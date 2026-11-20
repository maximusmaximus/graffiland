import { encodeGeohash } from '../server/services/pol.mjs';
import { LAND_VOLUME_LIMITS } from './constants.mjs';

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
 * Builds a shareable parcel link carrying exact 3D footprint, Z height, and rotation params.
 */
export function buildParcelShareUrl({
  origin = 'https://maximusmaximus.github.io',
  pathname = '/graffiland/',
  parcelId,
  lat,
  lng,
  volume = null,
  customName = ''
}) {
  const baseOrigin = String(origin || 'https://maximusmaximus.github.io').replace(/\/$/, '');
  const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${baseOrigin}${cleanPath}`);
  if (parcelId) url.searchParams.set('parcel', String(parcelId).toUpperCase());
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
