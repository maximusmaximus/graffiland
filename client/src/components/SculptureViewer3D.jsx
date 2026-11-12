import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildVoxelGroup, computeCenteredBounds } from './VoxelEngine3D.js';

export default function SculptureViewer3D({
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090d18');

    const camera = new THREE.PerspectiveCamera(50, host.clientWidth / height, 0.05, 100);
    camera.position.set(2.4, 1.8, 3.0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, height);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.4;

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(4, 7, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x00f5d4, 0.45);
    rimLight.position.set(-4, -2, -4);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(6, 24, 0x00f5d4, 0x1e2842);
    grid.position.y = -0.8;
    scene.add(grid);

    const voxelContainer = new THREE.Group();
    scene.add(voxelContainer);

    const cursorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xff3e7f, wireframe: true })
    );
    cursorMesh.visible = false;
    scene.add(cursorMesh);

    groupRef.current = voxelContainer;
    cursorRef.current = cursorMesh;
    cameraRef.current = camera;
    controlsRef.current = controls;

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
    const meshGroup = buildVoxelGroup(voxels);
    container.add(meshGroup);

    if (voxels.length > 0 && controlsRef.current && !liveCursor) {
      const { center, radius } = computeCenteredBounds(voxels);
      controlsRef.current.target.copy(center);
      if (cameraRef.current && voxels.length <= 2) {
        cameraRef.current.position.set(center.x + radius * 2.2, center.y + radius * 1.4, center.z + radius * 2.4);
      }
    }
  }, [voxels, liveCursor]);

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
