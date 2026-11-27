import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  computeRotatedBoxDimensions,
  extractSculptureBaseDimensions,
  extractSculptureRotation,
  extractSculptureScale,
  tiltToRadians,
  yawToRadians
} from '../../../shared/sculpturePlacement.mjs';
import { formatShortLength } from '../utils/measurementUnits.js';
import { api, resolveApiUrl } from '../utils/api.js';
import {
  enforceCrispTexturesAndShading,
  loadCustomModelObject
} from '../utils/customModelLoader.js';
import {
  computeInsideLandModelFraming,
  computeIsometricLandFraming,
  computeIsometricModelFraming,
  ISOMETRIC_PREVIEW_FOV_DEG
} from '../utils/isometricCameraFraming.js';
import {
  createDepthFadedThreeBoxWireframe,
  updateThreeWireframeDepthFade
} from '../utils/prismDepthFade.js';
import {
  buildVoxelGroup,
  disposeObject3D,
  VOXEL_STEP
} from './VoxelEngine3D.js';

function clearGroup(group) {
  if (!group) return;
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child);
  }
}

function normalizeYawDeg(deg) {
  let d = Number(deg || 0);
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.round(d);
}

function applyGhostMaterialToObject3D(
  rootObj,
  { tintHex = 0x60a5fa, opacity = 0.36, emissiveIntensity = 0.32 } = {}
) {
  const ghostMaterials = [];
  if (!rootObj) return ghostMaterials;
  const tintColor = new THREE.Color(tintHex);

  const convertMat = (orig) => {
    const baseColor = orig?.color?.clone ? orig.color.clone() : new THREE.Color(0xcbd5e1);
    baseColor.lerp(tintColor, 0.38);
    const ghostMat = new THREE.MeshStandardMaterial({
      color: baseColor,
      map: orig?.map || null,
      alphaMap: orig?.alphaMap || null,
      vertexColors: Boolean(orig?.vertexColors),
      transparent: true,
      opacity,
      depthWrite: false,
      emissive: tintColor.clone(),
      emissiveIntensity,
      roughness: 0.45,
      metalness: 0.08,
      side: THREE.DoubleSide
    });
    ghostMaterials.push(ghostMat);
    return ghostMat;
  };

  rootObj.traverse((node) => {
    if (!node?.isMesh) return;
    node.castShadow = false;
    node.receiveShadow = false;
    node.renderOrder = 2;
    const prevMat = node.material;
    if (Array.isArray(prevMat)) {
      node.material = prevMat.map((m) => {
        const next = convertMat(m);
        if (m && typeof m.dispose === 'function') m.dispose();
        return next;
      });
    } else if (prevMat) {
      node.material = convertMat(prevMat);
      if (typeof prevMat.dispose === 'function') prevMat.dispose();
    } else {
      node.material = convertMat(null);
    }
  });
  return ghostMaterials;
}

function updateGhostMaterialsStyle(materials, { tintHex, opacity, emissiveIntensity }) {
  if (!Array.isArray(materials) || materials.length === 0) return;
  for (const mat of materials) {
    if (!mat) continue;
    if (mat.emissive && tintHex !== undefined) {
      mat.emissive.setHex(tintHex);
    }
    if (opacity !== undefined) {
      mat.opacity = opacity;
    }
    if (emissiveIntensity !== undefined) {
      mat.emissiveIntensity = emissiveIntensity;
    }
  }
}

function buildSiblingGeometrySignature(sib) {
  const sc = sib?.sculpture || null;
  if (!sc) return `${sib?.id || ''}|box`;
  const fmt = sc.customModel?.format || '';
  const cid = sc.customModel?.ipfsCid || '';
  const dl = sc.customModel?.downloadUrl || sc.modelGlbUrl || '';
  const rotY = Number(sc.customModel?.rotationY || 0);
  const voxLen = Array.isArray(sc.voxels) ? sc.voxels.length : 0;
  const voxCnt = Number(sc.voxelCount || 0);
  return `${sc.id || sib.id}|${fmt}|${cid}|${dl}|${rotY}|${voxLen}|${voxCnt}`;
}

