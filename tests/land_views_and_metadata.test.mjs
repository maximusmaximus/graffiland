import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Land Page & In-Person Views Counter API + Deduplication', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprayland-views-api-'));
  let server;
  let baseUrl;
  let ownerToken;
  let parcelId;
  const landLat = 39.7283;
  const landLng = -121.8369;

  before(async () => {
    process.env.GRAFFILAND_DB_PATH = path.join(tmpDir, 'views.sqlite');
    process.env.GRAFFILAND_IPFS_DIR = path.join(tmpDir, 'ipfs');
    process.env.PINATA_JWT = '';
    process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
    process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
    const { createAppServer } = await import('../server/index.mjs');
    const created = createAppServer();
    server = created.server;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const auth = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: { email: 'views-owner@spray.test', name: 'Views Owner', username: 'views_owner' }
      })
    }).then((r) => r.json());
    ownerToken = auth.token;
    assert.ok(ownerToken);

    const claimed = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        lat: landLat,
        lng: landLng,
        customName: 'Sunset Plaza',
        volume: {
          centerLat: landLat,
          centerLng: landLng,
          widthMeters: 14,
          depthMeters: 14,
          heightMeters: 10,
          rotationDeg: 0
        }
      })
    }).then((r) => r.json());
    parcelId = claimed.parcelId;
    assert.ok(parcelId);
  });

  after(async () => {
    server?.closeAllConnections?.();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows SQLite WAL handle releases on exit
    }
  });

  test('tracks deduplicated page views and proximity-verified in-person views on land detail & parcel list', async () => {
    // 1. Fresh land starts at 0/0 with createdAt
    const initDetail = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}`).then((r) => r.json());
    assert.equal(initDetail.parcel.pageViews, 0);
    assert.equal(initDetail.parcel.inPersonViews, 0);
    assert.ok(initDetail.parcel.createdAt);

    // 2. First page view from session A increments pageViews to 1
    const pv1 = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewType: 'page', sessionId: 'visitor_session_alpha1' })
    }).then((r) => r.json());
    assert.equal(pv1.ok, true);
    assert.equal(pv1.counted, true);
    assert.equal(pv1.pageViews, 1);
    assert.equal(pv1.inPersonViews, 0);

    // 3. Immediate repeat from same session A is deduplicated (remains 1)
    const pv1Dup = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewType: 'page', sessionId: 'visitor_session_alpha1' })
    }).then((r) => r.json());
    assert.equal(pv1Dup.counted, false);
    assert.equal(pv1Dup.pageViews, 1);

    // 4. Second distinct visitor increments pageViews to 2
    const pv2 = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewType: 'page', sessionId: 'visitor_session_beta22' })
    }).then((r) => r.json());
    assert.equal(pv2.counted, true);
    assert.equal(pv2.pageViews, 2);

    // 5. Remote spoofing attempt for in_person view (> 300 ft away) is rejected (400)
    const farRes = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewType: 'in_person',
        sessionId: 'visitor_remote_99',
        lat: 37.7749,
        lng: -122.4194
      })
    });
    assert.equal(farRes.status, 400);

    // 6. Physically on-site visitor increments inPersonViews to 1 (and deduplicates repeat)
    const irl1 = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewType: 'in_person',
        sessionId: 'irl_visitor_one11',
        lat: landLat + 0.00005,
        lng: landLng
      })
    }).then((r) => r.json());
    assert.equal(irl1.ok, true);
    assert.equal(irl1.counted, true);
    assert.equal(irl1.inPersonViews, 1);
    assert.equal(irl1.pageViews, 2);

    const irl1Dup = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewType: 'in_person',
        sessionId: 'irl_visitor_one11',
        lat: landLat,
        lng: landLng
      })
    }).then((r) => r.json());
    assert.equal(irl1Dup.counted, false);
    assert.equal(irl1Dup.inPersonViews, 1);

    // 7. Public GET /api/lands/:parcelId and GET /api/parcels expose persisted view counters
    const afterDetail = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}`).then((r) => r.json());
    assert.equal(afterDetail.parcel.pageViews, 2);
    assert.equal(afterDetail.parcel.inPersonViews, 1);

    const listRes = await fetch(`${baseUrl}/api/parcels`).then((r) => r.json());
    const found = (listRes.parcels || []).find((p) => p.parcelId === parcelId);
    assert.equal(found?.pageViews, 2);
    assert.equal(found?.inPersonViews, 1);
  });
});

