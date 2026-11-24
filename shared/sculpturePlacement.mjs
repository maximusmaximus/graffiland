import { buildDefaultVolumeFromBounds } from './landVolume.mjs';
import { decodeGeohashBounds } from '../server/services/pol.mjs';

export const MIN_ARTWORK_SCALE = 0.001;
export const MAX_ARTWORK_SCALE = 60;
export const DEFAULT_ITEM_GAP_METERS = 0.08;
export const DEFAULT_WALL_MARGIN_METERS = 0.02;
export const VOXEL_UNIT_METERS = 0.05;

const METERS_PER_DEG_LAT = 111320;
const EPS = 1e-3;

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function round4(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

/**
 * Converts a stored yaw value (degrees from UI controls, or radians from legacy/quest records)
 * into radians for Three.js rotation and oriented AABB footprint math.
 * @param {number} yaw
 * @returns {number}
 */
export function yawToRadians(yaw) {
  const val = Number(yaw || 0);
  if (!Number.isFinite(val) || val === 0) return 0;
  if (Math.abs(val) > Math.PI * 2 + 0.01) {
    return (val * Math.PI) / 180;
  }
  if (Number.isInteger(val) && Math.abs(val) >= 5) {
    return (val * Math.PI) / 180;
  }
  return val;
}

/**
 * Normalizes a stored yaw value into degrees for slider UI display (-180..180).
 * @param {number} yaw
 * @returns {number}
 */
export function yawToDegrees(yaw) {
  const val = Number(yaw || 0);
  if (!Number.isFinite(val) || val === 0) return 0;
  let deg = val;
  if (Math.abs(val) <= Math.PI * 2 + 0.01 && !(Number.isInteger(val) && Math.abs(val) >= 5)) {
    deg = (val * 180) / Math.PI;
  }
  let wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  if (wrapped === -180 && deg > 0) wrapped = 180;
  return Math.round(wrapped * 10) / 10;
}

/**
 * Reads the persisted uniform scale factor for a sculpture (voxel or custom-3d).
 * @param {any} sculpture
 * @returns {number}
 */
export function extractSculptureScale(sculpture) {
  const candidates = [
    sculpture?.scale,
    sculpture?.anchorOffset?.scale,
    sculpture?.meshStats?.transformScale,
    sculpture?.customModel?.scale
  ];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(MIN_ARTWORK_SCALE, Math.min(MAX_ARTWORK_SCALE, round4(n)));
    }
  }
  return 1;
}

/**
 * Normalizes a `{ width, height, depth }` bounding box object into positive finite meters.
 * @param {any} raw
 * @returns {{ width: number, height: number, depth: number } | null}
 */
export function normalizeBaseDimensions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const w = Number(raw.width ?? raw.x);
  const h = Number(raw.height ?? raw.y);
  const d = Number(raw.depth ?? raw.z);
  if (![w, h, d].every((v) => Number.isFinite(v) && v > 0)) return null;
  return {
    width: Math.max(0.01, Math.min(100000, round4(w))),
    height: Math.max(0.01, Math.min(100000, round4(h))),
    depth: Math.max(0.01, Math.min(100000, round4(d)))
  };
}

/**
 * Computes unscaled 3D dimensions (width, height, depth in meters at scale = 1)
 * for any voxel or custom-3d sculpture.
 * @param {any} sculpture
 * @param {{ width?: number, height?: number, depth?: number } | null} [overrideDims]
 * @returns {{ width: number, height: number, depth: number }}
 */
export function extractSculptureBaseDimensions(sculpture, overrideDims = null) {
  const fromOverride = normalizeBaseDimensions(overrideDims);
  if (fromOverride) return fromOverride;

  const fromMeshStats = normalizeBaseDimensions(
    sculpture?.baseDimensions || sculpture?.meshStats?.bbox
  );
  if (fromMeshStats) return fromMeshStats;

  const voxels = Array.isArray(sculpture?.voxels) ? sculpture.voxels : [];
  if (voxels.length > 0) {
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
      const half = (VOXEL_UNIT_METERS / 2) * (Number(v?.scale) > 0 ? Number(v.scale) : 1);
      if (vx - half < minX) minX = vx - half;
      if (vx + half > maxX) maxX = vx + half;
      if (vy - half < minY) minY = vy - half;
      if (vy + half > maxY) maxY = vy + half;
      if (vz - half < minZ) minZ = vz - half;
      if (vz + half > maxZ) maxZ = vz + half;
    }
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      return {
        width: Math.max(0.08, round4(maxX - minX)),
        height: Math.max(0.08, round4(maxY - minY)),
        depth: Math.max(0.08, round4(maxZ - minZ))
      };
    }
  }

  if (sculpture?.modelType === 'custom-3d' || sculpture?.customModel?.format) {
    // Matches customModelLoader.js auto-fit showcase normalization (~1.4m max span at scale = 1)
    return { width: 1.4, height: 1.4, depth: 1.4 };
  }

  const count = Math.max(1, Number(sculpture?.voxelCount || 1));
  const est = Math.max(0.25, Math.min(2.4, Math.cbrt(count) * 0.14));
  return {
    width: round4(est),
    height: round4(est),
    depth: round4(est)
  };
}

/**
 * Resolves a valid parcel 3D volume from `{ parcel, volume, sculpture }` (or a direct parcel/volume object).
 * @param {any} input
 * @returns {{ centerLat: number, centerLng: number, widthMeters: number, depthMeters: number, heightMeters: number, rotationDeg: number, baseAltitudeM: number }}
 */
