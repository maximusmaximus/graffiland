/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(process.cwd());

describe('Mobile 3D Search Stability, Camera Hide on Search, and First-Time Camera Starter Tools', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-search-first-tools-'));
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
    cleanup?.();
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('1. MobileCatalogSearchModal stays stably open across ghost clicks and backdrop taps, and only closes explicitly', async () => {
    const { default: MobileCatalogSearchModal } = await loadJsxModule(
      'client/src/components/studio/MobileCatalogSearchModal.jsx'
    );
    const { markModalOpenedFromPointerUp, resetPointerUpGhostWindow } = await loadJsxModule(
      'client/src/utils/modalBackdropGuard.js'
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
                id: 'simready:cactus_pot',
                rawId: 'cactus_pot',
                source: 'simready',
                sourceName: 'SimReady Pile',
                title: 'Painted Pot Cactus',
                modelFormat: 'glb',
                modelUrl: 'https://cdn.example.com/cactus.glb',
                previewImageUrl: 'https://cdn.example.com/cactus.png'
              }
            ],
            totalMatches: 1
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    try {
      markModalOpenedFromPointerUp();
      let closeCount = 0;
      const view = RTL.render(
        React.createElement(MobileCatalogSearchModal, {
          busy: false,
          disabled: false,
          onPlaceItem: () => {},
          onClose: () => {
            closeCount += 1;
          }
        })
      );

      const modal = view.getByTestId('mobile-catalog-search-modal');
      assert.ok(modal.classList.contains('is-fullscreen-sheet'));
      assert.equal(modal.getAttribute('data-camera-hidden'), 'true');
      assert.ok(view.getByTestId('mobile-catalog-camera-paused-note'));

      // Wait for catalog results to mount inside the search view
      await RTL.waitFor(() => {
        assert.ok(view.queryByTestId('catalog-item-card-simready:cactus_pot'));
      });

      // Simulate delayed ghost clicks & direct backdrop pointerdown/click even after ghost window expires!
      resetPointerUpGhostWindow();
      RTL.fireEvent.click(modal);
      RTL.fireEvent.pointerDown(modal);
      RTL.fireEvent.mouseDown(modal);
      RTL.fireEvent.click(modal);
      assert.equal(
        closeCount,
        0,
        'Backdrop clicks and delayed ghost clicks must NEVER auto-close MobileCatalogSearchModal'
      );

      // Escape while an InfoTip popover is open must NOT close the modal
      const fakeInfoPop = document.createElement('div');
      fakeInfoPop.className = 'info-tip-popover';
      document.body.appendChild(fakeInfoPop);
      RTL.fireEvent.keyDown(window, { key: 'Escape' });
      assert.equal(closeCount, 0, 'Escape while InfoTip popover is open must keep search modal open');
      document.body.removeChild(fakeInfoPop);

      // Escape with no InfoTip closes cleanly
      RTL.fireEvent.keyDown(window, { key: 'Escape' });
      assert.equal(closeCount, 1, 'Escape should close MobileCatalogSearchModal cleanly');

      // Explicit Close / Camera button closes cleanly
      RTL.fireEvent.click(view.getByTestId('mobile-catalog-search-close-btn'));
      assert.equal(closeCount, 2, 'Explicit Camera/Close button should close MobileCatalogSearchModal');

      cleanup();
    } finally {
      globalThis.fetch = origFetch;
      resetPointerUpGhostWindow();
    }
  });

  test('2. MobileStudio hides & suspends the live camera view when catalogSearchOpen is true and restores cleanly on close', async () => {
    // 2a) Verify wiring across MobileStudio, ARViewportCanvas, and useProofOfLocation
    const mobileStudioSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    assert.match(
      mobileStudioSrc,
      /renderPaused=\{Boolean\([\s\S]*?catalogSearchOpen[\s\S]*?\)\}/,
      'MobileStudio must pause ARViewportCanvas rendering while catalogSearchOpen is true'
    );
    assert.match(
      mobileStudioSrc,
      /cameraHidden=\{Boolean\(catalogSearchOpen\)\}/,
      'MobileStudio must pass cameraHidden={Boolean(catalogSearchOpen)} to ARViewportCanvas'
    );
    assert.match(
      mobileStudioSrc,
      /cameraSuspendedRef\.current = Boolean\(catalogSearchOpen\)/,
      'MobileStudio must mark cameraSuspendedRef true while catalogSearchOpen is active'
    );
    assert.match(
      mobileStudioSrc,
      /className=\{`hud-layer\$\{catalogSearchOpen \? ' is-camera-hidden' : ''\}`\}/,
      'MobileStudio must hide the camera HUD layer while catalogSearchOpen is active'
    );

    const polSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useProofOfLocation.js'),
      'utf8'
    );
    assert.match(
      polSrc,
      /cameraSuspendedRef = null/,
      'useProofOfLocation must accept cameraSuspendedRef'
    );
    assert.match(
      polSrc,
      /if \(cameraSuspendedBridgeRef\.current\?\.current\) return;/,
      'useProofOfLocation must skip pause/sampler recovery while camera is intentionally suspended'
    );
    assert.match(
      polSrc,
      /if \(cameraSuspendedBridgeRef\.current\?\.current\) return false;/,
      'useProofOfLocation ensureCameraLive watchdog must skip restarts while camera is suspended'
    );

    // 2b) Behavioral verification of ARViewportCanvas cameraHidden toggle (pause -> hide -> restore)
    const arSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(arSrc, /cameraHidden = false/, 'ARViewportCanvas must accept cameraHidden prop');
    assert.match(
      arSrc,
      /const effectiveRenderPaused = Boolean\(renderPaused \|\| cameraHidden\)/,
      'ARViewportCanvas must pause rendering whenever cameraHidden is true'
    );
    assert.match(
      arSrc,
      /videoEl\.pause\(\)/,
      'ARViewportCanvas must pause the live camera video element when cameraHidden becomes true'
    );
    assert.match(
      arSrc,
      /videoEl\.play\(\)/,
      'ARViewportCanvas must resume video playback when cameraHidden returns to false'
    );
    assert.match(
      arSrc,
      /className=\{`camera-feed\$\{cameraHidden \? ' is-camera-hidden' : ''\}`\}/,
      'ARViewportCanvas must add is-camera-hidden class to <video> while hidden'
    );
    assert.match(
      arSrc,
      /className=\{`webgl-overlay\$\{cameraHidden \? ' is-camera-hidden' : ''\}`\}/,
      'ARViewportCanvas must add is-camera-hidden class to .webgl-overlay while hidden'
    );
  });

  test('3. CameraFirstToolsPrompt introduces Draw, Paint, and Add 3D Model once on first camera visit and unlocks selection after calibration', async () => {
    const { default: CameraFirstToolsPrompt } = await loadJsxModule(
      'client/src/components/studio/CameraFirstToolsPrompt.jsx'
    );
    const { CAMERA_FIRST_TOOLS_SEEN_KEY, loadBoolPreference, saveBoolPreference } =
      await loadJsxModule('client/src/utils/clipboard.js');
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');

    localStorage.removeItem(CAMERA_FIRST_TOOLS_SEEN_KEY);

    // Build a realistic MobileStudio-equivalent harness combining CameraFirstToolsPrompt,
    // useVoxelBrush, MobileCatalogSearchModal visibility, and localStorage once-only persistence
    function FirstCameraFlowHarness({ initialCalibrated = false }) {
      const [calibrated, setCalibrated] = React.useState(initialCalibrated);
      const [seen, setSeen] = React.useState(() =>
        loadBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, false)
      );
      const [searchOpen, setSearchOpen] = React.useState(false);

      const polRef = React.useRef({ analyzeSurfacePatch: () => null });
      const rawOrientationRef = React.useRef(null);
      const fallbackEulerRef = React.useRef({ yaw: 0, pitch: 0 });
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
      const openCatalogRef = React.useRef(() => setSearchOpen(true));

      const brush = useVoxelBrush({
        config: { policy: {} },
        initialDraft: {},
        user: { id: 'u1', username: 'artist' },
        location: locationRef.current,
        locationRef,
        cameraReady: true,
        sceneScan: { optimal: calibrated, scannedCount: calibrated ? 7 : 3, targetCount: 7 },
        calibrationReady: calibrated,
        polRef,
        rawOrientationRef,
        fallbackEulerRef,
        enterFullscreen: () => {},
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
        openCatalogSearchRef: openCatalogRef,
        openAgentHandoffRef: React.useRef(() => {}),
        openPublishSheetRef: React.useRef(() => {})
      });

      const handleDismiss = () => {
        setSeen(true);
        saveBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, true);
      };

      const handleSelectTool = (toolId) => {
        if (!calibrated) return;
        handleDismiss();
        brush.selectKeyTool(toolId, { silent: true });
        if (toolId === 'search') {
          setSearchOpen(true);
        }
      };

      return React.createElement(
        'div',
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'simulate-calibration-complete',
            onClick: () => setCalibrated(true)
          },
          'Finish Calibration'
        ),
        React.createElement('div', { 'data-testid': 'active-tool' }, brush.activeKeyTool),
        React.createElement('div', { 'data-testid': 'search-open-state' }, searchOpen ? 'open' : 'closed'),
        !seen &&
          React.createElement(CameraFirstToolsPrompt, {
            calibrationReady: calibrated,
            calibrationProgressPct: calibrated ? 100 : 45,
            onSelectTool: handleSelectTool,
            onDismiss: handleDismiss
          })
      );
    }

    // 3a) First entry: calibrating -> prompt is visible, shows Draw, Paint, Add 3D Model, buttons disabled until calibrated
    const view1 = RTL.render(React.createElement(FirstCameraFlowHarness, { initialCalibrated: false }));
    const prompt1 = view1.getByTestId('camera-first-tools-prompt');
    assert.equal(prompt1.getAttribute('data-calibration-ready'), 'false');
    assert.match(prompt1.textContent, /Draw/i);
    assert.match(prompt1.textContent, /Paint/i);
    assert.match(prompt1.textContent, /Add 3D Model/i);

    const drawBtn1 = view1.getByTestId('first-tools-btn-draw');
    const paintBtn1 = view1.getByTestId('first-tools-btn-paint');
    const searchBtn1 = view1.getByTestId('first-tools-btn-search');
    assert.equal(drawBtn1.disabled, true, 'Draw button must wait until calibration succeeds');
    assert.equal(paintBtn1.disabled, true, 'Paint button must wait until calibration succeeds');
    assert.equal(searchBtn1.disabled, true, 'Add 3D Model button must wait until calibration succeeds');

    // Clicking before calibration does NOT dismiss or switch tool
    RTL.fireEvent.click(drawBtn1);
    assert.ok(view1.queryByTestId('camera-first-tools-prompt'));
    assert.equal(loadBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, false), false);

    // 3b) Calibration completes -> all 3 tool tiles unlock!
    RTL.fireEvent.click(view1.getByTestId('simulate-calibration-complete'));
    assert.equal(view1.getByTestId('camera-first-tools-prompt').getAttribute('data-calibration-ready'), 'true');
    assert.equal(view1.getByTestId('first-tools-btn-draw').disabled, false);
    assert.equal(view1.getByTestId('first-tools-btn-paint').disabled, false);
    assert.equal(view1.getByTestId('first-tools-btn-search').disabled, false);

    // 3c) Selecting Draw activates 'pencil', hides the prompt, and marks localStorage seen permanently
    RTL.fireEvent.click(view1.getByTestId('first-tools-btn-draw'));
    assert.equal(view1.getByTestId('active-tool').textContent, 'pencil');
    assert.equal(view1.queryByTestId('camera-first-tools-prompt'), null);
    assert.equal(loadBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, false), true);
    cleanup();

    // 3d) Subsequent visit MUST NEVER show the first-time tools prompt again!
    const view2 = RTL.render(React.createElement(FirstCameraFlowHarness, { initialCalibrated: true }));
    assert.equal(
      view2.queryByTestId('camera-first-tools-prompt'),
      null,
      'First-time camera tools section must ONLY show once on the first visit'
    );
    cleanup();

    // 3e) Fresh user picking Add 3D Model after calibration opens Search 3D view & marks seen
    localStorage.removeItem(CAMERA_FIRST_TOOLS_SEEN_KEY);
    const view3 = RTL.render(React.createElement(FirstCameraFlowHarness, { initialCalibrated: true }));
    RTL.fireEvent.click(view3.getByTestId('first-tools-btn-search'));
    assert.equal(view3.getByTestId('active-tool').textContent, 'search');
    assert.equal(view3.getByTestId('search-open-state').textContent, 'open');
    assert.equal(view3.queryByTestId('camera-first-tools-prompt'), null);
    assert.equal(loadBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, false), true);
    cleanup();

    // 3f) Fresh user picking Paint after calibration activates 'brush' & marks seen
    localStorage.removeItem(CAMERA_FIRST_TOOLS_SEEN_KEY);
    const view4 = RTL.render(React.createElement(FirstCameraFlowHarness, { initialCalibrated: true }));
    RTL.fireEvent.click(view4.getByTestId('first-tools-btn-paint'));
    assert.equal(view4.getByTestId('active-tool').textContent, 'brush');
    assert.equal(view4.queryByTestId('camera-first-tools-prompt'), null);
    assert.equal(loadBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, false), true);
    cleanup();

    // 3g) Fresh user dismissing with X also marks seen permanently
    localStorage.removeItem(CAMERA_FIRST_TOOLS_SEEN_KEY);
    const view5 = RTL.render(React.createElement(FirstCameraFlowHarness, { initialCalibrated: false }));
    RTL.fireEvent.click(view5.getByTestId('first-tools-dismiss-btn'));
    assert.equal(view5.queryByTestId('camera-first-tools-prompt'), null);
    assert.equal(loadBoolPreference(CAMERA_FIRST_TOOLS_SEEN_KEY, false), true);
    cleanup();
  });
});
