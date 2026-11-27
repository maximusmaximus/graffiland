import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { ethers } from 'ethers';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-land-deed-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'land-deed.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
process.env.ROBINHOOD_ROYALTY_RECEIVER = '0x000000000000000000000000000000000000dEaD';

const { createAppServer } = await import('../server/index.mjs');
const { isLandOwnedByUser } = await import('../client/src/utils/landMapHelpers.js');

let server;
let baseUrl;

// Accounts
let owner1 = null; // Human Land Owner 1
let owner2 = null; // Human Recipient / Buyer 2
let guestArtist = null; // Third-party IRL artist whose art MUST NOT transfer with owner's bundle
let agent1 = null; // Autonomous AI agent 1
let agent2 = null; // Autonomous AI agent 2
let pairedAgentCode = '';

function makePolPayload(lat, lng) {
  const now = Date.now();
  return {
    gpsSamples: [
      { lat, lng, t: now - 5000 },
      { lat: lat + 0.00001, lng: lng + 0.00001, t: now - 1000 }
    ],
    gyroSamples: 24,
    cameraFrames: 12,
    opticalFlowCorrelation: 0.91,
    horizonLuminance: 138,
    ambientPalette: ['#00f5d4', '#1a2b4c', '#ffd166'],
    visualDHash: 'a1b2c3d4e5f60718',
    cameraFacingMode: 'environment',
    cameraResolution: '3840x2160',
    sculptDurationMs: 12000,
    sceneCoveragePct: 100,
    scannedSectors: 10,
    placementPrecisionMeters: 0.1
  };
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';

function makeVoxels(count = 5, baseColor = '#00f5d4') {
  return Array.from({ length: count }, (_, i) => ({
    x: i * 0.06,
    y: 0.05 + i * 0.05,
    z: 0,
    color: baseColor,
    material: 'neon',
    scale: 1
  }));
}

async function publishMobileArt({ token, title, description, lat, lng, parcelId = '', voxels }) {
  return apiJson('/api/sculptures/publish', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': MOBILE_UA
    },
    body: JSON.stringify({
      title,
      description,
      termsAccepted: true,
      ...(parcelId ? { parcelId } : {}),
      voxels: voxels || makeVoxels(5),
      location: { lat, lng, accuracy: 6, altitude: 12 },
      proofOfLocation: makePolPayload(lat, lng),
      deviceProfile: { isMobile: true }
    })
  });
}

function isMcpErrorResponse(res) {
  return res.status >= 400 || Boolean(res.body?.error) || Boolean(res.body?.result?.isError);
}

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

async function mcpCall(name, args = {}, token = '', pairingCode = '') {
  return apiJson('/api/mcp', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(pairingCode ? { 'x-graffiland-pairing-code': pairingCode } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
}

async function registerHuman(email, name) {
  const res = await apiJson('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ devProfile: { email, name } })
  });
  assert.equal(res.status, 200);
  return {
    token: res.body.token,
    user: res.body.user,
    walletAddress: res.body.user.walletAddress
  };
}

async function registerAutonomousAgent(name) {
  const wallet = ethers.Wallet.createRandom();
  const chal = await apiJson('/api/agents/challenge', {
    method: 'POST',
    body: JSON.stringify({ walletAddress: wallet.address })
  });
  assert.equal(chal.status, 200);
  const sig = await wallet.signMessage(chal.body.message);
  const reg = await apiJson('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      walletAddress: wallet.address,
      nonce: chal.body.nonce,
      signature: sig,
      name,
      framework: 'openclaw',
      description: 'Autonomous SPRAY.LAND Land Deed trading agent'
    })
  });
  assert.equal(reg.status, 201);
  return {
    wallet,
    token: reg.body.token,
    agentId: reg.body.agent.agentId,
    walletAddress: wallet.address
  };
}

