import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

const ROOT = path.resolve(process.cwd());

describe('Publish Isolated Art View — Only Newly Made Art or Placed 3D Model Visible', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-publish-isolated-'));
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
    dom?.window?.close();
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('shouldIsolatePublishArtView activates whenever entering or inside Publish and stays off for other modes', async () => {
    const { shouldIsolatePublishArtView } = await loadJsxModule(
      'client/src/utils/arLandGuidance.js'
    );

    assert.equal(
      shouldIsolatePublishArtView({ mode: 'publish', activeKeyTool: 'publish' }),
      true,
      'Publish modal mode must isolate user art'
    );
    assert.equal(
      shouldIsolatePublishArtView({ mode: 'publish', activeKeyTool: 'brush' }),
      true,
      'Publish mode must isolate user art regardless of active carousel tool'
    );
    assert.equal(
      shouldIsolatePublishArtView({ mode: 'draw', activeKeyTool: 'publish' }),
      true,
      'Landing on Publish tool in the carousel must immediately isolate user art'
    );

    assert.equal(
      shouldIsolatePublishArtView({ mode: 'draw', activeKeyTool: 'brush' }),
      false
    );
    assert.equal(
      shouldIsolatePublishArtView({ mode: 'draw', activeKeyTool: 'pencil' }),
      false
    );
    assert.equal(
      shouldIsolatePublishArtView({ mode: 'transform', activeKeyTool: 'transform' }),
      false
    );
    assert.equal(
      shouldIsolatePublishArtView({ mode: 'preview', activeKeyTool: 'preview' }),
      false
    );
    assert.equal(
      shouldIsolatePublishArtView({
        mode: 'publish',
        activeKeyTool: 'publish',
        isInteractingWithLand: true
      }),
      false
    );
    assert.equal(
      shouldIsolatePublishArtView({
        mode: 'publish',
        activeKeyTool: 'publish',
        isArViewOnly: true
      }),
      false
    );
  });

  test('captureIsolatedDraftSnapshot hides nearbyGroup & AR helpers during render, auto-frames ONLY draftGroup, and preserves collision checks', async () => {
    const { captureIsolatedDraftSnapshot } = await loadJsxModule(
      'client/src/utils/publishArtPreview.js'
    );
    const { collectPlacedItemColliders } = await loadJsxModule(
      'client/src/utils/arItemCollision.js'
    );

    const scene = new THREE.Scene();
    const liveCamera = new THREE.PerspectiveCamera(65, 9 / 16, 0.05, 400);
    liveCamera.position.set(0, 0, 0);
    // Deliberately point live camera away (straight down) to verify autoFrame centers on draftGroup
    liveCamera.lookAt(0, -10, 0);

    const draftGroup = new THREE.Group();
    const myArtMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.8, 0.6),
      new THREE.MeshBasicMaterial({ color: 0x00f5d4 })
    );
    myArtMesh.position.set(0.4, 0.5, -2.2);
    draftGroup.add(myArtMesh);
    draftGroup.visible = false; // even if somehow hidden, snapshot forces draftGroup visible
    scene.add(draftGroup);

    const nearbyGroup = new THREE.Group();
    const otherArtSub = new THREE.Group();
    otherArtSub.userData = {
      sculptureId: 'sc-other-land-art',
      parcelId: 'GLAND-BUSY',
      sculpture: { id: 'sc-other-land-art', title: 'Other Giant Statue' }
    };
    const otherMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 2.0, 1.2),
      new THREE.MeshBasicMaterial({ color: 0xff3e7f })
    );
    otherMesh.position.set(-1.5, 1.0, -3.0);
    otherArtSub.add(otherMesh);
    nearbyGroup.add(otherArtSub);
    nearbyGroup.visible = true;
    scene.add(nearbyGroup);

    const ghost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
    const grid = new THREE.GridHelper(4, 8);
    const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    const surfaceMarker = new THREE.Group();
    const transformBox = { visible: true };

    const renderLog = [];
    const mockRenderer = {
      render(scn, cam) {
        renderLog.push({
          scene: scn,
          camera: cam,
          draftVisible: draftGroup.visible,
          nearbyVisible: nearbyGroup.visible,
          ghostVisible: ghost.visible,
          gridVisible: grid.visible,
          shadowVisible: shadowPlane.visible,
          markerVisible: surfaceMarker.visible,
          transformBoxVisible: transformBox.visible
        });
      },
      domElement: {
        toDataURL(mime) {
          assert.equal(mime, 'image/png');
          return 'data:image/png;base64,ISOLATED_ART_ONLY';
        }
      }
    };

    const url = captureIsolatedDraftSnapshot({
      renderer: mockRenderer,
      scene,
      camera: liveCamera,
      draftGroup,
      hideObjects: [nearbyGroup, ghost, grid, shadowPlane, surfaceMarker, transformBox],
      keepHiddenObjects: [nearbyGroup],
      autoFrame: true
    });

    assert.equal(url, 'data:image/png;base64,ISOLATED_ART_ONLY');
    assert.ok(renderLog.length >= 1, 'Expected snapshot render call');

    // Snapshot frame (first render call) must ONLY show draftGroup — zero other land art or AR helpers!
    const snapFrame = renderLog[0];
    assert.equal(snapFrame.draftVisible, true, 'User art (draftGroup) must be visible in snapshot');
    assert.equal(snapFrame.nearbyVisible, false, 'Other art & items on land (nearbyGroup) must be hidden');
    assert.equal(snapFrame.ghostVisible, false, 'Cursor ghost must be hidden');
    assert.equal(snapFrame.gridVisible, false, 'Ground grid must be hidden');
    assert.equal(snapFrame.shadowVisible, false, 'Shadow catcher must be hidden');
    assert.equal(snapFrame.markerVisible, false, 'Surface beacon must be hidden');
    assert.equal(snapFrame.transformBoxVisible, false, 'Transform gizmo must be hidden');
    assert.notEqual(
      snapFrame.camera,
      liveCamera,
      'Snapshot must auto-frame a dedicated camera onto the user art bounding box'
    );

    // After capture: nearbyGroup stays hidden because it was in keepHiddenObjects (publish isolated),
    // while other restored states return cleanly and live camera re-renders with nearbyGroup hidden!
    assert.equal(nearbyGroup.visible, false, 'nearbyGroup must stay hidden while publish-isolated');
    assert.equal(ghost.visible, true);
    assert.equal(grid.visible, true);
    assert.equal(transformBox.visible, true);
    assert.equal(renderLog.length, 2, 'Live camera should re-render after auto-framed snapshot');
    assert.equal(renderLog[1].camera, liveCamera);
    assert.equal(renderLog[1].nearbyVisible, false);

    // Crucial integrity check: even while nearbyGroup.visible === false in publish mode,
    // collectPlacedItemColliders still sees existing sculpture bounds for non-overlap enforcement!
    const colliders = collectPlacedItemColliders(nearbyGroup);
    assert.equal(
      colliders.length,
      1,
      'Publish overlap guard must still collect colliders while nearbyGroup is visually hidden'
    );
    assert.equal(colliders[0].sculptureId, 'sc-other-land-art');
  });

  test('useARPreview hides nearbyGroup (other art & land prisms) immediately when entering Publish and restores on Draw', async () => {
    const { useARPreview } = await loadJsxModule('client/src/hooks/useARPreview.js');

    const nearbyGroup = new THREE.Group();
    const location = { lat: 37.7749, lng: -122.4194, altitude: 15 };
    const existingSculpture = {
      id: 'sc-neighbor-1',
      title: 'Existing Neighbor Sculpture',
      parcelId: 'GLAND-1',
      lat: 37.77492,
      lng: -122.41938,
      voxels: [{ x: 0, y: 0, z: 0, color: '#ff3e7f', material: 'matte', scale: 1 }]
    };

    let hookApi = null;
    function Harness({ mode, isolatePublishArt }) {
      const locationRef = React.useRef(location);
      const videoRef = React.useRef(null);
      const orbTrackerRef = React.useRef(null);
      const orbKeyframesRef = React.useRef(new Map());
      const orbPackCacheRef = React.useRef(new Map());
      const latestOrbProofRef = React.useRef(null);
      const nearbyGroupRef = React.useRef(nearbyGroup);
      const modeRef = React.useRef(mode);
      modeRef.current = mode;

      hookApi = useARPreview({
        mode,
        location,
        locationRef,
        cameraReady: true,
        videoRef,
        orbTrackerRef,
        orbKeyframesRef,
        orbPackCacheRef,
        latestOrbProofRef,
        setOrbStatus: () => {},
        nearbyGroupRef,
        modeRef,
        commitTransformAndExit: () => {},
        stopBrushPainting: () => {},
        showTemporaryHint: () => {},
        isolatePublishArt
      });
      return null;
    }

    const view = RTL.render(
      React.createElement(Harness, { mode: 'draw', isolatePublishArt: false })
    );

    await RTL.act(async () => {
      hookApi.setNearbySculptures([existingSculpture]);
    });

    assert.equal(nearbyGroup.visible, true, 'nearbyGroup should be visible during normal draw');
    assert.ok(
      nearbyGroup.children.length >= 1,
      'Expected existing neighbor sculpture mesh inside nearbyGroup during draw'
    );

    // 1) User swipes to Publish in the carousel (mode still draw, isolatePublishArt = true)
    await RTL.act(async () => {
      view.rerender(React.createElement(Harness, { mode: 'draw', isolatePublishArt: true }));
    });
    assert.equal(
      nearbyGroup.visible,
      false,
      'Selecting Publish tool must hide nearbyGroup (other art & land items)'
    );
    assert.equal(hookApi.visibleOtherItemsCount, 0);

    // 2) User opens Publish modal (mode = 'publish', isolatePublishArt = true)
    await RTL.act(async () => {
      view.rerender(React.createElement(Harness, { mode: 'publish', isolatePublishArt: true }));
    });
    assert.equal(
      nearbyGroup.visible,
      false,
      'Publish mode must keep nearbyGroup strictly hidden'
    );
    assert.equal(hookApi.visibleOtherItemsCount, 0);

    // 3) User closes Publish and returns to Draw (isolatePublishArt = false)
    await RTL.act(async () => {
      view.rerender(React.createElement(Harness, { mode: 'draw', isolatePublishArt: false }));
    });
    assert.equal(
      nearbyGroup.visible,
      true,
      'Exiting Publish back to Draw must restore nearbyGroup visibility'
    );

    view.unmount();
  });

  test('PublishSculptureModal displays isolated preview of ONLY user art or placed 3D model and enables publish for 3D-model-only placements', async () => {
    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );

    const baseProps = {
      config: { policy: { titleMax: 48, descriptionMax: 240, descriptionMaxWords: 45 } },
      user: {
        id: 'u-artist',
        email: 'artist@spray.land',
        activeMintRecipient: '0x1111111111111111111111111111111111111111'
      },
      polStats: { frames: 14, flow: 92 },
      location: { lat: 37.7749, lng: -122.4194, altitude: 18 },
      orbStatus: { features: 20, keyframes: 3 },
      activeTargetLand: {
        parcelId: 'GLAND-PLAZA',
        displayName: 'Neon Plaza',
        sculptures: [
          { id: 'other-1', title: 'Other Artist Tower' },
          { id: 'other-2', title: 'Someone Elses Dragon' }
        ]
      },
      passkeyCount: 1,
      passkeyBusy: false,
      title: 'My Fresh Piece',
      setTitle: () => {},
      description: 'Freshly sculpted on location.',
      setDescription: () => {},
      cluePrompt: '',
      setCluePrompt: () => {},
      clueAnswer: '',
      setClueAnswer: () => {},
      termsAccepted: true,
      setTermsAccepted: () => {},
      publishing: false,
      publishError: '',
      setPublishError: () => {},
      mintReceipt: null,
      mcpPairingsState: { mcpActive: false, activePairing: null },
      agentPublishPrompt: null,
      draftsBusy: false,
      draftStatusText: '',
      onSubmitPublish: (e) => e.preventDefault(),
      onCopyAgentPublishPrompt: () => {},
      onManualSaveDraft: () => {},
      onOpenInfo: () => {},
      onOpenPair: () => {},
      onOpenManageLand: () => {},
      onViewInARPreview: () => {},
      onShowHint: () => {},
      onClose: () => {}
    };

    // Case A: User painted voxels and isolated snapshot was captured
    const viewSnap = RTL.render(
      React.createElement(PublishSculptureModal, {
        ...baseProps,
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte', scale: 1 },
          { x: 0.05, y: 0.05, z: 0, color: '#ff3e7f', material: 'neon', scale: 1 }
        ],
        artPreviewUrl: 'data:image/png;base64,MY_ISOLATED_VOXEL_ART'
      })
    );
    const modalRoot = viewSnap.getByTestId('publish-sculpture-modal');
    assert.equal(modalRoot.getAttribute('data-publish-isolated'), 'true');
    const previewCard = viewSnap.getByTestId('publish-isolated-art-preview');
    assert.equal(previewCard.getAttribute('data-isolated-only'), 'true');
    assert.equal(previewCard.getAttribute('data-preview-kind'), 'snapshot');
    const previewImg = viewSnap.getByTestId('publish-art-preview-img');
    assert.equal(previewImg.getAttribute('src'), 'data:image/png;base64,MY_ISOLATED_VOXEL_ART');
    // Must NEVER display other sculptures on the land inside Publish view
    assert.equal(viewSnap.container.textContent.includes('Other Artist Tower'), false);
    assert.equal(viewSnap.container.textContent.includes('Someone Elses Dragon'), false);
    viewSnap.unmount();

    // Case B: User painted voxels without WebGL snapshot -> renders isolated isometric voxel SVG
    const viewIso = RTL.render(
      React.createElement(PublishSculptureModal, {
        ...baseProps,
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte', scale: 1 },
          { x: 0, y: 0.05, z: 0, color: '#ffd166', material: 'matte', scale: 1 }
        ],
        artPreviewUrl: ''
      })
    );
    assert.equal(
      viewIso.getByTestId('publish-isolated-art-preview').getAttribute('data-preview-kind'),
      'voxel-iso'
    );
    assert.ok(viewIso.getByTestId('publish-art-preview-voxel-svg'));
    viewIso.unmount();

    // Case C: User placed ONLY a 3D catalog model (0 voxels) -> shows placed model isolated preview AND submit button is enabled!
    const viewCatalogOnly = RTL.render(
      React.createElement(PublishSculptureModal, {
        ...baseProps,
        voxels: [],
        placedCatalogItem: {
          id: 'simready:neon-chair',
          title: 'Neon Cyber Chair',
          sourceName: 'SimReady Pile',
          modelFormat: 'glb',
          modelUrl: 'https://assets.spray.land/chair.glb',
          previewImageUrl: 'https://assets.spray.land/chair.png'
        },
        artPreviewUrl: ''
      })
    );
    const modelPreviewImg = viewCatalogOnly.getByTestId('publish-art-preview-img');
    assert.equal(modelPreviewImg.getAttribute('src'), 'https://assets.spray.land/chair.png');
    assert.ok(viewCatalogOnly.container.textContent.includes('Your Placed 3D Model'));
    const submitBtn = viewCatalogOnly.container.querySelector('button[type="submit"]');
    assert.ok(submitBtn, 'Expected Publish submit button');
    assert.equal(
      submitBtn.disabled,
      false,
      'Publish button MUST be enabled when a 3D catalog model is placed even with 0 voxels'
    );
    viewCatalogOnly.unmount();

    // Case D: Post-publish receipt retains isolated preview of newly published art
    const viewReceipt = RTL.render(
      React.createElement(PublishSculptureModal, {
        ...baseProps,
        voxels: [],
        artPreviewUrl: 'data:image/png;base64,RECEIPT_ISOLATED_ART',
        mintReceipt: {
          addedToExistingLand: true,
          landDisplayName: 'Neon Plaza',
          sculpture: {
            id: 'sc-new-1',
            title: 'My Fresh Piece',
            parcelId: 'GLAND-PLAZA',
            previewDataUrl: 'data:image/png;base64,RECEIPT_ISOLATED_ART'
          },
          mint: { tokenId: 42, txHash: '0xabc123' },
          ipfs: { metadataCid: 'bafy123' }
        }
      })
    );
    assert.equal(
      viewReceipt.getByTestId('publish-art-preview-img').getAttribute('src'),
      'data:image/png;base64,RECEIPT_ISOLATED_ART'
    );
    viewReceipt.unmount();
  });

  test('ARViewportCanvas, MobileStudio, and useVoxelBrush enforce publish isolation across scene, HUD, snapshot, and taps', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: ARViewportCanvas } = await loadJsxModule(
      'client/src/components/studio/ARViewportCanvas.jsx'
    );

    const commonViewportProps = {
      videoRef: { current: null },
      occlusionCanvasRef: { current: null },
      canvasHostRef: { current: null },
      rendererRef: { current: null },
      sceneRef: { current: null },
      cameraRef: { current: null },
      draftGroupRef: { current: null },
      nearbyGroupRef: { current: null },
      ghostMeshRef: { current: null },
      shadowPlaneRef: { current: null },
      gridHelperRef: { current: null },
      surfaceMarkerRef: { current: null },
      transformBoxRef: { current: null },
      originBeaconMatRef: { current: null },
      dirLightRef: { current: null },
      hemiLightRef: { current: null },
      envUpdaterRef: { current: null },
      draftUnitGeoRef: { current: null },
      draftMatCacheRef: { current: new Map() },
      draftMeshMapRef: { current: new Map() },
      polRef: { current: { getSceneCoverage: () => ({ optimal: true }) } },
      orbTrackerRef: { current: null },
      orbKeyframesRef: { current: new Map() },
      occlusionRef: { current: null },
      originStatusRef: { current: { originBlocked: false } },
      setOriginStatus: () => {},
      occlusionEnabled: true,
      occlusionEnabledRef: { current: true },
      rawOrientationRef: { current: null },
      yawOffsetRef: { current: 0 },
      fallbackEulerRef: { current: { pitch: 0, yaw: 0 } },
      wsRef: { current: null },
      locationRef: { current: null },
      arTargetedIdRef: { current: '' },
      setArTargetedSculpture: () => {},
      tool: 'brush',
      toolRef: { current: 'brush' },
      colorRef: { current: '#00f5d4' },
      voxelsRef: { current: [] },
      paintingRef: { current: false },
      lastPaintPosRef: { current: null },
      lastStackAtRef: { current: 0 },
      surfaceAnchorRef: { current: null },
      lastScanUiRef: { current: {} },
      lastUnmappedMaskRef: { current: '' },
      mappingCompletedNoticeShownRef: { current: false },
      setSceneScan: () => {},
      setUnmappedGrid: () => {},
      setOrbStatus: () => {},
      showTemporaryHint: () => {},
      cameraReady: true,
      sceneScanOptimal: false,
      calibrationReady: true,
      unmappedGrid: Array(48).fill(true),
      computeTargetVoxel: () => null,
      applyVoxelBatch: () => {},
      applyVoxelAction: () => {},
      eraseTargetVoxel: () => {},
      rebuildDraftMesh: () => {}
    };

    // 1) In publish mode: data-publish-isolated="true", and mapping grid / occlusion / center reticle are all suppressed
    const publishHtml = renderToStaticMarkup(
      React.createElement(ARViewportCanvas, {
        ...commonViewportProps,
        mode: 'publish',
        modeRef: { current: 'publish' },
        isolatePublishArt: true,
        isolatePublishArtRef: { current: true }
      })
    );
    assert.match(publishHtml, /data-publish-isolated="true"/);
    assert.equal(
      publishHtml.includes('mapping-grayscale-grid'),
      false,
      'Mapping grayscale grid must stay hidden in publish mode'
    );
    assert.equal(
      publishHtml.includes('occlusion-overlay'),
      false,
      'Occlusion overlay canvas must stay hidden in publish mode'
    );
    assert.equal(
      publishHtml.includes('tool-center-reticle'),
      false,
      'Center brush reticle must stay hidden in publish mode'
    );

    // 2) In draw mode with isolatePublishArt=true (carousel landed on Publish): also strictly isolated!
    const carouselPublishHtml = renderToStaticMarkup(
      React.createElement(ARViewportCanvas, {
        ...commonViewportProps,
        mode: 'draw',
        modeRef: { current: 'draw' },
        isolatePublishArt: true,
        isolatePublishArtRef: { current: true }
      })
    );
    assert.match(carouselPublishHtml, /data-publish-isolated="true"/);
    assert.equal(carouselPublishHtml.includes('tool-center-reticle'), false);
    assert.equal(carouselPublishHtml.includes('occlusion-overlay'), false);

    // 3) In regular draw mode (isolatePublishArt=false): data-publish-isolated="false" and draw overlays render normally
    const drawHtml = renderToStaticMarkup(
      React.createElement(ARViewportCanvas, {
        ...commonViewportProps,
        mode: 'draw',
        modeRef: { current: 'draw' },
        isolatePublishArt: false,
        isolatePublishArtRef: { current: false }
      })
    );
    assert.match(drawHtml, /data-publish-isolated="false"/);
    assert.ok(drawHtml.includes('occlusion-overlay'));

    // Verify source-level wiring across ARViewportCanvas, MobileStudio, and useVoxelBrush
    const viewportSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(viewportSrc, /nearbyGroup\.visible\s*=\s*!isPublishIsolatedFrame/);
    assert.match(viewportSrc, /draftGroup\.visible\s*=\s*isPublishIsolatedFrame\s*\?\s*true/);
    assert.match(viewportSrc, /grid\.visible\s*=\s*!arViewOnly && !isPublishIsolatedFrame/);
    assert.match(viewportSrc, /if \(arViewOnly \|\| isPublishIsolatedFrame\)\s*\{\s*transformBox\.visible\s*=\s*false/);

    const mobileStudioSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    assert.match(mobileStudioSrc, /shouldIsolatePublishArtView\(/);
    assert.match(mobileStudioSrc, /captureIsolatedDraftSnapshot\(/);
    assert.match(mobileStudioSrc, /artPreviewUrl=\{publishPreviewUrl\}/);
    assert.match(mobileStudioSrc, /catalogSearchOpen \|\| drafts\.agentOpen \|\| brush\.mode === 'publish'/);

    const brushSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useVoxelBrush.js'),
      'utf8'
    );
    assert.match(brushSrc, /nearbyGroup\.visible\s*!==\s*false/);
  });
});
