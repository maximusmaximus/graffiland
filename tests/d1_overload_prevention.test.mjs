import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compactSignaturePayload,
  compactSignatureRequestsMaintenance,
  compactSignatureResult,
  enqueueSignatureRequest,
  getSignatureRequestPreviewModel,
  listPendingSignaturesForUser,
  rejectSignatureRequest
} from '../shared/mcp/signatureService.mjs';
import {
  listLandsWithCurations,
  listOwnerLandsAndSculptures
} from '../shared/mcp/landMutations.mjs';
import worker from '../worker/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.resolve(__dirname, '../worker/schema.sql'), 'utf8');

function createSqliteAdapter() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
  let queryCount = 0;
  const adapter = {
    raw: sqlite,
    getQueryCount: () => queryCount,
    resetQueryCount: () => {
      queryCount = 0;
    },
    get: async (sql, params = []) => {
      queryCount += 1;
      return sqlite.prepare(sql).get(...params) || null;
    },
    all: async (sql, params = []) => {
      queryCount += 1;
      return sqlite.prepare(sql).all(...params) || [];
    },
    run: async (sql, params = []) => {
      queryCount += 1;
      const res = sqlite.prepare(sql).run(...params);
      return { changes: Number(res.changes || 0), meta: { changes: Number(res.changes || 0) } };
    }
  };
  return adapter;
}

function createMemoryBlobStore() {
  const map = new Map();
  return {
    map,
    put: async (k, v, ttlSec) => {
      map.set(k, { value: v, ttlSec });
    },
    get: async (k) => map.get(k)?.value ?? null,
    delete: async (k) => {
      map.delete(k);
    }
  };
}

// Minimal valid GLB header + JSON chunk (valid enough for extractCustomModelInput / preview-model)
function makeFakeGlbBase64(extraPadBytes = 24000) {
  const jsonText = JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }]
  });
  const padJson = jsonText + ' '.repeat((4 - (jsonText.length % 4)) % 4);
  const jsonBuf = Buffer.from(padJson, 'utf8');
  const binLen = Math.max(36, Math.ceil(extraPadBytes / 4) * 4);
  const binBuf = Buffer.alloc(binLen);
  const totalLen = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0); // 'glTF'
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  jsonBuf.copy(out, 20);
  const binOffset = 20 + jsonBuf.length;
  out.writeUInt32LE(binBuf.length, binOffset);
  out.writeUInt32LE(0x004e4942, binOffset + 4); // 'BIN\0'
  binBuf.copy(out, binOffset + 8);
  return out.toString('base64');
}

