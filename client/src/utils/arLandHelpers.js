import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { ensureLandVolumeFitsSculptures } from '../../../shared/landVolume.mjs';
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
    const rawVolume = resolveParcelVolume(land);
    if (!rawVolume) continue;
    const volume =
      Array.isArray(land.sculptures) && land.sculptures.length > 0
        ? ensureLandVolumeFitsSculptures(rawVolume, land.sculptures, { paddingFraction: 0.1 }) ||
          rawVolume
        : rawVolume;

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
  maxVisualHeightM = 28,
  enclosingLocalBox = null,
  paddingFraction = 0.1
}) {
  if (!location || !volume || !Array.isArray(volume.corners) || volume.corners.length < 4) {
    return null;
  }

  const uLat = Number(location.lat);
  const uLng = Number(location.lng);
  if (!Number.isFinite(uLat) || !Number.isFinite(uLng)) return null;

  let resolvedBaseY = Number(baseY);
  let heightMeters = Math.max(
    0.8,
    Math.min(maxVisualHeightM, Number(volume.heightMeters || 12))
  );
  let topY = Number((resolvedBaseY + heightMeters).toFixed(3));

  const centerOff = projectLngLatToLocalMeters(uLat, uLng, volume.centerLat, volume.centerLng);
  const centerDist = Math.hypot(centerOff.east, centerOff.north);
  const clampRatio = centerDist > maxClampDistM ? maxClampDistM / centerDist : 1;

  let bottomCorners = volume.corners.slice(0, 4).map(([cLng, cLat]) => {
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
      y: resolvedBaseY,
      z: Number(z.toFixed(3))
    };
  });

  // Guarantee rendered artworks belonging to this land ALWAYS stay inside the AR prism
  // horizontally AND vertically with symmetric padding on all faces.
  let centerLocalX = centerOff.east * clampRatio;
  let centerLocalZ = -centerOff.north * clampRatio;
  let effWidthMeters = Number(volume.widthMeters || 4);
  let effDepthMeters = Number(volume.depthMeters || 4);

  if (
    enclosingLocalBox &&
    Number.isFinite(enclosingLocalBox.minX) &&
    Number.isFinite(enclosingLocalBox.maxX) &&
    Number.isFinite(enclosingLocalBox.minY) &&
    Number.isFinite(enclosingLocalBox.maxY) &&
    Number.isFinite(enclosingLocalBox.minZ) &&
    Number.isFinite(enclosingLocalBox.maxZ)
  ) {
    const padFrac = Math.max(0.05, Math.min(0.5, Number(paddingFraction || 0.1)));
    const boxW = Math.max(0.2, enclosingLocalBox.maxX - enclosingLocalBox.minX);
    const boxH = Math.max(0.2, enclosingLocalBox.maxY - enclosingLocalBox.minY);
    const boxD = Math.max(0.2, enclosingLocalBox.maxZ - enclosingLocalBox.minZ);
    const padX = Math.max(0.12, boxW * padFrac);
    const padY = Math.max(0.12, boxH * padFrac);
    const padZ = Math.max(0.12, boxD * padFrac);

    const artMinY = enclosingLocalBox.minY - padY;
    const artMaxY = enclosingLocalBox.maxY + padY;
    if (artMinY < resolvedBaseY || enclosingLocalBox.maxY < resolvedBaseY + 0.15) {
      resolvedBaseY = Number(artMinY.toFixed(3));
    }
    topY = Number(
      Math.max(resolvedBaseY + heightMeters, artMaxY, resolvedBaseY + 0.8).toFixed(3)
    );
    heightMeters = Math.min(maxVisualHeightM, Math.max(0.8, Number((topY - resolvedBaseY).toFixed(3))));
    topY = Number((resolvedBaseY + heightMeters).toFixed(3));

    // Check if the rendered artwork sticks out horizontally from bottomCorners
    let polyMinX = Infinity;
    let polyMaxX = -Infinity;
    let polyMinZ = Infinity;
    let polyMaxZ = -Infinity;
    for (const pt of bottomCorners) {
      if (pt.x < polyMinX) polyMinX = pt.x;
      if (pt.x > polyMaxX) polyMaxX = pt.x;
      if (pt.z < polyMinZ) polyMinZ = pt.z;
      if (pt.z > polyMaxZ) polyMaxZ = pt.z;
    }

    const reqMinX = enclosingLocalBox.minX - padX;
    const reqMaxX = enclosingLocalBox.maxX + padX;
    const reqMinZ = enclosingLocalBox.minZ - padZ;
    const reqMaxZ = enclosingLocalBox.maxZ + padZ;

    if (
      reqMinX < polyMinX - 0.05 ||
      reqMaxX > polyMaxX + 0.05 ||
      reqMinZ < polyMinZ - 0.05 ||
      reqMaxZ > polyMaxZ + 0.05
    ) {
      const nextMinX = Math.min(polyMinX, reqMinX);
      const nextMaxX = Math.max(polyMaxX, reqMaxX);
      const nextMinZ = Math.min(polyMinZ, reqMinZ);
      const nextMaxZ = Math.max(polyMaxZ, reqMaxZ);
      centerLocalX = (nextMinX + nextMaxX) / 2;
      centerLocalZ = (nextMinZ + nextMaxZ) / 2;
      effWidthMeters = Number((nextMaxX - nextMinX).toFixed(2));
      effDepthMeters = Number((nextMaxZ - nextMinZ).toFixed(2));
      bottomCorners = [
        { x: Number(nextMinX.toFixed(3)), y: resolvedBaseY, z: Number(nextMinZ.toFixed(3)) },
        { x: Number(nextMaxX.toFixed(3)), y: resolvedBaseY, z: Number(nextMinZ.toFixed(3)) },
        { x: Number(nextMaxX.toFixed(3)), y: resolvedBaseY, z: Number(nextMaxZ.toFixed(3)) },
        { x: Number(nextMinX.toFixed(3)), y: resolvedBaseY, z: Number(nextMaxZ.toFixed(3)) }
      ];
    } else {
      bottomCorners = bottomCorners.map((pt) => ({ ...pt, y: resolvedBaseY }));
    }
  }

  const topCorners = bottomCorners.map((pt) => ({
    x: pt.x,
    y: topY,
    z: pt.z
  }));

  return {
    bottomCorners,
    topCorners,
    centerLocal: {
      x: Number(centerLocalX.toFixed(3)),
      y: Number((resolvedBaseY + heightMeters * 0.5).toFixed(3)),
      z: Number(centerLocalZ.toFixed(3))
    },
    widthMeters: effWidthMeters,
    depthMeters: effDepthMeters,
    heightMeters,
    baseY: resolvedBaseY,
    topY
  };
}

