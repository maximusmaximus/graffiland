import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Two-Click Land Name Activation (1st Click Zoom & Select -> 2nd Click Load Details)', () => {
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
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({
              path: 'stub.css',
              namespace: 'stub-css'
            }));
            build.onResolve({ filter: /\?url$/ }, () => ({
              path: 'stub-url',
              namespace: 'stub-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.two-click-land-'));
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
    globalThis.matchMedia =
      globalThis.matchMedia ||
      (() => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      }));
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    globalThis.fetch = origFetch;
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  function buildTwoLandFixtures() {
    const parcelA = {
      parcelId: 'GLAND-ALPHA1',
      customName: 'Alpha Terrace',
      description: 'First terrace parcel',
      centerLat: 39.7285,
      centerLng: -121.8375,
      ownerSub: 'u-two-click',
      stewardUsername: 'tester',
      sculptureCount: 1,
      volume: {
        centerLat: 39.7285,
        centerLng: -121.8375,
        widthMeters: 20,
        depthMeters: 16,
        heightMeters: 12,
        rotationDeg: 0
      }
    };
    const parcelB = {
      parcelId: 'GLAND-BETA02',
      customName: 'Beta Courtyard',
      description: 'Second courtyard parcel',
      centerLat: 39.731,
      centerLng: -121.839,
      ownerSub: 'u-other',
      stewardUsername: 'neighbor',
      sculptureCount: 2,
      volume: {
        centerLat: 39.731,
        centerLng: -121.839,
        widthMeters: 18,
        depthMeters: 18,
        heightMeters: 10,
        rotationDeg: 0
      }
    };
    return { parcelA, parcelB };
  }

  function installDesktopFetchMock(parcelA, parcelB) {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes(`/api/lands/${parcelA.parcelId}`)) {
        return { ok: true, json: async () => ({ parcel: parcelA, sculptures: [] }) };
      }
      if (u.includes(`/api/lands/${parcelB.parcelId}`)) {
        return { ok: true, json: async () => ({ parcel: parcelB, sculptures: [] }) };
      }
      if (u.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcels: [parcelA], parcelCount: 1 }) };
      }
      if (u.includes('/api/notifications')) {
        return { ok: true, json: async () => ({ notifications: [], unreadCount: 0 }) };
      }
      if (u.includes('/api/sculptures')) {
        return { ok: true, json: async () => ({ sculptures: [] }) };
      }
      if (u.includes('/api/parcels')) {
        return { ok: true, json: async () => ({ parcels: [parcelA, parcelB] }) };
      }
      if (u.includes('/api/quests/nearby')) {
        return { ok: true, json: async () => ({ quests: [] }) };
      }
      if (u.includes('/api/marketplace/listings')) {
        return { ok: true, json: async () => ({ listings: [] }) };
      }
      if (u.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
  }

  test('1. Desktop Land list & 3D map label: 1st click zooms & selects, 2nd click loads details, switching resets', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
    localStorage.clear();
    localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');

    const { parcelA, parcelB } = buildTwoLandFixtures();
    installDesktopFetchMock(parcelA, parcelB);

    const view = RTL.render(
      React.createElement(DesktopHub, {
        config: {},
        user: { id: 'u-two-click', username: 'tester', name: 'Tester' },
        onUserUpdate: () => {},
        onLogout: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.equal(view.getAllByTestId('desktop-land-item').length, 2);
      assert.equal(view.getAllByTestId('map3d-land-label').length, 2);
    });

    const getCard = (pid) =>
      view.getAllByTestId('desktop-land-item').find((el) => el.getAttribute('data-parcel-id') === pid);
    const getMapLabel = (pid) =>
      view.getAllByTestId('map3d-land-label').find((el) => el.getAttribute('data-parcel-id') === pid);
    const stage = () => view.container.querySelector('.map3d-stage');

    // --- A) Sidebar Land List: 1st click zooms & selects, does NOT open PlotVisitView ---
    RTL.fireEvent.click(getCard(parcelA.parcelId));
    await RTL.waitFor(() => {
      assert.equal(getCard(parcelA.parcelId).getAttribute('data-selected'), 'true');
      assert.equal(getCard(parcelB.parcelId).getAttribute('data-selected'), 'false');
      assert.equal(stage()?.getAttribute('data-selected-parcel-id'), parcelA.parcelId);
      assert.equal(stage()?.getAttribute('data-focus-parcel-id'), parcelA.parcelId);
      assert.equal(getMapLabel(parcelA.parcelId).getAttribute('data-focused'), 'true');
    });
    assert.equal(view.queryByTestId('desktop-plot-visit-view'), null);

    // --- B) Switching to a DIFFERENT land resets to 1st-click zoom & select (still no details) ---
    RTL.fireEvent.click(getCard(parcelB.parcelId));
    await RTL.waitFor(() => {
      assert.equal(getCard(parcelB.parcelId).getAttribute('data-selected'), 'true');
      assert.equal(getCard(parcelA.parcelId).getAttribute('data-selected'), 'false');
      assert.equal(stage()?.getAttribute('data-selected-parcel-id'), parcelB.parcelId);
      assert.equal(getMapLabel(parcelB.parcelId).getAttribute('data-focused'), 'true');
    });
    assert.equal(view.queryByTestId('desktop-plot-visit-view'), null);

    // --- C) 2nd click on the already-selected land in the list loads details view! ---
    RTL.fireEvent.click(getCard(parcelB.parcelId));
    await RTL.waitFor(() => {
      const detail = view.getByTestId('desktop-plot-visit-view');
      assert.ok(detail.textContent.includes('Beta Courtyard'));
    });

    // Close details view
    RTL.fireEvent.click(
      view.getByTestId('desktop-plot-visit-view').querySelector('button[aria-label*="Back"], button[aria-label*="Close"]') ||
        view.getByRole('button', { name: /Close|Back/i })
    );
    await RTL.waitFor(() => {
      assert.equal(view.queryByTestId('desktop-plot-visit-view'), null);
    });

    // --- D) 3D Map Floating Land Name: 1st click on unselected Alpha Terrace zooms & selects ---
    RTL.fireEvent.click(getMapLabel(parcelA.parcelId));
    await RTL.waitFor(() => {
      assert.equal(stage()?.getAttribute('data-selected-parcel-id'), parcelA.parcelId);
      assert.equal(getMapLabel(parcelA.parcelId).getAttribute('data-focused'), 'true');
      assert.match(getMapLabel(parcelA.parcelId).getAttribute('aria-label') || '', /Open detailed view/i);
    });
    assert.equal(view.queryByTestId('desktop-plot-visit-view'), null);

    // --- E) 2nd click on Alpha Terrace map label opens details view ---
    RTL.fireEvent.click(getMapLabel(parcelA.parcelId));
    await RTL.waitFor(() => {
      const detail = view.getByTestId('desktop-plot-visit-view');
      assert.ok(detail.textContent.includes('Alpha Terrace'));
    });

    // Close details view
    RTL.fireEvent.click(
      view.getByTestId('desktop-plot-visit-view').querySelector('button[aria-label*="Back"], button[aria-label*="Close"]') ||
        view.getByRole('button', { name: /Close|Back/i })
    );
    await RTL.waitFor(() => {
      assert.equal(view.queryByTestId('desktop-plot-visit-view'), null);
    });

    // --- F) Cross-click: 1st click on Beta Courtyard in list (zooms & selects), 2nd click on its map label opens details ---
    RTL.fireEvent.click(getCard(parcelB.parcelId));
    await RTL.waitFor(() => {
      assert.equal(stage()?.getAttribute('data-selected-parcel-id'), parcelB.parcelId);
    });
    assert.equal(view.queryByTestId('desktop-plot-visit-view'), null);

    RTL.fireEvent.click(getMapLabel(parcelB.parcelId));
    await RTL.waitFor(() => {
      const detail = view.getByTestId('desktop-plot-visit-view');
      assert.ok(detail.textContent.includes('Beta Courtyard'));
    });

    cleanup();
  });

  test('2. Explicit Inspect Land button still opens details on a single click even when unselected', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
    localStorage.clear();
    localStorage.setItem('graffiland_first_visit_welcome_seen_v1', '1');

    const { parcelA, parcelB } = buildTwoLandFixtures();
    installDesktopFetchMock(parcelA, parcelB);

    const view = RTL.render(
      React.createElement(DesktopHub, {
        config: {},
        user: { id: 'u-two-click', username: 'tester', name: 'Tester' },
        onUserUpdate: () => {},
        onLogout: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.equal(view.getAllByTestId('desktop-land-inspect-btn').length, 2);
    });

    const cardB = view
      .getAllByTestId('desktop-land-item')
      .find((el) => el.getAttribute('data-parcel-id') === parcelB.parcelId);
    assert.equal(cardB.getAttribute('data-selected'), 'false');

    const inspectBtnB = cardB.querySelector('[data-testid="desktop-land-inspect-btn"]');
    RTL.fireEvent.click(inspectBtnB);
    await RTL.waitFor(() => {
      const detail = view.getByTestId('desktop-plot-visit-view');
      assert.ok(detail.textContent.includes('Beta Courtyard'));
    });

    cleanup();
  });

  test('3. MobileMapSheet non-owned land name: 1st click selects & zooms, 2nd click opens card details', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );
    const { parcelA, parcelB } = buildTwoLandFixtures();
    const selectedCalls = [];

    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        user: { id: 'u-two-click', username: 'tester' },
        ownedParcelIds: [parcelA.parcelId],
        config: {},
        location: { lat: 39.7285, lng: -121.8375 },
        areaFilterMode: 'all',
        setAreaFilterMode: () => {},
        mapLoading: false,
        loadPublicMapData: () => {},
        displayedMapSculptures: [],
        areaSculpturesSorted: [],
        mapParcels: [parcelA, parcelB],
        selectedParcelId: '',
        onSelectParcel: (pid) => selectedCalls.push(pid),
        onSelectSculpture: () => {},
        onClose: () => {}
      })
    );

    const cardB = view
      .getAllByTestId('mobile-land-card')
      .find((el) => el.getAttribute('data-parcel-id') === parcelB.parcelId);
    const nameBtnB = cardB.querySelector('[data-testid="land-title-target-trigger"]');
    assert.ok(nameBtnB);
    assert.equal(cardB.getAttribute('data-selected'), 'false');
    assert.equal(cardB.getAttribute('data-expanded'), 'false');

    // 1st click -> zooms & selects only (card remains collapsed)
    RTL.fireEvent.click(nameBtnB);
    assert.equal(cardB.getAttribute('data-selected'), 'true');
    assert.equal(cardB.getAttribute('data-expanded'), 'false');
    assert.deepEqual(selectedCalls, [parcelB.parcelId]);

    // 2nd click -> opens details drawer on that selected land
    RTL.fireEvent.click(nameBtnB);
    assert.equal(cardB.getAttribute('data-selected'), 'true');
    assert.equal(cardB.getAttribute('data-expanded'), 'true');
    assert.ok(cardB.querySelector('[data-testid="mobile-land-card-details"]'));
    assert.deepEqual(selectedCalls, [parcelB.parcelId, parcelB.parcelId]);

    cleanup();
  });
});
