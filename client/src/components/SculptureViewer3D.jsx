import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  extractSculptureScale,
  yawToRadians
} from '../../../shared/sculpturePlacement.mjs';
import { resolveApiUrl } from '../utils/api.js';
import {
  enforceCrispTexturesAndShading,
  loadCustomModelObject
} from '../utils/customModelLoader.js';
import {
  createDepthFadedThreeBoxWireframe,
  updateThreeWireframeDepthFade
} from '../utils/prismDepthFade.js';
import {
  buildVoxelGroup,
  computeCenteredBounds,
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

export default function SculptureViewer3D({
  sculpture = null,
  voxels = [],
  height = 300,
  autoRotate = true,
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
  onModelBoundsMeasured = null,
  onTransformChange = null
}) {
  const hostRef = useRef(null);
  const groupRef = useRef(null);
  const modelContentRef = useRef(null);
  const landOverlayRef = useRef(null);
  const siblingOverlayRef = useRef(null);
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
  const framedLandKeyRef = useRef('');
  const [gizmoStatusText, setGizmoStatusText] = useState('');
  const [modelBoundsVersion, setModelBoundsVersion] = useState(0);
  const [modelStatus, setModelStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'
  const [modelErrorMsg, setModelErrorMsg] = useState('');

  const onModelBoundsMeasuredRef = useRef(onModelBoundsMeasured);
  onModelBoundsMeasuredRef.current = onModelBoundsMeasured;
  const onTransformChangeRef = useRef(onTransformChange);
  onTransformChangeRef.current = onTransformChange;
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

    const initWidth = Math.max(220, host.clientWidth || Math.min(640, (window.innerWidth || 640) - 48));
    const camera = new THREE.PerspectiveCamera(50, initWidth / height, 0.05, 600);
    camera.position.set(2.4, 1.8, 3.0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4));
    renderer.setSize(initWidth, height, false);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.maxWidth = '100%';
    renderer.domElement.style.height = `${height}px`;
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
    controls.autoRotate = autoRotate;
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
    const modelContent = new THREE.Group();
    modelPivot.add(modelContent);
    scene.add(modelPivot);

    const landOverlay = new THREE.Group();
    scene.add(landOverlay);

    const siblingOverlay = new THREE.Group();
    scene.add(siblingOverlay);

    const gizmoOverlay = new THREE.Group();
    scene.add(gizmoOverlay);

    const cursorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(VOXEL_STEP * 1.1, VOXEL_STEP * 1.1, VOXEL_STEP * 1.1),
      new THREE.MeshBasicMaterial({ color: 0xff3e7f, wireframe: true })
    );
    cursorMesh.visible = false;
    scene.add(cursorMesh);

    groupRef.current = modelPivot;
    modelContentRef.current = modelContent;
    landOverlayRef.current = landOverlay;
    siblingOverlayRef.current = siblingOverlay;
    gizmoOverlayRef.current = gizmoOverlay;
    cursorRef.current = cursorMesh;
    cameraRef.current = camera;
    controlsRef.current = controls;
    gridRef.current = grid;
    shadowGroundRef.current = shadowGround;
    keyLightRef.current = keyLight;

    // Interactive 3D Artwork Gizmo Pointer Dragging (Scale corners, Move side bars, Rotate vertical bars, Height top ball)
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const hitPoint = new THREE.Vector3();
    let dragState = null;

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

    const onPointerDown = (evt) => {
      if (!showEditGizmoRef.current || !onTransformChangeRef.current) return;
      const targets = gizmoHitMeshesRef.current;
      if (!targets || targets.length === 0) return;
      if (!toNdc(evt)) return;

      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(targets, false);
      if (!hits || hits.length === 0) return;

      const hit = hits[0];
      const role = hit.object?.userData?.gizmoRole;
      if (!role) return;

      evt.stopPropagation();
      const lt = liveTransformRef.current || {};
      const startDx = Number(lt.dx || 0);
      const startDy = Math.max(0, Number(lt.dy || 0));
      const startDz = Number(lt.dz || 0);
      const startYaw = Number(lt.yaw || 0);
      const startScale = Math.max(
        0.1,
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
        dragPlane.setFromNormalAndCoplanarPoint(camDir, new THREE.Vector3(pivotX, hit.point.y, pivotZ));
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
    };

    const onPointerMove = (evt) => {
      if (!showEditGizmoRef.current) return;
      if (!toNdc(evt)) return;
      raycaster.setFromCamera(pointerNdc, camera);

      if (!dragState) {
        const targets = gizmoHitMeshesRef.current;
        if (targets && targets.length > 0) {
          const hits = raycaster.intersectObjects(targets, false);
          const role = hits?.[0]?.object?.userData?.gizmoRole || '';
          renderer.domElement.style.cursor = role ? getGizmoCursor(role) : '';
        }
        return;
      }

      if (!raycaster.ray.intersectPlane(dragPlane, hitPoint)) return;

      const ranges = moveRangesRef.current;
      const capScale = Math.max(0.2, Number(maxSafeScaleRef.current || 60));

      if (dragState.role === 'scale') {
        const curDist = Math.hypot(hitPoint.x - dragState.pivotX, hitPoint.z - dragState.pivotZ);
        const ratio = Math.max(0.15, curDist / dragState.startDist);
        const nextScale = Math.max(
          0.1,
          Math.min(capScale, Math.round(dragState.startScale * ratio * 100) / 100)
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

    const endDrag = () => {
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

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', endDrag);
    renderer.domElement.addEventListener('pointercancel', endDrag);

    const handleResize = () => {
      if (!host) return;
      const w = Math.max(220, host.clientWidth || Math.min(640, (window.innerWidth || 640) - 48));
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height, false);
    };
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
      window.removeEventListener('resize', handleResize);
      resizeObs?.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', endDrag);
      renderer.domElement.removeEventListener('pointercancel', endDrag);
      clearGroup(modelContent);
      clearGroup(landOverlay);
      clearGroup(siblingOverlay);
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
      modelContentRef.current = null;
      landOverlayRef.current = null;
      siblingOverlayRef.current = null;
      gizmoOverlayRef.current = null;
    };
  }, [height, autoRotate]);

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

    function frameSoloCamera(center, radius, minY) {
      if (showLandBounds) return;
      const groundY = Number.isFinite(minY) ? minY - 0.02 : -0.02;
      if (gridRef.current) {
        gridRef.current.position.set(center.x, groundY, center.z);
        gridRef.current.scale.setScalar(Math.max(1, radius / 1.5));
      }
      if (shadowGroundRef.current) {
        shadowGroundRef.current.position.set(center.x, groundY + 0.001, center.z);
        shadowGroundRef.current.scale.setScalar(Math.max(1, radius / 1.5));
      }
      if (keyLightRef.current) {
        const span = Math.max(4, radius * 2.4);
        keyLightRef.current.position.set(center.x + span * 0.7, center.y + span * 1.1, center.z + span * 0.8);
        keyLightRef.current.target.position.copy(center);
        keyLightRef.current.shadow.camera.left = -span;
        keyLightRef.current.shadow.camera.right = span;
        keyLightRef.current.shadow.camera.top = span;
        keyLightRef.current.shadow.camera.bottom = -span;
        keyLightRef.current.shadow.camera.updateProjectionMatrix();
      }
      if (!liveCursor && controlsRef.current) {
        controlsRef.current.target.copy(center);
        if (cameraRef.current) {
          cameraRef.current.position.set(
            center.x + radius * 2.1,
            center.y + radius * 1.35,
            center.z + radius * 2.3
          );
        }
      }
    }

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

          const curScale = Number(liveTransform?.scale || extractSculptureScale(sculpture) || 1);
          const center = new THREE.Vector3();
          const sphere = new THREE.Sphere();
          loaded.bounds.getCenter(center);
          loaded.bounds.getBoundingSphere(sphere);
          center.multiplyScalar(curScale);
          frameSoloCamera(center, Math.max(0.8, sphere.radius * curScale), 0);
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

    if (voxels.length > 0 && controlsRef.current) {
      const curScale = Number(liveTransform?.scale || extractSculptureScale(sculpture) || 1);
      const { radius } = computeCenteredBounds(voxels);
      const h = (modelBaseSizeRef.current?.height || 1) * curScale;
      frameSoloCamera(
        new THREE.Vector3(0, h / 2, 0),
        Math.max(0.9, (voxels.length <= 2 ? radius : Math.max(1.0, radius)) * curScale),
        0
      );
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scId, scFormat, scCid, scDownloadUrl, scRotY, voxels, liveCursor]);

  // Fast 60fps transform, land-bounds wireframe, sibling collision boxes & 3D artwork gizmo bars/points
  useEffect(() => {
    const pivot = groupRef.current;
    const landOverlay = landOverlayRef.current;
    const siblingOverlay = siblingOverlayRef.current;
    const gizmoOverlay = gizmoOverlayRef.current;
    if (!pivot || !landOverlay || !siblingOverlay || !gizmoOverlay) return;

    const effScale = Math.max(
      0.001,
      Number(liveTransform?.scale ?? extractSculptureScale(sculpture) ?? 1)
    );
    const yawRad = yawToRadians(
      liveTransform?.yaw !== undefined ? liveTransform.yaw : sculpture?.anchorOffset?.yaw || 0
    );

    pivot.scale.setScalar(effScale);
    pivot.rotation.y = yawRad;

    clearGroup(landOverlay);
    clearGroup(siblingOverlay);
    clearGroup(gizmoOverlay);
    gizmoHitMeshesRef.current = [];

    const hasLand =
      showLandBounds &&
      parcelVolume &&
      Number(parcelVolume.widthMeters) > 0 &&
      Number(parcelVolume.depthMeters) > 0 &&
      Number(parcelVolume.heightMeters) > 0;

    if (controlsRef.current) {
      controlsRef.current.autoRotate = hasLand || showEditGizmo ? false : autoRotate;
    }

    const baseX = hasLand ? Number(liveTransform?.baseX || 0) : 0;
    const baseZ = hasLand ? Number(liveTransform?.baseZ || 0) : 0;
    const dx = hasLand ? Number(liveTransform?.dx || 0) : 0;
    const dy = hasLand ? Math.max(0, Number(liveTransform?.dy || 0)) : 0;
    const dz = hasLand ? Number(liveTransform?.dz || 0) : 0;

    pivot.position.set(baseX + dx, dy, baseZ + dz);

    const baseDims = modelBaseSizeRef.current || { width: 1.4, height: 1.4, depth: 1.4 };
    const footW = Math.max(0.32, baseDims.width * effScale);
    const footH = Math.max(0.32, baseDims.height * effScale);
    const footD = Math.max(0.32, baseDims.depth * effScale);

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

      gizmoOverlay.add(gizmoRoot);
      gizmoHitMeshesRef.current = hitList;
    }

    if (!hasLand) {
      framedLandKeyRef.current = '';
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
    floorMesh.position.y = 0.005;
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

    // 2) Sibling Artworks on the Same Land (highlighted gold when gently pushed, red if blocking)
    for (const sib of siblingBoxes || []) {
      const b = sib?.box;
      if (!b) continue;
      const sw = Math.max(0.12, Number(b.effW || 0.5));
      const sh = Math.max(0.12, Number(b.effH || 0.5));
      const sd = Math.max(0.12, Number(b.effD || 0.5));
      const sibColor = sib.isColliding ? 0xff4d6d : sib.wasPushed ? 0xffd166 : 0x60a5fa;

      const sGeo = new THREE.BoxGeometry(sw, sh, sd);
      const sMesh = new THREE.Mesh(
        sGeo,
        new THREE.MeshStandardMaterial({
          color: sibColor,
          transparent: true,
          opacity: sib.wasPushed || sib.isColliding ? 0.36 : 0.22,
          roughness: 0.4,
          metalness: 0.1
        })
      );
      sMesh.position.set(b.cx, b.cy, b.cz);
      siblingOverlay.add(sMesh);

      const sEdges = new THREE.EdgesGeometry(sGeo);
      const sWire = new THREE.LineSegments(
        sEdges,
        new THREE.LineBasicMaterial({ color: sibColor, transparent: true, opacity: 0.95 })
      );
      sWire.position.set(b.cx, b.cy, b.cz);
      siblingOverlay.add(sWire);
    }

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

    // Frame the isometric land view once when entering Land Bounds mode (never fights user orbit)
    const landKey = `${volW.toFixed(1)}x${volD.toFixed(1)}x${volH.toFixed(1)}`;
    if (framedLandKeyRef.current !== landKey && controlsRef.current && cameraRef.current) {
      framedLandKeyRef.current = landKey;
      const dist = Math.max(volW, volD, volH * 0.85) * 1.32;
      const focusY = Math.min(volH * 0.35, Math.max(1.2, (baseDims.height * effScale) * 0.75));
      controlsRef.current.target.set(0, focusY, 0);
      cameraRef.current.position.set(dist * 0.78, Math.max(dist * 0.62, focusY + 1.8), dist * 0.88);
      controlsRef.current.update();
    }
  }, [
    sculpture,
    liveTransform,
    parcelVolume,
    siblingBoxes,
    showLandBounds,
    showEditGizmo,
    placementBlocked,
    autoRotate,
    modelBoundsVersion
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

  return (
    <div
      className="sculpture-viewer-wrap"
      data-testid="sculpture-viewer-3d"
      data-land-bounds-preview={showLandBounds ? 'on' : 'off'}
      data-edit-gizmo={showEditGizmo ? 'on' : 'off'}
      data-model-status={modelStatus}
      data-model-format={scFormat || 'voxel'}
      style={{
        position: 'relative',
        width: '100%',
        height,
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
      {showEditGizmo && (
        <div
          className={`sculpture-gizmo-hud-chip ${gizmoStatusText ? 'is-dragging' : ''}`}
          data-testid="sculpture-gizmo-hud"
        >
          {gizmoStatusText || '● Corners: Scale · ▬ Sides: Move · ┃ Bars: Rotate · ▲ Top: Height'}
        </div>
      )}
    </div>
  );
}
