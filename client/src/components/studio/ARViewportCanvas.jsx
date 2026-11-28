import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../../shared/chatPolicy.mjs';
import {
  advanceFluidSprayPoint,
  buildConnectedVoxelPath,
  buildSmoothSplineVoxelPath,
  getVoxelCellStep,
  normalizeBlockScale,
  snapPointToVoxelLattice
} from '../../../../shared/voxelStroke.mjs';
import SceneErrorBoundary from '../SceneErrorBoundary.jsx';
import {
  createLiveEnvUpdater,
  deviceOrientationToQuaternion,
  disposeObject3D,
  VOXEL_STEP
} from '../VoxelEngine3D.js';
import { updateThreeWireframeDepthFade } from '../../utils/prismDepthFade.js';
import { filterStrokeAgainstPlacedItems } from '../../utils/arItemCollision.js';
import { createObjectTransformGizmo } from '../../utils/arTransformGizmo3D.js';
import {
  applyProximitySharpnessToObject3D,
  blendHexWithAtmosphericHaze,
  computeArLandCameraGuidance,
  computeProximitySharpness,
  DEFAULT_ATMOSPHERIC_HAZE_HEX
} from '../../utils/arLandGuidance.js';
import { estimateCameraVerticalFovDeg } from '../../utils/arSensorFusion.js';
import { resolveRelativeOrbBucket } from '../../utils/arCalibrationManager.js';
import {
  computeApproachedLandOpacityProfile,
  computeLiveLandEdgeDistanceMeters,
  createWalkingApproachTracker,
  stepWalkingApproachTracker
} from '../../utils/arWalkingApproach.js';
import { tryLockPortraitOrientation } from '../../utils/mobilePortraitLock.js';
import { startWebXrArSession } from '../../utils/webxrArSession.js';
import XeroIcon from '../XeroIcon.jsx';
import ToolCenterReticle from './ToolCenterReticle.jsx';

/**
 * Manages the transparent Three.js WebGL overlay, camera background video,
 * mapping grayscale grid, foreground occlusion canvas, WebGL context-lost recovery,
 * and SceneErrorBoundary isolation.
 */