export function resolveParcelVolumeForPlacement(input = {}) {
  const isWrapped =
    input &&
    typeof input === 'object' &&
    ('parcel' in input || 'volume' in input || 'sculpture' in input);
  const parcel = isWrapped ? input.parcel || null : input?.parcelId || input?.bounds ? input : null;
  const volume = isWrapped
    ? input.volume || null
    : Number.isFinite(Number(input?.widthMeters))
    ? input
    : null;
  const sculpture = isWrapped ? input.sculpture || null : null;
  const src = volume || parcel?.volume || (isWrapped ? null : input?.volume) || null;
  if (
    src &&
    Number.isFinite(Number(src.widthMeters)) &&
    Number.isFinite(Number(src.depthMeters)) &&
    Number.isFinite(Number(src.heightMeters)) &&
    Number(src.widthMeters) > 0 &&
    Number(src.depthMeters) > 0 &&
    Number(src.heightMeters) > 0
  ) {
    return {
      centerLat: Number(src.centerLat ?? parcel?.centerLat ?? sculpture?.lat ?? 0),
      centerLng: Number(src.centerLng ?? parcel?.centerLng ?? sculpture?.lng ?? 0),
      widthMeters: Number(src.widthMeters),
      depthMeters: Number(src.depthMeters),
      heightMeters: Number(src.heightMeters),
      rotationDeg: Number(src.rotationDeg || 0),
      baseAltitudeM: Number(src.baseAltitudeM || 0)
    };
  }

  const bounds =
    parcel?.bounds ||
    sculpture?.parcelBounds ||
    (sculpture?.geohash ? decodeGeohashBounds(sculpture.geohash) : null);
  if (bounds?.sw && bounds?.ne) {
    const built = buildDefaultVolumeFromBounds(
      bounds,
      parcel?.parcelId || sculpture?.parcelId || '',
      parcel?.geohash || sculpture?.geohash || ''
    );
    if (built) return built;
  }

  return {
    centerLat: Number(sculpture?.lat || 0),
    centerLng: Number(sculpture?.lng || 0),
    widthMeters: 14,
    depthMeters: 14,
    heightMeters: 18,
    rotationDeg: 0,
    baseAltitudeM: 0
  };
}

/**
 * Converts a geographic (lat, lng) coordinate into local parcel meters (x = East, z = South/North)
 * aligned to the parcel's rotation angle.
 * @param {number} lat
 * @param {number} lng
 * @param {any} parcelVolume
 * @returns {{ baseX: number, baseZ: number }}
 */
export function latLngToParcelLocalMeters(lat, lng, parcelVolume) {
  const cLat = Number(parcelVolume?.centerLat);
  const cLng = Number(parcelVolume?.centerLng);
  const sLat = Number(lat);
  const sLng = Number(lng);
  if (![cLat, cLng, sLat, sLng].every(Number.isFinite)) {
    return { baseX: 0, baseZ: 0 };
  }
  const cosLat = Math.max(0.15, Math.cos((cLat * Math.PI) / 180));
  const east = (sLng - cLng) * METERS_PER_DEG_LAT * cosLat;
  const south = -(sLat - cLat) * METERS_PER_DEG_LAT;
  const rotRad = -((Number(parcelVolume?.rotationDeg || 0) * Math.PI) / 180);
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  return {
    baseX: round3(east * cosR - south * sinR),
    baseZ: round3(east * sinR + south * cosR)
  };
}

/**
 * Exact algebraic inverse of `latLngToParcelLocalMeters`: rotates parcel-local `(dx, dz)`
 * meters (X = local East/width, Z = local South/depth) by the parcel's clockwise `rotationDeg`
 * into world meters (`east` = Three.js +X, `south` = Three.js +Z, `north` = -south).
 * @param {number} dx
 * @param {number} dz
 * @param {number} [rotationDeg]
 * @returns {{ east: number, south: number, north: number }}
 */
export function parcelLocalMetersToWorldMeters(dx = 0, dz = 0, rotationDeg = 0) {
  const lx = Number(dx || 0);
  const lz = Number(dz || 0);
  if (!Number.isFinite(lx) || !Number.isFinite(lz)) {
    return { east: 0, south: 0, north: 0 };
  }
  const rotRad = (Number(rotationDeg || 0) * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const east = lx * cosR - lz * sinR;
  const south = lx * sinR + lz * cosR;
  return {
    east: round4(east),
    south: round4(south),
    north: round4(-south)
  };
}

/**
 * Converts a parcel-local sculpture yaw (degrees or radians, CCW around +Y in Three.js)
 * into world Three.js Y-rotation radians accounting for the parcel's clockwise `rotationDeg`.
 * @param {number} yaw
 * @param {number} [rotationDeg]
 * @returns {number}
 */
export function parcelLocalYawToWorldYawRad(yaw = 0, rotationDeg = 0) {
  const parcelRotRad = (Number(rotationDeg || 0) * Math.PI) / 180;
  return yawToRadians(yaw) - parcelRotRad;
}

/**
 * Converts a sculpture's base `(lat, lng)` plus parcel-local `(dx, dz)` offset into
 * exact world `(lat, lng)` and world meter offsets `(worldDx, worldDz)` accounting for `rotationDeg`.
 * @param {number} baseLat
 * @param {number} baseLng
 * @param {number} [dx]
 * @param {number} [dz]
 * @param {number} [rotationDeg]
 */
export function parcelLocalOffsetToWorldLatLng(baseLat, baseLng, dx = 0, dz = 0, rotationDeg = 0) {
  const lat0 = Number(baseLat);
  const lng0 = Number(baseLng);
  const { east, south } = parcelLocalMetersToWorldMeters(dx, dz, rotationDeg);
  if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) {
    return { lat: lat0, lng: lng0, worldDx: east, worldDz: south };
  }
  const cosLat = Math.max(0.08, Math.cos((lat0 * Math.PI) / 180));
  return {
    lat: lat0 - south / METERS_PER_DEG_LAT,
    lng: lng0 + east / (METERS_PER_DEG_LAT * cosLat),
    worldDx: east,
    worldDz: south
  };
}

