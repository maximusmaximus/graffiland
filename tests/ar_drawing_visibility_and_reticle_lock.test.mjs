import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import {
  computeWebXrInitialYawAlignmentRad,
  mapWebXrPoseToTrueNorthWorld
} from '../client/src/utils/webxrArSession.js';

const ROOT = path.resolve(process.cwd());

describe('AR Drawing Visibility (WebXR Rig & DOM Overlay), Top Pill Removal & Reticle Hold-Lock Edge Cases', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-ar-draw-vis-'));
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

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  test('1. WebXR parent rig transform matches True-North world camera pose to sub-millimeter precision', () => {
    const baseCameraPos = { x: 0, y: 0.4, z: 2.2 };
    const cases = [
      { headingDeg: 0, anchor: { x: 0, y: 0, z: 0 }, xrPos: { x: 0.5, y: 0.1, z: -1.2 }, yaw: 0.2, pitch: -0.3 },
      { headingDeg: 47, anchor: { x: 1.3, y: -0.2, z: 0.8 }, xrPos: { x: 2.1, y: 0.35, z: -0.4 }, yaw: -0.7, pitch: 0.15 },
      { headingDeg: 135, anchor: { x: -0.6, y: 0.9, z: -1.5 }, xrPos: { x: -1.4, y: 1.1, z: -2.0 }, yaw: 1.4, pitch: -0.5 },
      { headingDeg: 250, anchor: { x: 0.25, y: -0.4, z: 0.7 }, xrPos: { x: -0.8, y: 0.0, z: 1.9 }, yaw: -2.1, pitch: 0.4 }
    ];

    for (const c of cases) {
      const initQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.35, 0, 'YXZ'));
      const anchorYawOffsetRad = computeWebXrInitialYawAlignmentRad(initQuat, c.headingDeg);
      const xrQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(c.pitch, c.yaw, 0.08, 'YXZ'));

      const mapped = mapWebXrPoseToTrueNorthWorld({
        xrPos: c.xrPos,
        xrQuat,
        anchorYawOffsetRad,
        anchorOriginXrPos: c.anchor,
        baseCameraPos
      });

      // Simulate Three.js WebXRManager: cameraXR.matrixWorld = xrRig.matrixWorld * rawXrCameraMatrix
      const xrRig = new THREE.Group();
      xrRig.position.copy(mapped.rigPosition);
      xrRig.quaternion.copy(mapped.rigQuaternion);
      xrRig.updateMatrixWorld(true);

      const rawXrCam = new THREE.Matrix4().compose(
        new THREE.Vector3(c.xrPos.x, c.xrPos.y, c.xrPos.z),
        xrQuat,
        new THREE.Vector3(1, 1, 1)
      );
      const composedWorld = new THREE.Matrix4().multiplyMatrices(xrRig.matrixWorld, rawXrCam);
      const renderedPos = new THREE.Vector3();
      const renderedQuat = new THREE.Quaternion();
      const renderedScale = new THREE.Vector3();
      composedWorld.decompose(renderedPos, renderedQuat, renderedScale);

      assert.ok(
        renderedPos.distanceTo(mapped.position) < 1e-6,
        `WebXR rendered position must match draw camera position exactly (heading=${c.headingDeg}°)`
      );
      assert.ok(
        Math.abs(renderedQuat.dot(mapped.quaternion)) > 1 - 1e-6,
        `WebXR rendered quaternion must match draw camera orientation exactly (heading=${c.headingDeg}°)`
      );
    }
  });

  test('2. WebXR DOM overlay transparency CSS & ARViewportCanvas rig wiring keep 3D drawing visible', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    const canvasSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    const mobileSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    const polSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useProofOfLocation.js'),
      'utf8'
    );

    // CSS makes root containers transparent and hides <video> + stale DOM <canvas> during WebXR
    assert.match(css, /html\.webxr-ar-active[\s\S]*background:\s*transparent\s*!important/);
    assert.match(css, /\.camera-feed\.is-webxr-hidden[\s\S]*opacity:\s*0\s*!important/);
    assert.match(css, /\.webgl-overlay\.is-webxr-active\s+canvas[\s\S]*opacity:\s*0\s*!important/);

    // ARViewportCanvas renders through xrRig + xrRenderCamera during WebXR and updates camera world matrix
    assert.match(canvasSrc, /xrRig\.add\(xrRenderCamera\)/);
    assert.match(canvasSrc, /renderer\.render\(scene,\s*xrRenderCamera\)/);
    assert.match(canvasSrc, /camera\.updateMatrixWorld\(true\)/);
    assert.match(canvasSrc, /webxr-ar-active/);
    assert.match(canvasSrc, /is-webxr-hidden/);
    assert.match(mobileSrc, /is-webxr-active/);
    assert.match(mobileSrc, /webxrActive=\{pol\.webxrActive\}/);

    // Camera watchdog does not fight WebXR ARCore for rear camera
    assert.match(
      polSrc,
      /if\s*\(\(?webxrActiveRef\.current(?:\s*\|\|\s*webxrStartingRef\.current\)?)?\s*&&\s*reason\s*!==\s*'webxr_ended'/
    );
  });

  test('3. StudioHudTopBar removes both top 6-DoF ARCore Lock pill and top pinned Surface pill', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u1', username: 'bigdog' },
        mode: 'draw',
        dockOpen: false,
        voxels: [{ x: 0, y: 0, z: -1.5, color: '#00f5d4' }],
        webxrActive: true,
        sensorStatus: {
          source: 'webxr',
          trueNorthLocked: true,
          headingAccuracyDeg: 5,
          gpsAccuracyM: 3,
          needsCompassCalibration: false,
          declinationDeg: 12
        },
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true, scannedCount: 7, targetCount: 7 },
        onOpenInfo: () => {},
        onOpenAreaMap: () => {}
      })
    );

    assert.equal(
      view.queryByTestId('ar-sensor-status-pill'),
      null,
      'Top 6-DoF ARCore Lock pill must not render'
    );
    assert.equal(
      view.container.textContent.includes('6-DoF ARCore Lock'),
      false,
      'Text "6-DoF ARCore Lock" must not appear in top HUD'
    );
    assert.equal(
      view.container.querySelector('.surface-pill'),
      null,
      'Top pinned Wall/Surface + Locked + Seed pill must be completely removed'
    );
    assert.equal(
      view.container.textContent.includes('+ Seed'),
      false,
      '"+ Seed" button must not appear in top HUD'
    );
    cleanup();
  });

  test('4. ToolCenterReticle handles all edge cases cleanly (auto unlocked surface, multi-touch, cancel/blur, calibration block, Pencil mode)', async () => {
    const { default: ToolCenterReticle, RETICLE_HOLD_LOCK_DRAW_MS } = await loadJsxModule(
      'client/src/components/studio/ToolCenterReticle.jsx'
    );

    let setCalls = 0;
    let unlockCalls = 0;
    let drawCalls = 0;
    let holdStarts = 0;
    let holdStops = 0;
    let allowLock = true;

    const makeProps = (overrides = {}) => ({
      tool: 'brush',
      blockSize: 1,
      color: '#00f5d4',
      reachMeters: 1.8,
      surfaceAnchor: null,
      painting: false,
      onSetCenterSurface: () => {
        setCalls += 1;
        return allowLock ? { x: 0, y: 0, z: -1.8, nx: 0, ny: 0, nz: 1, depthM: 1.8, locked: true } : null;
      },
      onUnlockCenterSurface: () => {
        unlockCalls += 1;
      },
      onDrawAtCenter: () => {
        drawCalls += 1;
      },
      onStartCenterBrushHold: () => {
        holdStarts += 1;
      },
      onStopCenterBrushHold: () => {
        holdStops += 1;
      },
      ...overrides
    });

    // Edge Case A: Auto-reconciled surface with locked=false must NOT look locked
    const view = RTL.render(
      React.createElement(
        ToolCenterReticle,
        makeProps({
          surfaceAnchor: { x: 0, y: 0, z: -1.8, nx: 0, ny: 0, nz: 1, depthM: 1.8, source: 'auto', locked: false }
        })
      )
    );
    const reticle = view.getByTestId('tool-center-reticle');
    assert.equal(reticle.getAttribute('data-surface-locked'), 'false');
    assert.equal(view.queryByTestId('tool-reticle-lock-dot'), null);

    // Edge Case B: Calibration not ready (onSetCenterSurface returns null) -> hold does NOT start spraying
    allowLock = false;
    RTL.fireEvent.pointerDown(reticle, { button: 0, pointerId: 1 });
    await new Promise((r) => setTimeout(r, RETICLE_HOLD_LOCK_DRAW_MS + 35));
    assert.equal(setCalls, 1);
    assert.equal(holdStarts, 0, 'Must not start spraying when lock fails (e.g. uncalibrated)');
    RTL.fireEvent.pointerUp(reticle, { button: 0, pointerId: 1 });
    assert.equal(holdStops, 0);

    // Edge Case C: Secondary multi-touch finger during active hold is ignored; pointerCancel stops spray cleanly
    allowLock = true;
    RTL.fireEvent.pointerDown(reticle, { button: 0, pointerId: 2 });
    RTL.fireEvent.pointerDown(reticle, { button: 0, pointerId: 99 }); // secondary finger ignored
    await new Promise((r) => setTimeout(r, RETICLE_HOLD_LOCK_DRAW_MS + 35));
    assert.equal(setCalls, 2);
    assert.equal(holdStarts, 1);
    RTL.fireEvent.pointerUp(reticle, { button: 0, pointerId: 99 }); // secondary finger release ignored
    assert.equal(holdStops, 0, 'Secondary pointer release must not stop primary hold spray');
    RTL.fireEvent.pointerCancel(reticle, { pointerId: 2 }); // OS interrupt stops primary hold cleanly
    assert.equal(holdStops, 1, 'pointerCancel on primary pointer must stop spraying');

    // Edge Case D: Window blur stops active spray cleanly
    RTL.fireEvent.pointerDown(reticle, { button: 0, pointerId: 3 });
    await new Promise((r) => setTimeout(r, RETICLE_HOLD_LOCK_DRAW_MS + 35));
    assert.equal(holdStarts, 2);
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(holdStops, 2, 'Window blur must stop active hold spray so brush never sticks');

    // Edge Case E: Tool switch mid-hold cleans up active spray
    RTL.fireEvent.pointerDown(reticle, { button: 0, pointerId: 4 });
    await new Promise((r) => setTimeout(r, RETICLE_HOLD_LOCK_DRAW_MS + 35));
    assert.equal(holdStarts, 3);
    view.rerender(React.createElement(ToolCenterReticle, makeProps({ tool: 'pencil' })));
    assert.equal(holdStops, 3, 'Switching tools mid-hold must stop previous brush spray');

    // Edge Case F: Pencil mode unlocked hold locks & places 1 block; locked quick-tap unlocks without placing block
    RTL.fireEvent.pointerDown(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 5 });
    await new Promise((r) => setTimeout(r, RETICLE_HOLD_LOCK_DRAW_MS + 35));
    RTL.fireEvent.pointerUp(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 5 });
    assert.equal(drawCalls, 1, 'Holding unlocked Pencil circle locks and places 1 block');

    view.rerender(
      React.createElement(
        ToolCenterReticle,
        makeProps({
          tool: 'pencil',
          surfaceAnchor: { x: 0, y: 0, z: -1.8, nx: 0, ny: 0, nz: 1, depthM: 1.8, locked: true }
        })
      )
    );
    RTL.fireEvent.pointerDown(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 6 });
    RTL.fireEvent.pointerUp(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 6 });
    assert.equal(unlockCalls, 1, 'Tapping locked Pencil circle unlocks to change location');
    assert.equal(drawCalls, 1, 'Unlock tap must not place a stray Pencil block');

    // Holding ALREADY locked Pencil circle draws at that locked surface without unlocking
    RTL.fireEvent.pointerDown(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 7 });
    await new Promise((r) => setTimeout(r, RETICLE_HOLD_LOCK_DRAW_MS + 35));
    RTL.fireEvent.pointerUp(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 7 });
    assert.equal(drawCalls, 2, 'Holding locked Pencil circle draws at locked location');
    assert.equal(unlockCalls, 1, 'Holding locked Pencil circle keeps lock active');

    cleanup();
  });
});
