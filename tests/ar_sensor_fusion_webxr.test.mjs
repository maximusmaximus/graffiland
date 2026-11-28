import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import { estimateMagneticDeclinationDeg } from '../client/src/utils/geomagneticDeclination.js';
import {
  ArOrientationFusion,
  ArPositionKalmanFilter,
  absoluteSensorQuatToThreeCameraQuat,
  estimateCameraVerticalFovDeg,
  extractCameraHeadingDegFromQuat,
  normalizeDeg360,
  shortestSignedAngleDeg
} from '../client/src/utils/arSensorFusion.js';
import {
  computeWebXrInitialYawAlignmentRad,
  mapWebXrPoseToTrueNorthWorld
} from '../client/src/utils/webxrArSession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEG2RAD = Math.PI / 180;

/**
 * Helper: constructs a W3C AbsoluteOrientationSensor quaternion `[qx, qy, qz, qw]`
 * for a phone held vertically upright facing `magHeadingDeg` clockwise from Magnetic North.
 */
function makeUprightW3cSensorQuat(magHeadingDeg = 0) {
  // Base upright facing Magnetic North: +90 deg around +X maps device -Z -> Earth +Y (Mag North), device +Y -> Earth +Z (Up)
  const qUpright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  // Clockwise heading rotation around Earth +Z (Up) is negative angle around +Z
  const qHeading = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    -magHeadingDeg * DEG2RAD
  );
  const q = qHeading.multiply(qUpright).normalize();
  return [q.x, q.y, q.z, q.w];
}