/**
 * Builds a normalized placement descriptor for any sculpture inside a parcel volume.
 * @param {any} sculpture
 * @param {any} parcelVolume
 * @param {{ width?: number, height?: number, depth?: number } | null} [overrideDims]
 */
export function buildPlacementItemFromSculpture(sculpture, parcelVolume, overrideDims = null) {
  const dims = extractSculptureBaseDimensions(sculpture, overrideDims);
  const scale = extractSculptureScale(sculpture);
  const off = sculpture?.anchorOffset || {};
  const { baseX, baseZ } = latLngToParcelLocalMeters(sculpture?.lat, sculpture?.lng, parcelVolume);
  return {
    id: String(sculpture?.id || ''),
    title: String(sculpture?.title || '3D Artwork'),
    baseX,
    baseZ,
    dx: Number.isFinite(Number(off.dx)) ? Number(off.dx) : 0,
    dy: Number.isFinite(Number(off.dy)) ? Math.max(0, Number(off.dy)) : 0,
    dz: Number.isFinite(Number(off.dz)) ? Number(off.dz) : 0,
    yaw: Number.isFinite(Number(off.yaw)) ? Number(off.yaw) : 0,
    scale,
    baseWidth: dims.width,
    baseHeight: dims.height,
    baseDepth: dims.depth
  };
}

/**
 * Computes the axis-aligned 3D bounding box of a placed item in parcel-local meters.
 * @param {any} item
 */
export function computeItemLocalBox(item) {
  const scale = Math.max(MIN_ARTWORK_SCALE, Number(item?.scale || 1));
  const bw = Math.max(0.05, Number(item?.baseWidth || 1)) * scale;
  const bh = Math.max(0.05, Number(item?.baseHeight || 1)) * scale;
  const bd = Math.max(0.05, Number(item?.baseDepth || 1)) * scale;
  const rad = yawToRadians(item?.yaw || 0);
  const absC = Math.abs(Math.cos(rad));
  const absS = Math.abs(Math.sin(rad));
  const effW = bw * absC + bd * absS;
  const effD = bw * absS + bd * absC;
  const effH = bh;

  const cx = Number(item?.baseX || 0) + Number(item?.dx || 0);
  const cz = Number(item?.baseZ || 0) + Number(item?.dz || 0);
  const minY = Math.max(0, Number(item?.dy || 0));
  const halfW = effW / 2;
  const halfD = effD / 2;

  return {
    cx,
    cy: minY + effH / 2,
    cz,
    effW,
    effD,
    effH,
    halfW,
    halfD,
    minX: cx - halfW,
    maxX: cx + halfW,
    minY,
    maxY: minY + effH,
    minZ: cz - halfD,
    maxZ: cz + halfD
  };
}

/**
 * Computes the theoretical maximum uniform scale for an item to fit inside `parcelVolume` alone.
 * @param {any} item
 * @param {any} parcelVolume
 * @param {{ wallMargin?: number }} [opts]
 * @returns {number}
 */
export function computeMaxScaleForParcel(
  item,
  parcelVolume,
  { wallMargin = DEFAULT_WALL_MARGIN_METERS } = {}
) {
  const volW = Math.max(0.5, Number(parcelVolume?.widthMeters || 14) - 2 * wallMargin);
  const volD = Math.max(0.5, Number(parcelVolume?.depthMeters || 14) - 2 * wallMargin);
  const volH = Math.max(0.5, Number(parcelVolume?.heightMeters || 18) - wallMargin);

  const unitBox = computeItemLocalBox({ ...item, scale: 1 });
  const maxS = Math.min(
    volW / Math.max(0.01, unitBox.effW),
    volD / Math.max(0.01, unitBox.effD),
    volH / Math.max(0.01, unitBox.effH),
    MAX_ARTWORK_SCALE
  );
  if (!Number.isFinite(maxS) || maxS < MIN_ARTWORK_SCALE) {
    return 0;
  }
  return maxS < 0.1 ? Math.floor(maxS * 10000) / 10000 : Math.floor(maxS * 1000) / 1000;
}

