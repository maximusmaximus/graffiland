import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

const ROOT = path.resolve(process.cwd());

/**
 * Generates a minimal valid binary glTF 2.0 (.glb) containing a 1-triangle mesh
 * so loadCustomModelObject can be verified end-to-end without network calls.
 */
function buildMinimalValidGlbArrayBuffer() {
  const positions = new Float32Array([0, 0, 0, 0.8, 0, 0, 0.4, 1.1, 0.5]);
  const binByteLen = positions.byteLength;
  const binPad = (4 - (binByteLen % 4)) % 4;
  const paddedBinLen = binByteLen + binPad;

  const jsonObj = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'TestPyramid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ byteLength: binByteLen }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binByteLen, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [0.8, 1.1, 0.5]
      }
    ]
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonObj));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const paddedJsonLen = jsonBytes.byteLength + jsonPad;

  const totalLen = 12 + 8 + paddedJsonLen + 8 + paddedBinLen;
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  // GLB Header: magic "glTF", version 2, totalLength
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  // JSON chunk
  dv.setUint32(12, paddedJsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i += 1) out[20 + jsonBytes.byteLength + i] = 0x20;
  // BIN chunk
  const binHeaderOff = 20 + paddedJsonLen;
  dv.setUint32(binHeaderOff, paddedBinLen, true);
  dv.setUint32(binHeaderOff + 4, 0x004e4942, true);
  out.set(new Uint8Array(positions.buffer), binHeaderOff + 8);
  return out.buffer;
}

