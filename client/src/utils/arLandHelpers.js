import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { groupNearestLandsWithSculptures, isLandOwnedByUser } from './landMapHelpers.js';
import { resolveParcelVolume } from './landPreviewHelpers.js';

const METERS_PER_DEG_LAT = 111320;

function metersPerDegLngAtLat(lat) {
  return METERS_PER_DEG_LAT * Math.max(0.08, Math.cos((Number(lat) * Math.PI) / 180));
}

function projectLngLatToLocalMeters(originLat, originLng, lat, lng) {
  const mPerDegLng = metersPerDegLngAtLat(originLat);
  return {
    east: (Number(lng) - Number(originLng)) * mPerDegLng,
    north: (Number(lat) - Number(originLat)) * METERS_PER_DEG_LAT
  };
}

function distPointToSegment2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Exact 2D point-in-polygon check for whether (lat, lng) lies inside a land parcel's
 * oriented 4-corner footprint (`volume.corners` as `[lng, lat]` pairs).
 * @param {number} lat
 * @param {number} lng
 * @param {any} volume
 * @returns {boolean}
 */
export function isPointInsideParcelFootprint(lat, lng, volume) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
  const corners = Array.isArray(volume?.corners) ? volume.corners : [];
  if (corners.length < 3) return false;

  const pts = corners.slice(0, 4).map(([cLng, cLat]) =>
    projectLngLatToLocalMeters(nLat, nLng, cLat, cLng)
  );
  // Ray-casting test for origin (0, 0) inside polygon pts
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].east;
    const yi = pts[i].north;
    const xj = pts[j].east;
    const yj = pts[j].north;
    const intersects = yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Computes distance in meters from (lat, lng) to the nearest boundary edge of a parcel volume.
 * Returns `0` when the point is inside the parcel footprint.
 * @param {number} lat
 * @param {number} lng
 * @param {any} volume
 * @returns {number}
 */
