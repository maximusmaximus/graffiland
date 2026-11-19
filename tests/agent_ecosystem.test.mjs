import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ethers } from 'ethers';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-agent-eco-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'agent-eco.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
process.env.ROBINHOOD_ROYALTY_RECEIVER = '0x000000000000000000000000000000000000dEaD';

const { createAppServer } = await import('../server/index.mjs');
const { releaseExpiredDormantLands } = await import('../shared/agentQuestService.mjs');
const { encodeGeohash } = await import('../server/services/pol.mjs');

let server;
let baseUrl;
const agentWallet = ethers.Wallet.createRandom();
let agentToken = '';
let agentId = '';
let human1Token = '';
let human2Token = '';
let human3Token = '';
let buyerToken = '';
let dormantParcelId = '';
let questId = '';
let createdHumanSculptureId = '';
let createdStageSculptureId = '';

before(async () => {
  const { server: srv } = createAppServer({ publishRateLimit: 100, mcpRateLimit: 300 });
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Create human test accounts (artists + marketplace buyer)
  for (const [email, name, assign] of [
    ['human1@graffiland.test', 'Nova Brush', (t) => (human1Token = t)],
    ['human2@graffiland.test', 'Echo Spray', (t) => (human2Token = t)],
    ['spammer@graffiland.test', 'OneVoxelBot', (t) => (human3Token = t)],
    ['collector@graffiland.test', 'Collector Prime', (t) => (buyerToken = t)]
  ]) {
    const res = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email, name } })
    });
    const body = await res.json();
    assign(body.token);
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore Windows file lock
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

async function mcpCall(name, args = {}, token = agentToken) {
  return apiJson('/api/mcp', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 10000),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
}

function makePolPayload(lat, lng) {
  const now = Date.now();
  return {
    gpsSamples: [
      { lat, lng, t: now - 5000 },
      { lat: lat + 0.00001, lng: lng + 0.00001, t: now - 1000 }
    ],
    gyroSamples: 24,
    cameraFrames: 12,
    opticalFlowCorrelation: 0.9,
    horizonLuminance: 140,
    ambientPalette: ['#00f5d4', '#1a2b4c', '#ffd166'],
    visualDHash: 'f0e1d2c3b4a59687',
    cameraFacingMode: 'environment',
    cameraResolution: '3840x2160',
    sculptDurationMs: 12000,
    sceneCoveragePct: 100,
    scannedSectors: 10,
    placementPrecisionMeters: 0.12
  };
}

