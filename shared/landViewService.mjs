import { decodeGeohashBounds } from '../server/services/pol.mjs';
import { haversineMeters } from './chatPolicy.mjs';
import { McpServiceError, normalizeParcelId } from './mcp/helpers.mjs';

export const LAND_VIEW_DEDUP_WINDOW_MS = 15 * 60 * 1000;
export const MAX_IN_PERSON_VIEW_DISTANCE_M = 95;

let _tablesCheckedDbs = new WeakSet();

/**
 * Ensures `land_view_stats` and `land_view_events` tables exist (idempotent).
 * Safe on both Node SQLite and Cloudflare D1.
 */
export async function ensureLandViewTables(db) {
  if (!db || _tablesCheckedDbs.has(db)) return;
  try {
    await db.run(
      `CREATE TABLE IF NOT EXISTS land_view_stats (
        parcel_id TEXT PRIMARY KEY,
        page_views INTEGER NOT NULL DEFAULT 0,
        in_person_views INTEGER NOT NULL DEFAULT 0,
        last_page_view_at TEXT NOT NULL DEFAULT '',
        last_in_person_view_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`
    );
    await db.run(
      `CREATE TABLE IF NOT EXISTS land_view_events (
        parcel_id TEXT NOT NULL,
        viewer_key TEXT NOT NULL,
        view_type TEXT NOT NULL,
        last_counted_at TEXT NOT NULL,
        PRIMARY KEY (parcel_id, viewer_key, view_type)
      )`
    );
    _tablesCheckedDbs.add(db);
  } catch {
    // Fallback gracefully if DB is read-only or migration pending
  }
}

/**
 * Loads all parcel view counts in a single lightweight query.
 * @returns {Promise<Map<string, { pageViews: number, inPersonViews: number }>>}
 */
export async function getLandViewCountsMap(db) {
  const map = new Map();
  if (!db) return map;
  try {
    const rows = await db.all(
      'SELECT parcel_id, page_views, in_person_views FROM land_view_stats'
    );
    for (const r of rows || []) {
      if (!r?.parcel_id) continue;
      map.set(String(r.parcel_id).toUpperCase(), {
        pageViews: Math.max(0, Number(r.page_views || 0)),
        inPersonViews: Math.max(0, Number(r.in_person_views || 0))
      });
    }
  } catch {
    // Table may not exist yet on an unmigrated DB — gracefully return zeros
  }
  return map;
}

/**
 * Reads view counts for a single parcel.
 */
export async function getLandViewCounts(db, parcelId) {
  const cleanId = normalizeParcelId(parcelId);
  if (!db || !cleanId) return { pageViews: 0, inPersonViews: 0 };
  try {
    const row = await db.get(
      'SELECT page_views, in_person_views FROM land_view_stats WHERE parcel_id = ?',
      [cleanId]
    );
    return {
      pageViews: Math.max(0, Number(row?.page_views || 0)),
      inPersonViews: Math.max(0, Number(row?.in_person_views || 0))
    };
  } catch {
    return { pageViews: 0, inPersonViews: 0 };
  }
}

async function resolveParcelAnchorForView(db, parcelId) {
  const cleanId = normalizeParcelId(parcelId);
  const [lp, vr, sc] = await Promise.all([
    db.get('SELECT parcel_id, geohash, center_lat, center_lng FROM land_parcels WHERE parcel_id = ?', [cleanId]).catch(() => null),
    db.get('SELECT parcel_id, geohash, center_lat, center_lng, width_meters, depth_meters FROM land_volumes WHERE parcel_id = ?', [cleanId]).catch(() => null),
    db.get('SELECT parcel_id, geohash, lat, lng FROM sculptures WHERE parcel_id = ? AND hidden = 0 LIMIT 1', [cleanId]).catch(() => null)
  ]);

  if (!lp && !vr && !sc) return null;

  const geohash = vr?.geohash || lp?.geohash || sc?.geohash || cleanId.replace(/^GLAND-/, '').toLowerCase();
  const bounds = geohash ? decodeGeohashBounds(geohash) : null;
  const centerLat = Number(vr?.center_lat ?? lp?.center_lat ?? sc?.lat ?? bounds?.center?.[0]);
  const centerLng = Number(vr?.center_lng ?? lp?.center_lng ?? sc?.lng ?? bounds?.center?.[1]);
  const widthM = Number(vr?.width_meters || 14);
  const depthM = Number(vr?.depth_meters || 14);
  const maxDistM = Math.max(
    MAX_IN_PERSON_VIEW_DISTANCE_M,
    Math.hypot(widthM / 2, depthM / 2) + 40
  );

  return {
    parcelId: cleanId,
    centerLat: Number.isFinite(centerLat) ? centerLat : null,
    centerLng: Number.isFinite(centerLng) ? centerLng : null,
    maxDistM
  };
}