function clampItemInsideParcel(item, halfVolW, halfVolD, volH, wallMargin) {
  const box = computeItemLocalBox(item);
  const minCx = -halfVolW + wallMargin + box.halfW;
  const maxCx = halfVolW - wallMargin - box.halfW;
  const minCz = -halfVolD + wallMargin + box.halfD;
  const maxCz = halfVolD - wallMargin - box.halfD;
  const maxDy = Math.max(0, volH - wallMargin - box.effH);

  let clamped = false;
  let nextCx = box.cx;
  let nextCz = box.cz;
  let nextDy = Math.max(0, Number(item.dy || 0));

  if (minCx <= maxCx) {
    if (nextCx < minCx - 1e-6) {
      nextCx = minCx;
      clamped = true;
    } else if (nextCx > maxCx + 1e-6) {
      nextCx = maxCx;
      clamped = true;
    }
  } else {
    nextCx = 0;
    clamped = true;
  }

  if (minCz <= maxCz) {
    if (nextCz < minCz - 1e-6) {
      nextCz = minCz;
      clamped = true;
    } else if (nextCz > maxCz + 1e-6) {
      nextCz = maxCz;
      clamped = true;
    }
  } else {
    nextCz = 0;
    clamped = true;
  }

  if (nextDy > maxDy + 1e-6) {
    nextDy = maxDy;
    clamped = true;
  }
  if (Number(item.dy || 0) < -1e-6) {
    nextDy = 0;
    clamped = true;
  }

  item.dx = nextCx - Number(item.baseX || 0);
  item.dz = nextCz - Number(item.baseZ || 0);
  item.dy = nextDy;
  return clamped;
}

function isBoxInsideParcel(box, halfVolW, halfVolD, volH, wallMargin) {
  return (
    box.minX >= -halfVolW + wallMargin - EPS &&
    box.maxX <= halfVolW - wallMargin + EPS &&
    box.minZ >= -halfVolD + wallMargin - EPS &&
    box.maxZ <= halfVolD - wallMargin + EPS &&
    box.minY >= -EPS &&
    box.maxY <= volH - wallMargin + EPS
  );
}

function computeBoxOverlap(a, b, gap) {
  const overlapX = a.halfW + b.halfW + gap - Math.abs(a.cx - b.cx);
  const overlapZ = a.halfD + b.halfD + gap - Math.abs(a.cz - b.cz);
  const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + gap * 0.5;
  return {
    colliding: overlapX > EPS && overlapZ > EPS && overlapY > EPS,
    overlapX,
    overlapZ,
    overlapY
  };
}

function findBestEscapeForSibling(sib, obstacleBox, origCx, origCz, halfVolW, halfVolD, wallMargin, gap) {
  const sibBox = computeItemLocalBox(sib);
  const minCx = -halfVolW + wallMargin + sibBox.halfW;
  const maxCx = halfVolW - wallMargin - sibBox.halfW;
  const minCz = -halfVolD + wallMargin + sibBox.halfD;
  const maxCz = halfVolD - wallMargin - sibBox.halfD;

  const pushPlusX = obstacleBox.maxX + gap + sibBox.halfW;
  const pushMinusX = obstacleBox.minX - gap - sibBox.halfW;
  const pushPlusZ = obstacleBox.maxZ + gap + sibBox.halfD;
  const pushMinusZ = obstacleBox.minZ - gap - sibBox.halfD;

  // Candidate positions: 4 cardinal slides + 4 corner slides around obstacle
  const candidates = [
    { cx: pushPlusX, cz: sibBox.cz, dir: 1 },
    { cx: pushMinusX, cz: sibBox.cz, dir: -1 },
    { cx: sibBox.cx, cz: pushPlusZ, dir: 1 },
    { cx: sibBox.cx, cz: pushMinusZ, dir: -1 },
    { cx: pushPlusX, cz: pushPlusZ, dir: 0 },
    { cx: pushPlusX, cz: pushMinusZ, dir: 0 },
    { cx: pushMinusX, cz: pushPlusZ, dir: 0 },
    { cx: pushMinusX, cz: pushMinusZ, dir: 0 }
  ];

  // Prefer pushing away from obstacle center when distances are nearly equal
  const awayX = sibBox.cx - obstacleBox.cx;
  const awayZ = sibBox.cz - obstacleBox.cz;

  let best = null;
  let bestScore = Infinity;

  for (const cand of candidates) {
    if (cand.cx < minCx - 1e-5 || cand.cx > maxCx + 1e-5) continue;
    if (cand.cz < minCz - 1e-5 || cand.cz > maxCz + 1e-5) continue;

    const clampedCx = Math.max(minCx, Math.min(maxCx, cand.cx));
    const clampedCz = Math.max(minCz, Math.min(maxCz, cand.cz));
    const moveDist = Math.hypot(clampedCx - sibBox.cx, clampedCz - sibBox.cz);
    const driftDist = Math.hypot(clampedCx - origCx, clampedCz - origCz);
    const dotAway = (clampedCx - sibBox.cx) * awayX + (clampedCz - sibBox.cz) * awayZ;
    const awayBonus = dotAway > 0 ? -0.05 : 0;
    const score = moveDist * 1.0 + driftDist * 0.2 + awayBonus;

    if (score < bestScore) {
      bestScore = score;
      best = { cx: clampedCx, cz: clampedCz };
    }
  }

  return best;
}

/**
 * Deterministic 3D placement, scaling & non-intersecting collision-push solver for artworks on a Virtual Land.
 * @param {{
 *   parcelVolume: any,
 *   targetId: string,
 *   targetTransform?: { dx?: number, dy?: number, dz?: number, yaw?: number, scale?: number },
 *   items?: any[],
 *   minGapMeters?: number,
 *   wallMargin?: number
 * }} params
 */
