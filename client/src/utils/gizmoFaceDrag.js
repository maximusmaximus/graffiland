/**
 * Pure 3D plane/face dragging math for the Desktop 3D Sculpture Editor gizmo.
 * Lets users grab any of the 6 faces of the editing bounding box (top/base horizontal planes
 * or any of the 4 vertical side faces) and drag the model directly in that face's plane
 * without moving/orbiting the camera or scene around the object.
 */

export const GIZMO_BOX_FACES = [
  { id: 'top', axis: 'horizontal', label: 'Top Plane', localNormal: [0, 1, 0] },
  { id: 'bottom', axis: 'horizontal', label: 'Base Plane', localNormal: [0, -1, 0] },
  { id: 'front', axis: 'vertical', label: 'Front Face', localNormal: [0, 0, 1] },
  { id: 'back', axis: 'vertical', label: 'Back Face', localNormal: [0, 0, -1] },
  { id: 'right', axis: 'vertical', label: 'Right Face', localNormal: [1, 0, 0] },
  { id: 'left', axis: 'vertical', label: 'Left Face', localNormal: [-1, 0, 0] }
];

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/**
 * Rotates a box-local outward face normal around world +Y by yawRad (Three.js right-handed Y-up).
 */
export function computeFaceWorldNormal(localNormal = [0, 1, 0], yawRad = 0) {
  const [nx, ny, nz] = localNormal;
  const c = Math.cos(Number(yawRad || 0));
  const s = Math.sin(Number(yawRad || 0));
  const wx = nx * c + nz * s;
  const wy = ny;
  const wz = -nx * s + nz * c;
  const len = Math.hypot(wx, wy, wz) || 1;
  return [wx / len, wy / len, wz / len];
}

/**
 * Returns true if the face outward normal points toward the camera (not back-facing or edge-on).
 */
export function isFaceFacingCamera(worldNormal, hitPoint, cameraPos, minDot = 0.12) {
  if (!worldNormal || !hitPoint || !cameraPos) return false;
  const tx = Number(cameraPos.x ?? cameraPos[0] ?? 0) - Number(hitPoint.x ?? hitPoint[0] ?? 0);
  const ty = Number(cameraPos.y ?? cameraPos[1] ?? 0) - Number(hitPoint.y ?? hitPoint[1] ?? 0);
  const tz = Number(cameraPos.z ?? cameraPos[2] ?? 0) - Number(hitPoint.z ?? hitPoint[2] ?? 0);
  const len = Math.hypot(tx, ty, tz);
  if (len < 1e-6) return false;
  const dot = (worldNormal[0] * tx + worldNormal[1] * ty + worldNormal[2] * tz) / len;
  return dot > minDot;
}

/**
 * Computes the world-space drag plane (normal + coplanar point) for dragging a clicked box face.
 * - Top & bottom faces drag in the horizontal XZ plane at hitPoint.y.
 * - Vertical side faces drag in that face's exact vertical plane (moving along the face + up/down).
 */
export function computeFaceDragPlaneSpec({ face, yawRad = 0, hitPoint, cameraDir = null }) {
  const axis = face?.axis === 'vertical' ? 'vertical' : 'horizontal';
  const pt = [
    Number(hitPoint?.x ?? hitPoint?.[0] ?? 0),
    Number(hitPoint?.y ?? hitPoint?.[1] ?? 0),
    Number(hitPoint?.z ?? hitPoint?.[2] ?? 0)
  ];

  if (axis === 'horizontal') {
    return {
      axis: 'horizontal',
      normal: [0, 1, 0],
      point: pt
    };
  }

  let normal = computeFaceWorldNormal(face?.localNormal || [0, 0, 1], yawRad);
  if (cameraDir) {
    const cx = Number(cameraDir.x ?? cameraDir[0] ?? 0);
    const cy = Number(cameraDir.y ?? cameraDir[1] ?? 0);
    const cz = Number(cameraDir.z ?? cameraDir[2] ?? 0);
    const cLen = Math.hypot(cx, cy, cz) || 1;
    const align = Math.abs((normal[0] * cx + normal[1] * cy + normal[2] * cz) / cLen);
    if (align < 0.16) {
      // Safety fallback for extreme grazing angles: camera-facing vertical plane
      const hLen = Math.hypot(cx, cz);
      if (hLen > 1e-4) {
        normal = [-cx / hLen, 0, -cz / hLen];
      }
    }
  }

  return {
    axis: 'vertical',
    normal,
    point: pt
  };
}

/**
 * Computes the next clamped model transform patch from a face-plane raycast drag step.
 */
export function computeFaceDragTransform({
  axis = 'horizontal',
  startDx = 0,
  startDy = 0,
  startDz = 0,
  startPt,
  hitPoint,
  moveRanges = null,
  maxJumpMeters = 120
}) {
  const sx = Number(startPt?.x ?? startPt?.[0] ?? 0);
  const sy = Number(startPt?.y ?? startPt?.[1] ?? 0);
  const sz = Number(startPt?.z ?? startPt?.[2] ?? 0);
  const hx = Number(hitPoint?.x ?? hitPoint?.[0] ?? sx);
  const hy = Number(hitPoint?.y ?? hitPoint?.[1] ?? sy);
  const hz = Number(hitPoint?.z ?? hitPoint?.[2] ?? sz);

  let deltaX = hx - sx;
  let deltaY = hy - sy;
  let deltaZ = hz - sz;

  const jumpLen = Math.hypot(deltaX, axis === 'vertical' ? deltaY : 0, deltaZ);
  if (jumpLen > maxJumpMeters && jumpLen > 1e-6) {
    const scale = maxJumpMeters / jumpLen;
    deltaX *= scale;
    deltaY *= scale;
    deltaZ *= scale;
  }

  let nextDx = round2(Number(startDx || 0) + deltaX);
  let nextDz = round2(Number(startDz || 0) + deltaZ);
  if (moveRanges) {
    if (Number.isFinite(Number(moveRanges.minDx)) && Number.isFinite(Number(moveRanges.maxDx))) {
      nextDx = Math.max(Number(moveRanges.minDx), Math.min(Number(moveRanges.maxDx), nextDx));
    }
    if (Number.isFinite(Number(moveRanges.minDz)) && Number.isFinite(Number(moveRanges.maxDz))) {
      nextDz = Math.max(Number(moveRanges.minDz), Math.min(Number(moveRanges.maxDz), nextDz));
    }
  }

  if (axis === 'vertical') {
    const maxDy = moveRanges ? Math.max(0.5, Number(moveRanges.maxDy || 12)) : 24;
    const nextDy = Math.max(0, Math.min(maxDy, round2(Math.max(0, Number(startDy || 0)) + deltaY)));
    return { dx: nextDx, dy: nextDy, dz: nextDz };
  }

  return { dx: nextDx, dz: nextDz };
}
