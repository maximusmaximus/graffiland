import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { resolveApiUrl } from '../utils/api.js';
import { loadCustomModelObject } from '../utils/customModelLoader.js';
import { buildVoxelGroup, computeCenteredBounds, VOXEL_STEP } from './VoxelEngine3D.js';

export default function SculptureViewer3D({
  sculpture = null,
  voxels = [],
  height = 300,
  autoRotate = true,
  liveCursor = null,
  liveQuaternion = null
}) {
  const hostRef = useRef(null);
  const groupRef = useRef(null);
  const cursorRef = useRef(null);
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);
  const gridRef = useRef(null);
  const shadowGroundRef = useRef(null);
  const keyLightRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090d18');

    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / height, 0.05, 100);
    camera.position.set(2.4, 1.8, 3.0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4));
    renderer.setSize(host.clientWidth, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
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
    keyLight.shadow.camera.far = 25;
    keyLight.shadow.camera.left = -4;
    keyLight.shadow.camera.right = 4;
    keyLight.shadow.camera.top = 4;
    keyLight.shadow.camera.bottom = -4;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);
    scene.add(keyLight.target);
    const rimLight = new THREE.DirectionalLight(0x00f5d4, 0.45);
    rimLight.position.set(-4, -2, -4);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(6, 24, 0x00f5d4, 0x1e2842);
    grid.position.y = -0.8;
    scene.add(grid);

    const shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.ShadowMaterial({ opacity: 0.45 })
    );
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = -0.799;
    shadowGround.receiveShadow = true;
    scene.add(shadowGround);

    const voxelContainer = new THREE.Group();
    scene.add(voxelContainer);

    const cursorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(VOXEL_STEP * 1.1, VOXEL_STEP * 1.1, VOXEL_STEP * 1.1),
      new THREE.MeshBasicMaterial({ color: 0xff3e7f, wireframe: true })
    );
    cursorMesh.visible = false;
    scene.add(cursorMesh);

    groupRef.current = voxelContainer;
    cursorRef.current = cursorMesh;
    cameraRef.current = camera;
    controlsRef.current = controls;
    gridRef.current = grid;
    shadowGroundRef.current = shadowGround;
    keyLightRef.current = keyLight;

    const handleResize = () => {
      if (!host) return;
      camera.aspect = host.clientWidth / height;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, height);
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
      controls.dispose();
      envRT.dispose();
      pmremGenerator.dispose();
      shadowGround.geometry.dispose();
      shadowGround.material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [height, autoRotate]);

  useEffect(() => {
    const container = groupRef.current;
    if (!container) return;
    while (container.children.length > 0) container.remove(container.children[0]);

    function applyBoundsToScene(center, radius, minY) {
      const groundY = Number.isFinite(minY) ? minY - 0.04 : -0.8;
      if (gridRef.current) {
        gridRef.current.position.set(center.x, groundY, center.z);
      }
      if (shadowGroundRef.current) {
        shadowGroundRef.current.position.set(center.x, groundY + 0.001, center.z);
      }
      if (keyLightRef.current) {
        const span = Math.max(4, radius * 2.2);
        keyLightRef.current.position.set(center.x + 4, center.y + 7, center.z + 5);
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

    if (sculpture?.customModel?.format) {
      let cancelled = false;
      loadCustomModelObject(sculpture, resolveApiUrl)
        .then((loaded) => {
          if (cancelled || !loaded || !groupRef.current) return;
          while (groupRef.current.children.length > 0) {
            groupRef.current.remove(groupRef.current.children[0]);
          }
          groupRef.current.add(loaded.object3d);
          const center = new THREE.Vector3();
          const sphere = new THREE.Sphere();
          loaded.bounds.getCenter(center);
          loaded.bounds.getBoundingSphere(sphere);
          applyBoundsToScene(center, Math.max(0.8, sphere.radius), loaded.bounds.min.y);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }

    const meshGroup = buildVoxelGroup(voxels);
    container.add(meshGroup);

    if (voxels.length > 0 && controlsRef.current) {
      let minY = Infinity;
      for (const v of voxels) {
        const halfH = (VOXEL_STEP / 2) * (v.scale ?? 1);
        if (Number.isFinite(v.y) && v.y - halfH < minY) minY = v.y - halfH;
      }
      const { center, radius } = computeCenteredBounds(voxels);
      applyBoundsToScene(center, voxels.length <= 2 ? radius : Math.max(1.0, radius), minY);
    }
  }, [sculpture, sculpture?.customModel?.format, sculpture?.customModel?.ipfsCid, voxels, liveCursor]);

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
      style={{
        width: '100%',
        height,
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid var(--border)'
      }}
    />
  );
}