/**
 * Computes safe vertical placement (`y` in local AR Three.js camera space) for a nearby
 * or land-anchored sculpture so GPS WGS84-vs-EGM96 altitude mismatches (commonly -25m to -35m
 * between Android, iOS, and terrain DEMs) NEVER bury land sculptures underground.
 *
 * - Custom 3D models (`.glb`/`.gltf`/`.obj`/`.stl`/`.ply`) have their bottom normalized to local `y = 0`,
 *   so they sit squarely on the land floor (`groundY + parcelBaseAlt + anchorOffset.dy`).
 * - Voxel sculptures preserve their sculpted eye-relative height while clamping away datum-skewed
 *   negative altitudes so they always remain visible inside their land volume.
 *
 * @param {{
 *   sculpture: any,
 *   viewerAltitude?: number | null,
 *   parentLand?: any,
 *   groundY?: number
 * }} options
 * @returns {number}
 */
export function computeArSculptureVerticalY({
  sculpture,
  viewerAltitude = null,
  parentLand = null,
  groundY = -1.15
} = {}) {
  const sc = sculpture || {};
  const isCustom3d = Boolean(sc.modelType === 'custom-3d' && sc.customModel?.format);
  const ay = Number.isFinite(Number(sc.anchorOffset?.dy)) ? Number(sc.anchorOffset.dy) : 0;
  const landBaseAlt = Math.max(0, Number(parentLand?.volume?.baseAltitudeM || 0));
  const floorY = Number(groundY) + landBaseAlt;

  // Custom 3D models are normalized with bottom at y=0, so anchor them directly on the land floor
  if (isCustom3d) {
    return Number((floorY + Math.max(0, ay)).toFixed(3));
  }

  const viewerElev =
    viewerAltitude !== null && viewerAltitude !== undefined && Number.isFinite(Number(viewerAltitude))
      ? Number(viewerAltitude)
      : null;
  const rawScElev =
    sc.elevation?.anchorAltitudeMeters ??
    (sc.altitude !== null && sc.altitude !== undefined ? sc.altitude : null);
  const scElev =
    rawScElev !== null && rawScElev !== undefined && Number.isFinite(Number(rawScElev))
      ? Number(rawScElev)
      : null;

  let deltaY = landBaseAlt;
  if (viewerElev !== null && scElev !== null) {
    const diff = scElev - viewerElev;
    // Ignore large cross-device WGS84/EGM96 geoid jumps (>12m) that would bury/launch sculptures
    if (Math.abs(diff) <= 12) {
      deltaY = Math.max(-2.5, Math.min(12, diff)) + landBaseAlt;
    }
  } else {
    const rawHeightAboveGround = sc.elevation?.heightAboveGroundMeters;
    const hag =
      rawHeightAboveGround !== null &&
      rawHeightAboveGround !== undefined &&
      Number.isFinite(Number(rawHeightAboveGround))
        ? Number(rawHeightAboveGround)
        : null;
    // Negative heightAboveGroundMeters (e.g. -30m in CA) is a WGS84 vs EGM96 datum artifact; ignore it
    if (hag !== null && hag >= 0.25 && hag <= 45) {
      deltaY = Math.max(landBaseAlt, hag);
    }
  }

  let finalY = deltaY + ay;
  // Never allow a voxel sculpture's lowest voxel to sink far below the land floor
  const minVoxelY = Number(sc.elevation?.sculptureVerticalMinM);
  if (Number.isFinite(minVoxelY) && minVoxelY + finalY < floorY - 0.35) {
    finalY = floorY - minVoxelY;
  }

  return Number(finalY.toFixed(3));
}
