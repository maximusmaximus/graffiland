import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  GIZMO_BOX_FACES,
  computeFaceDragPlaneSpec,
  computeFaceDragTransform,
  computeFaceWorldNormal,
  isFaceFacingCamera
} from '../client/src/utils/gizmoFaceDrag.js';
import {
  GHOST_SELECT_VIEWPORT_AREA_FRACTION,
  computeInsideLandModelFraming,
  computeIsometricLandFraming
} from '../client/src/utils/isometricCameraFraming.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('3D Sculpture Face/Plane Dragging & 25% Ghost Zoom Framing', () => {
  test('1. gizmoFaceDrag handles all 6 faces, yaw rotations, camera facing filter, and bounds clamping', () => {
    assert.equal(GIZMO_BOX_FACES.length, 6);
    const byId = Object.fromEntries(GIZMO_BOX_FACES.map((f) => [f.id, f]));

    // Yaw = +90deg rotates front (+Z) normal to +X and right (+X) normal to -Z
    const frontRot90 = computeFaceWorldNormal(byId.front.localNormal, Math.PI / 2);
    assert.ok(Math.abs(frontRot90[0] - 1) < 1e-6);
    assert.ok(Math.abs(frontRot90[1]) < 1e-6);
    assert.ok(Math.abs(frontRot90[2]) < 1e-6);

    const rightRot90 = computeFaceWorldNormal(byId.right.localNormal, Math.PI / 2);
    assert.ok(Math.abs(rightRot90[0]) < 1e-6);
    assert.ok(Math.abs(rightRot90[2] + 1) < 1e-6);

    // Camera-facing check accepts front face and rejects back/grazing faces
    const camPos = { x: 8, y: 6, z: 10 };
    const hitPt = { x: 0, y: 2, z: 1 };
    assert.equal(isFaceFacingCamera([0, 0, 1], hitPt, camPos), true);
    assert.equal(isFaceFacingCamera([0, 0, -1], hitPt, camPos), false);
    assert.equal(isFaceFacingCamera([0, 1, 0], hitPt, camPos), true);
    assert.equal(isFaceFacingCamera([0, -1, 0], hitPt, camPos), false);

    // Top horizontal plane drags smoothly in XZ only and clamps to land bounds
    const topPlane = computeFaceDragPlaneSpec({
      face: byId.top,
      yawRad: (-72 * Math.PI) / 180,
      hitPoint: { x: 3.5, y: 7.08, z: -0.3 },
      cameraDir: { x: -0.5, y: -0.5, z: -0.7 }
    });
    assert.equal(topPlane.axis, 'horizontal');
    assert.deepEqual(topPlane.normal, [0, 1, 0]);
    assert.deepEqual(topPlane.point, [3.5, 7.08, -0.3]);

    const topDrag = computeFaceDragTransform({
      axis: topPlane.axis,
      startDx: 3.5,
      startDy: 0,
      startDz: -0.3,
      startPt: { x: 3.5, y: 7.08, z: -0.3 },
      hitPoint: { x: 6.25, y: 7.08, z: -2.8 },
      moveRanges: { minDx: -20, maxDx: 20, minDz: -20, maxDz: 20, maxDy: 10 }
    });
    assert.deepEqual(topDrag, { dx: 6.25, dz: -2.8 });
    assert.equal(topDrag.dy, undefined);

    // Vertical face (yaw = -72deg) drags both horizontally along the face AND vertically in Y
    const yawMinus72 = (-72 * Math.PI) / 180;
    const frontPlane = computeFaceDragPlaneSpec({
      face: byId.front,
      yawRad: yawMinus72,
      hitPoint: { x: 2, y: 3, z: 1 },
      cameraDir: { x: 0.7, y: -0.3, z: -0.6 }
    });
    assert.equal(frontPlane.axis, 'vertical');
    assert.equal(frontPlane.normal[1], 0);
    // Tangent along the rotated vertical face
    const tangentX = -frontPlane.normal[2];
    const tangentZ = frontPlane.normal[0];
    const vertDrag = computeFaceDragTransform({
      axis: frontPlane.axis,
      startDx: 1,
      startDy: 0.5,
      startDz: -1,
      startPt: { x: 2, y: 3, z: 1 },
      hitPoint: { x: 2 + tangentX * 4, y: 5.25, z: 1 + tangentZ * 4 },
      moveRanges: { minDx: -10, maxDx: 10, minDz: -10, maxDz: 10, maxDy: 8 }
    });
    assert.equal(vertDrag.dy, 2.75);
    assert.ok(Math.abs(vertDrag.dx - Math.round((1 + tangentX * 4) * 100) / 100) < 1e-6);
    assert.ok(Math.abs(vertDrag.dz - Math.round((-1 + tangentZ * 4) * 100) / 100) < 1e-6);

    // Dragging below ground clamps dy >= 0 and respects land XZ bounds
    const clampedDrag = computeFaceDragTransform({
      axis: 'vertical',
      startDx: 0,
      startDy: 0,
      startDz: 0,
      startPt: { x: 0, y: 2, z: 0 },
      hitPoint: { x: 40, y: -5, z: -40 },
      moveRanges: { minDx: -12, maxDx: 12, minDz: -12, maxDz: 12, maxDy: 6 }
    });
    assert.deepEqual(clampedDrag, { dx: 12, dy: 0, dz: -12 });
  });

  test('2. computeInsideLandModelFraming zooms ghost selections to ~25% of working viewport window without clipping', () => {
    assert.equal(GHOST_SELECT_VIEWPORT_AREA_FRACTION, 0.25);

    const landFull = computeIsometricLandFraming({
      volW: 70.7,
      volD: 70.7,
      volH: 11.0,
      modelHeight: 2.2,
      fovDeg: 46,
      aspect: 1.5
    });

    // Standard cubic / organic model inside huge Stibblez Land
    const cheeseFrame = computeInsideLandModelFraming({
      modelWidth: 2.0,
      modelHeight: 1.8,
      modelDepth: 2.0,
      modelCenterX: 8.5,
      modelCenterY: 0.86,
      modelCenterZ: -4.2,
      modelMinY: 0,
      volW: 70.7,
      volD: 70.7,
      volH: 11.0,
      fovDeg: 46,
      aspect: 1.5,
      targetViewportAreaFraction: GHOST_SELECT_VIEWPORT_AREA_FRACTION
    });

    assert.deepEqual(cheeseFrame.target, [8.5, 0.86, -4.2]);
    assert.ok(
      Math.abs(cheeseFrame.projectedAreaFraction - 0.25) < 0.015,
      `Expected ~25% viewport area, got ${(cheeseFrame.projectedAreaFraction * 100).toFixed(2)}%`
    );
    assert.ok(cheeseFrame.projectedWidthFraction <= 0.78);
    assert.ok(cheeseFrame.projectedHeightFraction <= 0.78);
    assert.ok(
      cheeseFrame.distance < landFull.distance * 0.2,
      `Expected ghost zoom distance (${cheeseFrame.distance.toFixed(2)}m) << full land distance (${landFull.distance.toFixed(2)}m)`
    );

    // Tall thin object (Bad Flower: 5.26 x 7.08 x 2.32m) stays unclipped and around 20-25% window area
    const flowerFrame = computeInsideLandModelFraming({
      modelWidth: 5.26,
      modelHeight: 7.08,
      modelDepth: 2.32,
      modelCenterX: 3.484,
      modelCenterY: 3.4,
      modelCenterZ: -0.335,
      modelMinY: 0,
      volW: 70.7,
      volD: 70.7,
      volH: 11.0,
      fovDeg: 46,
      aspect: 1.5,
      targetViewportAreaFraction: GHOST_SELECT_VIEWPORT_AREA_FRACTION
    });
    assert.ok(flowerFrame.projectedHeightFraction <= 0.78, 'Tall model must not clip vertically');
    assert.ok(flowerFrame.projectedWidthFraction <= 0.78, 'Tall model must not clip horizontally');
    assert.ok(
      flowerFrame.projectedAreaFraction >= 0.18 && flowerFrame.projectedAreaFraction <= 0.27,
      `Expected tall model viewport area near 25%, got ${(flowerFrame.projectedAreaFraction * 100).toFixed(2)}%`
    );
  });

  test('3. SculptureViewer3D intercepts face/handle drags before OrbitControls and keeps camera stationary while model moves', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'SculptureViewer3D.jsx'),
      'utf8'
    );
    // Capture-phase pointerdown intercepts BEFORE OrbitControls
    assert.match(src, /addEventListener\('pointerdown',\s*onPointerDown,\s*true\)/);
    assert.match(src, /removeEventListener\('pointerdown',\s*onPointerDown,\s*true\)/);
    assert.match(src, /evt\.stopImmediatePropagation\(\)/);
    // 6 box face meshes & depth-aware front-handle vs front-face picker
    assert.match(src, /GIZMO_BOX_FACES/);
    assert.match(src, /gizmoFaceMeshesRef/);
    assert.match(src, /pickGizmoInteraction/);
    assert.match(src, /computeFaceDragPlaneSpec/);
    assert.match(src, /computeFaceDragTransform/);
    // Camera auto-pan on move MUST be removed so the model moves instead of the scene moving around it
    assert.doesNotMatch(src, /controlsRef\.current\.target\.x\s*\+=\s*deltaX/);
    assert.doesNotMatch(src, /cameraRef\.current\.position\.x\s*\+=\s*deltaX/);
    // HUD legend mentions Faces: Drag alongside Corners: Scale
    assert.match(src, /Faces: Drag.*Corners: Scale/);
  });
});

