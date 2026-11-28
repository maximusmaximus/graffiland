import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

describe('On-Land Live Chat Bell Notification, Top GPS Tag Removal & Locked Land Chat Info ("i")', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(cacheBase, '.cache-land-chat-ui-test-'));
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

  test('1. landChatHelpers accurately detects live land chats and explains every lock reason', async () => {
    const helpers = await loadJsxModule('client/src/utils/landChatHelpers.js');
    const {
      getLandChatLiveSummary,
      evaluateLandChatAvailability,
      buildLiveLandChatNotification
    } = helpers;

    // Parcel with no chat initialized, 0 messages, 0 pins -> not live
    const quietLand = {
      parcelId: 'GLAND-QUIET01',
      displayName: 'Quiet Meadow',
      isInside: true,
      edgeDistanceMeters: 0,
      sculptures: [{ id: 'sc-1', title: 'Rock', chatSummary: { initialized: false, messageCount: 0 } }]
    };
    assert.equal(getLandChatLiveSummary(quietLand).hasLiveChat, false);
    assert.equal(buildLiveLandChatNotification(quietLand), null);

    // Parcel with parcel-level chat initialized (even 0 sculptures) -> live!
    const parcelChatLand = {
      parcelId: 'GLAND-LIVE01',
      displayName: 'Stibblez Land',
      isInside: true,
      edgeDistanceMeters: 0,
      chatInitialized: true,
      chatMessageCount: 4,
      chatPinCount: 1,
      sculptures: []
    };
    const summary = getLandChatLiveSummary(parcelChatLand);
    assert.equal(summary.hasLiveChat, true);
    assert.equal(summary.messageCount, 4);
    assert.equal(summary.pinCount, 1);

    const liveNotif = buildLiveLandChatNotification(parcelChatLand, {
      isDesktop: false,
      isSignedIn: true,
      cameraReady: true,
      hasLocation: true
    });
    assert.ok(liveNotif);
    assert.equal(liveNotif.parcelId, 'GLAND-LIVE01');
    assert.ok(liveNotif.title.includes('Stibblez Land'));
    assert.ok(liveNotif.message.includes('4 encrypted messages'));
    assert.ok(liveNotif.message.includes('1 pinned note'));
    assert.equal(liveNotif.chatAvailability.canChat, true);

    // Not inside -> no on-land live chat notification
    assert.equal(
      buildLiveLandChatNotification({ ...parcelChatLand, isInside: false }),
      null
    );

    // Lock reason evaluation across all conditions
    const desktopAvail = evaluateLandChatAvailability({
      land: parcelChatLand,
      isDesktop: true
    });
    assert.equal(desktopAvail.canChat, false);
    assert.equal(desktopAvail.code, 'desktop_only');
    assert.match(desktopAvail.reason, /mobile in-person only/i);

    const noGpsAvail = evaluateLandChatAvailability({
      land: parcelChatLand,
      hasLocation: false
    });
    assert.equal(noGpsAvail.canChat, false);
    assert.equal(noGpsAvail.code, 'no_gps');
    assert.match(noGpsAvail.reason, /Enable GPS location/i);

    const farAvail = evaluateLandChatAvailability({
      land: { ...parcelChatLand, isInside: false, edgeDistanceMeters: 240, outOfArRange: true },
      hasLocation: true
    });
    assert.equal(farAvail.canChat, false);
    assert.equal(farAvail.code, 'out_of_range');
    assert.match(farAvail.reason, /walk within/i);

    const noCamAvail = evaluateLandChatAvailability({
      land: parcelChatLand,
      cameraReady: false
    });
    assert.equal(noCamAvail.canChat, false);
    assert.equal(noCamAvail.code, 'no_camera');
    assert.match(noCamAvail.reason, /live mobile AR camera/i);

    const signedOutAvail = evaluateLandChatAvailability({
      land: parcelChatLand,
      isSignedIn: false
    });
    assert.equal(signedOutAvail.canChat, false);
    assert.equal(signedOutAvail.code, 'signed_out');
    assert.match(signedOutAvail.reason, /Sign in/i);
  });

  test('2. Notification bell shows live on-land chat alert with Open Land Chat button (and locked + "i" when unavailable)', async () => {
    const notifMod = await loadJsxModule('client/src/components/NotificationCenter.jsx');
    const { NotificationProvider, GlobalNotificationBell } = notifMod;
    const { buildLiveLandChatNotification } = await loadJsxModule(
      'client/src/utils/landChatHelpers.js'
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          unreadCount: 0,
          preferences: {},
          notifications: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const liveLand = {
      parcelId: 'GLAND-STIBBLEZ',
      displayName: 'Stibblez Land',
      isInside: true,
      edgeDistanceMeters: 0,
      centerLat: 39.728,
      centerLng: -121.838,
      chatInitialized: true,
      chatMessageCount: 3,
      sculptures: [
        {
          id: 'sc-cheese',
          title: 'Big cheese',
          parcelId: 'GLAND-STIBBLEZ',
          chatSummary: { initialized: true, messageCount: 3 }
        }
      ]
    };

    const actions = [];
    const unlockedEntry = buildLiveLandChatNotification(liveLand, {
      isDesktop: false,
      isSignedIn: true,
      cameraReady: true,
      hasLocation: true
    });

    const view = RTL.render(
      React.createElement(
        NotificationProvider,
        {
          user: { id: 'u1', username: 'bigdog' },
          variant: 'mobile',
          liveLandChats: [unlockedEntry],
          onAction: (item) => actions.push(item)
        },
        React.createElement(GlobalNotificationBell, { testId: 'live-chat-bell-btn' })
      )
    );

    // Bell badge lights up with 1 live chat alert
    const badge = view.getByTestId('notif-unread-badge');
    assert.equal(badge.textContent.trim(), '1');

    // Open bell -> Inbox shows the Live Land Chat card with Open Land Chat button
    RTL.fireEvent.click(view.getByTestId('live-chat-bell-btn'));
    const liveItem = view.getByTestId('notif-live-land-chat-item');
    assert.ok(liveItem.textContent.includes('Live Land Chat at Stibblez Land'));
    assert.ok(view.getByTestId('notif-live-chat-pill').textContent.includes('Live'));

    const openChatBtn = view.getByTestId('notif-open-land-chat-btn');
    assert.equal(openChatBtn.getAttribute('data-locked'), 'false');
    RTL.fireEvent.click(openChatBtn);

    assert.equal(actions.length, 1);
    assert.equal(actions[0].actionType, 'open_land_chat');
    assert.equal(actions[0].parcelId, 'GLAND-STIBBLEZ');
    assert.equal(actions[0].chatTarget.id, 'sc-cheese');

    // Popover closes after navigating to chat view
    assert.equal(view.queryByTestId('notif-popover'), null);
    cleanup();

    // Locked live chat alert (camera disabled) renders greyed-out locked button + "i" InfoTip
    const lockedActions = [];
    const lockedEntry = buildLiveLandChatNotification(liveLand, {
      isDesktop: false,
      isSignedIn: true,
      cameraReady: false,
      hasLocation: true
    });

    const lockedView = RTL.render(
      React.createElement(
        NotificationProvider,
        {
          user: { id: 'u1', username: 'bigdog' },
          variant: 'mobile',
          liveLandChats: [lockedEntry],
          onAction: (item) => lockedActions.push(item)
        },
        React.createElement(GlobalNotificationBell, { testId: 'live-chat-bell-locked-btn' })
      )
    );

    RTL.fireEvent.click(lockedView.getByTestId('live-chat-bell-locked-btn'));
    const lockedBtn = lockedView.getByTestId('notif-open-land-chat-btn');
    assert.equal(lockedBtn.getAttribute('data-locked'), 'true');
    assert.equal(lockedBtn.getAttribute('aria-disabled'), 'true');
    assert.ok(lockedBtn.className.includes('is-action-locked'));
    RTL.fireEvent.click(lockedBtn);
    assert.equal(lockedActions.length, 0, 'Locked chat button in notification must not open chat');

    // Clicking the adjacent "i" explains why chat is locked
    const infoBtn = lockedView
      .getByTestId('notif-land-chat-lock-info')
      .querySelector('.info-tip-btn');
    assert.ok(infoBtn, 'Expected clickable info "i" button next to locked chat alert');
    RTL.fireEvent.click(infoBtn);
    assert.ok(
      lockedView.getByTestId('notif-popover').textContent.includes('live mobile AR camera')
    );
    cleanup();
  });

  test('3. ARLandInspectorPanel shows locked greyed-out Land Chat + "i" explaining why when unavailable, and unlocks when eligible', async () => {
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );

    const baseLand = {
      parcelId: 'GLAND-STIBBLEZ',
      displayName: 'Stibblez Land',
      centerLat: 39.728,
      centerLng: -121.838,
      isInside: false,
      edgeDistanceMeters: 310,
      outOfArRange: true,
      chatInitialized: true,
      chatMessageCount: 2,
      sculptures: [{ id: 'sc-1', title: 'Big cheese', chatSummary: { initialized: true, messageCount: 2 } }]
    };

    let chatOpened = 0;
    const farView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: baseLand,
        isSignedIn: true,
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {
          chatOpened += 1;
        },
        onClose: () => {}
      })
    );

    const farBtn = farView.getByTestId('ar-land-chat-btn');
    assert.equal(farBtn.getAttribute('data-locked'), 'true');
    assert.equal(farBtn.getAttribute('aria-disabled'), 'true');
    assert.ok(farBtn.className.includes('is-action-locked'));
    assert.ok(farBtn.textContent.includes('Land Chat (2)'));

    const farInfoWrap = farView.getByTestId('ar-land-chat-lock-info');
    const farInfoBtn = farInfoWrap.querySelector('.info-tip-btn');
    assert.ok(farInfoBtn, 'Expected "i" info button beside locked Land Chat');
    RTL.fireEvent.click(farInfoBtn);
    assert.match(farInfoWrap.textContent, /walk within/i);

    RTL.fireEvent.click(farBtn);
    assert.equal(chatOpened, 0);
    cleanup();

    // On site, but camera is off -> locked + "i" explains camera requirement
    const noCamView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: { ...baseLand, isInside: true, edgeDistanceMeters: 0, outOfArRange: false },
        isSignedIn: true,
        cameraReady: false,
        hasLocation: true,
        onOpenLandChat: () => {
          chatOpened += 1;
        },
        onClose: () => {}
      })
    );
    const noCamBtn = noCamView.getByTestId('ar-land-chat-btn');
    assert.equal(noCamBtn.getAttribute('data-locked'), 'true');
    const noCamInfoWrap = noCamView.getByTestId('ar-land-chat-lock-info');
    RTL.fireEvent.click(noCamInfoWrap.querySelector('.info-tip-btn'));
    assert.match(noCamInfoWrap.textContent, /live mobile AR camera/i);
    RTL.fireEvent.click(noCamBtn);
    assert.equal(chatOpened, 0);
    cleanup();

    // On site + camera + GPS + signed in -> unlocked, no lock info button, clicking opens chat
    const okView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: { ...baseLand, isInside: true, edgeDistanceMeters: 0, outOfArRange: false },
        isSignedIn: true,
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {
          chatOpened += 1;
        },
        onClose: () => {}
      })
    );
    const okBtn = okView.getByTestId('ar-land-chat-btn');
    assert.equal(okBtn.getAttribute('data-locked'), 'false');
    assert.equal(okBtn.className.includes('is-action-locked'), false);
    assert.equal(okView.queryByTestId('ar-land-chat-lock-info'), null);
    RTL.fireEvent.click(okBtn);
    assert.equal(chatOpened, 1);
    cleanup();
  });

  test('4. StudioHudTopBar hides top GPS/True North tag pill and locks Land Chat + "i" on targeted sculpture when unavailable', async () => {
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    let opened = 0;
    const view = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'preview',
        dockOpen: false,
        location: { lat: 39.728, lng: -121.838 },
        voxels: [],
        cameraReady: true,
        isInteractingWithLand: false,
        sensorStatus: {
          source: 'ios-compass-fused',
          trueNorthLocked: true,
          headingAccuracyDeg: 6,
          gpsAccuracyM: 2,
          needsCompassCalibration: false
        },
        arTargetedSculpture: {
          distanceM: 12,
          sculpture: {
            id: 'sc-1',
            title: 'Big cheese',
            parcelId: 'GLAND-STIBBLEZ',
            parcelName: 'Stibblez Land'
          }
        },
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: true, coveragePct: 100, scannedCount: 9, targetCount: 9 },
        onOpenCameraSelectedChat: () => {
          opened += 1;
        }
      })
    );

    assert.equal(view.queryByTestId('ar-sensor-status-pill'), null);
    assert.equal(view.container.textContent.includes('GPS ±2m'), false);

    // Signed-out user -> targeted sculpture Land Chat button is locked + greyed out with "i"
    const chatBtn = view.getByTestId('ar-select-land-chat-btn');
    assert.equal(chatBtn.getAttribute('data-locked'), 'true');
    assert.ok(chatBtn.className.includes('is-action-locked'));
    const infoWrap = view.getByTestId('ar-select-land-chat-lock-info');
    RTL.fireEvent.click(infoWrap.querySelector('.info-tip-btn'));
    assert.match(infoWrap.textContent, /Sign in/i);
    RTL.fireEvent.click(chatBtn);
    assert.equal(opened, 0);
    cleanup();
  });

  test('5. PlotVisitView renders locked greyed-out Land Chat + "i" on desktop and remote mobile views, and unlocks on mobile when eligible', async () => {
    const { default: PlotVisitView } = await loadJsxModule(
      'client/src/components/PlotVisitView.jsx'
    );

    const parcel = {
      parcelId: 'GLAND-STIBBLEZ',
      customName: 'Stibblez Land',
      displayName: 'Stibblez Land',
      centerLat: 39.728,
      centerLng: -121.838,
      chatInitialized: true,
      chatMessageCount: 5,
      volume: {
        centerLat: 39.728,
        centerLng: -121.838,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 10
      }
    };
    const sculptures = [
      {
        id: 'sc-cheese',
        title: 'Big cheese',
        parcelId: 'GLAND-STIBBLEZ',
        lat: 39.728,
        lng: -121.838,
        chatSummary: { initialized: true, messageCount: 5 }
      }
    ];

    // Desktop view -> expand details -> locked greyed-out Land Chat button + clickable "i" explaining desktop lock
    const desktopView = RTL.render(
      React.createElement(PlotVisitView, {
        variant: 'desktop',
        parcel,
        sculptures,
        user: { id: 'u1', username: 'bigdog' },
        onClose: () => {}
      })
    );
    RTL.fireEvent.click(desktopView.getByTestId('plot-details-toggle'));
    const deskChatBtn = desktopView.getByTestId('plot-land-chat-btn');
    assert.equal(deskChatBtn.getAttribute('data-locked'), 'true');
    assert.equal(deskChatBtn.getAttribute('aria-disabled'), 'true');
    assert.ok(deskChatBtn.className.includes('is-action-locked'));
    assert.ok(deskChatBtn.textContent.includes('Land Chat (5)'));
    const deskInfoWrap = desktopView.getByTestId('plot-land-chat-lock-info');
    RTL.fireEvent.click(deskInfoWrap.querySelector('.info-tip-btn'));
    assert.match(deskInfoWrap.textContent, /mobile in-person only/i);
    cleanup();

    // Mobile view on site with camera + signed in + onOpenLandChat -> unlocked and fires callback
    let mobileChatOpened = 0;
    const mobileView = RTL.render(
      React.createElement(PlotVisitView, {
        variant: 'mobile',
        parcel,
        sculptures,
        user: { id: 'u1', username: 'bigdog' },
        userLocation: { lat: 39.728, lng: -121.838 },
        cameraReady: true,
        onOpenLandChat: () => {
          mobileChatOpened += 1;
        },
        onClose: () => {}
      })
    );
    RTL.fireEvent.click(mobileView.getByTestId('plot-details-toggle'));
    const mobChatBtn = mobileView.getByTestId('plot-land-chat-btn');
    assert.equal(mobChatBtn.getAttribute('data-locked'), 'false');
    assert.equal(mobileView.queryByTestId('plot-land-chat-lock-info'), null);
    RTL.fireEvent.click(mobChatBtn);
    assert.equal(mobileChatOpened, 1);
    cleanup();

    const mobileStudioSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    assert.match(mobileStudioSrc, /liveLandChats=\{liveLandChats\}/);
    assert.match(mobileStudioSrc, /actionType === 'open_land_chat'/);
    assert.match(mobileStudioSrc, /buildLiveLandChatNotification/);
  });
});
