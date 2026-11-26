import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createWorkerStagedBlobStore,
  getModelBinaryFromMedia,
  offloadDataUrlToR2,
  offloadLegacyD1MediaBatch,
  pruneExpiredStagedBlobs,
  putModelBinaryToMedia,
  serveR2MediaResponse
} from '../worker/src/mediaStore.js';
import worker from '../worker/src/index.js';

function createMockR2Bucket() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value, opts = {}) {
      let bytes;
      if (typeof value === 'string') {
        bytes = new TextEncoder().encode(value);
      } else if (value instanceof Uint8Array) {
        bytes = new Uint8Array(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        bytes = new TextEncoder().encode(String(value));
      }
      store.set(key, {
        key,
        bytes,
        httpMetadata: opts.httpMetadata || {},
        customMetadata: opts.customMetadata || {},
        httpEtag: `"etag-${key}-${bytes.length}"`,
        uploaded: opts._uploaded || new Date()
      });
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        key: item.key,
        body: item.bytes,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata,
        httpEtag: item.httpEtag,
        uploaded: item.uploaded,
        async text() {
          return new TextDecoder().decode(item.bytes);
        },
        async arrayBuffer() {
          return item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength);
        }
      };
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', limit = 100 } = {}) {
      const objects = [];
      for (const item of store.values()) {
        if (!prefix || item.key.startsWith(prefix)) {
          objects.push({
            key: item.key,
            customMetadata: item.customMetadata,
            uploaded: item.uploaded
          });
          if (objects.length >= limit) break;
        }
      }
      return { objects, truncated: false };
    }
  };
}

