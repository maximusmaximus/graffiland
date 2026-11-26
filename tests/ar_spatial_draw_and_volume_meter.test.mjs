import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { VOXEL_STEP } from '../shared/constants.mjs';
import {
  areVoxelsFaceConnected,
  buildSmoothSplineVoxelPath
} from '../shared/voxelStroke.mjs';
import {
  ArSpatialDrawTracker,
  estimateGyroCompensatedVisualTranslation
} from '../client/src/utils/arSpatialDrawTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Generates a richly textured 2D grayscale test pattern with multi-frequency detail
 * and samples it at sub-pixel (x, y) coordinates using bilinear interpolation.
 */
function sampleRichPattern(x, y) {
  const v =
    128 +
    46 * Math.sin(x * 0.43 + y * 0.19) +
    38 * Math.cos(y * 0.51 - x * 0.17) +
    28 * Math.sin((x - y) * 0.77) +
    18 * Math.cos((x + y) * 0.93);
  return Math.max(0, Math.min(255, Math.round(v)));
}

function renderSyntheticFrame(width, height, { shiftX = 0, shiftY = 0, zoom = 1 } = {}) {
  const buf = new Uint8Array(width * height);
  const cx = width * 0.5;
  const cy = height * 0.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Feature at (srcX, srcY) moves to (x, y) where x = cx + (srcX - cx)*zoom + shiftX
      const srcX = cx + (x - cx - shiftX) / zoom;
      const srcY = cy + (y - cy - shiftY) / zoom;
      buf[y * width + x] = sampleRichPattern(srcX, srcY);
    }
  }
  return buf;
}

