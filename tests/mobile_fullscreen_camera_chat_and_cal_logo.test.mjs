import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

import {
  exitDomFullscreenSafely,
  isDocumentInFullscreen,
  resumeVideoElementPlayback
} from '../client/src/utils/cameraRecovery.js';
import { syncMobileViewportDimensions } from '../client/src/utils/mobilePortraitLock.js';
import { resolveLandChatTarget } from '../client/src/utils/landChatHelpers.js';
import { evaluateCalibrationReadiness } from '../client/src/utils/arCalibrationManager.js';

const ROOT = path.resolve(process.cwd());

describe('Mobile Fullscreen Camera Recovery, On-Land Chat Fix, Plain Calibration "i" Info & Logo Reveal', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let tmpDir;
  let origFetch;

  async function loadJsxModule(relPath) {
    const absIn = path.join(ROOT, relPath);
    const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const absOut = path.join(tmpDir, `${safeName}_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`);
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
    tmpDir = fs.mkdtempSync(path.join(ROOT, '.tmp-mobile-ux-'));
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

  after(() => {
    cleanup?.();
    globalThis.fetch = origFetch;
    dom?.window?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1. Fullscreen camera recovery helpers, viewport sizing & source wiring prevent camera lock in browser fullscreen', async () => {
    // 1A) resumeVideoElementPlayback re-attaches stream and resumes paused video cleanly
    let playCalls = 0;
    const mockStream = {
      getVideoTracks: () => [{ readyState: 'live' }]
    };
    const mockVideo = {
      srcObject: null,
      paused: true,
      playsInline: false,
      muted: false,
      autoplay: false,
      play: async () => {
        playCalls += 1;
        mockVideo.paused = false;
      }
    };
    const resumed = await resumeVideoElementPlayback(mockVideo, mockStream);
    assert.equal(resumed, true);
    assert.equal(playCalls, 1);
    assert.equal(mockVideo.srcObject, mockStream);
    assert.equal(mockVideo.playsInline, true);
    assert.equal(mockVideo.muted, true);

    // 1B) exitDomFullscreenSafely cleanly exits fullscreen when active
    let exitCalls = 0;
    const fsDoc = {
      fullscreenElement: {},
      exitFullscreen: () => {
        exitCalls += 1;
        return Promise.resolve();
      }
    };
    assert.equal(isDocumentInFullscreen(fsDoc), true);
    assert.equal(exitDomFullscreenSafely(fsDoc), true);
    assert.equal(exitCalls, 1);

    // 1C) syncMobileViewportDimensions fills full screen in DOM fullscreen even if visualViewport lags behind
    const props = {};
    const mockFsDoc = {
      fullscreenElement: {},
      activeElement: null,
      documentElement: {
        style: {
          setProperty: (k, v) => {
            props[k] = v;
          }
        }
      }
    };
    const dims = syncMobileViewportDimensions(
      { innerWidth: 412, innerHeight: 915, visualViewport: { width: 412, height: 820 } },
      mockFsDoc
    );
    assert.equal(dims.height, 915, 'In fullscreen mode, mobile height must expand to full 915px rather than clamping to stale 820px');
    assert.equal(props['--mobile-app-height'], '915px');

    // 1D) Source checks: useProofOfLocation never hijacks requestFullscreen on routine taps and listens to fullscreenchange
    const polSrc = fs.readFileSync(path.join(ROOT, 'client/src/hooks/useProofOfLocation.js'), 'utf8');
    assert.doesNotMatch(polSrc, /el\.requestFullscreen\(/, 'Routine AR tool taps must not hijack DOM requestFullscreen');
    assert.match(polSrc, /document\.addEventListener\('fullscreenchange', onFullscreenChange\)/);
    assert.match(polSrc, /document\.addEventListener\('webkitfullscreenchange', onFullscreenChange\)/);
    assert.match(polSrc, /window\.addEventListener\('orientationchange', onOrientationChange\)/);
    assert.match(polSrc, /resumeVideoElementPlayback/);

    // 1E) ARViewportCanvas guards against 0x0 fullscreen layout glitch and listens to fullscreenchange
    const canvasSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(canvasSrc, /if \(w < 10 \|\| h < 10\) return;/);
    assert.match(canvasSrc, /document\.addEventListener\('fullscreenchange', handleViewportOrFullscreenTransition\)/);
    assert.match(canvasSrc, /document\.addEventListener\('webkitfullscreenchange', handleViewportOrFullscreenTransition\)/);
  });

  test('2. On-land Chat button opens cleanly even with cameraFrames=0 (WebXR / View-in-AR / Map) and renders clean mobile chat + retry state', async () => {
    // 2A) resolveLandChatTarget populates fallback lat/lng from land & ignores hidden sculptures
    const target = resolveLandChatTarget(
      {
        parcelId: 'GLAND-CHAT01',
        customName: 'Sunset Plaza',
        centerLat: 37.7749,
        centerLng: -122.4194,
        sculptures: [
          { id: 'sc-hidden', hidden: true, title: 'Hidden' },
          { id: 'sc-live-1', title: 'Neon Arch' }
        ]
      },
      'Sunset Plaza'
    );
    assert.equal(target.id, 'sc-live-1');
    assert.equal(target.lat, 37.7749);
    assert.equal(target.lng, -122.4194);
    assert.equal(target.landDisplayName, 'Sunset Plaza');

    // 2B) useChat.openCameraSelectedChat works when standing on land with cameraFrames=0 (e.g. WebXR 6-DoF or instant map entry)
    const { useChat } = await loadJsxModule('client/src/hooks/useChat.js');
    let hookApi = null;
    const hints = [];
    const Harness = () => {
      hookApi = useChat({
        user: { id: 'user-1', username: 'artist1' },
        mode: 'preview',
        arTargetedSculpture: null,
        locationRef: { current: { lat: 37.7749, lng: -122.4194, altitude: 10 } },
        cameraReadyRef: { current: true },
        webxrActiveRef: { current: true },
        polRef: {
          current: {
            getSnapshot: () => ({ cameraFrames: 0, opticalFlowCorrelation: 0.72, visualDHash: 'abcd' })
          }
        },
        videoRef: { current: null },
        orbPackCacheRef: { current: new Map() },
        orbTrackerRef: { current: null },
        latestOrbProofRef: { current: null },
        handleEnrollPasskey: async () => false,
        setArSelectHint: () => {},
        showTemporaryHint: (m) => hints.push(m)
      });
      return null;
    };

    const view = RTL.render(React.createElement(Harness));
    let opened = false;
    await RTL.act(async () => {
      opened = hookApi.openCameraSelectedChat(target, 0, null);
    });
    assert.equal(opened, true, 'On-land chat must open immediately when camera/WebXR is active even if cameraFrames=0');
    assert.ok(hookApi.chatSelection, 'chatSelection must be populated');
    assert.equal(hookApi.chatSelection.sculpture.id, 'sc-live-1');
    assert.ok(
      hookApi.chatSelection.sightProof.cameraFrames >= 2,
      'sightProof.cameraFrames must be >= 2 for server verification'
    );
    view.unmount();

    // 2C) ARLandInspectorPanel shows quick 1-tap Chat CTA in collapsed bar when standing on land
    const { default: ARLandInspectorPanel } = await loadJsxModule(
      'client/src/components/studio/ARLandInspectorPanel.jsx'
    );
    let chatClicks = 0;
    const inspView = RTL.render(
      React.createElement(ARLandInspectorPanel, {
        land: {
          parcelId: 'GLAND-CHAT01',
          displayName: 'Sunset Plaza',
          isInside: true,
          edgeDistanceMeters: 0,
          distanceMeters: 0,
          centerLat: 37.7749,
          centerLng: -122.4194,
          chatAccessMode: 'open',
          sculptures: [{ id: 'sc-live-1', title: 'Neon Arch', lat: 37.7749, lng: -122.4194 }]
        },
        expanded: false,
        isDesktop: false,
        isSignedIn: true,
        userId: 'user-1',
        cameraReady: true,
        hasLocation: true,
        onOpenLandChat: () => {
          chatClicks += 1;
        },
        onClose: () => {}
      })
    );
    const compactChatBtn = inspView.getByTestId('ar-land-compact-chat-btn');
    RTL.fireEvent.click(compactChatBtn);
    assert.equal(chatClicks, 1);
    inspView.unmount();

    // 2D) SculptureChatDrawer shows a clean Retry error card (never misleading clue-lock card) if API fails, and does not spam syncBoard on GPS updates
    let enterCallCount = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/chat/enter')) {
        enterCallCount += 1;
        return new Response(JSON.stringify({ error: 'Temporary network issue' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const { default: SculptureChatDrawer } = await loadJsxModule(
      'client/src/components/SculptureChatDrawer.jsx'
    );
    const drawerView = RTL.render(
      React.createElement(SculptureChatDrawer, {
        sculpture: target,
        user: { id: 'user-1', username: 'artist1' },
        location: { lat: 37.7749, lng: -122.4194 },
        polTracker: { getSnapshot: () => ({ cameraFrames: 4, opticalFlowCorrelation: 0.8 }) },
        cameraReady: true,
        initialSightProof: {
          cameraReady: true,
          cameraFrames: 4,
          lat: 37.7749,
          lng: -122.4194
        },
        initialPinData: null,
        onRequestLogin: () => {},
        onClose: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.ok(drawerView.getByTestId('chat-error-retry-card'));
      assert.ok(drawerView.getByTestId('chat-retry-btn'));
    });
    const callsBeforeGpsTick = enterCallCount;
    // Rerender with fresh GPS coordinates — must NOT restart syncBoard effect & spam API
    drawerView.rerender(
      React.createElement(SculptureChatDrawer, {
        sculpture: target,
        user: { id: 'user-1', username: 'artist1' },
        location: { lat: 37.77492, lng: -122.41942 },
        polTracker: { getSnapshot: () => ({ cameraFrames: 5, opticalFlowCorrelation: 0.8 }) },
        cameraReady: false, // Even if background camera briefly pauses, sightProof stays valid
        initialSightProof: {
          cameraReady: true,
          cameraFrames: 4,
          lat: 37.7749,
          lng: -122.4194
        },
        initialPinData: null,
        onRequestLogin: () => {},
        onClose: () => {}
      })
    );
    assert.equal(enterCallCount, callsBeforeGpsTick, 'GPS updates must not recreate & spam syncBoard');
    drawerView.unmount();
  });

  test('3. Calibration uses plain non-technical copy on main view, puts all jargon in "i" info popover, and reveals SPRAY.LAND logo tile-by-tile', async () => {
    const { default: SceneCoverageWidget } = await loadJsxModule(
      'client/src/components/studio/SceneCoverageWidget.jsx'
    );

    // 3A) Plain English headlines from evaluateCalibrationReadiness
    const orbStep = evaluateCalibrationReadiness({
      cameraReady: true,
      cameraFrames: 10,
      orientationInitialized: true,
      gyroSamples: 8,
      scannedCount: 7,
      orbKeyframes: 0,
      elapsedScanningMs: 1000
    });
    assert.equal(orbStep.blockingStep, 'orb');
    assert.doesNotMatch(orbStep.headline, /ORB|Visual Anchors|6-DoF/i);
    assert.doesNotMatch(orbStep.subHint, /ORB|visual features|6-DoF/i);

    // 3B) Partial scan: 5 of 12 blocks lit -> reveals 5 logo tiles, hides 7, zero jargon on main card
    const sectors5 = Array.from({ length: 12 }, (_, i) => i < 5);
    const calView = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: {
          coveragePct: 58,
          scannedCount: 5,
          targetCount: 7,
          sectors: sectors5,
          cursorX: 0.45,
          cursorY: 0.52,
          optimal: false,
          precisionMeters: 0.85,
          hint: 'Turn slightly right to uncover more'
        },
        orbStatus: { engine: 'Gyro+ORB', keyframes: 1, relocalizedInliers: 9 },
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrating',
        calibrationReadiness: {
          sufficient: false,
          progressPct: 58,
          sweepTarget: 7,
          orbTarget: 2,
          headline: 'Look Around to Set Up',
          subHint: 'Turn slightly right to uncover more',
          checks: { camera: true, motion: true, sweep: false, orb: false, gps: true, gpsAccuracyM: 6 }
        },
        cameraReady: true,
        webxrActive: true
      })
    );

    const cardText = calView.getByTestId('scene-coverage-widget').textContent || '';
    assert.doesNotMatch(cardText, /ORB|Gyro\+ORB|6-DoF|inliers|GPS ±/i, 'Main calibration card must be free of technical jargon');

    // Logo reveal grid verification
    const logoBox = calView.getByTestId('calibration-logo-reveal');
    assert.equal(logoBox.getAttribute('data-revealed-tiles'), '5');
    assert.equal(logoBox.getAttribute('data-total-tiles'), '12');
    assert.equal(logoBox.getAttribute('data-logo-complete'), 'false');
    const brandLogos = logoBox.querySelectorAll('[data-testid="brand-logo-lockup"]');
    assert.ok(brandLogos.length >= 2, 'SPRAY.LAND logo lockup must render underneath calibration tiles');
    const revealedCells = logoBox.querySelectorAll('.scene-scan-cell[data-revealed="true"]');
    const maskedCells = logoBox.querySelectorAll('.scene-scan-cell[data-revealed="false"]');
    assert.equal(revealedCells.length, 5);
    assert.equal(maskedCells.length, 7);

    // Clicking the "i" info button opens the technical jargon & telemetry popover
    const infoBtn = calView.getByTestId('calibration-tech-info-tip').querySelector('button');
    assert.ok(infoBtn);
    RTL.fireEvent.click(infoBtn);
    const techBody = calView.getByTestId('calibration-tech-info-body');
    assert.match(techBody.textContent, /ORB/i);
    assert.match(techBody.textContent, /Gyro\+ORB/i);
    assert.match(techBody.textContent, /GPS ±6m/i);
    assert.ok(calView.getByTestId('cal-chip-webxr').textContent.includes('6-DoF'));

    // 3C) Reaching calibrated (100%) uncovers all 12 tiles to show the complete SPRAY.LAND logo
    calView.rerender(
      React.createElement(SceneCoverageWidget, {
        sceneScan: {
          coveragePct: 100,
          scannedCount: 7,
          targetCount: 7,
          sectors: Array.from({ length: 12 }, (_, i) => i < 7),
          cursorX: 0.5,
          cursorY: 0.5,
          optimal: true,
          precisionMeters: 0.15,
          hint: 'All set — ready to draw!'
        },
        orbStatus: { engine: 'Gyro+ORB', keyframes: 2, relocalizedInliers: 14 },
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        calibrationState: 'calibrated',
        calibrationReadiness: {
          sufficient: true,
          progressPct: 100,
          sweepTarget: 7,
          orbTarget: 2,
          headline: 'Ready to Spray!',
          subHint: 'Your space is lined up — start drawing in 3D!',
          checks: { camera: true, motion: true, sweep: true, orb: true, gps: true, gpsAccuracyM: 5 }
        },
        cameraReady: true
      })
    );
    const completeBox = calView.getByTestId('calibration-logo-reveal');
    assert.equal(completeBox.getAttribute('data-logo-complete'), 'true');
    assert.equal(completeBox.getAttribute('data-revealed-tiles'), '12');
    assert.equal(completeBox.querySelectorAll('.scene-scan-cell[data-revealed="true"]').length, 12);
    calView.unmount();
  });
});
