import { encodeGeohash } from '../server/services/pol.mjs';
import { LAND_VOLUME_LIMITS, VOXEL_STEP } from './constants.mjs';

const METERS_PER_DEG_LAT = 111320;

export function normalizeRotationDeg(deg = 0) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return LAND_VOLUME_LIMITS.defaultRotationDeg;
  const wrapped = ((n % 360) + 360) % 360;
  return Number(wrapped.toFixed(2));
}

function metersPerDegLngAtLat(lat) {
  const cosLat = Math.max(0.08, Math.cos((Number(lat) * Math.PI) / 180));
  return METERS_PER_DEG_LAT * cosLat;
}

/**
 * Computes the 4 rotated corner coordinates [[lng, lat], ...] and closed GeoJSON ring
 * around (lat, lng) for a widthMeters x depthMeters rectangle rotated clockwise by rotationDeg.
 */
export function computeOrientedFootprintLngLat({
  lat,
  lng,
  widthMeters = LAND_VOLUME_LIMITS.defaultWidthMeters,
  depthMeters = LAND_VOLUME_LIMITS.defaultDepthMeters,
  rotationDeg = LAND_VOLUME_LIMITS.defaultRotationDeg
}) {
  const centerLat = Number(lat);
  const centerLng = Number(lng);
  const halfW = Number(widthMeters) / 2;
  const halfD = Number(depthMeters) / 2;
  const rotRad = (normalizeRotationDeg(rotationDeg) * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const mPerDegLng = metersPerDegLngAtLat(centerLat);

  // Local corners before rotation: NW, NE, SE, SW in (east, north) meters
  const localCorners = [
    [-halfW, halfD],
    [halfW, halfD],
    [halfW, -halfD],
    [-halfW, -halfD]
  ];

  const corners = localCorners.map(([x, y]) => {
    // Clockwise bearing rotation from North: east' = x*cos + y*sin, north' = -x*sin + y*cos
    const eastM = x * cosR + y * sinR;
    const northM = -x * sinR + y * cosR;
    const cLng = Number((centerLng + eastM / mPerDegLng).toFixed(7));
    const cLat = Number((centerLat + northM / METERS_PER_DEG_LAT).toFixed(7));
    return [cLng, cLat];
  });

  const ring = [...corners, corners[0]];
  return { corners, ring };
}

/**
 * Validates and normalizes 3D land volume parameters against LAND_VOLUME_LIMITS.
 */
export function validateAndNormalizeLandVolume(input = {}) {
  const errors = [];
  const centerLat = Number(input.centerLat ?? input.lat);
  const centerLng = Number(input.centerLng ?? input.lng);

  if (!Number.isFinite(centerLat) || centerLat < -85 || centerLat > 85) {
    errors.push('centerLat must be between -85 and 85.');
  }
  if (!Number.isFinite(centerLng) || centerLng < -180 || centerLng > 180) {
    errors.push('centerLng must be between -180 and 180.');
  }

  const widthMeters = Number(
    input.widthMeters !== undefined && input.widthMeters !== null && input.widthMeters !== ''
      ? input.widthMeters
      : LAND_VOLUME_LIMITS.defaultWidthMeters
  );
  const depthMeters = Number(
    input.depthMeters !== undefined && input.depthMeters !== null && input.depthMeters !== ''
      ? input.depthMeters
      : LAND_VOLUME_LIMITS.defaultDepthMeters
  );
  const rotationDeg = normalizeRotationDeg(
    input.rotationDeg !== undefined && input.rotationDeg !== null && input.rotationDeg !== ''
      ? input.rotationDeg
      : LAND_VOLUME_LIMITS.defaultRotationDeg
  );

  const hasExplicitHeight =
    input.heightMeters !== undefined && input.heightMeters !== null && input.heightMeters !== '';
  const hasExplicitZScale =
    input.zScale !== undefined && input.zScale !== null && input.zScale !== '';

  let heightMeters;
  let zScale;

  if (hasExplicitHeight) {
    heightMeters = Number(input.heightMeters);
    zScale = Number((heightMeters / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3));
  } else if (hasExplicitZScale) {
    zScale = Number(input.zScale);
    heightMeters = Number((LAND_VOLUME_LIMITS.defaultHeightMeters * zScale).toFixed(2));
  } else {
    heightMeters = LAND_VOLUME_LIMITS.defaultHeightMeters;
    zScale = LAND_VOLUME_LIMITS.defaultZScale;
  }

  const baseAltitudeM = Number.isFinite(Number(input.baseAltitudeM))
    ? Math.max(0, Math.min(2000, Number(input.baseAltitudeM)))
    : 0;

  if (
    !Number.isFinite(widthMeters) ||
    widthMeters < LAND_VOLUME_LIMITS.minWidthMeters ||
    widthMeters > LAND_VOLUME_LIMITS.maxWidthMeters
  ) {
    errors.push(
      `Width must be between ${LAND_VOLUME_LIMITS.minWidthMeters}m and ${LAND_VOLUME_LIMITS.maxWidthMeters}m.`
    );
  }
  if (
    !Number.isFinite(depthMeters) ||
    depthMeters < LAND_VOLUME_LIMITS.minDepthMeters ||
    depthMeters > LAND_VOLUME_LIMITS.maxDepthMeters
  ) {
    errors.push(
      `Depth must be between ${LAND_VOLUME_LIMITS.minDepthMeters}m and ${LAND_VOLUME_LIMITS.maxDepthMeters}m.`
    );
  }
  if (hasExplicitZScale && !hasExplicitHeight) {
    if (
      !Number.isFinite(zScale) ||
      zScale < LAND_VOLUME_LIMITS.minZScale ||
      zScale > LAND_VOLUME_LIMITS.maxZScale
    ) {
      errors.push(
        `Z-axis scale must be between ${LAND_VOLUME_LIMITS.minZScale}x and ${LAND_VOLUME_LIMITS.maxZScale}x.`
      );
    }
  }
  if (
    !Number.isFinite(heightMeters) ||
    heightMeters < LAND_VOLUME_LIMITS.minHeightMeters ||
    heightMeters > LAND_VOLUME_LIMITS.maxHeightMeters
  ) {
    errors.push(
      `Height (Z axis) must be between ${LAND_VOLUME_LIMITS.minHeightMeters}m and ${LAND_VOLUME_LIMITS.maxHeightMeters}m.`
    );
  }

  const footprintAreaSqM = Number((widthMeters * depthMeters).toFixed(2));
  const volumeCubicM = Number((footprintAreaSqM * heightMeters).toFixed(2));

  if (Number.isFinite(footprintAreaSqM) && footprintAreaSqM > LAND_VOLUME_LIMITS.maxFootprintAreaSqM) {
    errors.push(
      `Footprint area (${footprintAreaSqM.toLocaleString()} m²) exceeds maximum limit of ${LAND_VOLUME_LIMITS.maxFootprintAreaSqM.toLocaleString()} m².`
    );
  }
  if (Number.isFinite(volumeCubicM) && volumeCubicM > LAND_VOLUME_LIMITS.maxVolumeCubicM) {
    errors.push(
      `3D volume (${volumeCubicM.toLocaleString()} m³) exceeds maximum limit of ${LAND_VOLUME_LIMITS.maxVolumeCubicM.toLocaleString()} m³.`
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors, volume: null };
  }

  const roundedW = Number(widthMeters.toFixed(2));
  const roundedD = Number(depthMeters.toFixed(2));
  const roundedH = Number(heightMeters.toFixed(2));
  const roundedArea = Number((roundedW * roundedD).toFixed(2));
  const roundedVol = Number((roundedArea * roundedH).toFixed(2));
  const rawGeohash =
    typeof input.geohash === 'string' && /^[0-9a-z]{6,10}$/i.test(input.geohash.trim())
      ? input.geohash.trim().toLowerCase()
      : encodeGeohash(centerLat, centerLng, 8);
  const cleanParcelId =
    typeof input.parcelId === 'string' && /^GLAND-[0-9A-Z]{6,10}$/i.test(input.parcelId.trim())
      ? input.parcelId.trim().toUpperCase()
      : `GLAND-${rawGeohash.toUpperCase()}`;

  const { corners, ring } = computeOrientedFootprintLngLat({
    lat: centerLat,
    lng: centerLng,
    widthMeters: roundedW,
    depthMeters: roundedD,
    rotationDeg
  });

  return {
    ok: true,
    errors: [],
    volume: {
      parcelId: cleanParcelId,
      geohash: rawGeohash,
      centerLat: Number(centerLat.toFixed(6)),
      centerLng: Number(centerLng.toFixed(6)),
      widthMeters: roundedW,
      depthMeters: roundedD,
      heightMeters: roundedH,
      zScale: Number((roundedH / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3)),
      rotationDeg,
      baseAltitudeM,
      footprintAreaSqM: roundedArea,
      volumeCubicM: roundedVol,
      corners,
      ring
    }
  };
}

/**
 * Derives a default 3D prism volume for legacy parcels lacking a land_volumes row.
 */
export function buildDefaultVolumeFromBounds(bounds, parcelId = '', geohash = '') {
  if (!bounds || !Array.isArray(bounds.center)) return null;
  const centerLat = Number(bounds.center[0]);
  const centerLng = Number(bounds.center[1]);
  const latSpanM = Math.abs(Number(bounds.north) - Number(bounds.south)) * METERS_PER_DEG_LAT;
  const lngSpanM =
    Math.abs(Number(bounds.east) - Number(bounds.west)) * metersPerDegLngAtLat(centerLat);
  const widthMeters = Math.max(
    LAND_VOLUME_LIMITS.minWidthMeters,
    Math.min(LAND_VOLUME_LIMITS.maxWidthMeters, Number((lngSpanM || LAND_VOLUME_LIMITS.defaultWidthMeters).toFixed(2)))
  );
  const depthMeters = Math.max(
    LAND_VOLUME_LIMITS.minDepthMeters,
    Math.min(LAND_VOLUME_LIMITS.maxDepthMeters, Number((latSpanM || LAND_VOLUME_LIMITS.defaultDepthMeters).toFixed(2)))
  );
  const heightMeters = LAND_VOLUME_LIMITS.defaultHeightMeters;
  const { corners, ring } = computeOrientedFootprintLngLat({
    lat: centerLat,
    lng: centerLng,
    widthMeters,
    depthMeters,
    rotationDeg: 0
  });
  const footprintAreaSqM = Number((widthMeters * depthMeters).toFixed(2));
  return {
    parcelId: parcelId || `GLAND-${String(geohash || '').toUpperCase()}`,
    geohash: String(geohash || '').toLowerCase(),
    centerLat: Number(centerLat.toFixed(6)),
    centerLng: Number(centerLng.toFixed(6)),
    widthMeters,
    depthMeters,
    heightMeters,
    zScale: LAND_VOLUME_LIMITS.defaultZScale,
    rotationDeg: 0,
    baseAltitudeM: 0,
    footprintAreaSqM,
    volumeCubicM: Number((footprintAreaSqM * heightMeters).toFixed(2)),
    corners,
    ring
  };
}

/**
 * Computes the exact 3D local bounding box (in meters) of a voxel array,
 * including half-block thickness on every face.
 * @param {Array<{ x?: number, y?: number, z?: number, scale?: number }>} voxels
 */
export function computeObjectVoxelBoundsMeters(voxels = []) {
  if (!Array.isArray(voxels) || voxels.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let count = 0;

  for (const v of voxels) {
    const x = Number(v?.x);
    const y = Number(v?.y);
    const z = Number(v?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const rawScale = Number(v?.scale);
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? Math.max(0.25, Math.min(8, rawScale)) : 1;
    const half = (VOXEL_STEP * scale) / 2;
    if (x - half < minX) minX = x - half;
    if (x + half > maxX) maxX = x + half;
    if (y - half < minY) minY = y - half;
    if (y + half > maxY) maxY = y + half;
    if (z - half < minZ) minZ = z - half;
    if (z + half > maxZ) maxZ = z + half;
    count += 1;
  }

  if (count === 0) return null;

  return {
    count,
    minX: Number(minX.toFixed(4)),
    maxX: Number(maxX.toFixed(4)),
    minY: Number(minY.toFixed(4)),
    maxY: Number(maxY.toFixed(4)),
    minZ: Number(minZ.toFixed(4)),
    maxZ: Number(maxZ.toFixed(4)),
    widthMeters: Number(Math.max(VOXEL_STEP, maxX - minX).toFixed(4)),
    depthMeters: Number(Math.max(VOXEL_STEP, maxZ - minZ).toFixed(4)),
    heightMeters: Number(Math.max(VOXEL_STEP, maxY - minY).toFixed(4)),
    midX: Number(((minX + maxX) / 2).toFixed(4)),
    midY: Number(((minY + maxY) / 2).toFixed(4)),
    midZ: Number(((minZ + maxZ) / 2).toFixed(4))
  };
}

/**
 * Fits a 3D Virtual Land volume centered directly on a drawn 3D object with symmetric
 * padding (default 10% on every side => 1.20x total span) in all three dimensions (W, D, H).
 * @param {{
 *   parcelId?: string,
 *   geohash?: string,
 *   lat?: number,
 *   lng?: number,
 *   voxels?: any[],
 *   anchorOffset?: { dx?: number, dy?: number, dz?: number, yaw?: number } | null,
 *   paddingFraction?: number,
 *   minDimensionMeters?: number
 * }} [options]
 */
export function buildObjectFittedLandVolume({
  parcelId = '',
  geohash = '',
  lat = NaN,
  lng = NaN,
  voxels = [],
  anchorOffset = null,
  paddingFraction = 0.1,
  minDimensionMeters = 0.6
} = {}) {
  const baseLat = Number(lat);
  const baseLng = Number(lng);
  if (!Number.isFinite(baseLat) || !Number.isFinite(baseLng)) return null;

  const padFrac = Number.isFinite(Number(paddingFraction))
    ? Math.max(0, Math.min(1, Number(paddingFraction)))
    : 0.1;
  const padMultiplier = 1 + 2 * padFrac; // 10% padding on each side in every dimension = 1.2x

  const dx = Number(anchorOffset?.dx || 0);
  const dz = Number(anchorOffset?.dz || 0);
  const yaw = Number(anchorOffset?.yaw || 0);
  const mPerDegLng = metersPerDegLngAtLat(baseLat);

  // Center the land directly on the object anchor (never off on a geohash edge)
  const centerLat = baseLat + (-dz / METERS_PER_DEG_LAT);
  const centerLng = baseLng + (dx / mPerDegLng);

  const bounds = computeObjectVoxelBoundsMeters(voxels);
  const rawW = bounds ? bounds.widthMeters : 1.0;
  const rawD = bounds ? bounds.depthMeters : 1.0;
  const rawH = bounds ? bounds.heightMeters : 1.0;

  let widthMeters = Math.max(
    minDimensionMeters,
    Math.min(LAND_VOLUME_LIMITS.maxWidthMeters, rawW * padMultiplier)
  );
  let depthMeters = Math.max(
    minDimensionMeters,
    Math.min(LAND_VOLUME_LIMITS.maxDepthMeters, rawD * padMultiplier)
  );
  let heightMeters = Math.max(
    minDimensionMeters,
    Math.min(LAND_VOLUME_LIMITS.maxHeightMeters, rawH * padMultiplier)
  );

  if (widthMeters * depthMeters > LAND_VOLUME_LIMITS.maxFootprintAreaSqM) {
    const shrink = Math.sqrt(LAND_VOLUME_LIMITS.maxFootprintAreaSqM / (widthMeters * depthMeters));
    widthMeters *= shrink;
    depthMeters *= shrink;
  }
  if (widthMeters * depthMeters * heightMeters > LAND_VOLUME_LIMITS.maxVolumeCubicM) {
    heightMeters = LAND_VOLUME_LIMITS.maxVolumeCubicM / Math.max(0.1, widthMeters * depthMeters);
  }

  const roundedW = Number(widthMeters.toFixed(2));
  const roundedD = Number(depthMeters.toFixed(2));
  const roundedH = Number(heightMeters.toFixed(2));
  // anchorOffset.yaw is Three.js right-handed Y rotation in radians; map rotationDeg is clockwise bearing in degrees
  const rotationDeg =
    Number.isFinite(yaw) && yaw !== 0 ? normalizeRotationDeg((-yaw * 180) / Math.PI) : 0;

  const resolvedGeohash =
    typeof geohash === 'string' && /^[0-9a-z]{5,10}$/i.test(geohash.trim())
      ? geohash.trim().toLowerCase()
      : encodeGeohash(centerLat, centerLng, 8);
  const resolvedParcelId =
    typeof parcelId === 'string' && parcelId.trim()
      ? parcelId.trim().toUpperCase()
      : `GLAND-${resolvedGeohash.toUpperCase()}`;

  const { corners, ring } = computeOrientedFootprintLngLat({
    lat: centerLat,
    lng: centerLng,
    widthMeters: roundedW,
    depthMeters: roundedD,
    rotationDeg
  });

  const footprintAreaSqM = Number((roundedW * roundedD).toFixed(2));
  const volumeCubicM = Number((footprintAreaSqM * roundedH).toFixed(2));

  return {
    parcelId: resolvedParcelId,
    geohash: resolvedGeohash,
    centerLat: Number(centerLat.toFixed(6)),
    centerLng: Number(centerLng.toFixed(6)),
    widthMeters: roundedW,
    depthMeters: roundedD,
    heightMeters: roundedH,
    zScale: Number((roundedH / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3)),
    rotationDeg,
    baseAltitudeM: 0,
    footprintAreaSqM,
    volumeCubicM,
    paddingFraction: padFrac,
    fitMode: 'object-padded',
    objectDimensions: {
      widthMeters: Number(rawW.toFixed(3)),
      depthMeters: Number(rawD.toFixed(3)),
      heightMeters: Number(rawH.toFixed(3))
    },
    corners,
    ring
  };
}

/**
 * Fits a centered 10%-padded 3D land volume around one or more sculptures belonging to a parcel.
 * @param {{
 *   parcelId?: string,
 *   geohash?: string,
 *   sculptures?: any[],
 *   paddingFraction?: number,
 *   minDimensionMeters?: number
 * }} [options]
 */
export function buildMultiObjectFittedLandVolume({
  parcelId = '',
  geohash = '',
  sculptures = [],
  paddingFraction = 0.1,
  minDimensionMeters = 0.6
} = {}) {
  const valid = (sculptures || []).filter(
    (sc) => sc && Number.isFinite(Number(sc.lat)) && Number.isFinite(Number(sc.lng))
  );
  if (valid.length === 0) return null;

  if (valid.length === 1) {
    const sc = valid[0];
    let voxels = sc.voxels;
    if (!Array.isArray(voxels) && typeof sc.voxels_json === 'string') {
      try {
        voxels = JSON.parse(sc.voxels_json);
      } catch {
        voxels = [];
      }
    }
    const anchorOffset = sc.anchorOffset || {
      dx: Number(sc.anchor_dx || 0),
      dy: Number(sc.anchor_dy || 0),
      dz: Number(sc.anchor_dz || 0),
      yaw: Number(sc.anchor_yaw || 0)
    };
    return buildObjectFittedLandVolume({
      parcelId,
      geohash,
      lat: Number(sc.lat),
      lng: Number(sc.lng),
      voxels: Array.isArray(voxels) ? voxels : [],
      anchorOffset,
      paddingFraction,
      minDimensionMeters
    });
  }

  const padFrac = Number.isFinite(Number(paddingFraction))
    ? Math.max(0, Math.min(1, Number(paddingFraction)))
    : 0.1;
  const padMultiplier = 1 + 2 * padFrac;

  const refLat = valid.reduce((sum, s) => sum + Number(s.lat), 0) / valid.length;
  const refLng = valid.reduce((sum, s) => sum + Number(s.lng), 0) / valid.length;
  const mPerDegLng = metersPerDegLngAtLat(refLat);

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  let maxRawH = 1.0;

  for (const sc of valid) {
    let voxels = sc.voxels;
    if (!Array.isArray(voxels) && typeof sc.voxels_json === 'string') {
      try {
        voxels = JSON.parse(sc.voxels_json);
      } catch {
        voxels = [];
      }
    }
    const vb = computeObjectVoxelBoundsMeters(Array.isArray(voxels) ? voxels : []);
    const halfW = (vb ? vb.widthMeters : 1.0) / 2;
    const halfD = (vb ? vb.depthMeters : 1.0) / 2;
    const objH = vb ? vb.heightMeters : 1.0;
    if (objH > maxRawH) maxRawH = objH;

    const dx = Number(sc.anchorOffset?.dx ?? sc.anchor_dx ?? 0);
    const dz = Number(sc.anchorOffset?.dz ?? sc.anchor_dz ?? 0);
    const e = (Number(sc.lng) - refLng) * mPerDegLng + dx;
    const n = (Number(sc.lat) - refLat) * METERS_PER_DEG_LAT - dz;
    if (e - halfW < minE) minE = e - halfW;
    if (e + halfW > maxE) maxE = e + halfW;
    if (n - halfD < minN) minN = n - halfD;
    if (n + halfD > maxN) maxN = n + halfD;
  }

  const rawW = Math.max(minDimensionMeters / padMultiplier, maxE - minE);
  const rawD = Math.max(minDimensionMeters / padMultiplier, maxN - minN);
  const centerEast = (minE + maxE) / 2;
  const centerNorth = (minN + maxN) / 2;
  const centerLat = refLat + centerNorth / METERS_PER_DEG_LAT;
  const centerLng = refLng + centerEast / mPerDegLng;

  let widthMeters = Math.max(
    minDimensionMeters,
    Math.min(LAND_VOLUME_LIMITS.maxWidthMeters, rawW * padMultiplier)
  );
  let depthMeters = Math.max(
    minDimensionMeters,
    Math.min(LAND_VOLUME_LIMITS.maxDepthMeters, rawD * padMultiplier)
  );
  let heightMeters = Math.max(
    minDimensionMeters,
    Math.min(LAND_VOLUME_LIMITS.maxHeightMeters, maxRawH * padMultiplier)
  );

  if (widthMeters * depthMeters > LAND_VOLUME_LIMITS.maxFootprintAreaSqM) {
    const shrink = Math.sqrt(LAND_VOLUME_LIMITS.maxFootprintAreaSqM / (widthMeters * depthMeters));
    widthMeters *= shrink;
    depthMeters *= shrink;
  }
  if (widthMeters * depthMeters * heightMeters > LAND_VOLUME_LIMITS.maxVolumeCubicM) {
    heightMeters = LAND_VOLUME_LIMITS.maxVolumeCubicM / Math.max(0.1, widthMeters * depthMeters);
  }

  const roundedW = Number(widthMeters.toFixed(2));
  const roundedD = Number(depthMeters.toFixed(2));
  const roundedH = Number(heightMeters.toFixed(2));
  const resolvedGeohash =
    typeof geohash === 'string' && /^[0-9a-z]{5,10}$/i.test(geohash.trim())
      ? geohash.trim().toLowerCase()
      : encodeGeohash(centerLat, centerLng, 8);
  const resolvedParcelId =
    typeof parcelId === 'string' && parcelId.trim()
      ? parcelId.trim().toUpperCase()
      : `GLAND-${resolvedGeohash.toUpperCase()}`;

  const { corners, ring } = computeOrientedFootprintLngLat({
    lat: centerLat,
    lng: centerLng,
    widthMeters: roundedW,
    depthMeters: roundedD,
    rotationDeg: 0
  });
  const footprintAreaSqM = Number((roundedW * roundedD).toFixed(2));
  const volumeCubicM = Number((footprintAreaSqM * roundedH).toFixed(2));

  return {
    parcelId: resolvedParcelId,
    geohash: resolvedGeohash,
    centerLat: Number(centerLat.toFixed(6)),
    centerLng: Number(centerLng.toFixed(6)),
    widthMeters: roundedW,
    depthMeters: roundedD,
    heightMeters: roundedH,
    zScale: Number((roundedH / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3)),
    rotationDeg: 0,
    baseAltitudeM: 0,
    footprintAreaSqM,
    volumeCubicM,
    paddingFraction: padFrac,
    fitMode: 'object-padded',
    corners,
    ring
  };
}

function toLocalMetersCorners(vol, originLat, originLng) {
  const mPerDegLng = metersPerDegLngAtLat(originLat);
  const ring = Array.isArray(vol?.corners) && vol.corners.length >= 4
    ? vol.corners
    : computeOrientedFootprintLngLat({
        lat: vol.centerLat,
        lng: vol.centerLng,
        widthMeters: vol.widthMeters,
        depthMeters: vol.depthMeters,
        rotationDeg: vol.rotationDeg || 0
      }).corners;
  return ring.slice(0, 4).map(([cLng, cLat]) => [
    (Number(cLng) - originLng) * mPerDegLng,
    (Number(cLat) - originLat) * METERS_PER_DEG_LAT
  ]);
}

function getPolygonAxes(pts) {
  const axes = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len > 1e-6) {
      axes.push([-ey / len, ex / len]);
    }
  }
  return axes;
}

function projectPolygon(pts, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    const d = p[0] * axis[0] + p[1] * axis[1];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/**
 * 2D Separating Axis Theorem check for two oriented rectangular land footprints.
 * Uses a 0.15m edge tolerance so snapped edge-to-edge adjacent plots do not collide.
 */
export function footprintsOverlap(volA, volB, edgeToleranceMeters = 0.15) {
  if (!volA || !volB) return false;
  const originLat = Number(volA.centerLat);
  const originLng = Number(volA.centerLng);
  if (!Number.isFinite(originLat) || !Number.isFinite(originLng)) return false;

  const ptsA = toLocalMetersCorners(volA, originLat, originLng);
  const ptsB = toLocalMetersCorners(volB, originLat, originLng);
  const axes = [...getPolygonAxes(ptsA), ...getPolygonAxes(ptsB)];

  for (const axis of axes) {
    const [minA, maxA] = projectPolygon(ptsA, axis);
    const [minB, maxB] = projectPolygon(ptsB, axis);
    const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
    if (overlap <= edgeToleranceMeters) {
      return false;
    }
  }
  return true;
}

/**
 * Turns a custom land title into a clean URL-safe slug (e.g. "Civic Neon Plaza" -> "civic-neon-plaza").
 */
export function slugifyLandTitle(name = '') {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Parses a shared parcel ID or friendly slug from URL search params or /p/<slug> pathname.
 */
export function parseParcelParamFromLocation(search = '', pathname = '') {
  try {
    const params = new URLSearchParams(String(search || ''));
    const rawParcel = String(params.get('parcel') || '').trim();
    const rawSlug = String(params.get('slug') || '').trim();
    if (rawParcel) {
      return { parcelId: rawParcel.toUpperCase(), slug: rawSlug };
    }
    if (rawSlug) {
      return { parcelId: '', slug: rawSlug };
    }
    const pathMatch = String(pathname || '').match(/\/p\/([a-z0-9-]+)\/?$/i);
    if (pathMatch) {
      const token = pathMatch[1];
      if (/^GLAND-[0-9A-Z]{6,10}$/i.test(token)) {
        return { parcelId: token.toUpperCase(), slug: '' };
      }
      return { parcelId: '', slug: token.toLowerCase() };
    }
  } catch {
    // ignore malformed URL params
  }
  return { parcelId: '', slug: '' };
}

/**
 * Builds a shareable parcel link. When `compact: true` (minted parcels), produces a clean
 * slugged visit link (`?parcel=GLAND-...&slug=...`). Otherwise carries full draft 3D bounds.
 */
export function buildParcelShareUrl({
  origin = 'https://maximusmaximus.github.io',
  pathname = '/graffiland/',
  parcelId = '',
  lat = undefined,
  lng = undefined,
  volume = null,
  customName = '',
  compact = false
} = {}) {
  const baseOrigin = String(origin || 'https://maximusmaximus.github.io').replace(/\/$/, '');
  const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${baseOrigin}${cleanPath}`);
  if (parcelId) url.searchParams.set('parcel', String(parcelId).toUpperCase());
  const slug = slugifyLandTitle(customName);
  if (slug) url.searchParams.set('slug', slug);
  if (compact) {
    return url.toString();
  }
  const cLat = Number(volume?.centerLat ?? lat);
  const cLng = Number(volume?.centerLng ?? lng);
  if (Number.isFinite(cLat)) url.searchParams.set('lat', String(Number(cLat.toFixed(6))));
  if (Number.isFinite(cLng)) url.searchParams.set('lng', String(Number(cLng.toFixed(6))));
  if (volume) {
    if (Number.isFinite(Number(volume.widthMeters))) {
      url.searchParams.set('w', String(Number(volume.widthMeters)));
    }
    if (Number.isFinite(Number(volume.depthMeters))) {
      url.searchParams.set('d', String(Number(volume.depthMeters)));
    }
    if (Number.isFinite(Number(volume.heightMeters))) {
      url.searchParams.set('h', String(Number(volume.heightMeters)));
    }
    if (Number.isFinite(Number(volume.rotationDeg))) {
      url.searchParams.set('rot', String(Number(volume.rotationDeg)));
    }
  }
  if (customName) url.searchParams.set('name', String(customName).slice(0, 48));
  return url.toString();
}

/**
 * Computes a camera-oriented 3D land footprint from drag start/end GPS coordinates
 * aligned with the map camera's current bearing, anchored at the drag-start corner,
 * and smoothly scaled/capped to LAND_VOLUME_LIMITS (width, depth, and maxFootprintAreaSqM).
 */
export function computeCameraAlignedDraftBox({
  startLat,
  startLng,
  endLat,
  endLng,
  bearingDeg = 0,
  limits = LAND_VOLUME_LIMITS
}) {
  const sLat = Number(startLat);
  const sLng = Number(startLng);
  const eLat = Number(endLat);
  const eLng = Number(endLng);
  const rotationDeg = normalizeRotationDeg(bearingDeg);
  const theta = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(theta);
  const sinR = Math.sin(theta);

  const midLat = (sLat + eLat) / 2;
  const mPerDegLng = metersPerDegLngAtLat(midLat);
  const dEast = (eLng - sLng) * mPerDegLng;
  const dNorth = (eLat - sLat) * METERS_PER_DEG_LAT;

  // Inverse of computeOrientedFootprintLngLat clockwise rotation
  const localX = dEast * cosR - dNorth * sinR;
  const localY = dEast * sinR + dNorth * cosR;
  const signX = localX >= 0 ? 1 : -1;
  const signY = localY >= 0 ? 1 : -1;

  let widthMeters = Math.max(
    limits.minWidthMeters,
    Math.min(limits.maxWidthMeters, Math.abs(localX))
  );
  let depthMeters = Math.max(
    limits.minDepthMeters,
    Math.min(limits.maxDepthMeters, Math.abs(localY))
  );
  let hitLimit =
    Math.abs(localX) >= limits.maxWidthMeters || Math.abs(localY) >= limits.maxDepthMeters;

  if (widthMeters * depthMeters > limits.maxFootprintAreaSqM) {
    const scale = Math.sqrt(limits.maxFootprintAreaSqM / (widthMeters * depthMeters));
    widthMeters = Math.max(limits.minWidthMeters, Math.floor(widthMeters * scale * 10) / 10);
    depthMeters = Math.max(limits.minDepthMeters, Math.floor(depthMeters * scale * 10) / 10);
    while (
      widthMeters * depthMeters > limits.maxFootprintAreaSqM &&
      widthMeters > limits.minWidthMeters
    ) {
      widthMeters = Number((widthMeters - 0.1).toFixed(1));
    }
    hitLimit = true;
  } else {
    widthMeters = Number(widthMeters.toFixed(1));
    depthMeters = Number(depthMeters.toFixed(1));
  }

  // Keep drag start corner pinned while scaling up to the limit
  const halfLocalX = (signX * widthMeters) / 2;
  const halfLocalY = (signY * depthMeters) / 2;
  const centerEastM = halfLocalX * cosR + halfLocalY * sinR;
  const centerNorthM = -halfLocalX * sinR + halfLocalY * cosR;
  const centerLng = Number((sLng + centerEastM / mPerDegLng).toFixed(7));
  const centerLat = Number((sLat + centerNorthM / METERS_PER_DEG_LAT).toFixed(7));

  const heightMeters = limits.defaultHeightMeters;
  const footprintAreaSqM = Number((widthMeters * depthMeters).toFixed(2));
  const { corners, ring } = computeOrientedFootprintLngLat({
    lat: centerLat,
    lng: centerLng,
    widthMeters,
    depthMeters,
    rotationDeg
  });

  return {
    centerLat,
    centerLng,
    widthMeters,
    depthMeters,
    heightMeters,
    baseAltitudeM: 0,
    rotationDeg,
    footprintAreaSqM,
    hitLimit,
    corners,
    ring
  };
}

/**
 * Scales a parcel footprint proportionally (preserving aspect ratio) along [0..1]
 * between its minimum legal size and maximum legal footprint (maxWidth/maxDepth/maxFootprintAreaSqM),
 * while clamping heightMeters so 3D volume stays within maxVolumeCubicM.
 */
export function scaleFootprintToLimit({
  widthMeters = LAND_VOLUME_LIMITS.defaultWidthMeters,
  depthMeters = LAND_VOLUME_LIMITS.defaultDepthMeters,
  heightMeters = LAND_VOLUME_LIMITS.defaultHeightMeters,
  ratio = 1,
  limits = LAND_VOLUME_LIMITS
}) {
  const curW = Math.max(limits.minWidthMeters, Number(widthMeters) || limits.defaultWidthMeters);
  const curD = Math.max(limits.minDepthMeters, Number(depthMeters) || limits.defaultDepthMeters);
  const aspect = curW / curD;

  const maxWByArea = Math.sqrt(limits.maxFootprintAreaSqM * aspect);
  const maxW = Math.min(limits.maxWidthMeters, limits.maxDepthMeters * aspect, maxWByArea);
  const minW = Math.min(maxW, Math.max(limits.minWidthMeters, limits.minDepthMeters * aspect));

  const t = Math.max(0, Math.min(1, Number(ratio)));
  let nextW = Math.floor((minW + (maxW - minW) * t) * 10) / 10;
  let nextD = Math.floor((nextW / aspect) * 10) / 10;

  nextW = Math.max(limits.minWidthMeters, Math.min(limits.maxWidthMeters, nextW));
  nextD = Math.max(limits.minDepthMeters, Math.min(limits.maxDepthMeters, nextD));

  while (nextW * nextD > limits.maxFootprintAreaSqM && nextW > limits.minWidthMeters) {
    nextW = Number((nextW - 0.1).toFixed(1));
  }
  while (nextW * nextD > limits.maxFootprintAreaSqM && nextD > limits.minDepthMeters) {
    nextD = Number((nextD - 0.1).toFixed(1));
  }

  const nextArea = Number((nextW * nextD).toFixed(2));
  const curH = Math.max(
    limits.minHeightMeters,
    Math.min(limits.maxHeightMeters, Number(heightMeters) || limits.defaultHeightMeters)
  );
  const maxAllowedH = Math.min(
    limits.maxHeightMeters,
    Math.max(limits.minHeightMeters, Math.floor((limits.maxVolumeCubicM / Math.max(1, nextArea)) * 10) / 10)
  );
  const nextH = Number(Math.min(curH, maxAllowedH).toFixed(1));
  const nextZScale = Number((nextH / limits.defaultHeightMeters).toFixed(3));

  return {
    widthMeters: Number(nextW.toFixed(1)),
    depthMeters: Number(nextD.toFixed(1)),
    heightMeters: nextH,
    zScale: nextZScale,
    footprintAreaSqM: nextArea,
    volumeCubicM: Number((nextArea * nextH).toFixed(2)),
    minWidthForAspect: Number(minW.toFixed(2)),
    maxWidthForAspect: Number(maxW.toFixed(2))
  };
}

/**
 * Computes maximum legal Z height & Z-scale for a given footprint within maxHeightMeters & maxVolumeCubicM.
 */
export function computeMaxHeightForFootprint({
  widthMeters = LAND_VOLUME_LIMITS.defaultWidthMeters,
  depthMeters = LAND_VOLUME_LIMITS.defaultDepthMeters,
  limits = LAND_VOLUME_LIMITS
}) {
  const area = Math.max(1, Number(widthMeters) * Number(depthMeters));
  const maxHeightMeters = Math.min(
    limits.maxHeightMeters,
    Math.max(limits.minHeightMeters, Math.floor((limits.maxVolumeCubicM / area) * 10) / 10)
  );
  const maxZScale = Number((maxHeightMeters / limits.defaultHeightMeters).toFixed(2));
  return {
    heightMeters: Number(maxHeightMeters.toFixed(1)),
    zScale: maxZScale
  };
}

/**
 * Scales an oriented 3D draft box by dragging one of its 4 corners (0=NW, 1=NE, 2=SE, 3=SW),
 * anchoring the opposite corner, preserving rotationDeg, and capping cleanly to platform limits.
 */
export function scaleDraftFromCorner({
  draft,
  cornerIndex = 0,
  pointerLat,
  pointerLng,
  limits = LAND_VOLUME_LIMITS
}) {
  if (!draft) return null;
  const idx = ((Number(cornerIndex) % 4) + 4) % 4;
  const oppIdx = (idx + 2) % 4;
  const rotationDeg = normalizeRotationDeg(draft.rotationDeg || 0);
  const corners =
    Array.isArray(draft.corners) && draft.corners.length >= 4
      ? draft.corners
      : computeOrientedFootprintLngLat({
          lat: draft.centerLat,
          lng: draft.centerLng,
          widthMeters: draft.widthMeters,
          depthMeters: draft.depthMeters,
          rotationDeg
        }).corners;

  const [oppLng, oppLat] = corners[oppIdx];
  const theta = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(theta);
  const sinR = Math.sin(theta);
  const mPerDegLng = metersPerDegLngAtLat(oppLat);

  const dEast = (Number(pointerLng) - oppLng) * mPerDegLng;
  const dNorth = (Number(pointerLat) - oppLat) * METERS_PER_DEG_LAT;
  const localX = dEast * cosR - dNorth * sinR;
  const localY = dEast * sinR + dNorth * cosR;

  // Expected local axis sign of dragged corner relative to opposite anchor corner
  const cornerSigns = [
    [-1, 1], // 0: NW
    [1, 1],  // 1: NE
    [1, -1], // 2: SE
    [-1, -1] // 3: SW
  ];
  const [signX, signY] = cornerSigns[idx];

  let widthMeters = Math.max(
    limits.minWidthMeters,
    Math.min(limits.maxWidthMeters, localX * signX)
  );
  let depthMeters = Math.max(
    limits.minDepthMeters,
    Math.min(limits.maxDepthMeters, localY * signY)
  );

  if (widthMeters * depthMeters > limits.maxFootprintAreaSqM) {
    const scale = Math.sqrt(limits.maxFootprintAreaSqM / (widthMeters * depthMeters));
    widthMeters = Math.max(limits.minWidthMeters, Math.floor(widthMeters * scale * 10) / 10);
    depthMeters = Math.max(limits.minDepthMeters, Math.floor(depthMeters * scale * 10) / 10);
    while (
      widthMeters * depthMeters > limits.maxFootprintAreaSqM &&
      widthMeters > limits.minWidthMeters
    ) {
      widthMeters = Number((widthMeters - 0.1).toFixed(1));
    }
  } else {
    widthMeters = Number(widthMeters.toFixed(1));
    depthMeters = Number(depthMeters.toFixed(1));
  }

  const halfLocalX = (signX * widthMeters) / 2;
  const halfLocalY = (signY * depthMeters) / 2;
  const centerEastM = halfLocalX * cosR + halfLocalY * sinR;
  const centerNorthM = -halfLocalX * sinR + halfLocalY * cosR;
  const centerLng = Number((oppLng + centerEastM / mPerDegLng).toFixed(7));
  const centerLat = Number((oppLat + centerNorthM / METERS_PER_DEG_LAT).toFixed(7));

  const nextArea = Math.max(1, widthMeters * depthMeters);
  const curH = Number(draft.heightMeters || limits.defaultHeightMeters);
  const maxAllowedH = Math.min(
    limits.maxHeightMeters,
    Math.max(limits.minHeightMeters, Math.floor((limits.maxVolumeCubicM / nextArea) * 10) / 10)
  );
  const heightMeters = Number(Math.min(curH, maxAllowedH).toFixed(1));
  const zScale = Number((heightMeters / limits.defaultHeightMeters).toFixed(3));

  return {
    centerLat,
    centerLng,
    widthMeters,
    depthMeters,
    heightMeters,
    zScale,
    rotationDeg
  };
}

/**
 * Stretches or shrinks a single side segment (0=North, 1=East, 2=South, 3=West),
 * anchoring the opposite edge in place and capping to platform footprint & volume limits.
 */
export function resizeDraftFromEdge({
  draft,
  edgeIndex = 0,
  pointerLat,
  pointerLng,
  limits = LAND_VOLUME_LIMITS
}) {
  if (!draft) return null;
  const idx = ((Number(edgeIndex) % 4) + 4) % 4;
  const rotationDeg = normalizeRotationDeg(draft.rotationDeg || 0);
  const corners =
    Array.isArray(draft.corners) && draft.corners.length >= 4
      ? draft.corners
      : computeOrientedFootprintLngLat({
          lat: draft.centerLat,
          lng: draft.centerLng,
          widthMeters: draft.widthMeters,
          depthMeters: draft.depthMeters,
          rotationDeg
        }).corners;

  // Opposite edge midpoint stays fixed
  const cOppA = corners[(idx + 2) % 4];
  const cOppB = corners[(idx + 3) % 4];
  const anchorLng = (cOppA[0] + cOppB[0]) / 2;
  const anchorLat = (cOppA[1] + cOppB[1]) / 2;

  const theta = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(theta);
  const sinR = Math.sin(theta);
  const mPerDegLng = metersPerDegLngAtLat(anchorLat);

  const dEast = (Number(pointerLng) - anchorLng) * mPerDegLng;
  const dNorth = (Number(pointerLat) - anchorLat) * METERS_PER_DEG_LAT;
  const localX = dEast * cosR - dNorth * sinR;
  const localY = dEast * sinR + dNorth * cosR;

  let widthMeters = Number(draft.widthMeters || limits.defaultWidthMeters);
  let depthMeters = Number(draft.depthMeters || limits.defaultDepthMeters);
  let halfLocalX = 0;
  let halfLocalY = 0;

  if (idx === 0 || idx === 2) {
    // North (+localY) or South (-localY) edge -> modifies depthMeters only
    const signY = idx === 0 ? 1 : -1;
    const maxDepthForArea = Math.min(
      limits.maxDepthMeters,
      Math.max(
        limits.minDepthMeters,
        Math.floor((limits.maxFootprintAreaSqM / Math.max(1, widthMeters)) * 10) / 10
      )
    );
    depthMeters = Number(
      Math.max(limits.minDepthMeters, Math.min(maxDepthForArea, localY * signY)).toFixed(1)
    );
    halfLocalY = (signY * depthMeters) / 2;
  } else {
    // East (+localX) or West (-localX) edge -> modifies widthMeters only
    const signX = idx === 1 ? 1 : -1;
    const maxWidthForArea = Math.min(
      limits.maxWidthMeters,
      Math.max(
        limits.minWidthMeters,
        Math.floor((limits.maxFootprintAreaSqM / Math.max(1, depthMeters)) * 10) / 10
      )
    );
    widthMeters = Number(
      Math.max(limits.minWidthMeters, Math.min(maxWidthForArea, localX * signX)).toFixed(1)
    );
    halfLocalX = (signX * widthMeters) / 2;
  }

  const centerEastM = halfLocalX * cosR + halfLocalY * sinR;
  const centerNorthM = -halfLocalX * sinR + halfLocalY * cosR;
  const centerLng = Number((anchorLng + centerEastM / mPerDegLng).toFixed(7));
  const centerLat = Number((anchorLat + centerNorthM / METERS_PER_DEG_LAT).toFixed(7));

  const nextArea = Math.max(1, widthMeters * depthMeters);
  const curH = Number(draft.heightMeters || limits.defaultHeightMeters);
  const maxAllowedH = Math.min(
    limits.maxHeightMeters,
    Math.max(limits.minHeightMeters, Math.floor((limits.maxVolumeCubicM / nextArea) * 10) / 10)
  );
  const heightMeters = Number(Math.min(curH, maxAllowedH).toFixed(1));
  const zScale = Number((heightMeters / limits.defaultHeightMeters).toFixed(3));

  return {
    centerLat,
    centerLng,
    widthMeters,
    depthMeters,
    heightMeters,
    zScale,
    rotationDeg
  };
}