export function resolveSculpturePlacement({
  parcelVolume,
  targetId,
  targetTransform = {},
  items = [],
  minGapMeters = DEFAULT_ITEM_GAP_METERS,
  wallMargin = DEFAULT_WALL_MARGIN_METERS
}) {
  const vol = resolveParcelVolumeForPlacement({ volume: parcelVolume });
  const halfVolW = vol.widthMeters / 2;
  const halfVolD = vol.depthMeters / 2;
  const volH = vol.heightMeters;
  const gap = Math.max(0, Number(minGapMeters || 0));
  const margin = Math.max(0, Number(wallMargin || 0));

  const cloned = (items || []).map((it) => ({
    ...it,
    id: String(it.id || ''),
    baseX: Number(it.baseX || 0),
    baseZ: Number(it.baseZ || 0),
    dx: Number(it.dx || 0),
    dy: Math.max(0, Number(it.dy || 0)),
    dz: Number(it.dz || 0),
    yaw: Number(it.yaw || 0),
    scale: Math.max(MIN_ARTWORK_SCALE, Number(it.scale || 1)),
    baseWidth: Math.max(0.05, Number(it.baseWidth || 1)),
    baseHeight: Math.max(0.05, Number(it.baseHeight || 1)),
    baseDepth: Math.max(0.05, Number(it.baseDepth || 1))
  }));

  let target = cloned.find((it) => it.id === String(targetId || ''));
  if (!target) {
    target = {
      id: String(targetId || 'target'),
      title: '3D Artwork',
      baseX: 0,
      baseZ: 0,
      dx: 0,
      dy: 0,
      dz: 0,
      yaw: 0,
      scale: 1,
      baseWidth: 1.4,
      baseHeight: 1.4,
      baseDepth: 1.4
    };
    cloned.push(target);
  }

  // Apply requested transform to target
  if (targetTransform.dx !== undefined) target.dx = Number(targetTransform.dx || 0);
  if (targetTransform.dy !== undefined) target.dy = Number(targetTransform.dy || 0);
  if (targetTransform.dz !== undefined) target.dz = Number(targetTransform.dz || 0);
  if (targetTransform.yaw !== undefined) target.yaw = Number(targetTransform.yaw || 0);
  if (targetTransform.scale !== undefined) target.scale = Number(targetTransform.scale || 1);

  if (![target.dx, target.dy, target.dz, target.yaw, target.scale].every(Number.isFinite)) {
    return {
      ok: false,
      reason: 'invalid_transform',
      message: 'Move, scale, and rotation values must be finite numbers.'
    };
  }

  const maxScaleForLand = computeMaxScaleForParcel(target, vol, { wallMargin: margin });
  if (target.scale < MIN_ARTWORK_SCALE - 1e-6) {
    return {
      ok: false,
      reason: 'scale_too_small',
      maxScaleForLand,
      message: `Scale cannot be smaller than ${MIN_ARTWORK_SCALE}×.`
    };
  }

  const targetTestBox = computeItemLocalBox(target);
  const availW = Math.max(0.1, vol.widthMeters - 2 * margin);
  const availD = Math.max(0.1, vol.depthMeters - 2 * margin);
  const availH = Math.max(0.1, volH - margin);
  if (
    targetTestBox.effW > availW + EPS ||
    targetTestBox.effD > availD + EPS ||
    targetTestBox.effH > availH + EPS
  ) {
    return {
      ok: false,
      reason: 'exceeds_land_bounds',
      maxScaleForLand,
      message: `Scale ${round3(target.scale)}× exceeds the ${round3(vol.widthMeters)}×${round3(
        vol.depthMeters
      )}×${round3(volH)}m land bounds (max ${round3(maxScaleForLand)}×).`
    };
  }

  // Clamp target cleanly inside parcel bounds
  const clampedToLandBounds = clampItemInsideParcel(target, halfVolW, halfVolD, volH, margin);
  const targetBox = computeItemLocalBox(target);

  const siblings = cloned.filter((it) => it.id !== target.id);
  const origPos = new Map();
  for (const s of siblings) {
    origPos.set(s.id, {
      dx: s.dx,
      dy: s.dy,
      dz: s.dz,
      cx: s.baseX + s.dx,
      cz: s.baseZ + s.dz
    });
  }

  // Track which siblings were actually pushed/participated in collision resolution
  const touchedIds = new Set();

  // Fast path: check if target overlaps any sibling at all
  let anyTargetOverlap = false;
  for (const s of siblings) {
    const sBox = computeItemLocalBox(s);
    if (computeBoxOverlap(targetBox, sBox, gap).colliding) {
      anyTargetOverlap = true;
      break;
    }
  }

  if (anyTargetOverlap) {
    const MAX_ITERS = 64;
    for (let iter = 0; iter < MAX_ITERS; iter += 1) {
      let movedAny = false;

      // Phase A: Target pushes overlapping siblings out of its box while keeping them inside land bounds
      for (const s of siblings) {
        const sBox = computeItemLocalBox(s);
        const ov = computeBoxOverlap(targetBox, sBox, gap);
        if (!ov.colliding) continue;

        touchedIds.add(s.id);
        const orig = origPos.get(s.id);
        const best = findBestEscapeForSibling(
          s,
          targetBox,
          orig.cx,
          orig.cz,
          halfVolW,
          halfVolD,
          margin,
          gap
        );
        if (best) {
          s.dx = best.cx - s.baseX;
          s.dz = best.cz - s.baseZ;
          clampItemInsideParcel(s, halfVolW, halfVolD, volH, margin);
          movedAny = true;
        } else {
          // Fallback incremental push away from target center along whichever axis has more slack
          const awayX = sBox.cx >= targetBox.cx ? 1 : -1;
          const awayZ = sBox.cz >= targetBox.cz ? 1 : -1;
          if (ov.overlapX <= ov.overlapZ) {
            s.dx += awayX * ov.overlapX;
          } else {
            s.dz += awayZ * ov.overlapZ;
          }
          clampItemInsideParcel(s, halfVolW, halfVolD, volH, margin);
          movedAny = true;
        }
      }

      // Phase B: Resolve cascade collisions involving any touched sibling against other siblings
      for (let i = 0; i < siblings.length; i += 1) {
        for (let j = i + 1; j < siblings.length; j += 1) {
          const a = siblings[i];
          const b = siblings[j];
          if (!touchedIds.has(a.id) && !touchedIds.has(b.id)) continue;

          const boxA = computeItemLocalBox(a);
          const boxB = computeItemLocalBox(b);
          const ov = computeBoxOverlap(boxA, boxB, gap);
          if (!ov.colliding) continue;

          touchedIds.add(a.id);
          touchedIds.add(b.id);

          // Push along minimum-penetration horizontal axis, distributing displacement by free room to walls
          const pushAlongX = ov.overlapX <= ov.overlapZ;
          if (pushAlongX) {
            const sign = boxB.cx >= boxA.cx ? 1 : -1;
            const roomA =
              sign > 0
                ? Math.max(0, boxA.minX - (-halfVolW + margin))
                : Math.max(0, halfVolW - margin - boxA.maxX);
            const roomB =
              sign > 0
                ? Math.max(0, halfVolW - margin - boxB.maxX)
                : Math.max(0, boxB.minX - (-halfVolW + margin));
            const totalRoom = roomA + roomB;
            if (totalRoom > EPS) {
              const shareA = roomA / totalRoom;
              const shareB = roomB / totalRoom;
              a.dx -= sign * ov.overlapX * shareA;
              b.dx += sign * ov.overlapX * shareB;
            } else {
              // No room along X -> slide orthogonally along Z
              const signZ = boxB.cz >= boxA.cz ? 1 : -1;
              a.dz -= signZ * (ov.overlapZ * 0.5);
              b.dz += signZ * (ov.overlapZ * 0.5);
            }
          } else {
            const sign = boxB.cz >= boxA.cz ? 1 : -1;
            const roomA =
              sign > 0
                ? Math.max(0, boxA.minZ - (-halfVolD + margin))
                : Math.max(0, halfVolD - margin - boxA.maxZ);
            const roomB =
              sign > 0
                ? Math.max(0, halfVolD - margin - boxB.maxZ)
                : Math.max(0, boxB.minZ - (-halfVolD + margin));
            const totalRoom = roomA + roomB;
            if (totalRoom > EPS) {
              const shareA = roomA / totalRoom;
              const shareB = roomB / totalRoom;
              a.dz -= sign * ov.overlapZ * shareA;
              b.dz += sign * ov.overlapZ * shareB;
            } else {
              const signX = boxB.cx >= boxA.cx ? 1 : -1;
              a.dx -= signX * (ov.overlapX * 0.5);
              b.dx += signX * (ov.overlapX * 0.5);
            }
          }

          clampItemInsideParcel(a, halfVolW, halfVolD, volH, margin);
          clampItemInsideParcel(b, halfVolW, halfVolD, volH, margin);
          movedAny = true;
        }
      }

      if (!movedAny) break;
    }

    // Phase C (Pocket-search rescue for tightly packed corners):
    // If any touched sibling still overlaps target or another sibling, test clean non-overlapping pockets around target
    for (const s of siblings) {
      if (!touchedIds.has(s.id)) continue;
      const sBox = computeItemLocalBox(s);
      const stillCollides =
        computeBoxOverlap(targetBox, sBox, gap).colliding ||
        siblings.some(
          (other) =>
            other.id !== s.id && computeBoxOverlap(sBox, computeItemLocalBox(other), gap).colliding
        );
      if (!stillCollides) continue;

      const orig = origPos.get(s.id);
      const minCx = -halfVolW + margin + sBox.halfW;
      const maxCx = halfVolW - margin - sBox.halfW;
      const minCz = -halfVolD + margin + sBox.halfD;
      const maxCz = halfVolD - margin - sBox.halfD;
      if (minCx > maxCx || minCz > maxCz) continue;

      const xAnchors = [
        orig.cx,
        targetBox.maxX + gap + sBox.halfW,
        targetBox.minX - gap - sBox.halfW,
        minCx,
        maxCx
      ].filter((v) => v >= minCx - EPS && v <= maxCx + EPS);
      const zAnchors = [
        orig.cz,
        targetBox.maxZ + gap + sBox.halfD,
        targetBox.minZ - gap - sBox.halfD,
        minCz,
        maxCz
      ].filter((v) => v >= minCz - EPS && v <= maxCz + EPS);

      let rescue = null;
      let bestDist = Infinity;
      for (const cx of xAnchors) {
        for (const cz of zAnchors) {
          const candX = Math.max(minCx, Math.min(maxCx, cx));
          const candZ = Math.max(minCz, Math.min(maxCz, cz));
          const testBox = computeItemLocalBox({
            ...s,
            dx: candX - s.baseX,
            dz: candZ - s.baseZ
          });
          if (!isBoxInsideParcel(testBox, halfVolW, halfVolD, volH, margin)) continue;
          if (computeBoxOverlap(targetBox, testBox, gap).colliding) continue;
          const hitsOther = siblings.some(
            (other) =>
              other.id !== s.id &&
              computeBoxOverlap(testBox, computeItemLocalBox(other), gap).colliding
          );
          if (hitsOther) continue;
          const dist = Math.hypot(candX - orig.cx, candZ - orig.cz);
          if (dist < bestDist) {
            bestDist = dist;
            rescue = { cx: candX, cz: candZ };
          }
        }
      }
      if (rescue) {
        s.dx = rescue.cx - s.baseX;
        s.dz = rescue.cz - s.baseZ;
      }
    }
  }

  // Final Strict Verification Gate:
  // 1) Target and all touched siblings MUST lie strictly inside parcelVolume
  // 2) Zero overlaps involving target OR any touched sibling
  const collidingIds = new Set();
  if (!isBoxInsideParcel(targetBox, halfVolW, halfVolD, volH, margin)) {
    return {
      ok: false,
      reason: 'exceeds_land_bounds',
      maxScaleForLand,
      message: 'Artwork does not fit within the land bounds.'
    };
  }

  for (const s of siblings) {
    const sBox = computeItemLocalBox(s);
    if (touchedIds.has(s.id) && !isBoxInsideParcel(sBox, halfVolW, halfVolD, volH, margin)) {
      collidingIds.add(s.id);
    }
    if (computeBoxOverlap(targetBox, sBox, gap).colliding) {
      collidingIds.add(s.id);
    }
  }

  for (let i = 0; i < siblings.length; i += 1) {
    for (let j = i + 1; j < siblings.length; j += 1) {
      const a = siblings[i];
      const b = siblings[j];
      if (!touchedIds.has(a.id) && !touchedIds.has(b.id)) continue;
      if (computeBoxOverlap(computeItemLocalBox(a), computeItemLocalBox(b), gap).colliding) {
        collidingIds.add(a.id);
        collidingIds.add(b.id);
      }
    }
  }

  if (collidingIds.size > 0) {
    const names = siblings
      .filter((s) => collidingIds.has(s.id))
      .map((s) => `"${s.title}"`)
      .slice(0, 3)
      .join(', ');
    return {
      ok: false,
      reason: 'collision_out_of_bounds',
      collidingIds: [...collidingIds],
      maxScaleForLand,
      message: `Cannot fit without intersecting ${names || 'another artwork'} or pushing it outside the land bounds.`
    };
  }

  const pushedSiblings = [];
  for (const s of siblings) {
    const orig = origPos.get(s.id);
    const movedMeters = Math.hypot(s.dx - orig.dx, s.dy - orig.dy, s.dz - orig.dz);
    if (movedMeters > EPS) {
      const box = computeItemLocalBox(s);
      pushedSiblings.push({
        id: s.id,
        title: s.title,
        dx: round3(s.dx),
        dy: round3(s.dy),
        dz: round3(s.dz),
        yaw: round4(s.yaw),
        scale: round4(s.scale),
        movedMeters: round3(movedMeters),
        box
      });
    }
  }

  const allItems = [target, ...siblings].map((it) => ({
    ...it,
    dx: round3(it.dx),
    dy: round3(it.dy),
    dz: round3(it.dz),
    yaw: round4(it.yaw),
    scale: round4(it.scale),
    box: computeItemLocalBox(it),
    wasPushed: pushedSiblings.some((p) => p.id === it.id)
  }));

  return {
    ok: true,
    clampedToLandBounds,
    maxScaleForLand,
    target: {
      id: target.id,
      title: target.title,
      dx: round3(target.dx),
      dy: round3(target.dy),
      dz: round3(target.dz),
      yaw: round4(target.yaw),
      scale: round4(target.scale),
      box: computeItemLocalBox(target)
    },
    pushedSiblings,
    allItems
  };
}