describe('Transferable Virtual Land Deed NFTs (SLAND) — Contracts, Backend, MCP & UI', () => {
  before(async () => {
    const { server: srv } = createAppServer({ publishRateLimit: 200, mcpRateLimit: 400 });
    server = srv;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    owner1 = await registerHuman('owner1@sland.test', 'Owner One');
    owner2 = await registerHuman('owner2@sland.test', 'Owner Two');
    guestArtist = await registerHuman('guest@sland.test', 'Guest Painter');
    agent1 = await registerAutonomousAgent('Deed Architect Agent');
    agent2 = await registerAutonomousAgent('Deed Collector Agent');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows sqlite handle lock on teardown
    }
  });

  test('1. Compiled GraffilandLandDeed & GraffilandMarketplace artifacts expose Land Deed & Marketplace ABIs', () => {
    const deedArtifactPath = path.join(ROOT, 'contracts', 'build', 'GraffilandLandDeed.json');
    const marketArtifactPath = path.join(ROOT, 'contracts', 'build', 'GraffilandMarketplace.json');
    assert.ok(fs.existsSync(deedArtifactPath), 'GraffilandLandDeed.json artifact must exist');
    assert.ok(fs.existsSync(marketArtifactPath), 'GraffilandMarketplace.json artifact must exist');

    const deedArtifact = JSON.parse(fs.readFileSync(deedArtifactPath, 'utf8'));
    const marketArtifact = JSON.parse(fs.readFileSync(marketArtifactPath, 'utf8'));

    assert.ok(deedArtifact.bytecode && deedArtifact.bytecode.length > 200);
    const deedFns = new Set(
      deedArtifact.abi.filter((x) => x.type === 'function').map((x) => x.name)
    );
    for (const fn of [
      'mintLandDeed',
      'updateLandURI',
      'ownerOfParcel',
      'parcelTokenId',
      'transferFrom',
      'safeTransferFrom',
      'royaltyInfo'
    ]) {
      assert.ok(deedFns.has(fn), `GraffilandLandDeed ABI missing ${fn}`);
    }

    const marketFns = new Set(
      marketArtifact.abi.filter((x) => x.type === 'function').map((x) => x.name)
    );
    for (const fn of ['setLandDeedNft', 'listLandDeed', 'cancelLandListing', 'buyLandDeed']) {
      assert.ok(marketFns.has(fn), `GraffilandMarketplace ABI missing ${fn}`);
    }
  });

  test('2. Contract metadata endpoint exposes SLAND collection & agent discovery advertises Land Deed endpoints', async () => {
    const meta = await apiJson('/api/contract/land-deeds.json');
    assert.equal(meta.status, 200);
    assert.equal(meta.body.name, 'SPRAY.LAND Virtual Land Deeds');
    assert.equal(meta.body.symbol, 'SLAND');

    const wellKnown = await apiJson('/.well-known/agent.json');
    assert.equal(wellKnown.status, 200);
    assert.ok(wellKnown.body.endpoints?.landDeed);
    assert.ok(wellKnown.body.endpoints?.transferLandDeed);
    assert.ok(wellKnown.body.endpoints?.landMarketplace);
  });

  test('3. Mobile AR human land automatically mints permanent Land Deed NFT, exposes ERC-721 metadata & shows in profile', async () => {
    const lat = 37.7749;
    const lng = -122.4194;
    const pub = await publishMobileArt({
      token: owner1.token,
      title: 'Owner1 Neon Totem',
      description: 'Mints a permanent Virtual Land + Land Deed NFT.',
      lat,
      lng,
      voxels: makeVoxels(6, '#00f5d4')
    });
    assert.equal(pub.status, 201, `publish failed: ${JSON.stringify(pub.body)}`);
    const parcelId = pub.body.sculpture.parcelId;
    assert.ok(parcelId);
    assert.ok(pub.body.landDeed?.tokenId, 'Permanent human land should auto-mint a Land Deed NFT');
    assert.equal(
      pub.body.landDeed.ownerAddress.toLowerCase(),
      owner1.walletAddress.toLowerCase()
    );

    // Token metadata JSON matches ERC-721 standard
    const deedMeta = await apiJson(`/api/lands/${encodeURIComponent(parcelId)}/deed.json`);
    assert.equal(deedMeta.status, 200);
    assert.match(deedMeta.body.name, /Land Deed #\d+/);
    assert.ok(Array.isArray(deedMeta.body.attributes));

    const tokenMeta = await apiJson(`/api/land-tokens/${pub.body.landDeed.tokenId}.json`);
    assert.equal(tokenMeta.status, 200);
    assert.equal(tokenMeta.body.external_url, deedMeta.body.external_url);

    // Guest artist adds a third-party artwork on the same open parcel
    const guestPub = await publishMobileArt({
      token: guestArtist.token,
      title: 'Guest Street Tag',
      description: 'Third-party artwork that stays owned by guest artist.',
      lat: lat + 0.00001,
      lng: lng + 0.00001,
      parcelId,
      voxels: makeVoxels(5, '#ff4d6d')
    });
    assert.equal(guestPub.status, 201, `guest publish failed: ${JSON.stringify(guestPub.body)}`);
    assert.equal(guestPub.body.sculpture.parcelId, parcelId);

    // Owner1's Deed summary shows 1 owner-owned artwork & 1 third-party artwork
    const deedInfo = await apiJson(`/api/lands/${encodeURIComponent(parcelId)}/deed`);
    assert.equal(deedInfo.status, 200);
    assert.equal(deedInfo.body.eligible, true);
    assert.equal(deedInfo.body.ownerOwnedArtworkCount, 1);
    assert.equal(deedInfo.body.thirdPartyArtworkCount, 1);

    // Public profile displays the Land Deed badge metadata
    const prof = await apiJson(`/api/profiles/${encodeURIComponent(owner1.user.id)}`);
    assert.equal(prof.status, 200);
    const profLand = (prof.body.lands || []).find((l) => l.parcelId === parcelId);
    assert.ok(profLand?.landDeed?.tokenId);
  });

  test('4. Dormant 72h agent land CANNOT mint or transfer until awakened by IRL human art, then auto-mints SLAND Deed', async () => {
    const scout = await mcpCall(
      'scout_lands',
      { lat: 37.789, lng: -122.401, radiusMeters: 1500, statusFilter: 'unclaimed' },
      agent1.token
    );
    assert.equal(scout.status, 200);
    const candidate = scout.body.result.structuredContent.parcels[0];
    assert.ok(candidate?.parcelId);

    const claim = await mcpCall(
      'claim_land',
      { parcelId: candidate.parcelId, customName: 'Archon Awakening Plaza' },
      agent1.token
    );
    assert.equal(claim.status, 200);
    const parcelId = claim.body.result.structuredContent.parcelId;

    // While dormant: deed is NOT minted, eligible=false, transfer rejected!
    const dormantDeed = await apiJson(`/api/lands/${encodeURIComponent(parcelId)}/deed`);
    assert.equal(dormantDeed.status, 200);
    assert.equal(dormantDeed.body.eligible, false);
    assert.equal(dormantDeed.body.deed, null);

    const blockedTransfer = await mcpCall(
      'transfer_land_deed',
      { parcelId, toAddress: agent2.walletAddress },
      agent1.token
    );
    assert.equal(isMcpErrorResponse(blockedTransfer), true);

    // Awaken the dormant agent land via IRL human art (>=3 voxels)
    const awakenHuman = await registerHuman('awakener@sland.test', 'Awakening Human');
    const lat = candidate.bounds.center[0];
    const lng = candidate.bounds.center[1];
    const awakenPub = await publishMobileArt({
      token: awakenHuman.token,
      title: 'Human Awakening Murals',
      description: 'Wakes up the agent land and triggers permanent Land Deed NFT mint!',
      lat,
      lng,
      parcelId,
      voxels: makeVoxels(5, '#ffd166')
    });
    assert.equal(awakenPub.status, 201, `awaken publish failed: ${JSON.stringify(awakenPub.body)}`);
    assert.equal(awakenPub.body.awakening?.awakenedParcel, true);
    assert.ok(
      awakenPub.body.awakening?.landDeed?.tokenId || awakenPub.body.landDeed?.tokenId,
      'Awakening dormant agent land should auto-mint permanent Land Deed NFT'
    );

    // Now the autonomous agent owns the permanent Land Deed NFT and can list + sell it directly via MCP!
    const afterAwaken = await mcpCall('get_land_deed', { parcelId }, agent1.token);
    assert.equal(afterAwaken.status, 200);
    const deedOut = afterAwaken.body.result.structuredContent;
    assert.equal(deedOut.eligible, true);
    assert.equal(deedOut.deed.ownerAddress.toLowerCase(), agent1.walletAddress.toLowerCase());

    // Autonomous agent1 lists its awakened Land Deed for 0.4 ETH
    const listRes = await mcpCall(
      'list_land_for_sale',
      { parcelId, priceEth: 0.4, includeOwnedArtworks: false },
      agent1.token
    );
    assert.equal(listRes.status, 200);
    assert.equal(isMcpErrorResponse(listRes), false);
    const listingId = listRes.body.result.structuredContent.listing.id;
    assert.ok(listingId);

    // Public marketplace lists it
    const mkt = await apiJson('/api/marketplace/lands');
    assert.equal(mkt.status, 200);
    assert.ok((mkt.body.listings || []).some((l) => l.id === listingId));

    // Autonomous agent2 buys the Land Deed via MCP!
    const buyRes = await mcpCall('buy_land_deed', { listingId }, agent2.token);
    assert.equal(buyRes.status, 200, `buy failed: ${JSON.stringify(buyRes.body)}`);
    assert.equal(isMcpErrorResponse(buyRes), false);
    const buyOut = buyRes.body.result.structuredContent;
    assert.equal(buyOut.deed.ownerAddress.toLowerCase(), agent2.walletAddress.toLowerCase());
    assert.equal(buyOut.splits.platform.bps, 500);
    assert.equal(buyOut.splits.agentSteward.bps, 300);
    assert.equal(buyOut.splits.humanContributors.bps, 200);
    assert.equal(buyOut.splits.seller.bps, 9000);
    assert.equal(buyOut.splits.humanContributors.perContributor.length, 1);
    assert.equal(
      buyOut.splits.humanContributors.perContributor[0].address.toLowerCase(),
      awakenHuman.walletAddress.toLowerCase()
    );

    // Agent1 can no longer transfer or manage the sold parcel
    const denied = await mcpCall(
      'transfer_land_deed',
      { parcelId, toAddress: owner2.walletAddress },
      agent1.token
    );
    assert.equal(isMcpErrorResponse(denied), true);

    // Agent2 (new deed holder) CAN directly transfer the deed to owner2 via MCP
    const directTransfer = await mcpCall(
      'transfer_land_deed',
      { parcelId, toAddress: owner2.walletAddress },
      agent2.token
    );
    assert.equal(directTransfer.status, 200);
    assert.equal(isMcpErrorResponse(directTransfer), false);
    assert.equal(
      directTransfer.body.result.structuredContent.deed.ownerAddress.toLowerCase(),
      owner2.walletAddress.toLowerCase()
    );
  });

  test('5. Paired agent CANNOT transfer or list human land without human approval (and cannot self-sign); human transfer bundles ONLY own art & cleans security state', async () => {
    const guestArtist2 = await registerHuman('guest2@sland.test', 'Guest Painter Two');
    // Owner1 mints a fresh permanent land + adds own artwork + guest2 adds third-party artwork
    const lat = 37.7755;
    const lng = -122.4188;
    const pub1 = await publishMobileArt({
      token: owner1.token,
      title: 'Owner1 Bundled Sculpture',
      description: 'Owned by Owner1 — will move with optional bundle.',
      lat,
      lng,
      voxels: makeVoxels(6, '#00f5d4')
    });
    assert.equal(pub1.status, 201, `pub1 failed: ${JSON.stringify(pub1.body)}`);
    const parcelId = pub1.body.sculpture.parcelId;
    const ownerSculptureId = pub1.body.sculpture.id;

    const pubGuest = await publishMobileArt({
      token: guestArtist2.token,
      title: 'Guest Independent Artwork',
      description: 'Owned by Guest2 — MUST remain with Guest2 after land bundle transfer.',
      lat: lat + 0.00001,
      lng: lng + 0.00001,
      parcelId,
      voxels: makeVoxels(5, '#ff9f1c')
    });
    assert.equal(pubGuest.status, 201, `pubGuest failed: ${JSON.stringify(pubGuest.body)}`);
    const guestSculptureId = pubGuest.body.sculpture.id;

    // Pair an MCP agent session with Owner1
    const pairInit = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({})
    });
    assert.equal(pairInit.status, 200, `pairInit failed: ${JSON.stringify(pairInit.body)}`);
    pairedAgentCode = pairInit.body.pairing?.code || pairInit.body.code;
    assert.ok(pairedAgentCode);

    const pairedWallet = ethers.Wallet.createRandom();
    const connectRes = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({
        pairingCode: pairedAgentCode,
        agentName: 'Paired Studio Copilot',
        agentAddress: pairedWallet.address
      })
    });
    assert.equal(connectRes.status, 200, `connectRes failed: ${JSON.stringify(connectRes.body)}`);

    // Paired agent queues a list_land_for_sale request (verifies human approval guard + auto-cancel on transfer!)
    const staleReq = await mcpCall(
      'list_land_for_sale',
      { parcelId, priceEth: 0.9, includeOwnedArtworks: false },
      '',
      pairedAgentCode
    );
    assert.equal(staleReq.status, 200, `staleReq failed: ${JSON.stringify(staleReq.body)}`);
    assert.equal(staleReq.body.result?.structuredContent?.status, 'pending_human_approval');
    const staleRequestId = staleReq.body.result?.structuredContent?.requestId || '';
    assert.ok(staleRequestId, 'Paired agent list_land_for_sale must queue a pending signature request');

    // Paired agent attempts transfer_land_deed -> MUST queue human approval (NOT execute immediately!)
    const agentTransferAttempt = await mcpCall(
      'transfer_land_deed',
      { parcelId, toAddress: owner2.walletAddress, includeOwnedArtworks: true },
      '',
      pairedAgentCode
    );
    assert.equal(
      agentTransferAttempt.status,
      200,
      `agentTransferAttempt failed: ${JSON.stringify(agentTransferAttempt.body)}`
    );
    const reqOut = agentTransferAttempt.body.result.structuredContent;
    assert.equal(reqOut.status, 'pending_human_approval');
    assert.ok(reqOut.requestId);
    const transferReqId = reqOut.requestId;

    // Paired agent attempts to self-sign transfer_land_deed via /agent-sign -> MUST BE BLOCKED (403)!
    const selfSign = await apiJson(
      `/api/signatures/requests/${encodeURIComponent(transferReqId)}/agent-sign`,
      {
        method: 'POST',
        headers: { 'x-graffiland-pairing-code': pairedAgentCode },
        body: JSON.stringify({
          agentAddress: pairedWallet.address,
          signature: await pairedWallet.signMessage(reqOut.request?.canonicalMessage || 'transfer')
        })
      }
    );
    assert.equal(selfSign.status, 403, `Expected 403 blocking agent self-sign, got: ${JSON.stringify(selfSign)}`);

    // Verify Owner1 is still the owner (nothing transferred yet)
    const stillOwner1 = await apiJson(`/api/lands/${encodeURIComponent(parcelId)}/deed`);
    assert.equal(
      stillOwner1.body.deed.ownerAddress.toLowerCase(),
      owner1.walletAddress.toLowerCase()
    );

    // Now human Owner1 approves & signs the transfer request!
    const approveRes = await apiJson(
      `/api/signatures/requests/${encodeURIComponent(transferReqId)}/mobile-sign`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner1.token}` },
        body: JSON.stringify({})
      }
    );
    assert.equal(approveRes.status, 200, `approve failed: ${JSON.stringify(approveRes.body)}`);
    const approvedDeed = approveRes.body.execution?.deed || approveRes.body.result?.deed;
    assert.equal(approvedDeed.ownerAddress.toLowerCase(), owner2.walletAddress.toLowerCase());

    // Verify bundled artwork moved to Owner2 while guest artwork stayed with Guest!
    const ownerArtAfter = await apiJson(`/api/sculptures/${encodeURIComponent(ownerSculptureId)}`);
    assert.equal(
      ownerArtAfter.body.sculpture.recipientAddress.toLowerCase(),
      owner2.walletAddress.toLowerCase()
    );
    const guestArtAfter = await apiJson(`/api/sculptures/${encodeURIComponent(guestSculptureId)}`);
    assert.equal(
      guestArtAfter.body.sculpture.recipientAddress.toLowerCase(),
      guestArtist2.walletAddress.toLowerCase()
    );

    // Verify Security Reset: stale pending request was auto-cancelled!
    if (staleRequestId) {
      const owner1Pending = await apiJson('/api/signatures/pending', {
        headers: { Authorization: `Bearer ${owner1.token}` }
      });
      assert.equal(
        (owner1Pending.body.requests || []).some((r) => r.id === staleRequestId),
        false,
        'Previous owner pending approval requests must be auto-cancelled after Land Deed transfer'
      );
    }

    // Verify Owner1 lost land ownership and Owner2 gained it!
    const oldOwnerDeny = await apiJson(`/api/lands/${encodeURIComponent(parcelId)}/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ toAddress: guestArtist2.walletAddress })
    });
    assert.equal(oldOwnerDeny.status, 403);

    // Verify Future 3% Land Steward Royalty now routes to Owner2 when guest2 sells their artwork!
    const guestList = await apiJson('/api/marketplace/listings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${guestArtist2.token}` },
      body: JSON.stringify({ sculptureId: guestSculptureId, priceEth: 1.0 })
    });
    assert.equal(guestList.status, 201, `guestList failed: ${JSON.stringify(guestList.body)}`);
    const guestBuy = await apiJson(`/api/marketplace/listings/${encodeURIComponent(guestList.body.listing.id)}/buy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({})
    });
    assert.equal(guestBuy.status, 200, `guestBuy failed: ${JSON.stringify(guestBuy.body)}`);
    assert.equal(
      guestBuy.body.splits.agentSteward.address.toLowerCase(),
      owner2.walletAddress.toLowerCase(),
      '3% Land Steward royalty must route to the NEW Land Deed holder (Owner2)'
    );
    assert.ok(
      guestBuy.body.splits.humanContributors.perContributor.some(
        (r) => r.address.toLowerCase() === guestArtist2.walletAddress.toLowerCase()
      ),
      '2% Human Contributor pool must remain with original IRL artists'
    );
  });

  test('6. Client isLandOwnedByUser canonically respects Land Deed NFT owner over stale claimedBy / ownedParcelIds', () => {
    const deedParcel = {
      parcelId: 'GLAND-DEED123',
      claimedBy: 'old-owner-sub',
      ownerSub: 'new-owner-sub',
      landDeed: {
        tokenId: '7',
        ownerSub: 'new-owner-sub',
        ownerAddress: '0x2222222222222222222222222222222222222222'
      }
    };
    assert.equal(
      isLandOwnedByUser(deedParcel, {
        user: { id: 'old-owner-sub', walletAddress: '0x1111111111111111111111111111111111111111' },
        ownedParcelIds: ['GLAND-DEED123']
      }),
      false
    );
    assert.equal(
      isLandOwnedByUser(deedParcel, {
        user: { id: 'new-owner-sub', walletAddress: '0x2222222222222222222222222222222222222222' },
        ownedParcelIds: []
      }),
      true
    );
  });
});

describe('Transferable Land Deed NFT React UI Components (jsdom + Testing Library)', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;

  async function loadJsxModule(relPath) {
    const absIn = path.join(ROOT, relPath);
    const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const absOut = path.join(outTmpDir, `${safeName}.mjs`);
    await esbuild.build({
      entryPoints: [absIn],
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({
              path: 'stub.css',
              namespace: 'stub-css'
            }));
            build.onResolve({ filter: /\?url$/ }, () => ({
              path: 'stub-url',
              namespace: 'stub-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-deed-test-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('LandDeedPanel shows unminted notice for dormant/unawakened land', async () => {
    const { default: LandDeedPanel } = await loadJsxModule('client/src/components/LandDeedPanel.jsx');
    const view = RTL.render(
      React.createElement(LandDeedPanel, {
        parcel: { parcelId: 'GLAND-DORMANT1' },
        fetchDeedFn: async () => ({
          eligible: false,
          deed: null,
          eligibilityReason: 'Awaken this land with mobile AR art to mint its permanent Land Deed NFT.'
        })
      })
    );

    const badge = await view.findByTestId('land-deed-pending-badge');
    assert.match(badge.textContent, /Not Minted Yet/i);
    const notice = await view.findByTestId('land-deed-unminted-notice');
    assert.match(notice.textContent, /Awaken this land/i);
    cleanup();
  });

  test('LandDeedPanel renders permanent Deed #42, submits bundled transfer & lists/cancels on marketplace', async () => {
    const { default: LandDeedPanel } = await loadJsxModule('client/src/components/LandDeedPanel.jsx');
    let transferredArgs = null;
    let listedArgs = null;
    let cancelledId = '';
    const recipient = '0x3333333333333333333333333333333333333333';

    let currentListing = null;
    const mockFetch = async () => ({
      eligible: true,
      deed: {
        parcelId: 'GLAND-PERM42',
        tokenId: '42',
        ownerAddress: '0x1111111111111111111111111111111111111111',
        chainName: 'Robinhood Chain Testnet',
        chainId: 46630,
        simulated: true
      },
      activeListing: currentListing,
      ownerOwnedArtworkCount: 2,
      thirdPartyArtworkCount: 1,
      transfers: [
        {
          id: 'tr-1',
          fromAddress: '0x0000000000000000000000000000000000000001',
          toAddress: '0x1111111111111111111111111111111111111111',
          method: 'embedded',
          bundledSculptureIds: ['sc-1']
        }
      ]
    });

    const view = RTL.render(
      React.createElement(LandDeedPanel, {
        parcel: { parcelId: 'GLAND-PERM42' },
        fetchDeedFn: mockFetch,
        transferDeedFn: async (parcelId, payload) => {
          transferredArgs = { parcelId, payload };
          return {
            deed: { tokenId: '42', ownerAddress: payload.toAddress },
            bundledArtworks: payload.includeOwnedArtworks ? ['sc-1', 'sc-2'] : []
          };
        },
        listForSaleFn: async (payload) => {
          listedArgs = payload;
          currentListing = {
            id: 'list-42',
            priceEth: payload.priceEth,
            includeSellerArtworks: Boolean(payload.includeSellerArtworks),
            bundledSculptureIds: payload.includeSellerArtworks ? ['sc-1', 'sc-2'] : []
          };
          return { listing: currentListing };
        },
        cancelListingFn: async (id) => {
          cancelledId = id;
          currentListing = null;
          return { cancelled: true };
        }
      })
    );

    const tokenBadge = await view.findByTestId('land-deed-token-badge');
    assert.match(tokenBadge.textContent, /Deed #42/);

    // Bundle transfer
    const toInput = view.getByTestId('land-deed-transfer-to-input');
    const bundleCheckbox = view.getByTestId('land-deed-bundle-checkbox');
    RTL.fireEvent.change(toInput, { target: { value: recipient } });
    RTL.fireEvent.click(bundleCheckbox);
    RTL.fireEvent.click(view.getByTestId('land-deed-transfer-submit-btn'));

    await RTL.waitFor(() => {
      assert.ok(transferredArgs);
      assert.equal(transferredArgs.parcelId, 'GLAND-PERM42');
      assert.equal(transferredArgs.payload.toAddress, recipient);
      assert.equal(transferredArgs.payload.includeOwnedArtworks, true);
    });

    // Wait for busy state to clear after transfer completes
    await RTL.waitFor(() => {
      assert.equal(view.getByTestId('land-deed-transfer-to-input').value, '');
    });

    // List for sale with bundle
    const priceInput = view.getByTestId('land-deed-list-price-input');
    const saleBundleCheckbox = view.getByTestId('land-deed-sale-bundle-checkbox');
    RTL.fireEvent.change(priceInput, { target: { value: '0.75' } });
    RTL.fireEvent.click(saleBundleCheckbox);
    RTL.fireEvent.submit(view.getByTestId('land-deed-list-submit-btn').closest('form'));

    await RTL.waitFor(() => {
      assert.ok(listedArgs);
      assert.equal(listedArgs.priceEth, 0.75);
      assert.equal(listedArgs.includeSellerArtworks, true);
    });

    // Active listing appears -> cancel it
    const cancelBtn = await view.findByTestId('land-deed-cancel-listing-btn');
    RTL.fireEvent.click(cancelBtn);
    await RTL.waitFor(() => {
      assert.equal(cancelledId, 'list-42');
    });

    // History row rendered
    const history = view.getByTestId('land-deed-transfer-history');
    assert.match(history.textContent, /embedded/i);
    cleanup();
  });

  test('PlotVisitView & ProfileModal source wire Deed #N, For Sale badges and Buy Land Deed card', () => {
    const plotSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'PlotVisitView.jsx'),
      'utf8'
    );
    assert.match(plotSrc, /data-testid="plot-land-deed-badge"/);
    assert.match(plotSrc, /data-testid="plot-land-forsale-badge"/);
    assert.match(plotSrc, /data-testid="plot-buy-land-card"/);
    assert.match(plotSrc, /data-testid="plot-buy-land-btn"/);
    assert.match(plotSrc, /api\.buyLandListing/);

    const profileSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'ProfileModal.jsx'),
      'utf8'
    );
    assert.match(profileSrc, /data-testid="profile-land-deed-badge"/);
    assert.match(profileSrc, /data-testid="profile-land-forsale-badge"/);

    const mgmtSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'LandManagementModal.jsx'),
      'utf8'
    );
    assert.match(mgmtSrc, /<LandDeedPanel\b/);
  });
});
