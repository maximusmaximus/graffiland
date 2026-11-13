import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ethers } from 'ethers';
import { WebSocket } from 'ws';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-test-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
process.env.ROBINHOOD_ROYALTY_RECEIVER = '';

const { compileContract } = await import('../contracts/compile.mjs');
const { createAppServer } = await import('../server/index.mjs');
const { buildTransferAuthMessage } = await import('../shared/transferMessage.mjs');
const chatCrypto = await import('../client/src/utils/chatCrypto.js');

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
    for (const fnName of [
      'safeTransferFrom',
      'transferFrom',
      'ownerOf',
      'contractURI',
      'setContractURI',
      'tokensOfOwner',
      'tokenOfOwnerByIndex'
    ]) {
      assert.ok(
        artifact.abi.some((item) => item.name === fnName),
        `${fnName} present in compiled ABI`
      );
    }
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
          altitude: 42.5,
          altitudeAccuracy: 3.2,
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
          cameraResolution: '3840x2160',
          sculptDurationMs: 14200,
          sceneCoveragePct: 100,
          scannedSectors: 10,
          placementPrecisionMeters: 0.15
        },
        deviceProfile: { isMobile: true }
      })
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.sculpture.id);
    assert.ok(res.body.sculpture.parcelId.startsWith('GLAND-'));
    assert.ok(res.body.sculpture.polScore >= 75);
    assert.equal(res.body.sculpture.proofOfLocation.sensors.sceneCoveragePct, 100);
    assert.equal(res.body.sculpture.proofOfLocation.sensors.scannedSectors, 10);
    assert.equal(res.body.sculpture.proofOfLocation.sensors.placementPrecisionMeters, 0.15);
    assert.equal(res.body.sculpture.altitude, 42.5);
    assert.equal(res.body.sculpture.elevation.deviceAltitudeMeters, 42.5);
    assert.equal(res.body.sculpture.elevation.altitudeAccuracyMeters, 3.2);
    assert.equal(res.body.sculpture.elevation.altitudeSource, 'device-sensor');
    assert.equal(res.body.sculpture.elevation.anchorAltitudeMeters, 42.5);
    assert.equal(res.body.sculpture.elevation.sculptureVerticalMinM, 0);
    assert.equal(res.body.sculpture.elevation.sculptureVerticalMaxM, 0.2);
    assert.equal(typeof res.body.sculpture.proofOfLocation.solar.solarAzimuthDeg, 'number');
    assert.equal(res.body.sculpture.chain.royaltyBps, 500);
    assert.equal(res.body.ipfs.metadata.royalty.resale_fee_bps, 500);
    assert.equal(res.body.ipfs.metadata.location.latitude, 37.808);
    assert.equal(res.body.ipfs.metadata.location.altitude_meters, 42.5);
    assert.equal(res.body.ipfs.metadata.virtual_land.anchor_elevation_meters, 42.5);
    createdSculptureId = res.body.sculpture.id;
    createdParcelId = res.body.sculpture.parcelId;

    // Verify local IPFS CID endpoint resolves valid JSON metadata
    const ipfsRes = await fetch(`${baseUrl}${res.body.ipfs.gatewayUrl}`);
    assert.equal(ipfsRes.status, 200);
    const ipfsJson = await ipfsRes.json();
    assert.equal(ipfsJson.name, 'Neon Pier Totem');
    assert.equal(ipfsJson.seller_fee_basis_points, 500);
    assert.equal(ipfsJson.location.altitude_meters, 42.5);
    assert.equal(ipfsJson.location.altitude_accuracy_meters, 3.2);
    assert.equal(ipfsJson.location.altitude_source, 'device-sensor');
    assert.equal(ipfsJson.location.sculpture_vertical_min_m, 0);
    assert.equal(ipfsJson.location.sculpture_vertical_max_m, 0.2);
    assert.equal(typeof ipfsJson.location.solar_azimuth_deg, 'number');
    assert.equal(ipfsJson.virtual_land.anchor_elevation_meters, 42.5);
    assert.equal(ipfsJson.animation_mime_type, 'model/gltf-binary');
    assert.equal(ipfsJson.properties?.category, '3d-model');

    // Verify local IPFS model CID is genuine binary glTF 2.0 (.glb)
    const modelCidRes = await fetch(`${baseUrl}/ipfs/${res.body.ipfs.modelCid}`);
    assert.equal(modelCidRes.status, 200);
    assert.ok(modelCidRes.headers.get('content-type')?.includes('model/gltf-binary'));
    const glbBuf = new Uint8Array(await modelCidRes.arrayBuffer());
    const dv = new DataView(glbBuf.buffer, glbBuf.byteOffset, glbBuf.byteLength);
    assert.equal(dv.getUint32(0, true), 0x46546c67, 'GLB magic header');
    assert.equal(dv.getUint32(4, true), 2, 'glTF version 2');
    assert.equal(dv.getUint32(8, true), glbBuf.byteLength, 'GLB length matches');

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

  test('Camera-locked Location Chat enforces AR raycast/proximity gates and server-blind E2EE (Clue + ECDH Wrap)', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
    const creatorAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'test-artist@graffiland.local', name: 'Test Artist' } })
    });
    const creatorUser = creatorAuth.body.user;

    const visAAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'visitorA@graffiland.local', name: 'Visitor A' } })
    });
    const visBAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'visitorB@graffiland.local', name: 'Visitor B' } })
    });

    const creatorId = await chatCrypto.getOrCreateDeviceIdentity(creatorUser.id);
    const visAId = await chatCrypto.getOrCreateDeviceIdentity(visAAuth.body.user.id);
    const visBId = await chatCrypto.getOrCreateDeviceIdentity(visBAuth.body.user.id);

    const makeSightProof = async (idObj, overrides = {}) => {
      const base = {
        selectionMethod: 'ar-camera-raycast',
        rayHit: true,
        inFrustum: true,
        cameraReady: true,
        cameraFrames: 6,
        opticalFlowCorrelation: 0.88,
        visualDHash: 'f0e1d2c3b4a59687',
        lat: 37.80805,
        lng: -122.41775,
        altitude: 43,
        selectedAt: new Date().toISOString(),
        ...overrides
      };
      return chatCrypto.signSightProof(idObj, {
        sculptureId: createdSculptureId,
        parcelId: createdParcelId,
        sightProof: base
      });
    };

    // 1. Creator generates client-side AES-256-GCM room key + optional visual clue wrap (never plaintext on server)
    const roomKeyB64 = chatCrypto.generateRoomKeyB64();
    const { roomKeyCommit } = await chatCrypto.computeRoomPossessionProof(
      roomKeyB64,
      createdSculptureId,
      1
    );
    const selfWrap = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      recipientEcdhPubJwk: creatorId.ecdhPublicJwk,
      recipientPubFp: creatorId.pubFingerprint,
      grantorIdentity: creatorId
    });
    const clueBlob = await chatCrypto.wrapRoomKeyWithClue({
      roomKeyB64,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      clueAnswer: 'Golden Sea Lion'
    });

    const initRes = await apiJson(`/api/sculptures/${createdSculptureId}/chat/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ownerEcdhPubJwk: creatorId.ecdhPublicJwk,
        ownerSignPubJwk: creatorId.signPublicJwk,
        ownerPubFp: creatorId.pubFingerprint,
        selfGrantEnvelope: selfWrap.wrappedKeyJson,
        selfGrantSig: selfWrap.grantSig,
        roomKeyCommit,
        cluePrompt: 'Statuette above the pier arch?',
        clueWrappedJson: clueBlob,
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(initRes.status, 200, JSON.stringify(initRes.body));
    assert.equal(initRes.body.board.hasClue, true);

    // 2. Enforce Desktop rejection (403), Too-Far GPS rejection (403), Missing Raycast rejection (403)
    const desktopEnter = await apiJson(`/api/sculptures/${createdSculptureId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}` },
      body: JSON.stringify({
        sightProof: await makeSightProof(visAId),
        deviceProfile: { isMobile: false }
      })
    });
    assert.equal(desktopEnter.status, 403);

    const farEnter = await apiJson(`/api/sculptures/${createdSculptureId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        sightProof: await makeSightProof(visAId, { lat: 37.9, lng: -122.41 }),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(farEnter.status, 403);

    const noRayEnter = await apiJson(`/api/sculptures/${createdSculptureId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        sightProof: await makeSightProof(visAId, { rayHit: false }),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(noRayEnter.status, 403);

    // 3. Creator posts E2EE message #1; server strictly rejects plaintext
    const secretText1 = 'Meet by the east pier lantern after sunset!';
    const plaintextReject = await apiJson(`/api/sculptures/${createdSculptureId}/chat/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        text: secretText1,
        sightProof: await makeSightProof(creatorId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(plaintextReject.status, 400);

    const encMsg1 = await chatCrypto.encryptChatMessage({
      roomKeyB64,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      senderSub: creatorUser.id,
      identity: creatorId,
      text: secretText1,
      authorName: creatorUser.name,
      sightDistM: 6.2,
      altM: 43
    });
    const post1 = await apiJson(`/api/sculptures/${createdSculptureId}/chat/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...encMsg1,
        sightProof: await makeSightProof(creatorId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(post1.status, 200, JSON.stringify(post1.body));
    assert.ok(post1.body.message.ciphertextB64);

    // 4. Visitor A taps sculpture in person through camera -> enters -> verifies server response has ZERO plaintext
    const enterVisA = await apiJson(`/api/sculptures/${createdSculptureId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: visAId.pubFingerprint,
        sightProof: await makeSightProof(visAId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(enterVisA.status, 200);
    assert.equal(JSON.stringify(enterVisA.body).includes(secretText1), false);
    assert.equal(enterVisA.body.messages.length, 1);

    // Wrong clue fails PBKDF2/AES-GCM unwrap; normalized correct clue succeeds
    await assert.rejects(() =>
      chatCrypto.unwrapRoomKeyWithClue({
        clueWrappedJson: enterVisA.body.board.clueWrappedJson,
        sculptureId: createdSculptureId,
        keyEpoch: 1,
        clueAnswer: 'silver pigeon'
      })
    );
    const unlockedVisAKey = await chatCrypto.unwrapRoomKeyWithClue({
      clueWrappedJson: enterVisA.body.board.clueWrappedJson,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      clueAnswer: '  golden   sea lion '
    });
    assert.equal(unlockedVisAKey, roomKeyB64);

    const decMsg1 = await chatCrypto.decryptChatMessage({
      msg: enterVisA.body.messages[0],
      roomKeyB64: unlockedVisAKey,
      sculptureId: createdSculptureId
    });
    assert.equal(decMsg1.verifiedSig, true);
    assert.equal(decMsg1.text, secretText1);

    // Visitor A claims granted membership via double-hashed proof without revealing clue answer or K_room
    const { roomProofToken } = await chatCrypto.computeRoomPossessionProof(
      unlockedVisAKey,
      createdSculptureId,
      1
    );
    const visASelfWrap = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64: unlockedVisAKey,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      recipientEcdhPubJwk: visAId.ecdhPublicJwk,
      recipientPubFp: visAId.pubFingerprint,
      grantorIdentity: visAId
    });
    const claimA = await apiJson(`/api/sculptures/${createdSculptureId}/chat/claim-grant`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        roomProofToken,
        requesterEcdhPubJwk: visAId.ecdhPublicJwk,
        requesterSignPubJwk: visAId.signPublicJwk,
        requesterPubFp: visAId.pubFingerprint,
        selfGrantEnvelope: visASelfWrap.wrappedKeyJson,
        selfGrantSig: visASelfWrap.grantSig,
        sightProof: await makeSightProof(visAId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(claimA.status, 200);
    assert.equal(claimA.body.grant.status, 'granted');

    const secretText2 = 'Unlocked by standing under the arch!';
    const encMsg2 = await chatCrypto.encryptChatMessage({
      roomKeyB64: unlockedVisAKey,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      senderSub: visAAuth.body.user.id,
      identity: visAId,
      text: secretText2,
      authorName: 'Visitor A',
      sightDistM: 5.5,
      altM: 43
    });
    const post2 = await apiJson(`/api/sculptures/${createdSculptureId}/chat/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...encMsg2,
        sightProof: await makeSightProof(visAId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(post2.status, 200);

    // 5. Visitor B enters without knowing the clue -> requests ECDH grant -> Visitor A wraps K_room -> Visitor B reads full history
    const reqB = await apiJson(`/api/sculptures/${createdSculptureId}/chat/request-grant`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visBAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterEcdhPubJwk: visBId.ecdhPublicJwk,
        requesterSignPubJwk: visBId.signPublicJwk,
        requesterPubFp: visBId.pubFingerprint,
        sightProof: await makeSightProof(visBId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(reqB.status, 200);
    assert.equal(reqB.body.grant.status, 'pending');

    const pendingForA = await apiJson('/api/chat/pending-grants', {
      headers: { Authorization: `Bearer ${visAAuth.body.token}` }
    });
    assert.equal(pendingForA.status, 200);
    const targetB = pendingForA.body.grants.find((g) => g.requesterPubFp === visBId.pubFingerprint);
    assert.ok(targetB);

    const wrapForB = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64: unlockedVisAKey,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      recipientEcdhPubJwk: targetB.requesterEcdhPubJwk,
      recipientPubFp: targetB.requesterPubFp,
      grantorIdentity: visAId
    });
    const grantB = await apiJson(`/api/sculptures/${createdSculptureId}/chat/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visAAuth.body.token}` },
      body: JSON.stringify({
        targetGrantId: targetB.id,
        wrappedKeyJson: wrapForB.wrappedKeyJson,
        grantorEcdhPubJwk: visAId.ecdhPublicJwk,
        grantorSignPubJwk: visAId.signPublicJwk,
        grantSig: wrapForB.grantSig
      })
    });
    assert.equal(grantB.status, 200);
    assert.equal(grantB.body.grant.status, 'granted');

    const enterVisB = await apiJson(`/api/sculptures/${createdSculptureId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visBAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: visBId.pubFingerprint,
        sightProof: await makeSightProof(visBId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(enterVisB.status, 200);
    assert.equal(enterVisB.body.myGrant.status, 'granted');

    const unwrappedVisBKey = await chatCrypto.unwrapRoomKeyFromGrant({
      wrappedKeyJson: enterVisB.body.myGrant.wrappedKeyJson,
      grantSig: enterVisB.body.myGrant.grantSig,
      grantorSignPubJwk: enterVisB.body.myGrant.grantorSignPubJwk,
      sculptureId: createdSculptureId,
      keyEpoch: 1,
      identity: visBId
    });
    assert.equal(unwrappedVisBKey, roomKeyB64);

    const decHistoryB = [];
    for (const m of enterVisB.body.messages) {
      decHistoryB.push(
        await chatCrypto.decryptChatMessage({
          msg: m,
          roomKeyB64: unwrappedVisBKey,
          sculptureId: createdSculptureId
        })
      );
    }
    assert.deepEqual(
      decHistoryB.map((m) => m.text),
      [secretText1, secretText2]
    );

    // 6. Desktop metadata endpoint exposes only encrypted count, zero plaintext or ciphertexts
    const singleSc = await apiJson(`/api/sculptures/${createdSculptureId}`);
    assert.equal(singleSc.status, 200);
    assert.equal(singleSc.body.sculpture.chatSummary.initialized, true);
    assert.equal(singleSc.body.sculpture.chatSummary.messageCount, 2);
    assert.equal(JSON.stringify(singleSc.body).includes(secretText1), false);
    assert.equal(JSON.stringify(singleSc.body).includes(secretText2), false);
  });

  test('NFT platform metadata, 3D GLB export & wallet-to-wallet transferability', async () => {
    // 1. EIP-7572 Collection Contract Metadata
    const contractMeta = await apiJson('/api/contract/metadata.json');
    assert.equal(contractMeta.status, 200);
    assert.equal(contractMeta.body.symbol, 'GLAND');
    assert.equal(contractMeta.body.seller_fee_basis_points, 500);
    assert.ok(contractMeta.body.contract.standards.includes('ERC-721'));
    assert.ok(contractMeta.body.contract.standards.includes('EIP-7572'));

    // 2. Dynamic .GLB export & ERC-721 / OpenSea Token Metadata
    const glbRes = await fetch(`${baseUrl}/api/sculptures/${createdSculptureId}/model.glb`);
    assert.equal(glbRes.status, 200);
    assert.ok(glbRes.headers.get('content-type')?.includes('model/gltf-binary'));
    const glbBytes = new Uint8Array(await glbRes.arrayBuffer());
    const dv = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
    assert.equal(dv.getUint32(0, true), 0x46546c67);
    assert.equal(dv.getUint32(4, true), 2);
    const jsonChunkLen = dv.getUint32(12, true);
    const gltfJson = JSON.parse(new TextDecoder().decode(glbBytes.slice(20, 20 + jsonChunkLen)));
    assert.equal(gltfJson.asset.version, '2.0');
    assert.ok(gltfJson.meshes[0].primitives.length >= 1);

    const scDetail = await apiJson(`/api/sculptures/${createdSculptureId}`);
    assert.equal(scDetail.status, 200);
    const tokenId = scDetail.body.sculpture.chain.tokenId;
    const origOwner = scDetail.body.sculpture.recipientAddress;

    const tokenMeta = await apiJson(`/api/sculptures/${createdSculptureId}/metadata.json`);
    assert.equal(tokenMeta.status, 200);
    assert.equal(tokenMeta.body.animation_mime_type, 'model/gltf-binary');
    assert.ok(tokenMeta.body.animation_url.endsWith(`/api/sculptures/${createdSculptureId}/model.glb`));
    assert.equal(tokenMeta.body.seller_fee_basis_points, 500);

    const byTokenId = await apiJson(`/api/tokens/${tokenId}.json`);
    assert.equal(byTokenId.status, 200);
    assert.equal(byTokenId.body.token_id, tokenId);

    // 3. Reject unauthorized transfer from non-owner (admin cannot steal artist's NFT)
    const externalWallet = ethers.Wallet.createRandom();
    const unauthorized = await apiJson(`/api/sculptures/${createdSculptureId}/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ toAddress: externalWallet.address })
    });
    assert.equal(unauthorized.status, 403);

    // 4. Embedded-wallet owner transfers NFT to external MetaMask / cold wallet
    const t1 = await apiJson(`/api/sculptures/${createdSculptureId}/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({ toAddress: externalWallet.address })
    });
    assert.equal(t1.status, 200);
    assert.equal(t1.body.transfer.fromAddress, origOwner);
    assert.equal(t1.body.transfer.toAddress, externalWallet.address);
    assert.equal(t1.body.sculpture.recipientAddress, externalWallet.address);
    assert.equal(t1.body.sculpture.transfers.length, 1);

    // 5. Previous embedded-wallet owner can no longer re-transfer it
    const replay = await apiJson(`/api/sculptures/${createdSculptureId}/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${artistToken}` },
      body: JSON.stringify({ toAddress: origOwner })
    });
    assert.equal(replay.status, 403);

    // 6. New external wallet owner authorizes onward transfer using EIP-191 personal_sign
    const secondWallet = ethers.Wallet.createRandom();
    const authMessage = buildTransferAuthMessage({
      sculptureId: createdSculptureId,
      tokenId,
      fromAddress: externalWallet.address,
      toAddress: secondWallet.address,
      contractAddress: scDetail.body.sculpture.chain.contractAddress,
      chainId: scDetail.body.sculpture.chain.chainId
    });
    const sig = await externalWallet.signMessage(authMessage);
    const t2 = await apiJson(`/api/sculptures/${createdSculptureId}/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ toAddress: secondWallet.address, signature: sig })
    });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.transfer.method, 'external-signed-sim');
    assert.equal(t2.body.sculpture.recipientAddress, secondWallet.address);
    assert.equal(t2.body.sculpture.transfers.length, 2);

    // 7. Ownership sync endpoint reports current owner cleanly
    const syncRes = await apiJson(`/api/sculptures/${createdSculptureId}/sync-ownership`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.ownerAddress, secondWallet.address);
  });

  test('4x resolution policy and 10000x10000x10000 area bounds enforcement', async () => {
    const cfg = await apiJson('/api/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.policy.resolutionScale, 4);
    assert.equal(cfg.body.policy.voxelStepMeters, 0.05);
    assert.equal(cfg.body.policy.maxVoxels, 4096);
    assert.equal(cfg.body.policy.areaHalfSpanMeters, 250);
    assert.deepEqual(cfg.body.policy.areaLimitBlocks, [10000, 10000, 10000]);

    const spec = await apiJson('/api/agent/spec');
    assert.equal(spec.status, 200);
    assert.equal(spec.body.resolution.scaleFactor, 4);
    assert.equal(spec.body.resolution.voxelStepMeters, 0.05);
    assert.deepEqual(spec.body.areaLimits.maxBlocksPerAxis, [10000, 10000, 10000]);
    assert.equal(spec.body.availableColors.length, 12);
    assert.deepEqual(
      spec.body.availableBlocks.map((b) => b.material),
      ['matte', 'neon', 'glass']
    );
    assert.equal(spec.body.rules.agentCanStageOnly, true);
    assert.equal(spec.body.rules.userMustPublishOnDevice, true);

    const login = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: {
          email: 'bounds-tester@graffiland.test',
          name: 'Bounds Tester'
        }
      })
    });
    assert.equal(login.status, 200);
    const bearer = login.body.token;

    const outOfBounds = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'Too Tall Spire',
        description: 'Testing bounds exceeding ten thousand blocks tall.',
        termsAccepted: true,
        location: { lat: 37.7749, lng: -122.4194, altitude: 10, accuracy: 8 },
        pol: {
          frameCount: 6,
          gyroSamples: 8,
          cameraFingerprint: 'ok',
          skyLuminance: 0.5,
          flowScore: 0.7
        },
        voxels: [
          { x: 0, y: -250, z: 0, color: '#00f5d4', material: 'matte' },
          { x: 0, y: 250, z: 0, color: '#ff3e7f', material: 'neon' }
        ]
      })
    });
    assert.equal(outOfBounds.status, 400);
    assert.match(outOfBounds.body.error, /10000x10000x10000|bounds/i);
  });

  test('Agent Sculpture Code stages 3D build without auto-publishing', async () => {
    const createRes = await apiJson('/api/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({
        location: { lat: 37.7791, lng: -122.4192, altitude: 22.4, accuracy: 6 }
      })
    });
    assert.equal(createRes.status, 201);
    assert.match(createRes.body.code, /^GRF-[A-Z2-9]+$/);
    assert.ok(createRes.body.clipboardText.includes(createRes.body.code));
    assert.ok(createRes.body.endpoints.spec.includes('/api/agent/spec'));

    const code = createRes.body.code;
    const beforePoll = await apiJson(`/api/agent/sessions/${code}`);
    assert.equal(beforePoll.status, 200);
    assert.equal(beforePoll.body.session.status, 'waiting');
    assert.equal(beforePoll.body.spec.availableColors.length, 12);

    const invalidBounds = await apiJson(`/api/agent/sessions/${code}/sculpture`, {
      method: 'POST',
      body: JSON.stringify({
        agentName: 'GrokBot',
        voxels: [{ x: 300, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(invalidBounds.status, 400);

    const stageRes = await apiJson(`/api/agent/sessions/${code}/sculpture`, {
      method: 'POST',
      body: JSON.stringify({
        agentName: 'GrokBot',
        title: 'Agent Neon Crown',
        description: 'Four-times finer crown floating above Civic Plaza.',
        voxels: [
          { x: 0.05, y: 0.1, z: -0.05, color: '#00f5d4', material: 'neon' },
          { x: 0.1, y: 0.15, z: -0.05, color: '#ff3e7f', material: 'glass', scale: 1 }
        ]
      })
    });
    assert.equal(stageRes.status, 200);
    assert.equal(stageRes.body.ok, true);
    assert.equal(stageRes.body.session.status, 'ready');
    assert.equal(stageRes.body.session.voxelCount, 2);
    assert.equal(stageRes.body.session.agentName, 'GrokBot');

    const afterPoll = await apiJson(`/api/agent/sessions/${code}`);
    assert.equal(afterPoll.status, 200);
    assert.equal(afterPoll.body.session.status, 'ready');
    assert.equal(afterPoll.body.session.draftVoxels.length, 2);

    const list = await apiJson('/api/sculptures');
    assert.equal(list.status, 200);
    assert.equal(
      list.body.sculptures.some((s) => s.title === 'Agent Neon Crown'),
      false
    );
  });
});