/**
 * Finds the highest legal uniform scale for `targetId` at `targetTransform`'s position/rotation
 * without intersecting any other placed artwork or pushing any item out of the land bounds.
 * @param {{
 *   parcelVolume: any,
 *   targetId: string,
 *   targetTransform?: { dx?: number, dy?: number, dz?: number, yaw?: number, scale?: number },
 *   items?: any[],
 *   minGapMeters?: number,
 *   wallMargin?: number
 * }} params
 */
export function computeMaxFeasibleScale({
  parcelVolume,
  targetId,
  targetTransform = {},
  items = [],
  minGapMeters = DEFAULT_ITEM_GAP_METERS,
  wallMargin = DEFAULT_WALL_MARGIN_METERS
}) {
  const vol = resolveParcelVolumeForPlacement({ volume: parcelVolume });
  const target = (items || []).find((it) => String(it.id) === String(targetId));
  if (!target) return 1;

  const probe = {
    ...target,
    ...(targetTransform.yaw !== undefined ? { yaw: Number(targetTransform.yaw || 0) } : {})
  };
  const hiMax = computeMaxScaleForParcel(probe, vol, { wallMargin });
  if (!Number.isFinite(hiMax) || hiMax < MIN_ARTWORK_SCALE) {
    return 0;
  }

  // Quick check: does maxScaleForLand already fit cleanly?
  const topRes = resolveSculpturePlacement({
    parcelVolume: vol,
    targetId,
    targetTransform: { ...targetTransform, scale: hiMax },
    items,
    minGapMeters,
    wallMargin
  });
  if (topRes.ok) return hiMax;

  let lo = MIN_ARTWORK_SCALE;
  let hi = hiMax;
  let best = 0;

  const loRes = resolveSculpturePlacement({
    parcelVolume: vol,
    targetId,
    targetTransform: { ...targetTransform, scale: lo },
    items,
    minGapMeters,
    wallMargin
  });
  if (!loRes.ok) return 0;
  best = lo;

  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    const res = resolveSculpturePlacement({
      parcelVolume: vol,
      targetId,
      targetTransform: { ...targetTransform, scale: mid },
      items,
      minGapMeters,
      wallMargin
    });
    if (res.ok) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best < 0.1
    ? Math.max(MIN_ARTWORK_SCALE, Math.floor(best * 10000) / 10000)
    : Math.max(MIN_ARTWORK_SCALE, Math.floor(best * 100) / 100);
}

