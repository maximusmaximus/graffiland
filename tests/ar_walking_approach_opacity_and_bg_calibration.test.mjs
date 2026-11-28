import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import {
  APPROACH_FULL_OPACITY_METERS,
  WALKING_HOLD_MS,
  computeApproachedLandOpacityProfile,
  computeLiveLandEdgeDistanceMeters,
  createWalkingApproachTracker,
  stepWalkingApproachTracker
} from '../client/src/utils/arWalkingApproach.js';
import {
  applyProximitySharpnessToObject3D,
  computeProximitySharpness
} from '../client/src/utils/arLandGuidance.js';
import {
  CALIBRATION_RELOCK_GRACE_MS,
  createCalibrationHealthState,
  stepCalibrationHealthMonitor
} from '../client/src/utils/arCalibrationManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function offsetLatNorth(lat, metersNorth) {
  return lat + metersNorth / 111320;
}

describe('AR Walking Approach 100% Opacity & Silent Background Calibration Across All Camera Modes', () => {
  test('1. computeLiveLandEdgeDistanceMeters tracks exact 3D XZ perimeter distance as camera walks closer', () => {
    const cornersLocal = [
      { x: -5, y: -1.15, z: -25 },
      { x: 5, y: -1.15, z: -25 },
      { x: 5, y: -1.15, z: -15 },
      { x: -5, y: -1.15, z: -15 }
    ];
    const nearbyGroupPos = { x: 0, y: 0, z: 0 };

    const dStart = computeLiveLandEdgeDistanceMeters({
      cameraPos: { x: 0, y: 0.4, z: 0 },
      nearbyGroupPos,
      cornersLocal
    });
    assert.equal(dStart, 15, 'Should measure exact 15m to south boundary edge (z = -15)');

    const dCloser = computeLiveLandEdgeDistanceMeters({
      cameraPos: { x: 0, y: 0.4, z: -10 },
      nearbyGroupPos,
      cornersLocal
    });
    assert.equal(dCloser, 5, 'Walking 10m north should drop live edge distance to 5m');

    const dInside = computeLiveLandEdgeDistanceMeters({
      cameraPos: { x: 0, y: 0.4, z: -20 },
      nearbyGroupPos,
      cornersLocal
    });
    assert.equal(dInside, 0, 'Standing inside land footprint must report 0m distance');
  });

  test('2. stepWalkingApproachTracker detects walking from speed, GPS displacement, or 6-DoF camera motion and tracks approached lands', () => {
    const tracker = createWalkingApproachTracker();
    const baseLat = 37.7749;
    const baseLng = -122.4194;

    // Frame 0: standing still 40m away from Land A, 35m away from Land B
    const s0 = stepWalkingApproachTracker(tracker, {
      nowMs: 1000,
      location: { lat: baseLat, lng: baseLng },
      speedMps: 0,
      cameraPos: { x: 0, y: 0.4, z: 0 },
      lands: [
        { parcelId: 'GLAND-A', distanceMeters: 40, insideParcel: false },
        { parcelId: 'GLAND-B', distanceMeters: 35, insideParcel: false }
      ]
    });
    assert.equal(s0.isWalking, false);
    assert.equal(s0.primaryApproachingParcelId, '');

    // Frame 1: user walks north 3m (coords.speed is null/0, detected via GPS displacement!)
    // Land A gets closer (40m -> 37m); Land B gets farther (35m -> 38m)
    const s1 = stepWalkingApproachTracker(tracker, {
      nowMs: 3000,
      location: { lat: offsetLatNorth(baseLat, 3), lng: baseLng },
      speedMps: 0,
      cameraPos: { x: 0, y: 0.4, z: -3 },
      lands: [
        { parcelId: 'GLAND-A', distanceMeters: 37, insideParcel: false },
        { parcelId: 'GLAND-B', distanceMeters: 38, insideParcel: false }
      ]
    });
    assert.equal(s1.isWalking, true, 'Walking displacement must be detected even without GPS speed');
    assert.equal(s1.byParcelId.get('GLAND-A')?.isApproaching, true, 'Land A is being approached');
    assert.equal(s1.byParcelId.get('GLAND-B')?.isApproaching, false, 'Land B is receding');
    assert.equal(s1.primaryApproachingParcelId, 'GLAND-A');

    // Frame 2: user walks up to 8m from Land A
    const s2 = stepWalkingApproachTracker(tracker, {
      nowMs: 5000,
      location: { lat: offsetLatNorth(baseLat, 32), lng: baseLng },
      speedMps: 1.3,
      cameraPos: { x: 0, y: 0.4, z: -32 },
      lands: [
        { parcelId: 'GLAND-A', distanceMeters: 8, insideParcel: false },
        { parcelId: 'GLAND-B', distanceMeters: 67, insideParcel: false }
      ]
    });
    assert.equal(s2.isWalking, true);
    assert.equal(s2.primaryApproachingParcelId, 'GLAND-A');
    assert.ok((s2.byParcelId.get('GLAND-A')?.closingMeters || 0) >= 30);

    // Frame 3: user stops walking and waits longer than WALKING_HOLD_MS -> cleanly returns to stationary
    const s3 = stepWalkingApproachTracker(tracker, {
      nowMs: 5000 + WALKING_HOLD_MS + 500,
      location: { lat: offsetLatNorth(baseLat, 32), lng: baseLng },
      speedMps: 0,
      cameraPos: { x: 0, y: 0.4, z: -32 },
      lands: [{ parcelId: 'GLAND-A', distanceMeters: 8, insideParcel: false }]
    });
    assert.equal(s3.isWalking, false);
  });

  test('3. Approaching a land while walking ramps BOTH land wireframe & sculptures to 100% opacity in ANY mode (even draw-tool auto-fade)', () => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      emissive: 0x00f5d4,
      emissiveIntensity: 0.6,
      roughness: 0.25
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat);
    const scGroup = new THREE.Group();
    scGroup.add(mesh);

    // A) Stationary in draw mode (baseFadeMultiplier = 0.22) at 10m -> stays respectfully faded at 22%
    const stationaryDraw = computeApproachedLandOpacityProfile({
      distanceMeters: 10,
      baseSharpness: computeProximitySharpness(10),
      baseFadeMultiplier: 0.22,
      baseWireOpacity: 0.65,
      isWalking: false,
      isApproaching: false
    });
    assert.equal(stationaryDraw.isApproachedWhileWalking, false);
    assert.equal(stationaryDraw.fadeMultiplier, 0.22);
    assert.ok(stationaryDraw.sculptureOpacity < 0.25);

    // B) Walking toward the land from 45m -> opacity visibly lifts above distant faded baseline
    const walkingMid = computeApproachedLandOpacityProfile({
      distanceMeters: 45,
      baseSharpness: computeProximitySharpness(45),
      baseFadeMultiplier: 0.22,
      baseWireOpacity: 0.65,
      isWalking: true,
      isApproaching: true,
      closingMeters: 6
    });
    assert.equal(walkingMid.isApproachedWhileWalking, true);
    assert.ok(walkingMid.approachProgress > 0.5);
    assert.ok(walkingMid.sculptureOpacity > 0.55);
    assert.ok(walkingMid.prismWireOpacity > 0.75);

    // C) Walking up to within APPROACH_FULL_OPACITY_METERS (10m <= 12m) in DRAW mode -> FULL 100% OPACITY!
    const walkingCloseDraw = computeApproachedLandOpacityProfile({
      distanceMeters: APPROACH_FULL_OPACITY_METERS - 2,
      baseSharpness: computeProximitySharpness(APPROACH_FULL_OPACITY_METERS - 2),
      baseFadeMultiplier: 0.22,
      baseWireOpacity: 0.65,
      isWalking: true,
      isApproaching: true,
      closingMeters: 15
    });
    assert.equal(walkingCloseDraw.approachProgress, 1);
    assert.equal(walkingCloseDraw.fadeMultiplier, 1);
    assert.equal(walkingCloseDraw.sculptureOpacity, 1, 'Approached land sculptures must hit 100% opacity');
    assert.equal(walkingCloseDraw.prismWireOpacity, 1, 'Approached land wireframe must hit 100% opacity');
    assert.equal(walkingCloseDraw.sharpnessProfile.atmosphericHaze, 0, 'Haze clears to 0 at 100% approach');

    // Apply directly to Three.js sculpture mesh and verify exact 100% solid material state
    applyProximitySharpnessToObject3D(scGroup, walkingCloseDraw.sharpnessProfile, 16, {
      fadeMultiplier: walkingCloseDraw.fadeMultiplier
    });
    assert.equal(mat.opacity, 1);
    assert.equal(mat.depthWrite, true);
    assert.equal(mat.color.getHex(), 0x00f5d4);

    // D) While actively spraying a stroke (isPainting = true), draw ghost fade stays respected
    const activePainting = computeApproachedLandOpacityProfile({
      distanceMeters: 4,
      baseSharpness: computeProximitySharpness(4),
      baseFadeMultiplier: 0.22,
      isWalking: true,
      isApproaching: true,
      closingMeters: 5,
      isPainting: true
    });
    assert.equal(activePainting.isApproachedWhileWalking, false);
    assert.equal(activePainting.fadeMultiplier, 0.22);

    // E) Strictly beyond 300 ft (92m) -> stays 0 opacity (respects < 300 ft cutoff)
    const beyond300ft = computeApproachedLandOpacityProfile({
      distanceMeters: 92,
      baseSharpness: computeProximitySharpness(92),
      isWalking: true,
      isApproaching: true,
      closingMeters: 10
    });
    assert.equal(beyond300ft.sculptureOpacity, 0);
    assert.equal(beyond300ft.prismWireOpacity, 0);
  });

  test('4. Background walk calibration re-anchors silently without interrupting with a blocking Location Changed modal', () => {
    const anchor = { lat: 37.7749, lng: -122.4194, accuracy: 6 };
    const st = createCalibrationHealthState();

    // Confirmed 25m walk while backgroundWalkCalibration is TRUE -> seamless backgroundWalkRefresh!
    stepCalibrationHealthMonitor(st, {
      nowMs: 1000,
      anchorLocation: anchor,
      currentLocation: { lat: offsetLatNorth(anchor.lat, 25), lng: anchor.lng, accuracy: 6 },
      currentLocationTs: 1000,
      lastOrientationEventTs: 950,
      hasSessionOrbKeyframes: true,
      backgroundWalkCalibration: true
    });
    const walkRes = stepCalibrationHealthMonitor(st, {
      nowMs: 2500,
      anchorLocation: anchor,
      currentLocation: { lat: offsetLatNorth(anchor.lat, 26), lng: anchor.lng, accuracy: 6 },
      currentLocationTs: 2500,
      lastOrientationEventTs: 2450,
      hasSessionOrbKeyframes: true,
      backgroundWalkCalibration: true
    });
    assert.equal(walkRes.status, 'calibrated', 'Must stay calibrated with zero blocking modal while walking toward a land');
    assert.equal(walkRes.backgroundWalkRefresh, true, 'Must signal silent background ORB & anchor refresh');
    assert.equal(walkRes.loss, null);

    // Meanwhile, when backgroundWalkCalibration is FALSE (e.g. stationary draw draft), existing relocation loss still fires
    const stStrict = createCalibrationHealthState();
    stepCalibrationHealthMonitor(stStrict, {
      nowMs: 10000,
      anchorLocation: anchor,
      currentLocation: { lat: offsetLatNorth(anchor.lat, 25), lng: anchor.lng, accuracy: 6 },
      currentLocationTs: 10000,
      lastOrientationEventTs: 9950,
      hasSessionOrbKeyframes: true,
      backgroundWalkCalibration: false
    });
    const relocStart = stepCalibrationHealthMonitor(stStrict, {
      nowMs: 11000,
      anchorLocation: anchor,
      currentLocation: { lat: offsetLatNorth(anchor.lat, 26), lng: anchor.lng, accuracy: 6 },
      currentLocationTs: 11000,
      lastOrientationEventTs: 10950,
      hasSessionOrbKeyframes: true,
      backgroundWalkCalibration: false
    });
    assert.equal(relocStart.status, 'relocalizing');
    const relocLost = stepCalibrationHealthMonitor(stStrict, {
      nowMs: 11000 + CALIBRATION_RELOCK_GRACE_MS + 100,
      anchorLocation: anchor,
      currentLocation: { lat: offsetLatNorth(anchor.lat, 26), lng: anchor.lng, accuracy: 6 },
      currentLocationTs: 11000,
      lastOrientationEventTs: 11000 + CALIBRATION_RELOCK_GRACE_MS + 50,
      hasSessionOrbKeyframes: true,
      backgroundWalkCalibration: false
    });
    assert.equal(relocLost.status, 'lost');
    assert.equal(relocLost.loss?.code, 'relocated');
  });

  test('5. All camera-open modes wire silent background calibration, ORB relocalization & walking-approach opacity', () => {
    const mobileSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    const viewportSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    const polSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useProofOfLocation.js'),
      'utf8'
    );
    const previewSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useARPreview.js'),
      'utf8'
    );

    assert.match(mobileSrc, /backgroundCalibrationActiveRef\.current\s*=\s*Boolean\(/);
    assert.match(mobileSrc, /walkingApproachRef=\{walkingApproachRef\}/);
    assert.match(viewportSrc, /isUiMappingActive\s*\|\|\s*allowBackgroundCalibration/);
    assert.match(viewportSrc, /computeApproachedLandOpacityProfile\(/);
    assert.match(viewportSrc, /stepWalkingApproachTracker\(/);
    assert.match(polSrc, /backgroundWalkCalibration:\s*allowSilentWalkRefresh/);
    assert.match(polSrc, /healthResult\.backgroundWalkRefresh/);
    assert.match(previewSrc, /isCameraOpenMode\s*&&\s*hasVisibleNearbyLand/);
    assert.match(previewSrc, /primaryApproachingParcelId/);
  });
});
