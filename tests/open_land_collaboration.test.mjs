import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-open-collab-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');

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

function makeSimpleVoxels(offsetX = 0) {
  return [
    { x: offsetX, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
    { x: offsetX + 1, y: 0, z: 0, color: '#ff3e7f', material: 'matte' },
    { x: offsetX, y: 1, z: 0, color: '#ffd166', material: 'glass' }
  ];
}

describe('Open Land Collaboration, Per-Land Require Approval & Artist NFT Ownership', () => {
  test('Default open lands let guests & their MCP agents add art (mints to artist, notifies land holder, preserves land ownership) and Require Approval routes to land holder approval queue', async () => {
    // 1) Owner (@muffkor) signs in & claims "alone in the woods"
    const ownerAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'muffkor@graffiland.test', name: 'David Elvion' }
      })
    });
    assert.equal(ownerAuth.status, 200);
    const ownerToken = ownerAuth.body.token;
    const ownerWallet = ownerAuth.body.user.walletAddress;
    await apiJson('/api/profile', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ username: 'muffkor' })
    });

    const claim = await apiJson('/api/lands/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        lat: 39.7285,
        lng: -121.8375,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 18,
        customName: 'alone in the woods',
        description: 'Open forest plot for collaborative 3D mushrooms'
      })
    });
    assert.equal(claim.status, 201);
    const parcelId = claim.body.parcelId || claim.body.parcel?.parcelId;
    assert.ok(parcelId);

    // 2) Guest artist (@bigdog) signs in & pairs an MCP agent
    const artistAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'bigdog@graffiland.test', name: 'Big Dog' }
      })
    });
    assert.equal(artistAuth.status, 200);
    const artistToken = artistAuth.body.token;
    const artistWallet = artistAuth.body.user.walletAddress;
    await apiJson('/api/profile', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({ username: 'bigdog' })
    });

    const pairCreate = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({})
    });
    assert.equal(pairCreate.status, 200);
    const artistPairingCode = pairCreate.body.pairing.code;
    await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({
        pairingCode: artistPairingCode,
        agentName: 'land-builder-agent'
      })
    });

    // 3) Agent inspects @muffkor's land -> default requireApproval is FALSE, canPlaceDirectly is TRUE
    const getLandRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': artistPairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_land', arguments: { parcelId } }
      })
    });
    assert.equal(getLandRes.status, 200);
    const landInfo = getLandRes.body.result.structuredContent;
    assert.equal(landInfo.settings.requireApproval, false);
    assert.equal(landInfo.permissions.isOwner, false);
    assert.equal(landInfo.permissions.canPlaceDirectly, true);
    assert.equal(landInfo.permissions.requiresOwnerApproval, false);

    // 4) Default open land: @bigdog's MCP agent places "Ghost Mushroom Nursery" -> queues for @bigdog, mints to @bigdog!
    const openPlaceRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': artistPairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'put_sculpture_on_land',
          arguments: {
            parcelId,
            title: 'Ghost Mushroom Nursery',
            description: 'Bioluminescent mushrooms placed on open community land',
            voxels: makeSimpleVoxels(0),
            anchorOffset: { dx: -3, dy: 0, dz: 0, yaw: 0 }
          }
        }
      })
    });
    assert.equal(openPlaceRes.status, 200);
    const openPlaceData = openPlaceRes.body.result.structuredContent;
    assert.equal(openPlaceData.status, 'pending_mobile_signature');
    const openReqId = openPlaceData.request.id;

    // @bigdog signs their own agent's open-land placement
    const artistSignRes = await apiJson(
      `/api/signatures/requests/${encodeURIComponent(openReqId)}/mobile-sign`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${artistToken}` },
        body: JSON.stringify({})
      }
    );
    assert.equal(artistSignRes.status, 200);
    const mintedOpenSc = artistSignRes.body.result.sculpture;
    assert.equal(mintedOpenSc.title, 'Ghost Mushroom Nursery');
    assert.equal(
      mintedOpenSc.recipientAddress.toLowerCase(),
      artistWallet.toLowerCase(),
      'Artist (@bigdog) must receive NFT ownership on open land placement'
    );

    // @muffkor (land holder) is notified automatically!
    const ownerNotifs1 = await apiJson('/api/notifications', {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.ok(
      ownerNotifs1.body.notifications.some(
        (n) => n.category === 'sculpture_on_land' && n.title.includes('Ghost Mushroom Nursery')
      ),
      'Land holder must be notified when a guest adds art to their open land'
    );

    // Security check: @bigdog MUST NOT gain land ownership over @muffkor's land!
    const bigdogRenameAttempt = await apiJson(`/api/lands/${parcelId}/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({ customName: 'Hijacked Woods' })
    });
    assert.equal(bigdogRenameAttempt.status, 403, 'Guest artist must NOT be able to rename land');

    const bigdogMyLands = await apiJson('/api/lands/mine', {
      headers: { Authorization: `Bearer ${artistToken}` }
    });
    assert.equal(
      bigdogMyLands.body.parcels.some((p) => p.parcelId === parcelId),
      false,
      'Another holder land must NOT appear in guest artist My Lands'
    );

    // 5) Owner (@muffkor) turns ON "Require Approval" in Land Settings
    const toggleReqRes = await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ requireApproval: true })
    });
    assert.equal(toggleReqRes.status, 200);
    assert.equal(toggleReqRes.body.settings.requireApproval, true);

    // 6) Now when @bigdog's agent submits a second piece -> routes to @muffkor's approval queue!
    const gatedPlaceRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': artistPairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'put_sculpture_on_land',
          arguments: {
            parcelId,
            title: 'Lantern Fairy Ring',
            description: 'Glowing forest lanterns proposed for owner approval',
            voxels: makeSimpleVoxels(0),
            anchorOffset: { dx: 4, dy: 0, dz: 3, yaw: 0 }
          }
        }
      })
    });
    assert.equal(gatedPlaceRes.status, 200);
    const gatedData = gatedPlaceRes.body.result.structuredContent;
    assert.equal(gatedData.status, 'pending_owner_approval');
    assert.equal(gatedData.requiresOwnerApproval, true);
    const proposalId = gatedData.request.id;

    // @bigdog CANNOT self-approve a guest proposal addressed to @muffkor
    const selfApproveAttempt = await apiJson(
      `/api/signatures/requests/${encodeURIComponent(proposalId)}/mobile-sign`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${artistToken}` },
        body: JSON.stringify({})
      }
    );
    assert.equal(selfApproveAttempt.status, 403);

    // @muffkor sees the pending proposal & receives an actionable approval notification
    const ownerPending = await apiJson('/api/signatures/pending', {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const matchedProposal = ownerPending.body.requests.find((r) => r.id === proposalId);
    assert.ok(matchedProposal, 'Expected proposal in land holder pending approvals');
    assert.match(matchedProposal.summaryTitle, /Lantern Fairy Ring/);
    assert.match(matchedProposal.summaryTitle, /@bigdog/);
    assert.match(matchedProposal.summaryDescription, /NFT mints to artist/i);

    const ownerNotifs2 = await apiJson('/api/notifications', {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.ok(
      ownerNotifs2.body.notifications.some(
        (n) => n.actionType === 'open_land_approval' && n.meta?.requestId === proposalId
      ),
      'Land holder must receive an actionable approval notification'
    );

    // @muffkor approves -> NFT mints to @bigdog (artist!), NOT @muffkor, and @bigdog gets notified!
    const ownerApproveRes = await apiJson(
      `/api/signatures/requests/${encodeURIComponent(proposalId)}/mobile-sign`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({})
      }
    );
    assert.equal(ownerApproveRes.status, 200);
    const approvedSc = ownerApproveRes.body.result.sculpture;
    assert.equal(approvedSc.title, 'Lantern Fairy Ring');
    assert.equal(
      approvedSc.recipientAddress.toLowerCase(),
      artistWallet.toLowerCase(),
      'Approved guest proposal MUST mint NFT to proposing artist (@bigdog)'
    );
    assert.notEqual(approvedSc.recipientAddress.toLowerCase(), ownerWallet.toLowerCase());

    const artistNotifs = await apiJson('/api/notifications', {
      headers: { Authorization: `Bearer ${artistToken}` }
    });
    assert.ok(
      artistNotifs.body.notifications.some(
        (n) => n.meta?.requestId === proposalId && n.meta?.approvedAndMinted === true
      ),
      'Proposing artist must be notified when land holder approves & mints their proposal'
    );

    // 7) Freezing the land still blocks all guest placements (403)
    await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ frozen: true })
    });
    const frozenRes = await apiJson(`/api/lands/${parcelId}/sculptures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({
        title: 'Blocked Ice Block',
        description: 'Should be rejected while land is frozen',
        voxels: makeSimpleVoxels(0)
      })
    });
    assert.equal(frozenRes.status, 403);
  });
});
