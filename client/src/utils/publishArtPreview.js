import * as THREE from 'three';

/**
 * Captures a clean PNG snapshot of ONLY the user's newly created art or staged 3D model
 * (`draftGroup`), temporarily hiding all other sculptures, land boundary wireframes, grids,
 * cursors, beacons, and transform gizmos so zero other land items ever appear in the preview.
 *
 * Uses the existing WebGL renderer synchronously (never creating an extra WebGL context)
 * and restores every object's visibility cleanly in a `finally` block.
 *
 * @param {{
 *   renderer?: THREE.WebGLRenderer | null,
 *   scene?: THREE.Scene | null,
 *   camera?: THREE.Camera | null,
 *   draftGroup?: THREE.Object3D | null,
 *   hideObjects?: Array<THREE.Object3D | { visible: boolean } | null | undefined>,
 *   keepHiddenObjects?: Array<THREE.Object3D | { visible: boolean } | null | undefined>,
 *   autoFrame?: boolean
 * }} params
 * @returns {string} PNG data URL or '' if renderer is unavailable
 */
export function captureIsolatedDraftSnapshot({
  renderer = null,
  scene = null,
  camera = null,
  draftGroup = null,
  hideObjects = [],
  keepHiddenObjects = [],
  autoFrame = true
} = {}) {
  if (!renderer || !scene || !camera || typeof renderer.render !== 'function') {
    return '';
  }

  const savedVisibility = [];
  const seen = new Set();
  for (const obj of hideObjects || []) {
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    savedVisibility.push([obj, obj.visible]);
    obj.visible = false;
  }

  const keepHiddenSet = new Set((keepHiddenObjects || []).filter(Boolean));
  const prevDraftVisible = draftGroup ? draftGroup.visible : true;
  if (draftGroup) {
    draftGroup.visible = true;
  }

  let renderCam = camera;
  let dataUrl = '';
  try {
    if (autoFrame && draftGroup) {
      draftGroup.updateMatrixWorld?.(true);
      const box = new THREE.Box3().setFromObject(draftGroup);
      if (!box.isEmpty()) {
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const radius = Math.max(0.16, Math.hypot(size.x, size.y, size.z) * 0.5);
        const rawAspect = Number(camera.aspect);
        const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1.25;
        const fovDeg = 42;
        const fovRad = THREE.MathUtils.degToRad(fovDeg);
        const halfMinFov = Math.min(fovRad * 0.5, Math.atan(Math.tan(fovRad * 0.5) * aspect));
        const dist = Math.max(0.55, (radius / Math.max(0.2, Math.sin(halfMinFov))) * 1.24);

        const camPos = camera.position || new THREE.Vector3(0, 0, 1);
        const dx = (camPos.x || 0) - center.x;
        const dz = (camPos.z || 0) - center.z;
        const horizLen = Math.hypot(dx, dz);
        let dirX = 0.58;
        let dirZ = 0.81;
        if (horizLen > 0.05) {
          const baseYaw = Math.atan2(dx, dz);
          const viewYaw = baseYaw + THREE.MathUtils.degToRad(16);
          dirX = Math.sin(viewYaw);
          dirZ = Math.cos(viewYaw);
        }
        const elevRad = THREE.MathUtils.degToRad(20);
        const elevCos = Math.cos(elevRad);
        const elevSin = Math.sin(elevRad);

        const snapCam = new THREE.PerspectiveCamera(
          fovDeg,
          aspect,
          Math.max(0.01, dist * 0.04),
          Math.max(100, dist * 12)
        );
        snapCam.position.set(
          center.x + dirX * elevCos * dist,
          center.y + elevSin * dist,
          center.z + dirZ * elevCos * dist
        );
        snapCam.lookAt(center);
        snapCam.updateMatrixWorld(true);
        renderCam = snapCam;
      }
    }

    renderer.render(scene, renderCam);
    dataUrl =
      typeof renderer.domElement?.toDataURL === 'function'
        ? renderer.domElement.toDataURL('image/png') || ''
        : '';
  } catch {
    dataUrl = '';
  } finally {
    if (draftGroup) {
      draftGroup.visible = prevDraftVisible;
    }
    for (const [obj, wasVisible] of savedVisibility) {
      obj.visible = keepHiddenSet.has(obj) ? false : wasVisible;
    }
    if (renderCam !== camera) {
      try {
        renderer.render(scene, camera);
      } catch {
        // ignore restore render failure
      }
    }
  }

  return dataUrl;
}
