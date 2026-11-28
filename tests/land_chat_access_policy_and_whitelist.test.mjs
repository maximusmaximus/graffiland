import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-chat-policy-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
process.env.ROBINHOOD_ROYALTY_RECEIVER = '';

const { createAppServer } = await import('../server/index.mjs');
const chatCrypto = await import('../client/src/utils/chatCrypto.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function makeValidPol(lat, lng, overrides = {}) {
  const now = Date.now();
  return {
    cameraFrames: 12,
    gyroSamples: 24,
    gyroVariance: 3.1,
    opticalFlowCorrelation: 0.74,
    opticalFlowSamples: 8,
    gpsSamples: [
      { lat, lng, accuracy: 8, altitude: 22, ts: now - 5000 },
      { lat: lat + 0.00001, lng: lng + 0.00001, accuracy: 7, altitude: 22, ts: now - 2500 },
      { lat, lng, accuracy: 6, altitude: 22, ts: now }
    ],
    horizonLuma: 150,
    ambientPalette: ['#112233', '#223344', '#334455', '#445566', '#556677'],
    visualDHash: 'a1b2c3d4e5f60718',
    sceneScan: { optimal: true, scannedCount: 9, targetCount: 9, coveragePct: 100 },
    ...overrides
  };
}

describe('Land Chat Access Policy (Default Contributors, Whitelist Only, Open, Off) — API, MCP & UI', () => {
  let srv;
  let baseUrl;

  async function apiJson(pathname, opts = {}) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  async function loginDevUser(email, name, username) {
    const auth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email, name } })
    });
    assert.equal(auth.status, 200, JSON.stringify(auth.body));
    const token = auth.body.token;
    if (username) {
      const upd = await apiJson('/api/profile', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username })
      });
      assert.equal(upd.status, 200, JSON.stringify(upd.body));
    }
    return { token, user: auth.body.user };
  }

  before(async () => {
    const { server } = createAppServer();
    srv = server;
    await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (srv) {
      await new Promise((resolve) => srv.close(resolve));
    }
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors
    }
  });

  test('1. Backend enforces default contributor chat, whitelist-only mode, off mode, open mode, and MCP whitelist management', async () => {
    const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148';
    const lat = 39.7284;
    const lng = -121.8375;

    const owner = await loginDevUser('chatpol-owner@spray.test', 'Land Owner', 'chatowner');
    const contrib = await loginDevUser('chatpol-contrib@spray.test', 'Art Contrib', 'artcontrib');
    const guest = await loginDevUser('chatpol-guest@spray.test', 'Walkup Guest', 'walkupguest');

    // Owner publishes initial sculpture -> creates land parcel (default chatAccessMode = 'contributors')
    const pub1 = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Owner Totem',
        description: 'Founding sculpture claiming this virtual land parcel.',
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'matte' },
          { x: 0, y: 0.1, z: 0, color: '#ffd166', material: 'glass' }
        ],
        location: { lat, lng, accuracy: 6, altitude: 22 },
        proofOfLocation: makeValidPol(lat, lng),
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 },
        termsAccepted: true
      })
    });
    assert.equal(pub1.status, 201, JSON.stringify(pub1.body));
    const ownerSc = pub1.body.sculpture;
    const parcelId = ownerSc.parcelId;

    // Art contributor publishes artwork on the SAME land -> becomes a land contributor automatically!
    const pub2 = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${contrib.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Contrib Flower',
        description: 'Collaborative voxel flower placed on the open land.',
        targetParcelId: parcelId,
        voxels: [
          { x: 0.5, y: 0, z: 0, color: '#ff3e7f', material: 'matte' },
          { x: 0.5, y: 0.05, z: 0, color: '#ffd166', material: 'neon' },
          { x: 0.5, y: 0.1, z: 0, color: '#00f5d4', material: 'glass' }
        ],
        location: { lat, lng, accuracy: 6, altitude: 22 },
        proofOfLocation: makeValidPol(lat, lng),
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 },
        termsAccepted: true
      })
    });
    assert.equal(pub2.status, 201, JSON.stringify(pub2.body));
    assert.equal(pub2.body.sculpture.parcelId, parcelId);

    const ownerId = await chatCrypto.getOrCreateDeviceIdentity(owner.user.id);
    const contribId = await chatCrypto.getOrCreateDeviceIdentity(contrib.user.id);
    const guestId = await chatCrypto.getOrCreateDeviceIdentity(guest.user.id);

    const makeSight = async (idObj) =>
      chatCrypto.signSightProof(idObj, {
        sculptureId: ownerSc.id,
        parcelId,
        sightProof: {
          selectionMethod: 'ar-camera-raycast',
          rayHit: true,
          inFrustum: true,
          cameraReady: true,
          cameraFrames: 6,
          opticalFlowCorrelation: 0.85,
          visualDHash: '1234567890abcdef',
          lat,
          lng,
          altitude: 22,
          selectedAt: new Date().toISOString()
        }
      });

    // Owner initializes Land Chat under default ('contributors') mode
    const roomKeyB64 = chatCrypto.generateRoomKeyB64();
    const { roomKeyCommit } = await chatCrypto.computeRoomPossessionProof(roomKeyB64, ownerSc.id, 1);
    const ownerWrap = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64,
      sculptureId: ownerSc.id,
      keyEpoch: 1,
      recipientEcdhPubJwk: ownerId.ecdhPublicJwk,
      recipientPubFp: ownerId.pubFingerprint,
      grantorIdentity: ownerId
    });
    const initRes = await apiJson(`/api/sculptures/${ownerSc.id}/chat/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        ownerEcdhPubJwk: ownerId.ecdhPublicJwk,
        ownerSignPubJwk: ownerId.signPublicJwk,
        ownerPubFp: ownerId.pubFingerprint,
        selfGrantEnvelope: ownerWrap.wrappedKeyJson,
        selfGrantSig: ownerWrap.grantSig,
        roomKeyCommit,
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(initRes.status, 200, JSON.stringify(initRes.body));
    assert.equal(initRes.body.chatAccessMode, 'contributors');

    // A) DEFAULT ('contributors'): Art contributor CAN enter chat immediately!
    const contribEnter = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${contrib.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: contribId.pubFingerprint,
        sightProof: await makeSight(contribId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(contribEnter.status, 200, JSON.stringify(contribEnter.body));
    assert.equal(contribEnter.body.chatAccessMode, 'contributors');
    assert.equal(contribEnter.body.viewerChatRole, 'contributor');

    // Non-contributor guest is BLOCKED by default ('contributors')
    const guestBlockedDefault = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${guest.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: guestId.pubFingerprint,
        sightProof: await makeSight(guestId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(guestBlockedDefault.status, 403);
    assert.equal(guestBlockedDefault.body.code, 'chat_contributors_only');

    // B) WHITELIST ONLY: Owner switches to 'whitelist' and whitelists @walkupguest by username
    const setWhitelistMode = await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ chatAccessMode: 'whitelist' })
    });
    assert.equal(setWhitelistMode.status, 200);
    assert.equal(setWhitelistMode.body.settings.chatAccessMode, 'whitelist');

    const addWl = await apiJson(`/api/lands/${parcelId}/chat-whitelist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ identifier: '@walkupguest' })
    });
    assert.equal(addWl.status, 200, JSON.stringify(addWl.body));
    assert.equal(addWl.body.whitelist.length, 1);
    assert.equal(addWl.body.whitelist[0].userSub, guest.user.id);

    // Public /api/parcels reflects chatAccessMode='whitelist' and chatWhitelistSubs
    const parcelsRes = await apiJson('/api/parcels');
    const liveParcel = parcelsRes.body.parcels.find((p) => p.parcelId === parcelId);
    assert.equal(liveParcel.chatAccessMode, 'whitelist');
    assert.ok(liveParcel.chatWhitelistSubs.includes(guest.user.id));

    // Whitelisted guest CAN enter chat; non-whitelisted art contributor is now BLOCKED!
    const guestWhitelistedEnter = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${guest.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: guestId.pubFingerprint,
        sightProof: await makeSight(guestId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(guestWhitelistedEnter.status, 200, JSON.stringify(guestWhitelistedEnter.body));
    assert.equal(guestWhitelistedEnter.body.viewerChatRole, 'whitelisted');

    const contribBlockedWhitelist = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${contrib.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: contribId.pubFingerprint,
        sightProof: await makeSight(contribId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(contribBlockedWhitelist.status, 403);
    assert.equal(contribBlockedWhitelist.body.code, 'chat_whitelist_only');

    // Removing guest from whitelist immediately revokes access
    const delWl = await apiJson(
      `/api/lands/${parcelId}/chat-whitelist/${encodeURIComponent(guest.user.id)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${owner.token}` }
      }
    );
    assert.equal(delWl.status, 200);
    assert.equal(delWl.body.whitelist.length, 0);

    const guestAfterRemove = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${guest.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: guestId.pubFingerprint,
        sightProof: await makeSight(guestId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(guestAfterRemove.status, 403);
    assert.equal(guestAfterRemove.body.code, 'chat_whitelist_only');

    // C) OFF MODE: Owner turns Land Chat off -> everyone blocked (code: 'chat_disabled')
    const setOffMode = await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ chatAccessMode: 'off' })
    });
    assert.equal(setOffMode.status, 200);
    assert.equal(setOffMode.body.settings.chatAccessMode, 'off');

    const ownerEnterOff = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: ownerId.pubFingerprint,
        sightProof: await makeSight(ownerId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(ownerEnterOff.status, 403);
    assert.equal(ownerEnterOff.body.code, 'chat_disabled');

    // D) OPEN MODE: Owner opens chat to everyone on site -> non-contributor guest enters cleanly
    const setOpenMode = await apiJson(`/api/lands/${parcelId}/settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ chatAccessMode: 'open' })
    });
    assert.equal(setOpenMode.status, 200);

    const guestEnterOpen = await apiJson(`/api/sculptures/${ownerSc.id}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${guest.token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: guestId.pubFingerprint,
        sightProof: await makeSight(guestId),
        deviceProfile: { isMobile: true }
      })
    });
    assert.equal(guestEnterOpen.status, 200, JSON.stringify(guestEnterOpen.body));
    assert.equal(guestEnterOpen.body.chatAccessMode, 'open');

    // E) MCP manage_land_chat_whitelist works over active pairing
    const pairCreate = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ label: 'Chat Policy Agent' })
    });
    assert.equal(pairCreate.status, 200);
    const code = pairCreate.body.pairing.code;
    const pairConn = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({ pairingCode: code, agentName: 'policy-bot' })
    });
    assert.equal(pairConn.status, 200);

    const mcpAddWl = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'X-Graffiland-Pairing-Code': code },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'manage_land_chat_whitelist',
          arguments: { parcelId, action: 'add', username: 'artcontrib' }
        }
      })
    });
    assert.equal(mcpAddWl.status, 200, JSON.stringify(mcpAddWl.body));
    assert.equal(mcpAddWl.body.result.structuredContent.whitelist.length, 1);
    assert.equal(mcpAddWl.body.result.structuredContent.whitelist[0].userSub, contrib.user.id);
  });
});