describe('6-DoF World-Anchored Space Drawing Tracker (ArSpatialDrawTracker)', () => {
  test('gyro-compensated visual odometry translates camera RIGHT when scene shifts LEFT and stays locked on pure rotation', () => {
    const W = 64;
    const H = 48;
    const vFovDeg = 60;
    const aspect = W / H;
    const depthMeters = 2.0;

    // 1. Pure lateral translation RIGHT -> features shift LEFT by -3 px
    const frameA = renderSyntheticFrame(W, H, { shiftX: 0, shiftY: 0 });
    const frameRight = renderSyntheticFrame(W, H, { shiftX: -3, shiftY: 0 });
    const qIdentity = new THREE.Quaternion();

    const estMove = estimateGyroCompensatedVisualTranslation(frameA, frameRight, W, H, {
      prevQuat: qIdentity,
      curQuat: qIdentity,
      vFovDeg,
      aspect,
      depthMeters
    });
    assert.equal(estMove.valid, true);
    assert.ok(estMove.trackedPatches >= 8, `Expected >=8 tracked patches, got ${estMove.trackedPatches}`);
    assert.ok(estMove.tx > 0.08, `Expected positive rightward camera translation, got tx=${estMove.tx}`);
    assert.ok(Math.abs(estMove.ty) < 0.02, `Expected ~0 vertical drift, got ty=${estMove.ty}`);

    // 2. Pure phone yaw LEFT (+dYaw) shifts background features RIGHT by +rotDx = +dYaw * fx
    //    Gyro compensation must subtract this rotational flow -> ZERO bogus translation!
    const halfTanV = Math.tan(((vFovDeg * Math.PI) / 180) * 0.5);
    const fx = (W * 0.5) / (halfTanV * aspect);
    const dYawRad = 3.0 / fx; // exact yaw causing +3px rightward rotational pixel shift
    const qYawed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dYawRad);
    const framePureRot = renderSyntheticFrame(W, H, { shiftX: 3.0, shiftY: 0 });

    const estRotOnly = estimateGyroCompensatedVisualTranslation(frameA, framePureRot, W, H, {
      prevQuat: qIdentity,
      curQuat: qYawed,
      vFovDeg,
      aspect,
      depthMeters
    });
    assert.equal(estRotOnly.valid, true);
    assert.ok(
      Math.abs(estRotOnly.tx) < 0.015,
      `Pure phone rotation must NOT falsely translate camera, got tx=${estRotOnly.tx}`
    );

    // 3. Moving phone FORWARD toward scene expands features radially outward (zoom > 1) -> tz < 0
    const frameForward = renderSyntheticFrame(W, H, { zoom: 1.06 });
    const estFwd = estimateGyroCompensatedVisualTranslation(frameA, frameForward, W, H, {
      prevQuat: qIdentity,
      curQuat: qIdentity,
      vFovDeg,
      aspect,
      depthMeters
    });
    assert.equal(estFwd.valid, true);
    assert.ok(estFwd.tz < -0.04, `Expected negative Z forward camera motion, got tz=${estFwd.tz}`);
  });

  test('ArSpatialDrawTracker integrates VIO, ZUPT IMU motion, and Kalman walking without moving anchored artwork', () => {
    const tracker = new ArSpatialDrawTracker({ sampleWidth: 64, sampleHeight: 48 });
    const baseCam = { x: 0, y: 0.4, z: 2.2 };
    const qIdentity = new THREE.Quaternion();

    // Feed visual translation frames (phone moving steadily rightward through space)
    const f0 = renderSyntheticFrame(64, 48, { shiftX: 0 });
    const f1 = renderSyntheticFrame(64, 48, { shiftX: -2.5 });
    const f2 = renderSyntheticFrame(64, 48, { shiftX: -5.0 });
    tracker.ingestGrayscaleFrame(f0, { cameraQuat: qIdentity, vFovDeg: 60, aspect: 64 / 48, depthMeters: 2.0, nowMs: 1000 });
    tracker.ingestGrayscaleFrame(f1, { cameraQuat: qIdentity, vFovDeg: 60, aspect: 64 / 48, depthMeters: 2.0, nowMs: 1033 });
    tracker.ingestGrayscaleFrame(f2, { cameraQuat: qIdentity, vFovDeg: 60, aspect: 64 / 48, depthMeters: 2.0, nowMs: 1066 });

    const camAfterSweep = tracker.getWorldCameraPosition(baseCam, new THREE.Vector3());
    assert.ok(
      camAfterSweep.x > baseCam.x + 0.15,
      `Expected camera X to advance right through space, got ${camAfterSweep.x}`
    );

    // Feed IMU impulse followed by stillness -> ZUPT kills velocity cleanly with zero runaway drift
    let t = 2000;
    for (let i = 0; i < 6; i += 1) {
      t += 16;
      tracker.updateFromDeviceMotion({
        acceleration: { x: 2.4, y: 0, z: 0 },
        cameraQuat: qIdentity,
        screenOrientDeg: 0,
        nowMs: t
      });
    }
    const camAfterAccel = tracker.getWorldCameraPosition(baseCam, new THREE.Vector3()).x;
    assert.ok(camAfterAccel > camAfterSweep.x);

    for (let i = 0; i < 25; i += 1) {
      t += 16;
      tracker.updateFromDeviceMotion({
        acceleration: { x: 0.02, y: -0.01, z: 0.01 },
        cameraQuat: qIdentity,
        screenOrientDeg: 0,
        nowMs: t
      });
    }
    assert.equal(tracker.imuVel.x, 0, 'ZUPT must zero IMU velocity once stationary');

    // Feed macro Kalman walking (+8m East, +3m North) -> camera walks smoothly through space
    tracker.updateFromKalmanWalk({ east: 0, north: 0, speedMps: 0, dtSec: 0.016 });
    for (let i = 0; i < 40; i += 1) {
      tracker.updateFromKalmanWalk({ east: 8.0, north: 3.0, speedMps: 1.3, dtSec: 0.05 });
    }
    const camAfterWalk = tracker.getWorldCameraPosition(baseCam, new THREE.Vector3());
    assert.ok(camAfterWalk.x > 6.5, `Expected camera to walk East near +8m, got x=${camAfterWalk.x}`);
    assert.ok(camAfterWalk.z < baseCam.z - 2.0, `Expected camera to walk North (-Z), got z=${camAfterWalk.z}`);

    // Nearby group stays world-locked with submeter Kalman delta (no drift vs draft art!)
    const nearbyPos = tracker.getNearbyGroupPosition(baseCam, { east: 1.2, north: 0.5 });
    assert.ok(Math.abs(nearbyPos.x - (baseCam.x + tracker.walkOffset.x - 1.2)) < 1e-6);
    assert.ok(Math.abs(nearbyPos.z - (baseCam.z + tracker.walkOffset.z + 0.5)) < 1e-6);

    // Resetting origin re-anchors cleanly for a new piece
    tracker.resetOrigin({ currentEnu: { east: 8.0, north: 3.0 } });
    const resetCam = tracker.getWorldCameraPosition(baseCam, new THREE.Vector3());
    assert.equal(resetCam.x, baseCam.x);
    assert.equal(resetCam.y, baseCam.y);
    assert.equal(resetCam.z, baseCam.z);
  });
});