describe('SculptureModal Ghost Click -> 25% Viewport Zoom Integration (React + jsdom)', () => {
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
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({
              path: 'stub.css',
              namespace: 'stub-css'
            }));
            build.onResolve({ filter: /\?url$/ }, () => ({
              path: 'stub-url',
              namespace: 'stub-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-face-ghost-'));
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

  after(() => {
    cleanup?.();
    dom?.window?.close?.();
    if (outTmpDir && fs.existsSync(outTmpDir)) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('4. Clicking a ghost under "Click ghost to save & edit:" switches from Fit Land to 25% viewport focus on that object', async () => {
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );

    const parcel = {
      parcelId: 'GLAND-STIBBLEZ',
      customName: 'Stibblez Land',
      ownerSub: 'u-duke',
      lat: 39.7285,
      lng: -121.8375,
      widthMeters: 70.7,
      depthMeters: 70.7,
      heightMeters: 11.0,
      frozen: false
    };
    const badFlower = {
      id: 'sc-flower',
      title: 'Bad Flower',
      parcelId: parcel.parcelId,
      creatorSub: 'u-bigdog',
      creatorUsername: 'bigdog',
      lat: parcel.lat,
      lng: parcel.lng,
      voxelCount: 467,
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
      anchorOffset: { dx: 3.48, dy: 0, dz: -0.33, yaw: -72, pitch: 0, roll: 85 },
      baseDimensions: { width: 5.26, height: 7.08, depth: 2.32 }
    };
    const bigCheese = {
      id: 'sc-cheese',
      title: 'Big cheese',
      parcelId: parcel.parcelId,
      creatorSub: 'u-bigdog',
      creatorUsername: 'bigdog',
      lat: parcel.lat,
      lng: parcel.lng,
      modelType: 'custom-3d',
      customModel: { format: 'glb', scale: 1, downloadUrl: '/api/models/cheese.glb' },
      anchorOffset: { dx: -8.2, dy: 0, dz: 5.4, yaw: 15, pitch: 0, roll: 0 },
      baseDimensions: { width: 2.2, height: 1.8, depth: 2.1 }
    };
    const stibblezReadOnly = {
      id: 'sc-stibblez',
      title: 'Stibblez',
      parcelId: parcel.parcelId,
      creatorSub: 'u-duke',
      creatorUsername: 'dukenukem',
      lat: parcel.lat,
      lng: parcel.lng,
      voxelCount: 120,
      anchorOffset: { dx: -12, dy: 0, dz: -10, yaw: 0, pitch: 0, roll: 0 }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes(`/api/lands/${parcel.parcelId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            parcel,
            sculptures: [badFlower, bigCheese, stibblezReadOnly]
          })
        };
      }
      if (u.includes(`/api/sculptures/${bigCheese.id}`)) {
        return { ok: true, status: 200, json: async () => ({ sculpture: bigCheese }) };
      }
      if (u.includes(`/api/sculptures/${badFlower.id}`)) {
        return { ok: true, status: 200, json: async () => ({ sculpture: badFlower }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      const view = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: badFlower,
          user: { id: 'u-bigdog', username: 'bigdog' },
          isDesktop: true,
          allParcels: [parcel],
          allSculptures: [badFlower, bigCheese, stibblezReadOnly],
          onClose: () => {}
        })
      );

      // Wait for ghost chips to appear
      const cheeseChip = await RTL.waitFor(() =>
        view.getByTestId(`viewer-ghost-chip-${bigCheese.id}`)
      );
      const viewer = view.getByTestId('sculpture-viewer-3d');

      // Switch to Fit Land (zoomed out to whole land)
      RTL.fireEvent.click(view.getByTestId('sculpture-fit-land-btn'));
      assert.equal(viewer.getAttribute('data-camera-focus'), 'land');
      assert.equal(viewer.getAttribute('data-target-viewport-area'), '');

      // Click ghost chip "Big cheese" under "Click ghost to save & edit:"
      RTL.fireEvent.click(cheeseChip);

      await RTL.waitFor(() => {
        const modal = view.getByTestId('sculpture-modal');
        assert.equal(modal.getAttribute('data-active-sculpture-id'), bigCheese.id);
      });

      // Immediately switches camera focus back to 'model' and targets 25% of the working viewport window
      assert.equal(viewer.getAttribute('data-camera-focus'), 'model');
      assert.equal(viewer.getAttribute('data-target-viewport-area'), '0.25');
      assert.equal(viewer.getAttribute('data-land-bounds-preview'), 'on');

      // Clicking Fit Land clears the 25% ghost focus and zooms back to full land
      RTL.fireEvent.click(view.getByTestId('sculpture-fit-land-btn'));
      assert.equal(viewer.getAttribute('data-camera-focus'), 'land');
      assert.equal(viewer.getAttribute('data-target-viewport-area'), '');

      // Clicking the previous sculpture's ghost chip ("Bad Flower") zooms right back to 25%
      const flowerChip = await RTL.waitFor(() =>
        view.getByTestId(`viewer-ghost-chip-${badFlower.id}`)
      );
      RTL.fireEvent.click(flowerChip);
      await RTL.waitFor(() => {
        assert.equal(view.getByTestId('sculpture-modal').getAttribute('data-active-sculpture-id'), badFlower.id);
      });
      assert.equal(viewer.getAttribute('data-camera-focus'), 'model');
      assert.equal(viewer.getAttribute('data-target-viewport-area'), '0.25');
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });

  test('5. Modify, Scale & Move Artwork displays feet by default for US/Imperial, saves canonical meters, and live-switches to Metric', async () => {
    const { default: SculptureModal } = await loadJsxModule(
      'client/src/components/SculptureModal.jsx'
    );
    const { setStoredUnitPreference } = await loadJsxModule(
      'client/src/utils/measurementUnits.js'
    );

    const parcel = {
      parcelId: 'GLAND-STIBBLEZ-FT',
      customName: 'Stibblez Land',
      ownerSub: 'u-bigdog',
      lat: 39.7285,
      lng: -121.8375,
      widthMeters: 70.7,
      depthMeters: 70.7,
      heightMeters: 11.0,
      frozen: false
    };
    const badFlower = {
      id: 'sc-flower-ft',
      title: 'Bad Flower',
      parcelId: parcel.parcelId,
      creatorSub: 'u-bigdog',
      creatorUsername: 'bigdog',
      lat: parcel.lat,
      lng: parcel.lng,
      voxelCount: 467,
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
      anchorOffset: { dx: 3.484, dy: 0, dz: -0.335, yaw: -72, pitch: 0, roll: 0 },
      baseDimensions: { width: 5.26, height: 7.08, depth: 2.32 }
    };

    const savedPayloads = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes(`/api/sculptures/${badFlower.id}`) && opts.method === 'PUT') {
        const body = JSON.parse(opts.body || '{}');
        savedPayloads.push(body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            sculpture: { ...badFlower, anchorOffset: body.anchorOffset }
          })
        };
      }
      if (u.includes(`/api/lands/${parcel.parcelId}`)) {
        return { ok: true, status: 200, json: async () => ({ parcel, sculptures: [badFlower] }) };
      }
      if (u.includes(`/api/sculptures/${badFlower.id}`)) {
        return { ok: true, status: 200, json: async () => ({ sculpture: badFlower }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    setStoredUnitPreference('auto');
    try {
      const view = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: badFlower,
          user: { id: 'u-bigdog', username: 'bigdog' },
          isDesktop: true,
          allParcels: [parcel],
          allSculptures: [badFlower],
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        const studio = view.getByTestId('sculpture-transform-studio');
        assert.equal(studio.getAttribute('data-unit-system'), 'imperial');
      });

      // All Modify, Scale & Move Artwork readouts + corner pills show feet (ft), NOT meters
      assert.ok(view.getByTestId('sculpture-corner-transform-pill').textContent.includes('ft'));
      assert.ok(!view.getByTestId('sculpture-corner-transform-pill').textContent.includes('m ·'));
      assert.ok(view.getByTestId('sculpture-corner-offset-pill').textContent.includes('ft'));
      assert.ok(view.getByTestId('sculpture-scale-dims-summary').textContent.includes('ft inside'));
      assert.ok(view.getByTestId('sculpture-scale-dims-summary').textContent.includes('ft land'));
      assert.equal(view.getByTestId('sculpture-move-dx-readout').textContent.trim(), '11.43 ft');
      assert.equal(view.getByTestId('sculpture-move-dz-readout').textContent.trim(), '-1.10 ft');
      assert.equal(view.getByTestId('sculpture-move-dy-readout').textContent.trim(), '0.00 ft');
      assert.equal(view.getByTestId('sculpture-move-dx-input').getAttribute('aria-label'), 'dx (ft)');
      assert.equal(view.getByTestId('sculpture-move-dz-input').getAttribute('aria-label'), 'dz (ft)');
      assert.equal(view.getByTestId('sculpture-move-dy-input').getAttribute('aria-label'), 'dy (ft)');
      assert.ok(view.getByTestId('sculpture-vertical-measure-readout').textContent.includes('ft W'));
      assert.ok(view.getByTestId('sculpture-vertical-measure-readout').textContent.includes('ft H'));

      // Editing Move X to 10 ft updates readout to 10.00 ft and persists canonical 3.048 m on Save
      RTL.fireEvent.change(view.getByTestId('sculpture-move-dx-input'), {
        target: { value: '10' }
      });
      assert.equal(view.getByTestId('sculpture-move-dx-readout').textContent.trim(), '10.00 ft');
      await RTL.act(async () => {
        RTL.fireEvent.click(view.getByTestId('sculpture-save-transform-btn'));
      });
      await RTL.waitFor(() => {
        assert.equal(savedPayloads.length, 1);
      });
      assert.ok(
        Math.abs(savedPayloads[0].anchorOffset.dx - 3.048) < 0.002,
        `Expected 10 ft -> 3.048 m, got ${savedPayloads[0].anchorOffset.dx}`
      );

      // Switching user preference to Metric live-updates all readouts & labels to meters (m)
      RTL.act(() => {
        setStoredUnitPreference('metric');
      });
      await RTL.waitFor(() => {
        assert.equal(
          view.getByTestId('sculpture-transform-studio').getAttribute('data-unit-system'),
          'metric'
        );
      });
      assert.equal(view.getByTestId('sculpture-move-dx-readout').textContent.trim(), '3.05 m');
      assert.equal(view.getByTestId('sculpture-move-dx-input').getAttribute('aria-label'), 'dx (m)');
      assert.ok(view.getByTestId('sculpture-scale-dims-summary').textContent.includes('m inside'));
    } finally {
      setStoredUnitPreference('auto');
      globalThis.fetch = origFetch;
      cleanup();
    }
  });
});
