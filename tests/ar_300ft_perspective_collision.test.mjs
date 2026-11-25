import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import {
  AR_MAX_VISIBLE_DISTANCE_FEET,
  AR_MAX_VISIBLE_DISTANCE_METERS,
  VOXEL_STEP
} from '../shared/constants.mjs';
import {
  computeArLandPrismLocalGeometry,
  findNearbyCameraLands,
  isWithinArCameraVisibilityRange
} from '../client/src/utils/arLandHelpers.js';
import {
  applyProximitySharpnessToObject3D,
  blendHexWithAtmosphericHaze,
  computeProximitySharpness,
  DEFAULT_ATMOSPHERIC_HAZE_HEX
} from '../client/src/utils/arLandGuidance.js';
import {
  collectPlacedItemColliders,
  filterStrokeAgainstPlacedItems,
  testTransformedVoxelsAgainstPlacedItems,
  testVoxelAgainstPlacedItems
} from '../client/src/utils/arItemCollision.js';
import { buildVoxelGroup } from '../client/src/components/VoxelEngine3D.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function offsetLatNorth(lat, metersNorth) {
  return lat + metersNorth / 111320;
}

describe('AR 300-Foot Visibility Cutoff, True Perspective, Atmospheric Haze & Placed-Item Collision', () => {
  test('strictly enforces < 300 ft (91.44 m) AR camera visibility cutoff for lands and sculptures', () => {
    assert.equal(AR_MAX_VISIBLE_DISTANCE_FEET, 300);
    assert.equal(AR_MAX_VISIBLE_DISTANCE_METERS, 91.44);

    assert.equal(isWithinArCameraVisibilityRange(0), true);
    assert.equal(isWithinArCameraVisibilityRange(45), true);
    assert.equal(isWithinArCameraVisibilityRange(91.43), true);
    assert.equal(isWithinArCameraVisibilityRange(91.44), false, 'Exactly 300 ft must be excluded');
    assert.equal(isWithinArCameraVisibilityRange(95), false, '312 ft must be excluded');
    assert.equal(isWithinArCameraVisibilityRange(-1), false);
    assert.equal(isWithinArCameraVisibilityRange(NaN), false);

    const userLoc = { lat: 37.7749, lng: -122.4194 };
    const makeParcel = (id, northMeters) => {
      const cLat = offsetLatNorth(userLoc.lat, northMeters);
      return {
        parcelId: id,
        customName: id,
        centerLat: cLat,
        centerLng: userLoc.lng,
        volume: {
          centerLat: cLat,
          centerLng: userLoc.lng,
          widthMeters: 6,
          depthMeters: 6,
          heightMeters: 10
        }
      };
    };

    const result = findNearbyCameraLands({
      parcels: [
        makeParcel('GLAND-INSIDE', 0),
        makeParcel('GLAND-75M', 75), // ~246 ft (edge 72m < 91.44m) -> visible
        makeParcel('GLAND-94M', 94), // center 94m, 6m parcel -> near edge 91m (< 91.44m / 300 ft) -> visible
        makeParcel('GLAND-95M', 95), // center 95m, 6m parcel -> near edge 92m (>= 91.44m / 300 ft) -> hidden!
        makeParcel('GLAND-115M', 115) // ~377 ft (edge 112m >= 91.44m) -> hidden!
      ],
      sculptures: [],
      location: userLoc
    });

    const ids = result.visibleLands.map((l) => l.parcelId);
    assert.deepEqual(ids, ['GLAND-INSIDE', 'GLAND-75M', 'GLAND-94M']);

    // Verify useARPreview strictly applies < 300 ft cutoff for both lands and sculptures with no 55m distortion clamp
    const arPreviewSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useARPreview.js'),
      'utf8'
    );
    assert.match(arPreviewSrc, /maxDistanceMeters:\s*AR_MAX_VISIBLE_DISTANCE_METERS/);
    assert.match(arPreviewSrc, /if\s*\(!isWithinArCameraVisibilityRange\(dist\)\)\s*\{\s*continue;\s*\}/);
    assert.equal(
      arPreviewSrc.includes('maxDistanceMeters: 50000'),
      false,
      'Must never bypass 300 ft cutoff with 50km override'
    );
    assert.equal(
      arPreviewSrc.includes('dist > 55 ? 55 / dist : 1'),
      false,
      'Must never clamp sculpture distance at 55m and distort perspective'
    );
  });

  test('renders AR land prisms & sculptures at exact true 1:1 world-meter perspective (no 55m clamping) with camera-centered nearbyGroup', () => {
    const userLoc = { lat: 37.7749, lng: -122.4194 };
    // A 10m x 10m x 18m land centered 75m north (~246 ft)
    const vol = {
      centerLat: offsetLatNorth(userLoc.lat, 75),
      centerLng: userLoc.lng,
      widthMeters: 10,
      depthMeters: 10,
      heightMeters: 18,
      corners: [
        [userLoc.lng - 5 / (111320 * Math.cos((userLoc.lat * Math.PI) / 180)), offsetLatNorth(userLoc.lat, 70)],
        [userLoc.lng + 5 / (111320 * Math.cos((userLoc.lat * Math.PI) / 180)), offsetLatNorth(userLoc.lat, 70)],
        [userLoc.lng + 5 / (111320 * Math.cos((userLoc.lat * Math.PI) / 180)), offsetLatNorth(userLoc.lat, 80)],
        [userLoc.lng - 5 / (111320 * Math.cos((userLoc.lat * Math.PI) / 180)), offsetLatNorth(userLoc.lat, 80)]
      ]
    };

    const prism = computeArLandPrismLocalGeometry({
      location: userLoc,
      volume: vol,
      baseY: -1.15
    });
    assert.ok(prism);
    // Exact 1:1 meter Z coordinate (-75m north, NOT clamped to -55m!)
    assert.ok(
      Math.abs(prism.centerLocal.z - -75) < 0.05,
      `Expected true -75m z perspective coordinate, got ${prism.centerLocal.z}`
    );
    // Exact 1:1 width and depth preserved at 75m distance
    const spanX = Math.abs(prism.bottomCorners[1].x - prism.bottomCorners[0].x);
    const spanZ = Math.abs(prism.bottomCorners[2].z - prism.bottomCorners[1].z);
    assert.ok(Math.abs(spanX - 10) < 0.1, `Expected true 10m width, got ${spanX}`);
    assert.ok(Math.abs(spanZ - 10) < 0.1, `Expected true 10m depth, got ${spanZ}`);
    assert.equal(prism.heightMeters, 18);

    // Verify ARViewportCanvas anchors nearbyGroup on camera's physical GPS origin and has far plane >= 320m
    const viewportSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(viewportSrc, /nearbyGroup\.position\.set\(camera\.position\.x,\s*0,\s*camera\.position\.z\)/);
    assert.match(viewportSrc, /new THREE\.PerspectiveCamera\(\s*68,[\s\S]*?0\.05,\s*320\s*\)/);
  });

  test('applies atmospheric perspective (sky-haze tinting, desaturation, horizon attenuation) that sharpens cleanly up close and supports lossless draw-mode fade', () => {
    const close = computeProximitySharpness(2);
    const mid = computeProximitySharpness(25);
    const far = computeProximitySharpness(65);
    const horizon = computeProximitySharpness(89);
    const beyond = computeProximitySharpness(92);

    assert.equal(close.inVisibleRange, true);
    assert.equal(horizon.inVisibleRange, true);
    assert.equal(beyond.inVisibleRange, false);
    assert.equal(beyond.sculptureOpacity, 0);
    assert.equal(beyond.prismOpacityScale, 0);

    // Atmospheric haze strictly increases with distance, saturation & opacity strictly decrease
    assert.equal(close.atmosphericHaze, 0);
    assert.ok(close.atmosphericHaze < mid.atmosphericHaze);
    assert.ok(mid.atmosphericHaze < far.atmosphericHaze);
    assert.ok(far.atmosphericHaze < horizon.atmosphericHaze);
    assert.ok(close.saturationScale > mid.saturationScale && mid.saturationScale > horizon.saturationScale);
    assert.ok(close.emissiveScale > mid.emissiveScale && mid.emissiveScale > horizon.emissiveScale);
    assert.ok(close.sculptureOpacity > mid.sculptureOpacity && mid.sculptureOpacity > far.sculptureOpacity);
    assert.ok(far.sculptureOpacity > horizon.sculptureOpacity && horizon.sculptureOpacity > 0.1);

    // Land prism atmospheric hex blending
    const baseMagenta = 0xff00aa;
    assert.equal(blendHexWithAtmosphericHaze(baseMagenta, 0), baseMagenta);
    const hazedMagenta = blendHexWithAtmosphericHaze(baseMagenta, far.atmosphericHaze, DEFAULT_ATMOSPHERIC_HAZE_HEX);
    assert.notEqual(hazedMagenta, baseMagenta);
    const origCol = new THREE.Color(baseMagenta);
    const hazedCol = new THREE.Color(hazedMagenta);
    const skyCol = new THREE.Color(DEFAULT_ATMOSPHERIC_HAZE_HEX);
    assert.ok(
      Math.hypot(hazedCol.r - skyCol.r, hazedCol.g - skyCol.g, hazedCol.b - skyCol.b) <
        Math.hypot(origCol.r - skyCol.r, origCol.g - skyCol.g, origCol.b - skyCol.b),
      'Hazed prism color should move visibly toward sky haze tint'
    );

    // Apply atmospheric perspective + draw-mode fade to real Three.js sculpture mesh
    const tex = new THREE.Texture();
    tex.anisotropy = 1;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff0054,
      emissive: 0xff0054,
      emissiveIntensity: 0.85,
      roughness: 0.2,
      map: tex
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat);
    const group = new THREE.Group();
    group.add(mesh);

    // Far (65m): color shifts toward sky haze, emissive & opacity soften
    applyProximitySharpnessToObject3D(group, far, 16, { hazeTintHex: DEFAULT_ATMOSPHERIC_HAZE_HEX });
    assert.notEqual(mat.color.getHex(), 0xff0054, 'Far color should blend toward atmospheric haze');
    assert.ok(mat.emissiveIntensity < 0.85, 'Far emissive glow should soften');
    assert.ok(mat.opacity < 0.75, 'Far sculpture opacity should soften');
    assert.ok(mat.roughness > 0.2, 'Far roughness should soften');

    // Close (2m) with draw-mode fade ON (0.22): exact color restored, translucent ghost, depthWrite off, visible still true for collision!
    applyProximitySharpnessToObject3D(group, close, 16, { fadeMultiplier: 0.22 });
    assert.equal(mat.color.getHex(), 0xff0054, 'Close color restores exact vivid pigment');
    assert.equal(mat.opacity, 0.22);
    assert.equal(mat.transparent, true);
    assert.equal(mat.depthWrite, false);
    assert.equal(mesh.visible, true, 'Faded item mesh stays visible so 3D collision remains active');

    // Close (2m) normal (fade OFF): 100% crisp, solid, max anisotropy, shadows ON
    applyProximitySharpnessToObject3D(group, close, 16, { fadeMultiplier: 1 });
    assert.equal(mat.color.getHex(), 0xff0054);
    assert.equal(mat.opacity, 1);
    assert.equal(mat.depthWrite, true);
    assert.equal(mat.emissiveIntensity, 0.85);
    assert.equal(Number(mat.roughness.toFixed(2)), 0.2);
    assert.equal(tex.anisotropy, 16);
    assert.equal(mesh.castShadow, true);
  });

  test('blocks drawing, spraying, stacking, or moving into/through placed land items even when items are faded out', () => {
    const nearbyGroup = new THREE.Group();
    nearbyGroup.position.set(0, 0, 2.2); // Camera-anchored nearbyGroup

    // 1) Faded voxel wall sculpture placed 2.2m north of camera -> world z = 0, spanning x in [-0.25..0.25], y in [-0.25..0.25]
    const wallVoxels = [];
    for (let ix = -5; ix <= 5; ix += 1) {
      for (let iy = -5; iy <= 5; iy += 1) {
        wallVoxels.push({ x: ix * VOXEL_STEP, y: iy * VOXEL_STEP, z: 0, color: '#00f5d4', material: 'matte' });
      }
    }
    const voxelSub = new THREE.Group();
    voxelSub.userData = {
      sculptureId: 'sc-voxel-wall',
      parcelId: 'GLAND-1',
      sculpture: { id: 'sc-voxel-wall', title: 'Neon Wall' }
    };
    voxelSub.position.set(0, 0, -2.2); // World pos = (0, 0, 0)
    const instGroup = buildVoxelGroup(wallVoxels);
    voxelSub.add(instGroup);
    // Add oversized invisible hitProxy + clickable base ring (must be IGNORED by collision!)
    const hitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 4),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitProxy.userData.isHitProxy = true;
    voxelSub.add(hitProxy);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.3, 16),
      new THREE.MeshBasicMaterial({ color: 0x00f5d4 })
    );
    ring.userData.clickableBase = true;
    voxelSub.add(ring);
    // Fade the voxel sculpture out (draw-mode ghosted state)
    applyProximitySharpnessToObject3D(voxelSub, computeProximitySharpness(2.2), 8, { fadeMultiplier: 0.22 });
    nearbyGroup.add(voxelSub);

    // 2) Faded custom 3D model statue pillar placed at world (1.5, 0, 0) (0.4m cube)
    const modelSub = new THREE.Group();
    modelSub.userData = {
      sculptureId: 'sc-custom-pillar',
      parcelId: 'GLAND-1',
      sculpture: { id: 'sc-custom-pillar', title: 'Marble Pillar' }
    };
    modelSub.position.set(1.5, 0, -2.2); // World pos = (1.5, 0, 0)
    const pillarMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.8, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 })
    );
    modelSub.add(pillarMesh);
    nearbyGroup.add(modelSub);

    // 3) Land perimeter prism glass walls (must NEVER block drawing inside the land!)
    const landPrism = new THREE.Group();
    landPrism.userData = { isParcelPerimeter: true, parcelId: 'GLAND-1' };
    const wallMesh = new THREE.Mesh(
      new THREE.BoxGeometry(10, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff00aa, transparent: true, opacity: 0.08 })
    );
    wallMesh.userData.isArLandHit = true;
    landPrism.add(wallMesh);
    nearbyGroup.add(landPrism);

    const colliders = collectPlacedItemColliders(nearbyGroup);
    assert.equal(colliders.length, 2, 'Should collect only actual placed artwork colliders (not land prism)');

    const camPos = { x: 0, y: 0, z: 2.2 };

    // A) Direct overlap inside faded voxel wall -> BLOCKED
    const insideVoxel = testVoxelAgainstPlacedItems({
      point: { x: 0, y: 0, z: 0 },
      voxelScale: 1,
      rayOrigin: camPos,
      colliders
    });
    assert.equal(insideVoxel.blocked, true);
    assert.equal(insideVoxel.reason, 'overlap');
    assert.equal(insideVoxel.title, 'Neon Wall');

    // B) Direct overlap inside faded 3D model pillar -> BLOCKED
    const insideModel = testVoxelAgainstPlacedItems({
      point: { x: 1.5, y: 0, z: 0 },
      voxelScale: 1,
      rayOrigin: camPos,
      colliders
    });
    assert.equal(insideModel.blocked, true);
    assert.equal(insideModel.reason, 'overlap');
    assert.equal(insideModel.title, 'Marble Pillar');

    // C) Aiming THROUGH faded voxel wall to paint behind it at z = -1.2 -> BLOCKED (occluded!)
    const behindWall = testVoxelAgainstPlacedItems({
      point: { x: 0, y: 0, z: -1.2 },
      voxelScale: 1,
      rayOrigin: camPos,
      colliders
    });
    assert.equal(behindWall.blocked, true);
    assert.equal(behindWall.reason, 'occluded');
    assert.equal(behindWall.title, 'Neon Wall');

    // D) Painting cleanly IN FRONT of the wall (inside oversized hitProxy bounds, but outside real voxels!) -> ALLOWED
    const inFront = testVoxelAgainstPlacedItems({
      point: { x: 0, y: 0, z: 0.6 },
      voxelScale: 1,
      rayOrigin: camPos,
      colliders
    });
    assert.equal(inFront.blocked, false, 'Must allow painting cleanly in open space in front of existing art');

    // E) Painting cleanly beside the wall -> ALLOWED
    const besideWall = testVoxelAgainstPlacedItems({
      point: { x: -0.6, y: 0, z: 0 },
      voxelScale: 1,
      rayOrigin: camPos,
      colliders
    });
    assert.equal(besideWall.blocked, false);

    // F) Continuous fast spray-can stroke sweeping straight across the Marble Pillar -> stops cleanly before pillar!
    const sweepPath = [
      { action: 'add', x: 1.0, y: 0, z: 0, scale: 1 },
      { action: 'add', x: 1.15, y: 0, z: 0, scale: 1 },
      { action: 'add', x: 1.85, y: 0, z: 0, scale: 1 }, // Jumped right across pillar at x=1.5!
      { action: 'add', x: 2.0, y: 0, z: 0, scale: 1 }
    ];
    const filtered = filterStrokeAgainstPlacedItems({
      prevPoint: { x: 0.9, y: 0, z: 0 },
      pathPoints: sweepPath,
      rayOrigin: { x: 1.5, y: 0, z: 2.2 },
      colliders
    });
    assert.equal(filtered.blocked, true, 'Fast sweep piercing through placed item must be stopped');
    assert.equal(filtered.blockedBy?.title, 'Marble Pillar');
    assert.equal(filtered.allowed.length, 2, 'Only safe voxels before the obstacle are placed');
    assert.equal(filtered.allowed.every((v) => v.x < 1.25), true);

    // G) Lock & Scale transform collision check blocks moving voxels into existing art
    const transformBlocked = testTransformedVoxelsAgainstPlacedItems({
      voxels: [
        { x: -0.6, y: 0, z: 0, scale: 1 },
        { x: 1.5, y: 0.1, z: 0, scale: 1 }
      ],
      colliders
    });
    assert.equal(transformBlocked.blocked, true);
    assert.equal(transformBlocked.blockedBy?.title, 'Marble Pillar');

    // H) Editing your own sculpture excludes it from self-collision
    const editingColliders = collectPlacedItemColliders(nearbyGroup, {
      excludeSculptureId: 'sc-voxel-wall'
    });
    assert.equal(editingColliders.length, 1);
    assert.equal(editingColliders[0].sculptureId, 'sc-custom-pillar');
  });
});