describe('Sophisticated Extended 3D Curved Brush Strokes (buildSmoothSplineVoxelPath)', () => {
  test('produces extended >100-voxel curved 3D ribbons with strict 6-connected face adjacency', () => {
    const start = { x: 0, y: 0, z: 0 };
    const control = { x: 2.6, y: 1.6, z: -1.4 };
    const end = { x: 5.2, y: 0.2, z: -2.8 };

    const res = buildSmoothSplineVoxelPath(start, end, {
      controlPoint: control,
      step: VOXEL_STEP,
      blockScale: 1,
      maxSteps: 256
    });

    // Must extend far beyond the old 96-step single-frame cap
    assert.ok(
      res.path.length > 120,
      `Expected long extended curved ribbon (>120 blocks), got ${res.path.length}`
    );

    // Must bend upward through the spline arch (not just a flat straight line between y=0 and y=0.2)
    const maxY = Math.max(...res.path.map((v) => v.y));
    assert.ok(maxY >= 0.75, `Expected smooth upward arc along control point, got maxY=${maxY}`);

    // Every consecutive voxel in the ribbon must be strictly 6-connected face-adjacent
    let prev = start;
    for (let i = 0; i < res.path.length; i += 1) {
      const v = res.path[i];
      assert.equal(
        areVoxelsFaceConnected(prev, v, { step: VOXEL_STEP, blockScale: 1 }),
        true,
        `Spline ribbon broke face-connectivity at step ${i}: ${JSON.stringify(prev)} -> ${JSON.stringify(v)}`
      );
      prev = v;
    }
  });
});

