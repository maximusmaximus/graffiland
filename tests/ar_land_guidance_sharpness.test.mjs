import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import {
  applyProximitySharpnessToObject3D,
  computeArLandCameraGuidance,
  computeProximitySharpness
} from '../client/src/utils/arLandGuidance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('AR Land Directional Guidance & Proximity Sharpness Math (arLandGuidance.js)', () => {
  test('computeArLandCameraGuidance computes exact blinking arrow directions (right, left, up, down, behind) and flips to inView when camera turns toward land', () => {
    const camera = new THREE.PerspectiveCamera(68, 390 / 844, 0.05, 120);
    camera.position.set(0, 0.4, 0);
    camera.lookAt(0, 0.4, -10);
    camera.updateMatrixWorld();

    // 1. Land to the RIGHT (+X)
    const gRight = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(18, 1.2, -6),
      camera,
      distanceMeters: 19
    });
    assert.equal(gRight.inView, false);
    assert.equal(gRight.edge, 'right');
    assert.equal(gRight.instruction, 'Move camera right');
    assert.ok(gRight.yawDeg > 35, `Expected positive right yawDeg, got ${gRight.yawDeg}`);

    // 2. Land to the LEFT (-X)
    const gLeft = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(-18, 1.2, -6),
      camera,
      distanceMeters: 19
    });
    assert.equal(gLeft.inView, false);
    assert.equal(gLeft.edge, 'left');
    assert.equal(gLeft.instruction, 'Move camera left');
    assert.ok(gLeft.yawDeg < -35, `Expected negative left yawDeg, got ${gLeft.yawDeg}`);

    // 3. Land ABOVE camera (+Y)
    const gUp = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(0, 22, -8),
      camera,
      distanceMeters: 23
    });
    assert.equal(gUp.inView, false);
    assert.equal(gUp.edge, 'top');
    assert.equal(gUp.instruction, 'Tilt camera up');
    assert.ok(gUp.pitchDeg > 30);

    // 4. Land BELOW camera (-Y)
    const gDown = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(0, -22, -8),
      camera,
      distanceMeters: 23
    });
    assert.equal(gDown.inView, false);
    assert.equal(gDown.edge, 'bottom');
    assert.equal(gDown.instruction, 'Tilt camera down');
    assert.ok(gDown.pitchDeg < -30);

    // 5. Land BEHIND camera (+Z) never flips NDC direction
    const gBehindRight = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(4, 0.4, 20),
      camera,
      distanceMeters: 20
    });
    assert.equal(gBehindRight.inView, false);
    assert.equal(gBehindRight.isBehind, true);
    assert.equal(gBehindRight.edge, 'right');
    assert.equal(gBehindRight.instruction, 'Turn around right');

    // 6. Dead behind camera still chooses a decisive horizontal turn arrow
    const gDeadBehind = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(0, 0.4, 20),
      camera,
      distanceMeters: 20
    });
    assert.equal(gDeadBehind.inView, false);
    assert.equal(gDeadBehind.isBehind, true);
    assert.ok(gDeadBehind.edge === 'right' || gDeadBehind.edge === 'left');

    // 7. User turns camera right toward the land -> enters view!
    camera.lookAt(18, 1.2, -6);
    camera.updateMatrixWorld();
    const gInView = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(18, 1.2, -6),
      camera,
      distanceMeters: 19
    });
    assert.equal(gInView.inView, true);
    assert.equal(gInView.edge, 'center');
    assert.equal(gInView.instruction, 'Land in view');
  });

  test('computeProximitySharpness & applyProximitySharpnessToObject3D progressively sharpen meshes, textures, shadows, and resolution as user gets closer', () => {
    const far = computeProximitySharpness(58);
    const mid = computeProximitySharpness(22);
    const near = computeProximitySharpness(8);
    const ultra = computeProximitySharpness(2);

    assert.ok(far.sharpness < mid.sharpness && mid.sharpness < near.sharpness && near.sharpness < ultra.sharpness);
    assert.ok(far.anisotropyRatio < mid.anisotropyRatio && mid.anisotropyRatio < ultra.anisotropyRatio);
    assert.ok(far.sculptureOpacity < mid.sculptureOpacity && mid.sculptureOpacity < ultra.sculptureOpacity);
    assert.ok(far.prismOpacityScale < mid.prismOpacityScale && mid.prismOpacityScale < ultra.prismOpacityScale);
    assert.ok(far.canvasBlurPx > mid.canvasBlurPx && mid.canvasBlurPx > near.canvasBlurPx);
    assert.equal(near.canvasBlurPx, 0);
    assert.equal(ultra.canvasBlurPx, 0);
    assert.equal(ultra.sharpnessPct, 100);
    assert.equal(ultra.tier, 'ultra');
    assert.equal(far.simplifyVoxelLod, true);
    assert.equal(mid.simplifyVoxelLod, false);
    assert.equal(far.enableShadows, false);
    assert.equal(near.enableShadows, true);

    // Apply to a real Three.js sculpture mesh with PBR texture map
    const tex = new THREE.Texture();
    tex.anisotropy = 1;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x00f5d4,
      roughness: 0.35,
      map: tex
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    const group = new THREE.Group();
    group.add(mesh);

    applyProximitySharpnessToObject3D(group, far, 16);
    const farAniso = tex.anisotropy;
    const farRough = mat.roughness;
    const farOpacity = mat.opacity;
    assert.equal(mesh.castShadow, false);
    assert.ok(farRough > 0.35, 'Distant roughness softens slightly');
    assert.ok(farOpacity < 0.9, 'Distant opacity is atmospheric');

    applyProximitySharpnessToObject3D(group, ultra, 16);
    assert.equal(tex.anisotropy, 16, 'Close-up texture ramps to max anisotropy 16');
    assert.ok(tex.anisotropy > farAniso);
    assert.equal(Number(mat.roughness.toFixed(2)), 0.35, 'Close-up restores exact original PBR roughness');
    assert.equal(mat.opacity, 1, 'Close-up reaches 100% solid clarity');
    assert.equal(mesh.castShadow, true, 'Close-up activates shadows');
  });
});

