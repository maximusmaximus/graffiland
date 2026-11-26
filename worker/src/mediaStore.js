import { b64ToModelBytes, CUSTOM_MODEL_MAX_BYTES } from '../../shared/model3d.mjs';

export const PUBLIC_MEDIA_PREFIXES = ['previews/', 'profiles/', 'models/'];

export const SAFE_MEDIA_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
  ['model/gltf-binary', 'glb'],
  ['model/gltf+json', 'gltf'],
  ['model/obj', 'obj'],
  ['model/stl', 'stl'],
  ['application/octet-stream', 'bin'],
  ['application/json', 'json'],
  ['text/plain', 'txt']
]);

const DATA_URL_IMAGE_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

function sanitizeSegment(raw, fallback = 'item') {
  const clean = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return clean || fallback;
}

async function shortSha256Hex(bytes, hexLen = 12) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length && out.length < hexLen; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, hexLen);
}

export function decodeImageDataUrl(dataUrl, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const str = String(dataUrl || '').trim();
  if (!str) return null;
  const m = str.match(DATA_URL_IMAGE_RE);
  if (!m) return null;
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const ext = SAFE_MEDIA_MIME.get(mime);
  if (!ext) return null;
  const cleanB64 = m[2].replace(/\s+/g, '');
  try {
    const bin = atob(cleanB64);
    if (bin.length === 0 || bin.length > maxBytes) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, ext, bytes };
  } catch {
    return null;
  }
}

/**
 * R2-first staged blob store for pending agent/guest signature payloads (GLBs, previews).
 * Falls back transparently to IPFS_KV when MEDIA_BUCKET is unbound or for legacy in-flight keys.
 */
export function createWorkerStagedBlobStore(env) {
  const r2 = env?.MEDIA_BUCKET || null;
  const kv = env?.IPFS_KV || null;
  if (!r2 && !kv) return null;

  return {
    backend: r2 ? 'r2' : 'kv',
    async put(key, value, ttlSec = 7200) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return;
      const safeTtl = Math.max(60, Number(ttlSec) || 7200);
      if (r2) {
        const expiresAt = new Date(Date.now() + safeTtl * 1000).toISOString();
        await r2.put(`staged/${cleanKey}`, value, {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { expiresAt }
        });
        return;
      }
      await kv.put(cleanKey, value, { expirationTtl: safeTtl });
    },
    async get(key) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return null;
      if (r2) {
        const obj = await r2.get(`staged/${cleanKey}`);
        if (obj) {
          const expIso = obj.customMetadata?.expiresAt || '';
          if (expIso && Date.parse(expIso) < Date.now()) {
            await r2.delete(`staged/${cleanKey}`).catch(() => {});
            return null;
          }
          return await obj.text();
        }
      }
      if (kv) {
        return await kv.get(cleanKey);
      }
      return null;
    },
    async delete(key) {
      const cleanKey = String(key || '').trim();
      if (!cleanKey) return;
      if (r2) {
        await r2.delete(`staged/${cleanKey}`).catch(() => {});
      }
      if (kv) {
        await kv.delete(cleanKey).catch(() => {});
      }
    }
  };
}

/**
 * Deletes expired staged/* blobs from R2 during scheduled cron maintenance.
 */
