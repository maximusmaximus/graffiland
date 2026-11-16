import { sanitizeVoxels } from '../server/services/moderation.mjs';
import { encodeGeohash } from '../server/services/pol.mjs';

const MAX_DRAFTS_PER_USER = 30;
const VALID_SOURCES = new Set(['auto', 'manual', 'agent', 'pair']);

export class DraftServiceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw || typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sanitizeSurfaceAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const x = Number(anchor.x);
  const y = Number(anchor.y);
  const z = Number(anchor.z);
  const nx = Number(anchor.nx);
  const ny = Number(anchor.ny);
  const nz = Number(anchor.nz);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(nx) ||
    !Number.isFinite(ny) ||
    !Number.isFinite(nz)
  ) {
    return null;
  }
  const depthM = Number(anchor.depthM);
  const sharpnessScore = Number(anchor.sharpnessScore);
  return {
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
    z: Math.round(z * 1000) / 1000,
    nx: Math.round(nx * 1000) / 1000,
    ny: Math.round(ny * 1000) / 1000,
    nz: Math.round(nz * 1000) / 1000,
    depthM: Number.isFinite(depthM) ? Math.round(depthM * 100) / 100 : 1.8,
    label: String(anchor.label || 'Surface').slice(0, 40),
    source: String(anchor.source || 'surface').slice(0, 24),
    sharpnessScore: Number.isFinite(sharpnessScore) ? Math.round(sharpnessScore * 100) / 100 : 0.35,
    locked: Boolean(anchor.locked)
  };
}

