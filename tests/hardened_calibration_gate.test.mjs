import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import {
  CALIBRATION_CAMERA_LOST_MS,
  CALIBRATION_MAG_INTERFERENCE_MS,
  CALIBRATION_OCCLUDED_LOST_MS,
  CALIBRATION_ORB_FALLBACK_WAIT_MS,
  CALIBRATION_RELOCK_GRACE_MS,
  CALIBRATION_SENSOR_STALL_MS,
  computeRelocationThresholdMeters,
  createCalibrationHealthState,
  evaluateCalibrationReadiness,
  isSessionOrbRelockMatch,
  resolveRelativeOrbBucket,
  stepCalibrationHealthMonitor
} from '../client/src/utils/arCalibrationManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
    outfile: absOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl' }
  });
  return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://spray.land/'
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  // Minimal 2D canvas stub for jsdom (ForegroundOcclusionCompositor allocates an offscreen 2D canvas)
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage: () => {},
    clearRect: () => {},
    getImageData: (_x, _y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
  });

  React = (await import('react')).default;
  RTL = await import('@testing-library/react');
  cleanup = RTL.cleanup;
  outTmpDir = fs.mkdtempSync(path.join(ROOT, '.cal-gate-test-cache-'));
});

after(() => {
  cleanup?.();
  dom?.window?.close();
  try {
    fs.rmSync(outTmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('Hardened Cross-Browser Calibration Engine, Drawing Gate & Center->Bottom-Right UI', () => {
  test('Balanced Smart Lock evaluates visual+motion readiness cleanly across devices without requiring GPS to draw', () => {
    // Relative ORB buckets work symmetrically regardless of absolute compass direction
    assert.equal(resolveRelativeOrbBucket(-25), 'left');
    assert.equal(resolveRelativeOrbBucket(0), 'center');
    assert.equal(resolveRelativeOrbBucket(22), 'right');

    // Accuracy-aware relocation threshold prevents indoor multipath false drops
    assert.equal(computeRelocationThresholdMeters(5, 5), 15);
    assert.equal(computeRelocationThresholdMeters(12, 10), 24);
    assert.equal(computeRelocationThresholdMeters(25, 25), 35);

    // 1. Missing camera blocks calibration
    const noCam = evaluateCalibrationReadiness({
      cameraReady: false,
      cameraFrames: 0,
      scannedCount: 8,
      orbKeyframes: 2,
      orientationInitialized: true
    });
    assert.equal(noCam.sufficient, false);
    assert.equal(noCam.blockingStep, 'camera');

    // 2. iOS Safari needing 1-tap motion permission blocks calibration
    const iosTap = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 6,
      sceneContrast: 14,
      needsGyroTap: true,
      scannedCount: 8,
      orbKeyframes: 2
    });
    assert.equal(iosTap.sufficient, false);
    assert.equal(iosTap.blockingStep, 'motion');

    // 3. Dark/covered lens blocks calibration
    const occluded = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 5,
      sceneContrast: 0.2,
      horizonLuminance: 4,
      orientationInitialized: true,
      scannedCount: 8,
      orbKeyframes: 2
    });
    assert.equal(occluded.sufficient, false);
    assert.equal(occluded.blockingStep, 'occluded');

    // 4. Needs 7 swept sectors + 2 ORB keyframes on standard cross-browser AR
    const partialSweep = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 6,
      sceneContrast: 16,
      orientationInitialized: true,
      scannedCount: 5,
      orbKeyframes: 2,
      orbWorkerSupported: true
    });
    assert.equal(partialSweep.sufficient, false);
    assert.equal(partialSweep.blockingStep, 'sweep');

    const needsOrb = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 6,
      sceneContrast: 16,
      orientationInitialized: true,
      scannedCount: 7,
      orbKeyframes: 1,
      orbWorkerSupported: true,
      elapsedScanningMs: 2500
    });
    assert.equal(needsOrb.sufficient, false);
    assert.equal(needsOrb.blockingStep, 'orb');

    // 5. Unlocks drawing cleanly with Visual + Motion + 7 sectors + 2 ORB keyframes EVEN WITHOUT GPS!
    const readyIndoors = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 6,
      sceneContrast: 16,
      orientationInitialized: true,
      scannedCount: 7,
      orbKeyframes: 2,
      orbWorkerSupported: true,
      hasLocation: false
    });
    assert.equal(readyIndoors.sufficient, true);
    assert.equal(readyIndoors.progressPct, 100);
    assert.equal(readyIndoors.blockingStep, 'ready');
    assert.equal(readyIndoors.checks.gps, false);

    // 6. Low-texture blank wall fallback avoids soft-lock after wait window + full 9-sector sweep
    const lowTextureFallback = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 10,
      sceneContrast: 3,
      orientationInitialized: true,
      scannedCount: 9,
      orbKeyframes: 0,
      orbWorkerSupported: true,
      elapsedScanningMs: CALIBRATION_ORB_FALLBACK_WAIT_MS + 100
    });
    assert.equal(lowTextureFallback.sufficient, true);

    // 7. WebXR 6-DoF fast-tracks with 4 sectors + 1 ORB keyframe
    const webxrReady = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 5,
      sceneContrast: 12,
      webxrActive: true,
      scannedCount: 4,
      orbKeyframes: 1
    });
    assert.equal(webxrReady.sufficient, true);
  });

  test('Continuous health monitor ignores jitter/brief glitches, silently relocks via ORB, and pops loss on confirmed failures', () => {
    const anchor = { lat: 39.73, lng: -121.84, accuracy: 8 };
    const st = createCalibrationHealthState();

    // 1. Indoor 10m GPS jitter (threshold = 16m) stays calibrated
    const jitter = stepCalibrationHealthMonitor(st, {
      nowMs: 1000,
      anchorLocation: anchor,
      currentLocation: { lat: 39.73009, lng: -121.84, accuracy: 8 },
      currentLocationTs: 1000,
      lastOrientationEventTs: 950
    });
    assert.equal(jitter.status, 'calibrated');

    // 2. Single GPS multipath spike (20m, only 1 fix) stays calibrated (requires 2 fixes)
    const spike1 = stepCalibrationHealthMonitor(st, {
      nowMs: 2000,
      anchorLocation: anchor,
      currentLocation: { lat: 39.73018, lng: -121.84, accuracy: 8 },
      currentLocationTs: 2000,
      lastOrientationEventTs: 1950,
      hasSessionOrbKeyframes: true
    });
    assert.equal(spike1.status, 'calibrated');

    // 3. Second confirmed fix >= threshold enters silent 'relocalizing' first when ORB keyframes exist
    const spike2 = stepCalibrationHealthMonitor(st, {
      nowMs: 3000,
      anchorLocation: anchor,
      currentLocation: { lat: 39.73019, lng: -121.84, accuracy: 8 },
      currentLocationTs: 3000,
      lastOrientationEventTs: 2950,
      hasSessionOrbKeyframes: true
    });
    assert.equal(spike2.status, 'relocalizing');

    // 4. If session ORB matches -> silently heals back to 'calibrated' without interrupting user!
    assert.equal(isSessionOrbRelockMatch({ inlierCount: 8, reprojectionErrorPx: 6.4 }), true);
    assert.equal(isSessionOrbRelockMatch({ inlierCount: 3, reprojectionErrorPx: 5 }), false);
    const healed = stepCalibrationHealthMonitor(st, {
      nowMs: 3600,
      orbRelockMatched: true
    });
    assert.equal(healed.status, 'calibrated');
    assert.equal(healed.silentRelocked, true);

    // 5. Real relocation without ORB match expires grace window -> 'lost' with canStartFresh
    const stReloc = createCalibrationHealthState();
    stepCalibrationHealthMonitor(stReloc, {
      nowMs: 10000,
      anchorLocation: anchor,
      currentLocation: { lat: 39.73025, lng: -121.84, accuracy: 6 },
      currentLocationTs: 10000,
      lastOrientationEventTs: 9950,
      hasSessionOrbKeyframes: true
    });
    const relocStart = stepCalibrationHealthMonitor(stReloc, {
      nowMs: 11000,
      anchorLocation: anchor,
      currentLocation: { lat: 39.73026, lng: -121.84, accuracy: 6 },
      currentLocationTs: 11000,
      lastOrientationEventTs: 10950,
      hasSessionOrbKeyframes: true
    });
    assert.equal(relocStart.status, 'relocalizing');
    const relocLost = stepCalibrationHealthMonitor(stReloc, {
      nowMs: 11000 + CALIBRATION_RELOCK_GRACE_MS + 100,
      anchorLocation: anchor,
      currentLocation: { lat: 39.73026, lng: -121.84, accuracy: 6 },
      currentLocationTs: 11000,
      lastOrientationEventTs: 11000 + CALIBRATION_RELOCK_GRACE_MS + 50,
      hasSessionOrbKeyframes: true
    });
    assert.equal(relocLost.status, 'lost');
    assert.equal(relocLost.loss.code, 'relocated');
    assert.equal(relocLost.loss.canStartFresh, true);

    // 6. Brief magnetic interference (<4.5s) stays calibrated; sustained (>=4.5s) drops to lost
    const stMag = createCalibrationHealthState();
    assert.equal(
      stepCalibrationHealthMonitor(stMag, {
        nowMs: 1000,
        magneticInterference: true,
        lastOrientationEventTs: 950
      }).status,
      'calibrated'
    );
    assert.equal(
      stepCalibrationHealthMonitor(stMag, {
        nowMs: 1000 + CALIBRATION_MAG_INTERFERENCE_MS - 500,
        magneticInterference: true,
        lastOrientationEventTs: 1000 + CALIBRATION_MAG_INTERFERENCE_MS - 550
      }).status,
      'calibrated'
    );
    const magLost = stepCalibrationHealthMonitor(stMag, {
      nowMs: 1000 + CALIBRATION_MAG_INTERFERENCE_MS + 100,
      magneticInterference: true,
      lastOrientationEventTs: 1000 + CALIBRATION_MAG_INTERFERENCE_MS + 50
    });
    assert.equal(magLost.status, 'lost');
    assert.equal(magLost.loss.code, 'magnetic_interference');

    // 7. Sustained camera death, lens occlusion, and orientation stall each report clear loss codes
    const stCam = createCalibrationHealthState();
    stepCalibrationHealthMonitor(stCam, { nowMs: 1000, cameraReady: false, cameraRecovering: false });
    const camLost = stepCalibrationHealthMonitor(stCam, {
      nowMs: 1000 + CALIBRATION_CAMERA_LOST_MS + 50,
      cameraReady: false,
      cameraRecovering: false
    });
    assert.equal(camLost.status, 'lost');
    assert.equal(camLost.loss.code, 'camera_lost');

    const stOcc = createCalibrationHealthState();
    stepCalibrationHealthMonitor(stOcc, { nowMs: 1000, cameraReady: true, sceneContrast: 0.1, horizonLuminance: 3 });
    const occLost = stepCalibrationHealthMonitor(stOcc, {
      nowMs: 1000 + CALIBRATION_OCCLUDED_LOST_MS + 50,
      cameraReady: true,
      sceneContrast: 0.1,
      horizonLuminance: 3
    });
    assert.equal(occLost.status, 'lost');
    assert.equal(occLost.loss.code, 'camera_occluded');

    const stStall = createCalibrationHealthState();
    stepCalibrationHealthMonitor(stStall, {
      nowMs: 5000,
      hasOrientationHardware: true,
      lastOrientationEventTs: 5000 - CALIBRATION_SENSOR_STALL_MS - 10
    });
    const stallLost = stepCalibrationHealthMonitor(stStall, {
      nowMs: 5700,
      hasOrientationHardware: true,
      lastOrientationEventTs: 5000 - CALIBRATION_SENSOR_STALL_MS - 10
    });
    assert.equal(stallLost.status, 'lost');
    assert.equal(stallLost.loss.code, 'sensor_stalled');
  });

  test('useVoxelBrush strictly blocks adding art until calibrated and preserves placed voxels when calibration is lost', async () => {
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');
    const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 100);
    camera.position.set(0, 0.4, 2.2);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const draftGroup = new THREE.Group();

    let hookApi = null;
    let requireCalibrationCalls = 0;
    let setCalReady = null;

    function Harness() {
      const [calReady, _setCalReady] = React.useState(false);
      setCalReady = _setCalReady;
      const api = useVoxelBrush({
        config: {},
        initialDraft: { voxels: [], color: '#00f5d4', material: 'matte' },
        user: null,
        location: null,
        locationRef: { current: null },
        cameraReady: true,
        sceneScan: { optimal: calReady, scannedCount: calReady ? 7 : 2, targetCount: 7 },
        calibrationReady: calReady,
        calibrationBlockReason: 'Calibrate AR space before drawing.',
        onRequireCalibration: () => {
          requireCalibrationCalls += 1;
        },
        polRef: { current: { analyzeSurfacePatch: () => null } },
        rawOrientationRef: { current: { alpha: 0, beta: 90, gamma: 0 } },
        fallbackEulerRef: { current: { yaw: 0, pitch: 0 } },
        enterFullscreen: () => {},
        setSensorBanner: () => {},
        showTemporaryHint: () => {},
        canvasHostRef: { current: null },
        cameraRef: { current: camera },
        draftGroupRef: { current: draftGroup },
        transformBoxRef: { current: null },
        surfaceMarkerRef: { current: null },
        shadowPlaneRef: { current: null },
        gridHelperRef: { current: null },
        nearbyGroupRef: { current: null },
        arTargetedIdRef: { current: '' },
        setArTargetedSculpture: () => {},
        arPinPreview: null,
        openCameraSelectedChat: () => {}
      });
      hookApi = api;
      return null;
    }

    const view = RTL.render(React.createElement(Harness));

    // 1. Before calibrated: brush/pencil/stack are strictly disabled and add ZERO voxels
    assert.equal(hookApi.toolAvailability.brush.usable, false);
    assert.equal(hookApi.toolAvailability.pencil.usable, false);
    assert.equal(hookApi.toolAvailability.stack.usable, false);

    await RTL.act(async () => {
      hookApi.applyVoxelBatch([{ action: 'add', x: 0, y: 0, z: 0.4, scale: 1 }]);
      hookApi.applyVoxelAction({ action: 'add', x: 0.05, y: 0, z: 0.4, scale: 1 });
      hookApi.startContinuousHoldTool('brush');
    });
    assert.equal(hookApi.voxels.length, 0, 'Must NEVER add voxels before calibration is sufficient');
    assert.equal(hookApi.painting, false);
    assert.ok(requireCalibrationCalls >= 2);

    // 2. Once calibrated: drawing unlocks cleanly!
    await RTL.act(async () => {
      setCalReady(true);
    });
    assert.equal(hookApi.toolAvailability.brush.usable, true);
    assert.equal(hookApi.toolAvailability.pencil.usable, true);

    await RTL.act(async () => {
      hookApi.applyVoxelBatch([
        { action: 'add', x: 0, y: 0, z: 0.4, scale: 1 },
        { action: 'add', x: 0.05, y: 0, z: 0.4, scale: 1 }
      ]);
    });
    assert.equal(hookApi.voxels.length, 2);

    // 3. When calibration is lost mid-session: painting stops, existing voxels are PRESERVED, new additions blocked!
    await RTL.act(async () => {
      hookApi.startContinuousHoldTool('brush');
    });
    assert.equal(hookApi.painting, true);

    await RTL.act(async () => {
      setCalReady(false);
    });
    assert.equal(hookApi.painting, false, 'Active spraying must stop immediately on calibration loss');
    const preservedCount = hookApi.voxels.length;
    assert.ok(preservedCount >= 2, 'Existing placed voxels must be preserved when calibration drops');

    await RTL.act(async () => {
      hookApi.applyVoxelBatch([{ action: 'add', x: 0.25, y: 0.25, z: 0.4, scale: 1 }]);
    });
    assert.equal(hookApi.voxels.length, preservedCount, 'No new voxels may be added while calibration is lost');

    view.unmount();
  });

  test('SceneCoverageWidget starts front-and-center, minimizes to bottom-right icon when calibrated, and pops back up center on loss', async () => {
    const { default: SceneCoverageWidget } = await loadJsxModule(
      'client/src/components/studio/SceneCoverageWidget.jsx'
    );

    let motionTapCount = 0;
    let toggleCount = 0;
    let restartReason = '';
    let startFreshCount = 0;

    const baseScan = {
      coveragePct: 42,
      scannedCount: 3,
      targetCount: 7,
      sectors: Array.from({ length: 12 }, (_, i) => i < 3),
      cursorX: 0.5,
      cursorY: 0.5,
      optimal: false,
      precisionMeters: 1.4,
      hint: 'Pan left to sharpen lock'
    };

    // 1. Calibrating state -> FRONT AND CENTER with inline iOS motion button & gate notice
    const view1 = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: baseScan,
        orbStatus: { engine: 'Gyro+ORB', keyframes: 1, relocalizedInliers: 0 },
        scanBoxCollapsed: false,
        onToggleCollapse: () => {
          toggleCount += 1;
        },
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrating',
        calibrationReadiness: {
          sufficient: false,
          progressPct: 45,
          sweepTarget: 7,
          orbTarget: 2,
          headline: 'Enable Motion Sensors',
          subHint: 'Tap Enable Motion & Compass to lock 3D tracking.',
          checks: { camera: true, motion: false, sweep: false, orb: false, gps: false }
        },
        cameraReady: true,
        needsGyroTap: true,
        onEnableIosGyro: () => {
          motionTapCount += 1;
        },
        onRestartMapping: (r) => {
          restartReason = r;
        }
      })
    );
    const widget1 = view1.getByTestId('scene-coverage-widget');
    assert.equal(widget1.getAttribute('data-placement'), 'center');
    assert.equal(widget1.getAttribute('data-calibration-state'), 'calibrating');
    assert.ok(view1.getByTestId('calibration-center-card'));
    assert.ok(view1.getByText(/Drawing unlocks automatically once calibrated/i));
    RTL.fireEvent.click(view1.getByTestId('calibration-enable-motion-btn'));
    assert.equal(motionTapCount, 1);
    view1.unmount();

    // 2. Calibrated + collapsed -> MINIMIZED BOTTOM-RIGHT ICON with brief Calibrated! flash
    const view2 = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: { ...baseScan, coveragePct: 100, scannedCount: 7, optimal: true },
        orbStatus: { engine: 'Gyro+ORB', keyframes: 2, relocalizedInliers: 14 },
        scanBoxCollapsed: true,
        onToggleCollapse: () => {
          toggleCount += 1;
        },
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrated',
        calibrationJustLocked: true,
        onRestartMapping: (r) => {
          restartReason = r;
        }
      })
    );
    const widget2 = view2.getByTestId('scene-coverage-widget');
    assert.equal(widget2.getAttribute('data-placement'), 'bottom-right');
    assert.equal(widget2.getAttribute('data-calibration-state'), 'calibrated');
    assert.ok(view2.getByText('Calibrated!'));
    RTL.fireEvent.click(view2.getByTestId('calibration-minimized-fab'));
    assert.equal(toggleCount, 1);
    view2.unmount();

    // 3. Calibration LOST with 5 placed blocks -> POPS BACK FRONT AND CENTER, preserves blocks, offers Start Fresh
    const view3 = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: baseScan,
        orbStatus: { engine: 'Gyro+ORB', keyframes: 2, relocalizedInliers: 0 },
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'lost',
        calibrationLoss: {
          code: 'relocated',
          movedSubstantially: true,
          canStartFresh: true,
          title: 'Location Changed',
          summary: 'Moved ~22m — pan slowly to re-lock this spot.'
        },
        voxelCount: 5,
        onRestartMapping: (r) => {
          restartReason = r;
        },
        onStartFresh: () => {
          startFreshCount += 1;
        }
      })
    );
    const widget3 = view3.getByTestId('scene-coverage-widget');
    assert.equal(widget3.getAttribute('data-placement'), 'center');
    assert.equal(widget3.getAttribute('data-calibration-state'), 'lost');
    assert.equal(widget3.getAttribute('data-needs-restart'), 'true');
    assert.ok(view3.getByTestId('calibration-preserved-note').textContent.includes('5 placed blocks'));
    RTL.fireEvent.click(view3.getByTestId('scene-scan-restart-btn'));
    assert.equal(restartReason, 'relocated');
    RTL.fireEvent.click(view3.getByTestId('calibration-start-fresh-btn'));
    assert.equal(startFreshCount, 1);
    view3.unmount();
  });
});