export async function pruneExpiredStagedBlobs(env, { nowMs = Date.now(), maxDeletes = 100 } = {}) {
  const r2 = env?.MEDIA_BUCKET || null;
  if (!r2 || typeof r2.list !== 'function') {
    return { scanned: 0, deleted: 0 };
  }
  const fallbackCutoffMs = nowMs - 24 * 60 * 60 * 1000;
  let scanned = 0;
  let deleted = 0;
  let cursor = undefined;

  while (deleted < maxDeletes) {
    const page = await r2.list({ prefix: 'staged/', limit: 100, cursor }).catch(() => null);
    if (!page || !Array.isArray(page.objects) || page.objects.length === 0) break;
    for (const obj of page.objects) {
      scanned += 1;
      const expIso = obj.customMetadata?.expiresAt || '';
      const expMs = expIso ? Date.parse(expIso) : NaN;
      const uploadedMs = obj.uploaded ? new Date(obj.uploaded).getTime() : NaN;
      const isExpired = Number.isFinite(expMs)
        ? expMs < nowMs
        : Number.isFinite(uploadedMs) && uploadedMs < fallbackCutoffMs;
      if (isExpired) {
        await r2.delete(obj.key).catch(() => {});
        deleted += 1;
        if (deleted >= maxDeletes) break;
      }
    }
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  return { scanned, deleted };
}

/**
 * Stores raw 3D model bytes directly in R2 (no base64 inflation).
 */
export async function putModelBinaryToMedia(env, { cid, bytes, contentType = 'model/gltf-binary' }) {
  const r2 = env?.MEDIA_BUCKET || null;
  const cleanCid = String(cid || '').trim();
  if (!r2 || !cleanCid || !bytes || bytes.length === 0 || bytes.length > CUSTOM_MODEL_MAX_BYTES) {
    return false;
  }
  const safeType = SAFE_MEDIA_MIME.has(String(contentType).toLowerCase())
    ? String(contentType).toLowerCase()
    : 'application/octet-stream';
  await r2.put(`models/${cleanCid}`, bytes, {
    httpMetadata: {
      contentType: safeType,
      cacheControl: 'public, max-age=31536000, immutable'
    },
    customMetadata: { cid: cleanCid, byteLength: String(bytes.length) }
  });
  return true;
}

/**
 * Reads raw 3D model bytes from R2 without base64 decode overhead.
 */
export async function getModelBinaryFromMedia(env, cid) {
  const r2 = env?.MEDIA_BUCKET || null;
  const cleanCid = String(cid || '').trim();
  if (!r2 || !cleanCid) return null;
  const obj = await r2.get(`models/${cleanCid}`);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
    etag: obj.httpEtag || ''
  };
}

/**
 * Stores fallback IPFS content-addressed bytes directly in R2 when PINATA_JWT is unset.
 */
export async function putIpfsObjectToMedia(env, { cid, bytes, contentType }) {
  const r2 = env?.MEDIA_BUCKET || null;
  const cleanCid = String(cid || '').trim();
  if (!r2 || !cleanCid || !bytes) return false;
  const safeType = SAFE_MEDIA_MIME.has(String(contentType).toLowerCase())
    ? String(contentType).toLowerCase()
    : 'application/octet-stream';
  await r2.put(`ipfs/${cleanCid}`, bytes, {
    httpMetadata: {
      contentType: safeType,
      cacheControl: 'public, max-age=31536000, immutable'
    }
  });
  return true;
}

export async function getIpfsObjectFromMedia(env, cid) {
  const r2 = env?.MEDIA_BUCKET || null;
  const cleanCid = String(cid || '').trim();
  if (!r2 || !cleanCid) return null;
  const obj = (await r2.get(`ipfs/${cleanCid}`)) || (await r2.get(`models/${cleanCid}`));
  if (!obj) return null;
  return {
    body: obj.body,
    arrayBuffer: () => obj.arrayBuffer(),
    contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
    etag: obj.httpEtag || ''
  };
}

/**
 * Offloads a base64 `data:image/...` string to Cloudflare R2 and returns an immutable HTTPS URL.
 * If MEDIA_BUCKET is not bound or input is already a URL / empty / non-data-URL, returns input unchanged.
 */
export async function offloadDataUrlToR2(env, { dataUrl, prefix = 'previews', id = 'asset', origin = '' }) {
  const raw = String(dataUrl || '').trim();
  if (!raw || !raw.startsWith('data:image/')) {
    return { url: raw, offloaded: false, key: '', bytes: 0 };
  }
  const r2 = env?.MEDIA_BUCKET || null;
  const cleanOrigin = String(origin || '').replace(/\/+$/, '');
  if (!r2 || !cleanOrigin) {
    return { url: raw, offloaded: false, key: '', bytes: 0 };
  }
  const decoded = decodeImageDataUrl(raw);
  if (!decoded) {
    return { url: raw, offloaded: false, key: '', bytes: 0 };
  }
  const safePrefix = sanitizeSegment(prefix, 'previews');
  if (!PUBLIC_MEDIA_PREFIXES.includes(`${safePrefix}/`)) {
    return { url: raw, offloaded: false, key: '', bytes: 0 };
  }
  const safeId = sanitizeSegment(id, 'asset');
  const hash = await shortSha256Hex(decoded.bytes, 12);
  const key = `${safePrefix}/${safeId}-${hash}.${decoded.ext}`;
  await r2.put(key, decoded.bytes, {
    httpMetadata: {
      contentType: decoded.mime,
      cacheControl: 'public, max-age=31536000, immutable'
    },
    customMetadata: { sourceId: safeId, byteLength: String(decoded.bytes.length) }
  });
  return {
    url: `${cleanOrigin}/api/media/${key}`,
    offloaded: true,
    key,
    bytes: decoded.bytes.length
  };
}