/**
 * Evaluates whether a candidate 3D model (or voxel bbox) at `modelScale` & `anchorOffset`
 * fits strictly inside `parcelVolume` without exceeding walls/ceiling or colliding with siblings.
 * Returns structured fit metrics + exact `maxSafeScale` for API/MCP errors and UI "Fit to Land" buttons.
 * @param {{
 *   parcelVolume: any,
 *   bbox: any,
 *   modelScale?: number,
 *   anchorOffset?: { dx?: number, dy?: number, dz?: number, yaw?: number, scale?: number },
 *   existingItems?: any[],
 *   minGapMeters?: number,
 *   wallMargin?: number
 * }} params
 */
export function evaluateModelFitInParcel({
  parcelVolume,
  bbox,
  modelScale = 1,
  anchorOffset = {},
  existingItems = [],
  minGapMeters = DEFAULT_ITEM_GAP_METERS,
  wallMargin = DEFAULT_WALL_MARGIN_METERS
}) {
  const vol = resolveParcelVolumeForPlacement({ volume: parcelVolume });
  const dims = normalizeBaseDimensions(bbox);
  const scale = Number.isFinite(Number(modelScale)) && Number(modelScale) > 0 ? Number(modelScale) : 1;
  const dx = Number.isFinite(Number(anchorOffset?.dx)) ? Number(anchorOffset.dx) : 0;
  const dy = Math.max(0, Number.isFinite(Number(anchorOffset?.dy)) ? Number(anchorOffset.dy) : 0);
  const dz = Number.isFinite(Number(anchorOffset?.dz)) ? Number(anchorOffset.dz) : 0;
  const yaw = Number.isFinite(Number(anchorOffset?.yaw)) ? Number(anchorOffset.yaw) : 0;

  const parcelDimensions = {
    widthMeters: round3(vol.widthMeters),
    depthMeters: round3(vol.depthMeters),
    heightMeters: round3(vol.heightMeters)
  };

  if (!dims) {
    return {
      fits: false,
      reason: 'unmeasurable_model',
      parcelDimensions,
      modelNativeDimensions: null,
      scaledDimensions: null,
      requestedScale: round4(scale),
      maxSafeScale: 0,
      suggestedScale: 0,
      message: 'Could not determine 3D model bounding box dimensions to verify land boundary fit.'
    };
  }

  const candidateId = '__candidate__';
  const candidateItem = {
    id: candidateId,
    title: 'Candidate 3D Model',
    baseX: 0,
    baseZ: 0,
    dx,
    dy,
    dz,
    yaw,
    scale,
    baseWidth: dims.width,
    baseHeight: dims.height,
    baseDepth: dims.depth
  };
  const items = [...(existingItems || []), candidateItem];

  const placement = resolveSculpturePlacement({
    parcelVolume: vol,
    targetId: candidateId,
    targetTransform: { dx, dy, dz, yaw, scale },
    items,
    minGapMeters,
    wallMargin
  });

  const maxSafeScale = computeMaxFeasibleScale({
    parcelVolume: vol,
    targetId: candidateId,
    targetTransform: { dx, dy, dz, yaw },
    items,
    minGapMeters,
    wallMargin
  });

  const scaledDimensions = {
    widthMeters: round3(dims.width * scale),
    depthMeters: round3(dims.depth * scale),
    heightMeters: round3(dims.height * scale)
  };

  if (placement.ok) {
    return {
      fits: true,
      reason: null,
      parcelDimensions,
      modelNativeDimensions: dims,
      scaledDimensions,
      requestedScale: round4(scale),
      maxSafeScale,
      suggestedScale: round4(scale),
      message: null
    };
  }

  const fitHint =
    maxSafeScale >= MIN_ARTWORK_SCALE
      ? `Set modelScale <= ${maxSafeScale}× (or re-export smaller in meters).`
      : `Model is too large for this land even at minimum scale (${MIN_ARTWORK_SCALE}×) — re-export in meters.`;

  return {
    fits: false,
    reason: placement.reason || 'exceeds_land_bounds',
    parcelDimensions,
    modelNativeDimensions: dims,
    scaledDimensions,
    requestedScale: round4(scale),
    maxSafeScale,
    suggestedScale: maxSafeScale,
    collidingIds: placement.collidingIds || [],
    message: `3D object (${scaledDimensions.widthMeters}×${scaledDimensions.depthMeters}×${scaledDimensions.heightMeters}m at ${round4(scale)}×) does not fit inside ${parcelDimensions.widthMeters}×${parcelDimensions.depthMeters}×${parcelDimensions.heightMeters}m land. ${fitHint}`
  };
}
