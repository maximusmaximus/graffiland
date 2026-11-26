import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

import {
  describeApiErrorForMobile,
  describeCameraError,
  describeCameraNeededAction,
  describeGeolocationError,
  describeHttpsRequiredError,
  describeLocationNeededAction,
  describeMotionError,
  detectMobilePlatform
} from '../client/src/utils/permissionMessages.js';
import {
  installMobileViewportLock,
  isMobileLandscapeOrientation,
  tryLockPortraitOrientation
} from '../client/src/utils/mobilePortraitLock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

function countWords(text) {
  return String(text || '')
    .replace(/[→—–·()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

describe('Concise, actionable mobile phone-settings errors', () => {
  test('detectMobilePlatform identifies iOS, Android, and generic browsers', () => {
    assert.equal(detectMobilePlatform(IOS_UA), 'ios');
    assert.equal(detectMobilePlatform(ANDROID_UA), 'android');
    assert.equal(detectMobilePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'other');
  });

  test('geolocation, camera, motion, and API errors stay concise and tell users exact phone settings', () => {
    const samples = [
      describeGeolocationError({ code: 1, message: 'User denied Geolocation' }, { userAgent: IOS_UA }),
      describeGeolocationError({ code: 1, message: 'User denied Geolocation' }, { userAgent: ANDROID_UA }),
      describeGeolocationError({ code: 2 }, { userAgent: IOS_UA }),
      describeGeolocationError({ code: 2 }, { userAgent: ANDROID_UA }),
      describeGeolocationError({ code: 3 }, { userAgent: IOS_UA }),
      describeCameraError({ name: 'NotAllowedError' }, { userAgent: IOS_UA }),
      describeCameraError({ name: 'NotAllowedError' }, { userAgent: ANDROID_UA }),
      describeCameraError({ name: 'NotReadableError' }, { userAgent: ANDROID_UA }),
      describeCameraError({ name: 'NotFoundError' }, { userAgent: IOS_UA }),
      describeMotionError('denied', { userAgent: IOS_UA }),
      describeMotionError('denied', { userAgent: ANDROID_UA }),
      describeMotionError('unavailable', { userAgent: IOS_UA }),
      describeLocationNeededAction({ userAgent: IOS_UA }),
      describeLocationNeededAction({ userAgent: ANDROID_UA }),
      describeCameraNeededAction({ userAgent: IOS_UA }),
      describeCameraNeededAction({ userAgent: ANDROID_UA }),
      describeHttpsRequiredError(),
      describeApiErrorForMobile(new Error('Failed to fetch'), { userAgent: IOS_UA })
    ];

    for (const msg of samples) {
      assert.ok(msg.length > 0, 'Message must be non-empty');
      assert.ok(
        countWords(msg) <= 16,
        `Expected concise <=16 word phone error, got ${countWords(msg)} words: "${msg}"`
      );
    }

    // Platform-specific actionable phone paths
    assert.match(
      describeCameraError({ name: 'NotAllowedError' }, { userAgent: IOS_UA }),
      /Settings.*Safari.*Camera/i
    );
    assert.match(
      describeCameraError({ name: 'NotAllowedError' }, { userAgent: ANDROID_UA }),
      /address bar lock.*Permissions.*Camera/i
    );
    assert.match(
      describeGeolocationError({ code: 1 }, { userAgent: IOS_UA }),
      /Settings.*Location Services.*Safari/i
    );
    assert.match(
      describeGeolocationError({ code: 1 }, { userAgent: ANDROID_UA }),
      /address bar lock.*Permissions.*Location/i
    );
    assert.match(
      describeMotionError('denied', { userAgent: IOS_UA }),
      /Settings.*Safari.*Motion/i
    );
    assert.match(
      describeApiErrorForMobile(new Error('Failed to fetch')),
      /Airplane Mode|Wi-Fi/i
    );
  });
});

describe('Mobile Portrait-Only Lock & Anti-Tilt Viewport Guard', () => {
  test('manifest.webmanifest and index.html declare portrait-primary and disable viewport pinch-zoom/tilt', () => {
    const manifestPath = path.join(ROOT, 'client/public/manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'client/public/manifest.webmanifest must exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.orientation, 'portrait-primary');
    assert.equal(manifest.display, 'standalone');

    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.match(html, /rel="manifest"\s+href="\/manifest\.webmanifest"/);
    assert.match(html, /minimum-scale=1\.0/);
    assert.match(html, /maximum-scale=1\.0/);
    assert.match(html, /user-scalable=no/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /interactive-widget=resizes-content/);

    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    assert.ok(
      css.includes("html.mobile-portrait-locked input:not([type='checkbox']):not([type='radio']):not([type='range'])"),
      'Mobile anti-zoom CSS must enforce >=16px inputs to prevent iOS focus auto-zoom'
    );
    assert.ok(
      css.includes('font-size: 16px !important;'),
      'Mobile inputs must force 16px font-size to stop Safari auto-zoom'
    );
    assert.ok(
      css.includes('html.mobile-portrait-locked .hud-layer button'),
      'Mobile HUD buttons must lock touch-action so buttons never drift off-screen'
    );
  });

  test('isMobileLandscapeOrientation locks genuine landscape rotation without false-triggering on portrait keyboards', () => {
    // 1. Portrait phone (390x844) -> false
    assert.equal(
      isMobileLandscapeOrientation(
        { innerWidth: 390, innerHeight: 844, screen: { orientation: { type: 'portrait-primary' } } },
        { activeElement: null }
      ),
      false
    );

    // 2. Portrait phone with virtual keyboard open (390x380, input focused, even if emulated orientation says landscape) -> false
    assert.equal(
      isMobileLandscapeOrientation(
        { innerWidth: 390, innerHeight: 380, screen: { orientation: { type: 'landscape-primary' } } },
        { activeElement: { tagName: 'INPUT' } }
      ),
      false
    );

    // 3. Portrait phone keyboard open even without focus (ratio 390/380 = 1.026 <= 1.15) -> false
    assert.equal(
      isMobileLandscapeOrientation(
        { innerWidth: 390, innerHeight: 380, screen: { orientation: { type: 'landscape-primary' } } },
        { activeElement: null }
      ),
      false
    );

    // 4. Genuine landscape phone rotation (844x390, landscape-primary) -> true
    assert.equal(
      isMobileLandscapeOrientation(
        { innerWidth: 844, innerHeight: 390, screen: { orientation: { type: 'landscape-primary' } } },
        { activeElement: null }
      ),
      true
    );

    // 5. Legacy iOS Safari landscape rotation (window.orientation === -90, 667x375) -> true
    assert.equal(
      isMobileLandscapeOrientation(
        { innerWidth: 667, innerHeight: 375, orientation: -90 },
        { activeElement: null }
      ),
      true
    );

    // 6. Legacy iOS Safari upright portrait (window.orientation === 0) -> false
    assert.equal(
      isMobileLandscapeOrientation(
        { innerWidth: 390, innerHeight: 360, orientation: 0 },
        { activeElement: { tagName: 'TEXTAREA' } }
      ),
      false
    );
  });

  test('tryLockPortraitOrientation tries portrait-primary, falls back to portrait, and handles rejection safely', async () => {
    const calls = [];
    const okPrimary = await tryLockPortraitOrientation({
      screen: {
        orientation: {
          async lock(mode) {
            calls.push(mode);
          }
        }
      }
    });
    assert.equal(okPrimary, true);
    assert.deepEqual(calls, ['portrait-primary']);

    const fallbackCalls = [];
    const okFallback = await tryLockPortraitOrientation({
      screen: {
        orientation: {
          async lock(mode) {
            fallbackCalls.push(mode);
            if (mode === 'portrait-primary') throw new Error('unsupported primary');
          }
        }
      }
    });
    assert.equal(okFallback, true);
    assert.deepEqual(fallbackCalls, ['portrait-primary', 'portrait']);

    const failSafe = await tryLockPortraitOrientation({
      screen: {
        orientation: {
          async lock() {
            throw new Error('NotSupportedError');
          }
        }
      }
    });
    assert.equal(failSafe, false);
  });
});

describe('Publish Sign-In Popup, Retry GPS HUD & Portrait Overlay (React + jsdom)', () => {
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
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.tmp-mobile-pub-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    dom.window.HTMLCanvasElement.prototype.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w || 1) * (h || 1) * 4)) }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w || 1) * (h || 1) * 4)) }),
      putImageData: () => {},
      clearRect: () => {},
      drawImage: () => {}
    });

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('useVoxelBrush keeps Publish actionable when drawn & logged out and immediately pops up Publish/Sign-In on selection', async () => {
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');

    let hookApi = null;
    let openPublishCalls = 0;
    const hints = [];

    function Harness({ user, initialVoxels }) {
      const api = useVoxelBrush({
        config: { policy: { maxVoxels: 4096 } },
        initialDraft: { voxels: initialVoxels },
        user,
        location: null,
        locationRef: { current: null },
        cameraReady: false,
        sceneScan: { optimal: false, scannedCount: 0, targetCount: 9 },
        polRef: { current: { getSceneCoverage: () => ({ optimal: false, scannedCount: 0, targetCount: 9 }) } },
        rawOrientationRef: { current: null },
        fallbackEulerRef: { current: { yaw: 0, pitch: 0 } },
        enterFullscreen: () => {},
        setSensorBanner: () => {},
        showTemporaryHint: (m) => hints.push(m),
        canvasHostRef: { current: null },
        cameraRef: { current: null },
        draftGroupRef: { current: null },
        transformBoxRef: { current: null },
        surfaceMarkerRef: { current: null },
        shadowPlaneRef: { current: null },
        gridHelperRef: { current: null },
        nearbyGroupRef: { current: null },
        arTargetedIdRef: { current: '' },
        setArTargetedSculpture: () => {},
        arPinPreview: null,
        openCameraSelectedChat: () => {},
        openAgentHandoffRef: { current: () => {} },
        openPublishSheetRef: {
          current: () => {
            openPublishCalls += 1;
          }
        }
      });
      hookApi = api;
      return React.createElement('div', null, api.activeKeyTool);
    }

    // 1) With 0 blocks drawn and logged out -> Publish is disabled & does not open sign-in
    const view = RTL.render(React.createElement(Harness, { user: null, initialVoxels: [] }));
    assert.equal(hookApi.toolAvailability.publish.usable, false);
    assert.match(hookApi.toolAvailability.publish.reason, /Draw at least 1 block/i);
    await RTL.act(async () => {
      hookApi.selectKeyTool('publish');
    });
    assert.equal(openPublishCalls, 0);
    view.unmount();

    // 2) After drawing art (1+ voxels) while logged out -> Publish is usable (needsAuth: true)
    //    and selecting Publish immediately calls openPublishSheet (which pops up Google Sign-In!)
    const viewDrawn = RTL.render(
      React.createElement(Harness, {
        user: null,
        initialVoxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' }]
      })
    );
    assert.equal(hookApi.toolAvailability.publish.usable, true);
    assert.equal(hookApi.toolAvailability.publish.needsAuth, true);

    await RTL.act(async () => {
      hookApi.selectKeyTool('publish');
    });
    assert.equal(openPublishCalls, 1, 'Selecting Publish after drawing while logged out must immediately trigger Sign-In/Publish');

    // Tapping center Publish button again triggers it again if user dismissed login
    await RTL.act(async () => {
      hookApi.triggerActiveKeyTool();
    });
    assert.equal(openPublishCalls, 2, 'Tapping center Publish button while logged out must trigger Sign-In/Publish');

    viewDrawn.unmount();
  });

  test('MobileStudio wires Publish -> GoogleLoginGate popup -> automatic post-login continuation, and PublishSculptureModal exposes Sign-In CTA when logged out', async () => {
    const studioSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    assert.match(studioSrc, /pendingPublishAfterLoginRef\.current\s*=\s*\{\s*skipVoxelCheck\s*\}/);
    assert.match(studioSrc, /setLoginOpen\(true\)/);
    assert.match(studioSrc, /userOverride:\s*u/);

    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );
    let loginRequested = 0;
    const view = RTL.render(
      React.createElement(PublishSculptureModal, {
        config: { policy: { titleMax: 48, descriptionMax: 240, descriptionMaxWords: 45 } },
        user: null,
        voxels: [{ x: 0, y: 0, z: 0, color: '#ff3e7f', material: 'matte' }],
        polStats: { frames: 12, gyro: 20, flow: 88 },
        location: { lat: 39.73, lng: -121.84 },
        orbStatus: { keyframes: 3, features: 24 },
        passkeyCount: 0,
        passkeyBusy: false,
        onEnrollPasskey: () => {},
        title: 'Test Art',
        setTitle: () => {},
        description: 'Street art',
        setDescription: () => {},
        cluePrompt: '',
        setCluePrompt: () => {},
        clueAnswer: '',
        setClueAnswer: () => {},
        termsAccepted: true,
        setTermsAccepted: () => {},
        publishing: false,
        publishError: '',
        setPublishError: () => {},
        mintReceipt: null,
        mcpPairingsState: { mcpActive: false, activePairing: null },
        agentPublishPrompt: null,
        draftsBusy: false,
        draftStatusText: '',
        onSubmitPublish: (e) => e.preventDefault(),
        onCopyAgentPublishPrompt: () => {},
        onManualSaveDraft: () => {},
        onOpenInfo: () => {},
        onOpenPair: () => {},
        onOpenManageLand: () => {},
        onViewInARPreview: () => {},
        onRequestLogin: () => {
          loginRequested += 1;
        },
        onShowHint: () => {},
        onClose: () => {}
      })
    );
    const signInBtn = view.getByRole('button', { name: /Sign in with Google to Publish/i });
    RTL.fireEvent.click(signInBtn);
    assert.equal(loginRequested, 1);
    view.unmount();
  });

  test('StudioHudTopBar displays Location error even when camera is ready and provides a 1-tap Retry GPS button', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    let gpsRetries = 0;
    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'draw',
        dockOpen: false,
        location: null,
        pairedCode: '',
        voxels: [],
        onOpenTutorial: () => {},
        onOpenInfo: () => {},
        onOpenLogin: () => {},
        hasOwnedLand: false,
        ownedLandCount: 0,
        onOpenLandManage: () => {},
        needsGyroTap: false,
        gyroFallbackActive: false,
        cameraReady: true,
        onRetryCameraAccess: () => {},
        onRetryLocation: () => {
          gpsRetries += 1;
        },
        sensorBanner: describeGeolocationError({ code: 1 }, { userAgent: IOS_UA }),
        onDismissSensorBanner: () => {},
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: false, scannedCount: 0, targetCount: 9 },
        mapOpen: false,
        nearbyCount: 0,
        onOpenAreaMap: () => {}
      })
    );

    const banner = view.getByTestId('mobile-error-banner');
    assert.match(banner.textContent || '', /Location blocked/i);
    assert.match(banner.textContent || '', /Settings.*Location Services/i);
    const retryGpsBtn = view.getByRole('button', { name: /Retry GPS/i });
    RTL.fireEvent.click(retryGpsBtn);
    assert.equal(gpsRetries, 1);
    view.unmount();
  });

  test('MobilePortraitLockOverlay renders portrait guard and installMobileViewportLock blocks Safari gesture zoom/tilt', async () => {
    const { default: MobilePortraitLockOverlay } = await loadJsxModule(
      'client/src/components/MobilePortraitLockOverlay.jsx'
    );
    const view = RTL.render(React.createElement(MobilePortraitLockOverlay));
    const overlay = view.getByTestId('mobile-portrait-lock-overlay');
    assert.match(overlay.textContent || '', /Hold Phone Upright/i);
    assert.match(overlay.textContent || '', /Portrait mode/i);
    view.unmount();

    const cleanupLock = installMobileViewportLock({ win: dom.window, doc: dom.window.document });
    assert.equal(dom.window.document.documentElement.classList.contains('mobile-portrait-locked'), true);

    // 1) Safari gesturestart page pinch/tilt is prevented
    const gestureEv = new dom.window.Event('gesturestart', { cancelable: true });
    dom.window.document.dispatchEvent(gestureEv);
    assert.equal(gestureEv.defaultPrevented, true, 'Safari gesturestart pinch/tilt must be prevented on mobile');

    // 2) Multi-touch touchstart on HUD / non-canvas is prevented, while canvas touchstart passes through
    const hudDiv = dom.window.document.createElement('div');
    const mapCanvas = dom.window.document.createElement('canvas');
    const actionBtn = dom.window.document.createElement('button');
    dom.window.document.body.appendChild(hudDiv);
    dom.window.document.body.appendChild(mapCanvas);
    dom.window.document.body.appendChild(actionBtn);

    const hudPinchStart = new dom.window.Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(hudPinchStart, 'touches', { value: [{ clientX: 50, clientY: 50 }, { clientX: 150, clientY: 150 }] });
    hudDiv.dispatchEvent(hudPinchStart);
    assert.equal(hudPinchStart.defaultPrevented, true, '2-finger touchstart on HUD must be blocked');

    const canvasPinchStart = new dom.window.Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(canvasPinchStart, 'touches', { value: [{ clientX: 50, clientY: 50 }, { clientX: 150, clientY: 150 }] });
    mapCanvas.dispatchEvent(canvasPinchStart);
    assert.equal(canvasPinchStart.defaultPrevented, false, '2-finger touchstart on canvas stays usable for map/3D handlers');

    // 3) Multi-touch touchmove is ALWAYS prevented at document bubble phase so page never zooms
    const pinchMove = new dom.window.Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(pinchMove, 'touches', { value: [{ clientX: 40, clientY: 40 }, { clientX: 180, clientY: 180 }] });
    hudDiv.dispatchEvent(pinchMove);
    assert.equal(pinchMove.defaultPrevented, true, '2-finger touchmove must be prevented to block page pinch-zoom');

    // 4) Double-tap touchend on non-interactive div is prevented, while rapid button taps are NOT swallowed
    const tap1 = new dom.window.Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(tap1, 'touches', { value: [] });
    Object.defineProperty(tap1, 'changedTouches', { value: [{ clientX: 100, clientY: 100 }] });
    hudDiv.dispatchEvent(tap1);
    assert.equal(tap1.defaultPrevented, false);

    const tap2 = new dom.window.Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(tap2, 'touches', { value: [] });
    Object.defineProperty(tap2, 'changedTouches', { value: [{ clientX: 104, clientY: 102 }] });
    hudDiv.dispatchEvent(tap2);
    assert.equal(tap2.defaultPrevented, true, 'Double-tap on non-interactive area must be blocked to stop zoom');

    const btnTap1 = new dom.window.Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(btnTap1, 'touches', { value: [] });
    Object.defineProperty(btnTap1, 'changedTouches', { value: [{ clientX: 100, clientY: 100 }] });
    actionBtn.dispatchEvent(btnTap1);
    const btnTap2 = new dom.window.Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(btnTap2, 'touches', { value: [] });
    Object.defineProperty(btnTap2, 'changedTouches', { value: [{ clientX: 100, clientY: 100 }] });
    actionBtn.dispatchEvent(btnTap2);
    assert.equal(btnTap2.defaultPrevented, false, 'Rapid taps on buttons must never be swallowed');

    // 5) Ctrl+wheel zoom on HUD is prevented
    const ctrlWheel = new dom.window.Event('wheel', { bubbles: true, cancelable: true });
    Object.defineProperty(ctrlWheel, 'ctrlKey', { value: true });
    hudDiv.dispatchEvent(ctrlWheel);
    assert.equal(ctrlWheel.defaultPrevented, true, 'Ctrl+wheel browser zoom must be prevented on mobile');

    // 6) Stray root scroll drift resets back to (0, 0) on focusout so HUD buttons never drift off-screen
    let scrolledTo = null;
    Object.defineProperty(dom.window, 'scrollY', { value: 84, configurable: true, writable: true });
    dom.window.scrollTo = (x, y) => {
      scrolledTo = [x, y];
    };
    dom.window.document.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }));
    assert.deepEqual(scrolledTo, [0, 0], 'Stray viewport scroll drift must snap back to (0, 0) on keyboard close');

    hudDiv.remove();
    mapCanvas.remove();
    actionBtn.remove();
    cleanupLock();
    assert.equal(dom.window.document.documentElement.classList.contains('mobile-portrait-locked'), false);
  });
});