export default function SculptureViewer3D({
  sculpture = null,
  voxels = [],
  height = 300,
  fillHeight = false,
  autoRotate = true,
  isometricFocus = false,
  cameraFocus = 'model', // 'model' | 'land'
  resetViewTick = 0,
  liveCursor = null,
  liveQuaternion = null,
  liveTransform = null,
  parcelVolume = null,
  siblingBoxes = [],
  showLandBounds = false,
  showEditGizmo = false,
  maxSafeScale = 60,
  moveRanges = null,
  placementBlocked = false,
  unitSystem = 'imperial',
  cornerTopLeftExtra = null,
  cornerTopRight = null,
  cornerBottomLeft = null,
  onModelBoundsMeasured = null,
  onTransformStart = null,
  onTransformChange = null,
  onSelectSibling = null,
  switchingSiblingId = ''
}) {
  const hostRef = useRef(null);
  const groupRef = useRef(null);
  const modelRotatorRef = useRef(null);
  const modelContentRef = useRef(null);
  const landOverlayRef = useRef(null);
  const siblingOverlayRef = useRef(null);
  const siblingGhostGroupRef = useRef(null);
  const siblingGhostEntriesRef = useRef(new Map());
  const siblingHitMeshesRef = useRef([]);
  const gizmoOverlayRef = useRef(null);
  const gizmoHitMeshesRef = useRef([]);
  const cursorRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const gridRef = useRef(null);
  const shadowGroundRef = useRef(null);
  const keyLightRef = useRef(null);
  const maxAnisotropyRef = useRef(8);
  const modelBaseSizeRef = useRef({ width: 1.4, height: 1.4, depth: 1.4 });
  const framedModeKeyRef = useRef('');
  const prevModelCenterRef = useRef(null);
  const resizeCanvasRef = useRef(null);
  const heightRef = useRef(height);
  heightRef.current = height;
  const fillHeightRef = useRef(fillHeight);
  fillHeightRef.current = fillHeight;
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const isometricFocusRef = useRef(isometricFocus);
  isometricFocusRef.current = isometricFocus;
  const [gizmoStatusText, setGizmoStatusText] = useState('');
  const [modelBoundsVersion, setModelBoundsVersion] = useState(0);
  const [ghostMeshVersion, setGhostMeshVersion] = useState(0);
  const [hoveredSibling, setHoveredSibling] = useState(null);
  const hoveredSiblingRef = useRef(null);
  hoveredSiblingRef.current = hoveredSibling;
  const [modelStatus, setModelStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'
  const [modelErrorMsg, setModelErrorMsg] = useState('');
  const [dblClickFocusTick, setDblClickFocusTick] = useState(0);

  const onModelBoundsMeasuredRef = useRef(onModelBoundsMeasured);
  onModelBoundsMeasuredRef.current = onModelBoundsMeasured;
  const onTransformStartRef = useRef(onTransformStart);
  onTransformStartRef.current = onTransformStart;
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
  const onSelectSiblingRef = useRef(onSelectSibling);
  onSelectSiblingRef.current = onSelectSibling;
  const liveTransformRef = useRef(liveTransform);
  liveTransformRef.current = liveTransform;
  const showEditGizmoRef = useRef(showEditGizmo);
  showEditGizmoRef.current = showEditGizmo;
  const showLandBoundsRef = useRef(showLandBounds);
  showLandBoundsRef.current = showLandBounds;
  const maxSafeScaleRef = useRef(maxSafeScale);
  maxSafeScaleRef.current = maxSafeScale;
  const moveRangesRef = useRef(moveRanges);
  moveRangesRef.current = moveRanges;
  const sculptureRef = useRef(sculpture);
  sculptureRef.current = sculpture;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090d18');

    const measureViewport = () => {
      const w = Math.max(220, host.clientWidth || Math.min(640, (window.innerWidth || 640) - 48));
      const fallbackH = typeof heightRef.current === 'number' ? heightRef.current : 320;
      const h = fillHeightRef.current
        ? Math.max(220, host.clientHeight || fallbackH)
        : Math.max(160, fallbackH);
      return { w, h };
    };

    const { w: initWidth, h: initHeight } = measureViewport();
    const initFov = isometricFocusRef.current ? ISOMETRIC_PREVIEW_FOV_DEG : 42;
    const camera = new THREE.PerspectiveCamera(initFov, initWidth / initHeight, 0.02, 800);
    camera.position.set(2.4, 1.8, 2.4);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4));
    renderer.setSize(initWidth, initHeight, false);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.maxWidth = '100%';
    renderer.domElement.style.height = fillHeightRef.current ? '100%' : `${initHeight}px`;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    maxAnisotropyRef.current = renderer.capabilities?.getMaxAnisotropy?.() || 8;
    host.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envRT = pmremGenerator.fromScene(roomEnv, 0.04);
    roomEnv.dispose();
    scene.environment = envRT.texture;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.zoomSpeed = 1.2;
    controls.minDistance = 0.12;
    controls.maxDistance = 360;
    controls.autoRotate = Boolean(autoRotateRef.current);
    controls.autoRotateSpeed = 1.4;

    scene.add(new THREE.HemisphereLight(0xd9f0ff, 0x1e2438, 0.85));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(4, 7, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 220;
    keyLight.shadow.camera.left = -8;
    keyLight.shadow.camera.right = 8;
    keyLight.shadow.camera.top = 8;
    keyLight.shadow.camera.bottom = -8;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);
    scene.add(keyLight.target);
    const rimLight = new THREE.DirectionalLight(0x00f5d4, 0.45);
    rimLight.position.set(-4, -2, -4);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(6, 24, 0x00f5d4, 0x1e2842);
    grid.position.y = -0.02;
    scene.add(grid);

    const shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.ShadowMaterial({ opacity: 0.45 })
    );
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = -0.019;
    shadowGround.receiveShadow = true;
    scene.add(shadowGround);

    const modelPivot = new THREE.Group();
    const modelRotator = new THREE.Group();
    modelRotator.rotation.order = 'YXZ';
    const modelContent = new THREE.Group();
    modelRotator.add(modelContent);
    modelPivot.add(modelRotator);
    scene.add(modelPivot);

    const landOverlay = new THREE.Group();
    scene.add(landOverlay);

    const siblingOverlay = new THREE.Group();
    scene.add(siblingOverlay);

    const siblingGhostGroup = new THREE.Group();
    scene.add(siblingGhostGroup);
    const siblingGhostEntries = siblingGhostEntriesRef.current;

    const gizmoOverlay = new THREE.Group();
    scene.add(gizmoOverlay);

    const cursorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(VOXEL_STEP * 1.1, VOXEL_STEP * 1.1, VOXEL_STEP * 1.1),
      new THREE.MeshBasicMaterial({ color: 0xff3e7f, wireframe: true })
    );
    cursorMesh.visible = false;
    scene.add(cursorMesh);

    groupRef.current = modelPivot;
    modelRotatorRef.current = modelRotator;
    modelContentRef.current = modelContent;
    landOverlayRef.current = landOverlay;
    siblingOverlayRef.current = siblingOverlay;
    siblingGhostGroupRef.current = siblingGhostGroup;
    gizmoOverlayRef.current = gizmoOverlay;
    cursorRef.current = cursorMesh;
    cameraRef.current = camera;
    controlsRef.current = controls;
    gridRef.current = grid;
    shadowGroundRef.current = shadowGround;
    keyLightRef.current = keyLight;

    // Interactive 3D Artwork Gizmo Pointer Dragging + Clickable Scene Ghost Selection
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const hitPoint = new THREE.Vector3();
    let dragState = null;
    let pendingGhostClick = null;

    const toNdc = (evt) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      pointerNdc.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
      return true;
    };

    const getGizmoCursor = (role) => {
      if (role === 'scale') return 'nwse-resize';
      if (role === 'move') return 'move';
      if (role === 'rotate') return 'grab';
      if (role === 'height') return 'ns-resize';
      return '';
    };

    const pickSiblingGhostHit = () => {
      if (!showLandBoundsRef.current) return null;
      const ghostTargets = siblingHitMeshesRef.current;
      if (!ghostTargets || ghostTargets.length === 0) return null;
      const ghostHits = raycaster.intersectObjects(ghostTargets, false);
      const ud = ghostHits?.[0]?.object?.userData;
      if (!ud?.siblingId) return null;
      return {
        id: ud.siblingId,
        title: ud.siblingTitle || 'Artwork',
        canEdit: Boolean(ud.canEdit)
      };
    };

    const updateHoveredSibling = (nextHover) => {
      const prev = hoveredSiblingRef.current;
      if (
        (prev?.id || '') === (nextHover?.id || '') &&
        Boolean(prev?.canEdit) === Boolean(nextHover?.canEdit)
      ) {
        return;
      }
      hoveredSiblingRef.current = nextHover;
      setHoveredSibling(nextHover);
    };

    const onPointerDown = (evt) => {
      pendingGhostClick = null;
      if (!toNdc(evt)) return;
      raycaster.setFromCamera(pointerNdc, camera);

      // 1) Gizmo handles always take priority over ghost clicking
      if (showEditGizmoRef.current && onTransformChangeRef.current) {
        const targets = gizmoHitMeshesRef.current;
        if (targets && targets.length > 0) {
          const hits = raycaster.intersectObjects(targets, false);
          const hit = hits?.[0];
          const role = hit?.object?.userData?.gizmoRole;
          if (role) {
            evt.stopPropagation();
            onTransformStartRef.current?.(role);
            const lt = liveTransformRef.current || {};
            const startDx = Number(lt.dx || 0);
            const startDy = Math.max(0, Number(lt.dy || 0));
            const startDz = Number(lt.dz || 0);
            const startYaw = Number(lt.yaw || 0);
            const startScale = Math.max(
              0.001,
              Number(lt.scale ?? extractSculptureScale(sculptureRef.current) ?? 1)
            );
            const baseX = showLandBoundsRef.current ? Number(lt.baseX || 0) : 0;
            const baseZ = showLandBoundsRef.current ? Number(lt.baseZ || 0) : 0;
            const pivotX = showLandBoundsRef.current ? baseX + startDx : 0;
            const pivotY = showLandBoundsRef.current ? startDy : 0;
            const pivotZ = showLandBoundsRef.current ? baseZ + startDz : 0;

            if (role === 'height') {
              const camDir = new THREE.Vector3();
              camera.getWorldDirection(camDir);
              camDir.y = 0;
              if (camDir.lengthSq() < 1e-4) camDir.set(0, 0, 1);
              camDir.normalize();
              dragPlane.setFromNormalAndCoplanarPoint(
                camDir,
                new THREE.Vector3(pivotX, hit.point.y, pivotZ)
              );
            } else {
              dragPlane.setFromNormalAndCoplanarPoint(
                new THREE.Vector3(0, 1, 0),
                new THREE.Vector3(pivotX, pivotY, pivotZ)
              );
            }

            const startPt = new THREE.Vector3();
            if (!raycaster.ray.intersectPlane(dragPlane, startPt)) {
              startPt.copy(hit.point);
            }

            const startDist = Math.hypot(startPt.x - pivotX, startPt.z - pivotZ);
            const startAngle = Math.atan2(startPt.x - pivotX, startPt.z - pivotZ);

            dragState = {
              pointerId: evt.pointerId,
              role,
              startDx,
              startDy,
              startDz,
              startYaw,
              startScale,
              pivotX,
              pivotY,
              pivotZ,
              startPt: startPt.clone(),
              startDist: Math.max(0.15, startDist),
              startAngle
            };

            controls.enabled = false;
            controls.autoRotate = false;
            try {
              renderer.domElement.setPointerCapture(evt.pointerId);
            } catch {
              // ignore if unsupported in headless env
            }
            renderer.domElement.style.cursor = role === 'rotate' ? 'grabbing' : getGizmoCursor(role);
            setGizmoStatusText(
              role === 'scale'
                ? `Scaling: ${startScale.toFixed(2)}×`
                : role === 'move'
                ? `Moving: X ${startDx.toFixed(1)}m · Z ${startDz.toFixed(1)}m`
                : role === 'rotate'
                ? `Rotating: ${Math.round(startYaw)}°`
                : `Height: ${startDy.toFixed(2)}m`
            );
            return;
          }
        }
      }

      // 2) Candidate click on an editable scene ghost (still allows camera orbit if dragged >= 6px)
      if (evt.button === 0 && onSelectSiblingRef.current) {
        const ghostHit = pickSiblingGhostHit();
        if (ghostHit?.canEdit) {
          pendingGhostClick = {
            pointerId: evt.pointerId,
            siblingId: ghostHit.id,
            clientX: evt.clientX,
            clientY: evt.clientY
          };
        }
      }
    };

    const onPointerMove = (evt) => {
      if (!toNdc(evt)) return;
      raycaster.setFromCamera(pointerNdc, camera);

      if (!dragState) {
        if (pendingGhostClick) {
          const moved = Math.hypot(
            evt.clientX - pendingGhostClick.clientX,
            evt.clientY - pendingGhostClick.clientY
          );
          if (moved >= 6) pendingGhostClick = null;
        }
        if (showEditGizmoRef.current) {
          const targets = gizmoHitMeshesRef.current;
          if (targets && targets.length > 0) {
            const hits = raycaster.intersectObjects(targets, false);
            const role = hits?.[0]?.object?.userData?.gizmoRole || '';
            if (role) {
              updateHoveredSibling(null);
              renderer.domElement.style.cursor = getGizmoCursor(role);
              return;
            }
          }
        }
        const ghostHit = pickSiblingGhostHit();
        updateHoveredSibling(ghostHit);
        renderer.domElement.style.cursor =
          ghostHit?.canEdit && onSelectSiblingRef.current ? 'pointer' : '';
        return;
      }

      if (!raycaster.ray.intersectPlane(dragPlane, hitPoint)) return;

      const ranges = moveRangesRef.current;
      const capScale = Math.max(0.2, Number(maxSafeScaleRef.current || 60));

      if (dragState.role === 'scale') {
        const curDist = Math.hypot(hitPoint.x - dragState.pivotX, hitPoint.z - dragState.pivotZ);
        const ratio = Math.max(0.15, curDist / dragState.startDist);
        const nextScale = Math.max(
          0.001,
          Math.min(capScale, Math.round(dragState.startScale * ratio * 1000) / 1000)
        );
        setGizmoStatusText(`Scaling: ${nextScale.toFixed(2)}×`);
        onTransformChangeRef.current?.({ scale: nextScale });
      } else if (dragState.role === 'move') {
        const deltaX = hitPoint.x - dragState.startPt.x;
        const deltaZ = hitPoint.z - dragState.startPt.z;
        let nextDx = Math.round((dragState.startDx + deltaX) * 100) / 100;
        let nextDz = Math.round((dragState.startDz + deltaZ) * 100) / 100;
        if (ranges) {
          nextDx = Math.max(ranges.minDx, Math.min(ranges.maxDx, nextDx));
          nextDz = Math.max(ranges.minDz, Math.min(ranges.maxDz, nextDz));
        }
        setGizmoStatusText(`Moving: X ${nextDx.toFixed(1)}m · Z ${nextDz.toFixed(1)}m`);
        onTransformChangeRef.current?.({ dx: nextDx, dz: nextDz });
      } else if (dragState.role === 'rotate') {
        const curAngle = Math.atan2(hitPoint.x - dragState.pivotX, hitPoint.z - dragState.pivotZ);
        const deltaDeg = ((curAngle - dragState.startAngle) * 180) / Math.PI;
        const nextYaw = normalizeYawDeg(dragState.startYaw + deltaDeg);
        setGizmoStatusText(`Rotating: ${nextYaw}°`);
        onTransformChangeRef.current?.({ yaw: nextYaw });
      } else if (dragState.role === 'height') {
        const deltaY = hitPoint.y - dragState.startPt.y;
        const maxDy = ranges ? Math.max(0.5, Number(ranges.maxDy || 12)) : 24;
        const nextDy = Math.max(
          0,
          Math.min(maxDy, Math.round((dragState.startDy + deltaY) * 100) / 100)
        );
        setGizmoStatusText(`Height: ${nextDy.toFixed(2)}m`);
        onTransformChangeRef.current?.({ dy: nextDy });
      }
    };

    const endDrag = (evt) => {
      if (pendingGhostClick && evt?.type === 'pointerup') {
        const moved = Math.hypot(
          (evt.clientX ?? pendingGhostClick.clientX) - pendingGhostClick.clientX,
          (evt.clientY ?? pendingGhostClick.clientY) - pendingGhostClick.clientY
        );
        const clickedSiblingId = pendingGhostClick.siblingId;
        pendingGhostClick = null;
        if (moved < 6 && clickedSiblingId) {
          onSelectSiblingRef.current?.(clickedSiblingId);
        }
      } else {
        pendingGhostClick = null;
      }
      if (!dragState) return;
      try {
        renderer.domElement.releasePointerCapture(dragState.pointerId);
      } catch {
        // ignore
      }
      dragState = null;
      controls.enabled = true;
      renderer.domElement.style.cursor = '';
      setGizmoStatusText('');
    };

    const onPointerLeave = () => {
      pendingGhostClick = null;
      updateHoveredSibling(null);
      if (!dragState) renderer.domElement.style.cursor = '';
    };

    const onDoubleClick = (evt) => {
      if (dragState) return;
      if (showEditGizmoRef.current && toNdc(evt)) {
        const targets = gizmoHitMeshesRef.current;
        if (targets && targets.length > 0) {
          raycaster.setFromCamera(pointerNdc, camera);
          if (raycaster.intersectObjects(targets, false).length > 0) return;
        }
      }
      setDblClickFocusTick((t) => t + 1);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', endDrag);
    renderer.domElement.addEventListener('pointercancel', endDrag);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);

    const handleResize = () => {
      if (!host) return;
      const { w, h } = measureViewport();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      renderer.domElement.style.height = fillHeightRef.current ? '100%' : `${h}px`;
    };
    resizeCanvasRef.current = handleResize;
    window.addEventListener('resize', handleResize);
    let resizeObs = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => handleResize());
      resizeObs.observe(host);
    }

    let rafId = 0;
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      controls.update();
      updateThreeWireframeDepthFade(landOverlay, camera.position);
      updateThreeWireframeDepthFade(gizmoOverlay, camera.position);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(rafId);
      resizeCanvasRef.current = null;
      window.removeEventListener('resize', handleResize);
      resizeObs?.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', endDrag);
      renderer.domElement.removeEventListener('pointercancel', endDrag);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('dblclick', onDoubleClick);
      clearGroup(modelContent);
      clearGroup(landOverlay);
      clearGroup(siblingOverlay);
      clearGroup(siblingGhostGroup);
      siblingGhostEntries.clear();
      siblingHitMeshesRef.current = [];
      clearGroup(gizmoOverlay);
      gizmoHitMeshesRef.current = [];
      controls.dispose();
      envRT.dispose();
      pmremGenerator.dispose();
      shadowGround.geometry.dispose();
      shadowGround.material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
      groupRef.current = null;
      modelRotatorRef.current = null;
      modelContentRef.current = null;
      landOverlayRef.current = null;
      siblingOverlayRef.current = null;
      siblingGhostGroupRef.current = null;
      gizmoOverlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    resizeCanvasRef.current?.();
  }, [height, fillHeight]);

  // Load 3D geometry ONCE per model / voxel update at base scale = 1 (zero reload while sliding scale/move)
  const scId = sculpture?.id || '';
  const scFormat = sculpture?.customModel?.format || '';
  const scCid = sculpture?.customModel?.ipfsCid || '';
  const scDownloadUrl = sculpture?.customModel?.downloadUrl || sculpture?.modelGlbUrl || '';
  const scRotY = Number(sculpture?.customModel?.rotationY || 0);

  useEffect(() => {
    const content = modelContentRef.current;
    if (!content) return undefined;
    clearGroup(content);
    framedModeKeyRef.current = '';

    if (scFormat && sculpture) {
      let cancelled = false;
      setModelStatus('loading');
      setModelErrorMsg('');
      loadCustomModelObject(sculpture, resolveApiUrl, {
        maxAnisotropy: maxAnisotropyRef.current,
        applyCustomScale: false
      })
        .then((loaded) => {
          if (cancelled || !loaded || !modelContentRef.current) {
            if (loaded?.object3d) disposeObject3D(loaded.object3d);
            return;
          }
          enforceCrispTexturesAndShading(loaded.object3d, maxAnisotropyRef.current);
          clearGroup(modelContentRef.current);
          modelContentRef.current.add(loaded.object3d);

          const baseDims = loaded.baseSize || { width: 1.4, height: 1.4, depth: 1.4 };
          modelBaseSizeRef.current = baseDims;
          setModelBoundsVersion((v) => v + 1);
          setModelStatus('ready');
          setModelErrorMsg('');
          onModelBoundsMeasuredRef.current?.(baseDims);
        })
        .catch((err) => {
          if (cancelled) return;
          setModelStatus('error');
          setModelErrorMsg(err?.message || `Unable to load ${scFormat.toUpperCase()} 3D model`);
        });
      return () => {
        cancelled = true;
      };
    }

    setModelStatus('ready');
    setModelErrorMsg('');

    const meshGroup = buildVoxelGroup(voxels);
    const rawBox = new THREE.Box3().setFromObject(meshGroup);
    if (!rawBox.isEmpty()) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      rawBox.getSize(size);
      rawBox.getCenter(center);
      // Ground-align voxel geometry cleanly so bottom sits at y = 0 and XZ centered at (0, 0)
      meshGroup.position.set(-center.x, -rawBox.min.y, -center.z);
      const baseDims = {
        width: Math.max(0.08, Math.round(size.x * 10000) / 10000),
        height: Math.max(0.08, Math.round(size.y * 10000) / 10000),
        depth: Math.max(0.08, Math.round(size.z * 10000) / 10000)
      };
      modelBaseSizeRef.current = baseDims;
      setModelBoundsVersion((v) => v + 1);
      onModelBoundsMeasuredRef.current?.(baseDims);
    }
    content.add(meshGroup);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scId, scFormat, scCid, scDownloadUrl, scRotY, voxels, liveCursor]);

  // Load real 3D translucent ghost meshes ONCE per sibling set (never reloads during slider/gizmo drags)
  const siblingSignaturesKey = (siblingBoxes || [])
    .map((sib) => buildSiblingGeometrySignature(sib))
    .join('||');
  const siblingBoxesForLoadRef = useRef(siblingBoxes);
  siblingBoxesForLoadRef.current = siblingBoxes;

  useEffect(() => {
    const ghostGroup = siblingGhostGroupRef.current;
    if (!ghostGroup) return undefined;
    const entries = siblingGhostEntriesRef.current;

    if (!showLandBounds) {
      ghostGroup.visible = false;
      return undefined;
    }
    ghostGroup.visible = true;

    const currentSibs = Array.isArray(siblingBoxesForLoadRef.current)
      ? siblingBoxesForLoadRef.current
      : [];
    const wantedById = new Map();
    for (const sib of currentSibs) {
      if (!sib?.id) continue;
      wantedById.set(sib.id, { sib, sig: buildSiblingGeometrySignature(sib) });
    }

    // Dispose removed or changed siblings
    for (const [id, entry] of entries.entries()) {
      const wanted = wantedById.get(id);
      if (!wanted || wanted.sig !== entry.signature) {
        entry.disposed = true;
        ghostGroup.remove(entry.pivot);
        disposeObject3D(entry.pivot);
        entries.delete(id);
      }
    }

    let cancelled = false;
    const attachVoxelGhost = (entry, rawVoxels) => {
      if (cancelled || entry.disposed) return;
      if (!Array.isArray(rawVoxels) || rawVoxels.length === 0) return;
      const voxGroup = buildVoxelGroup(rawVoxels);
      const rawBox = new THREE.Box3().setFromObject(voxGroup);
      if (rawBox.isEmpty()) {
        disposeObject3D(voxGroup);
        return;
      }
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      rawBox.getSize(size);
      rawBox.getCenter(center);
      voxGroup.position.set(-center.x, -rawBox.min.y, -center.z);
      const ghostMaterials = applyGhostMaterialToObject3D(voxGroup, {
        tintHex: 0x60a5fa,
        opacity: 0.36,
        emissiveIntensity: 0.32
      });
      clearGroup(entry.content);
      entry.content.add(voxGroup);
      entry.ghostMaterials = ghostMaterials;
      entry.baseSize = {
        width: Math.max(0.08, Math.round(size.x * 10000) / 10000),
        height: Math.max(0.08, Math.round(size.y * 10000) / 10000),
        depth: Math.max(0.08, Math.round(size.z * 10000) / 10000)
      };
      entry.hasRealMesh = true;
      setGhostMeshVersion((v) => v + 1);
    };

    for (const [id, { sib, sig }] of wantedById.entries()) {
      if (entries.has(id)) continue;
      const sibSc = sib.sculpture || null;
      const pivot = new THREE.Group();
      const rotator = new THREE.Group();
      rotator.rotation.order = 'YXZ';
      const content = new THREE.Group();
      rotator.add(content);
      pivot.add(rotator);
      pivot.visible = false;
      ghostGroup.add(pivot);

      const entry = {
        id,
        signature: sig,
        pivot,
        rotator,
        content,
        ghostMaterials: [],
        baseSize: extractSculptureBaseDimensions(sibSc),
        hasRealMesh: false,
        disposed: false
      };
      entries.set(id, entry);

      const sibFormat = sibSc?.customModel?.format || '';
      if (sibFormat && sibSc) {
        loadCustomModelObject(sibSc, resolveApiUrl, {
          maxAnisotropy: Math.min(4, maxAnisotropyRef.current),
          applyCustomScale: false
        })
          .then((loaded) => {
            if (cancelled || entry.disposed || !loaded?.object3d) {
              if (loaded?.object3d) disposeObject3D(loaded.object3d);
              return;
            }
            const ghostMaterials = applyGhostMaterialToObject3D(loaded.object3d, {
              tintHex: 0x60a5fa,
              opacity: 0.36,
              emissiveIntensity: 0.32
            });
            clearGroup(entry.content);
            entry.content.add(loaded.object3d);
            entry.ghostMaterials = ghostMaterials;
            entry.baseSize = loaded.baseSize || entry.baseSize;
            entry.hasRealMesh = true;
            setGhostMeshVersion((v) => v + 1);
          })
          .catch(() => {
            // Keep translucent ghost bounding volume fallback
          });
      } else if (Array.isArray(sibSc?.voxels) && sibSc.voxels.length > 0) {
        attachVoxelGhost(entry, sibSc.voxels);
      } else if (sibSc?.id && Number(sibSc.voxelCount || 0) > 0) {
        api
          .getSculpture(sibSc.id)
          .then((res) => {
            if (cancelled || entry.disposed) return;
            if (Array.isArray(res?.sculpture?.voxels) && res.sculpture.voxels.length > 0) {
              attachVoxelGhost(entry, res.sculpture.voxels);
            }
          })
          .catch(() => {});
      }
    }

    return () => {
      cancelled = true;
    };
  }, [siblingSignaturesKey, showLandBounds]);

  // Clear hover badge if hovered sibling disappears or becomes the active edited sculpture
  useEffect(() => {
    if (!hoveredSibling?.id) return;
    if (!showLandBounds || !(siblingBoxes || []).some((s) => s.id === hoveredSibling.id)) {
      setHoveredSibling(null);
    }
  }, [hoveredSibling?.id, showLandBounds, siblingBoxes]);

  // Fast 60fps transform, land-bounds wireframe, sibling ghost transforms & 3D artwork gizmo bars/points
  useEffect(() => {
    const pivot = groupRef.current;
    const rotator = modelRotatorRef.current;
    const content = modelContentRef.current;
    const landOverlay = landOverlayRef.current;
    const siblingOverlay = siblingOverlayRef.current;
    const gizmoOverlay = gizmoOverlayRef.current;
    if (!pivot || !rotator || !content || !landOverlay || !siblingOverlay || !gizmoOverlay) return;

    const effScale = Math.max(
      0.001,
      Number(liveTransform?.scale ?? extractSculptureScale(sculpture) ?? 1)
    );
    const savedRot = extractSculptureRotation(sculpture);
    const yawDeg = liveTransform?.yaw !== undefined ? Number(liveTransform.yaw) : savedRot.yaw;
    const pitchDeg =
      liveTransform?.pitch !== undefined ? Number(liveTransform.pitch) : savedRot.pitch;
    const rollDeg = liveTransform?.roll !== undefined ? Number(liveTransform.roll) : savedRot.roll;
    const yawRad = yawToRadians(yawDeg);
    const pitchRad = tiltToRadians(pitchDeg);
    const rollRad = tiltToRadians(rollDeg);

    const baseDims = modelBaseSizeRef.current || { width: 1.4, height: 1.4, depth: 1.4 };
    const unscaledYawLocal = computeRotatedBoxDimensions({
      width: baseDims.width,
      height: baseDims.height,
      depth: baseDims.depth,
      yaw: 0,
      pitch: pitchDeg,
      roll: rollDeg,
      scale: 1
    });

    // Rotate around the sculpture's 3D centroid and seat its rotated bottom flush on y = dy
    content.position.set(0, -baseDims.height / 2, 0);
    rotator.rotation.order = 'YXZ';
    rotator.rotation.set(pitchRad, yawRad, rollRad);
    rotator.position.set(0, unscaledYawLocal.effH / 2, 0);

    pivot.scale.setScalar(effScale);
    pivot.rotation.set(0, 0, 0);

    clearGroup(landOverlay);
    clearGroup(siblingOverlay);
    clearGroup(gizmoOverlay);
    gizmoHitMeshesRef.current = [];
    siblingHitMeshesRef.current = [];

    const hasLand =
      showLandBounds &&
      parcelVolume &&
      Number(parcelVolume.widthMeters) > 0 &&
      Number(parcelVolume.depthMeters) > 0 &&
      Number(parcelVolume.heightMeters) > 0;
    if (siblingGhostGroupRef.current) {
      siblingGhostGroupRef.current.visible = Boolean(hasLand);
    }

    if (controlsRef.current) {
      controlsRef.current.autoRotate = hasLand || showEditGizmo ? false : autoRotate;
    }

    const baseX = hasLand ? Number(liveTransform?.baseX || 0) : 0;
    const baseZ = hasLand ? Number(liveTransform?.baseZ || 0) : 0;
    const dx = hasLand ? Number(liveTransform?.dx || 0) : 0;
    const dy = hasLand ? Math.max(0, Number(liveTransform?.dy || 0)) : 0;
    const dz = hasLand ? Number(liveTransform?.dz || 0) : 0;

    pivot.position.set(baseX + dx, dy, baseZ + dz);

    const footW = Math.max(0.32, unscaledYawLocal.effW * effScale);
    const footH = Math.max(0.32, unscaledYawLocal.effH * effScale);
    const footD = Math.max(0.32, unscaledYawLocal.effD * effScale);

    // 0) Interactive 3D Bars & Drag Points (matching Land Builder handles) directly around the artwork!
    if (showEditGizmo) {
      const gizmoRoot = new THREE.Group();
      gizmoRoot.position.set(baseX + dx, dy, baseZ + dz);
      gizmoRoot.rotation.y = yawRad;

      const hw = footW / 2;
      const hd = footD / 2;
      const maxSpan = Math.max(footW, footH, footD, 0.8);
      const knobR = Math.max(0.055, Math.min(0.24, maxSpan * 0.055));
      const barR = Math.max(0.022, Math.min(0.08, knobR * 0.42));
      const hitPad = Math.max(0.12, knobR * 2.1);

      const frameColor = placementBlocked ? 0xff4d6d : 0x00f5d4;
      const frameLine = createDepthFadedThreeBoxWireframe(footW, footH, footD, frameColor, {
        nearOpacity: 0.96,
        farOpacity: 0.42
      });
      gizmoRoot.add(frameLine);

      const hitList = [];
      const invisibleHitMat = new THREE.MeshBasicMaterial({ visible: false });

      // (A) 4 Glowing Corner Scale Points (gold spheres on the 4 base corners)
      const scaleMat = new THREE.MeshStandardMaterial({
        color: placementBlocked ? 0xff4d6d : 0xffd166,
        emissive: placementBlocked ? 0xff4d6d : 0xffb703,
        emissiveIntensity: 0.65,
        roughness: 0.25,
        metalness: 0.2
      });
      const cornerCoords = [
        [-hw, hd],
        [hw, hd],
        [hw, -hd],
        [-hw, -hd]
      ];
      for (const [cx, cz] of cornerCoords) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(knobR, 16, 14), scaleMat);
        dot.position.set(cx, knobR * 0.6, cz);
        gizmoRoot.add(dot);

        const hit = new THREE.Mesh(new THREE.SphereGeometry(hitPad, 10, 8), invisibleHitMat);
        hit.position.copy(dot.position);
        hit.userData = { gizmoRole: 'scale' };
        gizmoRoot.add(hit);
        hitList.push(hit);
      }

      // (B) 4 Glowing Side Move Bars along the 4 bottom edges (cyan bars like Land Builder sides)
      const moveMat = new THREE.MeshStandardMaterial({
        color: 0x00f5d4,
        emissive: 0x00c9b1,
        emissiveIntensity: 0.55,
        roughness: 0.3,
        metalness: 0.2
      });
      const sideEdgeDefs = [
        { x: 0, z: hd, len: Math.max(0.18, footW * 0.56), rotZ: Math.PI / 2, rotX: 0 },
        { x: 0, z: -hd, len: Math.max(0.18, footW * 0.56), rotZ: Math.PI / 2, rotX: 0 },
        { x: hw, z: 0, len: Math.max(0.18, footD * 0.56), rotZ: 0, rotX: Math.PI / 2 },
        { x: -hw, z: 0, len: Math.max(0.18, footD * 0.56), rotZ: 0, rotX: Math.PI / 2 }
      ];
      for (const edge of sideEdgeDefs) {
        const bar = new THREE.Mesh(
          new THREE.CylinderGeometry(barR, barR, edge.len, 10),
          moveMat
        );
        bar.position.set(edge.x, knobR * 0.55, edge.z);
        bar.rotation.set(edge.rotX, 0, edge.rotZ);
        gizmoRoot.add(bar);

        const hitBar = new THREE.Mesh(
          new THREE.CylinderGeometry(hitPad * 0.72, hitPad * 0.72, edge.len + 0.08, 8),
          invisibleHitMat
        );
        hitBar.position.copy(bar.position);
        hitBar.rotation.copy(bar.rotation);
        hitBar.userData = { gizmoRole: 'move' };
        gizmoRoot.add(hitBar);
        hitList.push(hitBar);
      }

      // (C) 4 Vertical Corner Rotation Bars (sky-blue vertical bars along corners)
      const rotMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.5,
        roughness: 0.3,
        metalness: 0.2
      });
      const vertBarH = Math.max(0.2, footH * 0.68);
      for (const [cx, cz] of cornerCoords) {
        const vBar = new THREE.Mesh(
          new THREE.CylinderGeometry(barR * 0.9, barR * 0.9, vertBarH, 10),
          rotMat
        );
        vBar.position.set(cx, footH * 0.52, cz);
        gizmoRoot.add(vBar);

        const hitV = new THREE.Mesh(
          new THREE.CylinderGeometry(hitPad * 0.68, hitPad * 0.68, vertBarH + 0.06, 8),
          invisibleHitMat
        );
        hitV.position.copy(vBar.position);
        hitV.userData = { gizmoRole: 'rotate' };
        gizmoRoot.add(hitV);
        hitList.push(hitV);
      }

      // (D) Top Elevation Stem + Glowing Pink/Magenta Height Point
      const stemLen = Math.max(0.24, Math.min(0.85, maxSpan * 0.24));
      const heightMat = new THREE.MeshStandardMaterial({
        color: 0xff3e7f,
        emissive: 0xd92662,
        emissiveIntensity: 0.65,
        roughness: 0.25,
        metalness: 0.2
      });
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(barR * 0.75, barR * 0.75, stemLen, 10),
        heightMat
      );
      stem.position.set(0, footH + stemLen / 2, 0);
      gizmoRoot.add(stem);

      const topBall = new THREE.Mesh(new THREE.SphereGeometry(knobR * 1.15, 16, 14), heightMat);
      topBall.position.set(0, footH + stemLen + knobR * 0.4, 0);
      gizmoRoot.add(topBall);

      const hitTop = new THREE.Mesh(new THREE.SphereGeometry(hitPad * 1.15, 10, 8), invisibleHitMat);
      hitTop.position.copy(topBall.position);
      hitTop.userData = { gizmoRole: 'height' };
      gizmoRoot.add(hitTop);
      hitList.push(hitTop);

      // (E) Vertical Height Measurement Ruler alongside the rotated artwork (0 -> rotated top)
      const rulerOffset = Math.max(0.14, knobR * 1.4);
      const rulerX = hw + rulerOffset;
      const rulerZ = hd + rulerOffset * 0.4;
      const rulerPts = [
        new THREE.Vector3(rulerX, 0, rulerZ),
        new THREE.Vector3(rulerX, footH, rulerZ)
      ];
      const tickLen = Math.max(0.08, Math.min(0.28, maxSpan * 0.08));
      const tickSteps = 4;
      for (let t = 0; t <= tickSteps; t += 1) {
        const ty = (footH * t) / tickSteps;
        const len = t === 0 || t === tickSteps ? tickLen * 1.35 : tickLen * 0.7;
        rulerPts.push(
          new THREE.Vector3(rulerX - len, ty, rulerZ),
          new THREE.Vector3(rulerX + len * 0.45, ty, rulerZ)
        );
      }
      const rulerGeo = new THREE.BufferGeometry().setFromPoints(rulerPts);
      const rulerLines = new THREE.LineSegments(
        rulerGeo,
        new THREE.LineBasicMaterial({
          color: 0xffd166,
          transparent: true,
          opacity: 0.92
        })
      );
      gizmoRoot.add(rulerLines);

      gizmoOverlay.add(gizmoRoot);
      gizmoHitMeshesRef.current = hitList;
    }

    if (!hasLand) {
      pivot.updateMatrixWorld(true);
      const worldBox = new THREE.Box3().setFromObject(pivot);
      let boxW = footW;
      let boxH = footH;
      let boxD = footD;
      let boxCx = 0;
      let boxCz = 0;
      let boxMinY = 0;
      if (!worldBox.isEmpty()) {
        const wSize = new THREE.Vector3();
        const wCenter = new THREE.Vector3();
        worldBox.getSize(wSize);
        worldBox.getCenter(wCenter);
        boxW = Math.max(0.08, wSize.x);
        boxH = Math.max(0.08, wSize.y);
        boxD = Math.max(0.08, wSize.z);
        boxCx = wCenter.x;
        boxCz = wCenter.z;
        boxMinY = worldBox.min.y;
      }

      const targetFov = isometricFocus ? ISOMETRIC_PREVIEW_FOV_DEG : 42;
      const measuredH = fillHeight
        ? Math.max(220, hostRef.current?.clientHeight || (typeof height === 'number' ? height : 320))
        : Math.max(160, typeof height === 'number' ? height : 300);
      const camAspect =
        cameraRef.current?.aspect ||
        Math.max(0.8, (hostRef.current?.clientWidth || 560) / measuredH);
      const framing = computeIsometricModelFraming({
        width: boxW,
        height: boxH,
        depth: boxD,
        centerX: boxCx,
        centerY: boxMinY + boxH * 0.48,
        centerZ: boxCz,
        minY: boxMinY,
        fovDeg: targetFov,
        aspect: camAspect,
        fillRatio: isometricFocus ? 0.76 : 0.74
      });

      if (gridRef.current) {
        gridRef.current.position.set(boxCx, framing.groundY, boxCz);
        gridRef.current.scale.setScalar(framing.gridScale);
      }
      if (shadowGroundRef.current) {
        shadowGroundRef.current.position.set(boxCx, framing.groundY + 0.002, boxCz);
        shadowGroundRef.current.scale.setScalar(framing.shadowScale);
      }
      if (keyLightRef.current) {
        const span = framing.lightSpan;
        keyLightRef.current.position.set(
          boxCx + span * 0.72,
          framing.target[1] + span * 1.15,
          boxCz + span * 0.82
        );
        keyLightRef.current.target.position.set(framing.target[0], framing.target[1], framing.target[2]);
        keyLightRef.current.shadow.camera.left = -span;
        keyLightRef.current.shadow.camera.right = span;
        keyLightRef.current.shadow.camera.top = span;
        keyLightRef.current.shadow.camera.bottom = -span;
        keyLightRef.current.shadow.camera.updateProjectionMatrix();
      }

      const soloKey = `${isometricFocus ? 'iso' : 'solo'}:${scId}:${modelBoundsVersion}:${resetViewTick}:${dblClickFocusTick}`;
      if (!liveCursor && framedModeKeyRef.current !== soloKey && controlsRef.current && cameraRef.current) {
        framedModeKeyRef.current = soloKey;
        prevModelCenterRef.current = { x: framing.target[0], y: framing.target[1], z: framing.target[2] };
        const cam = cameraRef.current;
        if (Math.abs(cam.fov - framing.fov) > 0.05 || Math.abs(cam.near - framing.near) > 0.005) {
          cam.fov = framing.fov;
          cam.near = framing.near;
          cam.far = framing.far;
          cam.updateProjectionMatrix();
        }
        controlsRef.current.minDistance = framing.minDistance;
        controlsRef.current.maxDistance = framing.maxDistance;
        controlsRef.current.target.set(framing.target[0], framing.target[1], framing.target[2]);
        cam.position.set(framing.position[0], framing.position[1], framing.position[2]);
        controlsRef.current.update();
      }
      return;
    }

    const volW = Number(parcelVolume.widthMeters);
    const volD = Number(parcelVolume.depthMeters);
    const volH = Number(parcelVolume.heightMeters);

    // 1) Land Bounds 3D Wireframe Box + Translucent Floor Plane
    const wireColor = placementBlocked
      ? 0xff4d6d
      : siblingBoxes.some((s) => s.wasPushed)
      ? 0xffd166
      : 0xff1f8f;

    const wireLine = createDepthFadedThreeBoxWireframe(volW, volH, volD, wireColor, {
      nearOpacity: 0.96,
      farOpacity: 0.4
    });
    landOverlay.add(wireLine);
    if (cameraRef.current) {
      updateThreeWireframeDepthFade(landOverlay, cameraRef.current.position);
      updateThreeWireframeDepthFade(gizmoOverlay, cameraRef.current.position);
    }

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(volW, volD),
      new THREE.MeshBasicMaterial({
        color: wireColor,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.004;
    floorMesh.renderOrder = -1;
    landOverlay.add(floorMesh);

    // Target footprint ring directly under the active sculpture (skip duplicate when gizmo frame is visible)
    if (!showEditGizmo) {
      const targetFootGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(footW, 0.04, footD));
      const targetFootLine = new THREE.LineSegments(
        targetFootGeo,
        new THREE.LineBasicMaterial({
          color: placementBlocked ? 0xff4d6d : 0xffd166,
          transparent: true,
          opacity: 0.95
        })
      );
      targetFootLine.position.set(baseX + dx, Math.max(0.02, dy + 0.02), baseZ + dz);
      targetFootLine.rotation.y = yawRad;
      landOverlay.add(targetFootLine);
    }

    // 2) Sibling Artworks on the Same Land — Real 3D Ghost Meshes + Click-to-Edit Hit Volumes
    const ghostHitList = [];
    const ghostHitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hoveredSibId = hoveredSibling?.id || '';
    const ghostEntries = siblingGhostEntriesRef.current;
    const activeSiblingIds = new Set();

    for (const sib of siblingBoxes || []) {
      const b = sib?.box;
      if (!b) continue;
      activeSiblingIds.add(sib.id);
      const sw = Math.max(0.18, Number(b.effW || 0.5));
      const sh = Math.max(0.18, Number(b.effH || 0.5));
      const sd = Math.max(0.18, Number(b.effD || 0.5));
      const isHovered = hoveredSibId === sib.id;
      const canEditSib = Boolean(sib.canEdit);
      const sibColor = sib.isColliding
        ? 0xff4d6d
        : sib.wasPushed
        ? 0xffd166
        : isHovered && canEditSib
        ? 0x00f5d4
        : canEditSib
        ? 0x60a5fa
        : 0x94a3b8;
      const ghostOpacity = sib.isColliding
        ? 0.56
        : isHovered
        ? canEditSib
          ? 0.62
          : 0.44
        : sib.wasPushed
        ? 0.48
        : canEditSib
        ? 0.36
        : 0.24;

      const entry = ghostEntries.get(sib.id);
      if (entry && entry.hasRealMesh) {
        const sibSc = sib.sculpture || null;
        const sibRot = extractSculptureRotation(sibSc);
        const sibScale = Math.max(
          0.001,
          Number(sib.scale ?? extractSculptureScale(sibSc) ?? 1)
        );
        const sibYawDeg = sib.yaw !== undefined ? Number(sib.yaw) : sibRot.yaw;
        const sibPitchDeg = sib.pitch !== undefined ? Number(sib.pitch) : sibRot.pitch;
        const sibRollDeg = sib.roll !== undefined ? Number(sib.roll) : sibRot.roll;
        const sibBase = entry.baseSize || { width: 1, height: 1, depth: 1 };
        const sibUnscaledRot = computeRotatedBoxDimensions({
          width: sibBase.width,
          height: sibBase.height,
          depth: sibBase.depth,
          yaw: 0,
          pitch: sibPitchDeg,
          roll: sibRollDeg,
          scale: 1
        });
        entry.content.position.set(0, -sibBase.height / 2, 0);
        entry.rotator.rotation.order = 'YXZ';
        entry.rotator.rotation.set(
          tiltToRadians(sibPitchDeg),
          yawToRadians(sibYawDeg),
          tiltToRadians(sibRollDeg)
        );
        entry.rotator.position.set(0, sibUnscaledRot.effH / 2, 0);
        entry.pivot.scale.setScalar(sibScale);
        entry.pivot.position.set(b.cx, Math.max(0, Number(b.minY ?? 0)), b.cz);
        entry.pivot.visible = true;

        updateGhostMaterialsStyle(entry.ghostMaterials, {
          tintHex: sibColor,
          opacity: ghostOpacity,
          emissiveIntensity: isHovered ? 0.58 : sib.wasPushed || sib.isColliding ? 0.45 : 0.28
        });

        // Subtle footprint outline (or full wireframe highlight on hover / push / collision)
        if (isHovered || sib.wasPushed || sib.isColliding) {
          const highlightGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(sw, sh, sd));
          const highlightWire = new THREE.LineSegments(
            highlightGeo,
            new THREE.LineBasicMaterial({
              color: sibColor,
              transparent: true,
              opacity: isHovered ? 0.96 : 0.85
            })
          );
          highlightWire.position.set(b.cx, b.cy, b.cz);
          siblingOverlay.add(highlightWire);
        } else {
          const footGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(sw, 0.03, sd));
          const footWire = new THREE.LineSegments(
            footGeo,
            new THREE.LineBasicMaterial({
              color: sibColor,
              transparent: true,
              opacity: canEditSib ? 0.55 : 0.3
            })
          );
          footWire.position.set(b.cx, Math.max(0.015, Number(b.minY ?? 0) + 0.015), b.cz);
          siblingOverlay.add(footWire);
        }
      } else {
        if (entry) entry.pivot.visible = false;
        const sGeo = new THREE.BoxGeometry(sw, sh, sd);
        const sMesh = new THREE.Mesh(
          sGeo,
          new THREE.MeshStandardMaterial({
            color: sibColor,
            transparent: true,
            opacity: isHovered ? 0.42 : sib.wasPushed || sib.isColliding ? 0.34 : 0.2,
            depthWrite: false,
            roughness: 0.4,
            metalness: 0.1
          })
        );
        sMesh.position.set(b.cx, b.cy, b.cz);
        siblingOverlay.add(sMesh);

        const sEdges = new THREE.EdgesGeometry(sGeo);
        const sWire = new THREE.LineSegments(
          sEdges,
          new THREE.LineBasicMaterial({
            color: sibColor,
            transparent: true,
            opacity: isHovered ? 1 : 0.78
          })
        );
        sWire.position.set(b.cx, b.cy, b.cz);
        siblingOverlay.add(sWire);
      }

      // Raycast hit volume for click-to-edit on ghost objects
      const hitMesh = new THREE.Mesh(
        new THREE.BoxGeometry(sw * 1.06, sh * 1.06, sd * 1.06),
        ghostHitMat
      );
      hitMesh.position.set(b.cx, b.cy, b.cz);
      hitMesh.userData = {
        siblingId: sib.id,
        siblingTitle: sib.title || 'Artwork',
        canEdit: canEditSib
      };
      siblingOverlay.add(hitMesh);
      ghostHitList.push(hitMesh);
    }

    for (const [id, entry] of ghostEntries.entries()) {
      if (!activeSiblingIds.has(id)) {
        entry.pivot.visible = false;
      }
    }
    siblingHitMeshesRef.current = ghostHitList;

    // Scale grid & shadow plane to land volume
    const maxHoriz = Math.max(volW, volD, 6);
    if (gridRef.current) {
      gridRef.current.position.set(0, -0.02, 0);
      gridRef.current.scale.setScalar(Math.max(1, maxHoriz / 6));
    }
    if (shadowGroundRef.current) {
      shadowGroundRef.current.position.set(0, -0.015, 0);
      shadowGroundRef.current.scale.setScalar(Math.max(1, maxHoriz / 8));
    }
    if (keyLightRef.current) {
      const span = Math.max(8, Math.max(volW, volD, volH) * 0.9);
      keyLightRef.current.position.set(span * 0.7, Math.max(10, volH * 1.25), span * 0.8);
      keyLightRef.current.target.position.set(0, volH * 0.3, 0);
      keyLightRef.current.shadow.camera.left = -span;
      keyLightRef.current.shadow.camera.right = span;
      keyLightRef.current.shadow.camera.top = span;
      keyLightRef.current.shadow.camera.bottom = -span;
      keyLightRef.current.shadow.camera.updateProjectionMatrix();
    }

    // Compute live model world center inside the land for inside-land focus & smooth follow
    pivot.updateMatrixWorld(true);
    const liveWorldBox = new THREE.Box3().setFromObject(pivot);
    let modelW = footW;
    let modelH = footH;
    let modelD = footD;
    let modelCx = baseX + dx;
    let modelCy = dy + footH * 0.48;
    let modelCz = baseZ + dz;
    let modelMinY = dy;
    if (!liveWorldBox.isEmpty()) {
      const mSize = new THREE.Vector3();
      const mCenter = new THREE.Vector3();
      liveWorldBox.getSize(mSize);
      liveWorldBox.getCenter(mCenter);
      modelW = Math.max(0.18, mSize.x);
      modelH = Math.max(0.18, mSize.y);
      modelD = Math.max(0.18, mSize.z);
      modelCx = mCenter.x;
      modelCy = liveWorldBox.min.y + modelH * 0.48;
      modelCz = mCenter.z;
      modelMinY = liveWorldBox.min.y;
    }

    const effectiveFocus = cameraFocus === 'land' ? 'land' : 'model';
    const landKey = `${effectiveFocus}:${scId}:${modelBoundsVersion}:${volW.toFixed(1)}x${volD.toFixed(1)}x${volH.toFixed(1)}:${resetViewTick}:${dblClickFocusTick}`;
    if (framedModeKeyRef.current !== landKey && controlsRef.current && cameraRef.current) {
      framedModeKeyRef.current = landKey;
      const cam = cameraRef.current;
      const framing =
        effectiveFocus === 'land'
          ? computeIsometricLandFraming({
              volW,
              volH,
              volD,
              modelHeight: modelH,
              fovDeg: 46,
              aspect: cam.aspect || 1.5
            })
          : computeInsideLandModelFraming({
              modelWidth: modelW,
              modelHeight: modelH,
              modelDepth: modelD,
              modelCenterX: modelCx,
              modelCenterY: modelCy,
              modelCenterZ: modelCz,
              modelMinY,
              volW,
              volH,
              volD,
              fovDeg: 46,
              aspect: cam.aspect || 1.5,
              fillRatio: 0.84
            });
      cam.fov = framing.fov;
      cam.near = framing.near;
      cam.far = framing.far;
      cam.updateProjectionMatrix();
      controlsRef.current.minDistance = framing.minDistance;
      controlsRef.current.maxDistance = framing.maxDistance;
      controlsRef.current.target.set(framing.target[0], framing.target[1], framing.target[2]);
      cam.position.set(framing.position[0], framing.position[1], framing.position[2]);
      controlsRef.current.update();
      prevModelCenterRef.current = { x: modelCx, y: modelCy, z: modelCz };
    } else if (
      effectiveFocus === 'model' &&
      prevModelCenterRef.current &&
      controlsRef.current &&
      cameraRef.current
    ) {
      // Smoothly pan camera & target along with the model when moving X/Y/Z inside the land
      const deltaX = modelCx - prevModelCenterRef.current.x;
      const deltaY = modelCy - prevModelCenterRef.current.y;
      const deltaZ = modelCz - prevModelCenterRef.current.z;
      if (Math.abs(deltaX) > 1e-4 || Math.abs(deltaY) > 1e-4 || Math.abs(deltaZ) > 1e-4) {
        controlsRef.current.target.x += deltaX;
        controlsRef.current.target.y += deltaY;
        controlsRef.current.target.z += deltaZ;
        cameraRef.current.position.x += deltaX;
        cameraRef.current.position.y += deltaY;
        cameraRef.current.position.z += deltaZ;
        controlsRef.current.update();
      }
      // Keep close-up zoom bounds responsive as the model is scaled larger or smaller
      const minSpan = Math.max(0.12, Math.min(modelW, modelH, modelD));
      controlsRef.current.minDistance = Math.max(0.12, minSpan * 0.3);
      prevModelCenterRef.current = { x: modelCx, y: modelCy, z: modelCz };
    }
  }, [
    scId,
    sculpture,
    liveTransform,
    parcelVolume,
    siblingBoxes,
    showLandBounds,
    showEditGizmo,
    placementBlocked,
    autoRotate,
    isometricFocus,
    cameraFocus,
    resetViewTick,
    dblClickFocusTick,
    liveCursor,
    height,
    fillHeight,
    modelBoundsVersion,
    ghostMeshVersion,
    hoveredSibling?.id
  ]);

  useEffect(() => {
    if (!cursorRef.current) return;
    if (liveCursor) {
      cursorRef.current.visible = true;
      cursorRef.current.position.set(liveCursor[0], liveCursor[1], liveCursor[2]);
      if (liveQuaternion) {
        cursorRef.current.quaternion.fromArray(liveQuaternion);
      }
    } else {
      cursorRef.current.visible = false;
    }
  }, [liveCursor, liveQuaternion]);

  const savedRotForHud = extractSculptureRotation(sculpture);
  const hudScale = Math.max(
    0.001,
    Number(liveTransform?.scale ?? extractSculptureScale(sculpture) ?? 1)
  );
  const hudPitch =
    liveTransform?.pitch !== undefined ? Number(liveTransform.pitch) : savedRotForHud.pitch;
  const hudRoll =
    liveTransform?.roll !== undefined ? Number(liveTransform.roll) : savedRotForHud.roll;
  const hudDy = Math.max(0, Number(liveTransform?.dy ?? sculpture?.anchorOffset?.dy ?? 0));
  const hudBaseDims =
    modelBoundsVersion > 0
      ? modelBaseSizeRef.current || { width: 1.4, height: 1.4, depth: 1.4 }
      : extractSculptureBaseDimensions(sculpture);
  const hudDims = computeRotatedBoxDimensions({
    width: hudBaseDims.width,
    height: hudBaseDims.height,
    depth: hudBaseDims.depth,
    yaw: 0,
    pitch: hudPitch,
    roll: hudRoll,
    scale: hudScale
  });
  const isTilted = Math.abs(hudPitch) > 0.05 || Math.abs(hudRoll) > 0.05;
  const resolvedCameraMode = showLandBounds
    ? cameraFocus === 'land'
      ? 'land'
      : 'model-in-land'
    : isometricFocus
    ? 'isometric'
    : 'solo';

  return (
    <div
      className={`sculpture-viewer-wrap ${fillHeight ? 'is-fill-height' : ''}`.trim()}
      data-testid="sculpture-viewer-3d"
      data-camera-mode={resolvedCameraMode}
      data-camera-focus={cameraFocus}
      data-land-bounds-preview={showLandBounds ? 'on' : 'off'}
      data-edit-gizmo={showEditGizmo ? 'on' : 'off'}
      data-model-status={modelStatus}
      data-model-format={scFormat || 'voxel'}
      data-measured-height-m={hudDims.effH.toFixed(3)}
      data-ghost-count={showLandBounds ? (siblingBoxes || []).length : 0}
      style={{
        position: 'relative',
        width: '100%',
        height: fillHeight ? '100%' : height,
        borderRadius: 12,
        overflow: 'hidden',
        border: `1px solid ${
          placementBlocked
            ? 'rgba(255, 77, 109, 0.7)'
            : showLandBounds || showEditGizmo
            ? 'rgba(0, 245, 212, 0.45)'
            : 'var(--border)'
        }`
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />

      {/* Top-Left Corner: Live vertical height, scale/dimensions & fit telemetry */}
      {(showEditGizmo || isTilted || cornerTopLeftExtra) && (
        <div className="viewer-corner-stack is-top-left" data-testid="sculpture-viewer-corner-tl">
          {(showEditGizmo || isTilted) && (
            <div
              className="sculpture-vertical-ruler-badge mono"
              data-testid="sculpture-vertical-height-badge"
              title="Live measured vertical height at current rotation & scale"
            >
              <span>↕ Height: {formatShortLength(hudDims.effH, unitSystem)}</span>
              {hudDy > 0.01 && (
                <span className="sculpture-ruler-sep">
                  · Top: {formatShortLength(hudDy + hudDims.effH, unitSystem)}
                </span>
              )}
              {isTilted && (
                <span className="sculpture-ruler-tilt">
                  · Tilt X {Math.round(hudPitch)}° / Z {Math.round(hudRoll)}°
                </span>
              )}
            </div>
          )}
          {cornerTopLeftExtra}
        </div>
      )}

      {/* Top-Right Corner: Valuable model & NFT stats tucked neatly into corner */}
      {cornerTopRight && (
        <div className="viewer-corner-stack is-top-right" data-testid="sculpture-viewer-corner-tr">
          {cornerTopRight}
        </div>
      )}

      {scFormat && modelStatus === 'loading' && (
        <div
          className="sculpture-viewer-status-pill"
          data-testid="sculpture-viewer-loading"
          role="status"
        >
          Loading {scFormat.toUpperCase()} 3D model…
        </div>
      )}
      {scFormat && modelStatus === 'error' && (
        <div
          className="sculpture-viewer-status-pill is-error"
          data-testid="sculpture-viewer-error"
          role="alert"
        >
          {modelErrorMsg || `Could not load ${scFormat.toUpperCase()} 3D model`}
        </div>
      )}

      {/* Bottom-Left Corner: Scene Ghost Siblings + Camera Focus / Bounds / Gizmo controls */}
      {(cornerBottomLeft || (showLandBounds && (siblingBoxes || []).length > 0)) && (
        <div className="viewer-corner-stack is-bottom-left" data-testid="sculpture-viewer-corner-bl">
          {showLandBounds && (siblingBoxes || []).length > 0 && (
            <div
              className="viewer-ghost-siblings-bar"
              data-testid="viewer-ghost-siblings-bar"
              role="group"
              aria-label="Scene ghost artworks on this land"
            >
              <span className="viewer-ghost-bar-label">
                👻 {siblingBoxes.some((s) => s.canEdit) && onSelectSibling
                  ? 'Click ghost to save & edit:'
                  : 'Scene ghosts:'}
              </span>
              {siblingBoxes.map((sib) => {
                const canEditSib = Boolean(sib.canEdit && onSelectSibling);
                const isSwitching = switchingSiblingId === sib.id;
                const isHover = hoveredSibling?.id === sib.id;
                return (
                  <button
                    key={sib.id}
                    type="button"
                    className={`viewer-ghost-chip ${canEditSib ? 'is-editable' : 'is-readonly'} ${
                      isHover ? 'is-hovered' : ''
                    } ${sib.wasPushed ? 'is-pushed' : ''} ${sib.isColliding ? 'is-colliding' : ''}`.trim()}
                    data-testid={`viewer-ghost-chip-${sib.id}`}
                    data-sibling-id={sib.id}
                    data-can-edit={canEditSib ? 'true' : 'false'}
                    disabled={!canEditSib || Boolean(switchingSiblingId)}
                    onMouseEnter={() =>
                      setHoveredSibling({
                        id: sib.id,
                        title: sib.title || 'Artwork',
                        canEdit: Boolean(sib.canEdit)
                      })
                    }
                    onMouseLeave={() =>
                      setHoveredSibling((prev) => (prev?.id === sib.id ? null : prev))
                    }
                    onClick={() => {
                      if (canEditSib) onSelectSibling?.(sib.id);
                    }}
                    title={
                      canEditSib
                        ? `Save current edits and switch live to edit "${sib.title || 'Artwork'}"`
                        : `"${sib.title || 'Artwork'}" — view-only ghost`
                    }
                  >
                    <span>{canEditSib ? '👻' : '🔒'}</span>
                    <span className="viewer-ghost-chip-title">
                      {isSwitching ? 'Saving & switching…' : sib.title || 'Artwork'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {cornerBottomLeft}
        </div>
      )}

      {/* Bottom-Right Corner: Live 3D gizmo status / ghost hover prompt / drag legend */}
      {(showEditGizmo || hoveredSibling) && (
        <div
          className={`sculpture-gizmo-hud-chip ${
            gizmoStatusText || hoveredSibling ? 'is-dragging' : ''
          } ${cornerBottomLeft || (showLandBounds && (siblingBoxes || []).length > 0) ? 'is-corner-br' : ''}`.trim()}
          data-testid="sculpture-gizmo-hud"
        >
          {gizmoStatusText
            ? gizmoStatusText
            : hoveredSibling
            ? hoveredSibling.canEdit && onSelectSibling
              ? `👻 Click to save & edit "${hoveredSibling.title}"`
              : `👻 "${hoveredSibling.title}" (view-only ghost)`
            : '● Corners: Scale · ▬ Sides: Move · ┃ Bars: Rotate · ▲ Top: Height'}
        </div>
      )}
    </div>
  );
}
