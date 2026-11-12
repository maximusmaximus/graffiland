import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-test-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');

const { compileContract } = await import('../contracts/compile.mjs');
const { createAppServer } = await import('../server/index.mjs');

let server;
let baseUrl;
let wsUrl;
let artistToken;
let adminToken;
let createdSculptureId;
let createdParcelId;

before(async () => {
  const { server: srv } = createAppServer();
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore Windows file lock cleanup if SQLite handle lingers until exit
  }
});

async function apiJson(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('GRAFFILAND Full-Stack Verification', () => {
  test('Smart contract compiles with ERC-2981 5% resale fee (500 bps)', () => {
    const artifact = compileContract();
    assert.equal(artifact.contractName, 'GraffilandNFT');
    const feeFn = artifact.abi.find((item) => item.name === 'RESALE_FEE_BPS');
    assert.ok(feeFn, 'RESALE_FEE_BPS constant present in ABI');
    const mintFn = artifact.abi.find((item) => item.name === 'mintSculpture');
    assert.ok(mintFn, 'mintSculpture function present in ABI');
    const royaltyFn = artifact.abi.find((item) => item.name === 'royaltyInfo');
    assert.ok(royaltyFn, 'ERC-2981 royaltyInfo function present in ABI');
  });

  test('Public config exposes Robinhood Chain, 5% royalty, and Limited Terms policy', async () => {
    const { status, body } = await apiJson('/api/config');
    assert.equal(status, 200);
    assert.equal(body.chain.resaleFeeBps, 500);
    assert.equal(body.chain.resaleFeePercent, 5);
    assert.equal(body.chain.network.chainId, 46630);
    assert.equal(body.policy.titleMax, 48);
    assert.equal(body.policy.descriptionMax, 240);
  });

  test('Google login creates embedded wallet & rejects non-Google unauthenticated publish', async () => {
    const unauth = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      body: JSON.stringify({})
    });
    assert.equal(unauth.status, 401);

    const artistLogin = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'test-artist@graffiland.local', name: 'Test Artist' }
      })
    });
    assert.equal(artistLogin.status, 200);
    assert.ok(artistLogin.body.token);
    assert.match(artistLogin.body.user.walletAddress, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(artistLogin.body.user.isAdmin, false);
    artistToken = artistLogin.body.token;

    const adminLogin = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'admin@graffiland.local', name: 'Admin' }
      })
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.user.isAdmin, true);
    adminToken = adminLogin.body.token;
  });

  test('Publish enforces mobile device requirement & Limited Terms validation', async () => {
    const desktopAttempt = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({
        title: 'Desktop Test',
        description: 'Attempting to publish from desktop browser should fail.',
        termsAccepted: true,
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' }],
        location: { lat: 37.7749, lng: -122.4194 },
        deviceProfile: { isMobile: false }
      })
    });
    assert.equal(desktopAttempt.status, 403);

    const badTerms = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({
        title: 'Spam Link Sculpture',
        description: 'Visit https://scam.example.com for free airdrop!',
        termsAccepted: true,
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' }],
        location: { lat: 37.7749, lng: -122.4194 },
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(badTerms.status, 400);
  });

  test('Mobile publish verifies Proof of Location, pins IPFS metadata, mints 5% royalty NFT, and claims Virtual Land', async () => {
    const now = Date.now();
    const res = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${artistToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'Neon Pier Totem',
        description: 'Stacked glowing voxels sculpted live facing the bay wind.',
        termsAccepted: true,
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon', scale: 1 },
          { x: 0, y: 0.2, z: 0, color: '#ff3e7f', material: 'matte', scale: 1 },
          { x: 0.2, y: 0.2, z: 0, color: '#ffd166', material: 'glass', scale: 1 }
        ],
        location: {
          lat: 37.808,
          lng: -122.4177,
          accuracy: 8.5,
          altitude: 12,
          heading: 42,
          timezone: 'America/Los_Angeles'
        },
        proofOfLocation: {
          gpsSamples: [
            { lat: 37.808, lng: -122.4177, t: now - 5000 },
            { lat: 37.80801, lng: -122.41771, t: now - 1000 }
          ],
          gyroSamples: 24,
          cameraFrames: 12,
          opticalFlowCorrelation: 0.91,
          horizonLuminance: 145,
          ambientPalette: ['#00f5d4', '#1a2b4c', '#ffd166'],
          visualDHash: 'f0e1d2c3b4a59687',
          cameraFacingMode: 'environment',
          cameraResolution: '1280x720',
          sculptDurationMs: 14200
        },
        deviceProfile: { isMobile: true }
      })
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.sculpture.id);
    assert.ok(res.body.sculpture.parcelId.startsWith('GLAND-'));
    assert.ok(res.body.sculpture.polScore >= 75);
    assert.equal(res.body.sculpture.chain.royaltyBps, 500);
    assert.equal(res.body.ipfs.metadata.royalty.resale_fee_bps, 500);
    assert.equal(res.body.ipfs.metadata.location.latitude, 37.808);
    createdSculptureId = res.body.sculpture.id;
    createdParcelId = res.body.sculpture.parcelId;

    // Verify local IPFS CID endpoint resolves valid JSON metadata
    const ipfsRes = await fetch(`${baseUrl}${res.body.ipfs.gatewayUrl}`);
    assert.equal(ipfsRes.status, 200);
    const ipfsJson = await ipfsRes.json();
    assert.equal(ipfsJson.name, 'Neon Pier Totem');
    assert.equal(ipfsJson.seller_fee_basis_points, 500);

    // Verify AR Preview proximity search finds it
    const nearby = await apiJson('/api/sculptures?lat=37.80805&lng=-122.41775&radiusMeters=100');
    assert.equal(nearby.status, 200);
    assert.ok(nearby.body.sculptures.some((s) => s.id === createdSculptureId));

    // Verify Virtual Land parcel list includes it
    const parcels = await apiJson('/api/parcels');
    assert.equal(parcels.status, 200);
    assert.ok(parcels.body.parcels.some((p) => p.parcelId === createdParcelId));
  });

  test('Admin panel can hide and unhide sculptures from public feeds', async () => {
    const nonAdmin = await apiJson('/api/admin/sculptures', {
      headers: { Authorization: `Bearer ${artistToken}` }
    });
    assert.equal(nonAdmin.status, 403);

    const hideRes = await apiJson(`/api/admin/sculptures/${createdSculptureId}/visibility`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ hidden: true, reason: 'QA test hide' })
    });
    assert.equal(hideRes.status, 200);
    assert.equal(hideRes.body.sculpture.hidden, true);

    const publicAfterHide = await apiJson('/api/sculptures');
    assert.equal(
      publicAfterHide.body.sculptures.some((s) => s.id === createdSculptureId),
      false
    );

    const adminList = await apiJson('/api/admin/sculptures', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(adminList.status, 200);
    assert.ok(adminList.body.sculptures.some((s) => s.id === createdSculptureId && s.hidden));

    const unhideRes = await apiJson(`/api/admin/sculptures/${createdSculptureId}/visibility`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ hidden: false })
    });
    assert.equal(unhideRes.status, 200);
    assert.equal(unhideRes.body.sculpture.hidden, false);
  });

  test('WebSocket pairing relays live 3D brush & voxel streams between desktop and mobile', async () => {
    const desktopWs = new WebSocket(wsUrl);
    await new Promise((r) => desktopWs.once('open', r));

    const desktopMsgQueue = [];
    desktopWs.on('message', (d) => desktopMsgQueue.push(JSON.parse(d.toString())));

    desktopWs.send(JSON.stringify({ type: 'create_pair' }));
    await new Promise((r) => setTimeout(r, 50));
    const created = desktopMsgQueue.find((m) => m.type === 'pair_created');
    assert.ok(created?.code);

    const mobileWs = new WebSocket(wsUrl);
    await new Promise((r) => mobileWs.once('open', r));
    const mobileMsgQueue = [];
    mobileWs.on('message', (d) => mobileMsgQueue.push(JSON.parse(d.toString())));

    mobileWs.send(JSON.stringify({ type: 'join_pair', code: created.code }));
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(desktopMsgQueue.some((m) => m.type === 'pair_connected'));
    assert.ok(mobileMsgQueue.some((m) => m.type === 'pair_connected'));

    mobileWs.send(
      JSON.stringify({
        type: 'voxels_sync',
        voxels: [{ x: 0.2, y: 0.4, z: -1.0, color: '#00f5d4', material: 'neon' }]
      })
    );
    desktopWs.send(JSON.stringify({ type: 'desktop_command', action: 'set_color', color: '#ff3e7f' }));
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(desktopMsgQueue.some((m) => m.type === 'voxels_sync' && m.voxels.length === 1));
    assert.ok(mobileMsgQueue.some((m) => m.type === 'desktop_command' && m.color === '#ff3e7f'));

    desktopWs.close();
    mobileWs.close();
  });
});
