import * as THREE from 'three';

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'bumpMap'
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toVec3(pt) {
  if (!pt) return null;
  if (pt.isVector3) return pt.clone();
  const x = Number(pt.x);
  const y = Number(pt.y);
  const z = Number(pt.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return new THREE.Vector3(x, y, z);
}

/**
 * Computes progressive distance-based clarity & sharpness parameters for an AR land
 * and its artworks. Far lands render as clean atmospheric previews and progressively
 * sharpen in geometry detail, texture anisotropy, PBR contrast, shadows, and resolution
 * as the user walks closer.
 *
 * @param {number | null | undefined} distanceMeters
 * @param {{
 *   nearFullSharpMeters?: number,
 *   farSoftMeters?: number,
 *   lodUpgradeMeters?: number,
 *   shadowCutoffMeters?: number
 * }} [options]
 */
export function computeProximitySharpness(distanceMeters, options = {}) {
  const {
    nearFullSharpMeters = 5,
    farSoftMeters = 60,
    lodUpgradeMeters = 26,
    shadowCutoffMeters = 20
  } = options;

  const rawDist = Number(distanceMeters);
  const dist = Number.isFinite(rawDist) ? Math.max(0, rawDist) : 12;

  const span = Math.max(1, farSoftMeters - nearFullSharpMeters);
  const normDist = clamp((dist - nearFullSharpMeters) / span, 0, 1);

  // Smooth ease-out sharpening curve: 1.0 when <= 5m, dropping smoothly to 0.22 at >= 60m
  const eased = 1 - Math.pow(normDist, 0.78);
  const sharpness = Number(clamp(0.22 + eased * 0.78, 0.22, 1).toFixed(3));
  const sharpnessPct = Math.round(sharpness * 100);

  let tier = 'distant';
  let tierLabel = 'Distant';
  if (sharpness >= 0.88) {
    tier = 'ultra';
    tierLabel = 'Ultra-Sharp';
  } else if (sharpness >= 0.62) {
    tier = 'sharp';
    tierLabel = 'Sharp';
  } else if (sharpness >= 0.4) {
    tier = 'clarifying';
    tierLabel = 'Clarifying';
  }

  // Gentle atmospheric softness only past 8m; strictly 0px crisp within 8m
  const blurNorm = clamp((dist - 8) / Math.max(1, farSoftMeters - 8), 0, 1);
  const canvasBlurPx = Number((blurNorm * 1.35).toFixed(2));

  // Normalize sharpness onto 0..1 relative to [0.22..1.0] for continuous visual controls
  const s01 = clamp((sharpness - 0.22) / 0.78, 0, 1);

  return {
    distanceMeters: Math.round(dist * 10) / 10,
    sharpness,
    sharpnessPct,
    tier,
    tierLabel,
    simplifyVoxelLod: dist > lodUpgradeMeters,
    anisotropyRatio: Number(s01.toFixed(3)),
    enableShadows: dist <= shadowCutoffMeters,
    sculptureOpacity: Number((0.68 + s01 * 0.32).toFixed(3)),
    roughnessSoftening: Number(((1 - s01) * 0.22).toFixed(3)),
    envMapBoost: Number((0.55 + s01 * 0.63).toFixed(3)),
    prismOpacityScale: Number((0.58 + s01 * 0.42).toFixed(3)),
    canvasBlurPx,
    pixelRatioScale: Number((0.78 + s01 * 0.22).toFixed(3))
  };
}

/**
 * Projects a selected AR land's 3D world center & corners against the active Three.js
 * camera to compute blinking off-screen directional guidance arrows when out of view
 * and clean screen coordinates when the land enters view.
 *
 * @param {{
 *   targetWorld: THREE.Vector3 | { x: number, y: number, z: number },
 *   cornersWorld?: Array<THREE.Vector3 | { x: number, y: number, z: number }>,
 *   camera: THREE.Camera,
 *   isInside?: boolean,
 *   distanceMeters?: number
 * }} params
 */
export function computeArLandCameraGuidance({
  targetWorld,
  cornersWorld = [],
  camera,
  isInside = false,
  distanceMeters = 0
}) {
  const target = toVec3(targetWorld);
  if (!target || !camera) return null;

  if (typeof camera.updateMatrixWorld === 'function') {
    camera.updateMatrixWorld();
  }
  const invWorld =
    camera.matrixWorldInverse ||
    new THREE.Matrix4().copy(camera.matrixWorld).invert();

  // Camera-local space: +X = right, +Y = up, -Z = forward, +Z = behind
  const camLocal = target.clone().applyMatrix4(invWorld);
  const vx = camLocal.x;
  const vy = camLocal.y;
  const vz = camLocal.z;

  const isBehind = vz >= -0.05;
  const horizForward = Math.max(1e-5, Math.hypot(vx, -vz));
  const yawDeg = Math.round((Math.atan2(vx, -vz) * 180) / Math.PI);
  const pitchDeg = Math.round((Math.atan2(vy, horizForward) * 180) / Math.PI);
  const turnDegrees = Math.round(Math.hypot(yawDeg, pitchDeg));

  const ndc = target.clone().project(camera);
  const centerInView =
    !isBehind &&
    Number.isFinite(ndc.x) &&
    Number.isFinite(ndc.y) &&
    Math.abs(ndc.x) <= 0.86 &&
    Math.abs(ndc.y) <= 0.82;

  let cornersInViewCount = 0;
  let visibleSumX = 0;
  let visibleTopY = Infinity;
  for (const rawCorner of cornersWorld || []) {
    const corner = toVec3(rawCorner);
    if (!corner) continue;
    const cLocal = corner.clone().applyMatrix4(invWorld);
    if (cLocal.z >= -0.05) continue;
    const cNdc = corner.clone().project(camera);
    if (
      Number.isFinite(cNdc.x) &&
      Number.isFinite(cNdc.y) &&
      Math.abs(cNdc.x) <= 1.02 &&
      Math.abs(cNdc.y) <= 1.02
    ) {
      cornersInViewCount += 1;
      const sx = (cNdc.x + 1) * 0.5;
      const sy = (1 - cNdc.y) * 0.5;
      visibleSumX += sx;
      if (sy < visibleTopY) visibleTopY = sy;
    }
  }

  const closeEnoughForCornerLock = isInside || Number(distanceMeters) <= 8;
  const closeFacingAhead =
    (isInside || Number(distanceMeters) <= 6) &&
    !isBehind &&
    Math.abs(yawDeg) <= 44 &&
    Math.abs(pitchDeg) <= 62;
  const inView =
    centerInView ||
    closeFacingAhead ||
    (closeEnoughForCornerLock && cornersInViewCount >= 1);

  if (inView) {
    const rawSx = centerInView
      ? (ndc.x + 1) * 0.5
      : cornersInViewCount > 0
      ? visibleSumX / cornersInViewCount
      : 0.5;
    const rawSy =
      visibleTopY < Infinity
        ? visibleTopY
        : centerInView
        ? (1 - ndc.y) * 0.5
        : 0.34;
    return {
      inView: true,
      isBehind: false,
      edge: 'center',
      dirX: 0,
      dirY: 0,
      angleDeg: 0,
      yawDeg,
      pitchDeg,
      turnDegrees,
      instruction: 'Land in view',
      screenX: Number(clamp(rawSx, 0.14, 0.86).toFixed(3)),
      screenY: Number(clamp(rawSy, 0.14, 0.72).toFixed(3))
    };
  }

  // Compute true screen-space pointing direction (+dirX = right, +dirY = down)
  let rawDirX = 0;
  let rawDirY = 0;
  if (!isBehind && Number.isFinite(ndc.x) && Number.isFinite(ndc.y)) {
    rawDirX = ndc.x;
    rawDirY = -ndc.y;
  } else {
    // Behind the camera: project directly from camera-local (vx, -vy) so direction never inverts
    rawDirX = vx;
    rawDirY = -vy;
    if (Math.hypot(rawDirX, rawDirY) < 0.08) {
      rawDirX = vx < 0 ? -1 : 1;
      rawDirY = 0;
    }
  }

  const mag = Math.hypot(rawDirX, rawDirY) || 1;
  const dirX = rawDirX / mag;
  const dirY = rawDirY / mag;

  // Prefer left/right horizontal pan guidance when significant horizontal offset exists
  let edge = 'right';
  if (Math.abs(dirX) >= Math.abs(dirY) * 0.72) {
    edge = dirX >= 0 ? 'right' : 'left';
  } else {
    edge = dirY <= 0 ? 'top' : 'bottom';
  }

  const angleDeg = Math.round((Math.atan2(dirY, dirX) * 180) / Math.PI);

  let instruction = 'Move camera right';
  if (Math.abs(yawDeg) >= 125) {
    instruction = yawDeg >= 0 ? 'Turn around right' : 'Turn around left';
  } else if (edge === 'right') {
    instruction = 'Move camera right';
  } else if (edge === 'left') {
    instruction = 'Move camera left';
  } else if (edge === 'top') {
    instruction = 'Tilt camera up';
  } else {
    instruction = 'Tilt camera down';
  }

  // Project onto normalized viewport edge for edge-anchored indicator
  let screenX = 0.5;
  let screenY = 0.5;
  if (edge === 'right') {
    screenX = 0.92;
    screenY = clamp(0.5 + dirY * 0.28, 0.22, 0.78);
  } else if (edge === 'left') {
    screenX = 0.08;
    screenY = clamp(0.5 + dirY * 0.28, 0.22, 0.78);
  } else if (edge === 'top') {
    screenX = clamp(0.5 + dirX * 0.32, 0.2, 0.8);
    screenY = 0.14;
  } else {
    screenX = clamp(0.5 + dirX * 0.32, 0.2, 0.8);
    screenY = 0.86;
  }

  return {
    inView: false,
    isBehind,
    edge,
    dirX: Number(dirX.toFixed(3)),
    dirY: Number(dirY.toFixed(3)),
    angleDeg,
    yawDeg,
    pitchDeg,
    turnDegrees,
    instruction,
    screenX: Number(screenX.toFixed(3)),
    screenY: Number(screenY.toFixed(3))
  };
}

/**
 * Losslessly applies a proximity sharpness profile to a Three.js sculpture object tree:
 * ramps texture anisotropy, restores full PBR roughness/env reflections, activates crisp
 * shadows when close, and softly clears atmospheric distance translucency as user approaches.
 */
export function applyProximitySharpnessToObject3D(
  rootObj,
  sharpnessProfile,
  maxAnisotropy = 8
) {
  if (!rootObj || !sharpnessProfile || typeof rootObj.traverse !== 'function') return;

  const targetAnisotropy = Math.max(
    1,
    Math.round(1 + clamp(sharpnessProfile.anisotropyRatio ?? 1, 0, 1) * (Math.max(1, maxAnisotropy) - 1))
  );

  rootObj.traverse((obj) => {
    if (!obj?.isMesh && !obj?.isPoints) return;
    if (obj.userData?.isHitProxy || obj.userData?.clickableBase || obj.userData?.isArLandHit) {
      return;
    }

    const materials = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    const hasShadowMat = materials.some((m) => m?.isShadowMaterial);
    if (hasShadowMat) {
      obj.receiveShadow = Boolean(sharpnessProfile.enableShadows);
      return;
    }

    if (obj.isMesh) {
      obj.castShadow = Boolean(sharpnessProfile.enableShadows);
      obj.receiveShadow = Boolean(sharpnessProfile.enableShadows);
    }

    for (const mat of materials) {
      if (!mat) continue;
      if (!mat.userData) mat.userData = {};
      if (!mat.userData.__arBase) {
        mat.userData.__arBase = {
          opacity: Number.isFinite(mat.opacity) ? mat.opacity : 1,
          transparent: Boolean(mat.transparent),
          roughness: Number.isFinite(mat.roughness) ? mat.roughness : null,
          envMapIntensity: Number.isFinite(mat.envMapIntensity) ? mat.envMapIntensity : 1
        };
      }
      const base = mat.userData.__arBase;

      const nextOpacity = Number((base.opacity * sharpnessProfile.sculptureOpacity).toFixed(3));
      const nextTransparent = base.transparent || nextOpacity < 0.995;
      if (mat.transparent !== nextTransparent) {
        mat.transparent = nextTransparent;
        mat.needsUpdate = true;
      }
      if (Number.isFinite(mat.opacity)) {
        mat.opacity = nextOpacity;
      }

      if (base.roughness !== null && Number.isFinite(mat.roughness)) {
        mat.roughness = clamp(base.roughness + sharpnessProfile.roughnessSoftening, 0.04, 1);
      }

      if ('envMapIntensity' in mat && Number.isFinite(base.envMapIntensity)) {
        mat.envMapIntensity = Number((base.envMapIntensity * sharpnessProfile.envMapBoost).toFixed(3));
      }

      for (const slot of TEXTURE_SLOTS) {
        const tex = mat[slot];
        if (tex && tex.anisotropy !== targetAnisotropy) {
          tex.anisotropy = targetAnisotropy;
          tex.needsUpdate = true;
        }
      }
    }
  });
}
