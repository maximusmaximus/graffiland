import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import {
  formatDimensionTriple,
  formatDistance,
  formatLandDimensionsWithUnits
} from './measurementUnits.js';

/**
 * Resolve the geographic center coordinates for a land parcel record.
 * @param {any} parcel
 * @returns {{ lat: number, lng: number } | null}
 */
export function resolveLandCoords(parcel) {
  if (!parcel || typeof parcel !== 'object') return null;

  const candidates = [
    [parcel.volume?.centerLat, parcel.volume?.centerLng],
    [parcel.centerLat, parcel.centerLng],
    [parcel.bounds?.center?.[0], parcel.bounds?.center?.[1]]
  ];

  for (const [rawLat, rawLng] of candidates) {
    if (rawLat === null || rawLat === undefined || rawLat === '') continue;
    if (rawLng === null || rawLng === undefined || rawLng === '') continue;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }

  if (Array.isArray(parcel.bounds?.sw) && Array.isArray(parcel.bounds?.ne)) {
    const swLat = Number(parcel.bounds.sw[0]);
    const swLng = Number(parcel.bounds.sw[1]);
    const neLat = Number(parcel.bounds.ne[0]);
    const neLng = Number(parcel.bounds.ne[1]);
    if (
      Number.isFinite(swLat) &&
      Number.isFinite(swLng) &&
      Number.isFinite(neLat) &&
      Number.isFinite(neLng)
    ) {
      return { lat: (swLat + neLat) / 2, lng: (swLng + neLng) / 2 };
    }
  }

  return null;
}

/**
 * Build a Google Maps directions/location URL for a land coordinate.
 * @param {number | string | null | undefined} lat
 * @param {number | string | null | undefined} lng
 * @returns {string}
 */
export function buildGoogleMapsLandUrl(lat, lng) {
  if (lat === null || lat === undefined || lat === '') return '';
  if (lng === null || lng === undefined || lng === '') return '';
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${nLat.toFixed(6)},${nLng.toFixed(6)}`
  )}`;
}

/**
 * Format a distance in meters for compact mobile pills in the target unit system.
 * @param {number | null | undefined} meters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatDistanceMeters(meters, unitSystem = 'metric') {
  return formatDistance(meters, unitSystem);
}

/**
 * Format how much time remains before a land lease expires (or permanent status).
 * @param {any} parcel
 * @param {number} [nowMs]
 * @returns {{
 *   state: 'expired' | 'expiring-soon' | 'expiring' | 'dormant' | 'permanent',
 *   urgent: boolean,
 *   badgeText: string,
 *   detailText: string,
 *   remainingMs: number | null,
 *   expiresAtText: string
 * }}
 */
