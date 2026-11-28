import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-webxr-chat-ux-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';
process.env.ROBINHOOD_ROYALTY_RECEIVER = '';

const { createAppServer } = await import('../server/index.mjs');
const chatCrypto = await import('../client/src/utils/chatCrypto.js');
const {
  AR_WORLD_ANCHOR_STATIONARY_DEADZONE_M,
  AR_WORLD_ANCHOR_WALK_STEP_M,
  AR_WORLD_ANCHOR_WEBXR_RELOCATE_M,
  resolveStableArWorldAnchor
} = await import('../client/src/utils/arWalkingApproach.js');
const { computeArLandCameraGuidance } = await import('../client/src/utils/arLandGuidance.js');
const { abbreviateEthAddress } = await import('../client/src/utils/ethAddress.js');
const { startWebXrArSession } = await import('../client/src/utils/webxrArSession.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function makeValidPol(lat, lng) {
  const now = Date.now();
  return {
    cameraFrames: 12,
    gyroSamples: 24,
    gyroVariance: 3.1,
    opticalFlowCorrelation: 0.74,
    opticalFlowSamples: 8,
    gpsSamples: [
      { lat, lng, accuracy: 6, altitude: 20, ts: now - 4000 },
      { lat: lat + 0.000005, lng: lng + 0.000005, accuracy: 6, altitude: 20, ts: now - 2000 },
      { lat, lng, accuracy: 5, altitude: 20, ts: now }
    ],
    horizonLuma: 145,
    ambientPalette: ['#112233', '#223344', '#334455', '#445566', '#556677'],
    visualDHash: 'a1b2c3d4e5f60718',
    sceneScan: { optimal: true, scannedCount: 9, targetCount: 9, coveragePct: 100 }
  };
}