describe('AR Multi-Sensor Orientation Fusion, Position Kalman Filter & WebXR 6-DoF', () => {
  test('WMM-2025 geomagnetic declination matches NOAA reference values globally within ~0.5°', () => {
    const refDate = new Date('2026-06-01T00:00:00Z');
    const checks = [
      { name: 'San Francisco', lat: 37.7749, lng: -122.4194, expected: 12.8, tol: 0.8 },
      { name: 'New York', lat: 40.7128, lng: -74.006, expected: -12.6, tol: 0.8 },
      { name: 'Seattle', lat: 47.6062, lng: -122.3321, expected: 15.2, tol: 0.8 },
      { name: 'London', lat: 51.5074, lng: -0.1278, expected: 1.2, tol: 0.8 },
      { name: 'Tokyo', lat: 35.6762, lng: 139.6503, expected: -7.9, tol: 0.8 },
      { name: 'Sydney', lat: -33.8688, lng: 151.2093, expected: 12.9, tol: 0.8 },
      { name: 'Miami', lat: 25.7617, lng: -80.1918, expected: -7.1, tol: 0.8 }
    ];

    for (const c of checks) {
      const decl = estimateMagneticDeclinationDeg(c.lat, c.lng, refDate);
      assert.ok(
        Math.abs(decl - c.expected) <= c.tol,
        `${c.name} declination ${decl}° expected within ±${c.tol}° of ${c.expected}°`
      );
    }

    assert.equal(estimateMagneticDeclinationDeg(NaN, -122), 0);
    assert.equal(estimateMagneticDeclinationDeg(37, undefined), 0);
  });

  test('absoluteSensorQuatToThreeCameraQuat aligns W3C Magnetic ENU sensor quaternions to True North Three.js frame', () => {
    // 1. Facing Magnetic North (0°) with 0° declination -> True North (0°)
    const qNorth = absoluteSensorQuatToThreeCameraQuat(makeUprightW3cSensorQuat(0), 0, 0);
    assert.ok(Math.abs(shortestSignedAngleDeg(extractCameraHeadingDegFromQuat(qNorth), 0)) < 0.2);

    // 2. Facing Magnetic North (0°) in San Francisco (+12.8° East declination) -> True heading 12.8°
    const qSfNorth = absoluteSensorQuatToThreeCameraQuat(makeUprightW3cSensorQuat(0), 0, 12.8);
    assert.ok(Math.abs(shortestSignedAngleDeg(extractCameraHeadingDegFromQuat(qSfNorth), 12.8)) < 0.2);

    // 3. Facing Magnetic East (90°) in New York (-12.5° West declination) -> True heading 77.5°
    const qNycEast = absoluteSensorQuatToThreeCameraQuat(makeUprightW3cSensorQuat(90), 0, -12.5);
    assert.ok(Math.abs(shortestSignedAngleDeg(extractCameraHeadingDegFromQuat(qNycEast), 77.5)) < 0.2);

    // 4. Facing Magnetic West (270°) with +15° declination -> True heading 285°
    const qWest = absoluteSensorQuatToThreeCameraQuat(makeUprightW3cSensorQuat(270), 0, 15);
    assert.ok(Math.abs(shortestSignedAngleDeg(extractCameraHeadingDegFromQuat(qWest), 285)) < 0.2);

    // 5. Invalid sensor quaternion returns identity cleanly
    const qFallback = absoluteSensorQuatToThreeCameraQuat(null, 0, 12);
    assert.equal(qFallback.w, 1);
    assert.equal(normalizeDeg360(-90), 270);
  });

  test('ArOrientationFusion locks Android AbsoluteOrientationSensor to True North and rejects magnetic spikes', () => {
    const fusion = new ArOrientationFusion();
    fusion.setLocation(37.7749, -122.4194, new Date('2026-06-01T00:00:00Z')); // ~+12.8° declination

    const t0 = 10000;
    // Phone pointing Magnetic North -> True Heading ~12.8°
    fusion.updateFromAbsoluteSensor(makeUprightW3cSensorQuat(0), 0, t0);
    const h0 = fusion.getTrueHeadingDeg();
    assert.ok(Math.abs(shortestSignedAngleDeg(h0, fusion.declinationDeg)) < 0.5);
    assert.equal(fusion.source, 'absolute-sensor');
    assert.equal(fusion.trueNorthLocked, true);

    // Feed stationary gyro reading (0 deg/s) via devicemotion
    fusion.updateFromDeviceMotion(
      {
        rotationRate: { alpha: 0.2, beta: 0.1, gamma: 0.1 },
        accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 }
      },
      0,
      t0 + 20
    );

    // Inject sudden +55° magnetic anomaly near steel beam while phone is stationary
    fusion.updateFromAbsoluteSensor(makeUprightW3cSensorQuat(55), 0, t0 + 40);
    const hAfterSpike = fusion.getTrueHeadingDeg();
    const jump = Math.abs(shortestSignedAngleDeg(hAfterSpike, h0));
    assert.ok(jump < 7, `Magnetic spike should be heavily damped (jumped ${jump.toFixed(1)}°)`);
    assert.equal(fusion.magneticInterference, true);
    assert.equal(fusion.getSensorQuality({ gpsAccuracyM: 5 }).needsCompassCalibration, true);
  });

  test('ArOrientationFusion fuses iOS webkitCompassHeading + gyro delta, rejects stationary magnetic spikes, and supports ORB + manual nudge', () => {
    const fusion = new ArOrientationFusion();
    const t0 = 20000;

    // Initial iOS compass lock at True Heading 90° (East), phone upright (beta=90, gamma=0)
    fusion.updateFromDeviceOrientation(
      {
        alpha: 10,
        beta: 90,
        gamma: 0,
        webkitCompassHeading: 90,
        webkitCompassAccuracy: 8
      },
      0,
      t0
    );
    assert.equal(fusion.source, 'ios-compass-fused');
    assert.equal(fusion.trueNorthLocked, true);
    assert.ok(Math.abs(shortestSignedAngleDeg(fusion.getTrueHeadingDeg(), 90)) < 1.0);

    // Smooth real user pan 15° clockwise (relative alpha decreases by 15° CCW, compass moves to 105°)
    fusion.updateFromDeviceOrientation(
      {
        alpha: 355,
        beta: 90,
        gamma: 0,
        webkitCompassHeading: 105,
        webkitCompassAccuracy: 8
      },
      0,
      t0 + 60
    );
    assert.ok(
      Math.abs(shortestSignedAngleDeg(fusion.getTrueHeadingDeg(), 105)) < 1.5,
      `Expected ~105° after smooth pan, got ${fusion.getTrueHeadingDeg()}°`
    );

    // Sudden +40° compass glitch while relative gyro stays frozen at alpha=355
    const beforeSpike = fusion.getTrueHeadingDeg();
    fusion.updateFromDeviceOrientation(
      {
        alpha: 355,
        beta: 90,
        gamma: 0,
        webkitCompassHeading: 145,
        webkitCompassAccuracy: 10
      },
      0,
      t0 + 120
    );
    assert.equal(fusion.magneticInterference, true);
    assert.ok(
      Math.abs(shortestSignedAngleDeg(fusion.getTrueHeadingDeg(), beforeSpike)) < 2.0,
      'Stationary iOS magnetic spike should barely move camera heading'
    );

    // Manual compass fine-align nudge (+5°) shifts heading cleanly & clamps to [-45, +45]
    const hBeforeNudge = fusion.getTrueHeadingDeg();
    fusion.adjustManualYawNudgeDeg(5);
    assert.ok(Math.abs(shortestSignedAngleDeg(fusion.getTrueHeadingDeg(), hBeforeNudge + 5)) < 0.4);
    assert.equal(fusion.setManualYawNudgeDeg(80), 45);
    assert.equal(fusion.setManualYawNudgeDeg(-80), -45);
    fusion.setManualYawNudgeDeg(0);

    // ORB visual yaw correction shifts final camera quaternion heading
    const hBeforeOrb = fusion.getTrueHeadingDeg();
    fusion.setOrbYawCorrectionRad(-10 * DEG2RAD); // -10° around +Y = +10° clockwise heading
    assert.ok(Math.abs(shortestSignedAngleDeg(fusion.getTrueHeadingDeg(), hBeforeOrb + 10)) < 0.4);
  });

  test('ArOrientationFusion supports Android deviceorientationabsolute, gravity horizon stabilization & walking GPS course bias', () => {
    const fusion = new ArOrientationFusion();
    fusion.setLocation(40.7128, -74.006, new Date('2026-06-01T00:00:00Z')); // NYC ~-12.5°

    // Android deviceorientationabsolute: alpha=0 (Magnetic North), upright (beta=90, gamma=0)
    // True North heading should be ~347.5° (12.5° West of True North)
    fusion.updateFromDeviceOrientation(
      { absolute: true, alpha: 0, beta: 90, gamma: 0 },
      0,
      30000
    );
    assert.equal(fusion.source, 'absolute-euler');
    assert.equal(fusion.trueNorthLocked, true);
    const expectedHeading = normalizeDeg360(fusion.declinationDeg);
    assert.ok(Math.abs(shortestSignedAngleDeg(fusion.getTrueHeadingDeg(), expectedHeading)) < 1.0);

    // Introduce a small 8° roll tilt, then feed stationary gravity (0, 9.81, 0) via devicemotion
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 8 * DEG2RAD);
    fusion.quat.multiply(qRoll).normalize();
    const tiltedUp = new THREE.Vector3(0, 1, 0).applyQuaternion(fusion.quat);
    const tiltBefore = Math.acos(Math.max(-1, Math.min(1, tiltedUp.y)));

    let ts = 30020;
    for (let i = 0; i < 15; i += 1) {
      ts += 20;
      fusion.updateFromDeviceMotion(
        {
          rotationRate: { alpha: 0, beta: 0, gamma: 0 },
          accelerationIncludingGravity: { x: 0, y: 9.81, z: 0 }
        },
        0,
        ts
      );
    }
    const stabilizedUp = new THREE.Vector3(0, 1, 0).applyQuaternion(fusion.quat);
    const tiltAfter = Math.acos(Math.max(-1, Math.min(1, stabilizedUp.y)));
    assert.ok(
      tiltAfter < tiltBefore * 0.7,
      `Gravity horizon stabilization should reduce tilt (${tiltBefore.toFixed(3)} -> ${tiltAfter.toFixed(3)} rad)`
    );

    // Walking GPS course-over-ground cross-check gently learns persistent magnetometer bias
    const hBeforeBias = fusion.getTrueHeadingDeg();
    for (let i = 0; i < 6; i += 1) {
      fusion.updateFromGpsCourse({
        headingDeg: normalizeDeg360(hBeforeBias + 12),
        speedMps: 1.4,
        accuracyM: 6
      });
    }
    assert.ok(fusion.courseBiasDeg > 2.0 && fusion.courseBiasDeg < 12.0);
  });

  test('ArPositionKalmanFilter smooths GPS, rejects multipath spikes, gates teleports, and tracks IMU steps', () => {
    const kf = new ArPositionKalmanFilter();
    const baseLat = 37.7749;
    const baseLng = -122.4194;
    const mPerDegLng = 111320 * Math.cos(baseLat * DEG2RAD);

    let t = 50000;
    const f1 = kf.updateGps({ latitude: baseLat, longitude: baseLng, accuracy: 5 }, t);
    assert.ok(Math.abs(f1.lat - baseLat) < 1e-6);

    t += 1000;
    kf.updateGps({ latitude: baseLat + 0.5 / 111320, longitude: baseLng, accuracy: 5 }, t);

    // 1) Low-accuracy multipath glitch 45m away must be rejected completely
    const beforeGlitch = kf.getFilteredLocation();
    t += 1000;
    const afterGlitch = kf.updateGps(
      { latitude: baseLat + 45 / 111320, longitude: baseLng, accuracy: 65 },
      t
    );
    assert.ok(
      Math.abs((afterGlitch.lat - beforeGlitch.lat) * 111320) < 0.8,
      'Multipath 65m-accuracy glitch must be rejected'
    );

    // 2) Single impossible high-speed teleport (50m in 1s) must be gated on 1st fix
    t += 1000;
    const afterTeleport1 = kf.updateGps(
      { latitude: baseLat, longitude: baseLng + 50 / mPerDegLng, accuracy: 8 },
      t
    );
    assert.ok(
      Math.abs((afterTeleport1.lng - beforeGlitch.lng) * mPerDegLng) < 1.5,
      'Single-fix teleport should be gated until confirmed'
    );

    // 3) Confirming 2nd fix at the new location accepts real relocation cleanly
    t += 1000;
    const afterTeleport2 = kf.updateGps(
      { latitude: baseLat, longitude: baseLng + 50.4 / mPerDegLng, accuracy: 8 },
      t
    );
    assert.ok(
      Math.abs((afterTeleport2.lng - (baseLng + 50.4 / mPerDegLng)) * mPerDegLng) < 2.0,
      'Confirmed relocation on 2nd fix should snap filter cleanly'
    );

    // 4) IMU step detection advances smoothly along True-North heading (East = 90°) and stays 0 when standing still
    const refLoc = kf.getFilteredLocation();
    // Standing still (steady 1g) does NOT trigger steps
    t += 200;
    assert.equal(
      kf.updateImuMotion({
        accelWithGravity: { x: 0, y: 9.81, z: 0 },
        headingDeg: 90,
        nowMs: t
      }),
      false
    );
    const deltaStill = kf.getLiveSubmeterDeltaMeters(refLoc, t + 100);
    assert.ok(Math.hypot(deltaStill.east, deltaStill.north) < 0.2);

    // Two rhythmic walking footsteps East (heading = 90°)
    t += 400;
    assert.equal(
      kf.updateImuMotion({
        accelWithGravity: { x: 0, y: 12.2, z: 0 },
        headingDeg: 90,
        nowMs: t
      }),
      true
    );
    t += 450;
    assert.equal(
      kf.updateImuMotion({
        accelWithGravity: { x: 0, y: 12.3, z: 0 },
        headingDeg: 90,
        nowMs: t
      }),
      true
    );
    const deltaWalking = kf.getLiveSubmeterDeltaMeters(refLoc, t + 400);
    assert.ok(
      deltaWalking.east > 0.3 && deltaWalking.east <= 3.5,
      `Walking East should advance smooth positive East delta (got ${deltaWalking.east.toFixed(2)}m)`
    );
    assert.ok(Math.abs(deltaWalking.north) < 0.15);
  });

  test('estimateCameraVerticalFovDeg adapts to portrait, landscape & camera zoom', () => {
    const portraitFov = estimateCameraVerticalFovDeg({
      viewportWidth: 390,
      viewportHeight: 844
    });
    const landscapeFov = estimateCameraVerticalFovDeg({
      viewportWidth: 844,
      viewportHeight: 390
    });
    const zoomedFov = estimateCameraVerticalFovDeg({
      viewportWidth: 390,
      viewportHeight: 844,
      videoTrack: { getSettings: () => ({ zoom: 2, width: 1920, height: 1080 }) }
    });

    assert.ok(portraitFov >= 60 && portraitFov <= 68);
    assert.ok(landscapeFov < portraitFov);
    assert.ok(zoomedFov < portraitFov - 20 && zoomedFov >= 34);
  });

  test('WebXR 6-DoF session helpers seed initial heading to True North and map walking displacement', () => {
    // User starts WebXR facing local XR -Z (identity quat), while fused compass says 90° True East
    const initQuat = { x: 0, y: 0, z: 0, w: 1 };
    const yawOffset = computeWebXrInitialYawAlignmentRad(initQuat, 90);

    // User walks 2.0m straight forward in XR local space (z = -2.0m) -> should move +2.0m East (+X) in True North world!
    const worldPose = mapWebXrPoseToTrueNorthWorld({
      xrPos: { x: 0, y: 0.1, z: -2.0 },
      xrQuat: initQuat,
      anchorYawOffsetRad: yawOffset,
      anchorOriginXrPos: { x: 0, y: 0, z: 0 },
      baseCameraPos: { x: 0, y: 0.4, z: 2.2 }
    });

    assert.ok(Math.abs(worldPose.position.x - 2.0) < 1e-4, `Expected +2.0m East, got ${worldPose.position.x}`);
    assert.ok(Math.abs(worldPose.position.y - 0.5) < 1e-4);
    assert.ok(Math.abs(worldPose.position.z - 2.2) < 1e-4);
    const heading = extractCameraHeadingDegFromQuat(worldPose.quaternion);
    assert.ok(Math.abs(shortestSignedAngleDeg(heading, 90)) < 0.2);
  });

  test('Hooks and AR viewport wire True-North sensor fusion, draft-only yaw decoupling, ORB visits & publish world heading', () => {
    const polSrc = fs.readFileSync(path.join(ROOT, 'client/src/hooks/useProofOfLocation.js'), 'utf8');
    assert.match(polSrc, /AbsoluteOrientationSensor/);
    assert.match(polSrc, /deviceorientationabsolute/);
    assert.match(polSrc, /devicemotion/);
    assert.match(polSrc, /DeviceMotionEvent\.requestPermission/);
    assert.match(polSrc, /maximumAge:\s*0/);
    assert.match(polSrc, /draftYawOffsetRef/);
    assert.match(polSrc, /adjustCompassNudge/);

    const previewSrc = fs.readFileSync(path.join(ROOT, 'client/src/hooks/useARPreview.js'), 'utf8');
    assert.match(previewSrc, /setOrbYawCorrectionRad/);
    assert.match(previewSrc, /shouldRelocalize/);

    const canvasSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(canvasSrc, /orientationFusionRef\.current\.getCameraQuaternion/);
    assert.match(canvasSrc, /draftGroup\.rotation\.y\s*=\s*draftYaw/);
    assert.match(canvasSrc, /getLiveSubmeterDeltaMeters/);
    assert.match(canvasSrc, /estimateCameraVerticalFovDeg/);
    assert.match(canvasSrc, /startWebXrArSession/);

    const studioSrc = fs.readFileSync(path.join(ROOT, 'client/src/components/MobileStudio.jsx'), 'utf8');
    assert.match(studioSrc, /draftYawRad \+ localTransformYawRad/);
    assert.match(studioSrc, /getTrueHeadingDeg\(\)/);
    assert.match(studioSrc, /sensorFusion:\s*pol\.sensorStatus/);
  });
});

