import * as THREE from 'three';

export const VOXEL_STEP = 0.2;

export const GRAFFITI_PALETTE = [
  '#00f5d4',
  '#ff3e7f',
  '#ffd166',
  '#7b2cbf',
  '#00bbf9',
  '#ff6b35',
  '#80ff72',
  '#ffffff',
  '#ff0054',
  '#3a86ff',
  '#f15bb5',
  '#1b263b'
];

export function snapCoord(val, step = VOXEL_STEP) {
  return Math.round(val / step) * step;
}

export function voxelKey(x, y, z) {
  return `${Math.round(x * 100)}:${Math.round(y * 100)}:${Math.round(z * 100)}`;
}

/**
 * Converts Web DeviceOrientation Euler angles (degrees) to a Three.js camera Quaternion.
 */
export function deviceOrientationToQuaternion(alphaDeg, betaDeg, gammaDeg, screenOrientDeg = 0) {
  const alpha = THREE.MathUtils.degToRad(alphaDeg || 0);
  const beta = THREE.MathUtils.degToRad(betaDeg || 0);
  const gamma = THREE.MathUtils.degToRad(gammaDeg || 0);
  const orient = THREE.MathUtils.degToRad(screenOrientDeg || 0);

  const zee = new THREE.Vector3(0, 0, 1);
  const euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
  const q = new THREE.Quaternion().setFromEuler(euler);
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X
  const q0 = new THREE.Quaternion().setFromAxisAngle(zee, -orient);

  q.multiply(q1);
  q.multiply(q0);
  return q;
}

export function latLngOffsetMeters(originLat, originLng, targetLat, targetLng) {
  const latRad = (originLat * Math.PI) / 180;
  const north = (targetLat - originLat) * 111320;
  const east = (targetLng - originLng) * 111320 * Math.cos(latRad);
  return { east, north };
}

export function buildVoxelGroup(voxels = [], { scale = 1, opacity = 1 } = {}) {
  const group = new THREE.Group();
  const unitGeo = new THREE.BoxGeometry(VOXEL_STEP * 0.96, VOXEL_STEP * 0.96, VOXEL_STEP * 0.96);
  const matCache = new Map();

  for (const v of voxels) {
    const key = `${v.color}|${v.material || 'matte'}|${opacity}`;
    let mat = matCache.get(key);
    if (!mat) {
      const color = new THREE.Color(v.color || '#00f5d4');
      if (v.material === 'neon') {
        mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.75,
          roughness: 0.25,
          metalness: 0.1,
          transparent: opacity < 1,
          opacity
        });
      } else if (v.material === 'glass') {
        mat = new THREE.MeshPhysicalMaterial({
          color,
          roughness: 0.1,
          metalness: 0.05,
          transparent: true,
          opacity: Math.min(0.68, opacity)
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.45,
          metalness: 0.15,
          transparent: opacity < 1,
          opacity
        });
      }
      matCache.set(key, mat);
    }

    const mesh = new THREE.Mesh(unitGeo, mat);
    mesh.position.set(v.x * scale, v.y * scale, v.z * scale);
    const vScale = (v.scale ?? 1) * scale;
    mesh.scale.setScalar(vScale);
    mesh.userData.voxel = v;
    group.add(mesh);
  }
  return group;
}

export function computeCenteredBounds(voxels = []) {
  if (!voxels.length) {
    return { center: new THREE.Vector3(0, 0, 0), radius: 1 };
  }
  const box = new THREE.Box3();
  for (const v of voxels) {
    box.expandByPoint(new THREE.Vector3(v.x, v.y, v.z));
  }
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = Math.max(0.8, size.length() * 0.65);
  return { center, radius };
}
