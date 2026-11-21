import { haversineMeters } from '../../../shared/chatPolicy.mjs';

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
 * Format a distance in meters for compact mobile pills.
 * @param {number | null | undefined} meters
 * @returns {string}
 */
export function formatDistanceMeters(meters) {
  if (meters === null || meters === undefined) return '';
  const val = Number(meters);
  if (!Number.isFinite(val) || val < 0) return '';
  if (val < 1000) return `${Math.round(val)} m`;
  if (val < 10000) return `${(val / 1000).toFixed(1)} km`;
  return `${Math.round(val / 1000)} km`;
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
  const rawExpires = parcel?.leaseExpiresAt || parcel?.lease_expires_at || '';
  const hasTimestamp = Boolean(rawExpires);
  const parsedExpires = hasTimestamp ? Date.parse(String(rawExpires)) : NaN;

  const isLeaseBound =
    status === 'dormant' ||
    status === 'expired' ||
    (status !== 'awakened' && Number.isFinite(parsedExpires));

  if (isLeaseBound && Number.isFinite(parsedExpires)) {
    const diffMs = parsedExpires - nowMs;
    const expiresAtText = new Date(parsedExpires).toLocaleString(undefined, {
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
        detailText: `Lease expired ${expiresAtText} — open to reclaim`,
        remainingMs: 0,
        expiresAtText
      };
    }

    const totalMinutes = Math.max(1, Math.floor(diffMs / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    let badgeText = '';
    if (days >= 1) {
      badgeText = hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
    } else if (hours >= 1) {
      badgeText = mins > 0 ? `${hours}h ${mins}m left` : `${hours}h left`;
    } else {
      badgeText = `${mins}m left`;
    }

    const urgent = diffMs < 24 * 60 * 60 * 1000;
    return {
      state: urgent ? 'expiring-soon' : 'expiring',
      urgent,
      badgeText,
      detailText: `Expires ${expiresAtText} unless sparked by a human`,
      remainingMs: diffMs,
      expiresAtText
    };
  }

  if (status === 'dormant') {
    return {
      state: 'dormant',
      urgent: false,
      badgeText: 'Dormant lease',
      detailText: 'Awaiting first human spark to become permanent',
      remainingMs: null,
      expiresAtText: ''
    };
  }

  return {
    state: 'permanent',
    urgent: false,
    badgeText: 'Permanent',
    detailText: parcel?.awakenedAt
      ? 'Awakened — permanent land (no expiry)'
      : 'Permanent land — does not expire',
    remainingMs: null,
    expiresAtText: ''
  };
}

/**
 * Format 3D parcel volume dimensions into a crisp single-line summary.
 * @param {any} parcel
 * @returns {string}
 */
export function formatLandDimensions(parcel) {
  const vol = parcel?.volume;
  if (!vol) return '';
  const w = Number(vol.widthMeters);
  const d = Number(vol.depthMeters);
  const h = Number(vol.heightMeters);
  if (!Number.isFinite(w) || !Number.isFinite(d)) return '';
  const area = Number.isFinite(Number(vol.footprintAreaSqM))
    ? Math.round(Number(vol.footprintAreaSqM))
    : Math.round(w * d);
  const dimPart = Number.isFinite(h)
    ? `${Math.round(w)}×${Math.round(d)}×${Math.round(h)} m`
    : `${Math.round(w)}×${Math.round(d)} m`;
  return area > 0 ? `${dimPart} · ${area} m²` : dimPart;
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
 *   nowMs?: number
 * }} options
 */
export function groupNearestLandsWithSculptures({
  parcels = [],
  sculptures = [],
  location = null,
  filterMode = 'nearby',
  radiusMeters = 5000,
  nowMs = Date.now()
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
    const displayName = String(rawParcel.customName || '').trim() || pid;
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
      distanceLabel: formatDistanceMeters(distanceMeters),
      googleMapsUrl,
      expiration,
      dimensionsLabel: formatLandDimensions(rawParcel),
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