export function formatLandExpiration(parcel, nowMs = Date.now()) {
  const status = String(parcel?.stewardStatus || '').toLowerCase();
  const rawLeaseExpires = parcel?.leaseExpiresAt || parcel?.lease_expires_at || '';
  const rawInactivityExpires =
    parcel?.inactivityExpiresAt || parcel?.inactivity_expires_at || '';
  const parsedLease = rawLeaseExpires ? Date.parse(String(rawLeaseExpires)) : NaN;
  const parsedInactivity = rawInactivityExpires ? Date.parse(String(rawInactivityExpires)) : NaN;

  const isLeaseBound =
    status === 'dormant' ||
    status === 'expired' ||
    (status !== 'awakened' && Number.isFinite(parsedLease));

  const formatDurationBadge = (diffMs) => {
    const totalMinutes = Math.max(1, Math.floor(diffMs / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;
    if (days >= 1) {
      return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
    }
    if (hours >= 1) {
      return mins > 0 ? `${hours}h ${mins}m left` : `${hours}h left`;
    }
    return `${mins}m left`;
  };

  if (isLeaseBound && Number.isFinite(parsedLease)) {
    const diffMs = parsedLease - nowMs;
    const expiresAtText = new Date(parsedLease).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    if (diffMs <= 0 || status === 'expired') {
      return {
        state: 'expired',
        urgent: true,
        badgeText: 'Expired',
        detailText: `72h agent window expired ${expiresAtText} — archived & open to reclaim`,
        remainingMs: 0,
        expiresAtText
      };
    }

    const badgeText = formatDurationBadge(diffMs);
    const urgent = diffMs <= 24 * 60 * 60 * 1000;
    return {
      state: urgent ? 'expiring-soon' : 'expiring',
      urgent,
      badgeText,
      detailText: `72h agent limit — expires ${expiresAtText} unless a human visits in person on Mobile AR (add art to permanently own, or check in; archived & recycled if unvisited)`,
      remainingMs: diffMs,
      expiresAtText
    };
  }

  if (status === 'dormant') {
    return {
      state: 'dormant',
      urgent: false,
      badgeText: '72h agent window',
      detailText:
        'Awaiting a verified in-person human visit on Mobile AR within 72h (archived & recycled if unvisited)',
      remainingMs: null,
      expiresAtText: ''
    };
  }

  if (Number.isFinite(parsedInactivity)) {
    const diffMs = parsedInactivity - nowMs;
    const expiresAtText = new Date(parsedInactivity).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    if (diffMs <= 0 || status === 'archived') {
      return {
        state: 'expired',
        urgent: true,
        badgeText: 'Archived',
        detailText: `28-day window elapsed ${expiresAtText} — archived & open to reclaim`,
        remainingMs: 0,
        expiresAtText
      };
    }

    const badgeText = formatDurationBadge(diffMs);
    const urgent = diffMs <= 3 * 60 * 60 * 1000 || diffMs <= 24 * 60 * 60 * 1000;
    const neverVisitedInPerson =
      parcel?.hadHumanInteraction === false || Number(parcel?.had_human_interaction) === 0;
    return {
      state: urgent ? 'expiring-soon' : 'expiring',
      urgent,
      badgeText,
      detailText: neverVisitedInPerson
        ? `Land created first — a human must visit in person on Mobile AR and add art before ${expiresAtText} to fully mint & permanently own it (archived & recycled if unvisited)`
        : `28-day activity window — add art in person on Mobile AR to permanently own (no timer), or visit on-site before ${expiresAtText} to extend`,
      remainingMs: diffMs,
      expiresAtText
    };
  }

  return {
    state: 'permanent',
    urgent: false,
    badgeText: 'Permanent',
    detailText: 'Permanently owned — minted with in-person human art (no expiry)',
    remainingMs: null,
    expiresAtText: ''
  };
}

/**
 * Format 3D parcel volume dimensions into a crisp single-line summary.
 * @param {any} parcel
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatLandDimensions(parcel, unitSystem = 'metric') {
  return formatLandDimensionsWithUnits(parcel, unitSystem);
}

/**
 * Format compact W×D×H dimensions without area for dense inline card headers.
 * @param {any} parcel
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatCompactLandSize(parcel, unitSystem = 'metric') {
  const vol = parcel?.volume;
  if (!vol) return '';
  return formatDimensionTriple(vol.widthMeters, vol.depthMeters, vol.heightMeters, unitSystem);
}

/**
 * Format a sculpture's asset format / size metadata for compact cards.
 * @param {any} sculpture
 * @returns {string}
 */
export function formatSculptureAssetMeta(sculpture) {
  if (!sculpture) return '';
  if (sculpture.modelType === 'custom-3d') {
    const fmt = String(sculpture.customModel?.format || '3D').toUpperCase();
    const tris = Number(sculpture.customModel?.triangleCount || 0);
    return tris > 0 ? `${fmt} 3D · ${tris.toLocaleString()} tris` : `${fmt} 3D Model`;
  }
  const count = Number(sculpture.voxelCount || 0);
  return `${count} block${count === 1 ? '' : 's'}`;
}

/**
 * Format a compact short date label for sculpture metadata.
 * @param {string | number | null | undefined} iso
 * @returns {string}
 */
export function formatShortDate(iso) {
  if (!iso) return '';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Group sculptures under their respective lands, compute distances from user GPS,
 * attach expiration metadata and Google Maps links, and return nearest-sorted views.
 * @param {{
 *   parcels?: any[],
 *   sculptures?: any[],
 *   location?: { lat: number, lng: number } | null,
 *   filterMode?: 'nearby' | 'all',
 *   radiusMeters?: number,
 *   nowMs?: number,
 *   unitSystem?: 'imperial' | 'metric'
 * }} options
 */
export function groupNearestLandsWithSculptures({
  parcels = [],
  sculptures = [],
  location = null,
  filterMode = 'nearby',
  radiusMeters = 5000,
  nowMs = Date.now(),
  unitSystem = 'metric'
} = {}) {
  const hasLocation =
    Boolean(location) &&
    Number.isFinite(Number(location?.lat)) &&
    Number.isFinite(Number(location?.lng));
  const userLat = hasLocation ? Number(location.lat) : 0;
  const userLng = hasLocation ? Number(location.lng) : 0;

  /** @type {Map<string, any[]>} */
  const sculpturesByParcel = new Map();
  for (const sc of sculptures || []) {
    if (!sc) continue;
    const pid = String(sc.parcelId || '').trim() || `UNASSIGNED-${sc.id || '0'}`;
    const scLat = Number(sc.lat);
    const scLng = Number(sc.lng);
    const distanceMeters =
      hasLocation && Number.isFinite(scLat) && Number.isFinite(scLng)
        ? Math.round(haversineMeters(userLat, userLng, scLat, scLng))
        : null;
    const enriched = { ...sc, distanceMeters };
    const bucket = sculpturesByParcel.get(pid);
    if (bucket) {
      bucket.push(enriched);
    } else {
      sculpturesByParcel.set(pid, [enriched]);
    }
  }

  /** @type {Map<string, any>} */
  const landMap = new Map();
  for (const p of parcels || []) {
    if (!p?.parcelId) continue;
    landMap.set(p.parcelId, p);
  }

  // Ensure any sculpture whose parcelId isn't present in `parcels` still surfaces cleanly
  for (const [pid, list] of sculpturesByParcel.entries()) {
    if (landMap.has(pid) || list.length === 0) continue;
    const first = list[0];
    landMap.set(pid, {
      parcelId: pid,
      bounds: first.parcelBounds || null,
      centerLat: Number.isFinite(Number(first.lat)) ? Number(first.lat) : null,
      centerLng: Number.isFinite(Number(first.lng)) ? Number(first.lng) : null,
      sculptureCount: list.length,
      stewardName: first.creatorName || '',
      stewardType: 'human',
      stewardStatus: 'awakened',
      latestAt: first.createdAt || ''
    });
  }

  /** @type {any[]} */
  const allLands = [];
  for (const [pid, rawParcel] of landMap.entries()) {
    const coords = resolveLandCoords(rawParcel);
    const rawList = sculpturesByParcel.get(pid) || [];

    // Sort nested sculptures: featured first, then artist works before steward stages, then newest
    const featuredId = rawParcel.featuredSculptureId || '';
    const sortedSculptures = [...rawList].sort((a, b) => {
      const aFeat = a.id && a.id === featuredId ? 1 : 0;
      const bFeat = b.id && b.id === featuredId ? 1 : 0;
      if (aFeat !== bFeat) return bFeat - aFeat;
      const aStage = a.layerRole === 'steward_stage' ? 1 : 0;
      const bStage = b.layerRole === 'steward_stage' ? 1 : 0;
      if (aStage !== bStage) return aStage - bStage;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

    const distanceMeters =
      hasLocation && coords
        ? Math.round(haversineMeters(userLat, userLng, coords.lat, coords.lng))
        : null;

    const expiration = formatLandExpiration(rawParcel, nowMs);
    const isFrozen = Boolean(rawParcel.frozen || rawParcel.settings?.frozen);
    const firstSc = sortedSculptures[0] || null;
    const displayName = resolveLandDisplayName({
      customName: rawParcel.customName || firstSc?.parcelName || '',
      displayName: rawParcel.displayName || firstSc?.landDisplayName || '',
      firstSculptureTitle: firstSc?.title || '',
      placeName: firstSc?.placeName || ''
    });
    const description = String(rawParcel.description || rawParcel.curationNote || '').trim();
    const googleMapsUrl = coords ? buildGoogleMapsLandUrl(coords.lat, coords.lng) : '';

    allLands.push({
      ...rawParcel,
      parcelId: pid,
      displayName,
      description,
      centerLat: coords ? coords.lat : null,
      centerLng: coords ? coords.lng : null,
      distanceMeters,
      distanceLabel: formatDistanceMeters(distanceMeters, unitSystem),
      googleMapsUrl,
      expiration,
      dimensionsLabel: formatLandDimensions(rawParcel, unitSystem),
      compactDimensionsLabel: formatCompactLandSize(rawParcel, unitSystem),
      isFrozen,
      sculptures: sortedSculptures,
      sculptureCount: sortedSculptures.length > 0
        ? sortedSculptures.length
        : Number(rawParcel.sculptureCount || 0)
    });
  }

  allLands.sort((a, b) => {
    if (hasLocation) {
      const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
      const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
    }
    if (b.sculptures.length !== a.sculptures.length) {
      return b.sculptures.length - a.sculptures.length;
    }
    return String(b.latestAt || '').localeCompare(String(a.latestAt || ''));
  });

  const nearbyLands = hasLocation
    ? allLands.filter((land) => land.distanceMeters !== null && land.distanceMeters <= radiusMeters)
    : allLands;

  const autoFallbackToAll =
    filterMode === 'nearby' && hasLocation && nearbyLands.length === 0 && allLands.length > 0;

  const displayedLands =
    filterMode === 'nearby' && hasLocation && !autoFallbackToAll ? nearbyLands : allLands;

  const displayedSculptures = displayedLands.flatMap((land) => land.sculptures);
  const expiringCount = displayedLands.filter(
    (land) =>
      land.expiration.state === 'expiring' ||
      land.expiration.state === 'expiring-soon' ||
      land.expiration.state === 'expired'
  ).length;

  return {
    allLands,
    nearbyLands,
    displayedLands,
    displayedSculptures,
    autoFallbackToAll,
    expiringCount
  };
}

/**
 * Extract all corner points `{ lat, lng }` describing a land parcel's real perimeter.
 * Uses oriented `volume.corners` first, then `bounds.sw`/`bounds.ne`, then a small
 * ~12 m fallback footprint around the parcel center so single-point lands still frame cleanly.
 * @param {any} parcel
 * @returns {Array<{ lat: number, lng: number }>}
 */
export function extractParcelPerimeterPoints(parcel) {
  if (!parcel || typeof parcel !== 'object') return [];

  const corners = Array.isArray(parcel.volume?.corners) ? parcel.volume.corners : [];
  if (corners.length >= 3) {
    const pts = [];
    for (const pair of corners) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lng = Number(pair[0]);
      const lat = Number(pair[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        pts.push({ lat, lng });
      }
    }
    if (pts.length >= 3) return pts;
  }

  if (Array.isArray(parcel.bounds?.sw) && Array.isArray(parcel.bounds?.ne)) {
    const swLat = Number(parcel.bounds.sw[0]);
    const swLng = Number(parcel.bounds.sw[1]);
    const neLat = Number(parcel.bounds.ne[0]);
    const neLng = Number(parcel.bounds.ne[1]);
    if (
      Number.isFinite(swLat) &&
      Number.isFinite(swLng) &&
      Number.isFinite(neLat) &&
      Number.isFinite(neLng)
    ) {
      return [
        { lat: swLat, lng: swLng },
        { lat: swLat, lng: neLng },
        { lat: neLat, lng: neLng },
        { lat: neLat, lng: swLng }
      ];
    }
  }

  const center = resolveLandCoords(parcel);
  if (!center) return [];
  const dLat = 12 / 111320;
  const cosLat = Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  const dLng = 12 / (111320 * cosLat);
  return [
    { lat: center.lat - dLat, lng: center.lng - dLng },
    { lat: center.lat - dLat, lng: center.lng + dLng },
    { lat: center.lat + dLat, lng: center.lng + dLng },
    { lat: center.lat + dLat, lng: center.lng - dLng }
  ];
}

/**
 * Format a clean, concise label for a land parcel on map views.
 * @param {any} parcel
 * @param {number | null} [rankIndex]
 * @returns {string}
 */
export function formatSimpleLandLabel(parcel, rankIndex = null) {
  let base = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
  if (base.length > 20) {
    base = `${base.slice(0, 19).trimEnd()}…`;
  }
  if (typeof rankIndex === 'number' && Number.isFinite(rankIndex) && rankIndex >= 0) {
    return `#${rankIndex + 1} ${base}`;
  }
  return base;
}

/**
 * Select the closest available lands cluster and compute the tight combined bounding box
 * across ALL of their perimeter corners so map views zoom in edge-to-edge on the lands.
 * @param {{
 *   parcels?: any[],
 *   sculptures?: any[],
 *   location?: { lat: number, lng: number } | null,
 *   maxClusterSpanMeters?: number,
 *   maxLands?: number
 * }} [options]
 */
export function computeClosestLandsPerimeterFit({
  parcels = [],
  sculptures = [],
  location = null,
  maxClusterSpanMeters = 2500,
  maxLands = 12
} = {}) {
  const hasLocation =
    Boolean(location) &&
    Number.isFinite(Number(location?.lat)) &&
    Number.isFinite(Number(location?.lng));
  const userLat = hasLocation ? Number(location.lat) : 0;
  const userLng = hasLocation ? Number(location.lng) : 0;

  /** @type {Map<string, any>} */
  const landMap = new Map();
  for (const p of parcels || []) {
    if (!p?.parcelId) continue;
    landMap.set(p.parcelId, p);
  }
  for (const sc of sculptures || []) {
    if (!sc?.parcelId || landMap.has(sc.parcelId)) continue;
    if (sc.parcelBounds || (Number.isFinite(Number(sc.lat)) && Number.isFinite(Number(sc.lng)))) {
      landMap.set(sc.parcelId, {
        parcelId: sc.parcelId,
        bounds: sc.parcelBounds || null,
        centerLat: Number.isFinite(Number(sc.lat)) ? Number(sc.lat) : null,
        centerLng: Number.isFinite(Number(sc.lng)) ? Number(sc.lng) : null
      });
    }
  }

  /** @type {Array<{ parcel: any, center: { lat: number, lng: number }, perimeter: Array<{ lat: number, lng: number }>, distanceFromUser: number | null }>} */
  const candidates = [];
  for (const parcel of landMap.values()) {
    const center = resolveLandCoords(parcel);
    const perimeter = extractParcelPerimeterPoints(parcel);
    if (!center || perimeter.length === 0) continue;
    const distanceFromUser = hasLocation
      ? haversineMeters(userLat, userLng, center.lat, center.lng)
      : null;
    candidates.push({ parcel, center, perimeter, distanceFromUser });
  }

  if (candidates.length === 0) {
    return {
      clusterLands: [],
      perimeterPoints: [],
      boundsLatLng: null,
      boundsLngLat: null,
      center: null
    };
  }

  if (hasLocation) {
    candidates.sort(
      (a, b) =>
        (a.distanceFromUser ?? Number.POSITIVE_INFINITY) -
        (b.distanceFromUser ?? Number.POSITIVE_INFINITY)
    );
  }

  const anchor = candidates[0];
  const cluster = [];
  for (const item of candidates) {
    if (cluster.length >= maxLands) break;
    const spanFromAnchor = haversineMeters(
      anchor.center.lat,
      anchor.center.lng,
      item.center.lat,
      item.center.lng
    );
    if (spanFromAnchor <= maxClusterSpanMeters) {
      cluster.push(item);
    }
  }
  if (cluster.length === 0) {
    cluster.push(anchor);
  }

  const clusterIds = new Set(cluster.map((c) => c.parcel.parcelId));
  /** @type {Array<{ lat: number, lng: number }>} */
  const perimeterPoints = [];
  for (const item of cluster) {
    for (const pt of item.perimeter) {
      perimeterPoints.push(pt);
    }
  }
  for (const sc of sculptures || []) {
    if (
      sc?.parcelId &&
      clusterIds.has(sc.parcelId) &&
      Number.isFinite(Number(sc.lat)) &&
      Number.isFinite(Number(sc.lng))
    ) {
      perimeterPoints.push({ lat: Number(sc.lat), lng: Number(sc.lng) });
    }
  }

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const pt of perimeterPoints) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lng < minLng) minLng = pt.lng;
    if (pt.lng > maxLng) maxLng = pt.lng;
  }

  return {
    clusterLands: cluster.map((c) => c.parcel),
    perimeterPoints,
    boundsLatLng: [
      [minLat, minLng],
      [maxLat, maxLng]
    ],
    boundsLngLat: [
      [minLng, minLat],
      [maxLng, maxLat]
    ],
    center: {
      lat: (minLat + maxLat) / 2,
      lng: (minLng + maxLng) / 2
    }
  };
}

/**
 * Determines whether a land parcel belongs to the currently authenticated user.
 * Checks explicit owned parcel IDs (from `/api/lands/mine`), account IDs (`ownerSub`,
 * `stewardSub`, `claimedBy`), and linked wallet addresses (case-insensitive).
 * Always returns `false` when no user is signed in.
 * @param {any} land
 * @param {{ user?: any, ownedParcelIds?: string[] }} [options]
 * @returns {boolean}
 */
export function isLandOwnedByUser(land, { user = null, ownedParcelIds = [] } = {}) {
  if (!user?.id || !land?.parcelId) return false;

  const pid = String(land.parcelId).trim().toUpperCase();
  if (
    Array.isArray(ownedParcelIds) &&
    ownedParcelIds.some((id) => String(id || '').trim().toUpperCase() === pid)
  ) {
    return true;
  }

  const uid = String(user.id).trim();
  const ownerSubs = [land.ownerSub, land.stewardSub, land.claimedBy]
    .filter(Boolean)
    .map((v) => String(v).trim());
  if (ownerSubs.includes(uid)) {
    return true;
  }

  const userWallets = new Set(
    [user.walletAddress, user.customPayoutAddress, user.activeMintRecipient]
      .filter(Boolean)
      .map((a) => String(a).trim().toLowerCase())
  );
  if (userWallets.size > 0) {
    const landWallets = [land.firstClaimantAddress, land.ownerAddress, land.stewardAddress]
      .filter(Boolean)
      .map((a) => String(a).trim().toLowerCase());
    if (landWallets.some((w) => userWallets.has(w))) {
      return true;
    }
  }

  return false;
}