export function computeParcelEdgeDistanceMeters(lat, lng, volume) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng) || !volume) {
    return Number.POSITIVE_INFINITY;
  }
  if (isPointInsideParcelFootprint(nLat, nLng, volume)) return 0;

  const corners = Array.isArray(volume.corners) ? volume.corners : [];
  if (corners.length >= 3) {
    const pts = corners.slice(0, 4).map(([cLng, cLat]) =>
      projectLngLatToLocalMeters(nLat, nLng, cLat, cLng)
    );
    let minD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = distPointToSegment2D(0, 0, a.east, a.north, b.east, b.north);
      if (d < minD) minD = d;
    }
    return Number(minD.toFixed(2));
  }

  if (Number.isFinite(Number(volume.centerLat)) && Number.isFinite(Number(volume.centerLng))) {
    return Number(haversineMeters(nLat, nLng, Number(volume.centerLat), Number(volume.centerLng)).toFixed(2));
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Enriches and ranks virtual lands visible from the user's live mobile camera view.
 * Marks whether the user is physically inside or right near each land so the AR camera
 * drawing view can render glowing 3D land prisms and instant tap-to-inspect pills.
 * @param {{
 *   parcels?: any[],
 *   sculptures?: any[],
 *   location?: { lat: number, lng: number } | null,
 *   user?: any,
 *   ownedParcelIds?: string[],
 *   maxDistanceMeters?: number,
 *   nearThresholdMeters?: number,
 *   nowMs?: number
 * }} [options]
 */
export function findNearbyCameraLands({
  parcels = [],
  sculptures = [],
  location = null,
  user = null,
  ownedParcelIds = [],
  maxDistanceMeters = 120,
  nearThresholdMeters = 45,
  nowMs = Date.now()
} = {}) {
  const hasLocation =
    Boolean(location) &&
    Number.isFinite(Number(location?.lat)) &&
    Number.isFinite(Number(location?.lng));
  if (!hasLocation) {
    return {
      visibleLands: [],
      immediateLands: [],
      primaryLand: null
    };
  }

  const uLat = Number(location.lat);
  const uLng = Number(location.lng);

  const grouped = groupNearestLandsWithSculptures({
    parcels,
    sculptures,
    location,
    filterMode: 'all',
    nowMs
  });

  const visibleLands = [];
  for (const land of grouped.allLands) {
    const volume = resolveParcelVolume(land);
    if (!volume) continue;

    const edgeDistanceMeters = computeParcelEdgeDistanceMeters(uLat, uLng, volume);
    const centerDistanceMeters = haversineMeters(uLat, uLng, volume.centerLat, volume.centerLng);
    if (edgeDistanceMeters > maxDistanceMeters && centerDistanceMeters > maxDistanceMeters) {
      continue;
    }

    const isInside = edgeDistanceMeters <= 1.5;
    const isNear = isInside || edgeDistanceMeters <= nearThresholdMeters;
    const isOwned = isLandOwnedByUser(land, { user, ownedParcelIds });

    visibleLands.push({
      ...land,
      volume,
      edgeDistanceMeters: Math.round(edgeDistanceMeters),
      centerDistanceMeters: Math.round(centerDistanceMeters),
      distanceMeters: Math.round(edgeDistanceMeters === 0 ? 0 : Math.min(edgeDistanceMeters, centerDistanceMeters)),
      isInside,
      isNear,
      isOwned
    });
  }

  visibleLands.sort((a, b) => {
    if (a.isInside !== b.isInside) return a.isInside ? -1 : 1;
    if (a.edgeDistanceMeters !== b.edgeDistanceMeters) {
      return a.edgeDistanceMeters - b.edgeDistanceMeters;
    }
    if (a.isOwned !== b.isOwned) return a.isOwned ? -1 : 1;
    return a.centerDistanceMeters - b.centerDistanceMeters;
  });

  const immediateLands = visibleLands.filter((l) => l.isNear);
  const primaryLand = immediateLands[0] || null;

  return {
    visibleLands: visibleLands.slice(0, 12),
    immediateLands,
    primaryLand
  };
}

/**
 * Converts a land parcel's 3D geographic volume into local Three.js AR camera space
 * coordinates (`x = east`, `y = up`, `z = -north`) relative to the user's current GPS position.
 * @param {{
 *   location: { lat: number, lng: number },
 *   volume: any,
 *   baseY?: number,
 *   maxClampDistM?: number,
 *   maxVisualHeightM?: number
 * }} options
 */
export function computeArLandPrismLocalGeometry({
  location,
  volume,
  baseY = -1.15,
  maxClampDistM = 55,
  maxVisualHeightM = 28
}) {
  if (!location || !volume || !Array.isArray(volume.corners) || volume.corners.length < 4) {
    return null;
  }

  const uLat = Number(location.lat);
  const uLng = Number(location.lng);
  if (!Number.isFinite(uLat) || !Number.isFinite(uLng)) return null;

  const heightMeters = Math.max(
    0.8,
    Math.min(maxVisualHeightM, Number(volume.heightMeters || 12))
  );
  const topY = Number((baseY + heightMeters).toFixed(3));

  const centerOff = projectLngLatToLocalMeters(uLat, uLng, volume.centerLat, volume.centerLng);
  const centerDist = Math.hypot(centerOff.east, centerOff.north);
  const clampRatio = centerDist > maxClampDistM ? maxClampDistM / centerDist : 1;

  const bottomCorners = volume.corners.slice(0, 4).map(([cLng, cLat]) => {
    const off = projectLngLatToLocalMeters(uLat, uLng, cLat, cLng);
    // Preserve relative parcel shape cleanly even if distant center is softly clamped
    const x =
      clampRatio < 1
        ? centerOff.east * clampRatio + (off.east - centerOff.east) * clampRatio
        : off.east;
    const z =
      clampRatio < 1
        ? -(centerOff.north * clampRatio + (off.north - centerOff.north) * clampRatio)
        : -off.north;
    return {
      x: Number(x.toFixed(3)),
      y: baseY,
      z: Number(z.toFixed(3))
    };
  });

  const topCorners = bottomCorners.map((pt) => ({
    x: pt.x,
    y: topY,
    z: pt.z
  }));

  return {
    bottomCorners,
    topCorners,
    centerLocal: {
      x: Number((centerOff.east * clampRatio).toFixed(3)),
      y: Number((baseY + heightMeters * 0.5).toFixed(3)),
      z: Number((-centerOff.north * clampRatio).toFixed(3))
    },
    widthMeters: Number(volume.widthMeters || 4),
    depthMeters: Number(volume.depthMeters || 4),
    heightMeters,
    baseY,
    topY
  };
}
