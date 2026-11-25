import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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

async function exportWalletWithPasskey(token) {
  const b64u = (bytes) =>
    Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  );
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', keyPair.publicKey));
  const credentialId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const regOpts = await apiJson('/api/passkeys/register/options', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(regOpts.status, 200);
  const regVerify = await apiJson('/api/passkeys/register/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      credentialId,
      publicKeySpkiB64: b64u(spki),
      clientDataJSON: b64u(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: regOpts.body.challenge,
            origin: baseUrl
          })
        )
      ),
      deviceLabel: 'Test Export Passkey'
    })
  });
  assert.equal(regVerify.status, 200);

  const ch = await apiJson('/api/wallet/export/challenge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(ch.status, 200);

  const rpHash = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(regOpts.body.rp.id))
  );
  const authData = new Uint8Array(37);
  authData.set(rpHash, 0);
  authData[32] = 0x05;
  new DataView(authData.buffer).setUint32(33, 1, false);
  const clientDataBytes = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.get', challenge: ch.body.challenge, origin: baseUrl })
  );
  const clientHash = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', clientDataBytes)
  );
  const payload = new Uint8Array(authData.length + clientHash.length);
  payload.set(authData, 0);
  payload.set(clientHash, authData.length);
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      payload
    )
  );
  return apiJson('/api/wallet/export', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      challenge: ch.body.challenge,
      assertion: {
        credentialId,
        clientDataJSON: b64u(clientDataBytes),
        authenticatorData: b64u(authData),
        signature: b64u(sig)
      }
    })
  });
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