function createMockKv() {
  const map = new Map();
  return {
    _map: map,
    async put(key, val, opts = {}) {
      map.set(key, { value: val, metadata: opts.metadata || {} });
    },
    async get(key) {
      return map.get(key)?.value ?? null;
    },
    async getWithMetadata(key) {
      return map.get(key) || { value: null, metadata: null };
    },
    async delete(key) {
      map.delete(key);
    }
  };
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

describe('Cloudflare R2 Media & Staging Offloading (mediaStore.js)', () => {
  test('createWorkerStagedBlobStore uses R2 first, falls back to KV for legacy keys, and prunes expired staged blobs', async () => {
    const r2 = createMockR2Bucket();
    const kv = createMockKv();
    const store = createWorkerStagedBlobStore({ MEDIA_BUCKET: r2, IPFS_KV: kv });

    assert.equal(store.backend, 'r2');
    await store.put('sigblob:req-1', JSON.stringify({ modelBase64: 'QUJD' }), 3600);
    assert.ok(r2._store.has('staged/sigblob:req-1'));
    assert.equal(kv._map.size, 0, 'New staged blobs must not burn KV writes when R2 is bound');

    const loaded = await store.get('sigblob:req-1');
    assert.equal(JSON.parse(loaded).modelBase64, 'QUJD');

    // Legacy in-flight KV staged blob still resolves seamlessly
    await kv.put('sigblob:legacy-kv-1', JSON.stringify({ modelBase64: 'TEVH' }));
    const legacyLoaded = await store.get('sigblob:legacy-kv-1');
    assert.equal(JSON.parse(legacyLoaded).modelBase64, 'TEVH');

    // Delete cleans both R2 and KV
    await store.delete('sigblob:req-1');
    await store.delete('sigblob:legacy-kv-1');
    assert.equal(await store.get('sigblob:req-1'), null);
    assert.equal(await store.get('sigblob:legacy-kv-1'), null);

    // Expired staged objects get pruned cleanly by cron helper
    await r2.put('staged/sigblob:old-expired', '{}', {
      customMetadata: { expiresAt: new Date(Date.now() - 60_000).toISOString() }
    });
    await r2.put('staged/sigblob:fresh', '{}', {
      customMetadata: { expiresAt: new Date(Date.now() + 600_000).toISOString() }
    });
    const pruned = await pruneExpiredStagedBlobs({ MEDIA_BUCKET: r2 });
    assert.equal(pruned.deleted, 1);
    assert.equal(r2._store.has('staged/sigblob:old-expired'), false);
    assert.equal(r2._store.has('staged/sigblob:fresh'), true);
  });

  test('putModelBinaryToMedia & getModelBinaryFromMedia store and retrieve raw 3D model bytes without base64 bloat', async () => {
    const r2 = createMockR2Bucket();
    const rawGlb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);
    const ok = await putModelBinaryToMedia(
      { MEDIA_BUCKET: r2 },
      { cid: 'QmTestModelCid123456', bytes: rawGlb, contentType: 'model/gltf-binary' }
    );
    assert.equal(ok, true);
    const hit = await getModelBinaryFromMedia({ MEDIA_BUCKET: r2 }, 'QmTestModelCid123456');
    assert.ok(hit);
    assert.equal(hit.contentType, 'model/gltf-binary');
    assert.deepEqual(Array.from(hit.bytes), Array.from(rawGlb));
  });

  test('offloadDataUrlToR2 offloads image data URLs and serveR2MediaResponse enforces strict public prefix & security headers', async () => {
    const r2 = createMockR2Bucket();
    const origin = 'https://graffiland-api.maxinfeld-artshow.workers.dev';

    const res = await offloadDataUrlToR2(
      { MEDIA_BUCKET: r2 },
      { dataUrl: TINY_PNG_DATA_URL, prefix: 'previews', id: 'sc-abc123', origin }
    );
    assert.equal(res.offloaded, true);
    assert.ok(res.url.startsWith(`${origin}/api/media/previews/sc-abc123-`));
    assert.ok(res.url.endsWith('.png'));

    // Already-offloaded HTTPS URL passes through untouched
    const passthrough = await offloadDataUrlToR2(
      { MEDIA_BUCKET: r2 },
      { dataUrl: res.url, prefix: 'previews', id: 'sc-abc123', origin }
    );
    assert.equal(passthrough.offloaded, false);
    assert.equal(passthrough.url, res.url);

    // Unsafe HTML data URL is rejected from offloading
    const unsafe = await offloadDataUrlToR2(
      { MEDIA_BUCKET: r2 },
      { dataUrl: 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=', prefix: 'previews', id: 'bad', origin }
    );
    assert.equal(unsafe.offloaded, false);

    // Serve public preview with strict headers + 304 ETag
    const req = new Request(`${origin}/api/media/${res.key}`, { method: 'GET' });
    const httpRes = await serveR2MediaResponse({ MEDIA_BUCKET: r2 }, res.key, req);
    assert.equal(httpRes.status, 200);
    assert.equal(httpRes.headers.get('Content-Type'), 'image/png');
    assert.equal(httpRes.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(httpRes.headers.get('Content-Security-Policy') || '', /sandbox/);
    const etag = httpRes.headers.get('ETag');
    assert.ok(etag);

    const notModRes = await serveR2MediaResponse(
      { MEDIA_BUCKET: r2 },
      res.key,
      new Request(`${origin}/api/media/${res.key}`, { headers: { 'If-None-Match': etag } })
    );
    assert.equal(notModRes.status, 304);

    // Private prefixes (staged/ and snapshots/) and traversal attempts MUST be blocked
    await r2.put('staged/secret-blob', '{"secret":true}');
    await r2.put('snapshots/mainnet.json', '{"private":true}');
    const stagedResp = await serveR2MediaResponse({ MEDIA_BUCKET: r2 }, 'staged/secret-blob', req);
    assert.equal(stagedResp.status, 403);
    const snapResp = await serveR2MediaResponse({ MEDIA_BUCKET: r2 }, 'snapshots/mainnet.json', req);
    assert.equal(snapResp.status, 403);
    const travResp = await serveR2MediaResponse({ MEDIA_BUCKET: r2 }, 'previews/../staged/secret-blob', req);
    assert.equal(travResp.status, 400);
  });

  test('offloadLegacyD1MediaBatch migrates inline previews, models, drafts & profile images from D1 to R2', async () => {
    const r2 = createMockR2Bucket();
    const updates = [];
    const mockDb = {
      async all(sql) {
        if (sql.includes('FROM sculptures')) {
          return [{ id: 'sc-legacy-1', preview_data_url: TINY_PNG_DATA_URL }];
        }
        if (sql.includes('FROM sculpture_models')) {
          return [
            {
              sculpture_id: 'sc-legacy-1',
              model_cid: 'QmLegacyModelCid999',
              mime_type: 'model/gltf-binary',
              inline_b64: Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]).toString('base64')
            }
          ];
        }
        if (sql.includes('FROM sculpture_drafts')) {
          return [{ id: 'draft-1', preview_data_url: TINY_PNG_DATA_URL }];
        }
        if (sql.includes('FROM users')) {
          return [{ id: 'user-1', avatar_image: TINY_PNG_DATA_URL, header_image: TINY_PNG_DATA_URL }];
        }
        return [];
      },
      async run(sql, params) {
        updates.push({ sql, params });
      }
    };

    const out = await offloadLegacyD1MediaBatch(mockDb, { MEDIA_BUCKET: r2 }, {
      origin: 'https://graffiland-api.maxinfeld-artshow.workers.dev',
      maxRows: 10
    });
    assert.equal(out.previewsMigrated, 1);
    assert.equal(out.modelsMigrated, 1);
    assert.equal(out.draftsMigrated, 1);
    assert.equal(out.profilesMigrated, 1);
    assert.ok(out.bytesFreed > 0);
    assert.equal(updates.length, 4);
    assert.ok(r2._store.has('models/QmLegacyModelCid999'));
  });

  test('Worker GET /api/media/* serves public R2 previews and blocks private prefixes', async () => {
    const r2 = createMockR2Bucket();
    const origin = 'https://graffiland-api.maxinfeld-artshow.workers.dev';
    const env = {
      MEDIA_BUCKET: r2,
      IPFS_KV: createMockKv(),
      SESSION_SECRET: 'test-strong-secret-value-for-worker-r2-suite-123456',
      WALLET_ENCRYPTION_KEY: 'test-strong-wallet-key-value-for-worker-r2-123456',
      PUBLIC_URL: 'https://spray.land'
    };
    const off = await offloadDataUrlToR2(env, {
      dataUrl: TINY_PNG_DATA_URL,
      prefix: 'previews',
      id: 'worker-test',
      origin
    });
    await r2.put('staged/internal-blob', '{"x":1}');

    const okRes = await worker.fetch(new Request(off.url), env, {});
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get('X-Media-Source'), 'r2');

    const blockedRes = await worker.fetch(
      new Request(`${origin}/api/media/staged/internal-blob`),
      env,
      {}
    );
    assert.equal(blockedRes.status, 403);
  });
});
