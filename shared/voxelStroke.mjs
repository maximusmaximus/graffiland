import { VOXEL_STEP } from './constants.mjs';

export const BLOCK_SIZE_PRESETS = Object.freeze([
  { id: 's', label: 'S', scale: 0.5, hint: 'Fine · 0.5×' },
  { id: 'm', label: 'M', scale: 1, hint: 'Standard · 1×' },
  { id: 'l', label: 'L', scale: 1.5, hint: 'Large · 1.5×' },
  { id: 'xl', label: 'XL', scale: 2, hint: 'Chunky · 2×' }
]);

export const STANDARD_COLOR_PRESETS = Object.freeze([
  { name: 'Red', hex: '#ef4444' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Yellow', hex: '#facc15' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Cyan', hex: '#00f5d4' },
  { name: 'Sky Blue', hex: '#38bdf8' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Purple', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'White', hex: '#f8fafc' },
  { name: 'Gray', hex: '#94a3b8' },
  { name: 'Black', hex: '#1e293b' }
]);

export function normalizeBlockScale(rawScale = 1) {
  const n = Number(rawScale);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(2, Math.round(n * 100) / 100));
}

export function roundCoord3(val) {
  return Math.round(Number(val) * 1000) / 1000;
}

export function getVoxelCellStep(step = VOXEL_STEP, blockScale = 1) {
  return step * normalizeBlockScale(blockScale);
}

export function snapToVoxelLattice(value, step = VOXEL_STEP, blockScale = 1) {
  const cellStep = getVoxelCellStep(step, blockScale);
  return roundCoord3(Math.round(Number(value) / cellStep) * cellStep);
}

export function snapPointToVoxelLattice(point, step = VOXEL_STEP, blockScale = 1) {
  const scale = normalizeBlockScale(blockScale);
  return {
    x: snapToVoxelLattice(point.x, step, scale),
    y: snapToVoxelLattice(point.y, step, scale),
    z: snapToVoxelLattice(point.z, step, scale),
    scale
  };
}

/**
 * Generates a strictly 6-connected (face-adjacent) 3D voxel path from `fromPoint` to `toPoint`
 * using 3D Amanatides-Woo face-stepping traversal.
 *
 * Every consecutive voxel in the returned `path` (starting from `fromPoint`) advances by
 * exactly +/- 1 cell along a SINGLE axis (X, Y, or Z), guaranteeing that lines and curves
 * NEVER break apart or leave diagonal corner-only gaps.
 */
export function buildConnectedVoxelPath(
  fromPoint,
  toPoint,
  { step = VOXEL_STEP, blockScale = 1, maxSteps = 96 } = {}
) {
  const scale = normalizeBlockScale(blockScale);
  const cellStep = getVoxelCellStep(step, scale);
  if (!toPoint || !Number.isFinite(Number(toPoint.x))) {
    return { path: [], lastPoint: fromPoint || null };
  }

  const endIdxX = Math.round(Number(toPoint.x) / cellStep);
  const endIdxY = Math.round(Number(toPoint.y) / cellStep);
  const endIdxZ = Math.round(Number(toPoint.z) / cellStep);

  if (!fromPoint || !Number.isFinite(Number(fromPoint.x))) {
    const first = {
      action: 'add',
      x: roundCoord3(endIdxX * cellStep),
      y: roundCoord3(endIdxY * cellStep),
      z: roundCoord3(endIdxZ * cellStep),
      scale
    };
    return { path: [first], lastPoint: { x: first.x, y: first.y, z: first.z, scale } };
  }

  let curX = Math.round(Number(fromPoint.x) / cellStep);
  let curY = Math.round(Number(fromPoint.y) / cellStep);
  let curZ = Math.round(Number(fromPoint.z) / cellStep);

  const dx = endIdxX - curX;
  const dy = endIdxY - curY;
  const dz = endIdxZ - curZ;
  const totalSteps = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);

  if (totalSteps === 0) {
    return {
      path: [],
      lastPoint: {
        x: roundCoord3(curX * cellStep),
        y: roundCoord3(curY * cellStep),
        z: roundCoord3(curZ * cellStep),
        scale
      }
    };
  }

  const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
  const stepZ = dz === 0 ? 0 : dz > 0 ? 1 : -1;

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const absZ = Math.abs(dz);

  const tDeltaX = absX > 0 ? 1 / absX : Infinity;
  const tDeltaY = absY > 0 ? 1 / absY : Infinity;
  const tDeltaZ = absZ > 0 ? 1 / absZ : Infinity;

  let tMaxX = absX > 0 ? 0.5 / absX : Infinity;
  let tMaxY = absY > 0 ? 0.5 / absY : Infinity;
  let tMaxZ = absZ > 0 ? 0.5 / absZ : Infinity;

  const limit = Math.min(Math.max(1, Number(maxSteps) || 96), totalSteps);
  const path = [];

  for (let i = 0; i < limit; i += 1) {
    // Advance strictly ONE axis per step so every consecutive voxel shares a full face
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ && curX !== endIdxX) {
      curX += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxX && tMaxY <= tMaxZ && curY !== endIdxY) {
      curY += stepY;
      tMaxY += tDeltaY;
    } else if (curZ !== endIdxZ) {
      curZ += stepZ;
      tMaxZ += tDeltaZ;
    } else if (curX !== endIdxX) {
      curX += stepX;
      tMaxX += tDeltaX;
    } else if (curY !== endIdxY) {
      curY += stepY;
      tMaxY += tDeltaY;
    } else {
      break;
    }

    path.push({
      action: 'add',
      x: roundCoord3(curX * cellStep),
      y: roundCoord3(curY * cellStep),
      z: roundCoord3(curZ * cellStep),
      scale
    });
  }

  const last = path[path.length - 1];
  return {
    path,
    lastPoint: last
      ? { x: last.x, y: last.y, z: last.z, scale }
      : {
          x: roundCoord3(curX * cellStep),
          y: roundCoord3(curY * cellStep),
          z: roundCoord3(curZ * cellStep),
          scale
        }
  };
}

/**
 * Verifies that two voxel positions are strictly face-adjacent (Manhattan distance === 1 cell).
 */
export function areVoxelsFaceConnected(a, b, { step = VOXEL_STEP, blockScale = 1 } = {}) {
  if (!a || !b) return false;
  const cellStep = getVoxelCellStep(step, blockScale);
  const dx = Math.abs(Math.round(Number(a.x) / cellStep) - Math.round(Number(b.x) / cellStep));
  const dy = Math.abs(Math.round(Number(a.y) / cellStep) - Math.round(Number(b.y) / cellStep));
  const dz = Math.abs(Math.round(Number(a.z) / cellStep) - Math.round(Number(b.z) / cellStep));
  return dx + dy + dz === 1;
}
