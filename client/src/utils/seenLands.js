import { haversineMeters } from '../../../shared/chatPolicy.mjs';

export const SEEN_LANDS_STORAGE_KEY = 'graffiland_seen_lands_v1';
const MAX_STORED_LANDS = 400;

function getDefaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeSeenLandKey(parcelId) {
  return String(parcelId || '').trim().toUpperCase();
}

export function loadSeenLands(storage = getDefaultStorage()) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SEEN_LANDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = normalizeSeenLandKey(k);
      if (!key || !v || typeof v !== 'object') continue;
      out[key] = {
        seenAt: String(v.seenAt || ''),
        artCount: Math.max(0, Number(v.artCount || 0) || 0)
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSeenLands(seenMap, storage = getDefaultStorage()) {
  if (!storage || !seenMap || typeof seenMap !== 'object') return;
  try {
    const entries = Object.entries(seenMap);
    const trimmed =
      entries.length > MAX_STORED_LANDS
        ? Object.fromEntries(
            entries
              .sort((a, b) => String(b[1]?.seenAt || '').localeCompare(String(a[1]?.seenAt || '')))
              .slice(0, MAX_STORED_LANDS)
          )
        : seenMap;
    storage.setItem(SEEN_LANDS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

export function markLandSeenInMap(seenMap = {}, parcelId, { artCount = null } = {}) {
  const key = normalizeSeenLandKey(parcelId);
  if (!key) return seenMap;
  const prev = seenMap?.[key];
  const resolvedCount =
    artCount === null || artCount === undefined
      ? Math.max(0, Number(prev?.artCount || 0) || 0)
      : Math.max(0, Number(artCount) || 0);
  return {
    ...(seenMap || {}),
    [key]: {
      seenAt: new Date().toISOString(),
      artCount: resolvedCount
    }
  };
}

export function markLandSeen(parcelId, opts = {}, storage = getDefaultStorage()) {
  const current = loadSeenLands(storage);
  const next = markLandSeenInMap(current, parcelId, opts);
  saveSeenLands(next, storage);
  return next;
}

export function isLandSeen(parcelId, currentArtCount = 0, seenMap = {}) {
  const key = normalizeSeenLandKey(parcelId);
  if (!key) return false;
  const entry = seenMap?.[key];
  if (!entry) return false;
  return Math.max(0, Number(currentArtCount) || 0) <= Math.max(0, Number(entry.artCount || 0) || 0);
}

/**
 * Counts unseen nearby map items (sculptures & nearby empty lands) for the Map icon badge,
 * hiding any land the user has already seen or navigated to unless new art has appeared on it.
 */
export function countUnseenMapItems({
  sculptures = [],
  parcels = [],
  location = null,
  radiusMeters = 300,
  seenMap = {}
} = {}) {
  const artByParcel = new Map();
  let unseenCount = 0;

  for (const sc of Array.isArray(sculptures) ? sculptures : []) {
    if (!sc) continue;
    const pid = normalizeSeenLandKey(sc.parcelId || sc.parcel_id);
    if (pid) {
      artByParcel.set(pid, (artByParcel.get(pid) || 0) + 1);
    } else if (sc.id) {
      const scKey = normalizeSeenLandKey(`SC:${sc.id}`);
      if (!seenMap?.[scKey]) unseenCount += 1;
    } else {
      unseenCount += 1;
    }
  }

  for (const [pid, count] of artByParcel.entries()) {
    const entry = seenMap?.[pid];
    if (!entry) {
      unseenCount += count;
    } else {
      const seenArtCount = Math.max(0, Number(entry.artCount || 0) || 0);
      if (count > seenArtCount) {
        unseenCount += count - seenArtCount;
      }
    }
  }

  const hasValidLoc =
    location &&
    Number.isFinite(Number(location.lat)) &&
    Number.isFinite(Number(location.lng));

  if (hasValidLoc && Array.isArray(parcels) && parcels.length > 0) {
    const seenParcelsInLoop = new Set(artByParcel.keys());
    for (const p of parcels) {
      if (!p) continue;
      const pid = normalizeSeenLandKey(p.parcelId || p.parcel_id);
      if (!pid || seenParcelsInLoop.has(pid)) continue;
      seenParcelsInLoop.add(pid);
      const lat = Number(p.volume?.centerLat ?? p.centerLat ?? p.lat);
      const lng = Number(p.volume?.centerLng ?? p.centerLng ?? p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const dist = haversineMeters(Number(location.lat), Number(location.lng), lat, lng);
      if (dist <= radiusMeters && !seenMap?.[pid]) {
        unseenCount += 1;
      }
    }
  }

  return unseenCount;
}