describe('AR Sensor Status Pill, Calibration Prompt & Compass Fine-Align UI (React)', () => {
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
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ar-sensor-ui-test-cache-'));
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

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(async () => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('StudioHudTopBar displays True North / 6-DoF ARCore status pill without on-screen 6-DoF toggle button', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const baseProps = {
      user: null,
      mode: 'preview',
      dockOpen: false,
      location: { lat: 37.7749, lng: -122.4194 },
      voxels: [],
      quickSculpt: false,
      cameraReady: true,
      originStatus: { originBlocked: false, reason: '' },
      sceneScan: { optimal: true, coveragePct: 100, scannedCount: 9, targetCount: 9 },
      isInteractingWithLand: true,
      webxrActive: false,
      sensorStatus: {
        source: 'ios-compass-fused',
        trueNorthLocked: true,
        headingDeg: 142.3,
        headingAccuracyDeg: 6,
        gpsAccuracyM: 4,
        magneticInterference: false,
        needsCompassCalibration: false,
        declinationDeg: 12.8,
        manualYawNudgeDeg: 0
      }
    };

    const view = RTL.render(React.createElement(StudioHudTopBar, baseProps));
    const pill = view.getByTestId('ar-sensor-status-pill');
    assert.ok(pill.textContent.includes('True North ±6° · GPS ±4m'));
    assert.equal(pill.getAttribute('data-true-north'), 'true');
    assert.equal(
      view.queryByTestId('ar-webxr-toggle-btn'),
      null,
      'On-screen 6-DoF AR button must be removed from StudioHudTopBar'
    );

    // Rerender in magnetic-interference calibration warning state
    view.rerender(
      React.createElement(StudioHudTopBar, {
        ...baseProps,
        sensorStatus: {
          ...baseProps.sensorStatus,
          magneticInterference: true,
          needsCompassCalibration: true
        }
      })
    );
    assert.ok(
      view.getByTestId('ar-sensor-status-pill').textContent.includes('figure-8')
    );

    // Rerender in active WebXR 6-DoF state: top 6-DoF ARCore Lock pill & on-screen button are both hidden
    view.rerender(
      React.createElement(StudioHudTopBar, {
        ...baseProps,
        webxrActive: true
      })
    );
    assert.equal(
      view.queryByTestId('ar-sensor-status-pill'),
      null,
      'Top 6-DoF ARCore Lock pill must be removed when WebXR is active'
    );
    assert.equal(view.queryByTestId('ar-webxr-toggle-btn'), null);
    view.unmount();
  });

  test('ARLandInspectorPanel removes manual Align AR button, compass nudge controls, and on-screen 6-DoF button', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );

    const organizedView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: {
          parcelId: 'GLAND-PARKING',
          displayName: 'PARKING LOT 🚗 Land',
          centerLat: 39.7283,
          centerLng: -121.8369,
          stewardUsername: 'bigdog',
          isInside: true,
          isOwned: true,
          dimensionsLabel: '14×14×9.8 ft · 206 ft²',
          sculptures: [{ id: 'sc-1', title: 'PARKING LOT 🚗', voxelCount: 2406, creatorUsername: 'bigdog' }]
        },
        onDrawHere: () => {},
        onOpenLandChat: () => {},
        onOpen3DMap: () => {},
        onManageLand: () => {},
        onInspectSculpture: () => {},
        onClose: () => {}
      })
    );

    const infoZone = organizedView.getByTestId('ar-land-info-section');
    const actionsZone = organizedView.getByTestId('ar-land-actions-section');
    const primaryActions = organizedView.getByTestId('ar-land-primary-actions');
    const secondaryActions = organizedView.getByTestId('ar-land-secondary-actions');
    const sculpturesZone = organizedView.getByTestId('ar-land-sculptures-list');

    assert.ok(infoZone.textContent.includes('Owner') && infoZone.textContent.includes('Size'));
    assert.ok(actionsZone.textContent.includes('Actions'));
    assert.equal(primaryActions.querySelector('[data-testid="ar-land-draw-btn"]'), null);
    assert.ok(primaryActions.querySelector('[data-testid="ar-land-chat-btn"]'));
    assert.ok(secondaryActions.querySelector('[data-testid="ar-land-3d-map-btn"]'));
    assert.ok(secondaryActions.querySelector('[data-testid="ar-land-manage-btn"]'));
    assert.ok(sculpturesZone.textContent.includes('Art on This Land (1)'));

    // Align AR button, manual compass nudge controls, and on-screen 6-DoF button must be removed
    assert.equal(organizedView.queryByTestId('ar-compass-align-toggle-btn'), null);
    assert.equal(organizedView.queryByTestId('ar-compass-nudge-controls'), null);
    assert.equal(organizedView.queryByTestId('ar-inspector-webxr-btn'), null);
    organizedView.unmount();
  });
});
