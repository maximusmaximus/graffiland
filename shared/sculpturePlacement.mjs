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
 * Normalizes a pitch/roll tilt angle (always stored in degrees) into [-180, 180].
 * @param {number} deg
 * @returns {number}
 */
export function tiltToDegrees(deg) {
  const val = Number(deg || 0);
  if (!Number.isFinite(val) || val === 0) return 0;
  let wrapped = ((val + 180) % 360 + 360) % 360 - 180;
  if (wrapped === -180 && val > 0) wrapped = 180;
  return Math.round(wrapped * 100) / 100;
}

/**
 * Converts a pitch/roll tilt angle (degrees) directly into radians.
 * @param {number} deg
 * @returns {number}
 */
export function tiltToRadians(deg) {
  const val = Number(deg || 0);
  if (!Number.isFinite(val) || val === 0) return 0;
  return (val * Math.PI) / 180;
}

/**
 * Reads persisted 3-axis rotation `{ yaw, pitch, roll }` (in degrees) for a sculpture.
 * @param {any} sculpture
 * @returns {{ yaw: number, pitch: number, roll: number }}
 */
export function extractSculptureRotation(sculpture) {
  const off = sculpture?.anchorOffset || {};
  const stats = sculpture?.meshStats || {};
  const rawPitch = off.pitch !== undefined && off.pitch !== null ? off.pitch : stats.transformPitch ?? 0;
  const rawRoll = off.roll !== undefined && off.roll !== null ? off.roll : stats.transformRoll ?? 0;
  return {
    yaw: yawToDegrees(off.yaw || 0),
    pitch: tiltToDegrees(rawPitch),
    roll: tiltToDegrees(rawRoll)
  };
}

/**
 * Computes exact axis-aligned 3D extents `{ effW, effH, effD }` for an oriented box
 * rotated by Euler `(pitch, yaw, roll)` in `'YXZ'` order (`R = Ry(yaw) * Rx(pitch) * Rz(roll)`).
 * Matches Three.js `Euler(pitchRad, yawRad, rollRad, 'YXZ')` identically.
 * @param {{
 *   width: number,
 *   height: number,
 *   depth: number,
 *   yaw?: number,
 *   pitch?: number,
 *   roll?: number,
 *   scale?: number
 * }} params
 * @returns {{ effW: number, effH: number, effD: number }}
 */