describe('GRAFFILAND Agentic-First Ecosystem, Quests & 5%/3%/2% Marketplace', () => {
  test('Public /api/config exposes 5%/3%/2% transaction fee breakdown and steward defaults', async () => {
    const res = await apiJson('/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.body.chain.resaleFeeBps, 500);
    assert.equal(res.body.feeBreakdown.platformBps, 500);
    assert.equal(res.body.feeBreakdown.agentStewardBps, 300);
    assert.equal(res.body.feeBreakdown.humanContributorBps, 200);
    assert.equal(res.body.feeBreakdown.totalBps, 1000);
    assert.equal(res.body.feeBreakdown.sellerNetBps, 9000);
    assert.equal(res.body.stewardDefaults.starterDormantSlots, 3);
    assert.equal(res.body.stewardDefaults.slotsPerAwakenedLand, 2);
    assert.equal(res.body.stewardDefaults.dormantLeaseTtlHours, 168);
    assert.equal(res.body.stewardDefaults.minHumanPoolVoxels, 3);
  });

  test('Autonomous AI agent authenticates via wallet EIP-191 challenge with zero OAuth', async () => {
    const chal = await apiJson('/api/agents/challenge', {
      method: 'POST',
      body: JSON.stringify({ walletAddress: agentWallet.address })
    });
    assert.equal(chal.status, 200);
    assert.ok(chal.body.nonce.startsWith('ag_'));
    assert.ok(chal.body.message.includes(agentWallet.address));

    const sig = await agentWallet.signMessage(chal.body.message);
    const reg = await apiJson('/api/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        walletAddress: agentWallet.address,
        nonce: chal.body.nonce,
        signature: sig,
        name: 'Archon Architect Bot',
        framework: 'openclaw',
        description: 'Builds cyber-plinth stages across San Francisco to attract street artists.'
      })
    });
    assert.equal(reg.status, 201);
    assert.ok(reg.body.token);
    assert.equal(reg.body.agent.maxSlots, 3);
    assert.equal(reg.body.agent.usedSlots, 0);
    assert.equal(reg.body.agent.availableSlots, 3);
    agentToken = reg.body.token;
    agentId = reg.body.agent.agentId;

    // Replay nonce is rejected
    const replay = await apiJson('/api/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        walletAddress: agentWallet.address,
        nonce: chal.body.nonce,
        signature: sig
      })
    });
    assert.equal(replay.status, 400);
  });

  test('Agent scouts free land, claims 3 dormant parcels, hits slot limit on 4th, and batch-builds stage + quest', async () => {
    const scoutRes = await mcpCall('scout_lands', {
      lat: 37.785,
      lng: -122.405,
      radiusMeters: 2000,
      statusFilter: 'unclaimed'
    });
    assert.equal(scoutRes.status, 200);
    const candidates = scoutRes.body.result.structuredContent.parcels;
    assert.ok(candidates.length >= 4);

    // Claim 3 free dormant parcels
    for (let i = 0; i < 3; i++) {
      const claimRes = await mcpCall('claim_land', {
        parcelId: candidates[i].parcelId,
        customName: `Archon Sector #${i + 1}`,
        curationNote: 'Free open plinths waiting for IRL painters.'
      });
      assert.equal(claimRes.status, 200);
      const out = claimRes.body.result.structuredContent;
      assert.equal(out.claimed, true);
      assert.equal(out.gasSponsored, true);
      assert.equal(out.status, 'dormant');
      assert.equal(out.slots.usedSlots, i + 1);
      if (i === 0) dormantParcelId = out.parcelId;
    }

    // 4th dormant claim hits 3-slot cap
    const fourth = await mcpCall('claim_land', { parcelId: candidates[3].parcelId });
    assert.equal(fourth.status, 429);

    // Batch-build procedural voxel plinth + deploy quest with 0.5 ETH bounty
    const buildRes = await mcpCall('batch_build_land', {
      parcelId: dormantParcelId,
      customName: 'Cyber Plinth Plaza',
      curationNote: 'Snap your sculpture onto our neon plinths for 2x First-Spark XP.',
      items: [
        {
          prefab: 'plinth',
          title: 'Neon Plinth pedestal',
          description: 'Glowing cyan and indigo stage awaiting IRL human voxel sculptures.',
          primaryColor: '#1b2845',
          accentColor: '#00f5d4',
          widthBlocks: 5,
          heightBlocks: 4,
          slotLabel: 'Main Center Plinth'
        },
        {
          prefab: 'arch',
          title: 'Steward Entry Arch',
          description: 'Dual pillar portal marking the awakened parcel threshold.',
          primaryColor: '#251a40',
          accentColor: '#ff3e7f',
          widthBlocks: 5,
          heightBlocks: 6,
          anchorOffset: { dx: 0, dy: 0, dz: -0.6, yaw: 0 }
        }
      ],
      quest: {
        title: 'First-Spark Neon Plinth Quest',
        prompt: 'Drop an original 3+ voxel sculpture onto our center plinth.',
        theme: 'cyberpunk',
        bountyEth: 0.5,
        maxCompletions: 5
      }
    });
    assert.equal(buildRes.status, 200);
    const batchOut = buildRes.body.result.structuredContent;
    assert.equal(batchOut.builtCount, 2);
    assert.equal(batchOut.sculptures[0].layerRole, 'steward_stage');
    createdStageSculptureId = batchOut.sculptures[0].id;
    questId = batchOut.quest.id;
    assert.equal(batchOut.quest.landStatus, 'dormant');
    assert.equal(batchOut.quest.firstSparkBoost, true);
    assert.ok(batchOut.quest.slotOffsets.length >= 1);

    // Public nearby quests feed highlights dormant awakening priority
    const qFeed = await apiJson('/api/quests/nearby?lat=37.785&lng=-122.405');
    assert.equal(qFeed.status, 200);
    const match = qFeed.body.quests.find((q) => q.id === questId);
    assert.ok(match);
    assert.equal(match.firstSparkBoost, true);
  });

  test('1-voxel anti-dilution gate denies awakening/pool; 3+ voxel IRL humans awaken parcel, unlock +2 agent slots, and share 2% pool', async () => {
    const telemetryBefore = await apiJson(`/api/lands/${dormantParcelId}/telemetry`);
    assert.equal(telemetryBefore.status, 200);
    const qData = telemetryBefore.body.quests[0];
    const pLat = qData.lat;
    const pLng = qData.lng;

    // 1) 1-voxel spam fails quality gate -> dormant parcel stays dormant, does NOT unlock slots or join pool
    const spamRes = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${human3Token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'Tiny 1-Voxel Dot',
        description: 'Trying to dilute the contributor royalty pool with one block.',
        termsAccepted: true,
        questId,
        voxels: [{ x: 0, y: 0, z: 0, color: '#ffffff', material: 'matte', scale: 1 }],
        location: { lat: pLat, lng: pLng, accuracy: 6, altitude: 10 },
        proofOfLocation: makePolPayload(pLat, pLng),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(spamRes.status, 201);
    assert.equal(spamRes.body.awakening.awakenedParcel, false);
    assert.equal(spamRes.body.awakening.qualifiesForContributorPool, false);

    // 2) First genuine human (4 voxels) awakens dormant parcel, unlocks +2 agent slots, claims plinth slot, earns 500 XP
    const h1Res = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${human1Token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'Solar Phoenix Crest',
        description: 'Multi-layered neon crest snapped onto the steward plinth pedestal.',
        termsAccepted: true,
        questId,
        plinthSlotId: qData.slotOffsets[0].id,
        anchorOffset: {
          dx: qData.slotOffsets[0].dx,
          dy: qData.slotOffsets[0].dy,
          dz: qData.slotOffsets[0].dz,
          yaw: 0
        },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#ff3e7f', material: 'neon', scale: 1 },
          { x: 0.05, y: 0.05, z: 0, color: '#ffd166', material: 'neon', scale: 1 },
          { x: -0.05, y: 0.05, z: 0, color: '#00f5d4', material: 'glass', scale: 1 },
          { x: 0, y: 0.1, z: 0, color: '#ff3e7f', material: 'neon', scale: 1 }
        ],
        location: { lat: pLat, lng: pLng, accuracy: 6, altitude: 12 },
        proofOfLocation: makePolPayload(pLat, pLng),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(h1Res.status, 201);
    assert.equal(h1Res.body.sculpture.layerRole, 'artist_work');
    assert.equal(h1Res.body.awakening.awakenedParcel, true);
    assert.equal(h1Res.body.awakening.qualifiesForContributorPool, true);
    assert.equal(h1Res.body.awakening.slotsUnlockedForAgent, 2);
    assert.equal(h1Res.body.awakening.xpAwarded, 300);
    assert.equal(h1Res.body.awakening.questCompleted.plinthSlotClaimed, qData.slotOffsets[0].id);
    createdHumanSculptureId = h1Res.body.sculpture.id;

    // 3) Second genuine human (3 voxels) also joins the parcel's 2% contributor pool
    const h2Res = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${human2Token}`,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile'
      },
      body: JSON.stringify({
        title: 'Holo Wave Ribbons',
        description: 'Flowing cerulean ribbons celebrating co-creation on cyber plaza.',
        termsAccepted: true,
        questId,
        voxels: [
          { x: 0.2, y: 0, z: 0.2, color: '#00f5d4', material: 'neon', scale: 1 },
          { x: 0.2, y: 0.05, z: 0.2, color: '#00bbff', material: 'glass', scale: 1 },
          { x: 0.2, y: 0.1, z: 0.2, color: '#ffffff', material: 'neon', scale: 1 }
        ],
        location: { lat: pLat, lng: pLng, accuracy: 7, altitude: 12 },
        proofOfLocation: makePolPayload(pLat, pLng),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(h2Res.status, 201);
    assert.equal(h2Res.body.awakening.awakenedParcel, false);
    assert.equal(h2Res.body.awakening.qualifiesForContributorPool, true);
    assert.equal(h2Res.body.awakening.humanContributorCount, 2);

    // Check agent profile: maxSlots jumped from 3 -> 5 and usedSlots dropped from 3 -> 2
    const agentMe = await apiJson('/api/agents/me', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.equal(agentMe.status, 200);
    assert.equal(agentMe.body.maxSlots, 5);
    assert.equal(agentMe.body.usedSlots, 2);
    assert.equal(agentMe.body.availableSlots, 3);
    assert.equal(agentMe.body.activatedLandsCount, 1);

    // Agent steward CANNOT mutate/overwrite human artist's artwork via MCP (layer isolation)
    const illegalEdit = await mcpCall('update_land_sculpture', {
      sculptureId: createdHumanSculptureId,
      title: 'Overwritten By Bot'
    });
    assert.equal(illegalEdit.status, 403);
  });

  test('Marketplace purchase strictly distributes 5% Platform + 3% Agent Steward + 2% Pro-Rata Human Pool + 90% Seller', async () => {
    // Steward lists their Neon Plinth sculpture for 1.0 ETH
    const listRes = await apiJson('/api/marketplace/listings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ sculptureId: createdStageSculptureId, priceEth: 1.0 })
    });
    assert.equal(listRes.status, 201);
    const listing = listRes.body.listing;
    assert.equal(listing.splits.platform.bps, 500);
    assert.equal(listing.splits.agentSteward.bps, 300);
    assert.equal(listing.splits.humanContributors.bps, 200);
    assert.equal(listing.splits.seller.bps, 9000);
    assert.equal(listing.splits.humanContributors.contributorCount, 2);

    // Collector buys the listed sculpture
    const buyRes = await apiJson(`/api/marketplace/listings/${listing.id}/buy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buyerToken}` },
      body: JSON.stringify({})
    });
    assert.equal(buyRes.status, 200);
    const { splits } = buyRes.body;
    assert.equal(splits.platform.amountEth, 0.05);
    assert.equal(splits.agentSteward.amountEth, 0.03);
    assert.equal(splits.humanContributors.poolEth, 0.02);
    assert.equal(splits.seller.amountEth, 0.9);
    assert.equal(splits.humanContributors.perContributor.length, 2);
    assert.equal(splits.humanContributors.perContributor[0].amountEth, 0.01);
    assert.equal(splits.humanContributors.perContributor[1].amountEth, 0.01);

    // Dual leaderboard & economy ledger reflect payouts
    const lbRes = await apiJson('/api/agents/leaderboard');
    assert.equal(lbRes.status, 200);
    const stewardRank = lbRes.body.aiStewards.find((a) => a.agentId === agentId);
    assert.ok(stewardRank);
    assert.ok(stewardRank.totalXp >= 150);
    assert.ok(stewardRank.earnedRoyaltiesEth >= 0.03);
    assert.ok(lbRes.body.humanArtists.length >= 2);

    const econRes = await apiJson(`/api/economy/splits?parcel=${dormantParcelId}`);
    assert.equal(econRes.status, 200);
    assert.ok(econRes.body.totalsByRole.platform.totalEth >= 0.05);
    assert.ok(econRes.body.totalsByRole.agentSteward.totalEth >= 0.03);
    assert.ok(econRes.body.totalsByRole.humanContributors.totalEth >= 0.02);
  });

  test('Dormant 7-day lease reaper recycles unawakened leases while sparing awakened lands', async () => {
    // Pick an unclaimed coordinate for an empty dormant claim by our agent
    const lat = 37.7999;
    const lng = -122.4299;
    const gh = encodeGeohash(lat, lng, 8);
    const expireParcelId = `GLAND-${gh.toUpperCase()}`;

    const claimRes = await mcpCall('claim_land', { parcelId: expireParcelId, customName: 'Temp Lease' });
    assert.equal(claimRes.status, 200);

    // Verify 3 slots used before expiry check (2 remaining dormant + 1 awakened -> 3 dormant after claiming 3rd)
    const sqlite = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    sqlite
      .prepare('UPDATE land_steward_state SET lease_expires_at = ? WHERE parcel_id = ?')
      .run('2020-01-01T00:00:00.000Z', expireParcelId);
    sqlite.close();

    const rawDb = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    const dbAdapter = {
      get: async (sql, p = []) => rawDb.prepare(sql).get(...p),
      all: async (sql, p = []) => rawDb.prepare(sql).all(...p),
      run: async (sql, p = []) => rawDb.prepare(sql).run(...p)
    };
    const reaperRes = await releaseExpiredDormantLands(dbAdapter);
    rawDb.close();
    assert.ok(reaperRes.releasedCount >= 1);

    // Expired parcel shows back up as claimable unclaimed land in scout!
    const scoutAfter = await mcpCall('scout_lands', { lat, lng, radiusMeters: 500, statusFilter: 'unclaimed' });
    assert.equal(scoutAfter.status, 200);
    const reclaimedCandidate = scoutAfter.body.result.structuredContent.parcels.find(
      (p) => p.parcelId === expireParcelId
    );
    assert.ok(reclaimedCandidate);
    assert.equal(reclaimedCandidate.claimableFree, true);
  });
});
