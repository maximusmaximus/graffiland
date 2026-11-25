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

describe('SPRAY.LAND Agentic-First Ecosystem, Quests & 5%/3%/2% Marketplace', () => {
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
    assert.equal(res.body.stewardDefaults.dormantLeaseTtlHours, 72);
    assert.equal(res.body.stewardDefaults.inactivityArchiveDays, 28);
    assert.equal(res.body.stewardDefaults.expiryWarningHours, 3);
    assert.equal(res.body.stewardDefaults.freeSlotsReopenWithoutHumans, false);
    assert.equal(res.body.stewardDefaults.minHumanPoolVoxels, 3);
    assert.ok(Array.isArray(res.body.policy.inPersonHumanInteractions));
    assert.ok(res.body.policy.inPersonHumanInteractions.length >= 4);
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
      assert.equal(out.gasSponsored, false);
      assert.equal(out.gasPaidBy, 'agent');
      assert.equal(out.protocolFeeEth, 0);
      assert.equal(out.chainTxRequest?.method, 'claimDormantLand');
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
    assert.equal(batchOut.gasSponsored, false);
    assert.equal(batchOut.gasPaidBy, 'agent');
    assert.ok(Array.isArray(batchOut.chainTxRequests) && batchOut.chainTxRequests.length >= 1);
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

  test('72-hour agent reclaim archives & destroys unvisited land (even with agent 3D models) and NEVER reopens free slot', async () => {
    const profileBefore = await apiJson('/api/agents/me', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.equal(profileBefore.status, 200);
    const usedBefore = profileBefore.body.usedSlots;
    const availBefore = profileBefore.body.availableSlots;

    // Pick an unclaimed coordinate for an agent claim + place a 3D voxel stage on it (zero human visitors)
    const lat = 37.7999;
    const lng = -122.4299;
    const gh = encodeGeohash(lat, lng, 8);
    const expireParcelId = `GLAND-${gh.toUpperCase()}`;

    const claimRes = await mcpCall('claim_land', { parcelId: expireParcelId, customName: 'Temp 72h Lease' });
    assert.equal(claimRes.status, 200);
    const claimOut = claimRes.body.result.structuredContent;
    const leaseDeltaHours =
      (Date.parse(claimOut.leaseExpiresAt) - Date.now()) / (60 * 60 * 1000);
    assert.ok(
      leaseDeltaHours > 71 && leaseDeltaHours <= 72.1,
      `Expected ~72h initial agent lease, got ${leaseDeltaHours.toFixed(2)}h`
    );

    // Agent places a 3D model/stage on the land — must STILL expire & archive without a human visitor!
    const stageRes = await mcpCall('batch_build_land', {
      parcelId: expireParcelId,
      items: [
        {
          prefab: 'beacon',
          title: 'Agent Unvisited Beacon',
          description: 'Stage placed by AI agent without any human in-person visit.'
        }
      ]
    });
    assert.equal(stageRes.status, 200);

    // 1) Test 3-hour pre-expiry warning notification (set lease_expires_at to now + 2h)
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const sqlite = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    sqlite
      .prepare('UPDATE land_steward_state SET lease_expires_at = ? WHERE parcel_id = ?')
      .run(twoHoursFromNow, expireParcelId);
    sqlite.close();

    const notifWarn = await apiJson('/api/notifications', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.equal(notifWarn.status, 200);
    const expiryAlert = (notifWarn.body.notifications || []).find(
      (n) => n.category === 'land_expiring' && n.parcelId === expireParcelId
    );
    assert.ok(expiryAlert, 'Owner must receive a notification within 3 hours before land expiry');
    assert.ok(expiryAlert.title.includes('72h limit'));

    // 2) Now expire the 72-hour window and run reaper
    const sqlite2 = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    sqlite2
      .prepare('UPDATE land_steward_state SET lease_expires_at = ? WHERE parcel_id = ?')
      .run('2020-01-01T00:00:00.000Z', expireParcelId);
    sqlite2.close();

    const rawDb = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    const dbAdapter = {
      get: async (sql, p = []) => rawDb.prepare(sql).get(...p),
      all: async (sql, p = []) => rawDb.prepare(sql).all(...p),
      run: async (sql, p = []) => rawDb.prepare(sql).run(...p)
    };
    const reaperRes = await releaseExpiredDormantLands(dbAdapter);
    rawDb.close();
    assert.ok(reaperRes.releasedCount >= 1);
    assert.ok(reaperRes.agent72hCount >= 1);

    // 3) Reclaimed parcel shows back up as claimable unclaimed land in scout
    const scoutAfter = await mcpCall('scout_lands', { lat, lng, radiusMeters: 500, statusFilter: 'unclaimed' });
    assert.equal(scoutAfter.status, 200);
    const reclaimedCandidate = scoutAfter.body.result.structuredContent.parcels.find(
      (p) => p.parcelId === expireParcelId
    );
    assert.ok(reclaimedCandidate);
    assert.equal(reclaimedCandidate.claimableFree, true);

    // 4) Archived permanently in GET /api/archive with the agent's 3D stage snapshot preserved!
    const archRes = await apiJson('/api/archive?reason=agent_72h_no_human_interaction');
    assert.equal(archRes.status, 200);
    const archRecord = (archRes.body.archives || []).find((a) => a.parcelId === expireParcelId);
    assert.ok(archRecord, 'Expired agent land must be preserved in Land Archive');
    assert.equal(archRecord.archiveReason, 'agent_72h_no_human_interaction');
    assert.equal(archRecord.hadHumanInteraction, false);
    assert.equal(archRecord.freeSlotForfeited, true);
    assert.equal(archRecord.sculptureCount, 1);
    assert.equal(archRecord.sculpturesSnapshot[0].title, 'Agent Unvisited Beacon');

    // Archive detail endpoint & MCP tool work
    const archDetail = await apiJson(`/api/archive/${archRecord.id}`);
    assert.equal(archDetail.status, 200);
    assert.equal(archDetail.body.archive.id, archRecord.id);

    const mcpArch = await mcpCall('list_archived_lands', { q: 'Temp 72h Lease' });
    assert.equal(mcpArch.status, 200);
    assert.ok(
      mcpArch.body.result.structuredContent.archives.some((a) => a.id === archRecord.id)
    );

    // 5) Free mint slot did NOT open back up because no human visited in person!
    const profileAfter = await apiJson('/api/agents/me', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.equal(profileAfter.status, 200);
    assert.equal(profileAfter.body.forfeitedSlots, 1);
    assert.equal(profileAfter.body.usedSlots, usedBefore + 1);
    assert.equal(profileAfter.body.availableSlots, availBefore - 1);
  });

  test('In-person Mobile AR Check-In awakens agent land (blocks agents/desktop/remote), and 28-day inactivity archives & destroys', async () => {
    const lat = 37.8015;
    const lng = -122.4315;
    const gh = encodeGeohash(lat, lng, 8);
    const checkInParcelId = `GLAND-${gh.toUpperCase()}`;

    const claimRes = await mcpCall('claim_land', {
      parcelId: checkInParcelId,
      customName: 'Check-In Plaza'
    });
    assert.equal(claimRes.status, 200);

    // Agent cannot check in as a human visitor
    const agentCheckIn = await apiJson(`/api/lands/${checkInParcelId}/checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        location: { lat, lng },
        proofOfLocation: makePolPayload(lat, lng),
        deviceProfile: { isMobile: true, hasCamera: true }
      })
    });
    assert.equal(agentCheckIn.status, 403);

    // Remote human (far away) is blocked
    const farCheckIn = await apiJson(`/api/lands/${checkInParcelId}/checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${human1Token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        location: { lat: lat + 0.02, lng: lng + 0.02 },
        proofOfLocation: makePolPayload(lat + 0.02, lng + 0.02),
        deviceProfile: { isMobile: true, hasCamera: true }
      })
    });
    assert.equal(farCheckIn.status, 403);

    // Real mobile human standing at the land succeeds -> awakens land & sets 28-day window!
    const okCheckIn = await apiJson(`/api/lands/${checkInParcelId}/checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${human1Token}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        location: { lat, lng },
        proofOfLocation: makePolPayload(lat, lng),
        deviceProfile: { isMobile: true, hasCamera: true }
      })
    });
    assert.equal(okCheckIn.status, 200);
    assert.equal(okCheckIn.body.checkedIn, true);
    assert.equal(okCheckIn.body.awakenedNow, true);
    const inactivityDays =
      (Date.parse(okCheckIn.body.inactivityExpiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(inactivityDays > 27.9 && inactivityDays <= 28.1);

    // 3-hour pre-expiry warning works for 28-day human inactivity too
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const s1 = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    s1.prepare('UPDATE land_steward_state SET inactivity_expires_at = ? WHERE parcel_id = ?').run(
      inTwoHours,
      checkInParcelId
    );
    s1.close();

    const warn28 = await apiJson('/api/notifications', {
      headers: { Authorization: `Bearer ${agentToken}` }
    });
    assert.equal(warn28.status, 200);
    assert.ok(
      (warn28.body.notifications || []).some(
        (n) =>
          n.category === 'land_expiring' &&
          n.parcelId === checkInParcelId &&
          n.title.includes('28-day inactivity')
      ),
      'Owner must receive a 3-hour warning notification before 28-day inactivity archive'
    );

    // Passing 28 days archives & destroys the inactive land
    const s2 = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    s2.prepare('UPDATE land_steward_state SET inactivity_expires_at = ? WHERE parcel_id = ?').run(
      '2020-01-01T00:00:00.000Z',
      checkInParcelId
    );
    s2.close();

    const arch28Res = await apiJson('/api/archive?reason=inactivity_28d_no_human_interaction');
    assert.equal(arch28Res.status, 200);
    const rec28 = (arch28Res.body.archives || []).find((a) => a.parcelId === checkInParcelId);
    assert.ok(rec28, '28-day inactive land must be archived & destroyed');
    assert.equal(rec28.archiveReason, 'inactivity_28d_no_human_interaction');
    assert.equal(rec28.hadHumanInteraction, true);
  });

  test('Human art-minted land has NO expiry timer (permanent); map-created-first land starts with 28d timer until human adds AR art to own permanently', async () => {
    const loginArtHuman = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'art-pioneer@graffiland.test', name: 'Art Pioneer' }
      })
    });
    assert.equal(loginArtHuman.status, 200);
    const artHumanToken = loginArtHuman.body.token;

    const loginMapHuman = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'map-pioneer@graffiland.test', name: 'Map Pioneer' }
      })
    });
    assert.equal(loginMapHuman.status, 200);
    const mapHumanToken = loginMapHuman.body.token;

    // 1) Human manually draws art in Mobile AR on an unclaimed spot -> permanent land, ZERO timer!
    const artLat = 37.8125;
    const artLng = -122.4425;
    const artPublish = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${artHumanToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'Human Hand Drawn Totem',
        description: 'Manually drawn outdoors on Mobile AR to mint permanent land.',
        termsAccepted: true,
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'neon' },
          { x: 0, y: 0.1, z: 0, color: '#ffd166', material: 'neon' }
        ],
        location: { lat: artLat, lng: artLng, accuracy: 5, altitude: 10 },
        proofOfLocation: makePolPayload(artLat, artLng),
        deviceProfile: { isMobile: true, hasCamera: true }
      })
    });
    assert.equal(artPublish.status, 201, JSON.stringify(artPublish.body));
    const artParcelId = artPublish.body.sculpture.parcelId;

    const artLandsRes = await apiJson('/api/lands');
    const artLand = (artLandsRes.body.parcels || []).find((p) => p.parcelId === artParcelId);
    assert.ok(artLand, 'Art-minted land must appear in /api/lands');
    assert.equal(artLand.stewardStatus, 'awakened');
    assert.equal(artLand.hadHumanInteraction, true);
    assert.equal(artLand.leaseExpiresAt, '', 'Art-minted human land must have no 72h timer');
    assert.equal(artLand.inactivityExpiresAt, '', 'Art-minted human land must have no 28d timer');

    // Subsequent AR check-in on an already-permanent art-minted land MUST NOT re-add a timer
    const checkInOnPerm = await apiJson(`/api/lands/${artParcelId}/checkin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${artHumanToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        location: { lat: artLat, lng: artLng },
        proofOfLocation: makePolPayload(artLat, artLng),
        deviceProfile: { isMobile: true, hasCamera: true }
      })
    });
    assert.equal(checkInOnPerm.status, 200);
    assert.equal(checkInOnPerm.body.inactivityExpiresAt, '');

    // 2) Land made FIRST on Desktop/Mobile Map -> starts with 28-day countdown (no physical visit yet)
    const mapLat = 37.8195;
    const mapLng = -122.4495;
    const preClaim = await apiJson('/api/lands/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mapHumanToken}` },
      body: JSON.stringify({
        lat: mapLat,
        lng: mapLng,
        customName: 'Map First Plaza',
        volume: { centerLat: mapLat, centerLng: mapLng, widthMeters: 16, depthMeters: 16 }
      })
    });
    assert.equal(preClaim.status, 201, JSON.stringify(preClaim.body));
    assert.equal(preClaim.body.hadHumanInteraction, false);
    assert.equal(preClaim.body.requiresInPersonVisit, true);
    assert.equal(preClaim.body.permanentOwnership, false);
    assert.ok(preClaim.body.inactivityExpiresAt, 'Land made first must start with a 28-day timer');
    const preClaimParcelId = preClaim.body.parcelId;

    // 3) Human physically goes to the map-first land on Mobile AR and draws art -> timer CLEARS forever!
    const visitPublish = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mapHumanToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'First Physical Artwork',
        description: 'Human visited the pre-claimed map land in person and added manual AR art.',
        termsAccepted: true,
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' },
          { x: 0.05, y: 0, z: 0, color: '#ff3e7f', material: 'matte' },
          { x: 0.1, y: 0, z: 0, color: '#ffd166', material: 'matte' }
        ],
        location: { lat: mapLat, lng: mapLng, accuracy: 5, altitude: 10 },
        proofOfLocation: makePolPayload(mapLat, mapLng),
        deviceProfile: { isMobile: true, hasCamera: true }
      })
    });
    assert.equal(visitPublish.status, 201, JSON.stringify(visitPublish.body));
    assert.equal(visitPublish.body.sculpture.parcelId, preClaimParcelId);

    const afterVisitLands = await apiJson('/api/lands');
    const ownedNow = (afterVisitLands.body.parcels || []).find(
      (p) => p.parcelId === preClaimParcelId
    );
    assert.ok(ownedNow);
    assert.equal(ownedNow.hadHumanInteraction, true);
    assert.equal(ownedNow.leaseExpiresAt, '');
    assert.equal(
      ownedNow.inactivityExpiresAt,
      '',
      'Adding in-person Mobile AR art must clear the 28-day timer so land is permanently owned'
    );
  });
});
