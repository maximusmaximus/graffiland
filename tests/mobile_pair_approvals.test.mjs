import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-pair-approvals-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');
const { describeSignatureAction } = await import('../shared/mcp/signatureService.mjs');
const { parseDesktopPairQrText } = await import('../client/src/utils/qrPairScanner.js');
const worker = (await import('../worker/src/index.js')).default;

let server;
let baseUrl;

before(async () => {
  const { server: srv } = createAppServer();
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function apiJson(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('Mobile Pairing QR Parser & Signature Approval History', () => {
  test('parseDesktopPairQrText extracts Desktop URL ?pair=, raw 6-char codes, and GLP MCP codes', () => {
    assert.deepEqual(
      parseDesktopPairQrText('https://maximusmaximus.github.io/graffiland/?pair=a7k9p2'),
      {
        kind: 'desktop',
        code: 'A7K9P2',
        raw: 'https://maximusmaximus.github.io/graffiland/?pair=a7k9p2'
      }
    );
    assert.equal(parseDesktopPairQrText('?pair=ZX12CV')?.code, 'ZX12CV');
    assert.equal(parseDesktopPairQrText('q9m3t4')?.code, 'Q9M3T4');
    assert.equal(parseDesktopPairQrText('q9m3t4')?.kind, 'desktop');
    assert.deepEqual(parseDesktopPairQrText('GLP-ABCD-2345-EFGH-6789'), {
      kind: 'mcp',
      code: 'GLP-ABCD-2345-EFGH-6789',
      raw: 'GLP-ABCD-2345-EFGH-6789'
    });
    assert.equal(parseDesktopPairQrText('not-a-valid-code-at-all'), null);
  });

  test('describeSignatureAction generates human-readable titles and descriptions for agent actions', () => {
    const createSummary = describeSignatureAction({
      action: 'create_sculpture',
      parcelId: 'GLAND-9Q8YYK8Y',
      payload: {
        title: 'Neon Arch',
        description: 'Glowing cyberpunk gate',
        modelFormat: 'glb'
      }
    });
    assert.match(createSummary.summaryTitle, /Neon Arch/);
    assert.match(createSummary.summaryDescription, /GLB 3D model/i);
    assert.match(createSummary.summaryDescription, /Glowing cyberpunk gate/);

    const freezeSummary = describeSignatureAction({
      action: 'update_land_settings',
      parcelId: 'GLAND-9Q8YYK8Y',
      payload: { frozen: true }
    });
    assert.equal(freezeSummary.summaryTitle, 'Freeze Land');
    assert.match(freezeSummary.summaryDescription, /Freeze land/);
  });

  test('Express /api/signatures/pending?includeHistory=1 and /api/signatures/history track pending, approved & rejected items', async () => {
    const login = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'pair-hist@graffiland.test', name: 'Owner' } })
    });
    assert.equal(login.status, 200);
    const token = login.body.token;
    const ownerAddr = login.body.user.walletAddress;

    // Claim a land parcel so MCP agent can enqueue land actions for owner approval
    const claim = await apiJson('/api/lands/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ lat: 37.7751, lng: -122.4191, customName: 'Approval Plaza' })
    });
    assert.equal(claim.status, 201);
    const parcelId = claim.body.parcelId;

    // Create & connect robust MCP pairing
    const pairCreate = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(pairCreate.status, 200);
    const pairCode = pairCreate.body.pairing.code;

    const pairConn = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({
        pairingCode: pairCode,
        agentName: 'Studio Assistant',
        agentAddress: ownerAddr
      })
    });
    assert.equal(pairConn.status, 200);

    // Enqueue 2 unsigned agent mutations -> both appear as pending for mobile approval
    const req1 = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_land_parcel',
          arguments: {
            parcelId,
            customName: 'Approval Plaza V2',
            description: 'Curated open-air sculpture park'
          }
        }
      })
    });
    assert.equal(req1.status, 200);
    const req1Id = req1.body.result.structuredContent.request.id;

    const req2 = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'put_sculpture_on_land',
          arguments: {
            parcelId,
            title: 'Agent Beacon',
            description: 'A glowing beacon staged by my agent',
            voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
          }
        }
      })
    });
    assert.equal(req2.status, 200);
    const req2Id = req2.body.result.structuredContent.request.id;

    // Pending endpoint includes human-readable descriptions
    const pendingRes = await apiJson('/api/signatures/pending?includeHistory=1', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(pendingRes.status, 200);
    assert.equal(pendingRes.body.requests.length, 2);
    assert.equal(pendingRes.body.history.length, 0);
    const beaconItem = pendingRes.body.requests.find((r) => r.id === req2Id);
    assert.match(beaconItem.summaryTitle, /Agent Beacon/);
    assert.match(beaconItem.summaryDescription, /glowing beacon/);

    // Approve req1 (Yes) and Reject req2 (No)
    const approveRes = await apiJson(`/api/signatures/requests/${req1Id}/mobile-sign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(approveRes.status, 200);

    const rejectRes = await apiJson(`/api/signatures/requests/${req2Id}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(rejectRes.status, 200);

    // Now pending is 0 and history contains both executed & rejected items
    const afterRes = await apiJson('/api/signatures/pending?includeHistory=1', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(afterRes.status, 200);
    assert.equal(afterRes.body.requests.length, 0);
    assert.equal(afterRes.body.history.length, 2);
    assert.equal(afterRes.body.history.find((h) => h.id === req1Id)?.status, 'executed');
    assert.equal(afterRes.body.history.find((h) => h.id === req2Id)?.status, 'rejected');

    const histRes = await apiJson('/api/signatures/history', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(histRes.status, 200);
    assert.equal(histRes.body.pending.length, 0);
    assert.equal(histRes.body.history.length, 2);
  });

  test('Worker serves /api/signatures/pending?includeHistory=1 and /api/signatures/history cleanly', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    const env = {
      DB: {
        prepare: (sql) => {
          let params = [];
          const stmt = {
            bind: (...p) => {
              params = p;
              return stmt;
            },
            first: async () => db.prepare(sql).get(...params) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...params) }),
            run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } })
          };
          return stmt;
        }
      },
      PUBLIC_URL: 'https://app.example.dev',
      ALLOW_DEV_GOOGLE_AUTH: 'true',
      SESSION_SECRET: 'test-session-secret',
      WALLET_ENCRYPTION_KEY: 'test-wallet-key'
    };
    const wFetch = async (route, opts = {}) => {
      const res = await worker.fetch(
        new Request(`https://api.example.dev${route}`, {
          ...opts,
          headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
        }),
        env
      );
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const auth = await wFetch('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'w-hist@graffiland.test', name: 'Worker User' } })
    });
    assert.equal(auth.status, 200);
    const tok = auth.body.token;

    const pRes = await wFetch('/api/signatures/pending?includeHistory=1', {
      headers: { Authorization: `Bearer ${tok}` }
    });
    assert.equal(pRes.status, 200);
    assert.deepEqual(pRes.body.requests, []);
    assert.deepEqual(pRes.body.history, []);

    const hRes = await wFetch('/api/signatures/history', {
      headers: { Authorization: `Bearer ${tok}` }
    });
    assert.equal(hRes.status, 200);
    assert.deepEqual(hRes.body.pending, []);
    assert.deepEqual(hRes.body.history, []);

    // Verify expired/disconnected MCP pairing exposes needsRepair and emits a Re-pair notification
    const createdPair = await wFetch('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ expiresHours: 24 })
    });
    assert.equal(createdPair.status, 200);
    const pairCode = createdPair.body.pairing.code;

    // Connect the pairing then force its expires_at into the past -> simulates expired pairing
    const connRes = await wFetch('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({ pairingCode: pairCode, agentName: 'ExpiryBot' })
    });
    assert.equal(connRes.status, 200);
    db.prepare('UPDATE mcp_pairings SET expires_at = ? WHERE code = ?').run(
      new Date(Date.now() - 60_000).toISOString(),
      pairCode
    );

    const listAfterExpire = await wFetch('/api/mcp/pairings', {
      headers: { Authorization: `Bearer ${tok}` }
    });
    assert.equal(listAfterExpire.status, 200);
    assert.equal(listAfterExpire.body.mcpActive, false);
    assert.equal(listAfterExpire.body.needsRepair, true);
    assert.equal(listAfterExpire.body.repairReason, 'expired');

    const notifRes = await wFetch('/api/notifications', {
      headers: { Authorization: `Bearer ${tok}` }
    });
    assert.equal(notifRes.status, 200);
    const repairNotif = (notifRes.body.notifications || []).find(
      (n) => n.meta?.needsRepair === true && n.actionType === 'open_pair_mobile'
    );
    assert.ok(repairNotif, 'Expected Re-pair needed notification when pairing expires');
    assert.ok(repairNotif.title.toLowerCase().includes('re-pair'));
    assert.equal(repairNotif.actionLabel, 'Re-pair Now');
  });
});
