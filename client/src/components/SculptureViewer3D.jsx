import React, { useEffect, useRef } from 'react';
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
  placementBlocked = false,
  onModelBoundsMeasured = null
}) {
  const hostRef = useRef(null);
  const groupRef = useRef(null);
  const modelContentRef = useRef(null);
  const landOverlayRef = useRef(null);
  const siblingOverlayRef = useRef(null);
  const cursorRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const gridRef = useRef(null);
  const shadowGroundRef = useRef(null);
  const keyLightRef = useRef(null);
  const maxAnisotropyRef = useRef(8);
  const modelBaseSizeRef = useRef({ width: 1.4, height: 1.4, depth: 1.4 });
  const framedLandKeyRef = useRef('');
  const onModelBoundsMeasuredRef = useRef(onModelBoundsMeasured);
  onModelBoundsMeasuredRef.current = onModelBoundsMeasured;

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

    const initWidth = Math.max(240, host.clientWidth || 640);
    const camera = new THREE.PerspectiveCamera(50, initWidth / height, 0.05, 600);
    camera.position.set(2.4, 1.8, 3.0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4));
    renderer.setSize(initWidth, height);
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
    cursorRef.current = cursorMesh;
    cameraRef.current = camera;
    controlsRef.current = controls;
    gridRef.current = grid;
    shadowGroundRef.current = shadowGround;
    keyLightRef.current = keyLight;

    const handleResize = () => {
      if (!host) return;
      const w = Math.max(240, host.clientWidth || 640);
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
    };
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      clearGroup(modelContent);
      clearGroup(landOverlay);
      clearGroup(siblingOverlay);
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
          onModelBoundsMeasuredRef.current?.(baseDims);

          const curScale = Number(liveTransform?.scale || extractSculptureScale(sculpture) || 1);
          const center = new THREE.Vector3();
          const sphere = new THREE.Sphere();
          loaded.bounds.getCenter(center);
          loaded.bounds.getBoundingSphere(sphere);
          center.multiplyScalar(curScale);
          frameSoloCamera(center, Math.max(0.8, sphere.radius * curScale), 0);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }

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

  // Fast 60fps transform, land-bounds wireframe & sibling collision-push overlay update
  useEffect(() => {
    const pivot = groupRef.current;
    const landOverlay = landOverlayRef.current;
    const siblingOverlay = siblingOverlayRef.current;
    if (!pivot || !landOverlay || !siblingOverlay) return;

    const effScale = Math.max(
      0.1,
      Number(liveTransform?.scale ?? extractSculptureScale(sculpture) ?? 1)
    );
    const yawRad = yawToRadians(
      liveTransform?.yaw !== undefined ? liveTransform.yaw : sculpture?.anchorOffset?.yaw || 0
    );

    pivot.scale.setScalar(effScale);
    pivot.rotation.y = yawRad;

    clearGroup(landOverlay);
    clearGroup(siblingOverlay);

    const hasLand =
      showLandBounds &&
      parcelVolume &&
      Number(parcelVolume.widthMeters) > 0 &&
      Number(parcelVolume.depthMeters) > 0 &&
      Number(parcelVolume.heightMeters) > 0;

    if (controlsRef.current) {
      controlsRef.current.autoRotate = hasLand ? false : autoRotate;
    }

    if (!hasLand) {
      pivot.position.set(0, 0, 0);
      framedLandKeyRef.current = '';
      return;
    }

    const volW = Number(parcelVolume.widthMeters);
    const volD = Number(parcelVolume.depthMeters);
    const volH = Number(parcelVolume.heightMeters);

    const baseX = Number(liveTransform?.baseX || 0);
    const baseZ = Number(liveTransform?.baseZ || 0);
    const dx = Number(liveTransform?.dx || 0);
    const dy = Math.max(0, Number(liveTransform?.dy || 0));
    const dz = Number(liveTransform?.dz || 0);

    pivot.position.set(baseX + dx, dy, baseZ + dz);

    // 1) Land Bounds 3D Wireframe Box + Translucent Floor Plane
    const wireColor = placementBlocked
      ? 0xff4d6d
      : siblingBoxes.some((s) => s.wasPushed)
      ? 0xffd166
      : 0x00f5d4;

    const boxGeo = new THREE.BoxGeometry(volW, volH, volD);
    const edges = new THREE.EdgesGeometry(boxGeo);
    const wireLine = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: wireColor, transparent: true, opacity: 0.9 })
    );
    wireLine.position.set(0, volH / 2, 0);
    landOverlay.add(wireLine);
    boxGeo.dispose();

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

    // Target footprint ring directly under the active sculpture
    const baseDims = modelBaseSizeRef.current || { width: 1.4, height: 1.4, depth: 1.4 };
    const footW = Math.max(0.3, baseDims.width * effScale);
    const footD = Math.max(0.3, baseDims.depth * effScale);
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
    placementBlocked,
    autoRotate
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
      ref={hostRef}
      data-testid="sculpture-viewer-3d"
      data-land-bounds-preview={showLandBounds ? 'on' : 'off'}
      style={{
        width: '100%',
        height,
        borderRadius: 12,
        overflow: 'hidden',
        border: `1px solid ${
          placementBlocked
            ? 'rgba(255, 77, 109, 0.7)'
            : showLandBounds
            ? 'rgba(0, 245, 212, 0.45)'
            : 'var(--border)'
        }`
      }}
    />
  );
}
