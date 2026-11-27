/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(process.cwd());

describe('Mobile Bottom Slide Menu: Remove Pair & Occlusion, Add 3D Model Search', () => {
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
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}_${Math.random()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-slide-menu-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    dom.window.HTMLCanvasElement.prototype.getContext = (kind) =>
      kind === '2d'
        ? {
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {},
            clearRect: () => {},
            drawImage: () => {}
          }
        : null;

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

  test('1. KEY_TOOLS excludes pair & occlusion, includes search (🔍), and keeps Lock & Scale after Erase', async () => {
    const { KEY_TOOLS } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const ids = KEY_TOOLS.map((t) => t.id);

    assert.equal(ids.includes('pair'), false, 'pair must be removed from bottom slide menu');
    assert.equal(ids.includes('occlusion'), false, 'occlusion must be removed from bottom slide menu');
    assert.equal(ids.includes('search'), true, 'search must be added to bottom slide menu');

    const searchTool = KEY_TOOLS.find((t) => t.id === 'search');
    assert.equal(searchTool.emoji, '🔍');
    assert.match(searchTool.label, /Search/i);
    assert.equal(ids.indexOf('transform'), ids.indexOf('erase') + 1);

    // MobileStudio wires openCatalogSearchRef into useVoxelBrush
    const mobileStudioSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'MobileStudio.jsx'),
      'utf8'
    );
    assert.match(mobileStudioSrc, /openCatalogSearchRef:\s*openCatalogSearchCaller/);
    assert.match(mobileStudioSrc, /openCatalogSearchRef\.current\s*=\s*\(\)\s*=>\s*\{[\s\S]*setCatalogSearchOpen\(true\)/);
  });

  test('2. Tapping magnifying glass (🔍 Search 3D) in bottom slide menu opens MobileCatalogSearchModal & places into Lock & Scale', async () => {
    const { useVoxelBrush, KEY_TOOLS } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const { default: ToolCarouselBar } = await loadJsxModule(
      'client/src/components/studio/ToolCarouselBar.jsx'
    );
    const { default: MobileCatalogSearchModal } = await loadJsxModule(
      'client/src/components/studio/MobileCatalogSearchModal.jsx'
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/catalog/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'cat-robot',
                title: 'Pixel Robot',
                sourceId: 'pixels',
                sourceName: 'Pixels',
                modelFormat: 'glb',
                modelUrl: 'https://example.com/robot.glb',
                recommendedScale: 1
              }
            ],
            sources: [{ id: 'pixels', name: 'Pixels' }],
            total: 1
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    let fullscreenCalls = 0;

    try {
      function SlideMenuSearchHarness() {
        const [searchOpen, setSearchOpen] = React.useState(false);
        const [placedItem, setPlacedItem] = React.useState(null);
        const openCatalogSearchRef = React.useRef(() => setSearchOpen(true));
        const canvasHostRef = React.useRef(null);
        const cameraRef = React.useRef(null);
        const draftGroupRef = React.useRef(null);
        const transformBoxRef = React.useRef(null);
        const surfaceMarkerRef = React.useRef(null);
        const shadowPlaneRef = React.useRef(null);
        const gridHelperRef = React.useRef(null);
        const nearbyGroupRef = React.useRef(null);
        const arTargetedIdRef = React.useRef('');
        const locationRef = React.useRef({ lat: 39.73, lng: -121.84 });
        const polRef = React.useRef({ analyzeSurfacePatch: () => null });
        const rawOrientationRef = React.useRef(null);
        const fallbackEulerRef = React.useRef({ yaw: 0, pitch: 0 });
        const openAgentRef = React.useRef(() => {});
        const openPublishRef = React.useRef(() => {});

        const brush = useVoxelBrush({
          config: {},
          initialDraft: {},
          user: { id: 'user-mobile-1' },
          location: { lat: 39.73, lng: -121.84 },
          locationRef,
          cameraReady: true,
          sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
          calibrationReady: true,
          polRef,
          rawOrientationRef,
          fallbackEulerRef,
          enterFullscreen: () => {
            fullscreenCalls += 1;
          },
          setSensorBanner: () => {},
          showTemporaryHint: () => {},
          canvasHostRef,
          cameraRef,
          draftGroupRef,
          transformBoxRef,
          surfaceMarkerRef,
          shadowPlaneRef,
          gridHelperRef,
          nearbyGroupRef,
          arTargetedIdRef,
          setArTargetedSculpture: () => {},
          arPinPreview: null,
          openCameraSelectedChat: () => {},
          openCatalogSearchRef,
          openAgentHandoffRef: openAgentRef,
          openPublishSheetRef: openPublishRef,
          hasPlacedCatalogItem: Boolean(placedItem)
        });

        return React.createElement(
          'div',
          null,
          React.createElement(ToolCarouselBar, {
            activeKeyTool: brush.activeKeyTool,
            toolAvailability: brush.toolAvailability,
            canTouch: false,
            swipeDragPx: brush.swipeDragPx,
            isDraggingKey: brush.isDraggingKey,
            painting: brush.painting,
            mode: brush.mode,
            dockOpen: false,
            voxelsLength: brush.voxels.length,
            placedCatalogItem: placedItem,
            artTransform: brush.artTransform,
            onSetArtTransform: brush.setArtTransform,
            onToggleTransformLock: brush.toggleTransformLock,
            onStepKeyTool: brush.stepKeyTool,
            onKeyPointerDown: brush.handleKeyPointerDown,
            onKeyPointerMove: brush.handleKeyPointerMove,
            onKeyPointerUp: brush.handleKeyPointerUp,
            onKeyPointerCancel: brush.handleKeyPointerCancel
          }),
          searchOpen &&
            React.createElement(MobileCatalogSearchModal, {
              placedItem,
              onPlaceItem: (item) => {
                setPlacedItem(item);
                setSearchOpen(false);
                brush.enterTransformMode({ hintOverride: `Placed ${item.title}` });
              },
              onClose: () => setSearchOpen(false)
            })
        );
      }

      RTL.render(React.createElement(SlideMenuSearchHarness));

      // Step through carousel via Next arrow button until Search 3D is centered
      const nextBtn = document.querySelector('[aria-label="Next tool"]');
      const searchIndex = KEY_TOOLS.findIndex((t) => t.id === 'search');
      assert.ok(searchIndex > 0);
      for (let i = 0; i < searchIndex; i += 1) {
        RTL.fireEvent.click(nextBtn);
        // Never encounter Pair or Occlusion anywhere in the carousel
        assert.equal(document.querySelector('[data-tool-id="pair"]'), null);
        assert.equal(document.querySelector('[data-tool-id="occlusion"]'), null);
      }

      const centerSearchBtn = document.querySelector('[data-testid="key-slot-center-search"]');
      assert.ok(centerSearchBtn, 'Search 3D magnifying glass button should be centered');
      assert.match(document.querySelector('[data-testid="key-carousel"]').textContent, /Search 3D/i);

      // Tap center search button (pointerdown + pointerup < 16px)
      RTL.fireEvent.pointerDown(centerSearchBtn, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
      RTL.fireEvent.pointerUp(centerSearchBtn, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });

      assert.equal(fullscreenCalls, 0, 'Opening Search modal must NOT trigger browser fullscreen');
      assert.ok(
        document.querySelector('[data-testid="mobile-catalog-search-modal"]'),
        'MobileCatalogSearchModal should open when tapping 🔍 in bottom slide menu'
      );

      // Pick item and click Place & Scale -> closes search modal and opens Lock & Scale transform bar
      const card = await RTL.waitFor(() => {
        const el = document.querySelector('[data-testid="catalog-item-card-cat-robot"]');
        assert.ok(el, 'Catalog item card should load inside mobile search modal');
        return el;
      });
      RTL.fireEvent.click(card);

      const placeBtn = await RTL.waitFor(() => {
        const el = document.querySelector('[data-testid="catalog-place-selected-btn"]');
        assert.ok(el, 'Place & Scale button should render');
        return el;
      });
      RTL.fireEvent.click(placeBtn);

      await RTL.waitFor(() => {
        assert.equal(document.querySelector('[data-testid="mobile-catalog-search-modal"]'), null);
        assert.ok(
          document.querySelector('[data-testid="transform-scale-slider"]'),
          'Placing a 3D model from bottom slide menu search should enter Lock & Scale mode'
        );
      });
    } finally {
      cleanup();
      globalThis.fetch = origFetch;
    }
  });
});
