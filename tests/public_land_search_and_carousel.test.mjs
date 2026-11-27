import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { isLandPubliclyAddable } from '../client/src/utils/landMapHelpers.js';
import { search3dAssetCatalog } from '../shared/catalogSearchService.mjs';

const ROOT = path.resolve(process.cwd());

describe('Public Land Search Icon & Search-to-Add Random 6 Wheel/Swipe Carousel', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;

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
      jsx: 'automatic',
      plugins: [
        {
          name: 'ignore-css-and-url',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'ignore-css'
            }));
            build.onLoad({ filter: /.*/, namespace: 'ignore-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onResolve({ filter: /\?url$/ }, (args) => ({
              path: args.path,
              namespace: 'mock-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'mock-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl' },
      outfile: absOut
    });
    return import(`file://${absOut.replace(/\\/g, '/')}?t=${Date.now()}_${Math.random()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-pub-search-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.WheelEvent = dom.window.WheelEvent || dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    dom.window.HTMLCanvasElement.prototype.getContext = () => null;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    try {
      cleanup?.();
    } catch {
      // ignore
    }
    try {
      dom?.window?.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('1. isLandPubliclyAddable identifies open lands vs frozen / requireApproval / archived lands', () => {
    assert.equal(
      isLandPubliclyAddable({ parcelId: 'GLAND-OPEN', frozen: false, requireApproval: false }),
      true
    );
    assert.equal(
      isLandPubliclyAddable({ parcelId: 'GLAND-FROZEN', frozen: true, requireApproval: false }),
      false
    );
    assert.equal(
      isLandPubliclyAddable({
        parcelId: 'GLAND-FROZEN-NESTED',
        settings: { frozen: true, requireApproval: false }
      }),
      false
    );
    assert.equal(
      isLandPubliclyAddable({ parcelId: 'GLAND-APPROVAL', frozen: false, requireApproval: true }),
      false
    );
    assert.equal(
      isLandPubliclyAddable({
        parcelId: 'GLAND-APPROVAL-NESTED',
        settings: { requireApproval: true }
      }),
      false
    );
    assert.equal(
      isLandPubliclyAddable({ parcelId: 'GLAND-ARCHIVED', stewardStatus: 'archived' }),
      false
    );
  });

  test('2. search3dAssetCatalog random mode returns 6 fresh random items across libraries on each load', async () => {
    const offlineFetch = async () => ({ ok: false, status: 503 });
    const runA = await search3dAssetCatalog({
      query: '',
      source: 'all',
      limit: 6,
      random: true,
      seed: 'load-alpha-1',
      apiOrigin: 'https://api.spray.land',
      fetchImpl: offlineFetch
    });
    const runB = await search3dAssetCatalog({
      query: '',
      source: 'all',
      limit: 6,
      random: true,
      seed: 'load-beta-2',
      apiOrigin: 'https://api.spray.land',
      fetchImpl: offlineFetch
    });

    assert.equal(runA.randomized, true);
    assert.equal(runB.randomized, true);
    assert.equal(runA.items.length, 6);
    assert.equal(runB.items.length, 6);

    const idsA = runA.items.map((i) => i.id);
    const idsB = runB.items.map((i) => i.id);
    assert.equal(new Set(idsA).size, 6, 'Run A must have 6 unique items');
    assert.equal(new Set(idsB).size, 6, 'Run B must have 6 unique items');
    assert.notDeepEqual(idsA, idsB, 'Fresh loads must show different random 6 items');

    // Balanced across all 3 libraries when source === "all"
    const sourcesA = new Set(runA.items.map((i) => i.source));
    assert.equal(sourcesA.size, 3, 'Random 6 should span SimReady, Pixels & XeroEmoji');
  });

  test('3. Land labels show magnifying glass ONLY on publicly-addable lands and clicking it opens "Add 3D Item..."', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const s = String(url || '');
      if (s.includes('/api/parcels')) {
        return {
          ok: true,
          json: async () => ({
            parcels: [
              {
                parcelId: 'GLAND-PUBLIC1',
                customName: 'Open Canvas Plaza',
                frozen: false,
                requireApproval: false,
                centerLat: 37.7749,
                centerLng: -122.4194
              },
              {
                parcelId: 'GLAND-LOCKED1',
                customName: 'Approval Only Vault',
                frozen: false,
                requireApproval: true,
                centerLat: 37.7755,
                centerLng: -122.419
              },
              {
                parcelId: 'GLAND-FROZEN1',
                customName: 'Frozen Iceberg',
                frozen: true,
                requireApproval: false,
                centerLat: 37.776,
                centerLng: -122.4185
              }
            ]
          })
        };
      }
      if (s.includes('/api/catalog/search')) {
        return {
          ok: true,
          json: async () => ({
            query: '',
            source: 'all',
            randomized: true,
            totalMatches: 10000,
            items: [
              {
                id: 'xeroemoji:1f525',
                source: 'xeroemoji',
                sourceName: 'XeroEmoji Pile',
                title: '🔥 Fire',
                modelFormat: 'glb',
                modelUrl: '/api/catalog/emoji/1f525.glb',
                previewImageUrl: 'https://cdn.example/1f525.svg'
              }
            ]
          })
        };
      }
      if (s.includes('/api/sculptures')) {
        return { ok: true, json: async () => ({ sculptures: [] }) };
      }
      if (s.includes('/api/marketplace')) {
        return { ok: true, json: async () => ({ listings: [] }) };
      }
      if (s.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      if (s.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcelCount: 0, parcels: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    try {
      const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
      const view = RTL.render(
        React.createElement(DesktopHub, {
          user: { id: 'u-guest', username: 'visitor', walletAddress: '0x0000000000000000000000000000000000000002' },
          config: { network: 'testnet' }
        })
      );

      // Wait for floating land label pins to mount
      await RTL.waitFor(() => {
        const searchBtns = view.container.querySelectorAll('[data-testid="map3d-land-search-add-btn"]');
        assert.equal(searchBtns.length, 1, 'Only publicly-addable land should get a magnifying glass icon');
        assert.equal(searchBtns[0].getAttribute('data-parcel-id'), 'GLAND-PUBLIC1');
      });

      // Verify Approval Only & Frozen lands do NOT have magnifying glass buttons
      assert.equal(
        view.container.querySelector('[data-testid="map3d-land-search-add-btn"][data-parcel-id="GLAND-LOCKED1"]'),
        null
      );
      assert.equal(
        view.container.querySelector('[data-testid="map3d-land-search-add-btn"][data-parcel-id="GLAND-FROZEN1"]'),
        null
      );

      // Click the magnifying glass on Open Canvas Plaza -> opens "Add 3D Item to Open Canvas Plaza" modal!
      const pubSearchBtn = view.container.querySelector(
        '[data-testid="map3d-land-search-add-btn"][data-parcel-id="GLAND-PUBLIC1"]'
      );
      RTL.fireEvent.click(pubSearchBtn);

      await RTL.waitFor(() => {
        assert.ok(
          view.getByRole('dialog', { name: /Add 3D item to Open Canvas Plaza/i }),
          'Clicking magnifying glass on public land label must open Add 3D Item modal'
        );
      });

      cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('4. Search to Add loads 6 random items each mount, scrolls horizontally via mouse wheel on desktop, and provides swipe carousel on mobile', async () => {
    const origFetch = globalThis.fetch;
    const requestedUrls = [];
    const makeSix = (prefix) =>
      Array.from({ length: 6 }, (_, i) => ({
        id: `xeroemoji:${prefix}${i}`,
        source: 'xeroemoji',
        sourceName: 'XeroEmoji Pile',
        title: `${prefix} Item ${i + 1}`,
        modelFormat: 'glb',
        modelUrl: `/api/catalog/emoji/1f52${i}.glb`,
        previewImageUrl: `https://cdn.example/${prefix}${i}.svg`
      }));

    let callNum = 0;
    globalThis.fetch = async (url) => {
      const s = String(url || '');
      requestedUrls.push(s);
      callNum += 1;
      return {
        ok: true,
        json: async () => ({
          query: '',
          source: 'all',
          randomized: true,
          totalMatches: 10693,
          items: makeSix(`batch${callNum}`)
        })
      };
    };

    try {
      const { default: Catalog3DSearchBox } = await loadJsxModule(
        'client/src/components/Catalog3DSearchBox.jsx'
      );
      const { default: MobileCatalogSearchModal } = await loadJsxModule(
        'client/src/components/studio/MobileCatalogSearchModal.jsx'
      );

      // Desktop mode: mouse wheel horizontal scroll + random=1&limit=6
      Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
      const desktopView = RTL.render(
        React.createElement(Catalog3DSearchBox, {
          limit: 6,
          onPlaceItem: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.equal(
          desktopView.container.querySelectorAll('.catalog-item-card').length,
          6,
          'Should render 6 random items on load'
        );
      });

      assert.match(requestedUrls[0], /random=1/, 'Initial load should request random=1');
      assert.match(requestedUrls[0], /limit=6/, 'Initial load should request limit=6');
      assert.match(requestedUrls[0], /seed=/, 'Initial load should include fresh shuffle seed');

      const carousel = desktopView.getByTestId('catalog-results-grid');
      assert.equal(carousel.getAttribute('data-carousel-mode'), 'wheel');
      assert.match(
        desktopView.getByTestId('catalog-carousel-hint').textContent || '',
        /Scroll mouse wheel/i
      );

      // Simulate horizontal overflow and verify vertical mouse wheel scrolls carousel horizontally!
      Object.defineProperty(carousel, 'scrollWidth', { value: 1000, configurable: true });
      Object.defineProperty(carousel, 'clientWidth', { value: 480, configurable: true });
      carousel.scrollLeft = 0;

      const wheelEv = new dom.window.Event('wheel', { bubbles: true, cancelable: true });
      wheelEv.deltaY = 160;
      wheelEv.deltaX = 0;
      wheelEv.deltaMode = 0;
      carousel.dispatchEvent(wheelEv);

      assert.equal(carousel.scrollLeft, 160, 'Vertical mouse wheel must scroll the 6 items horizontally');
      assert.equal(wheelEv.defaultPrevented, true);

      // Clicking "New 6" rolls a fresh seed and loads 6 new items
      RTL.fireEvent.click(desktopView.getByTestId('catalog-shuffle-btn'));
      await RTL.waitFor(() => {
        assert.ok(requestedUrls.length >= 2);
        assert.notEqual(requestedUrls[0], requestedUrls[1], 'New 6 button must send a fresh random seed');
      });

      cleanup();

      // Mobile counterpart: MobileCatalogSearchModal renders swipe-snap carousel + Swipe hint + New 6
      const mobileView = RTL.render(
        React.createElement(MobileCatalogSearchModal, {
          onPlaceItem: () => {},
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.equal(mobileView.container.querySelectorAll('.catalog-item-card').length, 6);
      });
      const mobileCarousel = mobileView.getByTestId('catalog-results-grid');
      assert.equal(mobileCarousel.getAttribute('data-carousel-mode'), 'swipe');
      assert.match(
        mobileView.getByTestId('catalog-carousel-hint').textContent || '',
        /Swipe left\/right/i
      );
      assert.ok(mobileView.getByTestId('catalog-shuffle-btn'));
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