describe('AR Land Guidance Overlay, Map Entry & High-Clarity Land Loading (React + jsdom)', () => {
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
      define: {
        'import.meta.env': '{}'
      },
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ar-guide-test-cache-'));
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

  test('ARLandGuidanceOverlay renders blinking directional arrows when off-screen, then switches to loading & sharpening in-view badge', async () => {
    const { default: ARLandGuidanceOverlay } = await loadJsxModule(
      'client/src/components/studio/ARLandGuidanceOverlay.jsx'
    );

    const sampleLand = {
      parcelId: 'GLAND-SQUIGGLE',
      displayName: 'Squiggle Bro Land',
      isInside: false,
      distanceLabel: '32m'
    };

    // 1. Off-screen to the right -> blinking right chevrons + directional cue
    const view = RTL.render(
      React.createElement(ARLandGuidanceOverlay, {
        land: sampleLand,
        guidance: {
          inView: false,
          edge: 'right',
          angleDeg: 8,
          turnDegrees: 52,
          instruction: 'Move camera right',
          distanceMeters: 32,
          sharpnessPct: 48,
          tier: 'clarifying',
          tierLabel: 'Clarifying'
        },
        loadState: { parcelId: 'GLAND-SQUIGGLE', status: 'loading' }
      })
    );

    const arrows = view.getByTestId('ar-land-guide-arrows');
    assert.equal(arrows.getAttribute('data-direction'), 'right');
    assert.equal(arrows.querySelectorAll('.ar-guide-chevron-step').length, 3);
    assert.ok(view.getByText(/Move camera right/i));
    assert.ok(view.getByText(/Squiggle Bro Land/i));
    assert.equal(view.queryByTestId('ar-land-in-view-badge'), null);

    // 2. User pans camera toward land -> enters view while artworks finish loading
    view.rerender(
      React.createElement(ARLandGuidanceOverlay, {
        land: sampleLand,
        guidance: {
          inView: true,
          edge: 'center',
          angleDeg: 0,
          turnDegrees: 3,
          instruction: 'Land in view',
          distanceMeters: 32,
          sharpnessPct: 48,
          tier: 'clarifying',
          tierLabel: 'Clarifying'
        },
        loadState: { parcelId: 'GLAND-SQUIGGLE', status: 'loading' }
      })
    );

    assert.equal(view.queryByTestId('ar-land-guide-arrows'), null);
    const loadingBadge = view.getByTestId('ar-land-in-view-badge');
    assert.ok(loadingBadge.textContent.includes('Loading Squiggle Bro Land'));

    // 3. Loaded at 32m -> shows sharpness meter prompting user to move closer; at 3m -> Ultra-Sharp!
    view.rerender(
      React.createElement(ARLandGuidanceOverlay, {
        land: sampleLand,
        guidance: {
          inView: true,
          edge: 'center',
          angleDeg: 0,
          turnDegrees: 1,
          instruction: 'Land in view',
          distanceMeters: 3,
          sharpnessPct: 100,
          tier: 'ultra',
          tierLabel: 'Ultra-Sharp'
        },
        loadState: { parcelId: 'GLAND-SQUIGGLE', status: 'ready' }
      })
    );

    const sharpBadge = view.getByTestId('ar-land-in-view-badge');
    assert.equal(sharpBadge.getAttribute('data-sharpness-tier'), 'ultra');
    assert.equal(sharpBadge.getAttribute('data-sharpness-pct'), '100');
    assert.ok(sharpBadge.textContent.includes('Ultra-Sharp'));
    view.unmount();
  });

  test('MobileMapSheet provides Find in AR button on nearby lands to launch directional camera guidance', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );

    let guidedLand = null;
    const view = RTL.render(
      React.createElement(MobileMapSheet, {
        location: { lat: 39.7302, lng: -121.84067 },
        mapParcels: [
          {
            parcelId: 'GLAND-SQUIGGLE',
            customName: 'Squiggle Bro Land',
            centerLat: 39.73035,
            centerLng: -121.8405,
            widthMeters: 5,
            depthMeters: 3,
            heightMeters: 3
          }
        ],
        displayedMapSculptures: [],
        areaSculpturesSorted: [],
        onFindLandInAR: (land) => {
          guidedLand = land;
        },
        onClose: () => {}
      })
    );

    const findBtn = view.getByTestId('land-card-find-ar-btn');
    RTL.fireEvent.click(findBtn);
    assert.ok(guidedLand);
    assert.equal(guidedLand.parcelId, 'GLAND-SQUIGGLE');
    view.unmount();
  });
});
