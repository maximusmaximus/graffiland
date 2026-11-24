import { HUMAN_MAX_DRAW_SPAN_METERS, VOXEL_STEP } from './constants.mjs';

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

const CARDINAL_FACES = Object.freeze([
  { face: 'top', nx: 0, ny: 1, nz: 0 },
  { face: 'bottom', nx: 0, ny: -1, nz: 0 },
  { face: 'right', nx: 1, ny: 0, nz: 0 },
  { face: 'left', nx: -1, ny: 0, nz: 0 },
  { face: 'front', nx: 0, ny: 0, nz: 1 },
  { face: 'back', nx: 0, ny: 0, nz: -1 }
]);

function coordBucketKey(x, y, z) {
  return `${Math.round(Number(x) * 1000)},${Math.round(Number(y) * 1000)},${Math.round(Number(z) * 1000)}`;
}

/**
 * Computes empty face-adjacent candidate spaces around placed voxels so users can tilt/move
 * their phone up or sideways around existing blocks to select potential stacking slots easily.
 */
export function computeAdjacentCandidateSlots(
  voxels,
  { step = VOXEL_STEP, blockScale = 1, aroundVoxel = null } = {}
) {
  if (!Array.isArray(voxels) || voxels.length === 0) return [];
  const activeScale = normalizeBlockScale(blockScale);
  const occupiedKeys = new Set();
  for (const v of voxels) {
    if (!v || !Number.isFinite(Number(v.x))) continue;
    occupiedKeys.add(coordBucketKey(v.x, v.y, v.z));
  }

  const sourceList = aroundVoxel ? [aroundVoxel] : voxels;
  const seenCandidates = new Set();
  const candidates = [];

  for (const v of sourceList) {
    if (!v || !Number.isFinite(Number(v.x))) continue;
    const vScale = normalizeBlockScale(v.scale ?? 1);
    const stepOut = step * ((vScale + activeScale) * 0.5);
    for (const dir of CARDINAL_FACES) {
      const cx = roundCoord3(Number(v.x) + dir.nx * stepOut);
      const cy = roundCoord3(Number(v.y) + dir.ny * stepOut);
      const cz = roundCoord3(Number(v.z) + dir.nz * stepOut);
      const cKey = coordBucketKey(cx, cy, cz);
      if (occupiedKeys.has(cKey) || seenCandidates.has(cKey)) continue;

      // Reject slots that physically overlap another mixed-scale placed block
      let overlaps = false;
      for (const existing of voxels) {
        if (!existing || !Number.isFinite(Number(existing.x))) continue;
        const minSep = step * ((normalizeBlockScale(existing.scale ?? 1) + activeScale) * 0.42);
        if (
          Math.abs(cx - Number(existing.x)) < minSep &&
          Math.abs(cy - Number(existing.y)) < minSep &&
          Math.abs(cz - Number(existing.z)) < minSep
        ) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      seenCandidates.add(cKey);
      candidates.push({
        x: cx,
        y: cy,
        z: cz,
        scale: activeScale,
        face: dir.face,
        parentVoxel: v
      });
    }
  }
  return candidates;
}

/**
 * Selects the closest empty face-adjacent space around placed blocks along a camera/pointer ray,
 * enabling effortless upward/sideways phone movement to pick stacking spaces around existing blocks.
 */
export function findBestAdjacentVoxelSlot({
  rayOrigin,
  rayDir,
  voxels,
  step = VOXEL_STEP,
  blockScale = 1,
  maxDistance = 12
} = {}) {
  if (!rayOrigin || !rayDir || !Array.isArray(voxels) || voxels.length === 0) return null;
  const dirLen = Math.hypot(Number(rayDir.x) || 0, Number(rayDir.y) || 0, Number(rayDir.z) || 0);
  if (dirLen < 1e-6) return null;
  const dx = Number(rayDir.x) / dirLen;
  const dy = Number(rayDir.y) / dirLen;
  const dz = Number(rayDir.z) / dirLen;
  const ox = Number(rayOrigin.x) || 0;
  const oy = Number(rayOrigin.y) || 0;
  const oz = Number(rayOrigin.z) || 0;

  const activeScale = normalizeBlockScale(blockScale);
  const cellStep = getVoxelCellStep(step, activeScale);

  // Pre-filter placed voxels near the ray for O(1) fast candidate generation on large builds
  const relevantVoxels = [];
  for (const v of voxels) {
    if (!v || !Number.isFinite(Number(v.x))) continue;
    const vx = Number(v.x) - ox;
    const vy = Number(v.y) - oy;
    const vz = Number(v.z) - oz;
    const t = vx * dx + vy * dy + vz * dz;
    if (t < 0.05 || t > maxDistance) continue;
    const px = vx - dx * t;
    const py = vy - dy * t;
    const pz = vz - dz * t;
    const perp = Math.hypot(px, py, pz);
    const broadRadius = Math.max(cellStep * 3.6, Math.min(cellStep * 5.5, t * 0.22));
    if (perp <= broadRadius) {
      relevantVoxels.push(v);
    }
  }
  if (relevantVoxels.length === 0) return null;

  // Check occupancy against ALL voxels, generate candidates only from ray-nearby voxels
  const occupiedKeys = new Set();
  for (const v of voxels) {
    if (v && Number.isFinite(Number(v.x))) {
      occupiedKeys.add(coordBucketKey(v.x, v.y, v.z));
    }
  }

  const seenCandidates = new Set();
  let best = null;
  let bestScore = Infinity;

  for (const v of relevantVoxels) {
    const vScale = normalizeBlockScale(v.scale ?? 1);
    const stepOut = step * ((vScale + activeScale) * 0.5);
    for (const dir of CARDINAL_FACES) {
      const cx = roundCoord3(Number(v.x) + dir.nx * stepOut);
      const cy = roundCoord3(Number(v.y) + dir.ny * stepOut);
      const cz = roundCoord3(Number(v.z) + dir.nz * stepOut);
      const cKey = coordBucketKey(cx, cy, cz);
      if (occupiedKeys.has(cKey) || seenCandidates.has(cKey)) continue;
      seenCandidates.add(cKey);

      const vx = cx - ox;
      const vy = cy - oy;
      const vz = cz - oz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t < 0.15 || t > maxDistance) continue;

      const px = vx - dx * t;
      const py = vy - dy * t;
      const pz = vz - dz * t;
      const perpDist = Math.hypot(px, py, pz);
      const captureRadius = Math.max(cellStep * 1.18, Math.min(cellStep * 2.45, t * 0.095));
      if (perpDist > captureRadius) continue;

      // Reject physical overlap with any nearby placed voxel
      let overlaps = false;
      for (const existing of relevantVoxels) {
        const minSep = step * ((normalizeBlockScale(existing.scale ?? 1) + activeScale) * 0.42);
        if (
          Math.abs(cx - Number(existing.x)) < minSep &&
          Math.abs(cy - Number(existing.y)) < minSep &&
          Math.abs(cz - Number(existing.z)) < minSep
        ) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      // Primary metric: tight alignment to aim ray; gentle tie-breaker favors front-facing closer slot
      const score = perpDist + t * 0.004;
      if (score < bestScore) {
        bestScore = score;
        best = {
          x: cx,
          y: cy,
          z: cz,
          scale: activeScale,
          face: dir.face,
          parentVoxel: v,
          perpDist,
          rayDistance: t
        };
      }
    }
  }

  if (!best) return null;
  const nearbySlots = computeAdjacentCandidateSlots(voxels, {
    step,
    blockScale: activeScale,
    aroundVoxel: best.parentVoxel
  }).filter((s) => coordBucketKey(s.x, s.y, s.z) !== coordBucketKey(best.x, best.y, best.z));

  return {
    ...best,
    nearbySlots
  };
}

/**
 * Velocity-adaptive exponential smoothing for fluid spray-can 3D brush strokes.
 * Filters small hand tremor during slow curves while staying crisp and responsive on fast arcs.
 */
export function advanceFluidSprayPoint(
  prevPoint,
  rawPoint,
  { dtMs = 16.67, cellStep = VOXEL_STEP } = {}
) {
  if (!rawPoint || !Number.isFinite(Number(rawPoint.x))) return prevPoint || null;
  const rx = Number(rawPoint.x);
  const ry = Number(rawPoint.y);
  const rz = Number(rawPoint.z);
  if (!prevPoint || !Number.isFinite(Number(prevPoint.x))) {
    return { x: rx, y: ry, z: rz };
  }
  const px = Number(prevPoint.x);
  const py = Number(prevPoint.y);
  const pz = Number(prevPoint.z);
  const dist = Math.hypot(rx - px, ry - py, rz - pz);
  const safeCell = Math.max(0.01, Number(cellStep) || VOXEL_STEP);

  // Smooth slowly on fine details (~0.36), tighten rapidly up to ~0.86 on fast graffiti sweeps
  const speedRatio = Math.max(0, Math.min(1, (dist - safeCell * 0.5) / (safeCell * 3.0)));
  const baseAlpha = 0.36 + speedRatio * 0.5;
  const frameScale = Math.max(0.4, Math.min(3.0, (Number(dtMs) || 16.67) / 16.67));
  const alpha = 1 - Math.pow(1 - baseAlpha, frameScale);

  return {
    x: px + (rx - px) * alpha,
    y: py + (ry - py) * alpha,
    z: pz + (rz - pz) * alpha
  };
}

/**
 * Measures the physical horizontal footprint (width X, depth Z, and height Y in meters)
 * of a voxel list, including individual block extents and optional uniform transform scale/rotation.
 */
export function measureVoxelHorizontalFootprint(
  voxels,
  {
    step = VOXEL_STEP,
    scale = 1,
    rotYDeg = 0,
    rotZDeg = 0,
    pivot = null,
    maxSpanMeters = HUMAN_MAX_DRAW_SPAN_METERS
  } = {}
) {
  if (!Array.isArray(voxels) || voxels.length === 0) {
    return {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 0,
      widthMeters: 0,
      heightMeters: 0,
      depthMeters: 0,
      exceedsLimit: false
    };
  }

  const uniformScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  const radY = ((Number(rotYDeg) || 0) * Math.PI) / 180;
  const radZ = ((Number(rotZDeg) || 0) * Math.PI) / 180;
  const cosY = Math.cos(radY);
  const sinY = Math.sin(radY);
  const cosZ = Math.cos(radZ);
  const sinZ = Math.sin(radZ);
  const px = Number(pivot?.x || 0);
  const py = Number(pivot?.y || 0);
  const pz = Number(pivot?.z || 0);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const v of voxels) {
    const vx = Number(v?.x);
    const vy = Number(v?.y);
    const vz = Number(v?.z);
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) continue;
    const dx = (vx - px) * uniformScale;
    const dy = (vy - py) * uniformScale;
    const dz = (vz - pz) * uniformScale;
    // Euler YXZ with X=0 applies Z rotation first, then Y rotation (exact match to THREE.Euler(0, radY, radZ, 'YXZ'))
    const x1 = dx * cosZ - dy * sinZ;
    const y1 = dx * sinZ + dy * cosZ;
    const rx = px + x1 * cosY + dz * sinY;
    const ry = py + y1;
    const rz = pz - x1 * sinY + dz * cosY;
    const bakedBlockScale = normalizeBlockScale(normalizeBlockScale(v?.scale ?? 1) * uniformScale);
    const half = (step * bakedBlockScale) * 0.5;
    if (rx - half < minX) minX = rx - half;
    if (rx + half > maxX) maxX = rx + half;
    if (ry - half < minY) minY = ry - half;
    if (ry + half > maxY) maxY = ry + half;
    if (rz - half < minZ) minZ = rz - half;
    if (rz + half > maxZ) maxZ = rz + half;
  }

  if (!Number.isFinite(minX)) {
    return {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 0,
      widthMeters: 0,
      heightMeters: 0,
      depthMeters: 0,
      exceedsLimit: false
    };
  }

  const widthMeters = Math.max(0, Math.round((maxX - minX) * 10000) / 10000);
  const heightMeters = Math.max(0, Math.round((maxY - minY) * 10000) / 10000);
  const depthMeters = Math.max(0, Math.round((maxZ - minZ) * 10000) / 10000);
  const limit = Number(maxSpanMeters) > 0 ? Number(maxSpanMeters) : HUMAN_MAX_DRAW_SPAN_METERS;

  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    widthMeters,
    heightMeters,
    depthMeters,
    exceedsLimit: widthMeters > limit + 1e-4 || depthMeters > limit + 1e-4
  };
}

/**
 * Computes the maximum uniform transform scale (within [minScale, maxScale]) that keeps
 * a human voxel sculpture strictly inside the 250ft x 250ft (76.2m x 76.2m) drawing footprint.
 */
export function computeMaxHumanDrawScale(
  voxels,
  {
    step = VOXEL_STEP,
    rotYDeg = 0,
    rotZDeg = 0,
    pivot = null,
    maxSpanMeters = HUMAN_MAX_DRAW_SPAN_METERS,
    minScale = 0.25,
    maxScale = 2
  } = {}
) {
  if (!Array.isArray(voxels) || voxels.length === 0) return maxScale;
  const atMax = measureVoxelHorizontalFootprint(voxels, {
    step,
    scale: maxScale,
    rotYDeg,
    rotZDeg,
    pivot,
    maxSpanMeters
  });
  if (!atMax.exceedsLimit) return maxScale;

  let lo = minScale;
  let hi = maxScale;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) * 0.5;
    const probe = measureVoxelHorizontalFootprint(voxels, {
      step,
      scale: mid,
      rotYDeg,
      rotZDeg,
      pivot,
      maxSpanMeters
    });
    if (probe.exceedsLimit) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return Math.max(minScale, Math.floor(lo * 1000) / 1000);
}