// Realistic client sensor evidence (the mobile client always sends GPS samples + camera frames).
function polEvidenceAt(lat, lng) {
  const now = Date.now();
  return {
    cameraFrames: 6,
    gpsSamples: [
      { lat, lng, t: now - 3000 },
      { lat: lat + 0.00001, lng: lng + 0.00001, t: now - 500 }
    ]
  };
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
    desktopWs.send(
      JSON.stringify({ type: 'desktop_command', action: 'set_color', color: '#ff3e7f' })
    );
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
      body: JSON.stringify({
        devProfile: { email: 'test-artist@graffiland.local', name: 'Test Artist' }
      })
    });
    const creatorUser = creatorAuth.body.user;

    const visAAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'visitorA@graffiland.local', name: 'Visitor A' }
      })
    });
    const visBAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'visitorB@graffiland.local', name: 'Visitor B' }
      })
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

    // 7. Single shared chat per land: a second sculpture on the SAME parcel shares the exact same chat board & messages
    const sharedLat = singleSc.body.sculpture.lat;
    const sharedLng = singleSc.body.sculpture.lng;
    const secondScRes = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${visBAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Second Piece On Same Land',
        description: 'Verifies one shared land chat across all artworks on this parcel.',
        termsAccepted: true,
        location: { lat: sharedLat, lng: sharedLng, altitude: 16, accuracy: 4, heading: 90 },
        voxels: [
          { x: 0.6, y: 0, z: 0.6, color: '#ff006e', material: 'neon' },
          { x: 0.6, y: 0.2, z: 0.6, color: '#ffd166', material: 'neon' },
          { x: 0.6, y: 0.4, z: 0.6, color: '#00f5d4', material: 'neon' }
        ],
        proofOfLocation: {
          ...polEvidenceAt(sharedLat, sharedLng),
          gyroSamples: 20,
          opticalFlowCorrelation: 0.9,
          sceneCoveragePct: 100
        },
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 }
      })
    });
    assert.equal(secondScRes.status, 201, JSON.stringify(secondScRes.body));
    const secondScId = secondScRes.body.sculpture.id;
    const sharedParcelId = singleSc.body.sculpture.parcelId;
    assert.equal(secondScRes.body.sculpture.parcelId, sharedParcelId);

    // Entering chat via the 2nd sculpture OR directly via parcelId resolves to the SAME canonical land board & messages!
    const enterViaSecond = await apiJson(`/api/sculptures/${secondScId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visBAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: visBId.pubFingerprint,
        sightProof: await makeSightProof(visBId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(enterViaSecond.status, 200);
    assert.equal(enterViaSecond.body.initialized, true);
    assert.equal(enterViaSecond.body.boardId, createdSculptureId);
    assert.equal(enterViaSecond.body.board.sculptureId, createdSculptureId);
    assert.equal(enterViaSecond.body.messages.length, 2);

    const enterViaParcel = await apiJson(`/api/sculptures/${sharedParcelId}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visBAuth.body.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: visBId.pubFingerprint,
        sightProof: await makeSightProof(visBId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(enterViaParcel.status, 200);
    assert.equal(enterViaParcel.body.boardId, createdSculptureId);
    assert.equal(enterViaParcel.body.messages.length, 2);

    // Second sculpture metadata also reports the land's shared chat message count (2)
    const secondScMeta = await apiJson(`/api/sculptures/${secondScId}`);
    assert.equal(secondScMeta.status, 200);
    assert.equal(secondScMeta.body.sculpture.chatSummary.initialized, true);
    assert.equal(secondScMeta.body.sculpture.chatSummary.messageCount, 2);
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
    assert.ok(
      tokenMeta.body.animation_url.endsWith(`/api/sculptures/${createdSculptureId}/model.glb`)
    );
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
    assert.equal(cfg.body.policy.humanMaxDrawSpanFeet, 250);
    assert.equal(cfg.body.policy.humanMaxDrawSpanMeters, 76.2);

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

    // Human drawings exceeding 250ft x 250ft (76.2m x 76.2m) horizontal footprint must be rejected
    const tooWideHuman = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'Over 250ft Mural',
        description: 'Testing human drawing bounds exceeding 250ft wide.',
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
          { x: -38.5, y: 0, z: 0, color: '#00f5d4', material: 'matte' },
          { x: 38.5, y: 0, z: 0, color: '#ff3e7f', material: 'neon' }
        ]
      })
    });
    assert.equal(tooWideHuman.status, 400);
    assert.match(tooWideHuman.body.error, /250ft x 250ft/i);
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

  test('User sculpture drafts auto-save, enforce ownership, and clear on publish', async () => {
    const unauth = await apiJson('/api/drafts');
    assert.equal(unauth.status, 401);

    const loginA = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'draft-artist-a@graffiland.test', name: 'Draft Artist A' }
      })
    });
    assert.equal(loginA.status, 200);
    const tokenA = loginA.body.token;

    const loginB = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'draft-artist-b@graffiland.test', name: 'Draft Artist B' }
      })
    });
    assert.equal(loginB.status, 200);
    const tokenB = loginB.body.token;

    const badDraft = await apiJson('/api/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        title: 'Out of Bounds Draft',
        voxels: [{ x: 300, y: 0, z: 0, color: '#00f5d4', material: 'matte' }]
      })
    });
    assert.equal(badDraft.status, 400);

    const saveRes = await apiJson('/api/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        title: 'WIP Civic Arch',
        description: 'Work in progress saved before finishing the top arch.',
        source: 'auto',
        location: { lat: 37.775, lng: -122.419, altitude: 18 },
        surfaceAnchor: {
          x: 0,
          y: -0.6,
          z: -1.5,
          nx: 0,
          ny: 1,
          nz: 0,
          depthM: 1.5,
          label: 'Floor',
          source: 'surface',
          sharpnessScore: 0.72,
          locked: true
        },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'neon' }
        ]
      })
    });
    assert.equal(saveRes.status, 200);
    assert.ok(saveRes.body.draft.id.startsWith('draft_'));
    assert.equal(saveRes.body.draft.voxelCount, 2);
    assert.equal(saveRes.body.draft.surfaceAnchor.label, 'Floor');

    const draftId = saveRes.body.draft.id;

    // Update same draft in place
    const updateRes = await apiJson('/api/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        id: draftId,
        title: 'WIP Civic Arch v2',
        description: 'Added third neon block on top.',
        source: 'manual',
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'neon' },
          { x: 0, y: 0.1, z: 0, color: '#ffd166', material: 'glass' }
        ]
      })
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.draft.id, draftId);
    assert.equal(updateRes.body.draft.voxelCount, 3);
    assert.equal(updateRes.body.draft.title, 'WIP Civic Arch v2');

    // Cross-user isolation
    const listB = await apiJson('/api/drafts', {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.equal(listB.status, 200);
    assert.equal(listB.body.drafts.length, 0);

    const peekB = await apiJson(`/api/drafts/${draftId}`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.equal(peekB.status, 403);

    const deleteB = await apiJson(`/api/drafts/${draftId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.equal(deleteB.status, 403);

    // Owner publishes draft and verifies it is consumed automatically
    const pubRes = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        draftId,
        title: 'Finished Civic Arch',
        description: 'Completed 4x street sculpture originally saved as a WIP draft.',
        termsAccepted: true,
        location: { lat: 37.775, lng: -122.419, altitude: 18, accuracy: 6 },
        proofOfLocation: {
          ...polEvidenceAt(37.775, -122.419),
          frameHashes: ['aaa111', 'bbb222', 'ccc333', 'ddd444'],
          gyroSamples: [
            { alpha: 10, beta: 20, gamma: 1 },
            { alpha: 14, beta: 22, gamma: 2 }
          ],
          flowCorrelation: 0.79,
          skyPalette: ['#00f5d4', '#ff3e7f'],
          visualDHash: '1010101010101010',
          frameCount: 6,
          flowScore: 0.79
        },
        voxels: updateRes.body.draft.voxels
      })
    });
    assert.equal(pubRes.status, 201);

    const afterPublishList = await apiJson('/api/drafts', {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.equal(afterPublishList.status, 200);
    assert.equal(
      afterPublishList.body.drafts.some((d) => d.id === draftId),
      false
    );
  });

  test('Property ownership land editing, active-pairing MCP gate, and two-way agent/mobile signing', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile';

    // Login owner & stranger
    const ownerLogin = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'landowner@graffiland.test', name: 'Landowner Alice' }
      })
    });
    assert.equal(ownerLogin.status, 200);
    const ownerToken = ownerLogin.body.token;

    const outsiderLogin = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'outsider@graffiland.test', name: 'Outsider Bob' }
      })
    });
    assert.equal(outsiderLogin.status, 200);
    const outsiderToken = outsiderLogin.body.token;

    const samplePol = {
      frameHashes: ['f101', 'f202', 'f303', 'f404'],
      gyroSamples: [
        { alpha: 10, beta: 15, gamma: 2 },
        { alpha: 18, beta: 16, gamma: 3 }
      ],
      flowCorrelation: 0.85,
      skyPalette: ['#00f5d4', '#ffd166'],
      visualDHash: '1110001110001110',
      frameCount: 8,
      flowScore: 0.85
    };
    const landLat = 37.7812;
    const landLng = -122.4115;

    // 1. Owner publishes initial sculpture claiming the Virtual Land parcel
    const pub = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Founding Beacon',
        description: 'First sculpture staking property on this land parcel.',
        termsAccepted: true,
        location: { lat: landLat, lng: landLng, altitude: 14, accuracy: 5 },
        proofOfLocation: { ...samplePol, ...polEvidenceAt(landLat, landLng) },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(pub.status, 201);
    const sId = pub.body.sculpture.id;
    const parcelId = pub.body.sculpture.parcelId;

    // Non-owner cannot edit or place sculptures on this land
    const outsiderEdit = await apiJson(`/api/sculptures/${sId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${outsiderToken}` },
      body: JSON.stringify({ title: 'Hijacked Piece' })
    });
    assert.equal(outsiderEdit.status, 403);

    const outsiderPut = await apiJson(`/api/lands/${parcelId}/sculptures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsiderToken}` },
      body: JSON.stringify({
        title: 'Intruder Sculpture',
        description: 'Should be rejected for non-owner.',
        voxels: [{ x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'matte' }]
      })
    });
    assert.equal(outsiderPut.status, 403);

    // 2. Owner edits sculpture directly & puts a second sculpture directly on their owned land + curates land
    const directEdit = await apiJson(`/api/sculptures/${sId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        title: 'Founding Beacon v2',
        description: 'Updated directly by the verified landowner.'
      })
    });
    assert.equal(directEdit.status, 200);
    assert.equal(directEdit.body.sculpture.title, 'Founding Beacon v2');

    const directLandUpdate = await apiJson(`/api/lands/${parcelId}/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        customName: 'Alice Plaza',
        curationNote: 'Open 3D sculpture corner curated by Alice.',
        featuredSculptureId: sId
      })
    });
    assert.equal(directLandUpdate.status, 200);
    assert.equal(directLandUpdate.body.parcel.customName, 'Alice Plaza');

    const directPut = await apiJson(`/api/lands/${parcelId}/sculptures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        title: 'Plaza Arch',
        description: 'Second sculpture placed onto owned land directly.',
        voxels: [{ x: 0.05, y: 0, z: 0, color: '#ffd166', material: 'glass' }]
      })
    });
    assert.equal(directPut.status, 200);
    assert.equal(directPut.body.sculpture.parcelId, parcelId);

    // 3. Robust MCP Pairing Gate: MCP MUST reject until connected
    const pairCreate = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(pairCreate.status, 200);
    const pairingCode = pairCreate.body.pairing.code;
    assert.match(pairingCode, /^GLP-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    assert.equal(pairCreate.body.pairing.status, 'pending');

    const mcpBeforeConnect = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(mcpBeforeConnect.status, 403);
    assert.match(mcpBeforeConnect.body.error.message, /inactive/i);

    // Subscribe mobile WS listener for live signature push
    const wsPushEvents = [];
    const subWs = new WebSocket(wsUrl);
    await new Promise((resolve) => subWs.on('open', resolve));
    subWs.on('message', (raw) => {
      try {
        wsPushEvents.push(JSON.parse(raw.toString('utf8')));
      } catch {
        // ignore
      }
    });
    subWs.send(JSON.stringify({ type: 'subscribe_mcp', pairingCode }));
    await new Promise((r) => setTimeout(r, 80));

    // Agent connects using matching robust pairing code
    const pairConn = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({ pairingCode, agentName: 'AliceMcpAgent' })
    });
    assert.equal(pairConn.status, 200);
    assert.equal(pairConn.body.mcpActive, true);

    const mcpToolsRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    assert.equal(mcpToolsRes.status, 200);
    assert.ok(mcpToolsRes.body.result.tools.some((t) => t.name === 'put_sculpture_on_land'));

    // 4. Paired agent updates sculpture WITHOUT private key -> sends mobile notification for signature
    const unsignedMcpUpdate = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'update_land_sculpture',
          arguments: {
            sculptureId: sId,
            title: 'Founding Beacon (Mobile Approved)'
          }
        }
      })
    });
    assert.equal(unsignedMcpUpdate.status, 200);
    const pendingContent = unsignedMcpUpdate.body.result.structuredContent;
    assert.equal(pendingContent.status, 'pending_mobile_signature');
    assert.equal(pendingContent.requiresMobileSignature, true);

    // Mobile receives both HTTP pending queue & WS notification
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(
      wsPushEvents.some(
        (e) => e.type === 'signature_request' && e.request?.id === pendingContent.request.id
      )
    );
    const mobilePending = await apiJson('/api/signatures/pending', {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(mobilePending.status, 200);
    assert.ok(mobilePending.body.requests.some((r) => r.id === pendingContent.request.id));

    // Mobile signs & approves
    const mobileSign = await apiJson(
      `/api/signatures/requests/${pendingContent.request.id}/mobile-sign`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }
    );
    assert.equal(mobileSign.status, 200);
    assert.equal(mobileSign.body.request.status, 'executed');
    assert.equal(mobileSign.body.request.signedBy, 'mobile-wallet');
    assert.equal(mobileSign.body.result.sculpture.title, 'Founding Beacon (Mobile Approved)');

    // 5. Agent holds owner private key & signs transaction directly from agent side!
    const exportedKeyRes = await exportWalletWithPasskey(ownerToken);
    assert.equal(exportedKeyRes.status, 200);
    const agentWallet = new ethers.Wallet(exportedKeyRes.body.privateKey);

    const agentQueuePut = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'put_sculpture_on_land',
          arguments: {
            parcelId,
            title: 'Agent Key Signed Tower',
            description: 'Signed directly on the agent side with matching owner key.',
            voxels: [{ x: 0, y: 0.1, z: 0, color: '#80ff72', material: 'neon' }]
          }
        }
      })
    });
    assert.equal(agentQueuePut.status, 200);
    const putReq = agentQueuePut.body.result.structuredContent.request;
    const agentPutSig = await agentWallet.signMessage(putReq.canonicalMessage);

    const agentSignExec = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'sign_and_execute_pending',
          arguments: {
            requestId: putReq.id,
            signature: agentPutSig
          }
        }
      })
    });
    assert.equal(agentSignExec.status, 200);
    const execPut = agentSignExec.body.result.structuredContent;
    assert.equal(execPut.ok, true);
    assert.equal(execPut.request.status, 'executed');
    assert.equal(execPut.request.signedBy, 'agent-key');
    assert.equal(execPut.result.sculpture.parcelId, parcelId);

    // 6. Mobile chooses "Copy Agent Sign & Publish Prompt" when keys/pairing connected -> agent signs publish!
    const pubReqRes = await apiJson('/api/signatures/requests', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        pairingCode,
        title: 'Delegated Publish Art',
        description: 'Captured on mobile then signed by paired agent on user behalf.',
        termsAccepted: true,
        location: { lat: landLat, lng: landLng, altitude: 14, accuracy: 5 },
        proofOfLocation: { ...samplePol, ...polEvidenceAt(landLat, landLng) },
        voxels: [{ x: 0, y: 0, z: 0.05, color: '#ff3e7f', material: 'neon' }]
      })
    });
    assert.equal(pubReqRes.status, 201);
    assert.ok(pubReqRes.body.promptText.includes(pubReqRes.body.request.id));
    const delegatedSig = await agentWallet.signMessage(pubReqRes.body.request.canonicalMessage);

    const agentSignedPub = await apiJson(
      `/api/signatures/requests/${pubReqRes.body.request.id}/agent-sign`,
      {
        method: 'POST',
        body: JSON.stringify({
          pairingCode,
          signature: delegatedSig,
          agentName: 'AliceMcpAgent'
        })
      }
    );
    assert.equal(agentSignedPub.status, 200);
    assert.equal(agentSignedPub.body.request.status, 'executed');
    assert.equal(agentSignedPub.body.result.sculpture.title, 'Delegated Publish Art');

    // 7. Disconnecting pairing immediately deactivates MCP service for user
    const disc = await apiJson(`/api/mcp/pairings/${pairingCode}/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(disc.status, 200);
    assert.equal(disc.body.mcpActive, false);

    const mcpAfterDisc = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} })
    });
    assert.equal(mcpAfterDisc.status, 403);

    subWs.close();
  });

  test('Land holder pins updatable encrypted IPFS message batches unlocked only by unspoofable physical parcel presence', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
    const holderAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'pin-holder@graffiland.test', name: 'Pin Holder' }
      })
    });
    const visitorAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'pin-visitor@graffiland.test', name: 'Pin Visitor' }
      })
    });
    const thiefAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'pin-thief@graffiland.test', name: 'Challenge Thief' }
      })
    });
    assert.equal(holderAuth.status, 200);
    assert.equal(visitorAuth.status, 200);
    assert.equal(thiefAuth.status, 200);

    const holderToken = holderAuth.body.token;
    const visitorToken = visitorAuth.body.token;
    const thiefToken = thiefAuth.body.token;
    const holderId = await chatCrypto.getOrCreateDeviceIdentity(holderAuth.body.user.id);
    const visitorId = await chatCrypto.getOrCreateDeviceIdentity(visitorAuth.body.user.id);

    const parcelLat = 37.7655;
    const parcelLng = -122.4321;
    const samplePol = {
      frameHashes: ['p11', 'p22', 'p33', 'p44'],
      gyroSamples: [
        { alpha: 12, beta: 14, gamma: 4 },
        { alpha: 20, beta: 16, gamma: 6 }
      ],
      flowCorrelation: 0.87,
      visualDHash: 'a1b2c3d4e5f60718',
      frameCount: 6,
      flowScore: 0.87
    };

    // 1. Land holder publishes sculpture claiming the parcel
    const pub = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'IPFS Pin Vault Sculpture',
        description: 'Stores encrypted pinned IPFS batch unlockable only on this parcel.',
        termsAccepted: true,
        location: { lat: parcelLat, lng: parcelLng, altitude: 22, accuracy: 5 },
        proofOfLocation: { ...samplePol, ...polEvidenceAt(parcelLat, parcelLng) },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(pub.status, 201);
    const pinSc = pub.body.sculpture;

    // 2. Non-land-holder cannot obtain owner seal
    const nonOwnerSeal = await apiJson(`/api/sculptures/${pinSc.id}/pins/owner-seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}` },
      body: JSON.stringify({})
    });
    assert.equal(nonOwnerSeal.status, 403);

    // 3. Land holder obtains owner seal & rejects plaintext submissions
    const sealRes = await apiJson(`/api/sculptures/${pinSc.id}/pins/owner-seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({})
    });
    assert.equal(sealRes.status, 200);
    assert.ok(sealRes.body.parcelSealKeyB64);
    assert.equal(sealRes.body.nextBatchSeq, 1);

    const plainReject = await apiJson(`/api/sculptures/${pinSc.id}/pins/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ text: 'Unencrypted secret leak!' })
    });
    assert.equal(plainReject.status, 400);

    // 4. Land holder encrypts batch v1 client-side & pins to IPFS; verify zero plaintext leaks anywhere
    const v1Secret = 'Secret meetup behind the cedar mural at 21:00!';
    const batchV1 = await chatCrypto.encryptPinnedIpfsBatch({
      pins: [
        {
          id: 'pin-v1-a',
          text: v1Secret,
          authorName: holderAuth.body.user.name,
          authorAddress: holderAuth.body.user.walletAddress
        }
      ],
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash,
      batchSeq: sealRes.body.nextBatchSeq,
      parcelSealKeyB64: sealRes.body.parcelSealKeyB64,
      identity: holderId
    });
    const saveV1 = await apiJson(`/api/sculptures/${pinSc.id}/pins/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ encryptedBatch: batchV1 })
    });
    assert.equal(saveV1.status, 200);
    assert.equal(saveV1.body.meta.hasPins, true);
    assert.equal(saveV1.body.meta.batchSeq, 1);
    assert.equal(saveV1.body.meta.pinCount, 1);
    const cidV1 = saveV1.body.ipfs.cid;
    assert.ok(cidV1);

    const ipfsRawV1 = await fetch(`${baseUrl}/ipfs/${cidV1}`).then((r) => r.text());
    assert.equal(ipfsRawV1.includes(v1Secret), false);
    assert.ok(JSON.parse(ipfsRawV1).ciphertextB64);

    const detailRes = await apiJson(`/api/sculptures/${pinSc.id}`);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.sculpture.pinSummary.batchSeq, 1);
    assert.equal(detailRes.body.sculpture.pinSummary.ipfsCid, cidV1);
    assert.equal(JSON.stringify(detailRes.body).includes(v1Secret), false);
    assert.equal(JSON.stringify(detailRes.body).includes(sealRes.body.parcelSealKeyB64), false);

    // 5. Enter chat returns isLandHolder flag + pinMeta cleanly
    const sightMaker = async (idObj, overrides = {}) => {
      const base = {
        selectionMethod: 'ar-camera-raycast',
        rayHit: true,
        inFrustum: true,
        cameraReady: true,
        cameraFrames: 6,
        opticalFlowCorrelation: 0.85,
        visualDHash: 'f0e1d2c3b4a59687',
        accuracy: 6,
        lat: parcelLat,
        lng: parcelLng,
        altitude: 22,
        selectedAt: new Date().toISOString(),
        ...overrides
      };
      return chatCrypto.signSightProof(idObj, {
        sculptureId: pinSc.id,
        parcelId: pinSc.parcelId,
        sightProof: base
      });
    };

    const enterHolder = await apiJson(`/api/sculptures/${pinSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        sightProof: await sightMaker(holderId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(enterHolder.status, 200);
    assert.equal(enterHolder.body.isLandHolder, true);
    assert.equal(enterHolder.body.pinMeta.ipfsCid, cidV1);

    // 6. Enforce anti-spoofing defenses on unlock
    const desktopChallenge = await apiJson(`/api/sculptures/${pinSc.id}/pins/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}` },
      body: JSON.stringify({ deviceProfile: { isMobile: false } })
    });
    assert.equal(desktopChallenge.status, 403);

    const ch1Res = await apiJson(`/api/sculptures/${pinSc.id}/pins/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ deviceProfile: { isMobile: true } })
    });
    assert.equal(ch1Res.status, 200);

    const goodPolSnap = {
      cameraFrames: 6,
      visualDHash: 'f0e1d2c3b4a59687',
      gyroSamples: [
        { alpha: 5, beta: 10, gamma: 2 },
        { alpha: 11, beta: 12, gamma: 3 }
      ],
      opticalFlowCorrelation: 0.82,
      gpsSamples: [
        { lat: parcelLat, lng: parcelLng, accuracy: 6, t: Date.now() - 2000 },
        { lat: parcelLat + 0.00001, lng: parcelLng + 0.00001, accuracy: 5, t: Date.now() }
      ]
    };

    // Wrong parcel / off-site GPS rejected (403)
    const offSiteSight = await sightMaker(visitorId, { lat: parcelLat + 0.003, lng: parcelLng });
    const offSiteSigned = await chatCrypto.signParcelPresenceProof(visitorId, {
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash,
      challengeId: ch1Res.body.challengeId,
      challengeNonce: ch1Res.body.challengeNonce,
      sightProof: offSiteSight,
      polSnapshot: goodPolSnap
    });
    const offSiteUnlock = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...offSiteSigned, deviceProfile: { isMobile: true } })
    });
    assert.equal(offSiteUnlock.status, 403);

    // Low camera/gyro motion telemetry rejected (403)
    const onSiteSight = await sightMaker(visitorId);
    const lowSensorPol = { ...goodPolSnap, opticalFlowCorrelation: 0.05, cameraFrames: 1 };
    const lowSensorSight = await sightMaker(visitorId, {
      cameraFrames: 1,
      opticalFlowCorrelation: 0.05
    });
    const lowSensorSigned = await chatCrypto.signParcelPresenceProof(visitorId, {
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash,
      challengeId: ch1Res.body.challengeId,
      challengeNonce: ch1Res.body.challengeNonce,
      sightProof: lowSensorSight,
      polSnapshot: lowSensorPol
    });
    const lowSensorUnlock = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...lowSensorSigned, deviceProfile: { isMobile: true } })
    });
    assert.equal(lowSensorUnlock.status, 403);

    // Tampered ECDSA presence signature rejected (403)
    const legitSigned = await chatCrypto.signParcelPresenceProof(visitorId, {
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash,
      challengeId: ch1Res.body.challengeId,
      challengeNonce: ch1Res.body.challengeNonce,
      sightProof: onSiteSight,
      polSnapshot: goodPolSnap
    });
    const forgedUnlock = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...legitSigned,
        presenceSignatureB64: btoa('forged-ecdsa-signature-bytes'),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(forgedUnlock.status, 403);

    // Wrong user attempting to use visitor's challenge rejected (403)
    const stolenChallengeUnlock = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${thiefToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...legitSigned, deviceProfile: { isMobile: true } })
    });
    assert.equal(stolenChallengeUnlock.status, 403);

    // 7. Legitimate in-parcel visitor unlocks & decrypts v1 IPFS batch cleanly!
    const validUnlock = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...legitSigned, deviceProfile: { isMobile: true } })
    });
    assert.equal(validUnlock.status, 200, JSON.stringify(validUnlock.body));
    assert.equal(validUnlock.body.unlocked, true);
    const decV1 = await chatCrypto.decryptPinnedIpfsBatch({
      encryptedBatch: validUnlock.body.encryptedBatch,
      parcelSealKeyB64: validUnlock.body.parcelSealKeyB64,
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash
    });
    assert.equal(decV1.pins.length, 1);
    assert.equal(decV1.pins[0].text, v1Secret);
    assert.equal(decV1.sigVerified, true);

    // Replay of consumed single-use challenge MUST fail (403)
    const replayUnlock = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...legitSigned, deviceProfile: { isMobile: true } })
    });
    assert.equal(replayUnlock.status, 403);

    // 8. Land holder alters/updates the pinned messages -> new IPFS CID v2 -> visitor decrypts updated batch
    const v2Secret = 'UPDATED: Meetup moved to North Plaza Fountain at 22:00!';
    const v2Second = 'Bring warm neon glowsticks.';
    const batchV2 = await chatCrypto.encryptPinnedIpfsBatch({
      pins: [
        { id: 'pin-v1-a', text: v2Secret, authorName: holderAuth.body.user.name },
        { id: 'pin-v2-b', text: v2Second, authorName: holderAuth.body.user.name }
      ],
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash,
      batchSeq: 2,
      parcelSealKeyB64: sealRes.body.parcelSealKeyB64,
      identity: holderId
    });
    const saveV2 = await apiJson(`/api/sculptures/${pinSc.id}/pins/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ encryptedBatch: batchV2 })
    });
    assert.equal(saveV2.status, 200);
    assert.equal(saveV2.body.meta.batchSeq, 2);
    assert.equal(saveV2.body.meta.pinCount, 2);
    assert.notEqual(saveV2.body.ipfs.cid, cidV1);

    const ch2Res = await apiJson(`/api/sculptures/${pinSc.id}/pins/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ deviceProfile: { isMobile: true } })
    });
    assert.equal(ch2Res.status, 200);
    const signedV2 = await chatCrypto.signParcelPresenceProof(visitorId, {
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash,
      challengeId: ch2Res.body.challengeId,
      challengeNonce: ch2Res.body.challengeNonce,
      sightProof: await sightMaker(visitorId),
      polSnapshot: goodPolSnap
    });
    const unlockV2 = await apiJson(`/api/sculptures/${pinSc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...signedV2, deviceProfile: { isMobile: true } })
    });
    assert.equal(unlockV2.status, 200);
    const decV2 = await chatCrypto.decryptPinnedIpfsBatch({
      encryptedBatch: unlockV2.body.encryptedBatch,
      parcelSealKeyB64: unlockV2.body.parcelSealKeyB64,
      sculptureId: pinSc.id,
      parcelId: pinSc.parcelId,
      geohash: pinSc.geohash
    });
    assert.equal(decV2.batchSeq, 2);
    assert.deepEqual(
      decV2.pins.map((p) => p.text),
      [v2Secret, v2Second]
    );
  });

  test('MCP non-voxel 3D model loading, IRL chat Contributors, Land Management & authorized agent erase_land', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';
    const holderAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'm3d-holder@graffiland.test', name: 'Land Boss' }
      })
    });
    const visitorAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'm3d-visitor@graffiland.test', name: 'IRL Contributor' }
      })
    });
    const strangerAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'm3d-stranger@graffiland.test', name: 'Desktop Stranger' }
      })
    });
    assert.equal(holderAuth.status, 200);
    assert.equal(visitorAuth.status, 200);
    assert.equal(strangerAuth.status, 200);

    const holderToken = holderAuth.body.token;
    const visitorToken = visitorAuth.body.token;
    const strangerToken = strangerAuth.body.token;

    const holderWalletRes = await exportWalletWithPasskey(holderToken);
    const holderSigner = new ethers.Wallet(holderWalletRes.body.privateKey);

    const samplePol = {
      frameHashes: ['a1', 'a2', 'a3', 'a4'],
      gyroSamples: [
        { alpha: 10, beta: 12, gamma: 4 },
        { alpha: 18, beta: 14, gamma: 6 }
      ],
      flowCorrelation: 0.89,
      visualDHash: 'fedcba9876543210',
      frameCount: 6,
      flowScore: 0.89
    };
    const mLat = 37.7521;
    const mLng = -122.4412;

    // 1. Holder publishes first land -> GET /api/lands/mine immediately exposes Land Management workspace
    const pubRes = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Voxel Cornerstone',
        description: 'Claims initial Virtual Land before loading custom 3D mesh.',
        termsAccepted: true,
        location: { lat: mLat, lng: mLng, altitude: 18, accuracy: 5 },
        proofOfLocation: { ...samplePol, ...polEvidenceAt(mLat, mLng) },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(pubRes.status, 201);
    const seedSc = pubRes.body.sculpture;
    const parcelId = seedSc.parcelId;

    const myLands1 = await apiJson('/api/lands/mine', {
      headers: { Authorization: `Bearer ${holderToken}` }
    });
    assert.equal(myLands1.status, 200);
    assert.equal(myLands1.body.parcelCount, 1);
    assert.equal(myLands1.body.parcels[0].parcelId, parcelId);

    // 2. Connect paired MCP agent & verify non-3D files rejected while valid .obj and .glb load via MCP
    const pairCreate = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` }
    });
    const pairingCode = pairCreate.body.pairing.code;
    const connRes = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({
        pairingCode,
        agentName: '3DModelAgent',
        agentAddress: holderSigner.address
      })
    });
    assert.equal(connRes.status, 200);
    const hsSig = await holderSigner.signMessage(connRes.body.handshakeMessage);
    await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({ pairingCode, signature: hsSig })
    });

    // Reject bogus/unsuitable binary posing as .glb
    const badModelRpc = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'load_3d_model_on_land',
          arguments: {
            parcelId,
            title: 'Corrupt Mesh',
            description: 'Should fail validation cleanly.',
            modelFormat: 'glb',
            modelBase64: btoa('NOT_A_GLB_FILE_HEADER')
          }
        }
      })
    });
    assert.equal(badModelRpc.status, 400);

    // Load a non-voxel Wavefront OBJ 3D pyramid via load_3d_model_on_land (signed by agent)
    const objMeshText = [
      '# GRAFFILAND Non-Voxel Pyramid',
      'v 0 1.2 0',
      'v -0.8 0 0.8',
      'v 0.8 0 0.8',
      'v 0 0 -0.8',
      'f 1 2 3',
      'f 1 3 4',
      'f 1 4 2',
      'f 2 4 3'
    ].join('\n');

    // Guardrail check: placing an oversized OBJ (1.6×1.2×1.6m × 1.3 = 2.08m) onto a 0.6×0.6×0.6m land is hard-rejected (409) immediately at MCP preflight with exact maxSafeScale!
    const oversizedStep1 = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'load_3d_model_on_land',
          arguments: {
            parcelId,
            title: 'Obsidian OBJ Pyramid',
            description: 'Non-voxel Wavefront OBJ 3D mesh loaded onto owned parcel via MCP.',
            modelFormat: 'obj',
            modelData: objMeshText,
            modelScale: 1.3
          }
        }
      })
    });
    assert.equal(oversizedStep1.status, 409, JSON.stringify(oversizedStep1.body));
    const maxFitScale = Number(oversizedStep1.body?.error?.data?.maxSafeScale || 0);
    assert.equal(oversizedStep1.body?.error?.data?.code, 'exceeds_land_bounds');
    assert.ok(maxFitScale > 0 && maxFitScale < 0.4, `Expected exact maxSafeScale, got ${maxFitScale}`);

    // Retrying with modelScale <= maxSafeScale succeeds cleanly (leaving room for a sibling artwork too)!
    const objStep1 = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'load_3d_model_on_land',
          arguments: {
            parcelId,
            title: 'Obsidian OBJ Pyramid',
            description: 'Non-voxel Wavefront OBJ 3D mesh loaded onto owned parcel via MCP.',
            modelFormat: 'obj',
            modelData: objMeshText,
            modelScale: Math.min(0.1, maxFitScale)
          }
        }
      })
    });
    assert.equal(objStep1.status, 200);
    const objReq = objStep1.body.result.structuredContent.request;
    const objSig = await holderSigner.signMessage(objReq.canonicalMessage);
    const objExec = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'sign_and_execute_pending',
          arguments: { requestId: objReq.id, signature: objSig }
        }
      })
    });
    assert.equal(objExec.status, 200, JSON.stringify(objExec.body));
    const objSc = objExec.body.result.structuredContent.result.sculpture;
    assert.equal(objSc.modelType, 'custom-3d');
    assert.equal(objSc.customModel.format, 'obj');
    assert.equal(objSc.voxelCount, 0);

    const objFetch = await fetch(`${baseUrl}/api/sculptures/${objSc.id}/model`);
    assert.equal(objFetch.status, 200);
    assert.match(objFetch.headers.get('content-type') || '', /model\/obj/);
    assert.ok((await objFetch.text()).includes('v 0 1.2 0'));

    // Also load a raw binary .glb file via put_sculpture_on_land
    const { buildSculptureGlb } = await import('../shared/glb.mjs');
    const glbBytes = buildSculptureGlb([
      { x: 0.1, y: 0.2, z: 0.1, color: '#ffd166', material: 'neon' }
    ]);
    const glbB64 = Buffer.from(glbBytes).toString('base64');
    const glbStep = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'put_sculpture_on_land',
          arguments: {
            parcelId,
            title: 'Golden GLB Beacon',
            description: 'Custom binary GLB file uploaded via MCP put_sculpture_on_land.',
            modelFormat: 'glb',
            modelBase64: glbB64
          }
        }
      })
    });
    assert.equal(glbStep.status, 200);
    const glbReq = glbStep.body.result.structuredContent.request;
    const glbSig = await holderSigner.signMessage(glbReq.canonicalMessage);
    const glbExec = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'sign_and_execute_pending',
          arguments: { requestId: glbReq.id, signature: glbSig }
        }
      })
    });
    assert.equal(glbExec.status, 200);
    const glbSc = glbExec.body.result.structuredContent.result.sculpture;
    assert.equal(glbSc.modelType, 'custom-3d');
    assert.equal(glbSc.customModel.format, 'glb');

    // 3. Contributor gating: non-visitor stranger MUST be rejected (403); IRL chat visitor CAN be added
    const rejectStranger = await apiJson(`/api/lands/${parcelId}/contributors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ email: 'm3d-stranger@graffiland.test' })
    });
    assert.equal(rejectStranger.status, 403);

    // Visitor enters seedSc chat in person IRL via camera + initializes/claims chat access
    const visId = await chatCrypto.getOrCreateDeviceIdentity(visitorAuth.body.user.id);
    const holderId = await chatCrypto.getOrCreateDeviceIdentity(holderAuth.body.user.id);
    const makeLocalSight = async (idObj) =>
      chatCrypto.signSightProof(idObj, {
        sculptureId: seedSc.id,
        parcelId,
        sightProof: {
          selectionMethod: 'ar-camera-raycast',
          rayHit: true,
          inFrustum: true,
          cameraReady: true,
          cameraFrames: 5,
          opticalFlowCorrelation: 0.85,
          visualDHash: '1234567890abcdef',
          accuracy: 6,
          lat: mLat,
          lng: mLng,
          altitude: 18,
          selectedAt: new Date().toISOString()
        }
      });

    // Holder initializes chat board, visitor gets admitted grant IRL via holder peer grant
    const rKey = chatCrypto.generateRoomKeyB64();
    const { roomKeyCommit } = await chatCrypto.computeRoomPossessionProof(rKey, seedSc.id, 1);
    const ownerSelfWrap = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64: rKey,
      sculptureId: seedSc.id,
      keyEpoch: 1,
      recipientEcdhPubJwk: holderId.ecdhPublicJwk,
      recipientPubFp: holderId.pubFingerprint,
      grantorIdentity: holderId
    });
    await apiJson(`/api/sculptures/${seedSc.id}/chat/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ownerEcdhPubJwk: holderId.ecdhPublicJwk,
        ownerSignPubJwk: holderId.signPublicJwk,
        ownerPubFp: holderId.pubFingerprint,
        selfGrantEnvelope: ownerSelfWrap.wrappedKeyJson,
        selfGrantSig: ownerSelfWrap.grantSig,
        roomKeyCommit,
        deviceProfile: { isMobile: true }
      })
    });
    const reqGrantRes = await apiJson(`/api/sculptures/${seedSc.id}/chat/request-grant`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterEcdhPubJwk: visId.ecdhPublicJwk,
        requesterSignPubJwk: visId.signPublicJwk,
        requesterPubFp: visId.pubFingerprint,
        sightProof: await makeLocalSight(visId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(reqGrantRes.status, 200);
    const peerWrap = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64: rKey,
      sculptureId: seedSc.id,
      keyEpoch: 1,
      recipientEcdhPubJwk: visId.ecdhPublicJwk,
      recipientPubFp: visId.pubFingerprint,
      grantorIdentity: holderId
    });
    const grantRes = await apiJson(`/api/sculptures/${seedSc.id}/chat/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({
        targetGrantId: reqGrantRes.body.grant.id,
        grantorEcdhPubJwk: holderId.ecdhPublicJwk,
        grantorSignPubJwk: holderId.signPublicJwk,
        wrappedKeyJson: peerWrap.wrappedKeyJson,
        grantSig: peerWrap.grantSig
      })
    });
    assert.equal(grantRes.status, 200);

    // Now visitor appears in eligibleVisitors and can be added as Contributor
    const listContribs = await apiJson(`/api/lands/${parcelId}/contributors`, {
      headers: { Authorization: `Bearer ${holderToken}` }
    });
    assert.equal(listContribs.status, 200);
    assert.ok(
      listContribs.body.eligibleVisitors.some((v) => v.email === 'm3d-visitor@graffiland.test')
    );

    const addContrib = await apiJson(`/api/lands/${parcelId}/contributors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ email: 'm3d-visitor@graffiland.test' })
    });
    assert.equal(addContrib.status, 200);
    assert.equal(addContrib.body.contributors.length, 1);

    // Contributor sees viewerCanContribute: true and modifies sculpture blocks & title; Stranger still blocked
    const scAsContrib = await apiJson(`/api/sculptures/${seedSc.id}`, {
      headers: { Authorization: `Bearer ${visitorToken}` }
    });
    assert.equal(scAsContrib.status, 200);
    assert.equal(scAsContrib.body.sculpture.viewerCanContribute, true);

    const strangerEdit = await apiJson(`/api/sculptures/${seedSc.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${strangerToken}` },
      body: JSON.stringify({ title: 'Unauthorized Tweak' })
    });
    assert.equal(strangerEdit.status, 403);

    const contribEdit = await apiJson(`/api/sculptures/${seedSc.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${visitorToken}` },
      body: JSON.stringify({
        title: 'Contributor Remixed Beacon',
        description: 'Remixed collaboratively by an IRL chat visitor contributor.',
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'matte' }
        ]
      })
    });
    assert.equal(contribEdit.status, 200);
    assert.equal(contribEdit.body.editorRole, 'contributor');
    assert.equal(contribEdit.body.sculpture.title, 'Contributor Remixed Beacon');
    assert.equal(contribEdit.body.sculpture.voxelCount, 2);
    assert.equal(contribEdit.body.sculpture.recipientAddress, seedSc.recipientAddress);

    // Contributors CANNOT delete sculptures or erase land
    const contribDel = await apiJson(`/api/sculptures/${seedSc.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${visitorToken}` }
    });
    assert.equal(contribDel.status, 403);

    // 4. Agent Land Erasure (erase_land): blocked when allowAgentErase=false, executes when authorized
    const disableErase = await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ allowAgentErase: false })
    });
    assert.equal(disableErase.status, 200);
    assert.equal(disableErase.body.settings.allowAgentErase, false);

    const blockedErase = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'erase_land',
          arguments: { parcelId, confirmParcelId: parcelId }
        }
      })
    });
    assert.equal(blockedErase.status, 403);

    // Enable agent erase -> unsigned request notifies mobile (`pending_mobile_signature`) -> signed request erases land!
    await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ allowAgentErase: true })
    });
    const erasePending = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'erase_land',
          arguments: { parcelId, confirmParcelId: parcelId, reason: 'Clear for next exhibition' }
        }
      })
    });
    assert.equal(erasePending.status, 200);
    const eraseReq = erasePending.body.result.structuredContent.request;
    assert.equal(erasePending.body.result.structuredContent.status, 'pending_mobile_signature');

    const eraseSig = await holderSigner.signMessage(eraseReq.canonicalMessage);
    const eraseExec = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': pairingCode },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'sign_and_execute_pending',
          arguments: { requestId: eraseReq.id, signature: eraseSig }
        }
      })
    });
    assert.equal(eraseExec.status, 200);
    assert.equal(eraseExec.body.result.structuredContent.result.erased, true);
    assert.equal(eraseExec.body.result.structuredContent.result.erasedSculptureCount, 3);

    // Confirm parcel & its sculptures are gone from public listings & myLands
    const publicSculpturesAfterErase = await apiJson('/api/sculptures');
    assert.equal(
      publicSculpturesAfterErase.body.sculptures.some((s) => s.parcelId === parcelId),
      false
    );
    const parcelsAfterErase = await apiJson('/api/parcels');
    assert.equal(
      parcelsAfterErase.body.parcels.some((p) => p.parcelId === parcelId),
      false
    );
    const myLandsAfter = await apiJson('/api/lands/mine', {
      headers: { Authorization: `Bearer ${holderToken}` }
    });
    assert.equal(myLandsAfter.body.parcelCount, 0);
  });

  test('Spatial streaming, 3D triangle/texture budgets, anchorOffset, immutable IPFS revisions, 409 conflict, ERC-4906 rollback & 429 quota', async () => {
    const mobileUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36';
    const userAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: {
          email: 'sprint16@graffiland.test',
          name: 'Sprint16 Artist'
        }
      })
    });
    assert.equal(userAuth.status, 200);
    const token = userAuth.body.token;
    const pol16 = {
      frameHashes: ['p1', 'p2', 'p3', 'p4'],
      gyroSamples: [
        { alpha: 5, beta: 8, gamma: 2 },
        { alpha: 14, beta: 10, gamma: 5 }
      ],
      flowCorrelation: 0.87,
      visualDHash: 'abcdef1234567890',
      frameCount: 6,
      flowScore: 0.87
    };

    // Invalid anchorOffset rejected (400)
    const badOffsetPub = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Bad Offset Test',
        description: 'Tests anchorOffset bounds validation cleanly.',
        termsAccepted: true,
        anchorOffset: { dx: 95, dy: 0, dz: 0, yaw: 0 },
        location: { lat: 37.753, lng: -122.442, altitude: 15, accuracy: 5 },
        proofOfLocation: { ...pol16, ...polEvidenceAt(37.753, -122.442) },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(badOffsetPub.status, 400);

    // Valid publish with anchorOffset -> creates immutable v1 revision
    const pubRes = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Streamed Anchor V1',
        description: 'Initial anchored revision for streaming and rollback test.',
        termsAccepted: true,
        anchorOffset: { dx: 1.25, dy: 0.4, dz: -0.75, yaw: 0.7854 },
        location: { lat: 37.753, lng: -122.442, altitude: 15, accuracy: 5 },
        proofOfLocation: { ...pol16, ...polEvidenceAt(37.753, -122.442) },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0.05, y: 0.05, z: 0, color: '#ff3e7f', material: 'matte' }
        ]
      })
    });
    assert.equal(pubRes.status, 201);
    const sc1 = pubRes.body.sculpture;
    assert.equal(sc1.currentRev, 1);
    assert.equal(sc1.anchorOffset.dx, 1.25);
    assert.equal(sc1.anchorOffset.dy, 0.4);
    assert.equal(sc1.anchorOffset.dz, -0.75);

    // Spatial streaming: includeVoxels=0 omits voxels array while preserving voxelCount, GET /:id hydrates
    const lightList = await apiJson('/api/sculptures?includeVoxels=0');
    assert.equal(lightList.status, 200);
    const lightRow = lightList.body.sculptures.find((s) => s.id === sc1.id);
    assert.ok(lightRow);
    assert.equal(lightRow.voxels, undefined);
    assert.equal(lightRow.voxelCount, 2);
    assert.equal(lightRow.anchorOffset.dx, 1.25);

    const hydratedOne = await apiJson(`/api/sculptures/${sc1.id}`);
    assert.equal(hydratedOne.status, 200);
    assert.equal(hydratedOne.body.sculpture.voxels.length, 2);

    // 3D polygon (>150k faces) and texture (>8 textures) budget rejections
    const overPolyObj = `v 0 0 0\nv 1 0 0\nv 0 1 0\n${'f 1 2 3\n'.repeat(150005)}`;
    const overPolyRes = await apiJson(`/api/lands/${sc1.parcelId}/sculptures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: 'Over Poly Mesh',
        description: 'Should fail triangle budget cleanly.',
        modelFormat: 'obj',
        modelData: overPolyObj
      })
    });
    assert.equal(overPolyRes.status, 400);
    assert.match(overPolyRes.body.error, /triangle budget/i);

    const overTexGltf = JSON.stringify({
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 3, type: 'VEC3', componentType: 5126 }],
      textures: Array.from({ length: 10 }, (_, idx) => ({ name: `tex_${idx}` }))
    });
    const overTexRes = await apiJson(`/api/lands/${sc1.parcelId}/sculptures`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: 'Over Texture GLTF',
        description: 'Should fail texture budget cleanly.',
        modelFormat: 'gltf',
        modelData: overTexGltf
      })
    });
    assert.equal(overTexRes.status, 400);
    assert.match(overTexRes.body.error, /textures/i);

    // Update to v2 with expectedRev=1 & shifted anchorOffset -> emits ERC-4906
    const updV2 = await apiJson(`/api/sculptures/${sc1.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        expectedRev: 1,
        title: 'Streamed Anchor V2',
        description: 'Second immutable revision with updated offset.',
        anchorOffset: { dx: -0.5, dy: 0.1, dz: 0.25, yaw: 1.57 },
        voxels: [{ x: 0, y: 0, z: 0, color: '#ffd166', material: 'glass' }]
      })
    });
    assert.equal(updV2.status, 200);
    assert.equal(updV2.body.sculpture.currentRev, 2);
    assert.equal(updV2.body.sculpture.title, 'Streamed Anchor V2');
    assert.equal(updV2.body.sculpture.anchorOffset.dx, -0.5);
    assert.ok(updV2.body.sculpture.lastErc4906TxHash.startsWith('0x'));

    // Stale expectedRev=1 must fail with HTTP 409 Conflict
    const staleRes = await apiJson(`/api/sculptures/${sc1.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        expectedRev: 1,
        title: 'Stale Write Attempt'
      })
    });
    assert.equal(staleRes.status, 409);

    // List revisions & rollback back to v1 -> creates v3 restoring v1 title, voxels & anchorOffset + ERC-4906
    const revList = await apiJson(`/api/sculptures/${sc1.id}/revisions`);
    assert.equal(revList.status, 200);
    assert.equal(revList.body.revisions.length, 2);

    const rollbackRes = await apiJson(`/api/sculptures/${sc1.id}/revisions/1/rollback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(rollbackRes.status, 200);
    assert.equal(rollbackRes.body.restoredFromRev, 1);
    assert.equal(rollbackRes.body.revNum, 3);
    assert.equal(rollbackRes.body.sculpture.title, 'Streamed Anchor V1');
    assert.equal(rollbackRes.body.sculpture.voxelCount, 2);
    assert.equal(rollbackRes.body.sculpture.anchorOffset.dx, 1.25);
    assert.ok(rollbackRes.body.erc4906TxHash.startsWith('0x'));

    // Daily relayer gas-sponsorship quota (429 Too Many Requests when exceeded)
    const { server: quotaSrv } = createAppServer({ relayerDailyQuota: 2 });
    await new Promise((resolve) => quotaSrv.listen(0, '127.0.0.1', resolve));
    try {
      const qPort = quotaSrv.address().port;
      const qBase = `http://127.0.0.1:${qPort}`;
      const qAuth = await (
        await fetch(`${qBase}/api/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            devProfile: {
              email: 'quota@graffiland.test',
              name: 'Quota User'
            }
          })
        })
      ).json();
      const postQuotaPub = async (idx) => {
        const res = await fetch(`${qBase}/api/sculptures/publish`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${qAuth.token}`,
            'User-Agent': mobileUa
          },
          body: JSON.stringify({
            title: `Quota Art ${idx}`,
            description: 'Testing daily sponsored relayer gas limit.',
            termsAccepted: true,
            location: { lat: 37.754, lng: -122.443, altitude: 12, accuracy: 5 },
            proofOfLocation: { ...pol16, ...polEvidenceAt(37.754, -122.443) },
            voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
          })
        });
        return { status: res.status, body: await res.json() };
      };
      const q1 = await postQuotaPub(1);
      const q2 = await postQuotaPub(2);
      const q3 = await postQuotaPub(3);
      assert.equal(q1.status, 201);
      assert.equal(q2.status, 201);
      assert.equal(q3.status, 429);
      assert.equal(q3.body.dailyQuota, 2);
    } finally {
      await new Promise((resolve) => quotaSrv.close(resolve));
    }
  });

  test('Non-reversible ORB landmark packs, PIN_MASTER_KEK seal wrapping, ES256 WebAuthn Passkeys & ORB PnP unlock verification', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148';
    const desktopUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0';

    const holderAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'holder17@graffiland.test', name: 'Holder 17' } })
    });
    const visitorAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'visitor17@graffiland.test', name: 'Visitor 17' }
      })
    });
    const holderToken = holderAuth.body.token;
    const visitorToken = visitorAuth.body.token;

    const pLat = 37.7551;
    const pLng = -122.4451;
    const pub17 = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Passkey ORB Citadel',
        description:
          'Protected by ORB landmarks, KEK seal encryption, and hardware WebAuthn passkeys.',
        termsAccepted: true,
        location: { lat: pLat, lng: pLng, altitude: 22, accuracy: 4 },
        proofOfLocation: {
          ...polEvidenceAt(pLat, pLng),
          frameHashes: ['k1', 'k2', 'k3', 'k4'],
          gyroSamples: [
            { alpha: 4, beta: 10, gamma: 2 },
            { alpha: 18, beta: 12, gamma: 4 }
          ],
          flowCorrelation: 0.9,
          visualDHash: '1122334455667788',
          frameCount: 6,
          flowScore: 0.9
        },
        voxels: [{ x: 0, y: 0, z: 0, color: '#7b61ff', material: 'neon' }]
      })
    });
    assert.equal(pub17.status, 201);
    const sc = pub17.body.sculpture;
    const parcelId = sc.parcelId;

    // 1. Privacy gate: raw camera image / pixels in landmark-pack MUST be rejected (400)
    const makeFeat = (seed) => {
      const desc = new Uint8Array(32);
      desc.fill(seed & 0xff);
      return {
        u: 0.25 + (seed % 5) * 0.1,
        v: 0.3 + (seed % 4) * 0.1,
        x: 0.4,
        y: 0.2,
        z: -2.4,
        angle: 0.4,
        response: 55,
        descB64: Buffer.from(desc).toString('base64')
      };
    };
    const validKeyframes = [
      {
        yawOffsetDeg: -24,
        pitchDeg: 2,
        frameWidth: 160,
        frameHeight: 120,
        features: [1, 2, 3, 4, 5, 6].map(makeFeat)
      },
      {
        yawOffsetDeg: 0,
        pitchDeg: 1,
        frameWidth: 160,
        frameHeight: 120,
        features: [7, 8, 9, 10, 11, 12].map(makeFeat)
      },
      {
        yawOffsetDeg: 25,
        pitchDeg: -1,
        frameWidth: 160,
        frameHeight: 120,
        features: [13, 14, 15, 16, 17, 18].map(makeFeat)
      }
    ];

    const rejectRawPack = await apiJson(`/api/lands/${parcelId}/landmark-pack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({
        imageDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
        keyframes: validKeyframes
      })
    });
    assert.equal(rejectRawPack.status, 400);

    const savedPack = await apiJson(`/api/lands/${parcelId}/landmark-pack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ geohash: sc.geohash, keyframes: validKeyframes })
    });
    assert.equal(savedPack.status, 200);
    assert.equal(savedPack.body.keyframeCount, 3);
    assert.equal(savedPack.body.featureCount, 18);
    const descriptorDigest = savedPack.body.descriptorDigest;

    // 2. Geofenced fetch: desktop blocked (403), distant mobile blocked (403), on-site mobile allowed (200)
    const desktopFetch = await apiJson(`/api/lands/${parcelId}/landmark-pack/fetch`, {
      method: 'POST',
      headers: { 'User-Agent': desktopUa },
      body: JSON.stringify({ lat: pLat, lng: pLng, deviceProfile: { isMobile: false } })
    });
    assert.equal(desktopFetch.status, 403);

    const farMobileFetch = await apiJson(`/api/lands/${parcelId}/landmark-pack/fetch`, {
      method: 'POST',
      headers: { 'User-Agent': mobileUa },
      body: JSON.stringify({
        lat: pLat + 0.005,
        lng: pLng + 0.005,
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(farMobileFetch.status, 403);

    const localFetch = await apiJson(`/api/lands/${parcelId}/landmark-pack/fetch`, {
      method: 'POST',
      headers: { 'User-Agent': mobileUa },
      body: JSON.stringify({ lat: pLat, lng: pLng, deviceProfile: { isMobile: true } })
    });
    assert.equal(localFetch.status, 200);
    assert.equal(localFetch.body.descriptorDigest, descriptorDigest);

    // 3. Pin encrypted IPFS batch -> verify seal_secret_b64 is envelope-wrapped under PIN_MASTER_KEK (`kek-v1:`)
    const holderId = await chatCrypto.getOrCreateDeviceIdentity(holderAuth.body.user.id);
    const sealRes = await apiJson(`/api/sculptures/${sc.id}/pins/owner-seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({})
    });
    assert.equal(sealRes.status, 200);

    const rawDb = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    const pinDbRow = rawDb
      .prepare('SELECT seal_secret_b64 FROM sculpture_pin_batches WHERE sculpture_id = ?')
      .get(sc.id);
    rawDb.close();
    assert.ok(
      pinDbRow.seal_secret_b64.startsWith('kek-v1:'),
      'seal_secret_b64 must be envelope-encrypted with KEK'
    );

    const encBatch = await chatCrypto.encryptPinnedIpfsBatch({
      pins: [
        {
          id: 'p17',
          text: 'Only real Passkey + ORB visitors can decrypt this',
          authorName: 'Holder 17',
          createdAt: new Date().toISOString()
        }
      ],
      sculptureId: sc.id,
      parcelId,
      geohash: sc.geohash,
      batchSeq: 1,
      parcelSealKeyB64: sealRes.body.parcelSealKeyB64,
      identity: holderId
    });
    const savedPinRes = await apiJson(`/api/sculptures/${sc.id}/pins/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ encryptedBatch: encBatch })
    });
    assert.equal(savedPinRes.status, 200);

    // 4. Enforce strict Passkey + ORB policy on parcel
    const polUpdate = await apiJson(`/api/lands/${parcelId}/security`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${holderToken}` },
      body: JSON.stringify({ requirePasskeyUnlock: true, requireOrbUnlock: true, minOrbInliers: 8 })
    });
    assert.equal(polUpdate.status, 200);
    assert.equal(polUpdate.body.policy.requirePasskeyUnlock, true);
    assert.equal(polUpdate.body.policy.requireOrbUnlock, true);

    // 5. Visitor registers genuine WebCrypto ES256 hardware passkey credential
    const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
    const pkKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const spkiBuf = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('spki', pkKeyPair.publicKey)
    );
    const regOpts = await apiJson('/api/passkeys/register/options', {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}` },
      body: JSON.stringify({})
    });
    assert.equal(regOpts.status, 200);
    const rpId = regOpts.body.rp.id;
    const credentialId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(24)));
    const verifyReg = await apiJson('/api/passkeys/register/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}` },
      body: JSON.stringify({
        credentialId,
        publicKeySpkiB64: b64u(spkiBuf),
        clientDataJSON: b64u(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'webauthn.create',
              challenge: regOpts.body.challenge,
              origin: baseUrl
            })
          )
        ),
        deviceLabel: 'Test iPhone SecureEnclave'
      })
    });
    assert.equal(verifyReg.status, 200);

    const visId = await chatCrypto.getOrCreateDeviceIdentity(visitorAuth.body.user.id);
    const buildSignedPresence = async () => {
      const ch = await apiJson(`/api/sculptures/${sc.id}/pins/challenge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
        body: JSON.stringify({ deviceProfile: { isMobile: true } })
      });
      assert.equal(ch.status, 200);
      assert.equal(ch.body.webauthnRequired, true);
      assert.equal(ch.body.orbRequired, true);
      const freshSight = await chatCrypto.signSightProof(visId, {
        sculptureId: sc.id,
        parcelId,
        sightProof: {
          selectionMethod: 'ar-camera-raycast',
          rayHit: true,
          inFrustum: true,
          cameraReady: true,
          cameraFrames: 5,
          opticalFlowCorrelation: 0.88,
          visualDHash: '1122334455667788',
          accuracy: 5,
          lat: pLat,
          lng: pLng,
          altitude: 22,
          selectedAt: new Date().toISOString()
        }
      });
      const signed = await chatCrypto.signParcelPresenceProof(visId, {
        sculptureId: sc.id,
        parcelId,
        geohash: sc.geohash,
        challengeId: ch.body.challengeId,
        challengeNonce: ch.body.challengeNonce,
        sightProof: freshSight,
        polSnapshot: {
          cameraFrames: 6,
          visualDHash: '1122334455667788',
          gyroSamples: [
            { alpha: 4, beta: 10, gamma: 2 },
            { alpha: 18, beta: 12, gamma: 4 }
          ],
          opticalFlowCorrelation: 0.88,
          gpsSamples: [
            { lat: pLat, lng: pLng, accuracy: 5, t: Date.now() - 2000 },
            { lat: pLat + 0.00001, lng: pLng + 0.00001, accuracy: 5, t: Date.now() }
          ]
        }
      });
      return { ch: ch.body, signed };
    };

    const signWebAuthnAssertion = async (
      nonceB64u,
      signCount,
      signWithPrivateKey = pkKeyPair.privateKey
    ) => {
      const rpHash = new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId))
      );
      const authData = new Uint8Array(37);
      authData.set(rpHash, 0);
      authData[32] = 0x05; // UP + UV flags set
      new DataView(authData.buffer).setUint32(33, signCount, false);
      const clientDataBytes = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge: nonceB64u, origin: baseUrl })
      );
      const clientHash = new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', clientDataBytes)
      );
      const payloadToSign = new Uint8Array(authData.length + clientHash.length);
      payloadToSign.set(authData, 0);
      payloadToSign.set(clientHash, authData.length);
      const p1363Sig = new Uint8Array(
        await globalThis.crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          signWithPrivateKey,
          payloadToSign
        )
      );
      return {
        credentialId,
        clientDataJSON: b64u(clientDataBytes),
        authenticatorData: b64u(authData),
        signature: b64u(p1363Sig)
      };
    };

    // Attempt 1: Missing ORB + WebAuthn -> 403
    const p1 = await buildSignedPresence();
    const failMissing = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({ ...p1.signed, deviceProfile: { isMobile: true } })
    });
    assert.equal(failMissing.status, 403);
    assert.match(failMissing.body.error, /ORB|Passkey/i);

    // Attempt 2: Too few ORB inliers (3 < 8) -> 403
    const p2 = await buildSignedPresence();
    const failLowInliers = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...p2.signed,
        orbProof: { descriptorDigest, inlierCount: 3, reprojectionErrorPx: 1.5 },
        webauthnAssertion: await signWebAuthnAssertion(p2.ch.challengeNonce, 1),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(failLowInliers.status, 403);
    assert.match(failLowInliers.body.error, /inliers/i);

    // Attempt 3: Valid ORB + forged wrong WebAuthn key -> 403
    const wrongKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );
    const p3 = await buildSignedPresence();
    const failBadPasskey = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...p3.signed,
        orbProof: { descriptorDigest, inlierCount: 11, reprojectionErrorPx: 1.8 },
        webauthnAssertion: await signWebAuthnAssertion(
          p3.ch.challengeNonce,
          1,
          wrongKeyPair.privateKey
        ),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(failBadPasskey.status, 403);
    assert.match(failBadPasskey.body.error, /Passkey|signature/i);

    // Attempt 4: Valid ORB PnP + Valid ES256 WebAuthn Passkey -> UNLOCKED (200) & decrypts secret!
    const p4 = await buildSignedPresence();
    const okUnlock = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...p4.signed,
        orbProof: { descriptorDigest, inlierCount: 11, reprojectionErrorPx: 1.8 },
        webauthnAssertion: await signWebAuthnAssertion(p4.ch.challengeNonce, 2),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(okUnlock.status, 200, JSON.stringify(okUnlock.body));
    assert.equal(okUnlock.body.orbCheck.verified, true);
    assert.equal(okUnlock.body.webauthnResult.verified, true);
    const decryptedPins = await chatCrypto.decryptPinnedIpfsBatch({
      encryptedBatch: okUnlock.body.encryptedBatch,
      parcelSealKeyB64: okUnlock.body.parcelSealKeyB64,
      sculptureId: sc.id,
      parcelId,
      geohash: sc.geohash
    });
    assert.equal(decryptedPins.pins[0].text, 'Only real Passkey + ORB visitors can decrypt this');

    // Attempt 5: Sign-count rollback (count 1 <= stored 2) -> blocked (403)!
    const p5 = await buildSignedPresence();
    const failRollback = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...p5.signed,
        orbProof: { descriptorDigest, inlierCount: 11, reprojectionErrorPx: 1.8 },
        webauthnAssertion: await signWebAuthnAssertion(p5.ch.challengeNonce, 1),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(failRollback.status, 403);
    assert.match(failRollback.body.error, /rollback|cloned/i);

    // Attempt 6: Server-side ORB matchedDescriptors Hamming check (forged -> 403, valid -> 200)
    const p6Bad = await buildSignedPresence();
    const badMatches = [];
    const okMatches = [];
    for (let k = 0; k < 2; k += 1) {
      for (let f = 0; f < 5; f += 1) {
        const feat = validKeyframes[k].features[f];
        const origBytes = new Uint8Array(Buffer.from(feat.descB64, 'base64'));
        const invBytes = origBytes.map((b) => ~b & 0xff);
        badMatches.push({
          keyframeIndex: k,
          featureIndex: f,
          liveDescB64: Buffer.from(invBytes).toString('base64')
        });
        okMatches.push({
          keyframeIndex: k,
          featureIndex: f,
          liveDescB64: feat.descB64
        });
      }
    }

    const badOrbDesc = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...p6Bad.signed,
        orbProof: {
          descriptorDigest,
          inlierCount: 10,
          reprojectionErrorPx: 1.6,
          matchedDescriptors: badMatches
        },
        webauthnAssertion: await signWebAuthnAssertion(p6Bad.ch.challengeNonce, 3),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(badOrbDesc.status, 403);
    assert.match(badOrbDesc.body.error, /descriptor verification/i);

    const p6Ok = await buildSignedPresence();
    const okOrbDesc = await apiJson(`/api/sculptures/${sc.id}/pins/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${visitorToken}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ...p6Ok.signed,
        orbProof: {
          descriptorDigest,
          inlierCount: 10,
          reprojectionErrorPx: 1.6,
          matchedDescriptors: okMatches
        },
        webauthnAssertion: await signWebAuthnAssertion(p6Ok.ch.challengeNonce, 4),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(okOrbDesc.status, 200, JSON.stringify(okOrbDesc.body));
    assert.ok(okOrbDesc.body.orbCheck.serverVerifiedMatches >= 8);

    // Passkey deletion works & prevents deletion by other users
    const pkListBefore = await apiJson('/api/passkeys/status', {
      headers: { Authorization: `Bearer ${visitorToken}` }
    });
    assert.ok((pkListBefore.body.passkeys || []).length >= 1);
    const delPasskey = await apiJson(`/api/passkeys/${pkListBefore.body.passkeys[0].id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${visitorToken}` }
    });
    assert.equal(delPasskey.status, 200);
    const pkListAfter = await apiJson('/api/passkeys/status', {
      headers: { Authorization: `Bearer ${visitorToken}` }
    });
    assert.equal((pkListAfter.body.passkeys || []).length, 0);
  });

  test('Operational health, admin telemetry metrics, spatial SQL filter, rate limiting (429), and quota refund', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148';

    // 1. /api/health & /api/admin/metrics
    const healthRes = await apiJson('/api/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.body.ok, true);
    assert.equal(healthRes.body.db, 'connected');

    const metricsNonAdmin = await apiJson('/api/admin/metrics', {
      headers: { Authorization: `Bearer ${artistToken}` }
    });
    assert.equal(metricsNonAdmin.status, 403);

    const metricsAdmin = await apiJson('/api/admin/metrics', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(metricsAdmin.status, 200);
    assert.ok(metricsAdmin.body.counts.sculptures >= 1);
    assert.equal(typeof metricsAdmin.body.relayerTodayOps, 'number');

    // 2. Spatial bounding box SQL query + includeVoxels=0
    const sfSpatial = await apiJson(
      '/api/sculptures?lat=37.7749&lng=-122.4194&radiusMeters=250&includeVoxels=0'
    );
    assert.equal(sfSpatial.status, 200);
    assert.ok(
      sfSpatial.body.sculptures.every(
        (s) => (!s.voxels || s.voxels.length === 0) && Number(s.distanceMeters) <= 250
      )
    );

    // 3. Isolated server enforcing rate limit = 2 / min and relayer quota = 2 with refund on error
    const rlApp = createAppServer({ publishRateLimit: 2, relayerDailyQuota: 2 });
    let rlBaseUrl;
    await new Promise((resolve) => {
      rlApp.server.listen(0, '127.0.0.1', () => {
        rlBaseUrl = `http://127.0.0.1:${rlApp.server.address().port}`;
        resolve();
      });
    });
    try {
      const rlLogin = await fetch(`${rlBaseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          devProfile: { email: 'ratelimit-user@graffiland.test', name: 'RL User' }
        })
      }).then((r) => r.json());
      const tok = rlLogin.token;

      // Bad PoL (teleporting GPS trajectory > 60 m/s) increments publish RL 1/2 & fails 422 before consuming quota
      const badPol = await fetch(`${rlBaseUrl}/api/sculptures/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tok}`,
          'User-Agent': mobileUa
        },
        body: JSON.stringify({
          title: 'Quota Safe Sculpture',
          description: 'Verifies relayer quota is not lost on failed attempts.',
          termsAccepted: true,
          location: { lat: 37.775, lng: -122.418, accuracy: 850 },
          proofOfLocation: {
            frameHashes: [],
            gyroSamples: [],
            flowCorrelation: 0,
            gpsSamples: [
              { lat: 37.775, lng: -122.418, t: 1000 },
              { lat: 37.905, lng: -122.418, t: 1500 }
            ]
          },
          voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' }]
        })
      });
      assert.equal(badPol.status, 422);

      // Valid publish #1 succeeds (publish RL 2/2, relayer quota 1/2)
      const okBody = {
        title: 'Quota & RL Valid Piece',
        description: 'Valid mobile Proof of Location sculpture for ops check.',
        termsAccepted: true,
        location: { lat: 37.775, lng: -122.418, accuracy: 5 },
        proofOfLocation: {
          ...polEvidenceAt(37.775, -122.418),
          frameHashes: ['a1', 'a2', 'a3', 'a4'],
          gyroSamples: [
            { alpha: 1, beta: 2, gamma: 3 },
            { alpha: 9, beta: 4, gamma: 2 }
          ],
          flowCorrelation: 0.85,
          skyPalette: ['#00f5d4'],
          visualDHash: '1111000011110000',
          frameCount: 6,
          flowScore: 0.85
        },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      };
      const rl1 = await fetch(`${rlBaseUrl}/api/sculptures/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tok}`,
          'User-Agent': mobileUa
        },
        body: JSON.stringify(okBody)
      });
      assert.equal(rl1.status, 201);
      const rl1Body = await rl1.json();
      const parcelIdRl = rl1Body.sculpture.parcelId;

      // Invalid land creation fails AFTER consuming quota -> refundRelayerQuota refunds back to 1/2!
      const badLandPut = await fetch(`${rlBaseUrl}/api/lands/${parcelIdRl}/sculptures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          title: 'X',
          description: 'Invalid short title triggering quota refund.',
          voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte' }]
        })
      });
      assert.equal(badLandPut.status, 400);

      // Valid land creation succeeds ONLY because failed request refunded relayer quota (now 2/2)!
      const goodLandPut = await fetch(`${rlBaseUrl}/api/lands/${parcelIdRl}/sculptures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          title: 'Quota Refund Verified',
          description: 'Proves relayer quota was refunded after failed 400 call.',
          voxels: [{ x: 0, y: 0.05, z: 0, color: '#ffd166', material: 'matte' }]
        })
      });
      assert.equal(goodLandPut.status, 200);

      // Next publish hits publishRateLimit (3 > 2/min) -> 429 + Retry-After header!
      const rl2 = await fetch(`${rlBaseUrl}/api/sculptures/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tok}`,
          'User-Agent': mobileUa
        },
        body: JSON.stringify(okBody)
      });
      assert.equal(rl2.status, 429);
      assert.ok(Number(rl2.headers.get('retry-after')) >= 1);
    } finally {
      await new Promise((resolve) => rlApp.server.close(resolve));
    }
  });

  test('WebSocket pairing supports ping/pong keepalive, preserves code across transient desktop reconnects, and reclaims preferredCode', async () => {
    const desktop1 = new WebSocket(wsUrl);
    await new Promise((r) => desktop1.once('open', r));
    const d1Msgs = [];
    desktop1.on('message', (d) => d1Msgs.push(JSON.parse(d.toString())));

    desktop1.send(JSON.stringify({ type: 'create_pair' }));
    await new Promise((r) => setTimeout(r, 60));
    const created = d1Msgs.find((m) => m.type === 'pair_created');
    assert.ok(created?.code && created.code.length === 6);

    const mobile = new WebSocket(wsUrl);
    await new Promise((r) => mobile.once('open', r));
    const mMsgs = [];
    mobile.on('message', (d) => mMsgs.push(JSON.parse(d.toString())));

    mobile.send(JSON.stringify({ type: 'join_pair', code: created.code }));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(mMsgs.some((m) => m.type === 'pair_connected' && m.code === created.code));

    // Ping/pong keepalive stays strictly between client & server (never relayed to peer)
    desktop1.send(JSON.stringify({ type: 'ping' }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(d1Msgs.some((m) => m.type === 'pong'));
    assert.equal(mMsgs.some((m) => m.type === 'ping'), false);

    // Transient desktop disconnect notifies desktop_reconnecting (does NOT kill mobile pairing!)
    desktop1.close();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(mMsgs.some((m) => m.type === 'desktop_reconnecting' && m.code === created.code));
    assert.equal(mMsgs.some((m) => m.type === 'pair_ended'), false);

    // Reconnecting desktop with preferredCode reclaims the EXACT same code & re-links live mobile
    const desktop2 = new WebSocket(wsUrl);
    await new Promise((r) => desktop2.once('open', r));
    const d2Msgs = [];
    desktop2.on('message', (d) => d2Msgs.push(JSON.parse(d.toString())));
    desktop2.send(JSON.stringify({ type: 'create_pair', preferredCode: created.code }));
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(
      d2Msgs.some((m) => m.type === 'pair_created' && m.code === created.code && m.reclaimed === true)
    );
    assert.ok(
      d2Msgs.some((m) => m.type === 'pair_connected' && m.code === created.code && m.reconnected === true)
    );

    // Relay still works seamlessly after reconnect
    mobile.send(JSON.stringify({ type: 'voxels_sync', voxels: [{ x: 1, y: 2, z: 3, color: '#00f5d4' }] }));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(d2Msgs.some((m) => m.type === 'voxels_sync' && m.voxels?.length === 1));

    // Explicit end_pair ends the room cleanly
    desktop2.send(JSON.stringify({ type: 'end_pair', code: created.code }));
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(mMsgs.some((m) => m.type === 'pair_ended'));

    desktop2.close();
    mobile.close();
  });

  test('MCP pairing defaults to 30-day TTL and extends expiration via sliding renewal on active use', async () => {
    const auth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'long-ttl-owner@graffiland.local', name: 'Long TTL Owner' }
      })
    });
    assert.equal(auth.status, 200);
    const tok = auth.body.token;

    // Default create (no explicit expiresHours) grants 30-day (720h) TTL so pairing codes don't drop daily
    const created = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: JSON.stringify({})
    });
    assert.equal(created.status, 200);
    const code = created.body.pairing.code;
    const ttlHours = (Date.parse(created.body.pairing.expiresAt) - Date.now()) / (3600 * 1000);
    assert.ok(ttlHours >= 29 * 24, `Expected ~30 day default pairing TTL, got ${ttlHours.toFixed(1)}h`);

    // Explicit short TTL (24h) auto-extends to 30 days on active connect/MCP usage (sliding renewal)
    const shortCreated = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ expiresHours: 24 })
    });
    assert.equal(shortCreated.status, 200);
    const shortCode = shortCreated.body.pairing.code;
    const initialShortHours =
      (Date.parse(shortCreated.body.pairing.expiresAt) - Date.now()) / (3600 * 1000);
    assert.ok(initialShortHours <= 25);

    const conn = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({ pairingCode: shortCode, agentName: 'PersistentAgent' })
    });
    assert.equal(conn.status, 200);
    const renewedHours = (Date.parse(conn.body.pairing.expiresAt) - Date.now()) / (3600 * 1000);
    assert.ok(
      renewedHours >= 29 * 24,
      `Expected active pairing connect to renew TTL to ~30 days, got ${renewedHours.toFixed(1)}h`
    );

    // Active MCP initialize call succeeds on the renewed pairing
    const rpc = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': shortCode },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ttl-1', method: 'initialize', params: {} })
    });
    assert.equal(rpc.status, 200);
    assert.equal(rpc.body?.result?.pairing?.code, shortCode);
    assert.ok(code.startsWith('GLP-'));
  });
});
