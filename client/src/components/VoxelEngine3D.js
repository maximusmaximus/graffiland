import * as THREE from 'three';
import { GRAFFITI_PALETTE, VOXEL_STEP } from '../../../shared/constants.mjs';

export { GRAFFITI_PALETTE, VOXEL_STEP };

export function snapCoord(val, step = VOXEL_STEP) {
  return Math.round(Math.round(val / step) * step * 1000) / 1000;
}

export function voxelKey(x, y, z) {
  return `${Math.round(x * 1000)}:${Math.round(y * 1000)}:${Math.round(z * 1000)}`;
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

/**
 * Computes directional light vector in local East (+X), Up (+Y), South (+Z) meters
 * matching the physical solar azimuth & elevation at (lat, lng).
 */
export function computeSolarLightVector(lat, lng, date = new Date()) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { x: 4, y: 8, z: 3, isDaylight: true, solarAltitudeDeg: 55, solarAzimuthDeg: 145 };
  }
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const dayOfYear = Math.floor((date - start) / 86400000);
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma);

  const solarTimeHours = (((utcHours + lng / 15) % 24) + 24) % 24;
  const hourAngle = ((solarTimeHours - 12) * 15 * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const sinAlt =
    Math.sin(latRad) * Math.sin(decl) +
    Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const altDeg = (altRad * 180) / Math.PI;

  const cosAltLat = Math.cos(latRad) * Math.cos(altRad);
  let azDeg = 180;
  if (Math.abs(cosAltLat) > 1e-5) {
    const cosAz = (Math.sin(decl) - Math.sin(latRad) * Math.sin(altRad)) / cosAltLat;
    let az = (Math.acos(Math.max(-1, Math.min(1, cosAz))) * 180) / Math.PI;
    if (Math.sin(hourAngle) > 0) az = 360 - az;
    azDeg = az;
  }

  // If nighttime/deep twilight, use an elevated moonlight/streetlight shadow angle
  const clampedAltRad = THREE.MathUtils.degToRad(Math.max(24, altDeg));
  const azRad = THREE.MathUtils.degToRad(azDeg);
  const dist = 12;
  const horiz = Math.cos(clampedAltRad) * dist;
  return {
    x: Math.sin(azRad) * horiz,
    y: Math.sin(clampedAltRad) * dist,
    z: -Math.cos(azRad) * horiz,
    isDaylight: altDeg > 2,
    solarAltitudeDeg: Math.round(altDeg * 10) / 10,
    solarAzimuthDeg: Math.round(azDeg * 10) / 10
  };
}

/**
 * Generates live camera equirectangular reflections (PMREM) + matching sky/ground ambient colors.
 */
export function createLiveEnvUpdater(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 8;
  sampleCanvas.height = 4;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  let currentTarget = null;

  function update(videoEl) {
    if (!videoEl || videoEl.readyState < 2 || !ctx) return null;

    // Upper hemisphere: live camera wrap (mirrored horizontally for 360 seamlessness, no CPU blur)
    ctx.drawImage(videoEl, 0, 0, 128, 64);
    ctx.save();
    ctx.translate(256, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, 0, 0, 128, 64);
    ctx.restore();

    // Lower hemisphere: fast flipped & tinted ground bounce
    ctx.save();
    ctx.translate(0, 128);
    ctx.scale(1, -1);
    ctx.drawImage(canvas, 0, 0, 256, 64, 0, 0, 256, 64);
    ctx.restore();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(0, 64, 256, 64);

    tex.needsUpdate = true;
    const nextTarget = pmrem.fromEquirectangular(tex);
    if (currentTarget) currentTarget.dispose();
    currentTarget = nextTarget;

    // Sample sky (top band) and ground (bottom band) average colors from tiny 8x4 buffer
    sampleCtx.drawImage(canvas, 0, 0, 8, 4);
    const px = sampleCtx.getImageData(0, 0, 8, 4).data;
    const avgBandHex = (startRow, rows) => {
      let r = 0;
      let g = 0;
      let b = 0;
      const n = rows * 8;
      for (let y = startRow; y < startRow + rows; y++) {
        for (let x = 0; x < 8; x++) {
          const i = (y * 8 + x) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
      }
      return (
        ((Math.round(r / n) & 0xff) << 16) |
        ((Math.round(g / n) & 0xff) << 8) |
        (Math.round(b / n) & 0xff)
      );
    };

    return {
      envTexture: nextTarget.texture,
      skyColor: avgBandHex(0, 1),
      groundColor: avgBandHex(3, 1)
    };
  }

  function dispose() {
    if (currentTarget) currentTarget.dispose();
    tex.dispose();
    pmrem.dispose();
  }

  return { update, dispose };
}

export function createVoxelMaterial(colorHex = '#00f5d4', material = 'matte', opacity = 1) {
  const color = new THREE.Color(colorHex || '#00f5d4');
  if (material === 'neon') {
    return new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.85,
      roughness: 0.16,
      metalness: 0.35,
      envMapIntensity: 1.5,
      transparent: opacity < 1,
      opacity
    });
  }
  if (material === 'glass') {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.06,
      metalness: 0.1,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      reflectivity: 0.95,
      envMapIntensity: 1.9,
      transparent: true,
      opacity: Math.min(0.72, opacity)
    });
  }
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.24,
    envMapIntensity: 1.3,
    transparent: opacity < 1,
    opacity
  });
}

export function buildVoxelGroup(voxels = [], { scale = 1, opacity = 1 } = {}) {
  const group = new THREE.Group();
  const unitGeo = new THREE.BoxGeometry(VOXEL_STEP * 0.96, VOXEL_STEP * 0.96, VOXEL_STEP * 0.96);
  const matCache = new Map();

  for (const v of voxels) {
    const key = `${v.color}|${v.material || 'matte'}|${opacity}`;
    let mat = matCache.get(key);
    if (!mat) {
      mat = createVoxelMaterial(v.color, v.material || 'matte', opacity);
      matCache.set(key, mat);
    }

    const mesh = new THREE.Mesh(unitGeo, mat);
    mesh.position.set(v.x * scale, v.y * scale, v.z * scale);
    const vScale = (v.scale ?? 1) * scale;
    mesh.scale.setScalar(vScale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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