describe('WebXR Camera Fix, Cross-Device E2EE Chat Fix, Stable AR + Right Mode Toggle & Clean Publish UX', () => {
  let srv;
  let baseUrl;
  let dom;
  let React;
  let RTL;
  let cleanup;
  let uiTmpDir;
  let origFetch;
  let origClipboard;

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

  async function loadJsxModule(relPath) {
    const absIn = path.join(ROOT, relPath);
    const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const absOut = path.join(
      uiTmpDir,
      `${safeName}_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`
    );
    await esbuild.build({
      entryPoints: [absIn],
      outfile: absOut,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      define: { 'import.meta.env': '{}' },
      loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' }
    });
    return import(pathToFileURL(absOut).href);
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

    uiTmpDir = fs.mkdtempSync(path.join(ROOT, '.tmp-webxr-ux-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.localStorage = dom.window.localStorage;
    origClipboard = dom.window.navigator.clipboard;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    origFetch = globalThis.fetch;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(async () => {
    cleanup?.();
    globalThis.fetch = origFetch;
    if (dom?.window) {
      Object.defineProperty(dom.window.navigator, 'clipboard', {
        value: origClipboard,
        configurable: true
      });
      dom.window.close();
    }
    if (srv) {
      await new Promise((resolve) => srv.close(resolve));
    }
    try {
      fs.rmSync(uiTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error on Windows
    }
    try {
      fs.rmSync(testTmpDir, { recursive: true, force: true });
    } catch {
      // ignore SQLite file handle cleanup on Windows
    }
  });

  test('1. WebXR fullscreen camera handoff releases getUserMedia first, clears XR alpha to 0, and keeps :fullscreen/:xr-overlay transparent', async () => {
    // 1A) startWebXrArSession calls makeXRCompatible, clears alpha=0, enables XR, and attaches dom-overlay
    let makeXrCalls = 0;
    let clearAlphaArgs = null;
    let clearColorArgs = null;
    let setSessionCalled = false;
    let requestedInit = null;
    const mockSession = {
      addEventListener() {},
      removeEventListener() {},
      requestReferenceSpace: async () => ({}),
      end: async () => {}
    };
    const origXr = globalThis.navigator.xr;
    Object.defineProperty(globalThis.navigator, 'xr', {
      value: {
        requestSession: async (mode, init) => {
          assert.equal(mode, 'immersive-ar');
          requestedInit = init;
          return mockSession;
        }
      },
      configurable: true
    });

    const mockRenderer = {
      getContext: () => ({
        makeXRCompatible: async () => {
          makeXrCalls += 1;
        }
      }),
      setClearColor: (c, a) => {
        clearColorArgs = [c, a];
      },
      setClearAlpha: (a) => {
        clearAlphaArgs = a;
      },
      clear: () => {},
      xr: {
        enabled: false,
        setReferenceSpaceType() {},
        setSession: async () => {
          setSessionCalled = true;
        }
      }
    };

    try {
      const overlayEl = globalThis.document.getElementById('root');
      const ctrl = await startWebXrArSession({
        renderer: mockRenderer,
        overlayRoot: overlayEl,
        seedTrueHeadingDeg: 0
      });
      assert.equal(makeXrCalls, 1, 'Expected gl.makeXRCompatible() before renderer.xr.setSession');
      assert.deepEqual(clearColorArgs, [0x000000, 0]);
      assert.equal(clearAlphaArgs, 0);
      assert.equal(mockRenderer.xr.enabled, true);
      assert.equal(setSessionCalled, true);
      assert.equal(requestedInit?.domOverlay?.root, overlayEl);
      await ctrl.stop();
    } finally {
      Object.defineProperty(globalThis.navigator, 'xr', {
        value: origXr,
        configurable: true
      });
    }

    // 1B) Verify CSS scopes opaque #000 fullscreen strictly away from .webxr-ar-active & keeps :xr-overlay transparent
    const cssText = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    assert.ok(
      cssText.includes('html:fullscreen:not(.webxr-ar-active)'),
      'Opaque fullscreen background must exclude .webxr-ar-active'
    );
    assert.ok(
      cssText.includes('#root:xr-overlay') && cssText.includes('.mobile-fullscreen.is-webxr-active::backdrop'),
      'WebXR :xr-overlay and ::backdrop must be explicitly transparent'
    );

    // 1C) Verify MobileStudio releases getUserMedia BEFORE starting WebXR (prevents Android Camera2 HAL black screen)
    const mobileSrc = fs.readFileSync(path.join(ROOT, 'client/src/components/MobileStudio.jsx'), 'utf8');
    const releaseIdx = mobileSrc.indexOf('await pol.releaseCameraForWebXr?.()');
    const startIdx = mobileSrc.indexOf('await ctrl.start()', releaseIdx);
    assert.ok(releaseIdx > 0 && startIdx > releaseIdx, 'Must release getUserMedia before ctrl.start()');

    // 1D) Verify ARViewportCanvas guards resize / setPixelRatio / envUpdater / occlusion against activeXrSession
    const canvasSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.ok(canvasSrc.includes('if (!host || activeXrSession) return;'));
    assert.ok(canvasSrc.includes('scene.background = null;'));
    assert.ok(canvasSrc.includes('!activeXrSession &&'));
  });

  test('2. Land Chat never returns another device grant (eliminating ECDSA signature error) & allows land holder 1-tap epoch reset on new phone', async () => {
    const auth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'owner@spray.land', name: 'BigDog' } })
    });
    assert.equal(auth.status, 200);
    const token = auth.body.token;
    const ownerLat = 33.8302;
    const ownerLng = -116.5453;

    const mobileUa = 'Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 Mobile Safari/537.36';
    const pubRes = await apiJson('/api/sculptures/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        title: 'Twin Palms Art',
        description: 'Palm springs piece',
        location: { lat: ownerLat, lng: ownerLng, accuracy: 6, altitude: 20 },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0.08, y: 0, z: 0, color: '#ff3e7f', material: 'matte' },
          { x: 0, y: 0.08, z: 0, color: '#ffd166', material: 'glass' }
        ],
        proofOfLocation: makeValidPol(ownerLat, ownerLng),
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 },
        termsAccepted: true
      })
    });
    assert.equal(pubRes.status, 201, JSON.stringify(pubRes.body));
    const sculptureId = pubRes.body.sculpture.id;

    // Phone A generates identity + room key and initializes Land Chat (epoch 1)
    const idPhoneA = await chatCrypto.getOrCreateDeviceIdentity('owner-phone-a');
    const roomKey1 = chatCrypto.generateRoomKeyB64();
    const { roomKeyCommit: roomCommit1 } = await chatCrypto.computeRoomPossessionProof(
      roomKey1,
      sculptureId,
      1
    );
    const selfWrapA = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64: roomKey1,
      recipientEcdhPubJwk: idPhoneA.ecdhPublicJwk,
      grantorIdentity: idPhoneA,
      sculptureId,
      keyEpoch: 1,
      recipientPubFp: idPhoneA.pubFingerprint
    });

    const initRes = await apiJson(`/api/sculptures/${encodeURIComponent(sculptureId)}/chat/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        roomKeyCommit: roomCommit1,
        ownerEcdhPubJwk: idPhoneA.ecdhPublicJwk,
        ownerSignPubJwk: idPhoneA.signPublicJwk,
        ownerPubFp: idPhoneA.pubFingerprint,
        selfGrantEnvelope: selfWrapA.wrappedKeyJson,
        selfGrantSig: selfWrapA.grantSig,
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 }
      })
    });
    assert.equal(initRes.status, 200, JSON.stringify(initRes.body));
    assert.equal(initRes.body.board.keyEpoch, 1);

    // Phone B (different browser/device -> different ECDSA/ECDH fingerprint) enters the SAME land chat
    const idPhoneB = await chatCrypto.getOrCreateDeviceIdentity('owner-phone-b');
    assert.notEqual(idPhoneA.pubFingerprint, idPhoneB.pubFingerprint);

    const enterBRes = await apiJson(`/api/sculptures/${encodeURIComponent(sculptureId)}/chat/enter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        requesterPubFp: idPhoneB.pubFingerprint,
        sightProof: {
          lat: ownerLat,
          lng: ownerLng,
          accuracy: 5,
          cameraReady: true,
          inFrustum: true,
          cameraActive: true,
          cameraFrames: 10,
          opticalFlowCorrelation: 0.7,
          gyroVariance: 2.4,
          visualDHash: '1234567890abcdef',
          selectionMethod: 'ar-camera-raycast',
          rayHit: true,
          selectedAt: new Date().toISOString()
        },
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 }
      })
    });
    assert.equal(enterBRes.status, 200, JSON.stringify(enterBRes.body));
    assert.equal(
      enterBRes.body.myGrant,
      null,
      'Must NEVER return Phone A grant envelope to Phone B (prevents ECDSA verification failure!)'
    );
    assert.equal(enterBRes.body.otherDeviceHasGrant, true);

    // Non-owner cannot rotate epoch with forceResetEpoch
    const otherAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'stranger@spray.land', name: 'Stranger' } })
    });
    const strangerReset = await apiJson(
      `/api/sculptures/${encodeURIComponent(sculptureId)}/chat/init`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${otherAuth.body.token}`, 'User-Agent': mobileUa },
        body: JSON.stringify({
          forceResetEpoch: true,
          roomKeyCommit: roomCommit1,
          ownerEcdhPubJwk: idPhoneB.ecdhPublicJwk,
          ownerSignPubJwk: idPhoneB.signPublicJwk,
          ownerPubFp: idPhoneB.pubFingerprint,
          selfGrantEnvelope: selfWrapA.wrappedKeyJson,
          selfGrantSig: selfWrapA.grantSig,
          deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 }
        })
      }
    );
    assert.equal(strangerReset.status, 403);

    // Land holder resets key epoch to Epoch 2 cleanly on Phone B!
    const roomKey2 = chatCrypto.generateRoomKeyB64();
    const { roomKeyCommit: roomCommit2 } = await chatCrypto.computeRoomPossessionProof(
      roomKey2,
      sculptureId,
      2
    );
    const selfWrapB = await chatCrypto.wrapRoomKeyForRecipient({
      roomKeyB64: roomKey2,
      recipientEcdhPubJwk: idPhoneB.ecdhPublicJwk,
      grantorIdentity: idPhoneB,
      sculptureId,
      keyEpoch: 2,
      recipientPubFp: idPhoneB.pubFingerprint
    });
    const resetRes = await apiJson(`/api/sculptures/${encodeURIComponent(sculptureId)}/chat/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
      body: JSON.stringify({
        forceResetEpoch: true,
        roomKeyCommit: roomCommit2,
        ownerEcdhPubJwk: idPhoneB.ecdhPublicJwk,
        ownerSignPubJwk: idPhoneB.signPublicJwk,
        ownerPubFp: idPhoneB.pubFingerprint,
        selfGrantEnvelope: selfWrapB.wrappedKeyJson,
        selfGrantSig: selfWrapB.grantSig,
        deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 }
      })
    });
    assert.equal(resetRes.status, 200, JSON.stringify(resetRes.body));
    assert.equal(resetRes.body.board.keyEpoch, 2);

    // Phone B now enters and receives its own valid Epoch 2 grant and unwraps cleanly with zero ECDSA error!
    const enterBAfter = await apiJson(
      `/api/sculptures/${encodeURIComponent(sculptureId)}/chat/enter`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': mobileUa },
        body: JSON.stringify({
          requesterPubFp: idPhoneB.pubFingerprint,
          sightProof: {
            lat: ownerLat,
            lng: ownerLng,
            accuracy: 5,
            cameraReady: true,
            inFrustum: true,
            cameraActive: true,
            cameraFrames: 10,
            opticalFlowCorrelation: 0.7,
            gyroVariance: 2.4,
            visualDHash: '1234567890abcdef',
            selectionMethod: 'ar-camera-raycast',
            rayHit: true,
            selectedAt: new Date().toISOString()
          },
          deviceProfile: { isMobile: true, hasCamera: true, screenWidth: 390, screenHeight: 844 }
        })
      }
    );
    assert.equal(enterBAfter.status, 200);
    assert.ok(enterBAfter.body.myGrant, 'Phone B should now have its own Epoch 2 grant');
    assert.equal(enterBAfter.body.myGrant.requesterPubFp, idPhoneB.pubFingerprint);
    const unwrapped = await chatCrypto.unwrapRoomKeyFromGrant({
      wrappedKeyJson: enterBAfter.body.myGrant.wrappedKeyJson,
      grantSig: enterBAfter.body.myGrant.grantSig,
      grantorSignPubJwk: enterBAfter.body.myGrant.grantorSignPubJwk,
      sculptureId: enterBAfter.body.boardId,
      keyEpoch: enterBAfter.body.board.keyEpoch,
      identity: idPhoneB
    });
    assert.equal(unwrapped, roomKey2);
  });

  test('3. Stable AR world anchor prevents stationary GPS slipping, inside-land guidance never directs you to your own land, and right-side 2-button toggle switches Review <-> Tool', async () => {
    // 3A) resolveStableArWorldAnchor keeps items rock-solid still under stationary GPS jitter
    const start = { lat: 33.8302, lng: -116.5453, altitude: 120 };
    const anchor1 = resolveStableArWorldAnchor(null, start, {
      webxrActive: false,
      isWalking: false
    });
    assert.equal(anchor1.lat, start.lat);
    assert.equal(anchor1.lng, start.lng);
    assert.equal(anchor1.altitude, start.altitude);

    // ±3.0m GPS multipath jump while standing still -> anchor MUST NOT move!
    const jittered = { lat: 33.830225, lng: -116.545285, altitude: 121.2 };
    const anchorStill = resolveStableArWorldAnchor(anchor1, jittered, {
      webxrActive: false,
      isWalking: false
    });
    assert.equal(anchorStill.lat, start.lat);
    assert.equal(anchorStill.lng, start.lng);
    assert.ok(AR_WORLD_ANCHOR_STATIONARY_DEADZONE_M >= 4);

    // Walking >= 2.2m updates smoothly
    const walked = { lat: 33.83023, lng: -116.5453, altitude: 120 }; // ~3.3m north
    const anchorWalked = resolveStableArWorldAnchor(anchor1, walked, {
      webxrActive: false,
      isWalking: true
    });
    assert.equal(anchorWalked.lat, walked.lat);
    assert.ok(AR_WORLD_ANCHOR_WALK_STEP_M >= 2);

    // WebXR stays locked up to 35m so ARCore 6-DoF handles all physical parallax with zero GPS jump
    const anchorXr = resolveStableArWorldAnchor(anchor1, walked, {
      webxrActive: true,
      isWalking: true
    });
    assert.equal(anchorXr.lat, start.lat);
    assert.ok(AR_WORLD_ANCHOR_WEBXR_RELOCATE_M >= 30);

    // 3B) Standing inside a land NEVER produces directional guidance arrows
    const camera = new THREE.PerspectiveCamera(68, 390 / 844, 0.05, 120);
    camera.position.set(0, 0.4, 0);
    camera.lookAt(0, 0.4, -10);
    camera.updateMatrixWorld();

    const insideGuide = computeArLandCameraGuidance({
      targetWorld: new THREE.Vector3(6, 0.4, 10), // behind camera, but user IS inside parcel!
      camera,
      isInside: true,
      distanceMeters: 0
    });
    assert.equal(insideGuide.inView, true);
    assert.equal(insideGuide.isInside, true);
    assert.equal(insideGuide.edge, 'center');

    const { default: ARLandGuidanceOverlay } = await loadJsxModule(
      'client/src/components/studio/ARLandGuidanceOverlay.jsx'
    );
    const insideView = RTL.render(
      React.createElement(ARLandGuidanceOverlay, {
        land: { parcelId: 'GLAND-TWIN', displayName: 'Twin Palms', isInside: true },
        guidance: { inView: false, edge: 'right', instruction: 'Move camera right', turnDegrees: 45 }
      })
    );
    assert.equal(insideView.container.innerHTML, '', 'Must render nothing when user is inside the land');
    cleanup();

    const outsideView = RTL.render(
      React.createElement(ARLandGuidanceOverlay, {
        land: { parcelId: 'GLAND-FAR', displayName: 'Far Park', isInside: false },
        guidance: { inView: false, isInside: false, edge: 'right', instruction: 'Move camera right', turnDegrees: 45, distanceMeters: 25 }
      })
    );
    assert.ok(outsideView.getByTestId('ar-land-guidance-overlay'));
    cleanup();

    // 3C) Right-side big 2-button ARModeSwitchToggle switches cleanly between current tool & Review
    const { default: ARModeSwitchToggle } = await loadJsxModule(
      'client/src/components/studio/ARModeSwitchToggle.jsx'
    );
    const events = [];
    const toggleView = RTL.render(
      React.createElement(ARModeSwitchToggle, {
        mode: 'draw',
        selectedToolId: 'pencil',
        onSelectTool: (id) => events.push(['tool', id]),
        onSelectReview: () => events.push(['review'])
      })
    );
    const toolBtn = toggleView.getByTestId('ar-mode-toggle-tool');
    const reviewBtn = toggleView.getByTestId('ar-mode-toggle-review');
    assert.equal(toolBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(reviewBtn.getAttribute('aria-pressed'), 'false');
    assert.ok(toolBtn.textContent.includes('Pencil'));
    assert.ok(reviewBtn.textContent.includes('Review'));

    RTL.fireEvent.click(reviewBtn);
    assert.deepEqual(events[0], ['review']);

    toggleView.rerender(
      React.createElement(ARModeSwitchToggle, {
        mode: 'preview',
        selectedToolId: 'pencil',
        onSelectTool: (id) => events.push(['tool', id]),
        onSelectReview: () => events.push(['review'])
      })
    );
    assert.equal(toggleView.getByTestId('ar-mode-toggle-tool').getAttribute('aria-pressed'), 'false');
    assert.equal(toggleView.getByTestId('ar-mode-toggle-review').getAttribute('aria-pressed'), 'true');
    RTL.fireEvent.click(toggleView.getByTestId('ar-mode-toggle-tool'));
    assert.deepEqual(events[1], ['tool', 'pencil']);
    cleanup();
  });

  test('4. Publish modal focuses Title first, moves verbose/technical copy into "i" popovers, and abbreviates Eth addresses with copy button', async () => {
    const FULL_ETH = '0x66E681150eEf6AC5AAe1edc9EDc5133eC38e0Fe5';
    assert.equal(abbreviateEthAddress(FULL_ETH), '0x66E6…0Fe5');

    let copiedText = '';
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: {
        writeText: async (txt) => {
          copiedText = txt;
        }
      },
      configurable: true
    });

    const { default: PublishSculptureModal } = await loadJsxModule(
      'client/src/components/studio/PublishSculptureModal.jsx'
    );

    const view = RTL.render(
      React.createElement(PublishSculptureModal, {
        config: { policy: { titleMax: 48, descriptionMax: 240, descriptionMaxWords: 45 } },
        user: {
          id: 'u-bigdog',
          email: 'publicaccessdrawing@gmail.com',
          walletAddress: FULL_ETH,
          activeMintRecipient: FULL_ETH
        },
        voxels: [{ x: 0, y: 0, z: 0, c: '#00f5d4' }],
        polStats: { frames: 18, flow: 82 },
        location: { lat: 33.83, lng: -116.54, altitude: 144 },
        orbStatus: { keyframes: 3, features: 64 },
        activeTargetLand: { parcelId: 'GLAND-TP', customName: 'Twin Palms', isInside: true },
        passkeyCount: 0,
        passkeyBusy: false,
        onEnrollPasskey: async () => {},
        title: '',
        setTitle: () => {},
        description: '',
        setDescription: () => {},
        cluePrompt: '',
        setCluePrompt: () => {},
        clueAnswer: '',
        setClueAnswer: () => {},
        termsAccepted: true,
        setTermsAccepted: () => {},
        publishing: false,
        publishError: '',
        setPublishError: () => {},
        mintReceipt: null,
        mcpPairingsState: { mcpActive: true, activePairing: { code: 'GLP-VZRZ-F8RB-HRKT-XKVQ' } },
        agentPublishPrompt: null,
        draftsBusy: false,
        draftStatusText: '',
        onSubmitPublish: (e) => e.preventDefault(),
        onCopyAgentPublishPrompt: () => {},
        onManualSaveDraft: () => {},
        onOpenInfo: () => {},
        onOpenPair: () => {},
        onOpenManageLand: () => {},
        onViewInARPreview: () => {},
        onShowHint: () => {},
        onClose: () => {}
      })
    );

    // 4A) Title field MUST receive focus first (NOT Description!)
    const titleInput = view.getByTestId('publish-title-input');
    const descInput = view.getByTestId('publish-description-input');
    assert.equal(globalThis.document.activeElement, titleInput, 'Title input must be focused first on open');
    assert.notEqual(globalThis.document.activeElement, descInput, 'Description must NOT steal initial focus');

    // 4B) Visible modal text is clean — no raw email, no full 42-char Eth address, no verbose/technical jargon outside "i"
    const modalText = view.getByTestId('publish-sculpture-modal').textContent;
    assert.ok(!modalText.includes('publicaccessdrawing@gmail.com'), 'Must not leak raw Gmail in Publish sheet');
    assert.ok(!modalText.includes(FULL_ETH), 'Must never display full unabbreviated Eth address');
    assert.ok(!modalText.includes('Limited Terms'), 'Technical description text must live inside "i"');
    assert.ok(!modalText.includes('PBKDF2'), 'Crypto jargon must live inside "i"');
    assert.ok(!modalText.includes('24/7 Solo Unlock'), 'Verbose clue copy must live inside "i"');
    assert.ok(!modalText.includes('ORB Angles'), 'ORB telemetry jargon must live inside "i"');

    // 4C) Wallet is abbreviated as 0x66E6…0Fe5 with a working copy button right next to it
    const walletBadge = view.getByTestId('publish-recipient-wallet');
    assert.ok(walletBadge.textContent.includes('0x66E6…0Fe5'));
    const copyBtn = view.getByTestId('publish-wallet-copy-btn');
    await RTL.act(async () => {
      RTL.fireEvent.click(copyBtn);
    });
    assert.equal(copiedText, FULL_ETH, 'Copy icon must copy the full Ethereum address');

    // 4D) Clicking "i" next to Chat Clue reveals the technical E2EE / PBKDF2 / 24/7 Solo Unlock explanation
    const infoButtons = view.getByTestId('publish-sculpture-modal').querySelectorAll('button[aria-expanded]');
    assert.ok(infoButtons.length >= 6, `Expected InfoTip "i" buttons next to fields, got ${infoButtons.length}`);
    let revealedCryptoInfo = false;
    for (const btn of infoButtons) {
      RTL.fireEvent.click(btn);
      if (view.getByTestId('publish-sculpture-modal').textContent.includes('PBKDF2')) {
        revealedCryptoInfo = true;
        break;
      }
    }
    assert.equal(revealedCryptoInfo, true, 'Clicking "i" next to Chat Clue must reveal PBKDF2 details');
    cleanup();
  });
});