/**
 * Computes a short, privacy-preserving viewer deduplication key from user ID or request fingerprint.
 */
export function buildViewerDedupKey({ userId = '', sessionId = '', ip = '', userAgent = '' } = {}) {
  const cleanUser = String(userId || '').trim();
  if (cleanUser) return `u:${cleanUser.slice(0, 96)}`;
  const cleanSess = String(sessionId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanSess.length >= 8) return `s:${cleanSess.slice(0, 64)}`;
  const raw = `${String(ip || 'anon').slice(0, 64)}|${String(userAgent || '').slice(0, 120)}`;
  // Lightweight deterministic FNV-1a 64-ish hex fingerprint (works identically on Node & Cloudflare Workers)
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `g:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Records a deduplicated Land Page view (`page`) or physical in-person AR/on-site view (`in_person`).
 */
export async function recordLandView(
  db,
  {
    parcelId = '',
    viewType = 'page',
    viewerKey = '',
    lat = null,
    lng = null,
    verifiedInPerson = false,
    dedupWindowMs = LAND_VIEW_DEDUP_WINDOW_MS,
    nowMs = Date.now()
  } = {}
) {
  const cleanId = normalizeParcelId(parcelId);
  if (!cleanId) {
    throw new McpServiceError('Parcel ID is required.', 400);
  }
  const cleanType = viewType === 'in_person' ? 'in_person' : 'page';

  await ensureLandViewTables(db);
  const anchor = await resolveParcelAnchorForView(db, cleanId);
  if (!anchor) {
    throw new McpServiceError(`Virtual Land "${cleanId}" not found.`, 404);
  }

  if (cleanType === 'in_person' && !verifiedInPerson) {
    const nLat = Number(lat);
    const nLng = Number(lng);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) {
      throw new McpServiceError(
        'In-person view requires live GPS coordinates near the land.',
        400
      );
    }
    if (anchor.centerLat !== null && anchor.centerLng !== null) {
      const distM = haversineMeters(nLat, nLng, anchor.centerLat, anchor.centerLng);
      if (distM > anchor.maxDistM) {
        throw new McpServiceError(
          `In-person view requires standing within ${Math.round(anchor.maxDistM)}m of this land.`,
          400
        );
      }
    }
  }

  const safeViewerKey = String(viewerKey || 'anon').slice(0, 120);
  const nowIso = new Date(nowMs).toISOString();

  // Deduplicate repeat hits from the same viewer within the dedup window
  const existingEv = await db
    .get(
      'SELECT last_counted_at FROM land_view_events WHERE parcel_id = ? AND viewer_key = ? AND view_type = ?',
      [cleanId, safeViewerKey, cleanType]
    )
    .catch(() => null);

  if (existingEv?.last_counted_at && dedupWindowMs > 0) {
    const prevMs = Date.parse(existingEv.last_counted_at);
    if (Number.isFinite(prevMs) && nowMs - prevMs < dedupWindowMs) {
      const counts = await getLandViewCounts(db, cleanId);
      return {
        ok: true,
        parcelId: cleanId,
        viewType: cleanType,
        counted: false,
        pageViews: counts.pageViews,
        inPersonViews: counts.inPersonViews
      };
    }
  }

  await db.run(
    `INSERT INTO land_view_events (parcel_id, viewer_key, view_type, last_counted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(parcel_id, viewer_key, view_type)
     DO UPDATE SET last_counted_at = excluded.last_counted_at`,
    [cleanId, safeViewerKey, cleanType, nowIso]
  );

  if (cleanType === 'in_person') {
    await db.run(
      `INSERT INTO land_view_stats (
         parcel_id, page_views, in_person_views, last_page_view_at, last_in_person_view_at, updated_at
       ) VALUES (?, 0, 1, '', ?, ?)
       ON CONFLICT(parcel_id) DO UPDATE SET
         in_person_views = land_view_stats.in_person_views + 1,
         last_in_person_view_at = excluded.last_in_person_view_at,
         updated_at = excluded.updated_at`,
      [cleanId, nowIso, nowIso]
    );
  } else {
    await db.run(
      `INSERT INTO land_view_stats (
         parcel_id, page_views, in_person_views, last_page_view_at, last_in_person_view_at, updated_at
       ) VALUES (?, 1, 0, ?, '', ?)
       ON CONFLICT(parcel_id) DO UPDATE SET
         page_views = land_view_stats.page_views + 1,
         last_page_view_at = excluded.last_page_view_at,
         updated_at = excluded.updated_at`,
      [cleanId, nowIso, nowIso]
    );
  }

  const counts = await getLandViewCounts(db, cleanId);
  return {
    ok: true,
    parcelId: cleanId,
    viewType: cleanType,
    counted: true,
    pageViews: counts.pageViews,
    inPersonViews: counts.inPersonViews
  };
}