export function serializeDraftRow(row, { includeVoxels = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    ownerSub: row.owner_sub,
    title: row.title || '',
    description: row.description || '',
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    altitude: row.altitude ?? null,
    parcelId: row.parcel_id || '',
    geohash: row.geohash || '',
    voxelCount: Number(row.voxel_count || 0),
    ...(includeVoxels ? { voxels: parseJsonSafe(row.voxels_json, []) || [] } : {}),
    surfaceAnchor: parseJsonSafe(row.surface_anchor_json, null),
    previewDataUrl: row.preview_data_url || '',
    source: row.source || 'manual',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listUserDrafts(db, { user }) {
  if (!user?.id) throw new DraftServiceError('Google sign-in required', 401);
  const rows = await db.all(
    'SELECT * FROM sculpture_drafts WHERE owner_sub = ? ORDER BY updated_at DESC LIMIT ?',
    [user.id, MAX_DRAFTS_PER_USER]
  );
  return {
    drafts: (rows || []).map((r) => serializeDraftRow(r, { includeVoxels: true }))
  };
}

export async function getUserDraft(db, { draftId, user }) {
  if (!user?.id) throw new DraftServiceError('Google sign-in required', 401);
  const cleanId = String(draftId || '').trim();
  if (!cleanId) throw new DraftServiceError('Draft ID required', 400);
  const row = await db.get('SELECT * FROM sculpture_drafts WHERE id = ?', [cleanId]);
  if (!row) throw new DraftServiceError('Draft not found', 404);
  if (row.owner_sub !== user.id) throw new DraftServiceError('Draft belongs to another account', 403);
  return { draft: serializeDraftRow(row, { includeVoxels: true }) };
}

export async function saveUserDraft(db, { user, body }) {
  if (!user?.id) throw new DraftServiceError('Google sign-in required', 401);

  const rawVoxels = Array.isArray(body?.voxels) ? body.voxels : [];
  const title = String(body?.title || '').trim().slice(0, 64);
  const description = String(body?.description || '').trim().slice(0, 300);

  if (rawVoxels.length === 0 && !title && !description) {
    throw new DraftServiceError('Add blocks, a title, or a description before saving a draft.', 400);
  }

  let cleanVoxels = [];
  if (rawVoxels.length > 0) {
    const res = sanitizeVoxels(rawVoxels);
    if (res.errors.length > 0) {
      throw new DraftServiceError(res.errors[0], 400);
    }
    cleanVoxels = res.cleanVoxels;
  }

  const loc = body?.location || {};
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);
  const alt = Number(loc?.altitude);
  const hasCoords =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180;
  const geohash = hasCoords ? encodeGeohash(lat, lng, 8) : '';
  const parcelId = geohash ? `GH-${geohash.toUpperCase()}` : '';

  const anchor = sanitizeSurfaceAnchor(body?.surfaceAnchor);
  const surfaceAnchorJson = anchor ? JSON.stringify(anchor) : '';
  const previewDataUrl =
    typeof body?.previewDataUrl === 'string' && body.previewDataUrl.startsWith('data:image/')
      ? body.previewDataUrl.slice(0, 450000)
      : '';
  const source = VALID_SOURCES.has(body?.source) ? body.source : 'manual';
  const now = new Date().toISOString();
  const requestedId = String(body?.id || '').trim();

  if (requestedId) {
    const existing = await db.get('SELECT * FROM sculpture_drafts WHERE id = ?', [requestedId]);
    if (existing) {
      if (existing.owner_sub !== user.id) {
        throw new DraftServiceError('Draft belongs to another account', 403);
      }
      await db.run(
        `UPDATE sculpture_drafts
         SET title = ?, description = ?, lat = ?, lng = ?, altitude = ?, parcel_id = ?, geohash = ?,
             voxels_json = ?, voxel_count = ?, surface_anchor_json = ?,
             preview_data_url = CASE WHEN ? != '' THEN ? ELSE preview_data_url END,
             source = ?, updated_at = ?
         WHERE id = ? AND owner_sub = ?`,
        [
          title,
          description,
          hasCoords ? lat : existing.lat,
          hasCoords ? lng : existing.lng,
          Number.isFinite(alt) ? alt : existing.altitude,
          parcelId || existing.parcel_id || '',
          geohash || existing.geohash || '',
          JSON.stringify(cleanVoxels),
          cleanVoxels.length,
          surfaceAnchorJson,
          previewDataUrl,
          previewDataUrl,
          source,
          now,
          requestedId,
          user.id
        ]
      );
      const updated = await db.get('SELECT * FROM sculpture_drafts WHERE id = ?', [requestedId]);
      return { draft: serializeDraftRow(updated, { includeVoxels: true }), updated: true };
    }
  }

  const countRow = await db.get(
    'SELECT COUNT(*) AS c FROM sculpture_drafts WHERE owner_sub = ?',
    [user.id]
  );
  if (Number(countRow?.c || 0) >= MAX_DRAFTS_PER_USER) {
    const oldestAuto = await db.get(
      "SELECT id FROM sculpture_drafts WHERE owner_sub = ? AND source = 'auto' ORDER BY updated_at ASC LIMIT 1",
      [user.id]
    );
    if (oldestAuto?.id) {
      await db.run('DELETE FROM sculpture_drafts WHERE id = ? AND owner_sub = ?', [
        oldestAuto.id,
        user.id
      ]);
    } else {
      throw new DraftServiceError(
        `Maximum ${MAX_DRAFTS_PER_USER} saved drafts reached; delete an older draft first.`,
        400
      );
    }
  }

  const draftId = `draft_${globalThis.crypto.randomUUID()}`;
  await db.run(
    `INSERT INTO sculpture_drafts (
      id, owner_sub, title, description, lat, lng, altitude, parcel_id, geohash,
      voxels_json, voxel_count, surface_anchor_json, preview_data_url, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      draftId,
      user.id,
      title,
      description,
      hasCoords ? lat : null,
      hasCoords ? lng : null,
      Number.isFinite(alt) ? alt : null,
      parcelId,
      geohash,
      JSON.stringify(cleanVoxels),
      cleanVoxels.length,
      surfaceAnchorJson,
      previewDataUrl,
      source,
      now,
      now
    ]
  );

  const created = await db.get('SELECT * FROM sculpture_drafts WHERE id = ?', [draftId]);
  return { draft: serializeDraftRow(created, { includeVoxels: true }), updated: false };
}

export async function deleteUserDraft(db, { draftId, user }) {
  if (!user?.id) throw new DraftServiceError('Google sign-in required', 401);
  const cleanId = String(draftId || '').trim();
  if (!cleanId) throw new DraftServiceError('Draft ID required', 400);
  const row = await db.get('SELECT owner_sub FROM sculpture_drafts WHERE id = ?', [cleanId]);
  if (!row) throw new DraftServiceError('Draft not found', 404);
  if (row.owner_sub !== user.id) throw new DraftServiceError('Draft belongs to another account', 403);
  await db.run('DELETE FROM sculpture_drafts WHERE id = ? AND owner_sub = ?', [cleanId, user.id]);
  return { ok: true, id: cleanId };
}

export async function consumeDraftOnPublish(db, { draftId, user }) {
  const cleanId = String(draftId || '').trim();
  if (!cleanId || !user?.id) return false;
  await db.run('DELETE FROM sculpture_drafts WHERE id = ? AND owner_sub = ?', [cleanId, user.id]);
  return true;
}
