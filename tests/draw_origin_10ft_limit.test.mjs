import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import {
  MAX_DRAW_DISTANCE_FROM_ORIGIN_FEET,
  MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS,
  POLICY,
  VOXEL_STEP
} from '../shared/constants.mjs';
import {
  buildConnectedVoxelPath,
  clampPointToDrawOriginRadius,
  distanceFromDrawOrigin,
  filterStrokeByOriginRadius,
  isWithinDrawOriginRadius,
  resolveDrawOriginPoint
} from '../shared/voxelStroke.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('10-Foot Single-Line Draw Distance Limit from Set Origin or Device Origin', () => {
  test('constants and policy expose exact 10 ft (3.048 m) origin draw limit', () => {
    assert.equal(MAX_DRAW_DISTANCE_FROM_ORIGIN_FEET, 10);
    assert.equal(MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS, 3.048);
    assert.equal(POLICY.maxDrawDistanceFromOriginFeet, 10);
    assert.equal(POLICY.maxDrawDistanceFromOriginMeters, 3.048);
  });

  test('resolveDrawOriginPoint prioritizes set surfaceAnchor, then strokeDeviceOrigin, then live camera', () => {
    const anchor = { x: 1, y: 0, z: -2, nx: 0, ny: 1, nz: 0, locked: true };
    const strokeOrigin = { x: 0, y: 0.4, z: 2.2 };
    const camPos = { x: 4, y: 0.4, z: 2.2 };

    assert.deepEqual(
      resolveDrawOriginPoint({ surfaceAnchor: anchor, strokeDeviceOrigin: strokeOrigin, cameraPosition: camPos }),
      { x: 1, y: 0, z: -2, source: 'surface_anchor' }
    );
    assert.deepEqual(
      resolveDrawOriginPoint({ surfaceAnchor: null, strokeDeviceOrigin: strokeOrigin, cameraPosition: camPos }),
      { x: 0, y: 0.4, z: 2.2, source: 'device_origin' }
    );
    assert.deepEqual(
      resolveDrawOriginPoint({ surfaceAnchor: null, strokeDeviceOrigin: null, cameraPosition: camPos }),
      { x: 4, y: 0.4, z: 2.2, source: 'device_origin' }
    );
  });

  test('clampPointToDrawOriginRadius preserves locked surface plane and never exceeds 10 ft (3.048 m)', () => {
    const floorOrigin = { x: 0, y: -0.5, z: 0 };
    // Point 18 meters out on the same horizontal floor plane (y = -0.5)
    const farFloorPt = { x: 18, y: -0.5, z: 0 };
    const clamped = clampPointToDrawOriginRadius(farFloorPt, floorOrigin);
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.y, -0.5, 'Clamped point must remain strictly on the locked surface plane');
    assert.ok(Math.abs(clamped.x - 3.048) < 1e-4, `Expected x=3.048, got ${clamped.x}`);
    assert.equal(isWithinDrawOriginRadius(clamped, floorOrigin), true);

    const nearPt = { x: 1.5, y: -0.5, z: 1.0 };
    assert.equal(clampPointToDrawOriginRadius(nearPt, floorOrigin).clamped, false);
    assert.equal(isWithinDrawOriginRadius(nearPt, floorOrigin), true);
  });

  test('filterStrokeByOriginRadius clips a single connected line cleanly at <= 10 ft (3.048 m)', () => {
    const origin = { x: 0, y: 0, z: 0 };
    // Single 10-meter (32.8 ft) line along +X
    const longStroke = buildConnectedVoxelPath(
      { x: 0, y: 0, z: 0 },
      { x: 10.0, y: 0, z: 0 },
      { step: VOXEL_STEP, blockScale: 1, maxSteps: 256 }
    );
    assert.ok(longStroke.path.length >= 180);

    const clipped = filterStrokeByOriginRadius({
      pathPoints: longStroke.path,
      originPoint: origin,
      maxRadiusMeters: MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS
    });
    assert.equal(clipped.limitReached, true, 'Long line must stop at 10 ft limit');
    assert.ok(clipped.allowed.length > 0, 'Voxels inside 10 ft must still be placed');
    for (const v of clipped.allowed) {
      const dist = distanceFromDrawOrigin(v, origin);
      assert.ok(
        dist <= MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS + 1e-4,
        `Every allowed voxel must stay <= 3.048m (10 ft), found ${dist.toFixed(3)}m`
      );
    }
    const maxDist = distanceFromDrawOrigin(clipped.lastAllowedPoint, origin);
    assert.ok(
      maxDist >= 2.95 && maxDist <= MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS + 1e-4,
      `Line should reach cleanly right up to ~3.0m / 10 ft (got ${maxDist.toFixed(3)}m)`
    );
  });
});

