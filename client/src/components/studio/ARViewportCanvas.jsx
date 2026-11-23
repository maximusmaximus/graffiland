import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../../shared/chatPolicy.mjs';
import {
  buildConnectedVoxelPath,
  getVoxelCellStep,
  normalizeBlockScale
} from '../../../../shared/voxelStroke.mjs';
import SceneErrorBoundary from '../SceneErrorBoundary.jsx';
import {
  createLiveEnvUpdater,
  deviceOrientationToQuaternion,
  disposeObject3D,
  VOXEL_STEP
} from '../VoxelEngine3D.js';
import { updateThreeWireframeDepthFade } from '../../utils/prismDepthFade.js';
import {
  applyProximitySharpnessToObject3D,
  computeArLandCameraGuidance,
  computeProximitySharpness
} from '../../utils/arLandGuidance.js';
import XeroIcon from '../XeroIcon.jsx';

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
  occlusionEnabledRef,
  rawOrientationRef,
  yawOffsetRef,
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
  mode,
  modeRef,
  toolRef,
  blockSizeRef = null,
  colorRef,
  voxelsRef,
  paintingRef,
  lastPaintPosRef,
  lastStackAtRef,
  surfaceAnchorRef,
  lastScanUiRef,
  lastUnmappedMaskRef,
  mappingCompletedNoticeShownRef,
  setSceneScan,
  setUnmappedGrid,
  setOrbStatus,
  showTemporaryHint,
  cameraReady,
  sceneScanOptimal,
  unmappedGrid,
  onVideoMounted = null,
  onCameraRefreshNeeded = null,
  onArLandGuidance = null,
  computeTargetVoxel,
  applyVoxelBatch,
  applyVoxelAction,
  eraseTargetVoxel,
  rebuildDraftMesh,
  onCanvasPointerDown,
  onCanvasPointerMove,
  onCanvasPointerUp,
  onCanvasPointerCancel
}) {
  const [contextLost, setContextLost] = useState(false);
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
    if (isArViewOnly) {
      occlusionRef.current?.reset?.();
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
  }, [canvasHostRef, isArViewOnly, occlusionCanvasRef, occlusionRef]);

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
      120
    );
    camera.position.set(0, 0.4, 2.2);

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
      setContextLost(true);
    };
    const onContextRestored = () => {
      setContextLost(false);
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
    dirLight.shadow.camera.far = 36;
    const shadowBound = 9;
    dirLight.shadow.camera.left = -shadowBound;
    dirLight.shadow.camera.right = shadowBound;
    dirLight.shadow.camera.top = shadowBound;
    dirLight.shadow.camera.bottom = -shadowBound;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
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
    scene.add(draftGroup);
    scene.add(nearbyGroup);

    const transformBox = new THREE.Box3Helper(new THREE.Box3(), 0x00f5d4);
    transformBox.visible = false;
    scene.add(transformBox);
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

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    draftGroupRef.current = draftGroup;
    nearbyGroupRef.current = nearbyGroup;
    ghostMeshRef.current = ghost;
    if (voxelsRef.current?.length) {
      rebuildDraftMesh(voxelsRef.current);
    }

    const handleResize = () => {
      if (!host) return;
      camera.aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
      if (occlusionCanvasRef.current) {
        const occW = Math.min(280, Math.max(96, host.clientWidth));
        const occH = Math.max(
          96,
          Math.round((occW * host.clientHeight) / Math.max(1, host.clientWidth))
        );
        occlusionCanvasRef.current.width = occW;
        occlusionCanvasRef.current.height = occH;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    let lastWsPush = 0;
    let lastEnvPush = 0;
    let lastOcclusionPush = 0;
    let lastTargetCheck = 0;
    let lastScanPosePush = 0;
    let lastOrbExtractPush = 0;
    let lastGuidancePush = 0;
    let lastGuidanceKey = '';
    let lastPixelRatio = renderer.getPixelRatio();
    let lastCanvasFilter = '';
    let orbExtractBusy = false;
    const maxAnisotropy = Math.min(16, renderer.capabilities?.getMaxAnisotropy?.() || 8);
    const scanFwdVec = new THREE.Vector3();
    const originProjVec = new THREE.Vector3();
    const guidanceTargetWorld = new THREE.Vector3();
    const targetRay = new THREE.Raycaster();
    const centerNdc = new THREE.Vector2(0, 0);

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const now = performance.now();

      if (rawOrientationRef.current) {
        const { alpha, beta, gamma } = rawOrientationRef.current;
        const screenAngle = window.screen?.orientation?.angle || 0;
        const q = deviceOrientationToQuaternion(
          alpha - yawOffsetRef.current,
          beta,
          gamma,
          screenAngle
        );
        camera.quaternion.slerp(q, 0.45);
      } else {
        const euler = new THREE.Euler(
          fallbackEulerRef.current.pitch,
          fallbackEulerRef.current.yaw,
          0,
          'YXZ'
        );
        camera.quaternion.setFromEuler(euler);
      }

      const interactingLand = Boolean(isInteractingWithLandRef?.current);
      const arViewOnly = Boolean(
        isArViewOnlyRef?.current || interactingLand || modeRef.current === 'preview'
      );
      const showCursor = !arViewOnly && modeRef.current === 'draw' && !interactingLand;
      ghost.visible = showCursor;
      grid.visible = !arViewOnly;
      shadowCatcher.visible = !arViewOnly;
      dirLight.castShadow = !arViewOnly;
      draftGroup.visible = !interactingLand;
      if (arViewOnly) {
        transformBox.visible = false;
      }
      let latestTarget = null;

      if (showCursor) {
        const curBlockScale = normalizeBlockScale(blockSizeRef?.current ?? 1);
        const curCellStep = getVoxelCellStep(VOXEL_STEP, curBlockScale);
        const target = computeTargetVoxel(paintingRef.current);
        latestTarget = target;
        if (target && target.action === 'add') {
          ghost.position.set(target.x, target.y, target.z);
          ghost.scale.setScalar(normalizeBlockScale(target.scale ?? curBlockScale));
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
              if (!prev) {
                const startStep = buildConnectedVoxelPath(null, target, {
                  step: VOXEL_STEP,
                  blockScale: curBlockScale
                });
                if (startStep.path.length > 0) {
                  lastPaintPosRef.current = startStep.lastPoint;
                  lastStackAtRef.current = now;
                  applyVoxelBatch(startStep.path);
                }
              } else {
                const stroke = buildConnectedVoxelPath(prev, target, {
                  step: VOXEL_STEP,
                  blockScale: curBlockScale,
                  maxSteps: 64
                });
                if (stroke.path.length > 0) {
                  lastPaintPosRef.current = stroke.lastPoint;
                  lastStackAtRef.current = now;
                  applyVoxelBatch(stroke.path);
                }
              }
            }
          }
        } else if (target && target.action === 'erase' && target.voxel) {
          ghost.position.set(target.voxel.x, target.voxel.y, target.voxel.z);
          ghost.scale.setScalar(normalizeBlockScale(target.voxel.scale ?? 1));
          ghost.material.color.set(0xff3e7f);
          if (paintingRef.current && toolRef.current === 'erase') {
            eraseTargetVoxel(target);
          }
        }
      }

      const anchor = surfaceAnchorRef.current;
      const placedVoxels = voxelsRef.current || [];
      let originX = null;
      let originY = null;
      let originZ = null;
      let originRequired = false;

      if (arViewOnly || interactingLand) {
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

      if (!arViewOnly && now - lastScanPosePush > 110) {
        lastScanPosePush = now;
        scanFwdVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
        const yawDeg = (Math.atan2(scanFwdVec.x, -scanFwdVec.z) * 180) / Math.PI;
        const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, scanFwdVec.y))) * 180) / Math.PI;
        const cov = polRef.current.recordViewPose({
          yawDeg,
          pitchDeg,
          hasCamera: Boolean(videoRef.current && videoRef.current.readyState >= 2)
        });
        const prev = lastScanUiRef.current;
        if (!prev.optimal && cov.optimal && !mappingCompletedNoticeShownRef.current) {
          mappingCompletedNoticeShownRef.current = true;
          showTemporaryHint('Mapping complete for this space — 100% precision lock active!');
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

        const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
        const vpKey = vpGrid.map((b) => (b ? '1' : '0')).join('');
        if (lastUnmappedMaskRef.current !== vpKey) {
          lastUnmappedMaskRef.current = vpKey;
          setUnmappedGrid(vpGrid);
        }

        if (
          now - lastOrbExtractPush > 920 &&
          !orbExtractBusy &&
          videoRef.current?.readyState >= 2 &&
          orbKeyframesRef.current.size < 3
        ) {
          const bucket = yawDeg < -18 ? 'left' : yawDeg > 18 ? 'right' : 'center';
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
                    features: totalPts
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

      const envRefreshMs = polRef.current.getSceneCoverage().optimal ? 2200 : 1100;
      if (
        !arViewOnly &&
        !paintingRef.current &&
        now - lastEnvPush > envRefreshMs &&
        videoRef.current &&
        envUpdaterRef.current
      ) {
        lastEnvPush = now;
        const envData = envUpdaterRef.current.update(videoRef.current);
        if (envData) {
          scene.environment = envData.envTexture;
          hemiLight.color.setHex(envData.skyColor);
          hemiLight.groundColor.setHex(envData.groundColor);
        }
      }

      if (!arViewOnly && now - lastOcclusionPush > 110 && occlusionCanvasRef.current) {
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
      const selectedLandId = arSelectedLandIdRef?.current || '';

      if (
        (modeRef.current === 'draw' || modeRef.current === 'preview') &&
        nearbyGroupRef.current?.children.length
      ) {
        const activeId = arTargetedIdRef.current;
        nearbyGroupRef.current.updateMatrixWorld();
        for (const sub of nearbyGroupRef.current.children) {
          const ud = sub.userData;
          if (ud?.isParcelPerimeter) {
            const isSelLand = Boolean(selectedLandId && ud.parcelId === selectedLandId);
            if (isSelLand) {
              selectedLandObj = sub;
            }
            const landSharp = computeProximitySharpness(ud.distanceMeters ?? 0);
            const pPulse = 0.5 + 0.5 * Math.sin(now * (isSelLand ? 0.0075 : 0.0045));
            const pulseScale =
              (isSelLand
                ? 0.86 + pPulse * 0.14
                : ud.insideParcel
                ? 0.72 + pPulse * 0.24
                : 0.5 + pPulse * 0.2) * landSharp.prismOpacityScale;
            if (ud.wireMat?.uniforms?.uOpacityScale) {
              ud.wireMat.uniforms.uOpacityScale.value = pulseScale;
            } else if (ud.wireMat) {
              ud.wireMat.opacity = pulseScale;
            }
            if (ud.perimeterMat) {
              ud.perimeterMat.opacity = pulseScale;
            }
            if (ud.wallMat) {
              ud.wallMat.opacity =
                (isSelLand
                  ? 0.13 + pPulse * 0.08
                  : ud.insideParcel
                  ? 0.06 + pPulse * 0.04
                  : 0.04 + pPulse * 0.025) * landSharp.prismOpacityScale;
            }
            updateThreeWireframeDepthFade(sub, camera.position);
            continue;
          }
          if (ud?.sculptureId && Number.isFinite(ud.distanceMeters)) {
            const scSharp = computeProximitySharpness(ud.distanceMeters);
            if (Math.abs(scSharp.sharpness - (ud._lastSharpness ?? -1)) >= 0.03) {
              ud._lastSharpness = scSharp.sharpness;
              applyProximitySharpnessToObject3D(sub, scSharp, maxAnisotropy);
            }
          }
          if (!ud?.baseRingMat) continue;
          const isTargeted = activeId && ud.sculptureId === activeId;
          const pulse = 0.5 + 0.5 * Math.sin(now * (isTargeted ? 0.008 : 0.0045));
          ud.baseRingMat.color.setHex(isTargeted ? 0xffd166 : 0x00f5d4);
          ud.baseRingMat.opacity = isTargeted
            ? 0.72 + pulse * 0.25
            : modeRef.current === 'draw'
            ? 0.28 + pulse * 0.18
            : 0.46 + pulse * 0.3;
          if (ud.baseHaloMat) {
            ud.baseHaloMat.color.setHex(isTargeted ? 0xffd166 : 0x00f5d4);
            ud.baseHaloMat.opacity = isTargeted ? 0.22 + pulse * 0.14 : 0.1 + pulse * 0.1;
          }
          if (ud.baseGlowRing) {
            const s = isTargeted ? 1.08 + pulse * 0.07 : 1 + pulse * 0.03;
            ud.baseGlowRing.scale.set(s, s, 1);
          }
        }
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
          const guidance = computeArLandCameraGuidance({
            targetWorld: guidanceTargetWorld,
            cornersWorld,
            camera,
            isInside: Boolean(ud.insideParcel),
            distanceMeters: ud.distanceMeters ?? 0
          });
          const sharpProfile = computeProximitySharpness(ud.distanceMeters ?? 0);

          const nativeDpr = Math.min(window.devicePixelRatio || 1, 2.5);
          const targetDpr = Math.max(
            0.85,
            Number((nativeDpr * sharpProfile.pixelRatioScale).toFixed(2))
          );
          if (Math.abs(targetDpr - lastPixelRatio) >= 0.08) {
            lastPixelRatio = targetDpr;
            renderer.setPixelRatio(targetDpr);
          }

          const hasDraftBlocks = (voxelsRef.current?.length || 0) > 0;
          const nextFilter =
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
              Math.round(ud.distanceMeters || 0)
            ].join(':');
            if (key !== lastGuidanceKey) {
              lastGuidanceKey = key;
              onArLandGuidanceRef.current?.({
                ...guidance,
                parcelId: selectedLandId,
                displayName: ud.displayName || 'Nearby Land',
                distanceMeters: ud.distanceMeters ?? 0,
                sharpness: sharpProfile.sharpness,
                sharpnessPct: sharpProfile.sharpnessPct,
                tier: sharpProfile.tier,
                tierLabel: sharpProfile.tierLabel
              });
            }
          }
        } else {
          if (lastCanvasFilter !== '') {
            lastCanvasFilter = '';
            renderer.domElement.style.filter = '';
          }
          const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
          if (Math.abs(baseDpr - lastPixelRatio) >= 0.12) {
            lastPixelRatio = baseDpr;
            renderer.setPixelRatio(baseDpr);
          }
          if (lastGuidanceKey !== '') {
            lastGuidanceKey = '';
            onArLandGuidanceRef.current?.(null);
          }
        }
      }

      if (now - lastTargetCheck > 180) {
        lastTargetCheck = now;
        if (modeRef.current === 'preview' && nearbyGroupRef.current?.children.length) {
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

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      originBeaconMatRef.current = null;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
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
    envUpdaterRef,
    eraseTargetVoxel,
    fallbackEulerRef,
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
    modeRef,
    nearbyGroupRef,
    occlusionCanvasRef,
    occlusionEnabledRef,
    occlusionRef,
    orbKeyframesRef,
    orbTrackerRef,
    originBeaconMatRef,
    originStatusRef,
    paintingRef,
    polRef,
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
    wsRef,
    yawOffsetRef
  ]);

  return (
    <>
      <video ref={videoRef} className="camera-feed" playsInline muted autoPlay />
      {!isArViewOnly && cameraReady && !sceneScanOptimal && (
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
      <div
        ref={canvasHostRef}
        className="webgl-overlay"
        data-ar-view-only={isArViewOnly ? 'true' : 'false'}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerCancel}
      />
      {!isArViewOnly && (
        <canvas
          ref={occlusionCanvasRef}
          className="occlusion-overlay"
          data-testid="occlusion-overlay"
        />
      )}
      {!isArViewOnly && mode === 'draw' && !isInteractingWithLand && <div className="reticle" />}
      {contextLost && (
        <div className="scene-error-fallback" role="status">
          <div className="scene-error-card card">
            <XeroIcon emoji="⏳" size={20} />
            <p style={{ fontSize: 13 }}>Recovering mobile WebGL AR context...</p>
          </div>
        </div>
      )}
    </>
  );
}

export default function ARViewportCanvas(props) {
  const [sceneMountKey, setSceneMountKey] = useState(0);
  return (
    <SceneErrorBoundary onRecover={() => setSceneMountKey((k) => k + 1)}>
      <ARViewportCanvasInner key={sceneMountKey} {...props} />
    </SceneErrorBoundary>
  );
}