/**
 * Validates and serves public media objects from R2 (`previews/`, `profiles/`, `models/`).
 * Explicitly rejects private prefixes (`staged/`, `snapshots/`) and traversal attempts.
 */
export async function serveR2MediaResponse(env, rawKey, request, corsHeadersFn = () => ({})) {
  const r2 = env?.MEDIA_BUCKET || null;
  if (!r2) {
    return new Response(JSON.stringify({ error: 'Media store unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeadersFn(request) }
    });
  }
  const key = String(rawKey || '').replace(/^\/+/, '');
  if (!key || key.includes('..') || !/^[a-zA-Z0-9/_.-]{3,220}$/.test(key)) {
    return new Response(JSON.stringify({ error: 'Invalid media key' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeadersFn(request) }
    });
  }
  const isAllowedPublic = PUBLIC_MEDIA_PREFIXES.some((p) => key.startsWith(p));
  if (!isAllowedPublic) {
    return new Response(JSON.stringify({ error: 'Forbidden media prefix' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeadersFn(request) }
    });
  }

  const obj = await r2.get(key);
  if (!obj) {
    return new Response(JSON.stringify({ error: 'Media object not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeadersFn(request) }
    });
  }

  const etag = obj.httpEtag || (obj.etag ? `"${obj.etag}"` : '');
  const ifNoneMatch = request?.headers?.get?.('If-None-Match') || '';
  if (etag && ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...corsHeadersFn(request)
      }
    });
  }

  const storedType = String(obj.httpMetadata?.contentType || '').toLowerCase();
  const contentType = SAFE_MEDIA_MIME.has(storedType) ? storedType : 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Media-Source': 'r2',
    ...corsHeadersFn(request)
  };
  if (etag) headers.ETag = etag;

  return new Response(request?.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

/**
 * Opportunistic + on-demand migration that moves legacy inline D1 media blobs into R2:
 *  1) sculptures.preview_data_url (data:image/... -> /api/media/previews/...)
 *  2) sculpture_models.inline_b64 (base64 GLB -> R2 models/<cid>, then clears inline_b64)
 *  3) sculpture_drafts.preview_data_url (data:image/... -> /api/media/previews/...)
 *  4) users.avatar_image & header_image (data:image/... -> /api/media/profiles/...)
 */
export async function offloadLegacyD1MediaBatch(db, env, { origin = '', maxRows = 12 } = {}) {
  const r2 = env?.MEDIA_BUCKET || null;
  const cleanOrigin = String(origin || '').replace(/\/+$/, '');
  if (!r2 || !cleanOrigin || !db) {
    return {
      skipped: true,
      previewsMigrated: 0,
      modelsMigrated: 0,
      draftsMigrated: 0,
      profilesMigrated: 0,
      bytesFreed: 0
    };
  }

  const limit = Math.max(1, Math.min(50, Number(maxRows) || 12));
  let previewsMigrated = 0;
  let modelsMigrated = 0;
  let draftsMigrated = 0;
  let profilesMigrated = 0;
  let bytesFreed = 0;

  // 1) Inline sculpture preview PNGs
  const scRows = await db
    .all(
      `SELECT id, preview_data_url
       FROM sculptures
       WHERE preview_data_url LIKE 'data:image/%'
       ORDER BY created_at ASC
       LIMIT ?`,
      [limit]
    )
    .catch(() => []);
  for (const row of scRows || []) {
    const orig = String(row.preview_data_url || '');
    const res = await offloadDataUrlToR2(env, {
      dataUrl: orig,
      prefix: 'previews',
      id: `sc-${row.id}`,
      origin: cleanOrigin
    }).catch(() => ({ offloaded: false }));
    if (res.offloaded && res.url) {
      await db.run('UPDATE sculptures SET preview_data_url = ? WHERE id = ?', [res.url, row.id]);
      previewsMigrated += 1;
      bytesFreed += Math.max(0, orig.length - res.url.length);
    }
  }

  // 2) Inline 3D model base64 payloads in sculpture_models
  const modelRows = await db
    .all(
      `SELECT sculpture_id, model_cid, mime_type, inline_b64
       FROM sculpture_models
       WHERE inline_b64 IS NOT NULL AND LENGTH(inline_b64) > 0
       LIMIT ?`,
      [limit]
    )
    .catch(() => []);
  for (const row of modelRows || []) {
    try {
      const origLen = String(row.inline_b64 || '').length;
      const bytes = b64ToModelBytes(row.inline_b64);
      const cid = String(row.model_cid || '').trim() || `scmodel-${row.sculpture_id}`;
      if (bytes && bytes.length > 0) {
        const stored = await putModelBinaryToMedia(env, {
          cid,
          bytes,
          contentType: row.mime_type || 'model/gltf-binary'
        });
        if (stored) {
          await db.run(
            `UPDATE sculpture_models
             SET inline_b64 = '', model_cid = CASE WHEN model_cid = '' THEN ? ELSE model_cid END
             WHERE sculpture_id = ?`,
            [cid, row.sculpture_id]
          );
          modelsMigrated += 1;
          bytesFreed += origLen;
        }
      }
    } catch {
      // Skip malformed row and continue
    }
  }

  // 3) Inline draft preview PNGs
  const draftRows = await db
    .all(
      `SELECT id, preview_data_url
       FROM sculpture_drafts
       WHERE preview_data_url LIKE 'data:image/%'
       LIMIT ?`,
      [limit]
    )
    .catch(() => []);
  for (const row of draftRows || []) {
    const orig = String(row.preview_data_url || '');
    const res = await offloadDataUrlToR2(env, {
      dataUrl: orig,
      prefix: 'previews',
      id: `draft-${row.id}`,
      origin: cleanOrigin
    }).catch(() => ({ offloaded: false }));
    if (res.offloaded && res.url) {
      await db.run('UPDATE sculpture_drafts SET preview_data_url = ? WHERE id = ?', [
        res.url,
        row.id
      ]);
      draftsMigrated += 1;
      bytesFreed += Math.max(0, orig.length - res.url.length);
    }
  }

  // 4) Inline profile avatars & banners
  const userRows = await db
    .all(
      `SELECT id, avatar_image, header_image
       FROM users
       WHERE avatar_image LIKE 'data:image/%' OR header_image LIKE 'data:image/%'
       LIMIT ?`,
      [limit]
    )
    .catch(() => []);
  for (const row of userRows || []) {
    let nextAvatar = String(row.avatar_image || '');
    let nextHeader = String(row.header_image || '');
    let changed = false;
    if (nextAvatar.startsWith('data:image/')) {
      const res = await offloadDataUrlToR2(env, {
        dataUrl: nextAvatar,
        prefix: 'profiles',
        id: `av-${row.id}`,
        origin: cleanOrigin
      }).catch(() => ({ offloaded: false }));
      if (res.offloaded && res.url) {
        bytesFreed += Math.max(0, nextAvatar.length - res.url.length);
        nextAvatar = res.url;
        changed = true;
      }
    }
    if (nextHeader.startsWith('data:image/')) {
      const res = await offloadDataUrlToR2(env, {
        dataUrl: nextHeader,
        prefix: 'profiles',
        id: `hdr-${row.id}`,
        origin: cleanOrigin
      }).catch(() => ({ offloaded: false }));
      if (res.offloaded && res.url) {
        bytesFreed += Math.max(0, nextHeader.length - res.url.length);
        nextHeader = res.url;
        changed = true;
      }
    }
    if (changed) {
      await db.run('UPDATE users SET avatar_image = ?, header_image = ? WHERE id = ?', [
        nextAvatar,
        nextHeader,
        row.id
      ]);
      profilesMigrated += 1;
    }
  }

  return {
    skipped: false,
    previewsMigrated,
    modelsMigrated,
    draftsMigrated,
    profilesMigrated,
    bytesFreed
  };
}