describe('AR Fade Other Art Toggle & Out-of-Range 300 ft Guidance UI (React + jsdom)', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ar-300ft-test-cache-'));
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

  test('StudioHudTopBar and StudioDockDrawer expose Fade Other Art toggle while drawing near placed items', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    const { default: StudioDockDrawer } = await loadJsxModule(
      'client/src/components/studio/StudioDockDrawer.jsx'
    );

    let toggled = 0;
    const hudView = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'draw',
        dockOpen: false,
        location: { lat: 37.7749, lng: -122.4194 },
        voxels: [],
        quickSculpt: false,
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true, coveragePct: 100, scannedCount: 9, targetCount: 9 },
        isInteractingWithLand: false,
        nearbyOtherItemsCount: 3,
        fadeOtherItems: false,
        onToggleFadeOtherItems: () => {
          toggled += 1;
        }
      })
    );

    const fadeBtn = hudView.getByTestId('ar-fade-other-items-btn');
    assert.equal(fadeBtn.getAttribute('aria-pressed'), 'false');
    assert.ok(fadeBtn.textContent.includes('Fade Other Art (3)'));
    RTL.fireEvent.click(fadeBtn);
    assert.equal(toggled, 1);

    // Re-render in faded state
    hudView.rerender(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'draw',
        dockOpen: false,
        location: { lat: 37.7749, lng: -122.4194 },
        voxels: [],
        quickSculpt: false,
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true, coveragePct: 100, scannedCount: 9, targetCount: 9 },
        isInteractingWithLand: false,
        nearbyOtherItemsCount: 3,
        fadeOtherItems: true,
        onToggleFadeOtherItems: () => {
          toggled += 1;
        }
      })
    );
    const fadedBtn = hudView.getByTestId('ar-fade-other-items-btn');
    assert.equal(fadedBtn.getAttribute('aria-pressed'), 'true');
    assert.ok(fadedBtn.textContent.includes('Other Art Faded (3)'));
    hudView.unmount();

    // Paint & Brush Kit also exposes the Fade Other Art toggle when items exist
    const dockView = RTL.render(
      React.createElement(StudioDockDrawer, {
        dockOpen: true,
        onToggleDock: () => {},
        tool: 'brush',
        color: '#00f5d4',
        material: 'matte',
        reachMeters: 1.8,
        nearbyOtherItemsCount: 2,
        fadeOtherItems: false,
        onToggleFadeOtherItems: () => {
          toggled += 1;
        }
      })
    );
    const dockFadeBtn = dockView.getByTestId('palette-fade-other-items-btn');
    assert.ok(dockFadeBtn.textContent.includes('Fade Other Art on Land (2)'));
    RTL.fireEvent.click(dockFadeBtn);
    assert.equal(toggled, 2);
    dockView.unmount();
  });

  test('ARLandGuidanceOverlay shows clean 300 ft out-of-range prompt when selected land is >= 300 ft away', async () => {
    const { default: ARLandGuidanceOverlay } = await loadJsxModule(
      'client/src/components/studio/ARLandGuidanceOverlay.jsx'
    );

    const view = RTL.render(
      React.createElement(ARLandGuidanceOverlay, {
        land: {
          parcelId: 'GLAND-FAR',
          displayName: 'Far Ridge Land',
          edgeDistanceMeters: 140,
          outOfArRange: true
        },
        guidance: null
      })
    );

    const badge = view.getByTestId('ar-land-out-of-range-badge');
    assert.ok(badge.textContent.includes('Far Ridge Land'));
    assert.ok(badge.textContent.includes('Walk within 300 ft to view in AR camera'));
    view.unmount();
  });
});