function ARViewportCanvasInner({
  videoRef,
  occlusionCanvasRef,
  canvasHostRef,
  rendererRef,
  sceneRef,
  cameraRef,
  draftGroupRef,
  nearbyGroupRef,
  ghostMeshRef,
  shadowPlaneRef,
  gridHelperRef,
  surfaceMarkerRef,
  transformBoxRef,
  originBeaconMatRef,
  dirLightRef,
  hemiLightRef,
  envUpdaterRef,
  draftUnitGeoRef,
  draftMatCacheRef,
  draftMeshMapRef,
  polRef,
  orbTrackerRef,
  orbKeyframesRef,
  occlusionRef,
  originStatusRef,
  setOriginStatus,
  occlusionEnabled = false,
  occlusionEnabledRef,
  rawOrientationRef,
  yawOffsetRef,
  draftYawOffsetRef = null,
  orientationFusionRef = null,
  positionFilterRef = null,
  spatialDrawTrackerRef = null,
  reachRef = null,
  webxrActive = false,
  webxrControllerRef = null,
  onWebxrStateChange = null,
  fallbackEulerRef,
  wsRef,
  locationRef,
  arTargetedIdRef,
  setArTargetedSculpture,
  arSelectedLandIdRef = null,
  isInteractingWithLand = false,
  isInteractingWithLandRef = null,
  isArViewOnly = false,
  isArViewOnlyRef = null,
  renderPaused = false,
  cameraHidden = false,
  mode,
  modeRef,
  tool = 'brush',
  toolRef,
  blockSize = 1,
  blockSizeRef = null,
  color = '#00f5d4',
  colorRef,
  reachMeters = 1.8,
  surfaceAnchor = null,
  painting = false,
  voxelsRef,
  paintingRef,
  strokeDeviceOriginRef = null,
  lastPaintPosRef,
  lastStackAtRef,
  surfaceAnchorRef,
  lastScanUiRef,
  lastUnmappedMaskRef,
  mappingCompletedNoticeShownRef,
  mappingPausedRef = null,
  backgroundCalibrationActiveRef = null,
  walkingApproachRef = null,
  mappingRestartRequired = false,
  setSceneScan,
  setUnmappedGrid,
  setOrbStatus,
  showTemporaryHint,
  cameraReady,
  sceneScanOptimal,
  calibrationReady = true,
  unmappedGrid,
  onVideoMounted = null,
  onCameraRefreshNeeded = null,
  onArLandGuidance = null,
  fadeOtherItemsRef = null,
  isolatePublishArt = false,
  isolatePublishArtRef = null,
  atmosphericTintRef = null,
  getActivePlacedItemColliders = null,
  notifyBlockedByPlacedItem = null,
  computeTargetVoxel,
  applyVoxelBatch,
  applyVoxelAction,
  eraseTargetVoxel,
  rebuildDraftMesh,
  onCanvasPointerDown,
  onCanvasPointerMove,
  onCanvasPointerUp,
  onCanvasPointerCancel,
  onSetCenterSurface = null,
  onUnlockCenterSurface = null,
  onDrawAtCenter = null,
  onStartCenterBrushHold = null,
  onStopCenterBrushHold = null,
  onRequestContextRecover = null
}) {
  const [contextLost, setContextLost] = useState(false);
  const contextLostRef = useRef(false);
  const needsRemountOnResumeRef = useRef(false);
  const contextRecoverTimerRef = useRef(null);
  const resumeLoopRef = useRef(null);
  const onRequestContextRecoverRef = useRef(onRequestContextRecover);
  onRequestContextRecoverRef.current = onRequestContextRecover;
  const webxrActivePropRef = useRef(Boolean(webxrActive));
  webxrActivePropRef.current = Boolean(webxrActive);

  // Keep html/body transparent while WebXR immersive-ar DOM overlay is active so the
  // hardware ARCore camera passthrough and Three.js WebXR 3D layer are never covered!
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    if (webxrActive) {
      htmlEl?.classList?.add('webxr-ar-active');
      bodyEl?.classList?.add('webxr-ar-active');
    } else {
      htmlEl?.classList?.remove('webxr-ar-active');
      bodyEl?.classList?.remove('webxr-ar-active');
    }
    return () => {
      htmlEl?.classList?.remove('webxr-ar-active');
      bodyEl?.classList?.remove('webxr-ar-active');
    };
  }, [webxrActive]);
  const isTransformMode = mode === 'transform';
  const isPublishIsolated = Boolean(mode === 'publish' || isolatePublishArt);
  const localIsolatePublishRef = useRef(isPublishIsolated);
  localIsolatePublishRef.current = isPublishIsolated;
  const effectiveRenderPaused = Boolean(renderPaused || cameraHidden);
  const renderPausedRef = useRef(effectiveRenderPaused);
  renderPausedRef.current = effectiveRenderPaused;
  const cameraHiddenRef = useRef(Boolean(cameraHidden));
  cameraHiddenRef.current = Boolean(cameraHidden);
  const wasCameraHiddenRef = useRef(Boolean(cameraHidden));
  const sceneScanOptimalRef = useRef(Boolean(sceneScanOptimal));
  sceneScanOptimalRef.current = Boolean(sceneScanOptimal);
  const calibrationReadyRef = useRef(Boolean(calibrationReady));
  calibrationReadyRef.current = Boolean(calibrationReady);
  const hasCapturedEnvRef = useRef(false);
  const onCameraRefreshNeededRef = useRef(onCameraRefreshNeeded);
  const onArLandGuidanceRef = useRef(onArLandGuidance);

  useEffect(() => {
    onCameraRefreshNeededRef.current = onCameraRefreshNeeded;
    onArLandGuidanceRef.current = onArLandGuidance;
  }, [onCameraRefreshNeeded, onArLandGuidance]);

  useEffect(() => {
    onVideoMounted?.();
  }, [onVideoMounted]);

  useEffect(() => {
    const occlusionActive = !isArViewOnly && !isTransformMode && occlusionEnabled;
    if (!occlusionActive) {
      occlusionRef.current?.reset?.();
      const occ = occlusionCanvasRef.current;
      if (occ) {
        const ctx = occ.getContext?.('2d');
        ctx?.clearRect?.(0, 0, occ.width, occ.height);
      }
      if (originStatusRef.current?.originBlocked) {
        const clearStatus = { originBlocked: false, originVisible: true, reason: '' };
        originStatusRef.current = clearStatus;
        setOriginStatus?.(clearStatus);
      }
      return;
    }
    const host = canvasHostRef.current;
    const occ = occlusionCanvasRef.current;
    if (host && occ) {
      const occW = Math.min(280, Math.max(96, host.clientWidth));
      const occH = Math.max(
        96,
        Math.round((occW * host.clientHeight) / Math.max(1, host.clientWidth))
      );
      occ.width = occW;
      occ.height = occH;
    }
  }, [
    canvasHostRef,
    isArViewOnly,
    isTransformMode,
    occlusionCanvasRef,
    occlusionEnabled,
    occlusionRef,
    originStatusRef,
    setOriginStatus
  ]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return undefined;
    const draftMatCache = draftMatCacheRef.current;
    const draftMeshMap = draftMeshMapRef.current;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      68,
      Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
      0.05,
      320
    );
    camera.position.set(0, 0.4, 2.2);

    // Dedicated parent rig + render camera for WebXR immersive-ar so Three.js WebXRManager
    // transforms the raw ARCore viewer pose directly into our True-North world coordinates
    // without clobbering `camera` (used by raycasting, voxel brush, and land alignment).
    const xrRig = new THREE.Group();
    xrRig.name = 'webxr-world-rig';
    const xrRenderCamera = new THREE.PerspectiveCamera(
      68,
      Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
      0.05,
      320
    );
    xrRig.add(xrRenderCamera);
    scene.add(xrRig);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);

    const onContextLost = (ev) => {
      ev.preventDefault();
      contextLostRef.current = true;
      setContextLost(true);
      clearTimeout(contextRecoverTimerRef.current);
      if (renderPausedRef.current) {
        // Silently defer recovery until user returns from map/modal to AR view
        needsRemountOnResumeRef.current = true;
        return;
      }
      contextRecoverTimerRef.current = setTimeout(() => {
        if (!renderPausedRef.current && contextLostRef.current) {
          onRequestContextRecoverRef.current?.();
        }
      }, 900);
    };
    const onContextRestored = () => {
      clearTimeout(contextRecoverTimerRef.current);
      contextLostRef.current = false;
      needsRemountOnResumeRef.current = false;
      setContextLost(false);
      resumeLoopRef.current?.();
      onCameraRefreshNeededRef.current?.({ reason: 'webgl_restored', force: true });
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false);

    const envUpdater = createLiveEnvUpdater(renderer);
    envUpdaterRef.current = envUpdater;

    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.85);
    scene.add(hemiLight);
    hemiLightRef.current = hemiLight;

    const initArViewOnly = Boolean(
      isArViewOnlyRef?.current || isInteractingWithLandRef?.current || modeRef.current === 'preview'
    );

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.45);
    dirLight.position.set(4, 8, 3);
    dirLight.castShadow = !initArViewOnly;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 48;
    const shadowBound = 18;
    dirLight.shadow.camera.left = -shadowBound;
    dirLight.shadow.camera.right = shadowBound;
    dirLight.shadow.camera.top = shadowBound;
    dirLight.shadow.camera.bottom = -shadowBound;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
    scene.add(dirLight.target);
    dirLightRef.current = dirLight;

    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.ShadowMaterial({ opacity: 0.44 })
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.8;
    shadowCatcher.receiveShadow = true;
    shadowCatcher.visible = !initArViewOnly;
    scene.add(shadowCatcher);
    shadowPlaneRef.current = shadowCatcher;

    const grid = new THREE.GridHelper(6, 30, 0x00f5d4, 0x26324d);
    grid.position.y = -0.805;
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    grid.visible = !initArViewOnly;
    scene.add(grid);
    gridHelperRef.current = grid;

    const surfaceMarker = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.13, 0.165, 36);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.z = 0.004;
    surfaceMarker.add(ringMesh);

    const dotGeo = new THREE.CircleGeometry(0.026, 20);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95
    });
    const dotMesh = new THREE.Mesh(dotGeo, dotMat);
    dotMesh.position.z = 0.005;
    surfaceMarker.add(dotMesh);

    const footGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(VOXEL_STEP * 1.06, VOXEL_STEP * 1.06, VOXEL_STEP * 1.06)
    );
    const footMat = new THREE.LineBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.85
    });
    const footWire = new THREE.LineSegments(footGeo, footMat);
    footWire.position.z = VOXEL_STEP * 0.53;
    surfaceMarker.add(footWire);

    const stemGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.09, 8);
    const stemMesh = new THREE.Mesh(stemGeo, ringMat);
    stemMesh.rotation.x = Math.PI / 2;
    stemMesh.position.z = 0.045;
    surfaceMarker.add(stemMesh);

    surfaceMarker.visible = false;
    scene.add(surfaceMarker);
    surfaceMarkerRef.current = surfaceMarker;
    originBeaconMatRef.current = { ringMat, dotMat, footMat };

    const draftGroup = new THREE.Group();
    const nearbyGroup = new THREE.Group();
    // Anchor nearbyGroup horizontally on the camera's physical GPS origin so all <300 ft
    // lands & sculptures appear at exact 1:1 world-meter perspective in all directions (N/S/E/W).
    nearbyGroup.position.set(camera.position.x, 0, camera.position.z);
    scene.add(draftGroup);
    scene.add(nearbyGroup);

    const transformBox = createObjectTransformGizmo();
    transformBox.visible = false;
    scene.add(transformBox.group);
    transformBoxRef.current = transformBox;

    const ghostGeo = new THREE.BoxGeometry(VOXEL_STEP, VOXEL_STEP, VOXEL_STEP);
    const ghostMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      wireframe: true,
      transparent: true,
      opacity: 0.85
    });
    const ghost = new THREE.Mesh(ghostGeo, ghostMat);
    scene.add(ghost);

    // Pre-allocated pool of subtle open-space outlines around placed blocks (Pencil / Stack)
    const neighborSlotEdgeGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(VOXEL_STEP * 0.92, VOXEL_STEP * 0.92, VOXEL_STEP * 0.92)
    );
    const neighborSlotMat = new THREE.LineBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.32
    });
    const neighborSlotPool = Array.from({ length: 6 }, () => {
      const seg = new THREE.LineSegments(neighborSlotEdgeGeo, neighborSlotMat);
      seg.visible = false;
      scene.add(seg);
      return seg;
    });

    // Lightweight 3D spray-can mist stream while actively spraying with Brush
    const SPRAY_MIST_COUNT = 18;
    const sprayMistPositions = new Float32Array(SPRAY_MIST_COUNT * 3);
    const sprayMistGeo = new THREE.BufferGeometry();
    sprayMistGeo.setAttribute('position', new THREE.BufferAttribute(sprayMistPositions, 3));
    const sprayMistMat = new THREE.PointsMaterial({
      color: 0x00f5d4,
      size: 0.026,
      transparent: true,
      opacity: 0.72,
      depthWrite: false
    });
    const sprayMist = new THREE.Points(sprayMistGeo, sprayMistMat);
    sprayMist.visible = false;
    sprayMist.frustumCulled = false;
    scene.add(sprayMist);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    draftGroupRef.current = draftGroup;
    nearbyGroupRef.current = nearbyGroup;
    ghostMeshRef.current = ghost;
    if (voxelsRef.current?.length) {
      rebuildDraftMesh(voxelsRef.current);
    }

    const syncLiveLensFov = () => {
      if (!host) return;
      const vid = videoRef?.current;
      const track = vid?.srcObject?.getVideoTracks?.()?.[0] || null;
      const nextFov = estimateCameraVerticalFovDeg({
        videoTrack: track,
        videoWidth: vid?.videoWidth || 0,
        videoHeight: vid?.videoHeight || 0,
        viewportWidth: host.clientWidth,
        viewportHeight: host.clientHeight
      });
      if (Math.abs(camera.fov - nextFov) >= 0.4) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }
    };

    let activeXrSession = null;
    const resizeSettleTimers = new Set();
    const handleResize = () => {
      if (!host || activeXrSession) return;
      const w = host.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
      const h = host.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
      if (w < 10 || h < 10) return;
      camera.aspect = w / h;
      syncLiveLensFov();
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (occlusionCanvasRef.current) {
        const occW = Math.min(280, Math.max(96, w));
        const occH = Math.max(96, Math.round((occW * h) / Math.max(1, w)));
        occlusionCanvasRef.current.width = occW;
        occlusionCanvasRef.current.height = occH;
      }
    };
    const handleViewportOrFullscreenTransition = () => {
      handleResize();
      const vid = videoRef?.current;
      if (
        vid &&
        !cameraHiddenRef.current &&
        !activeXrSession &&
        vid.srcObject &&
        vid.paused &&
        typeof vid.play === 'function'
      ) {
        vid.play().catch(() => {});
      }
      for (const delayMs of [140, 380]) {
        const tid = setTimeout(() => {
          resizeSettleTimers.delete(tid);
          handleResize();
        }, delayMs);
        resizeSettleTimers.add(tid);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleViewportOrFullscreenTransition);
    window.visualViewport?.addEventListener?.('resize', handleResize);
    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', handleViewportOrFullscreenTransition);
      document.addEventListener('webkitfullscreenchange', handleViewportOrFullscreenTransition);
    }

    let rafId = 0;
    let lastFrameAt = performance.now();
    let spraySmoothPos = null;
    let strokeControlPos = null;
    let lastWsPush = 0;
    let lastEnvPush = 0;
    let lastOcclusionPush = 0;
    let lastTargetCheck = 0;
    let lastScanPosePush = 0;
    let lastOrbExtractPush = 0;
    let lastGuidancePush = 0;
    let lastGuidanceKey = '';
    let lastFovCheck = 0;
    let lastPixelRatio = renderer.getPixelRatio();
    let lastCanvasFilter = '';
    let orbExtractBusy = false;
    const walkingTracker = createWalkingApproachTracker();
    const maxAnisotropy = Math.min(16, renderer.capabilities?.getMaxAnisotropy?.() || 8);
    const fusedQuat = new THREE.Quaternion();
    const baseCameraPos = { x: 0, y: 0.4, z: 2.2 };
    const scanFwdVec = new THREE.Vector3();
    const sprayFwdVec = new THREE.Vector3();
    const sprayUpVec = new THREE.Vector3();
    const sprayRightVec = new THREE.Vector3();
    const sprayNozzleVec = new THREE.Vector3();
    const originProjVec = new THREE.Vector3();
    const guidanceTargetWorld = new THREE.Vector3();
    const targetRay = new THREE.Raycaster();
    const centerNdc = new THREE.Vector2(0, 0);

    const renderFrame = (xrFrame = null) => {
      const now = performance.now();
      const dtMs = Math.max(4, Math.min(80, now - lastFrameAt));
      lastFrameAt = now;

      // Pause heavy GPU rendering & video-to-texture uploads while fullscreen map/modals cover AR view
      // so mobile browsers have full GPU headroom for MapLibre 3D maps & Three.js sculpture layers.
      if (
        !activeXrSession &&
        (renderPausedRef.current ||
          (typeof document !== 'undefined' && document.visibilityState === 'hidden'))
      ) {
        return;
      }

      if (!activeXrSession && now - lastFovCheck > 1800) {
        lastFovCheck = now;
        syncLiveLensFov();
      }

      if (activeXrSession) {
        // Keep XR framebuffer strictly transparent so hardware ARCore camera passthrough shows cleanly.
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
        renderer.setClearAlpha(0);
        // Lock nearbyGroup cleanly to world origin; ARCore 6-DoF handles all physical parallax with zero slip.
        nearbyGroup.position.set(baseCameraPos.x, 0, baseCameraPos.z);
        if (xrFrame) {
          const xrWorldPose = activeXrSession.processFrame(xrFrame, baseCameraPos);
          if (xrWorldPose) {
            if (xrWorldPose.rigPosition && xrWorldPose.rigQuaternion) {
              xrRig.position.copy(xrWorldPose.rigPosition);
              xrRig.quaternion.copy(xrWorldPose.rigQuaternion);
              xrRig.updateMatrixWorld(true);
            }
            camera.position.copy(xrWorldPose.position);
            camera.quaternion.copy(xrWorldPose.quaternion);
            if (
              Array.isArray(xrWorldPose.projectionMatrix) &&
              xrWorldPose.projectionMatrix.length === 16
            ) {
              camera.projectionMatrix.fromArray(xrWorldPose.projectionMatrix);
              camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
              const m5 = camera.projectionMatrix.elements[5];
              if (Number.isFinite(m5) && Math.abs(m5) > 0.001) {
                camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(1 / Math.abs(m5)));
              }
            }
          }
        }
      } else if (orientationFusionRef?.current?.initialized) {
        orientationFusionRef.current.getCameraQuaternion(fusedQuat);
        camera.quaternion.slerp(fusedQuat, 0.78);
      } else if (rawOrientationRef.current) {
        const { alpha, beta, gamma } = rawOrientationRef.current;
        const screenAngle = window.screen?.orientation?.angle || 0;
        const q = deviceOrientationToQuaternion(
          alpha - yawOffsetRef.current,
          beta,
          gamma,
          screenAngle
        );
        camera.quaternion.slerp(q, 0.68);
      } else {
        const euler = new THREE.Euler(
          fallbackEulerRef.current.pitch,
          fallbackEulerRef.current.yaw,
          0,
          'YXZ'
        );
        camera.quaternion.setFromEuler(euler);
      }

      // Keep placed artwork strictly anchored in True-North world space (only allow local
      // Recenter yaw offset while canvas is empty so existing art never drags/spins with phone).
      if (modeRef.current !== 'transform' && draftYawOffsetRef) {
        if (!voxelsRef.current?.length) {
          draftGroup.rotation.y = draftYawOffsetRef.current || 0;
        } else if (draftGroup.rotation.y !== 0) {
          draftGroup.rotation.y = 0;
          draftYawOffsetRef.current = 0;
        }
      }

      // 6-DoF World-Anchored Spatial Camera Translation (when WebXR is not driving pose):
      // In Review / Inspect / View-Only modes, freeze noisy monocular VIO `localOffset` and
      // stationary GPS jitter so items inside a land stay rock-solid still. Only run monocular
      // VIO while actively drawing so strokes track hand motion without making land items slip.
      if (!activeXrSession) {
        const spatial = spatialDrawTrackerRef?.current;
        const pf = positionFilterRef?.current;
        const isViewingMode = Boolean(
          modeRef.current === 'preview' ||
            isArViewOnlyRef?.current ||
            isInteractingWithLandRef?.current
        );
        const isActivelyWalking = Boolean(walkingApproachRef?.current?.isWalking);
        const subDelta =
          isActivelyWalking && pf?.initialized && locationRef.current
            ? pf.getLiveSubmeterDeltaMeters(locationRef.current)
            : { east: 0, north: 0 };

        if (spatial) {
          if (pf?.initialized) {
            spatial.updateFromKalmanWalk({
              east: pf.east,
              north: pf.north,
              speedMps: pf.lastSpeed || 0,
              dtSec: dtMs / 1000
            });
          }
          if (!isViewingMode && modeRef.current === 'draw' && videoRef.current) {
            const activeDepthM =
              surfaceAnchorRef.current?.locked && Number(surfaceAnchorRef.current?.depthM) > 0
                ? Number(surfaceAnchorRef.current.depthM)
                : Number(reachRef?.current || 1.8);
            spatial.updateFromVideoElement({
              videoEl: videoRef.current,
              cameraQuat: camera.quaternion,
              vFovDeg: camera.fov,
              aspect: camera.aspect,
              depthMeters: activeDepthM,
              nowMs: now
            });
            spatial.getWorldCameraPosition(baseCameraPos, camera.position);
            const nearbyPos = spatial.getNearbyGroupPosition(baseCameraPos, subDelta);
            nearbyGroup.position.set(nearbyPos.x, nearbyPos.y, nearbyPos.z);
          } else {
            const walkX = Number(spatial.walkOffset?.x) || 0;
            const walkZ = Number(spatial.walkOffset?.z) || 0;
            camera.position.set(baseCameraPos.x + walkX, baseCameraPos.y, baseCameraPos.z + walkZ);
            nearbyGroup.position.set(baseCameraPos.x + walkX, 0, baseCameraPos.z + walkZ);
          }
        } else {
          camera.position.set(baseCameraPos.x, baseCameraPos.y, baseCameraPos.z);
          nearbyGroup.position.set(
            camera.position.x - subDelta.east,
            0,
            camera.position.z + subDelta.north
          );
        }
      }

      // Ensure camera world matrix is 100% current before raycasting / computeTargetVoxel
      camera.updateMatrixWorld(true);

      // Keep ground reference grid snapped to fixed 1m world lines and directional shadows
      // tracking the user's current position in BOTH WebXR 6-DoF and standard AR modes.
      if (!surfaceAnchorRef.current) {
        grid.position.set(Math.round(camera.position.x), -0.805, Math.round(camera.position.z));
        shadowCatcher.position.set(camera.position.x, -0.8, camera.position.z);
      }
      dirLight.target.position.set(camera.position.x, 0, camera.position.z - 1.6);
      dirLight.target.updateMatrixWorld();

      const interactingLand = Boolean(isInteractingWithLandRef?.current);
      const arViewOnly = Boolean(
        isArViewOnlyRef?.current || interactingLand || modeRef.current === 'preview'
      );
      const isPublishIsolatedFrame = Boolean(
        modeRef.current === 'publish' ||
          isolatePublishArtRef?.current ||
          localIsolatePublishRef.current
      );
      const isCalibratedForDraw = Boolean(calibrationReadyRef.current);
      const showCursor =
        !isPublishIsolatedFrame &&
        !arViewOnly &&
        modeRef.current === 'draw' &&
        !interactingLand &&
        isCalibratedForDraw;
      nearbyGroup.visible = !isPublishIsolatedFrame;
      ghost.visible = showCursor;
      grid.visible = !arViewOnly && !isPublishIsolatedFrame;
      shadowCatcher.visible = !arViewOnly && !isPublishIsolatedFrame;
      dirLight.castShadow = !arViewOnly && !isPublishIsolatedFrame;
      draftGroup.visible = isPublishIsolatedFrame ? true : !interactingLand;
      if (arViewOnly || isPublishIsolatedFrame) {
        transformBox.visible = false;
      }
      for (let i = 0; i < neighborSlotPool.length; i += 1) {
        neighborSlotPool[i].visible = false;
      }
      sprayMist.visible = false;
      let latestTarget = null;

      if (!paintingRef.current || toolRef.current !== 'brush') {
        spraySmoothPos = null;
        strokeControlPos = null;
      }

      if (showCursor) {
        const curBlockScale = normalizeBlockScale(blockSizeRef?.current ?? 1);
        const curCellStep = getVoxelCellStep(VOXEL_STEP, curBlockScale);
        const target = computeTargetVoxel(paintingRef.current);
        latestTarget = target;

        // Render subtle outlines of potential empty spaces around placed blocks (Pencil & Stack)
        if (
          target &&
          Array.isArray(target.nearbySlots) &&
          target.nearbySlots.length > 0 &&
          (toolRef.current === 'pencil' || toolRef.current === 'stack')
        ) {
          neighborSlotMat.color.set(colorRef.current);
          const count = Math.min(neighborSlotPool.length, target.nearbySlots.length);
          for (let i = 0; i < count; i += 1) {
            const slot = target.nearbySlots[i];
            const seg = neighborSlotPool[i];
            seg.position.set(slot.x, slot.y, slot.z);
            seg.scale.setScalar(normalizeBlockScale(slot.scale ?? curBlockScale));
            seg.visible = true;
          }
        }

        if (target && target.action === 'blocked') {
          ghost.position.set(target.x, target.y, target.z);
          ghost.scale.setScalar(normalizeBlockScale(target.scale ?? curBlockScale));
          ghost.material.color.set(0xff2d55);
          spraySmoothPos = null;
          strokeControlPos = null;
          lastPaintPosRef.current = null;
          if (paintingRef.current) {
            notifyBlockedByPlacedItem?.({
              reason: target.blockedReason || 'overlap',
              title: target.blockedByTitle || 'existing art'
            });
          }
        } else if (target && target.action === 'replace') {
          const pulse = 1.07 + 0.04 * Math.sin(now * 0.012);
          const repScale = Math.max(
            curBlockScale,
            normalizeBlockScale(target.replacedVoxel?.scale ?? curBlockScale)
          );
          ghost.position.set(target.x, target.y, target.z);
          ghost.scale.setScalar(repScale * pulse);
          ghost.material.color.set(
            originStatusRef.current.originBlocked ? 0xff3e7f : colorRef.current
          );
        } else if (target && target.action === 'add') {
          const isActiveSprayBrush = paintingRef.current && toolRef.current === 'brush';
          let strokeTarget = target;

          if (isActiveSprayBrush) {
            const rawPt = target.rawPoint || target;
            spraySmoothPos = advanceFluidSprayPoint(spraySmoothPos, rawPt, {
              dtMs,
              cellStep: curCellStep
            });
            const snapped = snapPointToVoxelLattice(spraySmoothPos, VOXEL_STEP, curBlockScale);
            strokeTarget = {
              ...target,
              x: snapped.x,
              y: snapped.y,
              z: snapped.z,
              scale: snapped.scale
            };
            ghost.position.set(spraySmoothPos.x, spraySmoothPos.y, spraySmoothPos.z);

            // Animate spray-can mist stream from nozzle toward live tip
            sprayFwdVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
            sprayUpVec.set(0, 1, 0).applyQuaternion(camera.quaternion);
            sprayRightVec.set(1, 0, 0).applyQuaternion(camera.quaternion);
            sprayNozzleVec
              .copy(camera.position)
              .addScaledVector(sprayFwdVec, 0.34)
              .addScaledVector(sprayUpVec, -0.14);
            const mistSpread = curCellStep * 0.68;
            const phaseBase = (now * 0.0045) % 1;
            for (let i = 0; i < SPRAY_MIST_COUNT; i += 1) {
              const frac = (i / SPRAY_MIST_COUNT + phaseBase) % 1;
              const cone = frac * mistSpread;
              const ang = i * 2.39996 + now * 0.014;
              const px =
                sprayNozzleVec.x +
                (spraySmoothPos.x - sprayNozzleVec.x) * frac +
                (sprayRightVec.x * Math.cos(ang) + sprayUpVec.x * Math.sin(ang)) * cone;
              const py =
                sprayNozzleVec.y +
                (spraySmoothPos.y - sprayNozzleVec.y) * frac +
                (sprayRightVec.y * Math.cos(ang) + sprayUpVec.y * Math.sin(ang)) * cone;
              const pz =
                sprayNozzleVec.z +
                (spraySmoothPos.z - sprayNozzleVec.z) * frac +
                (sprayRightVec.z * Math.cos(ang) + sprayUpVec.z * Math.sin(ang)) * cone;
              sprayMistPositions[i * 3] = px;
              sprayMistPositions[i * 3 + 1] = py;
              sprayMistPositions[i * 3 + 2] = pz;
            }
            sprayMistGeo.attributes.position.needsUpdate = true;
            sprayMistMat.color.set(colorRef.current);
            sprayMist.visible = true;
          } else {
            ghost.position.set(target.x, target.y, target.z);
          }

          ghost.scale.setScalar(normalizeBlockScale(strokeTarget.scale ?? curBlockScale));
          ghost.material.color.set(
            originStatusRef.current.originBlocked ? 0xff3e7f : colorRef.current
          );

          if (paintingRef.current && (toolRef.current === 'brush' || toolRef.current === 'stack')) {
            const prev = lastPaintPosRef.current;
            const selfStackBlocked =
              toolRef.current === 'stack' &&
              prev &&
              target.stackedFrom &&
              Math.hypot(
                target.stackedFrom.x - prev.x,
                target.stackedFrom.y - prev.y,
                target.stackedFrom.z - prev.z
              ) <
                curCellStep * 0.5 &&
              now - lastStackAtRef.current < 145;

            if (!selfStackBlocked) {
              const placedColliders = getActivePlacedItemColliders ? getActivePlacedItemColliders() : [];
              if (!prev) {
                const startStep = buildConnectedVoxelPath(null, strokeTarget, {
                  step: VOXEL_STEP,
                  blockScale: curBlockScale
                });
                const filtered = filterStrokeAgainstPlacedItems({
                  prevPoint: null,
                  pathPoints: startStep.path,
                  voxelStep: VOXEL_STEP,
                  rayOrigin: camera.position,
                  colliders: placedColliders
                });
                if (filtered.allowed.length > 0) {
                  lastPaintPosRef.current = filtered.blocked
                    ? null
                    : filtered.allowed[filtered.allowed.length - 1];
                  strokeControlPos = filtered.blocked
                    ? null
                    : { x: strokeTarget.x, y: strokeTarget.y, z: strokeTarget.z };
                  lastStackAtRef.current = now;
                  applyVoxelBatch(filtered.allowed);
                }
                if (filtered.blocked) {
                  lastPaintPosRef.current = null;
                  spraySmoothPos = null;
                  strokeControlPos = null;
                  notifyBlockedByPlacedItem?.(filtered.blockedBy);
                }
              } else {
                const stroke =
                  toolRef.current === 'brush'
                    ? buildSmoothSplineVoxelPath(prev, strokeTarget, {
                        controlPoint: strokeControlPos,
                        step: VOXEL_STEP,
                        blockScale: curBlockScale,
                        maxSteps: 256
                      })
                    : buildConnectedVoxelPath(prev, strokeTarget, {
                        step: VOXEL_STEP,
                        blockScale: curBlockScale,
                        maxSteps: 256
                      });
                const filtered = filterStrokeAgainstPlacedItems({
                  prevPoint: prev,
                  pathPoints: stroke.path,
                  voxelStep: VOXEL_STEP,
                  rayOrigin: camera.position,
                  colliders: placedColliders
                });
                if (filtered.allowed.length > 0) {
                  lastPaintPosRef.current = filtered.blocked
                    ? null
                    : filtered.allowed[filtered.allowed.length - 1];
                  strokeControlPos = filtered.blocked
                    ? null
                    : {
                        x: (prev.x + strokeTarget.x) * 0.5,
                        y: (prev.y + strokeTarget.y) * 0.5,
                        z: (prev.z + strokeTarget.z) * 0.5
                      };
                  lastStackAtRef.current = now;
                  applyVoxelBatch(filtered.allowed);
                }
                if (filtered.blocked) {
                  lastPaintPosRef.current = null;
                  spraySmoothPos = null;
                  strokeControlPos = null;
                  notifyBlockedByPlacedItem?.(filtered.blockedBy);
                }
              }
            }
          }
        } else if (target && target.action === 'erase' && target.voxel) {
          ghost.position.set(target.voxel.x, target.voxel.y, target.voxel.z);
          ghost.scale.setScalar(normalizeBlockScale(target.voxel.scale ?? 1) * 1.06);
          ghost.material.color.set(0xff3e7f);
          if (paintingRef.current && toolRef.current === 'erase') {
            eraseTargetVoxel(target);
          }
        } else if (toolRef.current === 'erase') {
          ghost.visible = false;
        }
      }

      const anchor = surfaceAnchorRef.current;
      const placedVoxels = voxelsRef.current || [];
      let originX = null;
      let originY = null;
      let originZ = null;
      let originRequired = false;

      if (isPublishIsolatedFrame || arViewOnly || interactingLand || !isCalibratedForDraw) {
        surfaceMarker.visible = false;
      } else if (anchor) {
        originX = anchor.x;
        originY = anchor.y;
        originZ = anchor.z;
        originRequired = Boolean(anchor.locked);
        surfaceMarker.visible = modeRef.current === 'draw';
      } else if (placedVoxels.length > 0) {
        originX = placedVoxels[0].x;
        originY = placedVoxels[0].y;
        originZ = placedVoxels[0].z;
        surfaceMarker.visible = modeRef.current === 'draw' || modeRef.current === 'transform';
        if (modeRef.current === 'draw') {
          surfaceMarker.position.set(originX, originY, originZ);
          surfaceMarker.rotation.set(-Math.PI / 2, 0, 0);
        }
      } else if (latestTarget && latestTarget.action === 'add') {
        originX = latestTarget.x;
        originY = latestTarget.y;
        originZ = latestTarget.z;
        originRequired = true;
        surfaceMarker.visible = modeRef.current === 'draw';
        surfaceMarker.position.set(originX, originY, originZ);
        surfaceMarker.rotation.set(-Math.PI / 2, 0, 0);
      } else {
        surfaceMarker.visible = false;
      }

      const beaconMats = originBeaconMatRef.current;
      if (beaconMats) {
        const isBlk = originStatusRef.current.originBlocked;
        beaconMats.ringMat.color.setHex(isBlk ? 0xff3e7f : 0x00f5d4);
        beaconMats.footMat.color.setHex(isBlk ? 0xff3e7f : 0x00f5d4);
        beaconMats.dotMat.color.setHex(isBlk ? 0xff3e7f : 0xffd166);
      }

      const isTransform = modeRef.current === 'transform';
      const isMappingPaused = Boolean(
        mappingPausedRef?.current ||
          (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      );
      const isUiMappingActive = !arViewOnly && !isTransform && !isMappingPaused;
      const allowBackgroundCalibration = Boolean(
        backgroundCalibrationActiveRef?.current &&
          !cameraHiddenRef.current &&
          !isPublishIsolatedFrame &&
          (typeof document === 'undefined' || document.visibilityState !== 'hidden')
      );
      const isSceneLocked = Boolean(polRef.current.getSceneCoverage().optimal);
      sceneScanOptimalRef.current = isSceneLocked;
      const needsMoreCalibration =
        !isSceneLocked || !calibrationReadyRef.current || orbKeyframesRef.current.size < 3;
      if (calibrationReadyRef.current) {
        if (isUiMappingActive && !mappingCompletedNoticeShownRef.current) {
          mappingCompletedNoticeShownRef.current = true;
          showTemporaryHint('AR Calibrated — ready to draw in 3D!');
        }
      }

      if (
        (isUiMappingActive || allowBackgroundCalibration) &&
        needsMoreCalibration &&
        now - lastScanPosePush > 110
      ) {
        lastScanPosePush = now;
        scanFwdVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
        const yawDeg = (Math.atan2(scanFwdVec.x, -scanFwdVec.z) * 180) / Math.PI;
        const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, scanFwdVec.y))) * 180) / Math.PI;
        const hasLiveCameraFrame = Boolean(
          activeXrSession ||
            (videoRef.current &&
              videoRef.current.readyState >= 2 &&
              videoRef.current.videoWidth > 0 &&
              !videoRef.current.paused)
        );
        const cov = polRef.current.recordViewPose({
          yawDeg,
          pitchDeg,
          hasCamera: hasLiveCameraFrame
        });
        const prev = lastScanUiRef.current;
        if (cov.optimal) {
          sceneScanOptimalRef.current = true;
        }
        if (
          cov.coveragePct !== prev.coveragePct ||
          cov.scannedCount !== prev.scannedCount ||
          cov.optimal !== prev.optimal ||
          cov.hint !== prev.hint ||
          Math.abs(cov.cursorX - prev.cursorX) >= 0.035 ||
          Math.abs(cov.cursorY - prev.cursorY) >= 0.035
        ) {
          lastScanUiRef.current = {
            coveragePct: cov.coveragePct,
            scannedCount: cov.scannedCount,
            optimal: cov.optimal,
            cursorX: cov.cursorX,
            cursorY: cov.cursorY,
            hint: cov.hint
          };
          setSceneScan(cov);
        }

        if (cov.optimal && calibrationReadyRef.current) {
          const clearKey = '0'.repeat(48);
          if (lastUnmappedMaskRef.current !== clearKey) {
            lastUnmappedMaskRef.current = clearKey;
            setUnmappedGrid(Array(48).fill(false));
          }
        } else if (isUiMappingActive && !cov.optimal) {
          const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
          const vpKey = vpGrid.map((b) => (b ? '1' : '0')).join('');
          if (lastUnmappedMaskRef.current !== vpKey) {
            lastUnmappedMaskRef.current = vpKey;
            setUnmappedGrid(vpGrid);
          }
        }

        const orbIntervalMs = calibrationReadyRef.current ? 1100 : 520;
        if (
          now - lastOrbExtractPush > orbIntervalMs &&
          !orbExtractBusy &&
          hasLiveCameraFrame &&
          orbKeyframesRef.current.size < 3
        ) {
          // Use scan-relative yaw so left/center/right ORB anchors capture facing ANY compass direction!
          const bucket = resolveRelativeOrbBucket(cov.relYaw);
          if (!orbKeyframesRef.current.has(bucket)) {
            lastOrbExtractPush = now;
            orbExtractBusy = true;
            orbTrackerRef.current
              ?.extractKeyframeFeatures(videoRef.current, { yawDeg, pitchDeg })
              .then((kf) => {
                if (kf?.features?.length >= 4 && !orbKeyframesRef.current.has(bucket)) {
                  orbKeyframesRef.current.set(bucket, kf);
                  let totalPts = 0;
                  for (const item of orbKeyframesRef.current.values()) {
                    totalPts += item.features.length;
                  }
                  setOrbStatus((prevSt) => ({
                    ...prevSt,
                    keyframes: orbKeyframesRef.current.size,
                    features: totalPts,
                    lightingSlot: kf.lightingTag || prevSt.lightingSlot || 'daylight'
                  }));
                }
              })
              .catch(() => {})
              .finally(() => {
                orbExtractBusy = false;
              });
          }
        }
      }

      const envRefreshMs = 1100;
      const shouldRefreshEnv =
        !activeXrSession &&
        !arViewOnly &&
        !isTransform &&
        !paintingRef.current &&
        (!isSceneLocked || !hasCapturedEnvRef.current);
      if (
        shouldRefreshEnv &&
        now - lastEnvPush > envRefreshMs &&
        videoRef.current &&
        envUpdaterRef.current
      ) {
        lastEnvPush = now;
        const envData = envUpdaterRef.current.update(videoRef.current);
        if (envData) {
          hasCapturedEnvRef.current = true;
          scene.environment = envData.envTexture;
          hemiLight.color.setHex(envData.skyColor);
          hemiLight.groundColor.setHex(envData.groundColor);
          if (atmosphericTintRef && Number.isFinite(envData.skyColor)) {
            atmosphericTintRef.current = envData.skyColor;
          }
        }
      }

      if (
        !activeXrSession &&
        !arViewOnly &&
        !isTransform &&
        occlusionEnabledRef.current &&
        now - lastOcclusionPush > 110 &&
        occlusionCanvasRef.current
      ) {
        lastOcclusionPush = now;
        let originScreen = { x: 0.5, y: 0.5, onScreen: true, requiredVisible: false };
        if (originX !== null && originY !== null && originZ !== null) {
          originProjVec.set(originX, originY, originZ).project(camera);
          const sx = (originProjVec.x + 1) * 0.5;
          const sy = (1 - originProjVec.y) * 0.5;
          const onScreen =
            originProjVec.z >= -1 &&
            originProjVec.z <= 1 &&
            sx >= 0.04 &&
            sx <= 0.96 &&
            sy >= 0.04 &&
            sy <= 0.96;
          originScreen = {
            x: sx,
            y: sy,
            onScreen,
            requiredVisible: originRequired
          };
        }
        const occStatus = occlusionRef.current.processFrame(
          videoRef.current,
          occlusionCanvasRef.current,
          rawOrientationRef.current,
          occlusionEnabledRef.current,
          originScreen
        );
        if (
          occStatus &&
          (occStatus.originBlocked !== originStatusRef.current.originBlocked ||
            occStatus.reason !== originStatusRef.current.reason)
        ) {
          originStatusRef.current = occStatus;
          setOriginStatus(occStatus);
        }
      }

      let selectedLandObj = null;
      let selectedLandApproach = null;
      let selectedLandLiveDist = null;
      const selectedLandId = arSelectedLandIdRef?.current || '';

      if (
        !isPublishIsolatedFrame &&
        (modeRef.current === 'draw' ||
          modeRef.current === 'transform' ||
          modeRef.current === 'preview') &&
        nearbyGroupRef.current?.children.length
      ) {
        const activeId = arTargetedIdRef.current;
        const activeFadeMul =
          (modeRef.current === 'draw' || modeRef.current === 'transform') &&
          !isInteractingWithLandRef?.current &&
          Boolean(fadeOtherItemsRef?.current)
            ? 0.22
            : 1;
        const hazeTintHex = Number.isFinite(Number(atmosphericTintRef?.current))
          ? Number(atmosphericTintRef.current)
          : DEFAULT_ATMOSPHERIC_HAZE_HEX;
        nearbyGroupRef.current.updateMatrixWorld();

        // Pass 1: Compute live 3D camera distance to every rendered land prism & step walking-approach tracker
        const liveLandInputs = [];
        const liveDistByParcelId = new Map();
        const prismNodes = [];
        const sculptureNodes = [];
        for (const sub of nearbyGroupRef.current.children) {
          const ud = sub.userData;
          if (ud?.isParcelPerimeter) {
            prismNodes.push(sub);
            const liveDistM = computeLiveLandEdgeDistanceMeters({
              cameraPos: camera.position,
              nearbyGroupPos: nearbyGroup.position,
              cornersLocal: ud.cornersLocal,
              centerLocal: ud.centerLocal,
              fallbackDistanceMeters: ud.distanceMeters ?? 0
            });
            liveDistByParcelId.set(ud.parcelId, liveDistM);
            liveLandInputs.push({
              parcelId: ud.parcelId,
              distanceMeters: liveDistM,
              insideParcel: Boolean(ud.insideParcel || liveDistM <= 1.5)
            });
          } else if (ud?.sculptureId && Number.isFinite(ud.distanceMeters)) {
            sculptureNodes.push(sub);
          }
        }

        const nowWallMs = Date.now();
        const liveSpeedMps = Math.max(
          Number(locationRef.current?.speed || 0),
          Number(positionFilterRef?.current?.lastSpeed || 0)
        );
        const walkSnap = stepWalkingApproachTracker(walkingTracker, {
          nowMs: nowWallMs,
          location: locationRef.current,
          speedMps: liveSpeedMps,
          cameraPos: camera.position,
          lands: liveLandInputs
        });
        if (walkingApproachRef) {
          walkingApproachRef.current = {
            isWalking: walkSnap.isWalking,
            walkingSpeedMps: walkSnap.walkingSpeedMps,
            primaryApproachingParcelId: walkSnap.primaryApproachingParcelId,
            hasUnsavedDraft: (voxelsRef.current?.length || 0) > 0,
            updatedAt: nowWallMs
          };
        }

        const isPaintingNow = Boolean(paintingRef.current);
        const approachProfileByParcel = new Map();

        // Pass 2: Update land boundary prisms (smoothly ramping approached lands to 100% opacity in ANY camera mode)
        for (const sub of prismNodes) {
          const ud = sub.userData;
          const isSelLand = Boolean(selectedLandId && ud.parcelId === selectedLandId);
          if (isSelLand) {
            selectedLandObj = sub;
          }
          const liveDistM = liveDistByParcelId.get(ud.parcelId) ?? ud.distanceMeters ?? 0;
          const landSharp = computeProximitySharpness(liveDistM, { hazeTintHex });
          const pPulse = 0.5 + 0.5 * Math.sin(now * (isSelLand ? 0.0075 : 0.0045));
          const baseWireOpacity = isSelLand
            ? 0.86 + pPulse * 0.14
            : ud.insideParcel
            ? 0.72 + pPulse * 0.24
            : 0.5 + pPulse * 0.2;
          const baseWallOpacity = isSelLand
            ? 0.13 + pPulse * 0.08
            : ud.insideParcel
            ? 0.06 + pPulse * 0.04
            : 0.04 + pPulse * 0.025;

          const walkLand = walkSnap.byParcelId.get(ud.parcelId);
          const approachProfile = computeApproachedLandOpacityProfile({
            distanceMeters: liveDistM,
            baseSharpness: landSharp,
            baseFadeMultiplier: activeFadeMul,
            baseWireOpacity,
            baseWallOpacity,
            isWalking: walkSnap.isWalking,
            isApproaching: Boolean(walkLand?.isApproaching),
            closingMeters: walkLand?.closingMeters || 0,
            insideParcel: Boolean(ud.insideParcel || liveDistM <= 1.5),
            isPainting: isPaintingNow
          });
          approachProfileByParcel.set(ud.parcelId, approachProfile);
          if (isSelLand) {
            selectedLandApproach = approachProfile;
            selectedLandLiveDist = liveDistM;
          }

          const effHaze = approachProfile.sharpnessProfile.atmosphericHaze;
          const hazeColorKey = `${hazeTintHex}:${Math.round(effHaze * 40)}`;
          if (ud.baseHex !== undefined && ud._lastHazeColorKey !== hazeColorKey) {
            ud._lastHazeColorKey = hazeColorKey;
            ud._lastHazeHex = hazeTintHex;
            const atmoHex = blendHexWithAtmosphericHaze(
              ud.baseHex,
              effHaze * 0.72,
              hazeTintHex
            );
            if (ud.wireMat?.uniforms?.uColor?.value?.setHex) {
              ud.wireMat.uniforms.uColor.value.setHex(atmoHex);
            } else if (ud.wireMat?.color?.setHex) {
              ud.wireMat.color.setHex(atmoHex);
            }
            if (ud.wallMat?.color?.setHex) {
              ud.wallMat.color.setHex(atmoHex);
            }
          }
          if (ud.wireMat?.uniforms?.uOpacityScale) {
            ud.wireMat.uniforms.uOpacityScale.value = approachProfile.prismWireOpacity;
          } else if (ud.wireMat) {
            ud.wireMat.opacity = approachProfile.prismWireOpacity;
          }
          if (ud.perimeterMat) {
            ud.perimeterMat.opacity = approachProfile.prismWireOpacity;
          }
          if (ud.wallMat) {
            ud.wallMat.opacity = approachProfile.prismWallOpacity;
          }
          updateThreeWireframeDepthFade(sub, camera.position);
        }

        // Pass 3: Update sculptures (approached land sculptures reach 100% opacity in ANY camera-open mode)
        for (const sub of sculptureNodes) {
          const ud = sub.userData;
          const liveScDist = Number.isFinite(sub.position?.x) && Number.isFinite(sub.position?.z)
            ? Math.hypot(
                nearbyGroup.position.x + sub.position.x - camera.position.x,
                nearbyGroup.position.z + sub.position.z - camera.position.z
              )
            : ud.distanceMeters;
          const baseScSharp = computeProximitySharpness(liveScDist, { hazeTintHex });
          const landApproach = ud.parcelId ? approachProfileByParcel.get(ud.parcelId) || null : null;
          const walkLand = ud.parcelId ? walkSnap.byParcelId.get(ud.parcelId) || null : null;

          const scApproach = computeApproachedLandOpacityProfile({
            distanceMeters: liveScDist,
            baseSharpness: baseScSharp,
            baseFadeMultiplier: activeFadeMul,
            isWalking: walkSnap.isWalking,
            isApproaching: Boolean(
              landApproach?.isApproachedWhileWalking || walkLand?.isApproaching
            ),
            closingMeters: Math.max(
              walkLand?.closingMeters || 0,
              (landApproach?.approachProgress || 0) * 8
            ),
            insideParcel: Boolean(
              walkLand?.insideParcel || (landApproach?.approachProgress || 0) >= 0.99
            ),
            isPainting: isPaintingNow
          });

          const effSharp = scApproach.sharpnessProfile;
          const effFadeMul = scApproach.fadeMultiplier;
          const effApproach = scApproach.approachProgress;

          if (
            Math.abs(effSharp.sharpness - (ud._lastSharpness ?? -1)) >= 0.02 ||
            Math.abs(effFadeMul - (ud._lastFadeMul ?? -1)) >= 0.02 ||
            Math.abs(effApproach - (ud._lastApproach ?? -1)) >= 0.02 ||
            ud._lastHazeHex !== hazeTintHex
          ) {
            ud._lastSharpness = effSharp.sharpness;
            ud._lastFadeMul = effFadeMul;
            ud._lastApproach = effApproach;
            ud._lastHazeHex = hazeTintHex;
            applyProximitySharpnessToObject3D(sub, effSharp, maxAnisotropy, {
              fadeMultiplier: effFadeMul,
              hazeTintHex
            });
          }
          if (!ud?.baseRingMat) continue;
          const isTargeted = activeId && ud.sculptureId === activeId;
          const pulse = 0.5 + 0.5 * Math.sin(now * (isTargeted ? 0.008 : 0.0045));
          const baseAtten = effSharp.prismOpacityScale * effFadeMul;
          ud.baseRingMat.color.setHex(isTargeted ? 0xffd166 : 0x00f5d4);
          ud.baseRingMat.opacity =
            (isTargeted
              ? 0.72 + pulse * 0.25
              : scApproach.isApproachedWhileWalking
              ? 0.55 + pulse * 0.35
              : modeRef.current === 'draw'
              ? 0.28 + pulse * 0.18
              : 0.46 + pulse * 0.3) * baseAtten;
          if (ud.baseHaloMat) {
            ud.baseHaloMat.color.setHex(isTargeted ? 0xffd166 : 0x00f5d4);
            ud.baseHaloMat.opacity =
              (isTargeted ? 0.22 + pulse * 0.14 : 0.1 + pulse * 0.1) * baseAtten;
          }
          if (ud.baseGlowRing) {
            const s = isTargeted ? 1.08 + pulse * 0.07 : 1 + pulse * 0.03;
            ud.baseGlowRing.scale.set(s, s, 1);
          }
        }
      } else if (!isPublishIsolatedFrame && !cameraHiddenRef.current && walkingApproachRef) {
        const nowWallMs = Date.now();
        const liveSpeedMps = Math.max(
          Number(locationRef.current?.speed || 0),
          Number(positionFilterRef?.current?.lastSpeed || 0)
        );
        const walkSnap = stepWalkingApproachTracker(walkingTracker, {
          nowMs: nowWallMs,
          location: locationRef.current,
          speedMps: liveSpeedMps,
          cameraPos: camera.position,
          lands: []
        });
        walkingApproachRef.current = {
          isWalking: walkSnap.isWalking,
          walkingSpeedMps: walkSnap.walkingSpeedMps,
          primaryApproachingParcelId: '',
          hasUnsavedDraft: (voxelsRef.current?.length || 0) > 0,
          updatedAt: nowWallMs
        };
      }

      if (now - lastGuidancePush > 90) {
        lastGuidancePush = now;
        if (
          selectedLandId &&
          selectedLandObj?.userData?.centerLocal &&
          nearbyGroupRef.current
        ) {
          const ud = selectedLandObj.userData;
          camera.updateMatrixWorld();
          guidanceTargetWorld
            .copy(ud.centerLocal)
            .applyMatrix4(nearbyGroupRef.current.matrixWorld);
          const cornersWorld = (ud.cornersLocal || []).map((pt) =>
            pt.clone().applyMatrix4(nearbyGroupRef.current.matrixWorld)
          );
          const effectiveSelDist = selectedLandLiveDist ?? ud.distanceMeters ?? 0;
          const isInsideSelectedLand = Boolean(ud.insideParcel || effectiveSelDist <= 1.5);
          const guidance = isInsideSelectedLand
            ? null
            : computeArLandCameraGuidance({
                targetWorld: guidanceTargetWorld,
                cornersWorld,
                camera,
                isInside: false,
                distanceMeters: effectiveSelDist
              });
          const sharpProfile =
            selectedLandApproach?.sharpnessProfile ||
            computeProximitySharpness(effectiveSelDist);

          if (!activeXrSession) {
            const nativeDpr = Math.min(window.devicePixelRatio || 1, 2.5);
            const targetDpr = Math.max(
              0.85,
              Number((nativeDpr * sharpProfile.pixelRatioScale).toFixed(2))
            );
            if (Math.abs(targetDpr - lastPixelRatio) >= 0.08) {
              lastPixelRatio = targetDpr;
              renderer.setPixelRatio(targetDpr);
            }
          }

          const hasDraftBlocks = (voxelsRef.current?.length || 0) > 0;
          const nextFilter =
            !activeXrSession &&
            !isInsideSelectedLand &&
            interactingLand &&
            !hasDraftBlocks &&
            guidance?.inView &&
            sharpProfile.canvasBlurPx > 0.05
              ? `blur(${sharpProfile.canvasBlurPx}px)`
              : '';
          if (nextFilter !== lastCanvasFilter) {
            lastCanvasFilter = nextFilter;
            renderer.domElement.style.filter = nextFilter;
          }

          if (guidance) {
            const key = [
              selectedLandId,
              guidance.inView ? 1 : 0,
              guidance.edge,
              Math.round((guidance.angleDeg || 0) / 4),
              Math.round((guidance.turnDegrees || 0) / 3),
              sharpProfile.sharpnessPct,
              Math.round(effectiveSelDist || 0)
            ].join(':');
            if (key !== lastGuidanceKey) {
              lastGuidanceKey = key;
              onArLandGuidanceRef.current?.({
                ...guidance,
                isInside: false,
                parcelId: selectedLandId,
                displayName: ud.displayName || 'Nearby Land',
                distanceMeters: effectiveSelDist,
                sharpness: sharpProfile.sharpness,
                sharpnessPct: sharpProfile.sharpnessPct,
                tier: sharpProfile.tier,
                tierLabel: sharpProfile.tierLabel
              });
            }
          } else if (lastGuidanceKey !== '') {
            lastGuidanceKey = '';
            onArLandGuidanceRef.current?.(null);
          }
        } else {
          if (lastCanvasFilter !== '') {
            lastCanvasFilter = '';
            renderer.domElement.style.filter = '';
          }
          if (!activeXrSession) {
            const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
            if (Math.abs(baseDpr - lastPixelRatio) >= 0.12) {
              lastPixelRatio = baseDpr;
              renderer.setPixelRatio(baseDpr);
            }
          }
          if (lastGuidanceKey !== '') {
            lastGuidanceKey = '';
            onArLandGuidanceRef.current?.(null);
          }
        }
      }

      if (isPublishIsolatedFrame && arTargetedIdRef.current) {
        arTargetedIdRef.current = '';
        setArTargetedSculpture(null);
      }
      if (now - lastTargetCheck > 180) {
        lastTargetCheck = now;
        if (
          !isPublishIsolatedFrame &&
          modeRef.current === 'preview' &&
          nearbyGroupRef.current?.children.length
        ) {
          targetRay.setFromCamera(centerNdc, camera);
          const hits = targetRay.intersectObjects(nearbyGroupRef.current.children, true);
          const hitObj = hits.find((h) => h.object?.userData?.sculpture);
          const sc = hitObj?.object?.userData?.sculpture || null;
          if (sc) {
            const loc = locationRef.current;
            const d = loc ? haversineMeters(loc.lat, loc.lng, sc.lat, sc.lng) : hitObj.distance;
            if (arTargetedIdRef.current !== sc.id) {
              arTargetedIdRef.current = sc.id;
              setArTargetedSculpture({ sculpture: sc, distanceM: d });
            }
          } else if (arTargetedIdRef.current) {
            arTargetedIdRef.current = '';
            setArTargetedSculpture(null);
          }
        } else if (arTargetedIdRef.current) {
          arTargetedIdRef.current = '';
          setArTargetedSculpture(null);
        }
      }

      if (!arViewOnly && wsRef.current?.readyState === 1 && now - lastWsPush > 45) {
        lastWsPush = now;
        wsRef.current.send(
          JSON.stringify({
            type: 'brush_state',
            q: camera.quaternion.toArray(),
            cursor: [ghost.position.x, ghost.position.y, ghost.position.z],
            color: colorRef.current,
            tool: toolRef.current,
            mode: modeRef.current
          })
        );
      }

      if (activeXrSession) {
        xrRenderCamera.near = camera.near;
        xrRenderCamera.far = camera.far;
        renderer.render(scene, xrRenderCamera);
      } else {
        renderer.render(scene, camera);
      }
    };

    const animate = () => {
      if (!activeXrSession && renderPausedRef.current) {
        rafId = 0;
        return;
      }
      rafId = requestAnimationFrame(animate);
      renderFrame(null);
    };

    const startStandardLoop = () => {
      if (!rafId && !activeXrSession && !renderPausedRef.current) {
        rafId = requestAnimationFrame(animate);
      }
    };
    resumeLoopRef.current = startStandardLoop;

    if (webxrControllerRef) {
      webxrControllerRef.current = {
        start: async () => {
          if (activeXrSession) return true;
          cancelAnimationFrame(rafId);
          rafId = 0;
          const seedHeading = orientationFusionRef?.current?.initialized
            ? orientationFusionRef.current.getTrueHeadingDeg()
            : 0;
          const overlayRoot =
            typeof document !== 'undefined'
              ? document.getElementById('root') || document.querySelector('.mobile-fullscreen')
              : null;
          if (typeof document !== 'undefined') {
            document.documentElement?.classList?.add('webxr-ar-active');
            document.body?.classList?.add('webxr-ar-active');
          }
          try {
            const sessionCtrl = await startWebXrArSession({
              renderer,
              overlayRoot,
              seedTrueHeadingDeg: seedHeading,
              onEnd: () => {
                activeXrSession = null;
                renderer.setAnimationLoop(null);
                xrRig.position.set(0, 0, 0);
                xrRig.quaternion.identity();
                xrRig.updateMatrixWorld(true);
                camera.position.set(baseCameraPos.x, baseCameraPos.y, baseCameraPos.z);
                nearbyGroup.position.set(baseCameraPos.x, 0, baseCameraPos.z);
                handleResize();
                if (typeof document !== 'undefined') {
                  document.documentElement?.classList?.remove('webxr-ar-active');
                  document.body?.classList?.remove('webxr-ar-active');
                }
                onWebxrStateChange?.(false);
                startStandardLoop();
              }
            });
            tryLockPortraitOrientation();
            activeXrSession = sessionCtrl;
            onWebxrStateChange?.(true);
            renderer.setAnimationLoop((_t, xrFrame) => {
              renderFrame(xrFrame);
            });
            return true;
          } catch (err) {
            activeXrSession = null;
            renderer.setAnimationLoop(null);
            if (typeof document !== 'undefined') {
              document.documentElement?.classList?.remove('webxr-ar-active');
              document.body?.classList?.remove('webxr-ar-active');
            }
            onWebxrStateChange?.(false);
            startStandardLoop();
            throw err;
          }
        },
        stop: async () => {
          if (!activeXrSession) return;
          const cur = activeXrSession;
          activeXrSession = null;
          renderer.setAnimationLoop(null);
          await cur.stop();
        }
      };
    }

    animate();

    return () => {
      if (webxrControllerRef) {
        webxrControllerRef.current = null;
      }
      if (activeXrSession) {
        const cur = activeXrSession;
        activeXrSession = null;
        renderer.setAnimationLoop(null);
        cur.stop().catch(() => {});
      }
      originBeaconMatRef.current = null;
      resumeLoopRef.current = null;
      for (const tid of resizeSettleTimers) clearTimeout(tid);
      resizeSettleTimers.clear();
      clearTimeout(contextRecoverTimerRef.current);
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleViewportOrFullscreenTransition);
      window.visualViewport?.removeEventListener?.('resize', handleResize);
      if (typeof document !== 'undefined') {
        document.removeEventListener('fullscreenchange', handleViewportOrFullscreenTransition);
        document.removeEventListener('webkitfullscreenchange', handleViewportOrFullscreenTransition);
      }
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      envUpdaterRef.current?.dispose();
      disposeObject3D(nearbyGroup);
      ringGeo.dispose();
      ringMat.dispose();
      dotGeo.dispose();
      dotMat.dispose();
      footGeo.dispose();
      footMat.dispose();
      stemGeo.dispose();
      ghostGeo.dispose();
      ghostMat.dispose();
      neighborSlotEdgeGeo.dispose();
      neighborSlotMat.dispose();
      sprayMistGeo.dispose();
      sprayMistMat.dispose();
      transformBox.dispose?.();
      transformBoxRef.current = null;
      draftUnitGeoRef.current?.dispose();
      draftUnitGeoRef.current = null;
      for (const mat of draftMatCache.values()) mat.dispose();
      draftMatCache.clear();
      draftMeshMap.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [
    applyVoxelAction,
    applyVoxelBatch,
    arSelectedLandIdRef,
    arTargetedIdRef,
    atmosphericTintRef,
    blockSizeRef,
    cameraRef,
    canvasHostRef,
    colorRef,
    computeTargetVoxel,
    dirLightRef,
    draftGroupRef,
    draftMatCacheRef,
    draftMeshMapRef,
    draftUnitGeoRef,
    draftYawOffsetRef,
    envUpdaterRef,
    eraseTargetVoxel,
    fadeOtherItemsRef,
    isolatePublishArtRef,
    fallbackEulerRef,
    getActivePlacedItemColliders,
    ghostMeshRef,
    gridHelperRef,
    hemiLightRef,
    isArViewOnlyRef,
    isInteractingWithLandRef,
    lastPaintPosRef,
    lastScanUiRef,
    lastStackAtRef,
    lastUnmappedMaskRef,
    locationRef,
    mappingCompletedNoticeShownRef,
    mappingPausedRef,
    backgroundCalibrationActiveRef,
    walkingApproachRef,
    modeRef,
    nearbyGroupRef,
    notifyBlockedByPlacedItem,
    occlusionCanvasRef,
    occlusionEnabledRef,
    occlusionRef,
    onWebxrStateChange,
    orbKeyframesRef,
    orbTrackerRef,
    orientationFusionRef,
    originBeaconMatRef,
    originStatusRef,
    paintingRef,
    strokeDeviceOriginRef,
    polRef,
    positionFilterRef,
    spatialDrawTrackerRef,
    reachRef,
    rawOrientationRef,
    rebuildDraftMesh,
    rendererRef,
    sceneRef,
    setArTargetedSculpture,
    setOrbStatus,
    setOriginStatus,
    setSceneScan,
    setUnmappedGrid,
    shadowPlaneRef,
    showTemporaryHint,
    surfaceAnchorRef,
    surfaceMarkerRef,
    toolRef,
    transformBoxRef,
    videoRef,
    voxelsRef,
    webxrControllerRef,
    wsRef,
    yawOffsetRef
  ]);

  // Pause live camera video element while camera view is intentionally hidden (e.g. Search 3D models)
  // so mobile GPUs & decoders have full headroom without tearing down stream permissions.
  useEffect(() => {
    const videoEl = videoRef?.current;
    if (cameraHidden) {
      wasCameraHiddenRef.current = true;
      if (videoEl && typeof videoEl.pause === 'function' && !videoEl.paused) {
        try {
          videoEl.pause();
        } catch {
          // ignore
        }
      }
      return;
    }
    if (wasCameraHiddenRef.current) {
      wasCameraHiddenRef.current = false;
      if (webxrActivePropRef.current) return;
      onVideoMounted?.();
      if (videoEl && typeof videoEl.play === 'function') {
        const playRes = videoEl.play();
        if (playRes && typeof playRes.catch === 'function') {
          playRes.catch(() => {});
        }
      }
    }
  }, [cameraHidden, onVideoMounted, videoRef]);

  // Resume AR RAF loop & auto-recover any WebGL context evicted while full-screen map/modal was open
  useEffect(() => {
    if (effectiveRenderPaused) return undefined;
    resumeLoopRef.current?.();
    const gl = rendererRef?.current?.getContext?.();
    const isLostNow = Boolean(
      needsRemountOnResumeRef.current ||
        contextLostRef.current ||
        (typeof gl?.isContextLost === 'function' && gl.isContextLost())
    );
    if (!isLostNow) return undefined;
    needsRemountOnResumeRef.current = false;
    clearTimeout(contextRecoverTimerRef.current);
    contextRecoverTimerRef.current = setTimeout(() => {
      const curGl = rendererRef?.current?.getContext?.();
      if (
        !renderPausedRef.current &&
        (contextLostRef.current ||
          (typeof curGl?.isContextLost === 'function' && curGl.isContextLost()))
      ) {
        onRequestContextRecoverRef.current?.();
      }
    }, 220);
    return () => {
      clearTimeout(contextRecoverTimerRef.current);
    };
  }, [effectiveRenderPaused, rendererRef]);

  return (
    <>
      <video
        ref={videoRef}
        className={`camera-feed${cameraHidden ? ' is-camera-hidden' : ''}${
          webxrActive ? ' is-webxr-hidden' : ''
        }`}
        data-testid="ar-camera-video"
        data-camera-hidden={cameraHidden ? 'true' : 'false'}
        data-webxr-hidden={webxrActive ? 'true' : 'false'}
        aria-hidden={cameraHidden || webxrActive || undefined}
        playsInline
        muted
        autoPlay
      />
      {!cameraHidden && (
        <>
          {!isArViewOnly &&
            !isTransformMode &&
            !isPublishIsolated &&
            cameraReady &&
            !sceneScanOptimal &&
            !mappingRestartRequired && (
            <div
              className="mapping-grayscale-grid"
              data-testid="mapping-grayscale-grid"
              aria-hidden="true"
            >
              {unmappedGrid.map((isUnmapped, i) => (
                <div
                  key={i}
                  className={`mapping-grayscale-cell ${isUnmapped ? 'unmapped' : 'mapped'}`}
                />
              ))}
            </div>
          )}
          {!isArViewOnly && isTransformMode && (
            <div
              className="transform-camera-fade"
              data-testid="transform-camera-fade"
              aria-hidden="true"
            />
          )}
        </>
      )}
      <div
        ref={canvasHostRef}
        className={`webgl-overlay${cameraHidden ? ' is-camera-hidden' : ''}${
          webxrActive ? ' is-webxr-active' : ''
        }`}
        data-testid="ar-webgl-overlay"
        data-camera-hidden={cameraHidden ? 'true' : 'false'}
        data-webxr-active={webxrActive ? 'true' : 'false'}
        aria-hidden={cameraHidden || undefined}
        data-ar-view-only={isArViewOnly ? 'true' : 'false'}
        data-transform-mode={isTransformMode ? 'true' : 'false'}
        data-publish-isolated={isPublishIsolated ? 'true' : 'false'}
        data-scene-locked={sceneScanOptimal && calibrationReady ? 'true' : 'false'}
        data-calibration-ready={calibrationReady ? 'true' : 'false'}
        data-mapping-restart-required={mappingRestartRequired ? 'true' : 'false'}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerCancel}
      />
      {!cameraHidden && (
        <>
          {!webxrActive && !isArViewOnly && !isTransformMode && !isPublishIsolated && occlusionEnabled && (
            <canvas
              ref={occlusionCanvasRef}
              className="occlusion-overlay"
              data-testid="occlusion-overlay"
            />
          )}
          {!isArViewOnly &&
            !isPublishIsolated &&
            mode === 'draw' &&
            !isInteractingWithLand &&
            calibrationReady && (
            <ToolCenterReticle
              tool={tool}
              blockSize={blockSize}
              color={color}
              reachMeters={reachMeters}
              surfaceAnchor={surfaceAnchor}
              painting={painting}
              vFovDeg={cameraRef?.current?.fov || 65}
              onSetCenterSurface={onSetCenterSurface}
              onUnlockCenterSurface={onUnlockCenterSurface}
              onDrawAtCenter={onDrawAtCenter}
              onStartCenterBrushHold={onStartCenterBrushHold}
              onStopCenterBrushHold={onStopCenterBrushHold}
            />
          )}
          {contextLost && !renderPaused && (
            <div
              className="scene-error-fallback is-ar-viewport-recovery"
              data-testid="ar-webgl-recovery-overlay"
              role="status"
            >
              <div className="scene-error-card card">
                <XeroIcon emoji="⏳" size={20} />
                <p style={{ fontSize: 13 }}>Recovering mobile WebGL AR context...</p>
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  data-testid="ar-webgl-reload-btn"
                  onClick={() => onRequestContextRecover?.()}
                  style={{ marginTop: 8 }}
                >
                  Reload AR View
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function ARViewportCanvas(props) {
  const [sceneMountKey, setSceneMountKey] = useState(0);
  const triggerRecover = () => setSceneMountKey((k) => k + 1);
  return (
    <SceneErrorBoundary onRecover={triggerRecover}>
      <ARViewportCanvasInner
        key={sceneMountKey}
        {...props}
        onRequestContextRecover={triggerRecover}
      />
    </SceneErrorBoundary>
  );
}