describe('PlotVisitView Views Counter Beside Title Tag & Extra Metadata "i" Beside Author/Date (React + jsdom)', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;
  let origFetch;

  async function loadJsxModule(relPath) {
    const absIn = path.join(ROOT, relPath);
    const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const absOut = path.join(outTmpDir, `${safeName}.mjs`);
    await esbuild.build({
      entryPoints: [absIn],
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      define: { 'import.meta.env': '{}' },
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({ path: 'stub.css', namespace: 'stub-css' }));
            build.onResolve({ filter: /\?url$/ }, () => ({ path: 'stub-url', namespace: 'stub-url' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({ contents: '', loader: 'js' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({ contents: 'export default "";', loader: 'js' }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.land-views-ui-test-cache-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(async () => {
    cleanup?.();
    if (origFetch !== undefined) globalThis.fetch = origFetch;
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('displays in-person & page views beside title status tag, puts extra metadata in "i" beside author & date, and records live page view', async () => {
    const viewCalls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/view')) {
        const body = JSON.parse(init?.body || '{}');
        viewCalls.push({ url: u, body });
        return new Response(
          JSON.stringify({ ok: true, parcelId: 'GLAND-VIEWUI1', counted: true, pageViews: 15, inPersonViews: 4 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true, parcels: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');

    // Loading state with parcel=null must render cleanly with zero null-dereference errors
    const loadingView = RTL.render(
      React.createElement(PlotVisitView, {
        variant: 'desktop',
        parcel: null,
        loading: true,
        onClose: () => {}
      })
    );
    assert.ok(loadingView.getByTestId('plot-visit-header').textContent.includes('Loading Land'));
    loadingView.unmount();

    const parcel = {
      parcelId: 'GLAND-VIEWUI1',
      customName: 'PARKING LOT 🚗 Land',
      stewardUsername: 'bigdog',
      stewardType: 'human',
      centerLat: 39.7283,
      centerLng: -121.8369,
      createdAt: '2026-11-25T20:00:00Z',
      pageViews: 14,
      inPersonViews: 4,
      humanContributorCount: 2,
      volume: {
        centerLat: 39.7283,
        centerLng: -121.8369,
        widthMeters: 4.3,
        depthMeters: 4.3,
        heightMeters: 3.0,
        rotationDeg: 0
      }
    };

    const view = RTL.render(
      React.createElement(PlotVisitView, {
        variant: 'desktop',
        parcel,
        sculptures: [
          {
            id: 'sc-1',
            title: 'PARKING LOT 🚗',
            creatorUsername: 'bigdog',
            voxelCount: 2406,
            polScore: 94,
            currentRev: 1,
            createdAt: '2026-11-25T20:00:00Z'
          }
        ],
        allParcels: [parcel],
        onClose: () => {}
      })
    );

    // 1) Header has status tag + views counter right beside the title (and strictly 2 buttons: Share + Close)
    const header = view.getByTestId('plot-visit-header');
    assert.equal(header.querySelectorAll('button').length, 2);
    const viewsCounter = view.getByTestId('plot-views-counter');
    assert.ok(header.contains(viewsCounter));
    assert.ok(view.getByTestId('plot-in-person-views').textContent.includes('4'));
    assert.ok(view.getByTestId('plot-in-person-views').textContent.includes('IRL'));

    // Live page view API call updates counter from 14 -> 15
    await RTL.waitFor(() => {
      assert.equal(viewCalls.length >= 1, true);
      assert.ok(view.getByTestId('plot-page-views').textContent.includes('15'));
    });
    assert.equal(viewCalls[0].body.viewType, 'page');

    // 2) Author + Date + "i" icon row holds author name, formatted date, and the extra-metadata "i" icon
    const authorRow = view.getByTestId('plot-author-meta-row');
    assert.ok(authorRow.textContent.includes('@bigdog'));
    assert.ok(view.getByTestId('plot-land-date').textContent.includes('Nov 25'));
    const infoWrap = view.getByTestId('parcel-directions-info');
    assert.ok(authorRow.contains(infoWrap));

    // Clicking "i" reveals all extra metadata cleanly inside popover
    RTL.fireEvent.click(infoWrap.querySelector('button'));
    assert.ok(view.getByTestId('plot-info-in-person-views').textContent.includes('4'));
    assert.ok(view.getByTestId('plot-info-page-views').textContent.includes('15'));
    assert.ok(view.getByTestId('plot-info-coords').textContent.includes('39.7283, -121.8369'));
    assert.ok(view.getByTestId('plot-info-dimensions').textContent.includes('ft'));

    // 3) Switching to Artwork tab also shows clean author · date · "i" popover row
    RTL.fireEvent.click(view.getByTestId('plot-tab-artwork'));
    const artMetaRow = view.getByTestId('plot-artwork-meta-row');
    assert.ok(artMetaRow.textContent.includes('@bigdog'));
    assert.ok(artMetaRow.textContent.includes('Nov 25'));
    assert.ok(artMetaRow.contains(view.getByTestId('plot-artwork-info-tip')));
    view.unmount();
  });
});