describe('D1 Overload Prevention (Tiers 1–3)', () => {
  test('Tier 1: Offloads pending GLB base64 to KV stagedBlobStore, strips blobs from list polls, hydrates preview-model, and cleans up on reject', async () => {
    const db = createSqliteAdapter();
    const blobStore = createMemoryBlobStore();
    const ownerUser = {
      id: 'google:owner-1',
      wallet_address: '0x1111111111111111111111111111111111111111'
    };
    const bigGlbB64 = makeFakeGlbBase64(48000);

    const reqObj = await enqueueSignatureRequest(db, {
      pairingCode: 'GLP-TEST-1234',
      ownerUser,
      ownerAddress: ownerUser.wallet_address,
      action: 'create_sculpture',
      parcelId: 'GLAND-9Q8YYK8Y',
      payload: {
        title: 'Scattered Syringes — West',
        description: 'Large GLB model staged via MCP',
        modelFormat: 'glb',
        modelBase64: bigGlbB64,
        modelScale: 1
      },
      requestedBy: 'agent',
      agentName: 'land-builder-agent',
      stagedBlobStore: blobStore
    });

    // 1) D1 row itself stays tiny (< 1.5 KB) while heavy GLB lives in KV
    const rawRow = db.raw
      .prepare('SELECT payload_json FROM land_signature_requests WHERE id = ?')
      .get(reqObj.id);
    assert.ok(
      rawRow.payload_json.length < 1500,
      `Expected tiny D1 payload_json, got ${rawRow.payload_json.length} bytes`
    );
    assert.equal(blobStore.map.size, 1, 'Expected GLB binary to be offloaded to stagedBlobStore');

    // 2) List polling response NEVER returns modelBase64 but preserves modelFormat + hasAttachedModel
    const listed = await listPendingSignaturesForUser(db, {
      user: ownerUser,
      includeHistory: true
    });
    assert.equal(listed.requests.length, 1);
    assert.equal(listed.requests[0].payload.modelBase64, undefined);
    assert.equal(listed.requests[0].payload.modelFormat, 'glb');
    assert.equal(listed.requests[0].payload.hasAttachedModel, true);
    assert.match(listed.requests[0].summaryDescription, /GLB 3D model/i);

    // 3) Preview endpoint hydrates exact GLB bytes transparently from KV
    const preview = await getSignatureRequestPreviewModel(db, {
      requestId: reqObj.id,
      user: ownerUser,
      stagedBlobStore: blobStore
    });
    assert.equal(preview.format, 'glb');
    assert.equal(preview.bytes.length, Buffer.from(bigGlbB64, 'base64').length);

    // 4) Rejecting compacts row & deletes KV blob
    await rejectSignatureRequest(db, {
      requestId: reqObj.id,
      user: ownerUser,
      stagedBlobStore: blobStore
    });
    assert.equal(blobStore.map.size, 0, 'Expected staged KV blob to be deleted on reject');
    const afterRow = db.raw
      .prepare('SELECT status, payload_json FROM land_signature_requests WHERE id = ?')
      .get(reqObj.id);
    assert.equal(afterRow.status, 'rejected');
    assert.ok(!afterRow.payload_json.includes('_stagedBlobKey'));
  });

  test('Tier 1: compactSignatureRequestsMaintenance marks expired requests & compacts legacy multi-MB rows without losing History metadata', async () => {
    const db = createSqliteAdapter();
    const hugeBase64 = 'A'.repeat(250_000);
    const pastIso = new Date(Date.now() - 3600_000).toISOString();

    // Insert 1 legacy executed row with 250 KB inline modelBase64 + 1 expired pending row with 250 KB inline modelBase64
    db.raw
      .prepare(
        `INSERT INTO land_signature_requests (
          id, pairing_code, owner_sub, owner_address, action, parcel_id, sculpture_id,
          payload_json, payload_hash, canonical_message, nonce, requested_by, agent_name,
          status, signed_by, signer_address, signature, tx_hash, result_json,
          created_at, updated_at, expires_at
        ) VALUES (?, '', 'google:u1', '0x1111111111111111111111111111111111111111',
          'create_sculpture', 'GLAND-9Q8YYK8Y', '', ?, '0xhash', 'msg', 'n1', 'agent',
          'land-builder-agent', ?, '', '', '', '', ?, ?, ?, ?)`
      )
      .run(
        'sigreq_legacy_exec',
        JSON.stringify({
          title: 'Mushroom Garden',
          description: 'Legacy huge GLB',
          modelFormat: 'glb',
          modelBase64: hugeBase64
        }),
        'executed',
        JSON.stringify({
          sculpture: {
            id: 'sc-1',
            title: 'Mushroom Garden',
            parcelId: 'GLAND-9Q8YYK8Y',
            voxels: Array.from({ length: 500 }, (_, i) => ({ x: i, y: 0, z: 0, color: '#fff' })),
            previewDataUrl: 'data:image/png;base64,' + 'B'.repeat(40_000)
          }
        }),
        pastIso,
        pastIso,
        pastIso
      );

    db.raw
      .prepare(
        `INSERT INTO land_signature_requests (
          id, pairing_code, owner_sub, owner_address, action, parcel_id, sculpture_id,
          payload_json, payload_hash, canonical_message, nonce, requested_by, agent_name,
          status, signed_by, signer_address, signature, tx_hash, result_json,
          created_at, updated_at, expires_at
        ) VALUES (?, '', 'google:u1', '0x1111111111111111111111111111111111111111',
          'create_sculpture', 'GLAND-9Q8YYK8Y', '', ?, '0xhash2', 'msg2', 'n2', 'agent',
          'land-builder-agent', 'pending', '', '', '', '', '{}', ?, ?, ?)`
      )
      .run(
        'sigreq_legacy_expired',
        JSON.stringify({
          title: 'Black Cat',
          description: 'Expired huge GLB',
          modelFormat: 'glb',
          modelBase64: hugeBase64
        }),
        pastIso,
        pastIso,
        pastIso
      );

    const summary = await compactSignatureRequestsMaintenance(db);
    assert.equal(summary.expiredMarked, 1);
    assert.equal(summary.rowsCompacted, 2);
    assert.ok(summary.bytesFreed > 500_000, `Expected >500 KB freed, got ${summary.bytesFreed}`);

    // Verify History titles & descriptions stay 100% intact after compaction
    const listed = await listPendingSignaturesForUser(db, {
      user: { id: 'google:u1', wallet_address: '0x1111111111111111111111111111111111111111' },
      includeHistory: true
    });
    assert.equal(listed.requests.length, 0);
    assert.equal(listed.history.length, 2);
    const titles = listed.history.map((r) => r.summaryTitle).sort();
    assert.deepEqual(titles, ['Place "Black Cat"', 'Place "Mushroom Garden"']);

    // Sanity check direct helper exports
    const compactedP = compactSignaturePayload({
      title: 'Voxel Art',
      voxels: [{ x: 0, y: 0, z: 0 }],
      modelBase64: 'AAAA'
    });
    assert.equal(compactedP.modelBase64, undefined);
    assert.equal(compactedP.voxelCount, 1);
    const compactedR = compactSignatureResult({
      sculpture: { id: 's1', voxels: [1, 2, 3], previewDataUrl: 'X'.repeat(5000) }
    });
    assert.equal(compactedR.sculpture.voxels, undefined);
    assert.equal(compactedR.sculpture.voxelCount, 3);
    assert.equal(compactedR.sculpture.previewDataUrl, undefined);
  });

  test('Tier 2: listLandsWithCurations and listOwnerLandsAndSculptures stay O(1) query count as parcel count scales', async () => {
    const db = createSqliteAdapter();
    const ownerId = 'google:multi-owner';
    const ownerAddr = '0x2222222222222222222222222222222222222222';
    const now = new Date().toISOString();

    db.raw
      .prepare(
        `INSERT INTO users (id, email, name, username, wallet_address, encrypted_wallet_json, created_at, last_login_at)
         VALUES (?, 'm@test', 'Multi', 'multiowner', ?, '{}', ?, ?)`
      )
      .run(ownerId, ownerAddr, now, now);

    // Seed 20 distinct minted lands
    for (let i = 0; i < 20; i++) {
      const gh = `9q8yy${String.fromCharCode(97 + (i % 10))}${String.fromCharCode(97 + Math.floor(i / 10))}b`;
      const pid = `GLAND-${gh.toUpperCase()}`;
      db.raw
        .prepare(
          `INSERT INTO land_parcels (parcel_id, geohash, center_lat, center_lng, first_claimant_sub, first_claimant_address, latest_claimant_address, sculpture_count, updated_at)
           VALUES (?, ?, 37.77, -122.41, ?, ?, ?, 0, ?)`
        )
        .run(pid, gh, ownerId, ownerAddr, ownerAddr, now);
    }

    db.resetQueryCount();
    const publicLands = await listLandsWithCurations(db);
    const publicQueries = db.getQueryCount();
    assert.equal(publicLands.length, 20);
    assert.ok(
      publicQueries <= 15,
      `Expected O(1) <= 15 queries for 20 parcels in listLandsWithCurations, ran ${publicQueries}`
    );

    db.resetQueryCount();
    const ownerWorkspace = await listOwnerLandsAndSculptures(db, {
      id: ownerId,
      wallet_address: ownerAddr
    });
    const ownerQueries = db.getQueryCount();
    assert.equal(ownerWorkspace.parcelCount, 20);
    assert.ok(
      ownerQueries <= 18,
      `Expected O(1) <= 18 queries for 20 owned parcels in listOwnerLandsAndSculptures, ran ${ownerQueries}`
    );
  });

  test('Tier 3: Worker retries transient D1 overload errors automatically and maps persistent overload to friendly 503', async () => {
    // 1) Transient failure on attempt 1 -> succeeds on retry
    let transientAttempts = 0;
    const fakeEnvRecovering = {
      SESSION_SECRET: 'test-session-secret-long-enough-1234',
      WALLET_ENCRYPTION_KEY: 'test-wallet-key-long-enough-1234',
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              transientAttempts += 1;
              if (transientAttempts === 1) {
                throw new Error(
                  'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'
                );
              }
              return { results: [] };
            },
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } })
          })
        })
      }
    };
    const okRes = await worker.fetch(
      new Request('https://api.spray.land/api/parcels'),
      fakeEnvRecovering
    );
    assert.equal(okRes.status, 200);
    assert.ok(transientAttempts >= 2, `Expected retry after transient D1 overload, got ${transientAttempts}`);

    // 2) Persistent D1 overload -> friendly 503 instead of leaking raw D1_ERROR
    const fakeEnvOverloaded = {
      SESSION_SECRET: 'test-session-secret-long-enough-1234',
      WALLET_ENCRYPTION_KEY: 'test-wallet-key-long-enough-1234',
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error(
                'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'
              );
            },
            first: async () => {
              throw new Error(
                'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'
              );
            },
            run: async () => {
              throw new Error(
                'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'
              );
            }
          })
        })
      }
    };
    const busyRes = await worker.fetch(
      new Request('https://api.spray.land/api/signatures/pending', {
        headers: { Authorization: 'Bearer invalid' }
      }),
      fakeEnvOverloaded
    );
    // Unauthenticated returns 401 before DB; test an authenticated/public route that hits DB via d1Adapter
    assert.equal(busyRes.status, 401);

    const mcpBusyRes = await worker.fetch(
      new Request('https://api.spray.land/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      }),
      fakeEnvOverloaded
    );
    assert.equal(mcpBusyRes.status, 503);
    const mcpBusyJson = await mcpBusyRes.json();
    assert.match(mcpBusyJson.error.message, /briefly busy/i);
    assert.ok(!mcpBusyJson.error.message.includes('D1_ERROR'));
  });
});
