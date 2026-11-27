import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import { POLICY } from '../shared/constants.mjs';
import { buildLlmsTxt, buildWellKnownAgentCard } from '../shared/agentService.mjs';
import { buildPropertyOwnerPrompt } from '../shared/landSignatureMessage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-profile-mcp-'));
process.env.GRAFFILAND_DB_PATH = path.join(testDbDir, 'profile-mcp.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testDbDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');

describe('AR HUD Cleanup, Land-Style 3D Gizmo Bars, Profile Settings Gear & Paired Agent Profile MCP', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;
  let server;
  let baseUrl;

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
      loader: { '.svg': 'dataurl' },
      define: { 'import.meta.env': '{}' },
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({ path: 'stub.css', namespace: 'stub-css' }));
            build.onResolve({ filter: /\?url$/ }, () => ({ path: 'stub-url', namespace: 'stub-url' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({ contents: '', loader: 'js' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
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

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-ar-hud-gizmo-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: {
        writeText: async (txt) => {
          globalThis.__lastCopiedText = txt;
        }
      },
      configurable: true
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    dom.window.HTMLCanvasElement.prototype.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w || 1) * (h || 1) * 4)) }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w || 1) * (h || 1) * 4)) }),
      putImageData: () => {},
      clearRect: () => {},
      drawImage: () => {}
    });

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;

    const { server: srv } = createAppServer({ publishRateLimit: 200, mcpRateLimit: 400 });
    server = srv;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    cleanup?.();
    dom?.window?.close();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
    if (testDbDir) {
      try {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows SQLite lock on temp cleanup
      }
    }
  });

  test('1. Calibration dock sits above bottom tool selector with shrink-to-dock animation', async () => {
    const { default: SceneCoverageWidget } = await loadJsxModule(
      'client/src/components/studio/SceneCoverageWidget.jsx'
    );
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    assert.match(css, /@keyframes calibration-shrink-to-dock/);
    assert.match(css, /\.scene-scan-box\.collapsed\.minimized-fab\.just-locked[\s\S]*calibration-shrink-to-dock/);

    const view = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: { coveragePct: 100, scannedCount: 9, targetCount: 9, optimal: true, grid: Array(12).fill(true) },
        orbStatus: { engine: 'Gyro+ORB', keyframes: 3, relocalizedInliers: 18 },
        scanBoxCollapsed: true,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrated',
        calibrationJustLocked: true
      })
    );
    const widget = view.getByTestId('scene-coverage-widget');
    assert.equal(widget.getAttribute('data-placement'), 'above-carousel');
    assert.ok(widget.className.includes('just-locked'));
    view.unmount();
  });

  test('2-4 & 7. StudioHudTopBar removes Land button and start-surface tip, and floats Search 3D with 3-blocks badge above Maps', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );
    let searchClicked = 0;
    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: { id: 'u1', username: 'sprayartist' },
        mode: 'draw',
        dockOpen: false,
        location: { lat: 39.73, lng: -121.84 },
        voxels: [],
        cameraReady: true,
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true },
        surfaceAnchor: null,
        nearbyCount: 2,
        pairedCode: 'PAIR99',
        mcpPairingsState: { mcpActive: true, activePairing: { code: 'GLP-AAAA-BBBB-CCCC-DDDD' } },
        onOpenAreaMap: () => {},
        onOpenCatalogSearch: () => {
          searchClicked += 1;
        }
      })
    );

    // No Land button on drawing screen (user accesses lands via their account name/profile)
    assert.equal(view.queryByTestId('mobile-land-management-btn'), null);
    assert.ok(view.getByTestId('mobile-profile-btn'));

    // No "Tap scene to set start surface" prompt pill
    assert.equal(view.container.textContent.includes('Tap scene to set start surface'), false);
    assert.equal(view.container.querySelector('.surface-pill'), null);

    // Magnifying glass is a floating button above the Maps icon with 3 isometric blocks in a top-right circle badge
    const searchBtn = view.getByTestId('mobile-catalog-search-btn');
    assert.ok(searchBtn.className.includes('floating-catalog-search-btn'));
    const badge = view.getByTestId('floating-search-blocks-badge');
    assert.ok(searchBtn.contains(badge));
    assert.ok(badge.querySelectorAll('polygon').length >= 9, 'Mini badge should render 3 isometric 3D blocks');

    RTL.fireEvent.click(searchBtn);
    assert.equal(searchClicked, 1);

    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    assert.match(css, /\.floating-catalog-search-btn[\s\S]*\+\s*58px/);
    assert.match(css, /\.floating-search-mini-badge/);
    view.unmount();
  });

  test('5. ARLandInspectorPanel removes Draw button when user is already inside land', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    const insideLand = {
      parcelId: 'GLAND-INSIDE1',
      displayName: 'Inside Plaza',
      isInside: true,
      isOwned: true,
      isFrozen: false,
      edgeDistanceMeters: 0,
      sculptures: [{ id: 's1', title: 'Neon Arch', voxelCount: 120 }]
    };

    const compactView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: insideLand,
        defaultExpanded: false,
        onDrawHere: () => {},
        onOpenLandChat: () => {},
        onClose: () => {}
      })
    );
    assert.equal(compactView.queryByTestId('ar-land-compact-draw-btn'), null);
    compactView.unmount();

    const expandedView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: insideLand,
        defaultExpanded: true,
        onDrawHere: () => {},
        onOpenLandChat: () => {},
        onClose: () => {}
      })
    );
    assert.equal(expandedView.queryByTestId('ar-land-draw-btn'), null);
    assert.ok(expandedView.getByTestId('ar-land-chat-btn'));
    expandedView.unmount();
  });

  test('6. Lock & Scale builds Land-style 3D wireframe bars/orbs, handles bar dragging, and maps 2-finger vertical->Z-pivot & horizontal->Y-rotate', async () => {
    const { createObjectTransformGizmo, computeGizmoHandleDragStep } = await loadJsxModule(
      'client/src/utils/arTransformGizmo3D.js'
    );
    const { captureTwoFingerFrame, computeTwoFingerTransformStep } = await loadJsxModule(
      'client/src/utils/arTransformGestures.js'
    );
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');

    const gizmo = createObjectTransformGizmo();
    const counts = gizmo.getHandleCount();
    assert.deepEqual(counts, {
      bottomBars: 4,
      topBars: 4,
      verticalBars: 4,
      cornerOrbs: 8,
      heightHandle: 1
    });
    assert.ok(gizmo.getInteractiveMeshes().length >= 44, 'Every visual bar/orb + touch hit collider must be raycastable');

    const testBox = new THREE.Box3(new THREE.Vector3(-0.5, 0, -2.5), new THREE.Vector3(0.5, 1, -1.5));
    gizmo.updateFromBox(testBox, { activeHandle: 'vbar-0', colliding: false });
    assert.equal(gizmo.visible, true);

    const camQuat = new THREE.Quaternion();
    const camPos = new THREE.Vector3(0, 0.5, 0);
    const pivot = { x: 0, y: 0.5, z: -2.0 };
    const baseTr = { scale: 1, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 };

    // Handle drag behaviors match Land bars
    const scaled = computeGizmoHandleDragStep({
      handleAction: 'scale',
      dx: 40,
      dy: -20,
      cameraQuaternion: camQuat,
      cameraPosition: camPos,
      pivot,
      currentTransform: baseTr
    });
    assert.ok(scaled.scale > 1.2, `Corner orb drag should scale up, got ${scaled.scale}`);

    const rotated = computeGizmoHandleDragStep({
      handleAction: 'rotate-y',
      dx: 50,
      dy: 0,
      cameraQuaternion: camQuat,
      cameraPosition: camPos,
      pivot,
      currentTransform: baseTr
    });
    assert.ok(rotated.rotYDeg > 25, `Vertical gold bar drag should rotate Y, got ${rotated.rotYDeg}`);

    const lifted = computeGizmoHandleDragStep({
      handleAction: 'height',
      dx: 0,
      dy: -60,
      cameraQuaternion: camQuat,
      cameraPosition: camPos,
      pivot,
      currentTransform: baseTr
    });
    assert.ok(lifted.offsetY > 0.2, `Top rim / elevator bar drag up should raise +Y, got ${lifted.offsetY}`);

    const movedXZ = computeGizmoHandleDragStep({
      handleAction: 'move-xz',
      dx: 50,
      dy: -40,
      cameraQuaternion: camQuat,
      cameraPosition: camPos,
      pivot,
      currentTransform: baseTr
    });
    assert.ok(movedXZ.offsetX > 0.1 && movedXZ.offsetZ < -0.1, 'Bottom cyan bar drag should move XZ');

    // Two-finger vertical pull -> Z pivot; two-finger horizontal move -> Y rotate
    const f0 = captureTwoFingerFrame([
      { x: 140, y: 300 },
      { x: 240, y: 300 }
    ]);
    const zPivotUp = computeTwoFingerTransformStep({
      prevFrame: f0,
      nextPointers: [
        { x: 140, y: 220 },
        { x: 240, y: 220 }
      ],
      currentTransform: baseTr
    });
    assert.ok(zPivotUp.nextTransform.rotZDeg > 30, `2-finger pull up must pivot +Z, got ${zPivotUp.nextTransform.rotZDeg}`);

    const yRotLeft = computeTwoFingerTransformStep({
      prevFrame: f0,
      nextPointers: [
        { x: 60, y: 300 },
        { x: 160, y: 300 }
      ],
      currentTransform: baseTr
    });
    assert.ok(yRotLeft.nextTransform.rotYDeg < -30, `2-finger move left must rotate -Y, got ${yRotLeft.nextTransform.rotYDeg}`);

    // Verify useVoxelBrush wires gizmo.updateFromBox in transform mode
    const camera = new THREE.PerspectiveCamera(65, 390 / 844, 0.05, 100);
    camera.position.set(0, 0.5, 0);
    camera.lookAt(0, 0.5, -2);
    camera.updateMatrixWorld(true);
    const draftGroup = new THREE.Group();
    let hookApi = null;

    function Harness() {
      const api = useVoxelBrush({
        config: { policy: POLICY },
        initialDraft: {
          voxels: [{ x: 0, y: 0.5, z: -2.0, color: '#00f5d4', material: 'neon', scale: 1 }]
        },
        user: { id: 'u1', username: 'artist' },
        location: { lat: 39.73, lng: -121.84 },
        locationRef: { current: { lat: 39.73, lng: -121.84 } },
        cameraReady: true,
        sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
        polRef: { current: { getSceneCoverage: () => ({ optimal: true }), analyzeSurfacePatch: () => ({ sharpnessScore: 0.5 }) } },
        rawOrientationRef: { current: null },
        fallbackEulerRef: { current: { yaw: 0, pitch: 0 } },
        enterFullscreen: () => {},
        setSensorBanner: () => {},
        showTemporaryHint: () => {},
        canvasHostRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) } },
        cameraRef: { current: camera },
        draftGroupRef: { current: draftGroup },
        transformBoxRef: { current: gizmo },
        surfaceMarkerRef: { current: null },
        shadowPlaneRef: { current: null },
        gridHelperRef: { current: null },
        nearbyGroupRef: { current: null },
        arTargetedIdRef: { current: '' },
        setArTargetedSculpture: () => {},
        arPinPreview: null,
        openCameraSelectedChat: () => {},
        openAgentHandoffRef: { current: () => {} },
        openPublishSheetRef: { current: () => {} }
      });
      hookApi = api;
      return React.createElement('div', null, api.mode);
    }

    const view = RTL.render(React.createElement(Harness));
    assert.equal(gizmo.visible, false);
    await RTL.act(async () => {
      hookApi.enterTransformMode();
    });
    assert.equal(hookApi.mode, 'transform');
    assert.equal(gizmo.visible, true, 'Entering Lock & Scale must display the Land-style 3D gizmo bars');
    gizmo.dispose();
    view.unmount();
  });

  test('8a. ProfileModal provides ⚙️ Settings gear folding expanded Measurement Units + Wallet + Paired Agent info + Copy Link & "i"', async () => {
    const { default: ProfileModal } = await loadJsxModule('client/src/components/ProfileModal.jsx');
    const mockOwner = { id: 'u-gear-1', username: 'gear_artist', bio: '3D AR builder' };
    const fetchProfileFn = async () => ({
      profile: {
        id: 'u-gear-1',
        username: 'gear_artist',
        displayName: '@gear_artist',
        bio: '3D AR builder',
        userNumber: 7,
        userNumberLabel: '#0007',
        accountType: 'human',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678'
      },
      stats: { landCount: 1, sculptureCount: 2, activeListingCount: 0, questCount: 0, actionCount: 0, totalBlocks: 20, awakenedLands: 1, totalXp: 200 },
      lands: [],
      sculptures: [],
      listings: [],
      actions: []
    });

    let walletOpened = 0;
    let view;
    await RTL.act(async () => {
      view = RTL.render(
        React.createElement(ProfileModal, {
          handle: 'gear_artist',
          user: mockOwner,
          fetchProfileFn,
          onOpenWalletSettings: () => {
            walletOpened += 1;
          },
          onLogout: () => {},
          onClose: () => {}
        })
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    // Copy Link button works and copies the public ?u= URL
    const shareCopyBtn = view.getByTestId('profile-share-copy-btn');
    await RTL.act(async () => {
      RTL.fireEvent.click(shareCopyBtn);
    });
    assert.match(String(globalThis.__lastCopiedText || ''), /\?u=gear_artist/);

    // "i" tooltip in profile documents paired agent profile updates
    RTL.fireEvent.click(
      view.getByRole('button', { name: /Info: Share Profile & Paired Agent Updates/i })
    );
    assert.ok(view.container.textContent.includes('update_profile'));
    assert.ok(view.container.textContent.includes('get_my_profile'));

    // Settings panel starts folded behind the ⚙️ gear icon (no loose MeasurementUnitSetting)
    assert.equal(view.queryByTestId('profile-settings-panel'), null);
    assert.equal(view.queryByTestId('measurement-unit-setting'), null);

    // Clicking ⚙️ gear expands User Settings with full (non-compact) Measurement Units + Wallet + Paired Agent note
    const gearBtn = view.getByTestId('profile-settings-gear-btn');
    assert.equal(gearBtn.getAttribute('aria-expanded'), 'false');
    RTL.fireEvent.click(gearBtn);
    assert.equal(gearBtn.getAttribute('aria-expanded'), 'true');
    const settingsPanel = view.getByTestId('profile-settings-panel');
    const unitSetting = view.getByTestId('measurement-unit-setting');
    assert.equal(unitSetting.className.includes('is-compact'), false, 'Measurement Units inside Settings gear must use expanded view');
    assert.ok(settingsPanel.textContent.includes('Auto (Location)'));
    assert.ok(settingsPanel.textContent.includes('US (ft, mi)'));
    assert.ok(settingsPanel.textContent.includes('Metric (m, km)'));
    assert.ok(view.getByTestId('profile-agent-sync-note').textContent.includes('update_profile'));

    RTL.fireEvent.click(view.getByTestId('profile-settings-wallet-btn'));
    assert.equal(walletOpened, 1);
    view.unmount();
  });

  test('8b. Paired AI agent can read & update user profile via MCP (get_my_profile & update_profile) and docs cover it', async () => {
    // Register two humans (alice and bob)
    const aliceAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'alice_profile@example.com', name: 'Alice' } })
    });
    assert.equal(aliceAuth.status, 200);
    const aliceToken = aliceAuth.body.token;
    const aliceWallet = aliceAuth.body.user.walletAddress;

    const bobAuth = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'bob_profile@example.com', name: 'Bob' } })
    });
    assert.equal(bobAuth.status, 200);
    const bobToken = bobAuth.body.token;
    await apiJson('/api/profile', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ username: 'bob_taken_name', bio: 'Taken handle' })
    });

    // Create & connect MCP pairing for Alice
    const createPair = await apiJson('/api/mcp/pairings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({})
    });
    assert.ok(createPair.status === 200 || createPair.status === 201);
    const code = createPair.body.pairing.code;

    const connectPair = await apiJson('/api/mcp/pairings/connect', {
      method: 'POST',
      body: JSON.stringify({
        pairingCode: code,
        agentName: 'alice-helper-bot',
        agentAddress: aliceWallet
      })
    });
    assert.equal(connectPair.status, 200);

    // 1) tools/list exposes get_my_profile & update_profile
    const listRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'x-graffiland-pairing-code': code },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(listRes.status, 200);
    const toolNames = (listRes.body?.result?.tools || []).map((t) => t.name);
    assert.ok(toolNames.includes('get_my_profile'));
    assert.ok(toolNames.includes('update_profile'));

    // 2) Paired agent updates Alice's username, bio, avatarImage, and headerImage
    const updRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'x-graffiland-pairing-code': code },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'update_profile',
          arguments: {
            username: 'alice_agent_sync',
            bio: 'Updated live by my paired AI agent!',
            avatarImage: 'https://spray.land/avatar-sample.png',
            headerImage: 'preset:sunset-voxel'
          }
        }
      })
    });
    assert.equal(updRes.status, 200);
    const updData = updRes.body?.result?.structuredContent;
    assert.equal(updData.ok, true);
    assert.equal(updData.profile.username, 'alice_agent_sync');
    assert.equal(updData.profile.bio, 'Updated live by my paired AI agent!');
    assert.equal(updData.profile.avatarImage, 'https://spray.land/avatar-sample.png');
    assert.equal(updData.profile.headerImage, 'preset:sunset-voxel');
    assert.equal(updData.shareUrl, 'https://spray.land/?u=alice_agent_sync');

    // 3) get_my_profile returns the persisted update + public shareUrl
    const getRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'x-graffiland-pairing-code': code },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_my_profile', arguments: {} }
      })
    });
    assert.equal(getRes.status, 200);
    const getData = getRes.body?.result?.structuredContent;
    assert.equal(getData.profile.username, 'alice_agent_sync');
    assert.equal(getData.profile.bio, 'Updated live by my paired AI agent!');
    assert.equal(getData.shareUrl, 'https://spray.land/?u=alice_agent_sync');

    // 4) Rejects taken username (409) and unsafe SVG avatar (400)
    const takenRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'x-graffiland-pairing-code': code },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'update_profile', arguments: { username: 'bob_taken_name' } }
      })
    });
    assert.ok(takenRes.status >= 400 || Boolean(takenRes.body?.error));

    const svgRes = await apiJson('/api/mcp', {
      method: 'POST',
      headers: { 'x-graffiland-pairing-code': code },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'update_profile',
          arguments: { avatarImage: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }
        }
      })
    });
    assert.ok(svgRes.status >= 400 || Boolean(svgRes.body?.error));

    // 5) Docs (/llms.txt, agent.json, owner prompt, README) all advertise get_my_profile & update_profile
    const llmsTxt = buildLlmsTxt('https://api.spray.land');
    assert.ok(llmsTxt.includes('get_my_profile'));
    assert.ok(llmsTxt.includes('update_profile'));

    const card = buildWellKnownAgentCard('https://api.spray.land');
    const cardToolNames = card.capabilities.tools.map((t) => t.name);
    assert.ok(cardToolNames.includes('get_my_profile'));
    assert.ok(cardToolNames.includes('update_profile'));

    const ownerPrompt = buildPropertyOwnerPrompt({ pairingCode: code });
    assert.ok(ownerPrompt.includes('get_my_profile'));
    assert.ok(ownerPrompt.includes('update_profile'));

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('get_my_profile'));
    assert.ok(readme.includes('update_profile'));
  });
});