describe('Mobile 3D Model Preview, Multi-Axis 2-Finger Rotate/Position, Scene Fade & Sculpture Collision', () => {
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
      define: { 'import.meta.env': '{}' },
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-model-transform-'));
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
    dom.window.HTMLCanvasElement.prototype.getContext = (kind) =>
      kind === '2d'
        ? {
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {},
            clearRect: () => {},
            drawImage: () => {}
          }
        : null;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('loadCustomModelObject decodes real GLB via customModel.modelUrl/downloadUrl & MobileStudio invokes it cleanly (no cyan block fallback)', async () => {
    const { loadCustomModelObject, clearCustomModelBufferCache } = await loadJsxModule(
      'client/src/utils/customModelLoader.js'
    );
    clearCustomModelBufferCache();

    const glbBuf = buildMinimalValidGlbArrayBuffer();
    const fetchedUrls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      fetchedUrls.push(String(url));
      return new Response(glbBuf.slice(0), {
        status: 200,
        headers: { 'Content-Type': 'model/gltf-binary' }
      });
    };

    try {
      const loaded = await loadCustomModelObject(
        {
          id: 'simready:cactus_pot',
          modelGlbUrl: '/api/catalog/emoji/1f335.glb',
          customModel: {
            format: 'glb',
            downloadUrl: '/api/catalog/emoji/1f335.glb',
            modelUrl: '/api/catalog/emoji/1f335.glb',
            scale: 1
          }
        },
        (u) => (u.startsWith('/') ? `https://api.spray.land${u}` : u),
        { applyCustomScale: false }
      );

      assert.ok(loaded?.object3d, 'Expected real parsed Three.js Object3D from GLB');
      assert.equal(fetchedUrls[0], 'https://api.spray.land/api/catalog/emoji/1f335.glb');
      assert.ok(loaded.baseSize.height > 1.0 && loaded.baseSize.width > 0.7);

      // Verify defensive fallback when caller passes modelUrl-only + options object as 2nd arg
      const loadedCompat = await loadCustomModelObject(
        {
          id: 'simready:compat_mesh',
          customModel: {
            format: 'glb',
            modelUrl: 'https://cdn.jsdelivr.net/gh/maximusmaximus/simready-pile@main/glb/chair.glb'
          }
        },
        { applyCustomScale: false }
      );
      assert.ok(loadedCompat?.object3d, 'Defensive overload must still decode GLB cleanly');

      // Verify MobileStudio calls loadCustomModelObject with downloadUrl + resolveApiUrl + options
      const mobileSrc = fs.readFileSync(
        path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
        'utf8'
      );
      assert.match(mobileSrc, /downloadUrl:\s*item\.modelUrl/);
      assert.match(mobileSrc, /resolveApiUrl,\s*\{\s*applyCustomScale:\s*false\s*\}/);
      assert.match(mobileSrc, /findNonCollidingPlacementPosition\(/);
    } finally {
      globalThis.fetch = origFetch;
      clearCustomModelBufferCache();
    }
  });

  test('2-finger gesture pivots Z on vertical pull, rotates Y on horizontal slide, and scales on pinch; 1-finger drag moves X & Y freely', async () => {
    const {
      captureTwoFingerFrame,
      computeOneFingerDragStep,
      computeTwoFingerTransformStep
    } = await loadJsxModule('client/src/utils/arTransformGestures.js');

    const camQuat = new THREE.Quaternion(); // Facing -Z, Right = +X, Up = +Y
    const camPos = new THREE.Vector3(0, 0, 0);
    const pivot = { x: 0, y: 0, z: -2.0 };
    const startTr = { scale: 1, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 };

    // 1) Two-finger pull up (-60px) + slide right (+60px) + pinch spread (1.5x)
    const f0 = captureTwoFingerFrame([
      { x: 100, y: 200 },
      { x: 200, y: 200 }
    ]);
    const nextPts = [
      { x: 210 - 75, y: 140 },
      { x: 210 + 75, y: 140 }
    ];
    const step2 = computeTwoFingerTransformStep({
      prevFrame: f0,
      nextPointers: nextPts,
      cameraQuaternion: camQuat,
      cameraPosition: camPos,
      pivot,
      currentTransform: startTr
    });

    assert.ok(step2.nextTransform.scale > 1.4, `Expected pinch spread to enlarge scale, got ${step2.nextTransform.scale}`);
    assert.ok(step2.nextTransform.rotYDeg > 25, `Expected 2-finger slide right to rotate Y, got ${step2.nextTransform.rotYDeg}`);
    assert.ok(step2.nextTransform.rotZDeg > 25, `Expected 2-finger pull up to pivot Z, got ${step2.nextTransform.rotZDeg}`);

    // Two-finger pull down (+60px) pivots Z in the opposite direction
    const pullDown = computeTwoFingerTransformStep({
      prevFrame: f0,
      nextPointers: [
        { x: 100, y: 260 },
        { x: 200, y: 260 }
      ],
      currentTransform: startTr
    });
    assert.ok(pullDown.nextTransform.rotZDeg < -25, `Expected 2-finger pull down to pivot -Z, got ${pullDown.nextTransform.rotZDeg}`);

    // 2) Single-finger drag right (+50px) and up (-40px) shifts BOTH +X and +Y smoothly
    const step1 = computeOneFingerDragStep({
      dx: 50,
      dy: -40,
      cameraQuaternion: camQuat,
      cameraPosition: camPos,
      pivot,
      currentTransform: startTr
    });
    assert.ok(step1.offsetX > 0.1, `Expected +X move on 1-finger drag right, got ${step1.offsetX}`);
    assert.ok(step1.offsetY > 0.1, `Expected +Y move on 1-finger drag up, got ${step1.offsetY}`);
  });

  test('Auto-fade fades other items during transform & catalog placement, and 3D collision blocks spawning/moving sculptures into other sculptures', async () => {
    const {
      collectPlacedItemColliders,
      findNonCollidingPlacementPosition,
      testBoundingBoxAgainstPlacedItems
    } = await loadJsxModule('client/src/utils/arItemCollision.js');
    const { default: useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js').then(
      (m) => ({ default: m.useVoxelBrush })
    );
    const { default: ToolCarouselBar } = await loadJsxModule(
      'client/src/components/studio/ToolCarouselBar.jsx'
    );
    const { default: Catalog3DSearchBox } = await loadJsxModule(
      'client/src/components/Catalog3DSearchBox.jsx'
    );

    // Verify useARPreview & ARViewportCanvas both apply fade in transform mode
    const arPrevSrc = fs.readFileSync(path.join(ROOT, 'client/src/hooks/useARPreview.js'), 'utf8');
    const viewportSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(arPrevSrc, /\(mode === 'draw' \|\| mode === 'transform'\)/);
    assert.match(viewportSrc, /modeRef\.current === 'transform'/);

    // Build a nearbyGroup with an existing 1m x 1m x 1m sculpture centered at (0, 0.5, -2.0)
    const nearbyGroup = new THREE.Group();
    const existingSub = new THREE.Group();
    existingSub.userData = {
      sculptureId: 'sc-existing-statue',
      parcelId: 'GLAND-TEST',
      sculpture: { id: 'sc-existing-statue', title: 'Golden Statue' }
    };
    const statueMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 1.0, 1.0),
      new THREE.MeshStandardMaterial({ color: 0xffd166 })
    );
    statueMesh.position.set(0, 0.5, -2.0);
    existingSub.add(statueMesh);
    nearbyGroup.add(existingSub);
    nearbyGroup.updateMatrixWorld(true);

    const colliders = collectPlacedItemColliders(nearbyGroup);
    assert.equal(colliders.length, 1);

    // 1) Initial spawn right on top of Golden Statue automatically shifts to nearest collision-free spot!
    const spawned = findNonCollidingPlacementPosition({
      initialPos: { x: 0, y: 0, z: -2.0 },
      baseSize: { width: 0.75, height: 0.75, depth: 0.75 },
      scale: 1,
      colliders,
      cameraPosition: { x: 0, y: 0, z: 0 }
    });
    assert.equal(spawned.shifted, true, 'Expected overlapping initial spawn to shift beside existing sculpture');
    assert.equal(spawned.avoidedTitle, 'Golden Statue');
    const spawnedBox = new THREE.Box3(
      new THREE.Vector3(spawned.pos.x - 0.375, spawned.pos.y, spawned.pos.z - 0.375),
      new THREE.Vector3(spawned.pos.x + 0.375, spawned.pos.y + 0.75, spawned.pos.z + 0.375)
    );
    assert.equal(
      testBoundingBoxAgainstPlacedItems({ box: spawnedBox, colliders }).blocked,
      false,
      'Shifted spawn position must be completely collision-free'
    );

    // 2) Live transform collision guard in useVoxelBrush blocks dragging/moving a placed model INTO Golden Statue!
    let latestBrush = null;
    const hints = [];
    const stagedItem = {
      id: 'simready:neon_chair',
      title: 'Neon Chair',
      previewImageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      scale: 1,
      rotXDeg: 0,
      rotYDeg: 0,
      rotZDeg: 0,
      pos: { x: 1.4, y: 0, z: -2.0 },
      baseSize: { width: 0.7, height: 0.8, depth: 0.7 }
    };

    function TransformCollisionHarness() {
      const dummyRef = React.useRef(null);
      const nearbyRef = React.useRef(nearbyGroup);
      const draftRef = React.useRef(new THREE.Group());
      const itemRef = React.useRef(stagedItem);
      const pivotRef = React.useRef({ ...stagedItem.pos });
      const camRef = React.useRef(new THREE.PerspectiveCamera(68, 1, 0.05, 100));

      const brush = useVoxelBrush({
        config: { policy: {} },
        initialDraft: {},
        user: { id: 'u1' },
        location: { lat: 39.73, lng: -121.84 },
        cameraReady: true,
        sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
        calibrationReady: true,
        showTemporaryHint: (m) => hints.push(m),
        canvasHostRef: dummyRef,
        cameraRef: camRef,
        draftGroupRef: draftRef,
        transformBoxRef: dummyRef,
        surfaceMarkerRef: dummyRef,
        shadowPlaneRef: dummyRef,
        gridHelperRef: dummyRef,
        nearbyGroupRef: nearbyRef,
        arTargetedIdRef: dummyRef,
        hasPlacedCatalogItem: true,
        placedCatalogItemRef: itemRef,
        placedCatalogPivotRef: pivotRef
      });
      latestBrush = brush;

      return React.createElement(ToolCarouselBar, {
        activeKeyTool: brush.activeKeyTool,
        toolAvailability: brush.toolAvailability,
        canTouch: true,
        swipeDragPx: 0,
        isDraggingKey: false,
        painting: false,
        mode: brush.mode,
        dockOpen: false,
        voxelsLength: 0,
        placedCatalogItem: stagedItem,
        transformCollision: brush.transformCollision,
        onRemoveCatalogItem: () => {},
        artTransform: brush.artTransform,
        onSetArtTransform: brush.setArtTransform,
        onToggleTransformLock: brush.toggleTransformLock,
        onStepKeyTool: brush.stepKeyTool,
        onKeyPointerDown: () => {},
        onKeyPointerMove: () => {},
        onKeyPointerUp: () => {},
        onKeyPointerCancel: () => {}
      });
    }

    const view = RTL.render(React.createElement(TransformCollisionHarness));
    await RTL.act(async () => {
      latestBrush.enterTransformMode({ pivotOverride: stagedItem.pos });
    });

    // Transform bar renders preview thumbnail, multi-axis X/Y/Z controls, and gesture instructions
    assert.ok(view.getByTestId('transform-model-preview-thumb'));
    assert.ok(view.getByTestId('transform-nudge-x-minus'));
    assert.ok(view.getByTestId('transform-nudge-x-plus'));
    assert.ok(view.getByTestId('transform-rotx-slider'));
    assert.ok(view.getByTestId('transform-roty-slider'));
    assert.ok(view.getByTestId('transform-rotz-slider'));
    assert.ok(view.getByTestId('transform-gesture-banner').textContent.includes('2-finger ↕ Z-pivot'));

    // Try moving -1.4m on X (straight into Golden Statue at x=0, z=-2.0) -> MUST BE BLOCKED!
    await RTL.act(async () => {
      latestBrush.setArtTransform((p) => ({ ...p, offsetX: -1.4 }));
    });
    assert.equal(
      latestBrush.artTransform.offsetX,
      0,
      'Must block moving sculpture directly into Golden Statue'
    );
    assert.equal(latestBrush.transformCollision?.blocked, true);
    assert.equal(latestBrush.transformCollision?.title, 'Golden Statue');
    assert.ok(view.getByTestId('transform-collision-warning').textContent.includes('Golden Statue'));

    // Moving +0.5m into open space (+X away from Golden Statue) succeeds & clears collision warning!
    await RTL.act(async () => {
      latestBrush.setArtTransform((p) => ({ ...p, offsetX: 0.5, rotXDeg: 20, rotYDeg: 45 }));
    });
    assert.equal(latestBrush.artTransform.offsetX, 0.5);
    assert.equal(latestBrush.artTransform.rotXDeg, 20);
    assert.equal(latestBrush.artTransform.rotYDeg, 45);
    assert.equal(latestBrush.transformCollision, null);
    assert.equal(view.queryByTestId('transform-collision-warning'), null);
    cleanup();

    // 3) Catalog3DSearchBox renders visual preview in selected footer before placing
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          totalMatches: 1,
          items: [
            {
              id: 'xeroemoji:1f525',
              rawId: '1f525',
              source: 'xeroemoji',
              sourceName: 'XeroEmoji Pile',
              title: 'Fire Emoji',
              modelFormat: 'glb',
              modelUrl: '/api/catalog/emoji/1f525.glb',
              previewImageUrl: 'https://cdn.jsdelivr.net/gh/maximusmaximus/xeroemoji@v1.0.2/svg/1f525.svg'
            }
          ]
        }),
        { status: 200 }
      );
    try {
      const searchView = RTL.render(
        React.createElement(Catalog3DSearchBox, {
          compact: true,
          onPlaceItem: () => {}
        })
      );
      await RTL.waitFor(() => {
        assert.ok(searchView.getByTestId('catalog-item-card-xeroemoji:1f525'));
      });
      RTL.fireEvent.click(searchView.getByTestId('catalog-item-card-xeroemoji:1f525'));
      const previewEl = searchView.getByTestId('catalog-selected-preview');
      assert.ok(previewEl.querySelector('img'), 'Selected item bar should render visual model preview');
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