export function computeRotatedBoxDimensions({
  width,
  height,
  depth,
  yaw = 0,
  pitch = 0,
  roll = 0,
  scale = 1
}) {
  const s = Math.max(MIN_ARTWORK_SCALE, Number(scale || 1));
  const bw = Math.max(0.05, Number(width || 1)) * s;
  const bh = Math.max(0.05, Number(height || 1)) * s;
  const bd = Math.max(0.05, Number(depth || 1)) * s;

  const yawRad = yawToRadians(yaw || 0);
  const pitchRad = tiltToRadians(pitch || 0);
  const rollRad = tiltToRadians(roll || 0);

  if (pitchRad === 0 && rollRad === 0) {
    const absC = Math.abs(Math.cos(yawRad));
    const absS = Math.abs(Math.sin(yawRad));
    return {
      effW: bw * absC + bd * absS,
      effH: bh,
      effD: bw * absS + bd * absC
    };
  }

  const cy = Math.cos(yawRad);
  const sy = Math.sin(yawRad);
  const cx = Math.cos(pitchRad);
  const sx = Math.sin(pitchRad);
  const cz = Math.cos(rollRad);
  const sz = Math.sin(rollRad);

  const m00 = cy * cz + sy * sx * sz;
  const m01 = -cy * sz + sy * sx * cz;
  const m02 = sy * cx;
  const m10 = cx * sz;
  const m11 = cx * cz;
  const m12 = -sx;
  const m20 = -sy * cz + cy * sx * sz;
  const m21 = sy * sz + cy * sx * cz;
  const m22 = cy * cx;

  return {
    effW: Math.abs(m00) * bw + Math.abs(m01) * bh + Math.abs(m02) * bd,
    effH: Math.abs(m10) * bw + Math.abs(m11) * bh + Math.abs(m12) * bd,
    effD: Math.abs(m20) * bw + Math.abs(m21) * bh + Math.abs(m22) * bd
  };
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
  const stats = sculpture?.meshStats || {};
  const rawPitch =
    off.pitch !== undefined && off.pitch !== null ? off.pitch : stats.transformPitch ?? 0;
  const rawRoll =
    off.roll !== undefined && off.roll !== null ? off.roll : stats.transformRoll ?? 0;
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
    pitch: tiltToDegrees(rawPitch),
    roll: tiltToDegrees(rawRoll),
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
  const { effW, effH, effD } = computeRotatedBoxDimensions({
    width: item?.baseWidth || 1,
    height: item?.baseHeight || 1,
    depth: item?.baseDepth || 1,
    yaw: item?.yaw || 0,
    pitch: item?.pitch || 0,
    roll: item?.roll || 0,
    scale: item?.scale || 1
  });

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

function hasRawBoxIntersection(a, b) {
  const RAW_EPS = 1e-4;
  const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return ox > RAW_EPS && oz > RAW_EPS && oy > RAW_EPS;
}

function findBestEscapeForSibling(
  sib,
  primaryObstacleBox,
  allObstacleBoxes,
  origCx,
  origCz,
  halfVolW,
  halfVolD,
  wallMargin,
  gap
) {
  const sibBox = computeItemLocalBox(sib);
  const minCx = -halfVolW + wallMargin + sibBox.halfW;
  const maxCx = halfVolW - wallMargin - sibBox.halfW;
  const minCz = -halfVolD + wallMargin + sibBox.halfD;
  const maxCz = halfVolD - wallMargin - sibBox.halfD;
  if (minCx > maxCx + 1e-5 || minCz > maxCz + 1e-5) return null;

  const pushPlusX = primaryObstacleBox.maxX + gap + sibBox.halfW;
  const pushMinusX = primaryObstacleBox.minX - gap - sibBox.halfW;
  const pushPlusZ = primaryObstacleBox.maxZ + gap + sibBox.halfD;
  const pushMinusZ = primaryObstacleBox.minZ - gap - sibBox.halfD;

  // Candidate positions: 4 cardinal slides + 4 corner slides around primary obstacle,
  // plus secondary slides around other obstacle edges when a cardinal slide is blocked.
  const candidates = [
    { cx: pushPlusX, cz: sibBox.cz },
    { cx: pushMinusX, cz: sibBox.cz },
    { cx: sibBox.cx, cz: pushPlusZ },
    { cx: sibBox.cx, cz: pushMinusZ },
    { cx: pushPlusX, cz: pushPlusZ },
    { cx: pushPlusX, cz: pushMinusZ },
    { cx: pushMinusX, cz: pushPlusZ },
    { cx: pushMinusX, cz: pushMinusZ },
    { cx: pushPlusX, cz: origCz },
    { cx: pushMinusX, cz: origCz },
    { cx: origCx, cz: pushPlusZ },
    { cx: origCx, cz: pushMinusZ }
  ];

  const obstacles = Array.isArray(allObstacleBoxes) ? allObstacleBoxes : [primaryObstacleBox];
  for (const ob of obstacles) {
    if (!ob || ob === primaryObstacleBox) continue;
    const obPlusX = ob.maxX + gap + sibBox.halfW;
    const obMinusX = ob.minX - gap - sibBox.halfW;
    const obPlusZ = ob.maxZ + gap + sibBox.halfD;
    const obMinusZ = ob.minZ - gap - sibBox.halfD;
    candidates.push(
      { cx: pushPlusX, cz: obPlusZ },
      { cx: pushPlusX, cz: obMinusZ },
      { cx: pushMinusX, cz: obPlusZ },
      { cx: pushMinusX, cz: obMinusZ },
      { cx: obPlusX, cz: pushPlusZ },
      { cx: obMinusX, cz: pushPlusZ },
      { cx: obPlusX, cz: pushMinusZ },
      { cx: obMinusX, cz: pushMinusZ },
      { cx: obPlusX, cz: sibBox.cz },
      { cx: obMinusX, cz: sibBox.cz },
      { cx: sibBox.cx, cz: obPlusZ },
      { cx: sibBox.cx, cz: obMinusZ }
    );
  }

  // Prefer pushing away from primary obstacle center when distances are nearly equal
  const awayX = sibBox.cx - primaryObstacleBox.cx;
  const awayZ = sibBox.cz - primaryObstacleBox.cz;

  let best = null;
  let bestScore = Infinity;

  for (const cand of candidates) {
    if (cand.cx < minCx - 1e-5 || cand.cx > maxCx + 1e-5) continue;
    if (cand.cz < minCz - 1e-5 || cand.cz > maxCz + 1e-5) continue;

    const clampedCx = Math.max(minCx, Math.min(maxCx, cand.cx));
    const clampedCz = Math.max(minCz, Math.min(maxCz, cand.cz));
    const testBox = {
      ...sibBox,
      cx: clampedCx,
      cz: clampedCz,
      minX: clampedCx - sibBox.halfW,
      maxX: clampedCx + sibBox.halfW,
      minZ: clampedCz - sibBox.halfD,
      maxZ: clampedCz + sibBox.halfD
    };

    // Never accept a candidate that still overlaps the primary obstacle
    if (computeBoxOverlap(primaryObstacleBox, testBox, gap).colliding) continue;

    let overlapCount = 0;
    let overlapPenalty = 0;
    for (const ob of obstacles) {
      if (!ob || ob === primaryObstacleBox) continue;
      const ov = computeBoxOverlap(ob, testBox, gap);
      if (ov.colliding) {
        overlapCount += 1;
        overlapPenalty += Math.min(ov.overlapX, ov.overlapZ);
      }
    }

    const moveDist = Math.hypot(clampedCx - sibBox.cx, clampedCz - sibBox.cz);
    const driftDist = Math.hypot(clampedCx - origCx, clampedCz - origCz);
    const dotAway = (clampedCx - sibBox.cx) * awayX + (clampedCz - sibBox.cz) * awayZ;
    const awayBonus = dotAway > 0 ? -0.05 : 0;
    // Strongly prefer candidates that clear ALL siblings without causing a cascade
    const score = overlapCount * 1000 + overlapPenalty * 40 + moveDist * 1.0 + driftDist * 0.2 + awayBonus;

    if (score < bestScore) {
      bestScore = score;
      best = { cx: clampedCx, cz: clampedCz, clearOfAll: overlapCount === 0 };
    }
  }

  return best;
}

function findClosestClearPocketForItem(
  item,
  origCx,
  origCz,
  obstacleBoxes,
  halfVolW,
  halfVolD,
  volH,
  wallMargin,
  gap
) {
  const sBox = computeItemLocalBox(item);
  const minCx = -halfVolW + wallMargin + sBox.halfW;
  const maxCx = halfVolW - wallMargin - sBox.halfW;
  const minCz = -halfVolD + wallMargin + sBox.halfD;
  const maxCz = halfVolD - wallMargin - sBox.halfD;
  if (minCx > maxCx + 1e-5 || minCz > maxCz + 1e-5) return null;

  const rawXAnchors = [origCx, minCx, maxCx, 0];
  const rawZAnchors = [origCz, minCz, maxCz, 0];

  for (const ob of obstacleBoxes) {
    if (!ob) continue;
    rawXAnchors.push(ob.maxX + gap + sBox.halfW, ob.minX - gap - sBox.halfW, ob.cx);
    rawZAnchors.push(ob.maxZ + gap + sBox.halfD, ob.minZ - gap - sBox.halfD, ob.cz);
  }

  const dedup = (arr, lo, hi) => {
    const out = [];
    for (const v of arr) {
      if (!Number.isFinite(v) || v < lo - EPS || v > hi + EPS) continue;
      const clamped = Math.max(lo, Math.min(hi, v));
      if (!out.some((u) => Math.abs(u - clamped) < 1e-4)) {
        out.push(clamped);
      }
    }
    return out;
  };

  const xAnchors = dedup(rawXAnchors, minCx, maxCx);
  const zAnchors = dedup(rawZAnchors, minCz, maxCz);

  const testPoint = (candX, candZ) => {
    const testBox = computeItemLocalBox({
      ...item,
      dx: candX - item.baseX,
      dz: candZ - item.baseZ
    });
    if (!isBoxInsideParcel(testBox, halfVolW, halfVolD, volH, wallMargin)) return false;
    for (const ob of obstacleBoxes) {
      if (!ob) continue;
      if (computeBoxOverlap(ob, testBox, gap).colliding || hasRawBoxIntersection(ob, testBox)) {
        return false;
      }
    }
    return true;
  };

  let rescue = null;
  let bestDist = Infinity;

  for (const cx of xAnchors) {
    for (const cz of zAnchors) {
      if (!testPoint(cx, cz)) continue;
      const dist = Math.hypot(cx - origCx, cz - origCz);
      if (dist < bestDist) {
        bestDist = dist;
        rescue = { cx, cz };
      }
    }
  }
  if (rescue) return rescue;

  // Fallback parcel sweep grid when anchor intersections miss an open interior pocket
  const GRID_STEPS = 14;
  for (let ix = 0; ix <= GRID_STEPS; ix += 1) {
    const cx = minCx + ((maxCx - minCx) * ix) / GRID_STEPS;
    for (let iz = 0; iz <= GRID_STEPS; iz += 1) {
      const cz = minCz + ((maxCz - minCz) * iz) / GRID_STEPS;
      if (!testPoint(cx, cz)) continue;
      const dist = Math.hypot(cx - origCx, cz - origCz);
      if (dist < bestDist) {
        bestDist = dist;
        rescue = { cx, cz };
      }
    }
  }

  return rescue;
}

/**
 * Deterministic 3D placement, scaling & non-intersecting collision-push solver for artworks on a Virtual Land.
 * @param {{
 *   parcelVolume: any,
 *   targetId: string,
 *   targetTransform?: { dx?: number, dy?: number, dz?: number, yaw?: number, pitch?: number, roll?: number, scale?: number },
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
  const solveGap = gap + 0.002;
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
    pitch: tiltToDegrees(it.pitch || 0),
    roll: tiltToDegrees(it.roll || 0),
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
      pitch: 0,
      roll: 0,
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
  if (targetTransform.pitch !== undefined) target.pitch = Number(targetTransform.pitch || 0);
  if (targetTransform.roll !== undefined) target.roll = Number(targetTransform.roll || 0);
  if (targetTransform.scale !== undefined) target.scale = Number(targetTransform.scale || 1);

  if (
    ![target.dx, target.dy, target.dz, target.yaw, target.pitch, target.roll, target.scale].every(
      Number.isFinite
    )
  ) {
    return {
      ok: false,
      reason: 'invalid_transform',
      message: 'Move, scale, and rotation values must be finite numbers.'
    };
  }
  target.pitch = tiltToDegrees(target.pitch);
  target.roll = tiltToDegrees(target.roll);

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
      message: `Scale ${round3(target.scale)}× (${round3(targetTestBox.effW)}×${round3(
        targetTestBox.effH
      )}×${round3(targetTestBox.effD)}m) exceeds the ${round3(vol.widthMeters)}×${round3(
        vol.depthMeters
      )}×${round3(volH)}m land bounds (max ${round3(maxScaleForLand)}×).`
    };
  }

  // Clamp target cleanly inside parcel bounds and round to persisted precision before collision solving
  const clampedToLandBounds = clampItemInsideParcel(target, halfVolW, halfVolD, volH, margin);
  target.dx = round3(target.dx);
  target.dy = round3(Math.max(0, target.dy));
  target.dz = round3(target.dz);
  if (!isBoxInsideParcel(computeItemLocalBox(target), halfVolW, halfVolD, volH, margin)) {
    clampItemInsideParcel(target, halfVolW, halfVolD, volH, margin);
  }
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
    if (
      computeBoxOverlap(targetBox, sBox, solveGap).colliding ||
      hasRawBoxIntersection(targetBox, sBox)
    ) {
      anyTargetOverlap = true;
      break;
    }
  }

  if (anyTargetOverlap) {
    const MAX_ITERS = 96;
    for (let iter = 0; iter < MAX_ITERS; iter += 1) {
      let movedAny = false;

      // Phase A: Target pushes overlapping siblings out of its box while avoiding other siblings
      for (const s of siblings) {
        const sBox = computeItemLocalBox(s);
        const ov = computeBoxOverlap(targetBox, sBox, solveGap);
        if (!ov.colliding && !hasRawBoxIntersection(targetBox, sBox)) continue;

        touchedIds.add(s.id);
        const orig = origPos.get(s.id);
        const allObstacles = [
          targetBox,
          ...siblings.filter((other) => other.id !== s.id).map((other) => computeItemLocalBox(other))
        ];
        const best = findBestEscapeForSibling(
          s,
          targetBox,
          allObstacles,
          orig.cx,
          orig.cz,
          halfVolW,
          halfVolD,
          margin,
          solveGap
        );
        if (best) {
          s.dx = best.cx - s.baseX;
          s.dz = best.cz - s.baseZ;
          clampItemInsideParcel(s, halfVolW, halfVolD, volH, margin);
          movedAny = true;
        } else {
          const awayX = sBox.cx >= targetBox.cx ? 1 : -1;
          const awayZ = sBox.cz >= targetBox.cz ? 1 : -1;
          if (ov.overlapX <= ov.overlapZ) {
            s.dx += awayX * Math.max(ov.overlapX, 0.02);
          } else {
            s.dz += awayZ * Math.max(ov.overlapZ, 0.02);
          }
          clampItemInsideParcel(s, halfVolW, halfVolD, volH, margin);
          movedAny = true;
        }
      }

      // Phase B: Resolve cascade collisions involving any touched sibling against ALL other siblings
      for (let i = 0; i < siblings.length; i += 1) {
        for (let j = i + 1; j < siblings.length; j += 1) {
          const a = siblings[i];
          const b = siblings[j];
          if (!touchedIds.has(a.id) && !touchedIds.has(b.id)) continue;

          const boxA = computeItemLocalBox(a);
          const boxB = computeItemLocalBox(b);
          const ov = computeBoxOverlap(boxA, boxB, solveGap);
          if (!ov.colliding && !hasRawBoxIntersection(boxA, boxB)) continue;

          touchedIds.add(a.id);
          touchedIds.add(b.id);

          const prevADx = a.dx;
          const prevADz = a.dz;
          const prevBDx = b.dx;
          const prevBDz = b.dz;

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

          // If proportional push got stuck against walls or shoved either sibling back into target,
          // use obstacle-aware escape on the sibling that has clearer escape options
          const nextBoxA = computeItemLocalBox(a);
          const nextBoxB = computeItemLocalBox(b);
          const stillHits =
            computeBoxOverlap(nextBoxA, nextBoxB, solveGap).colliding ||
            hasRawBoxIntersection(nextBoxA, nextBoxB) ||
            computeBoxOverlap(targetBox, nextBoxA, solveGap).colliding ||
            computeBoxOverlap(targetBox, nextBoxB, solveGap).colliding;

          if (stillHits) {
            const origB = origPos.get(b.id);
            const obstaclesForB = [
              targetBox,
              nextBoxA,
              ...siblings
                .filter((other) => other.id !== a.id && other.id !== b.id)
                .map((other) => computeItemLocalBox(other))
            ];
            const escB = findBestEscapeForSibling(
              b,
              nextBoxA,
              obstaclesForB,
              origB.cx,
              origB.cz,
              halfVolW,
              halfVolD,
              margin,
              solveGap
            );
            if (escB && escB.clearOfAll) {
              b.dx = escB.cx - b.baseX;
              b.dz = escB.cz - b.baseZ;
              clampItemInsideParcel(b, halfVolW, halfVolD, volH, margin);
            } else {
              const origA = origPos.get(a.id);
              const obstaclesForA = [
                targetBox,
                nextBoxB,
                ...siblings
                  .filter((other) => other.id !== a.id && other.id !== b.id)
                  .map((other) => computeItemLocalBox(other))
              ];
              const escA = findBestEscapeForSibling(
                a,
                nextBoxB,
                obstaclesForA,
                origA.cx,
                origA.cz,
                halfVolW,
                halfVolD,
                margin,
                solveGap
              );
              if (escA && escA.clearOfAll) {
                a.dx = escA.cx - a.baseX;
                a.dz = escA.cz - a.baseZ;
                clampItemInsideParcel(a, halfVolW, halfVolD, volH, margin);
              }
            }
          }

          if (
            Math.abs(a.dx - prevADx) > 1e-5 ||
            Math.abs(a.dz - prevADz) > 1e-5 ||
            Math.abs(b.dx - prevBDx) > 1e-5 ||
            Math.abs(b.dz - prevBDz) > 1e-5
          ) {
            movedAny = true;
          }
        }
      }

      if (!movedAny) break;
    }

    // Phase C (Multi-pass Pocket-Search Rescue across target + all sibling edges + parcel sweep):
    const hasTouchedCollisions = () => {
      for (const s of siblings) {
        const sBox = computeItemLocalBox(s);
        if (
          computeBoxOverlap(targetBox, sBox, solveGap).colliding ||
          hasRawBoxIntersection(targetBox, sBox)
        ) {
          touchedIds.add(s.id);
          return true;
        }
      }
      for (let i = 0; i < siblings.length; i += 1) {
        for (let j = i + 1; j < siblings.length; j += 1) {
          const a = siblings[i];
          const b = siblings[j];
          if (!touchedIds.has(a.id) && !touchedIds.has(b.id)) continue;
          const bA = computeItemLocalBox(a);
          const bB = computeItemLocalBox(b);
          if (computeBoxOverlap(bA, bB, solveGap).colliding || hasRawBoxIntersection(bA, bB)) {
            touchedIds.add(a.id);
            touchedIds.add(b.id);
            return true;
          }
        }
      }
      return false;
    };

    for (let rescuePass = 0; rescuePass < 3; rescuePass += 1) {
      if (!hasTouchedCollisions()) break;
      let rescuedAny = false;
      for (const s of siblings) {
        if (!touchedIds.has(s.id)) continue;
        const sBox = computeItemLocalBox(s);
        const stillCollides =
          computeBoxOverlap(targetBox, sBox, solveGap).colliding ||
          hasRawBoxIntersection(targetBox, sBox) ||
          siblings.some((other) => {
            if (other.id === s.id) return false;
            const oBox = computeItemLocalBox(other);
            return computeBoxOverlap(sBox, oBox, solveGap).colliding || hasRawBoxIntersection(sBox, oBox);
          });
        if (!stillCollides) continue;

        const orig = origPos.get(s.id);
        const obstacleBoxes = [
          targetBox,
          ...siblings.filter((other) => other.id !== s.id).map((other) => computeItemLocalBox(other))
        ];
        const rescue = findClosestClearPocketForItem(
          s,
          orig.cx,
          orig.cz,
          obstacleBoxes,
          halfVolW,
          halfVolD,
          volH,
          margin,
          solveGap
        );
        if (rescue) {
          s.dx = rescue.cx - s.baseX;
          s.dz = rescue.cz - s.baseZ;
          rescuedAny = true;
        }
      }
      if (!rescuedAny) break;
    }

    // Phase D (Joint Multi-Sibling Repack Fallback for deadlocked 2+ sibling clusters):
    if (hasTouchedCollisions() && touchedIds.size >= 1) {
      const snapshot = siblings.map((s) => ({ id: s.id, dx: s.dx, dy: s.dy, dz: s.dz }));
      const fixedSiblings = siblings.filter((s) => !touchedIds.has(s.id));
      const movableSiblings = siblings
        .filter((s) => touchedIds.has(s.id))
        .sort((a, b) => {
          const boxA = computeItemLocalBox(a);
          const boxB = computeItemLocalBox(b);
          const areaDiff = boxB.effW * boxB.effD - boxA.effW * boxA.effD;
          if (Math.abs(areaDiff) > 1e-4) return areaDiff;
          return a.id.localeCompare(b.id);
        });

      const placedBoxes = [targetBox, ...fixedSiblings.map((s) => computeItemLocalBox(s))];
      let repackOk = true;

      for (const s of movableSiblings) {
        const orig = origPos.get(s.id);
        const pocket = findClosestClearPocketForItem(
          s,
          orig.cx,
          orig.cz,
          placedBoxes,
          halfVolW,
          halfVolD,
          volH,
          margin,
          solveGap
        );
        if (!pocket) {
          repackOk = false;
          break;
        }
        s.dx = pocket.cx - s.baseX;
        s.dz = pocket.cz - s.baseZ;
        placedBoxes.push(computeItemLocalBox(s));
      }

      if (!repackOk) {
        const snapMap = new Map(snapshot.map((st) => [st.id, st]));
        for (const s of siblings) {
          const prev = snapMap.get(s.id);
          if (prev) {
            s.dx = prev.dx;
            s.dy = prev.dy;
            s.dz = prev.dz;
          }
        }
      }
    }
  }

  // Round all persisted coordinates BEFORE final strict zero-intersection verification
  for (const s of siblings) {
    if (touchedIds.has(s.id)) {
      s.dx = round3(s.dx);
      s.dy = round3(Math.max(0, s.dy));
      s.dz = round3(s.dz);
    }
  }

  const finalTargetBox = computeItemLocalBox(target);

  // Final Strict Verification Gate (evaluated on exact rounded output coordinates):
  // 1) Target and all touched siblings MUST lie strictly inside parcelVolume
  // 2) ZERO overlaps or raw bounding-box intersections involving target OR any touched sibling
  const collidingIds = new Set();
  if (!isBoxInsideParcel(finalTargetBox, halfVolW, halfVolD, volH, margin)) {
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
    if (
      computeBoxOverlap(finalTargetBox, sBox, gap).colliding ||
      hasRawBoxIntersection(finalTargetBox, sBox)
    ) {
      collidingIds.add(s.id);
    }
  }

  for (let i = 0; i < siblings.length; i += 1) {
    for (let j = i + 1; j < siblings.length; j += 1) {
      const a = siblings[i];
      const b = siblings[j];
      if (!touchedIds.has(a.id) && !touchedIds.has(b.id)) continue;
      const boxA = computeItemLocalBox(a);
      const boxB = computeItemLocalBox(b);
      if (computeBoxOverlap(boxA, boxB, gap).colliding || hasRawBoxIntersection(boxA, boxB)) {
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
        pitch: tiltToDegrees(s.pitch),
        roll: tiltToDegrees(s.roll),
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
    pitch: tiltToDegrees(it.pitch),
    roll: tiltToDegrees(it.roll),
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
      pitch: tiltToDegrees(target.pitch),
      roll: tiltToDegrees(target.roll),
      scale: round4(target.scale),
      box: finalTargetBox
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
 *   targetTransform?: { dx?: number, dy?: number, dz?: number, yaw?: number, pitch?: number, roll?: number, scale?: number },
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
    ...(targetTransform.yaw !== undefined ? { yaw: Number(targetTransform.yaw || 0) } : {}),
    ...(targetTransform.pitch !== undefined ? { pitch: tiltToDegrees(targetTransform.pitch || 0) } : {}),
    ...(targetTransform.roll !== undefined ? { roll: tiltToDegrees(targetTransform.roll || 0) } : {})
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
 *   anchorOffset?: { dx?: number, dy?: number, dz?: number, yaw?: number, pitch?: number, roll?: number, scale?: number },
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
  const pitch = tiltToDegrees(anchorOffset?.pitch || 0);
  const roll = tiltToDegrees(anchorOffset?.roll || 0);

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
    pitch,
    roll,
    scale,
    baseWidth: dims.width,
    baseHeight: dims.height,
    baseDepth: dims.depth
  };
  const items = [...(existingItems || []), candidateItem];

  const placement = resolveSculpturePlacement({
    parcelVolume: vol,
    targetId: candidateId,
    targetTransform: { dx, dy, dz, yaw, pitch, roll, scale },
    items,
    minGapMeters,
    wallMargin
  });

  const maxSafeScale = computeMaxFeasibleScale({
    parcelVolume: vol,
    targetId: candidateId,
    targetTransform: { dx, dy, dz, yaw, pitch, roll },
    items,
    minGapMeters,
    wallMargin
  });

  const rotScaled = computeRotatedBoxDimensions({
    width: dims.width,
    height: dims.height,
    depth: dims.depth,
    yaw,
    pitch,
    roll,
    scale
  });
  const scaledDimensions = {
    widthMeters: round3(rotScaled.effW),
    depthMeters: round3(rotScaled.effD),
    heightMeters: round3(rotScaled.effH)
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