describe('useVoxelBrush 10-Foot Origin Enforcement (React + jsdom)', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.tmp-draw10ft-'));
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

  test('does NOT restrict users to 10 ft from origin so painting works freely anywhere', async () => {
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');

    const camera = new THREE.PerspectiveCamera(68, 390 / 844, 0.05, 120);
    camera.position.set(0, 1.0, 2.0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const draftGroup = new THREE.Group();
    const hints = [];
    let hookApi = null;

    function Harness({ initialDraft }) {
      const api = useVoxelBrush({
        config: { policy: POLICY },
        initialDraft,
        user: { id: 'u-1', username: 'artist' },
        location: { lat: 39.73, lng: -121.84 },
        locationRef: { current: { lat: 39.73, lng: -121.84 } },
        cameraReady: true,
        sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
        polRef: {
          current: {
            getSceneCoverage: () => ({ optimal: true, scannedCount: 9, targetCount: 9 }),
            analyzeSurfacePatch: () => ({ sharpnessScore: 0.5 })
          }
        },
        rawOrientationRef: { current: null },
        fallbackEulerRef: { current: { yaw: 0, pitch: 0 } },
        enterFullscreen: () => {},
        setSensorBanner: () => {},
        showTemporaryHint: (m) => hints.push(m),
        canvasHostRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) } },
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
        openCameraSelectedChat: () => {},
        openAgentHandoffRef: { current: () => {} },
        openPublishSheetRef: { current: () => {} }
      });
      hookApi = api;
      return React.createElement('div', null, String(api.voxels.length));
    }

    // 1) Restored draft with reachMeters=8.0 is NOT forced down to 3.048m (10 ft)
    const view = RTL.render(
      React.createElement(Harness, {
        initialDraft: { reachMeters: 8.0, voxels: [] }
      })
    );
    assert.equal(hookApi.reachMeters, 8.0);
    await RTL.act(async () => {
      hookApi.setReachMeters(9.5);
    });
    assert.equal(hookApi.reachMeters, 9.5);

    // 2) Aiming >10 ft (e.g. 6m / ~20 ft) from a set floor origin is allowed (never returns out_of_range)
    await RTL.act(async () => {
      hookApi.setSurfaceAnchor({
        x: 0,
        y: 0,
        z: 0,
        nx: 0,
        ny: 1,
        nz: 0,
        depthM: 2.0,
        label: 'Floor',
        locked: true
      });
    });

    camera.position.set(0, 1.0, 2.0);
    camera.lookAt(0, 0, -6.0);
    camera.updateMatrixWorld(true);

    const farTarget = hookApi.computeTargetVoxel(false);
    assert.equal(farTarget.action, 'add', 'Aiming >10 ft from surface origin must allow painting');
    assert.ok(
      distanceFromDrawOrigin(farTarget, { x: 0, y: 0, z: 0 }) > MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS,
      'Far target should remain beyond 10 ft without artificial origin clamping'
    );

    await RTL.act(async () => {
      hookApi.applyVoxelAction(farTarget);
    });
    assert.equal(hookApi.voxels.length, 1, 'Applying voxel >10 ft from origin must succeed');
    assert.equal(
      hints.some((h) => /10 ft/i.test(h)),
      false,
      'Must never show a 10 ft origin lockout hint'
    );

    // 3) Without surfaceAnchor, walking >10 ft mid-stroke still computes 'add' cleanly and auto-reconciles surface
    await RTL.act(async () => {
      hookApi.setSurfaceAnchor(null);
      hookApi.setVoxels([]);
      hookApi.stopBrushPainting();
    });
    camera.position.set(0, 0.4, 2.2);
    camera.lookAt(0, 0.4, 0.4);
    camera.updateMatrixWorld(true);
    await RTL.act(async () => {
      hookApi.setReachMeters(1.8);
    });
    await RTL.act(async () => {
      hookApi.startContinuousHoldTool('brush');
    });
    assert.equal(hookApi.voxels.length, 1);
    assert.ok(hookApi.surfaceAnchor, 'Start surface should auto-reconcile on first paint');

    // Walk 6m away mid-stroke -> still allowed (action === 'add', no out_of_range block)
    camera.position.set(6.0, 0.4, 2.2);
    camera.lookAt(6.0, 0.4, 0.4);
    camera.updateMatrixWorld(true);
    const walkedMidStroke = hookApi.computeTargetVoxel(true);
    assert.equal(walkedMidStroke.action, 'add');
    assert.ok(
      distanceFromDrawOrigin(walkedMidStroke, { x: 0, y: 0.4, z: 2.2 }) > MAX_DRAW_DISTANCE_FROM_ORIGIN_METERS
    );

    view.unmount();
  });
});