describe('Land Chat Access Policy & Whitelist UI (React + jsdom)', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;
  let origFetch;

  async function loadJsxModule(relPath) {
    const absEntry = path.join(ROOT, relPath);
    const outFile = path.join(
      outTmpDir,
      `${path.basename(relPath, path.extname(relPath))}-${Math.random().toString(36).slice(2)}.mjs`
    );
    await esbuild.build({
      entryPoints: [absEntry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'three'],
      plugins: [
        {
          name: 'stub-leaflet-and-css',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'empty-css'
            }));
            build.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onResolve({ filter: /^leaflet$/ }, () => ({
              path: 'leaflet',
              namespace: 'stub-leaflet'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-leaflet' }, () => ({
              contents: 'export default { map: () => ({ setView: () => ({}), remove: () => {}, on: () => {}, off: () => {} }) };',
              loader: 'js'
            }));
          }
        }
      ],
      loader: {
        '.js': 'jsx',
        '.jsx': 'jsx',
        '.css': 'empty',
        '.svg': 'dataurl',
        '.png': 'dataurl'
      },
      outfile: outFile
    });
    return import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
  }

  before(async () => {
    const cacheBase = path.join(ROOT, 'node_modules');
    outTmpDir = fs.mkdtempSync(path.join(cacheBase, '.cache-chat-policy-ui-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    if (origFetch !== undefined) globalThis.fetch = origFetch;
    dom?.window?.close();
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
  });

  test('2. ARLandInspectorPanel & live chat notifications enforce contributors default, whitelist-only, and off mode with clear "i" reasons', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const { buildLiveLandChatNotification } = await loadJsxModule(
      'client/src/utils/landChatHelpers.js'
    );

    const baseLand = {
      parcelId: 'GLAND-STIBBLEZ',
      displayName: 'Stibblez Land',
      ownerSub: 'u-owner',
      isInside: true,
      edgeDistanceMeters: 0,
      outOfArRange: false,
      chatInitialized: true,
      chatMessageCount: 2,
      chatAccessMode: 'contributors',
      contributorSubs: [],
      chatWhitelistSubs: ['u-vip'],
      sculptures: [
        {
          id: 'sc-art-1',
          title: 'Big cheese',
          creatorSub: 'u-contrib',
          chatSummary: { initialized: true, messageCount: 2 }
        }
      ]
    };

    // Art contributor -> UNLOCKED under default 'contributors' mode!
    let opened = 0;
    const contribView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: baseLand,
        isSignedIn: true,
        userId: 'u-contrib',
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {
          opened += 1;
        },
        onClose: () => {}
      })
    );
    assert.equal(contribView.getByTestId('ar-land-chat-btn').getAttribute('data-locked'), 'false');
    RTL.fireEvent.click(contribView.getByTestId('ar-land-chat-btn'));
    assert.equal(opened, 1);
    cleanup();

    // Non-contributor visitor -> LOCKED under default 'contributors' mode with "i" reason
    const guestView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: baseLand,
        isSignedIn: true,
        userId: 'u-stranger',
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {
          opened += 1;
        },
        onClose: () => {}
      })
    );
    const guestBtn = guestView.getByTestId('ar-land-chat-btn');
    assert.equal(guestBtn.getAttribute('data-locked'), 'true');
    const guestInfo = guestView.getByTestId('ar-land-chat-lock-info');
    RTL.fireEvent.click(guestInfo.querySelector('.info-tip-btn'));
    assert.match(guestInfo.textContent, /contributors by default/i);
    cleanup();

    // Whitelist-only mode -> blocks art contributor, unlocks whitelisted VIP
    const wlContribView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: { ...baseLand, chatAccessMode: 'whitelist' },
        isSignedIn: true,
        userId: 'u-contrib',
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {},
        onClose: () => {}
      })
    );
    assert.equal(wlContribView.getByTestId('ar-land-chat-btn').getAttribute('data-locked'), 'true');
    const wlInfo = wlContribView.getByTestId('ar-land-chat-lock-info');
    RTL.fireEvent.click(wlInfo.querySelector('.info-tip-btn'));
    assert.match(wlInfo.textContent, /whitelist-only/i);
    cleanup();

    const wlVipView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: { ...baseLand, chatAccessMode: 'whitelist' },
        isSignedIn: true,
        userId: 'u-vip',
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {},
        onClose: () => {}
      })
    );
    assert.equal(wlVipView.getByTestId('ar-land-chat-btn').getAttribute('data-locked'), 'false');
    cleanup();

    // Off mode -> locks button with "turned off" info AND suppresses live bell chat notification
    const offView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: { ...baseLand, chatAccessMode: 'off' },
        isSignedIn: true,
        userId: 'u-owner',
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {},
        onClose: () => {}
      })
    );
    assert.equal(offView.getByTestId('ar-land-chat-btn').getAttribute('data-locked'), 'true');
    const offInfo = offView.getByTestId('ar-land-chat-lock-info');
    RTL.fireEvent.click(offInfo.querySelector('.info-tip-btn'));
    assert.match(offInfo.textContent, /turned off/i);
    assert.equal(
      buildLiveLandChatNotification({ ...baseLand, chatAccessMode: 'off' }, { userId: 'u-owner' }),
      null
    );
    cleanup();
  });

  test('3. LandManagementModal lets land holder switch chatAccessMode (Contributors / Open / Whitelist / Off) and manage Chat Whitelist', async () => {
    const { default: LandManagementModal } = await loadJsxModule(
      'client/src/components/LandManagementModal.jsx'
    );

    let savedSettingsPayload = null;
    let addedWhitelistPayload = null;
    let whitelistMembers = [];

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/api/lands/mine')) {
        return new Response(
          JSON.stringify({
            parcelCount: 1,
            sculptureCount: 1,
            parcels: [
              {
                parcelId: 'GLAND-MYLAND1',
                customName: 'Stibblez Land',
                displayName: 'Stibblez Land',
                centerLat: 39.728,
                centerLng: -121.838,
                settings: {
                  allowAgentErase: true,
                  allowContributorEdits: true,
                  requireApproval: false,
                  frozen: false,
                  chatAccessMode: savedSettingsPayload?.chatAccessMode || 'contributors'
                },
                chatAccessMode: savedSettingsPayload?.chatAccessMode || 'contributors',
                contributors: [],
                chatWhitelist: whitelistMembers,
                eligibleVisitors: [
                  {
                    userId: 'u-art1',
                    username: 'bigdog',
                    name: '@bigdog',
                    isArtContributor: true
                  }
                ],
                sculptures: []
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/api/passkeys')) {
        return new Response(JSON.stringify({ passkeys: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/update') && opts.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/settings') && opts.method === 'POST') {
        savedSettingsPayload = JSON.parse(opts.body || '{}');
        return new Response(JSON.stringify({ settings: savedSettingsPayload }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/security') && opts.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/chat-whitelist') && opts.method === 'POST') {
        addedWhitelistPayload = JSON.parse(opts.body || '{}');
        whitelistMembers = [
          {
            userSub: 'u-art1',
            username: 'bigdog',
            name: '@bigdog',
            walletAddress: '0x1111111111111111111111111111111111111111'
          }
        ];
        return new Response(
          JSON.stringify({
            ok: true,
            member: whitelistMembers[0],
            whitelist: whitelistMembers
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const view = RTL.render(
      React.createElement(LandManagementModal, {
        user: { id: 'u-owner', username: 'dukenukem' },
        onClose: () => {}
      })
    );

    const select = await view.findByTestId('land-chat-access-select');
    assert.equal(select.value, 'contributors');

    // Switch to Whitelist Only -> shows badge & lets holder whitelist @bigdog
    RTL.fireEvent.change(select, { target: { value: 'whitelist' } });
    assert.ok(view.getByTestId('land-chat-whitelist-section').textContent.includes('Whitelist Only Active'));

    const wlInput = view.getByTestId('chat-whitelist-input');
    RTL.fireEvent.change(wlInput, { target: { value: '@bigdog' } });
    await RTL.act(async () => {
      RTL.fireEvent.click(view.getByTestId('chat-whitelist-add-btn'));
    });
    assert.deepEqual(addedWhitelistPayload, { identifier: '@bigdog' });
    await view.findByTestId('chat-whitelist-member-row');

    // Save settings -> persists chatAccessMode: 'whitelist'
    await RTL.act(async () => {
      RTL.fireEvent.submit(select.closest('form'));
    });
    assert.equal(savedSettingsPayload.chatAccessMode, 'whitelist');

    // Switch to Off -> Chat Whitelist section cleanly hides
    RTL.fireEvent.change(view.getByTestId('land-chat-access-select'), { target: { value: 'off' } });
    assert.equal(view.queryByTestId('land-chat-whitelist-section'), null);
    cleanup();
  });

  test('4. In-app Guide and ENCRYPTED_LOCATION_CHAT docs document default contributor chat, whitelist, and off mode', async () => {
    const { default: InfoTermsModal } = await loadJsxModule(
      'client/src/components/InfoTermsModal.jsx'
    );

    const view = RTL.render(
      React.createElement(InfoTermsModal, {
        config: {},
        onClose: () => {}
      })
    );
    RTL.fireEvent.click(view.getByText(/Mobile AR Studio/i));
    assert.match(view.container.textContent, /Whitelist Only/i);
    assert.match(view.container.textContent, /contributors/i);
    RTL.fireEvent.click(view.getByText(/AI Agents & Collectors/i));
    assert.match(view.container.textContent, /Whitelist Only/i);
    cleanup();

    const docText = fs.readFileSync(
      path.join(ROOT, 'docs/ENCRYPTED_LOCATION_CHAT.md'),
      'utf8'
    );
    assert.match(docText, /chat_access_mode/);
    assert.match(docText, /land_chat_whitelist/);
    assert.match(docText, /manage_land_chat_whitelist/);
  });
});