describe('Side Volumetric Remaining-Pixels Bar (DrawVolumeMeter React + jsdom)', () => {
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
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.vol-meter-ui-test-cache-'));
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

  test('appears when holding draw tool, displays live remaining pixels & fill height, warns when low/empty, and hides on release', async () => {
    const { default: DrawVolumeMeter, computeDrawVolumeMeterState } = await loadJsxModule(
      'client/src/components/studio/DrawVolumeMeter.jsx'
    );

    // Pure math checks across all capacity states
    assert.deepEqual(
      {
        remaining: computeDrawVolumeMeterState({ usedVoxels: 0, maxVoxels: 4096 }).remaining,
        state: computeDrawVolumeMeterState({ usedVoxels: 0, maxVoxels: 4096 }).state
      },
      { remaining: 4096, state: 'normal' }
    );
    assert.equal(computeDrawVolumeMeterState({ usedVoxels: 3000, maxVoxels: 4096 }).state, 'low');
    assert.equal(computeDrawVolumeMeterState({ usedVoxels: 3700, maxVoxels: 4096 }).state, 'critical');
    assert.equal(computeDrawVolumeMeterState({ usedVoxels: 4096, maxVoxels: 4096 }).state, 'empty');

    // 1. Hidden initially when user is not holding a draw tool
    const view = RTL.render(
      React.createElement(DrawVolumeMeter, {
        active: false,
        painting: false,
        usedVoxels: 200,
        maxVoxels: 4096,
        brushColor: '#00f5d4',
        lingerMs: 0
      })
    );
    assert.equal(view.getByTestId('draw-volume-meter').getAttribute('data-visible'), 'false');

    // 2. Holding tool down immediately reveals the volumetric side bar with exact remaining pixels
    view.rerender(
      React.createElement(DrawVolumeMeter, {
        active: true,
        painting: true,
        usedVoxels: 200,
        maxVoxels: 4096,
        brushColor: '#00f5d4',
        lingerMs: 0
      })
    );
    const meter = view.getByTestId('draw-volume-meter');
    assert.equal(meter.getAttribute('data-visible'), 'true');
    assert.equal(meter.getAttribute('data-state'), 'normal');
    assert.equal(meter.getAttribute('aria-valuenow'), '3896');
    assert.equal(meter.getAttribute('aria-valuemax'), '4096');
    assert.equal(view.getByTestId('draw-volume-remaining').textContent, '3,896');
    assert.equal(view.getByTestId('draw-volume-percent').textContent, '95%');
    assert.ok(view.getByTestId('draw-volume-fill').style.height.startsWith('95.'));

    // 3. Low remaining pixels transitions to warning state (amber)
    view.rerender(
      React.createElement(DrawVolumeMeter, {
        active: true,
        painting: true,
        usedVoxels: 3200,
        maxVoxels: 4096,
        brushColor: '#00f5d4',
        lingerMs: 0
      })
    );
    assert.equal(view.getByTestId('draw-volume-meter').getAttribute('data-state'), 'low');
    assert.equal(view.getByTestId('draw-volume-remaining').textContent, '896');

    // 4. Exhausting the per-piece pixel limit hits empty state (0% / LIMIT)
    view.rerender(
      React.createElement(DrawVolumeMeter, {
        active: true,
        painting: true,
        usedVoxels: 4096,
        maxVoxels: 4096,
        brushColor: '#00f5d4',
        lingerMs: 0
      })
    );
    assert.equal(view.getByTestId('draw-volume-meter').getAttribute('data-state'), 'empty');
    assert.equal(view.getByTestId('draw-volume-remaining').textContent, '0');
    assert.equal(view.getByTestId('draw-volume-percent').textContent, '0%');
    assert.equal(view.getByTestId('draw-volume-fill').style.height, '0%');

    // 5. Releasing tool hides the meter cleanly
    view.rerender(
      React.createElement(DrawVolumeMeter, {
        active: false,
        painting: false,
        usedVoxels: 4096,
        maxVoxels: 4096,
        brushColor: '#00f5d4',
        lingerMs: 0
      })
    );
    assert.equal(view.getByTestId('draw-volume-meter').getAttribute('data-visible'), 'false');
    cleanup();
  });

  test('MobileStudio, ARViewportCanvas, and StudioDockDrawer wire spatial 6-DoF draw tracking, extended reach, and DrawVolumeMeter', () => {
    const mobileSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    const canvasSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    const dockSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/StudioDockDrawer.jsx'),
      'utf8'
    );

    assert.match(mobileSrc, /<DrawVolumeMeter/);
    assert.match(mobileSrc, /spatialDrawTrackerRef=\{pol\.spatialDrawTrackerRef\}/);
    assert.match(canvasSrc, /buildSmoothSplineVoxelPath/);
    assert.match(canvasSrc, /getWorldCameraPosition/);
    assert.match(canvasSrc, /getNearbyGroupPosition/);
    assert.match(dockSrc, /REACH_PRESETS\s*=\s*\[0\.8,\s*1\.2,\s*1\.8,\s*2\.4,\s*3\.0\]/);
  });
});
