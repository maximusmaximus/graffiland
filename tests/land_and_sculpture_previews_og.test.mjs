import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import {
  buildLandSharePageHtml,
  buildSculptureSharePageHtml,
  computeLandOgContentSig,
  computeSculptureOgContentSig,
  normalizeLandOgImageMode,
  renderBrandLogoOgPng,
  renderLandOgPng,
  renderSculptureOgPng
} from '../shared/landOgImage.mjs';
import {
  buildSculptureOgShareUrl,
  buildShareToXUrl
} from '../client/src/utils/clipboard.js';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-og-previews-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'og-previews.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');

function assertValidPng1200x630(bytes, label = 'PNG') {
  assert.ok(bytes instanceof Uint8Array, `${label} must be Uint8Array`);
  assert.ok(bytes.byteLength > 1500, `${label} must be non-trivial PNG`);
  assert.deepEqual(
    Array.from(bytes.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${label} must have valid PNG magic header`
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(16, false), 1200, `${label} width must be 1200`);
  assert.equal(view.getUint32(20, false), 630, `${label} height must be 630`);
}

// Tiny valid 1x1 PNG data URL for owner upload / snapshot roundtrip tests
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

describe('Land & Sculpture Previews + Centered-Logo OG Cards (Unit, API & UI)', () => {
  let server;
  let baseUrl;
  let dom;
  let RTL;
  let jsxTmpDir;

  before(async () => {
    const { server: srv } = createAppServer({ publishRateLimit: 100, mcpRateLimit: 300 });
    server = srv;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.SVGElement = dom.window.SVGElement;
    globalThis.Event = dom.window.Event;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.PointerEvent = dom.window.MouseEvent;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.File = dom.window.File;
    globalThis.FileReader = dom.window.FileReader;
    globalThis.getComputedStyle = dom.window.getComputedStyle;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.matchMedia =
      globalThis.matchMedia ||
      (() => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      }));
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    if (!globalThis.navigator) {
      globalThis.navigator = dom.window.navigator;
    }
    RTL = await import('@testing-library/react');
    jsxTmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-og-ui-'));
  });

  after(async () => {
    try {
      RTL?.cleanup();
    } catch {
      // ignore
    }
    dom?.window?.close();
    if (jsxTmpDir) fs.rmSync(jsxTmpDir, { recursive: true, force: true });
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function loadJsxModule(relPath) {
    const absIn = path.resolve(relPath);
    const outFile = path.join(jsxTmpDir, `${path.basename(relPath, '.jsx')}-${Date.now()}.mjs`);
    await esbuild.build({
      entryPoints: [absIn],
      outfile: outFile,
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      platform: 'browser',
      external: ['react', 'react-dom', 'react-dom/client', 'three', 'leaflet', 'maplibre-gl'],
      define: {
        'import.meta.env.VITE_API_BASE': JSON.stringify(
          'https://graffiland-api.maxinfeld-artshow.workers.dev'
        )
      },
      plugins: [
        {
          name: 'stub-css',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'css-stub'
            }));
            build.onResolve({ filter: /\?url$/ }, () => ({
              path: 'stub-url',
              namespace: 'url-stub'
            }));
            build.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: 'url-stub' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.svg': 'dataurl' }
    });
    return import(`file://${outFile.replace(/\\/g, '/')}`);
  }

  test('1. Shared OG renderers produce valid 1200x630 PNGs for Land (auto & logo), Sculpture, and rotate freshness signatures', async () => {
    const parcel = {
      parcelId: 'GLAND-ISOTEST',
      customName: 'Skyline Plaza',
      volume: { widthMeters: 28, depthMeters: 24, heightMeters: 16 }
    };
    const sculptures = [
      {
        id: 'sc-a',
        title: 'Emerald Arch',
        currentRev: 1,
        anchorOffset: { dx: -3, dy: 0, dz: 2, scale: 1 },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4' },
          { x: 0.4, y: 0.4, z: 0, color: '#ff3e7f' }
        ]
      },
      {
        id: 'sc-b',
        title: 'Chrome Beacon',
        currentRev: 1,
        modelType: 'custom-3d',
        anchorOffset: { dx: 4, dy: 0, dz: -3, scale: 1.5 }
      }
    ];

    const autoLandPng = await renderLandOgPng({ parcel, sculptures, mode: 'auto' });
    assertValidPng1200x630(autoLandPng, 'autoLandPng');

    const logoOnlyPng = await renderBrandLogoOgPng();
    assertValidPng1200x630(logoOnlyPng, 'logoOnlyPng');

    const modeLogoLandPng = await renderLandOgPng({ parcel, sculptures, mode: 'logo' });
    assert.deepEqual(
      modeLogoLandPng,
      logoOnlyPng,
      'mode=logo must output the pure SPRAY.LAND logo card'
    );

    const scPng = await renderSculptureOgPng({ sculpture: sculptures[0], parcel });
    assertValidPng1200x630(scPng, 'sculpturePng');
    const customModelScPng = await renderSculptureOgPng({ sculpture: sculptures[1], parcel });
    assertValidPng1200x630(customModelScPng, 'customModelSculpturePng');

    // Freshness signatures rotate whenever land/sculptures/mode change
    const sig1 = computeLandOgContentSig({ parcel, sculptures });
    const sigMoved = computeLandOgContentSig({
      parcel,
      sculptures: [
        { ...sculptures[0], anchorOffset: { dx: 5, dy: 0, dz: 2, scale: 1 } },
        sculptures[1]
      ]
    });
    const sigLogo = computeLandOgContentSig({
      parcel: { ...parcel, ogImageMode: 'logo' },
      sculptures
    });
    assert.notEqual(sig1, sigMoved, 'Moving a sculpture must rotate land OG freshness signature');
    assert.notEqual(sig1, sigLogo, 'Switching OG mode to logo must rotate land OG signature');
    assert.equal(normalizeLandOgImageMode('off'), 'logo');
    assert.equal(normalizeLandOgImageMode('custom'), 'custom');
    assert.equal(normalizeLandOgImageMode('anything'), 'auto');

    // Land share HTML includes full Facebook & X tags with freshness ?v=
    const landHtml = buildLandSharePageHtml({
      parcelId: parcel.parcelId,
      parcel,
      sculptures,
      apiOrigin: 'https://graffiland-api.maxinfeld-artshow.workers.dev',
      publicUrl: 'https://spray.land'
    });
    assert.match(landHtml, /property="og:image:secure_url"/);
    assert.match(landHtml, /property="og:image:width" content="1200"/);
    assert.match(landHtml, /property="og:image:height" content="630"/);
    assert.ok(landHtml.includes(sig1), 'Land share HTML must include freshness signature ?v=');

    // Sculpture share HTML + X intent URL use /share/sculpture/:id with full OG & X tags
    const scHtml = buildSculptureSharePageHtml({
      sculptureId: 'sc-a',
      sculpture: sculptures[0],
      parcel,
      apiOrigin: 'https://graffiland-api.maxinfeld-artshow.workers.dev',
      publicUrl: 'https://spray.land'
    });
    assert.match(scHtml, /property="og:image" content="https:\/\/graffiland-api\.maxinfeld-artshow\.workers\.dev\/api\/og\/sculpture\/sc-a\.png\?v=/);
    assert.match(scHtml, /property="og:image:secure_url"/);
    assert.match(scHtml, /property="og:image:width" content="1200"/);
    assert.match(scHtml, /property="og:image:height" content="630"/);
    assert.match(scHtml, /name="twitter:card" content="summary_large_image"/);
    assert.match(scHtml, /name="twitter:image" content="https:\/\/graffiland-api\.maxinfeld-artshow\.workers\.dev\/api\/og\/sculpture\/sc-a\.png\?v=/);
    assert.match(scHtml, /https:\/\/spray\.land\/\?sculpture=sc-a/);

    const scSig = computeSculptureOgContentSig({ sculpture: sculptures[0], parcel });
    assert.ok(scHtml.includes(scSig), 'Sculpture share HTML must include freshness signature ?v=');

    const scOgShare = buildSculptureOgShareUrl({
      sculptureId: 'sc-a',
      apiBase: 'https://graffiland-api.maxinfeld-artshow.workers.dev'
    });
    assert.equal(
      scOgShare,
      'https://graffiland-api.maxinfeld-artshow.workers.dev/share/sculpture/sc-a'
    );
    const xScUrl = new URL(
      buildShareToXUrl({
        title: 'Emerald Arch',
        landName: 'Skyline Plaza',
        sculptureId: 'sc-a',
        apiBase: 'https://graffiland-api.maxinfeld-artshow.workers.dev'
      })
    );
    assert.equal(
      xScUrl.searchParams.get('url'),
      'https://graffiland-api.maxinfeld-artshow.workers.dev/share/sculpture/sc-a'
    );
  });

  test('2. Express API roundtrip: Land & Sculpture OG endpoints, owner-only guard, freshness invalidation, custom image & logo-off mode', async () => {
    // Log in two dev users: owner & intruder
    const loginUser = async (email, name) => {
      const res = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devProfile: { email, name } })
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const ownerAuth = await loginUser('og-owner@spray.land', 'OgOwner');
    const otherAuth = await loginUser('og-guest@spray.land', 'OgGuest');

    // Create a land with an initial sculpture
    const createRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({
        customName: 'Neon Terrace',
        lat: 37.7749,
        lng: -122.4194,
        volume: { widthMeters: 16, depthMeters: 16, heightMeters: 10 }
      })
    });
    assert.ok(createRes.ok, `Expected claim ok, got ${createRes.status}`);
    const createdLand = await createRes.json();
    const parcelId = createdLand.parcelId || createdLand.parcel?.parcelId;
    assert.ok(parcelId, 'Claimed parcelId must be returned');

    const addScRes = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/sculptures`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerAuth.token}`
      },
      body: JSON.stringify({
        title: 'Prism Totem',
        description: 'A glowing prism',
        voxels: [
          { x: 0, y: 0.2, z: 0, color: '#00f5d4' },
          { x: 0, y: 0.6, z: 0, color: '#ff3e7f' }
        ]
      })
    });
    assert.ok(addScRes.ok, `Expected add sculpture ok, got ${addScRes.status}`);
    const addedSc = await addScRes.json();
    const sculptureId = addedSc.sculpture?.id || addedSc.id;
    assert.ok(sculptureId, 'Added sculpture id must be returned');

    // 2a) GET /share/land/:parcelId & GET /api/og/land/:parcelId.png (dynamic isometric default)
    const shareRes = await fetch(`${baseUrl}/share/land/${encodeURIComponent(parcelId)}`);
    assert.equal(shareRes.status, 200);
    const shareHtml = await shareRes.text();
    assert.match(shareHtml, /property="og:image"/);
    assert.match(shareHtml, /property="og:image:secure_url"/);
    assert.match(shareHtml, /name="twitter:card" content="summary_large_image"/);
    assert.ok(shareHtml.includes('Neon Terrace'));

    const ogRes1 = await fetch(`${baseUrl}/api/og/land/${encodeURIComponent(parcelId)}.png`);
    assert.equal(ogRes1.status, 200);
    assert.equal(ogRes1.headers.get('content-type'), 'image/png');
    assert.equal(ogRes1.headers.get('x-og-source'), 'dynamic-isometric');
    const liveSig1 = ogRes1.headers.get('x-og-content-sig');
    assert.ok(liveSig1, 'X-OG-Content-Sig must be returned');
    assertValidPng1200x630(new Uint8Array(await ogRes1.arrayBuffer()), 'server dynamic land OG');

    // 2b) Non-owner is blocked (403) from changing land OG settings
    const forbiddenRes = await fetch(
      `${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/og-settings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${otherAuth.token}`
        },
        body: JSON.stringify({ previewEnabled: false })
      }
    );
    assert.equal(forbiddenRes.status, 403);

    // 2c) Owner uploads a fresh auto 3D snapshot matching liveSig1 -> server serves it!
    const snapRes = await fetch(
      `${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/og-settings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.token}`
        },
        body: JSON.stringify({
          autoPreviewDataUrl: TINY_PNG_DATA_URL,
          contentSig: liveSig1
        })
      }
    );
    assert.equal(snapRes.status, 200);
    const ogFreshRes = await fetch(`${baseUrl}/api/og/land/${encodeURIComponent(parcelId)}.png`);
    assert.equal(ogFreshRes.status, 200);
    assert.equal(ogFreshRes.headers.get('x-og-source'), 'auto-3d-fresh');

    // 2d) Adding another sculpture makes the old snapshot STALE -> server regenerates fresh dynamic PNG!
    const addSc2Res = await fetch(
      `${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/sculptures`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.token}`
        },
        body: JSON.stringify({
          title: 'Second Pillar',
          description: 'Fresh addition',
          voxels: [{ x: 1, y: 0.4, z: 0, color: '#ffd166' }]
        })
      }
    );
    assert.ok(addSc2Res.ok, `Expected 2nd add sculpture ok, got ${addSc2Res.status}`);

    const ogAfterAddRes = await fetch(`${baseUrl}/api/og/land/${encodeURIComponent(parcelId)}.png`);
    assert.equal(ogAfterAddRes.status, 200);
    assert.equal(
      ogAfterAddRes.headers.get('x-og-source'),
      'dynamic-isometric',
      'Stale auto snapshot must automatically fall back to fresh dynamic render when land changes'
    );
    assert.notEqual(ogAfterAddRes.headers.get('x-og-content-sig'), liveSig1);

    // 2e) Owner uploads a custom share image -> served as custom-owner
    const customRes = await fetch(
      `${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/og-settings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.token}`
        },
        body: JSON.stringify({ customImageDataUrl: TINY_PNG_DATA_URL })
      }
    );
    assert.equal(customRes.status, 200);
    const customJson = await customRes.json();
    assert.equal(customJson.settings.ogImageMode, 'custom');
    const ogCustomRes = await fetch(`${baseUrl}/api/og/land/${encodeURIComponent(parcelId)}.png`);
    assert.equal(ogCustomRes.headers.get('x-og-source'), 'custom-owner');

    // 2f) Owner turns preview OFF -> served as brand-logo (SPRAY.LAND logo only)
    const offRes = await fetch(
      `${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/og-settings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.token}`
        },
        body: JSON.stringify({ previewEnabled: false })
      }
    );
    assert.equal(offRes.status, 200);
    const offJson = await offRes.json();
    assert.equal(offJson.settings.ogImageMode, 'logo');
    const ogLogoRes = await fetch(`${baseUrl}/api/og/land/${encodeURIComponent(parcelId)}.png`);
    assert.equal(ogLogoRes.headers.get('x-og-source'), 'brand-logo');
    assertValidPng1200x630(new Uint8Array(await ogLogoRes.arrayBuffer()), 'server brand-logo OG');

    // 2g) Sculpture OG page + PNG + owner upload
    const scShareRes = await fetch(`${baseUrl}/share/sculpture/${encodeURIComponent(sculptureId)}`);
    assert.equal(scShareRes.status, 200);
    const scShareHtml = await scShareRes.text();
    assert.match(scShareHtml, /Prism Totem/);
    assert.match(scShareHtml, /name="twitter:card" content="summary_large_image"/);
    assert.match(scShareHtml, /property="og:image"/);

    const scOgRes1 = await fetch(
      `${baseUrl}/api/og/sculpture/${encodeURIComponent(sculptureId)}.png`
    );
    assert.equal(scOgRes1.status, 200);
    assert.equal(scOgRes1.headers.get('x-og-source'), 'dynamic-sculpture');
    assertValidPng1200x630(new Uint8Array(await scOgRes1.arrayBuffer()), 'server dynamic sc OG');

    const scUploadRes = await fetch(
      `${baseUrl}/api/sculptures/${encodeURIComponent(sculptureId)}/og-preview`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerAuth.token}`
        },
        body: JSON.stringify({ previewDataUrl: TINY_PNG_DATA_URL })
      }
    );
    assert.equal(scUploadRes.status, 200);

    const scOgRes2 = await fetch(
      `${baseUrl}/api/og/sculpture/${encodeURIComponent(sculptureId)}.png`
    );
    assert.equal(scOgRes2.status, 200);
    assert.equal(scOgRes2.headers.get('x-og-source'), 'sculpture-3d-og');
  });

  test('3. UI: DesktopHub renders low-angle Land background cards & square Sculptures tab previews', async () => {
    const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');

    const parcel = {
      parcelId: 'GLAND-CARDBG1',
      customName: 'Sunset Deck',
      centerLat: 37.7749,
      centerLng: -122.4194,
      volume: {
        parcelId: 'GLAND-CARDBG1',
        centerLat: 37.7749,
        centerLng: -122.4194,
        widthMeters: 18,
        depthMeters: 14,
        heightMeters: 10
      },
      ogImageMode: 'auto'
    };
    const sc = {
      id: 'sc-sq-1',
      title: 'Voxel Flamingo',
      parcelId: 'GLAND-CARDBG1',
      parcelName: 'Sunset Deck',
      lat: 37.7749,
      lng: -122.4194,
      voxelCount: 24,
      polScore: 95,
      voxels: [
        { x: 0, y: 0, z: 0, color: '#ff3e7f' },
        { x: 0.3, y: 0.3, z: 0, color: '#00f5d4' }
      ]
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('/api/lands') && !s.includes('/mine')) {
        return { ok: true, status: 200, json: async () => ({ parcels: [parcel] }) };
      }
      if (s.includes('/api/sculptures')) {
        return { ok: true, status: 200, json: async () => ({ sculptures: [sc] }) };
      }
      if (s.includes('/api/config')) {
        return { ok: true, status: 200, json: async () => ({ chain: { name: 'Test' } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    try {
      const view = RTL.render(
        React.createElement(DesktopHub, {
          user: null,
          config: { chain: { name: 'Test' } },
          onRequestLogin: () => {}
        })
      );

      // Land tab shows low-angle isometric background card on desktop-land-item
      const landCard = await view.findByTestId('desktop-land-item');
      assert.ok(landCard.classList.contains('has-preview-bg'));
      const bg = landCard.querySelector('[data-testid="land-card-preview-bg"]');
      assert.ok(bg, 'Land card must include low-angle preview background');
      assert.equal(bg.getAttribute('data-preview-mode'), 'auto');
      assert.ok(bg.querySelector('img.desktop-land-card-bg-img'), 'Land card bg must render preview image');

      // Switch to Sculptures tab and verify square 1:1 preview thumbnail
      const scTabBtn = view.getByRole('tab', { name: /Sculptures/i });
      RTL.fireEvent.click(scTabBtn);

      const sqThumb = await view.findByTestId('desktop-sculpture-square-thumb');
      assert.equal(sqThumb.getAttribute('data-thumb-variant'), 'square');
      assert.ok(sqThumb.classList.contains('is-square'));
      assert.equal(sqThumb.style.width, '52px');
      assert.equal(sqThumb.style.height, '52px');

      RTL.cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('4. UI: PlotVisitView shows square artwork previews and live Land OG Preview Card with owner suggested dimensions, upload & logo toggle', async () => {
    const { default: PlotVisitView } = await loadJsxModule('client/src/components/PlotVisitView.jsx');

    const parcel = {
      parcelId: 'GLAND-DETAIL1',
      customName: 'Gallery Loft',
      ownerSub: 'user-owner-1',
      stewardSub: 'user-owner-1',
      centerLat: 37.775,
      centerLng: -122.419,
      ogImageMode: 'auto',
      volume: {
        parcelId: 'GLAND-DETAIL1',
        centerLat: 37.775,
        centerLng: -122.419,
        widthMeters: 20,
        depthMeters: 18,
        heightMeters: 12
      }
    };
    const sculptures = [
      {
        id: 'sc-plot-1',
        title: 'Holo Cube',
        parcelId: 'GLAND-DETAIL1',
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
        voxelCount: 12
      }
    ];

    const ogCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const s = String(url);
      if (s.includes('/og-settings') && init.method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        ogCalls.push(body);
        const nextMode =
          body.previewEnabled === false
            ? 'logo'
            : body.ogImageMode || (body.customImageDataUrl ? 'custom' : 'auto');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            parcelId: parcel.parcelId,
            settings: {
              ogImageMode: nextMode,
              ogCustomImageUrl: body.customImageDataUrl || '',
              ogPreviewImageUrl: body.autoPreviewDataUrl || '',
              ogPreviewSig: body.contentSig || '',
              ogPreviewUpdatedAt: new Date().toISOString()
            }
          })
        };
      }
      if (s.includes('/api/lands/')) {
        return { ok: true, status: 200, json: async () => ({ parcel, sculptures }) };
      }
      return { ok: true, status: 200, json: async () => ({ requests: [] }) };
    };

    try {
      // 4a) Land Holder view: sees live OG preview card, suggested 1200x630 dimensions, custom upload & toggle off -> logo
      const ownerView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          user: { id: 'user-owner-1', name: 'Owner', walletAddress: '0x123' },
          ownedParcelIds: ['GLAND-DETAIL1'],
          parcel,
          sculptures,
          allParcels: [parcel],
          onClose: () => {}
        })
      );

      // Artwork tab has small square preview
      const tabThumb = ownerView.getByTestId('plot-tab-sculpture-thumb');
      assert.equal(tabThumb.getAttribute('data-thumb-variant'), 'square');

      // Expand Land Details drawer to inspect details & OG Preview Card
      const detailsToggle = ownerView.queryByTestId('plot-details-toggle');
      if (detailsToggle && detailsToggle.getAttribute('aria-expanded') !== 'true') {
        RTL.fireEvent.click(detailsToggle);
      }

      // Land details shows the live OG Preview Card
      const ogCard = ownerView.getByTestId('land-og-preview-card');
      assert.equal(ogCard.getAttribute('data-og-mode'), 'auto');
      assert.ok(ownerView.getByTestId('land-og-preview-img'), 'Live OG preview image must render');
      const dimsText = ownerView.getByTestId('land-og-suggested-dims').textContent || '';
      assert.match(dimsText, /1200\s*×\s*630\s*px/);
      assert.match(dimsText, /1\.91:1/);

      // Toggle preview OFF -> calls POST /og-settings with previewEnabled: false & switches to SPRAY.LAND Logo mode
      const toggle = ownerView.getByTestId('land-og-preview-toggle');
      assert.equal(toggle.checked, true);
      RTL.fireEvent.click(toggle);

      await RTL.waitFor(() => {
        assert.equal(ownerView.getByTestId('land-og-preview-card').getAttribute('data-og-mode'), 'logo');
      });
      assert.ok(
        ogCalls.some((c) => c.previewEnabled === false && c.ogImageMode === 'logo'),
        'Unchecking toggle must save ogImageMode=logo'
      );
      assert.match(ownerView.getByTestId('land-og-mode-badge').textContent || '', /SPRAY\.LAND Logo/i);

      // Click artwork tab -> shows square artwork preview in Artwork Details & X share link to /share/sculpture/:id
      RTL.fireEvent.click(ownerView.getByTestId('plot-tab-artwork'));
      const artDetailThumb = await ownerView.findByTestId('plot-artwork-square-thumb');
      assert.equal(artDetailThumb.getAttribute('data-thumb-variant'), 'square');
      const artShareX = ownerView.getByTestId('plot-artwork-share-x-btn');
      assert.match(artShareX.getAttribute('href') || '', /share%2Fsculpture%2Fsc-plot-1/);

      RTL.cleanup();

      // 4b) Non-owner visitor view: sees live OG preview card WITHOUT owner upload/toggle controls
      const visitorView = RTL.render(
        React.createElement(PlotVisitView, {
          variant: 'desktop',
          user: { id: 'user-guest-9', name: 'Guest' },
          ownedParcelIds: [],
          parcel,
          sculptures,
          allParcels: [parcel],
          onClose: () => {}
        })
      );
      const vToggle = visitorView.queryByTestId('plot-details-toggle');
      if (vToggle && vToggle.getAttribute('aria-expanded') !== 'true') {
        RTL.fireEvent.click(vToggle);
      }
      assert.ok(visitorView.getByTestId('land-og-preview-card'));
      assert.equal(visitorView.queryByTestId('land-og-owner-controls'), null);
      RTL.cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
