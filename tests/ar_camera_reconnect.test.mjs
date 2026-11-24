import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

import {
  acquireRearCameraStream,
  flushVideoElement,
  inspectCameraFeedHealth,
  stopMediaStreamTracks
} from '../client/src/utils/cameraRecovery.js';
import {
  computeHexHammingDistance,
  evaluateSubstantialDeviceMovement,
  ProofOfLocationTracker,
  shortestAngleDeltaDeg
} from '../client/src/components/ProofOfLocation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function createMockTrack(id) {
  const listeners = new Map();
  return {
    id,
    kind: 'video',
    readyState: 'live',
    enabled: true,
    muted: false,
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type) {
      if (type === 'ended') this.readyState = 'ended';
      if (type === 'mute') this.muted = true;
      if (type === 'unmute') this.muted = false;
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ type, target: this });
      }
    }
  };
}

function createMockStream(id) {
  const track = createMockTrack(`track-${id}`);
  return {
    id: `stream-${id}`,
    track,
    getTracks() {
      return [track];
    },
    getVideoTracks() {
      return [track];
    }
  };
}

describe('AR Camera Health & Freeze Detection (cameraRecovery.js)', () => {
  test('inspectCameraFeedHealth flags ended tracks, detached srcObject, paused video, muted stalls, and frozen frames', () => {
    const stream = createMockStream(1);
    const video = {
      srcObject: stream,
      paused: false,
      ended: false,
      readyState: 4,
      videoWidth: 1280,
      videoHeight: 720,
      currentTime: 1.0,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 30 })
    };

    const healthy1 = inspectCameraFeedHealth(video, stream, null, 5000, {
      streamStartedAt: 1000
    });
    assert.equal(healthy1.healthy, true);
    assert.equal(healthy1.action, 'none');
    assert.equal(healthy1.frameAdvanced, true);

    // Frame advances -> still healthy
    video.currentTime = 1.5;
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 45 });
    const healthy2 = inspectCameraFeedHealth(video, stream, healthy1.nextSample, 6500, {
      streamStartedAt: 1000
    });
    assert.equal(healthy2.healthy, true);
    assert.equal(healthy2.frameAdvanced, true);

    // Silent freeze: track still live & readyState=4, but frames stop advancing past threshold
    const frozen = inspectCameraFeedHealth(video, stream, healthy2.nextSample, 10200, {
      streamStartedAt: 1000,
      stallThresholdMs: 3400
    });
    assert.equal(frozen.healthy, false);
    assert.equal(frozen.action, 'restart');
    assert.equal(frozen.reason, 'frame_frozen');

    // Detached srcObject (e.g. after ErrorBoundary remount) -> reattach
    video.srcObject = null;
    const detached = inspectCameraFeedHealth(video, stream, healthy2.nextSample, 6800, {
      streamStartedAt: 1000
    });
    assert.equal(detached.healthy, false);
    assert.equal(detached.action, 'reattach');
    assert.equal(detached.reason, 'src_detached');

    // Paused video with live track -> play
    video.srcObject = stream;
    video.paused = true;
    const paused = inspectCameraFeedHealth(video, stream, healthy2.nextSample, 6800, {
      streamStartedAt: 1000
    });
    assert.equal(paused.healthy, false);
    assert.equal(paused.action, 'play');
    assert.equal(paused.reason, 'video_paused');

    // Prolonged muted track -> restart
    video.paused = false;
    stream.track.muted = true;
    const mutedStall = inspectCameraFeedHealth(video, stream, healthy2.nextSample, 9000, {
      streamStartedAt: 1000,
      mutedSince: 6500,
      mutedGraceMs: 1800
    });
    assert.equal(mutedStall.healthy, false);
    assert.equal(mutedStall.action, 'restart');
    assert.equal(mutedStall.reason, 'track_muted_stalled');

    // Track ended -> immediate restart even within startup grace
    stream.track.muted = false;
    stream.track.readyState = 'ended';
    const ended = inspectCameraFeedHealth(video, stream, healthy2.nextSample, 1500, {
      streamStartedAt: 1000
    });
    assert.equal(ended.healthy, false);
    assert.equal(ended.action, 'restart');
    assert.equal(ended.reason, 'track_ended');
  });

  test('acquireRearCameraStream falls back across constraint tiers on OverconstrainedError and stops immediately on NotAllowedError', async () => {
    const calls = [];
    const fallbackStream = createMockStream('fallback');
    const mockMediaDevices = {
      async getUserMedia(constraints) {
        calls.push(constraints);
        if (calls.length === 1) {
          const err = new Error('1080p unsupported');
          err.name = 'OverconstrainedError';
          throw err;
        }
        return fallbackStream;
      }
    };
    const acquired = await acquireRearCameraStream(mockMediaDevices);
    assert.equal(acquired, fallbackStream);
    assert.equal(calls.length, 2);

    const deniedCalls = [];
    await assert.rejects(
      () =>
        acquireRearCameraStream({
          async getUserMedia(c) {
            deniedCalls.push(c);
            const err = new Error('Denied');
            err.name = 'NotAllowedError';
            throw err;
          }
        }),
      (err) => err.name === 'NotAllowedError'
    );
    assert.equal(deniedCalls.length, 1);

    let pauseCalls = 0;
    const mockVid = {
      srcObject: fallbackStream,
      pause() {
        pauseCalls += 1;
      }
    };
    stopMediaStreamTracks(fallbackStream);
    flushVideoElement(mockVid);
    assert.equal(fallbackStream.track.stopped, true);
    assert.equal(pauseCalls, 1);
    assert.equal(mockVid.srcObject, null);
  });
});

describe('AR Camera Refresh on Disconnect & Reconnect (React Hooks + UI)', () => {
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
      define: {
        'import.meta.env': '{}'
      },
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ar-cam-test-cache-'));
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

  after(async () => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('useProofOfLocation refreshes AR camera cleanly on offline->online, visibilitychange, track ended, and devicechange', async () => {
    const { useProofOfLocation } = await loadJsxModule(
      'client/src/hooks/useProofOfLocation.js'
    );

    const createdStreams = [];
    const deviceListeners = new Map();
    const refreshReasons = [];
    let networkReconnects = 0;

    const mockMediaDevices = {
      async getUserMedia() {
        const s = createMockStream(createdStreams.length + 1);
        createdStreams.push(s);
        return s;
      },
      addEventListener(type, fn) {
        if (!deviceListeners.has(type)) deviceListeners.set(type, new Set());
        deviceListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        deviceListeners.get(type)?.delete(fn);
      },
      emit(type) {
        for (const fn of [...(deviceListeners.get(type) || [])]) fn({ type });
      }
    };

    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      value: mockMediaDevices,
      configurable: true
    });

    let visState = 'visible';
    Object.defineProperty(dom.window.document, 'visibilityState', {
      get: () => visState,
      configurable: true
    });

    let hookApi = null;
    function Harness() {
      const dirLightRef = React.useRef(null);
      const pol = useProofOfLocation({
        user: null,
        dirLightRef,
        onLocationUpdate: null,
        onCameraRefreshed: ({ reason }) => refreshReasons.push(reason),
        onNetworkReconnect: () => {
          networkReconnects += 1;
        }
      });
      hookApi = pol;
      return React.createElement('video', {
        ref: (el) => {
          if (el) {
            el.play = () => Promise.resolve();
            el.pause = () => {};
            Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(el, 'videoWidth', { value: 1280, configurable: true });
            Object.defineProperty(el, 'videoHeight', { value: 720, configurable: true });
          }
          pol.videoRef.current = el;
        }
      });
    }

    const view = RTL.render(React.createElement(Harness));
    await RTL.waitFor(() => {
      assert.equal(createdStreams.length, 1);
      assert.equal(hookApi.cameraReady, true);
    });
    assert.equal(hookApi.videoRef.current.srcObject, createdStreams[0]);

    // 1. Network disconnect -> reconnect (offline -> online) refreshes camera & stops old track
    await RTL.act(async () => {
      dom.window.dispatchEvent(new dom.window.Event('offline'));
      dom.window.dispatchEvent(new dom.window.Event('online'));
    });
    await RTL.waitFor(() => {
      assert.equal(createdStreams.length, 2);
      assert.equal(createdStreams[0].track.stopped, true);
      assert.equal(hookApi.videoRef.current.srcObject, createdStreams[1]);
    });
    assert.equal(networkReconnects, 1);
    assert.equal(refreshReasons.at(-1), 'network_reconnected');

    // 2. App background -> foreground (visibilitychange hidden -> visible) refreshes camera
    await RTL.act(async () => {
      visState = 'hidden';
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      visState = 'visible';
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    });
    await RTL.waitFor(() => {
      assert.equal(createdStreams.length, 3);
      assert.equal(createdStreams[1].track.stopped, true);
      assert.equal(hookApi.videoRef.current.srcObject, createdStreams[2]);
    });
    assert.equal(refreshReasons.at(-1), 'visibility_visible');

    // 3. Camera track ends unexpectedly (e.g. OS reclaimed camera) -> auto-recovers fresh stream
    await RTL.act(async () => {
      createdStreams[2].track.emit('ended');
    });
    await RTL.waitFor(() => {
      assert.equal(createdStreams.length, 4);
      assert.equal(hookApi.videoRef.current.srcObject, createdStreams[3]);
      assert.equal(hookApi.cameraReady, true);
    });
    assert.equal(refreshReasons.at(-1), 'track_ended');

    // 4. Hardware devicechange -> refreshes stream
    await RTL.act(async () => {
      mockMediaDevices.emit('devicechange');
    });
    await RTL.waitFor(() => {
      assert.equal(createdStreams.length, 5);
      assert.equal(createdStreams[3].track.stopped, true);
      assert.equal(hookApi.videoRef.current.srcObject, createdStreams[4]);
    });
    assert.equal(refreshReasons.at(-1), 'devicechange');

    // 5. Cleanup stops final stream cleanly
    view.unmount();
    assert.equal(createdStreams[4].track.stopped, true);
  });

  test('useProofOfLocation retries transiently busy camera hardware (NotReadableError) and recovers automatically', async () => {
    const { useProofOfLocation } = await loadJsxModule(
      'client/src/hooks/useProofOfLocation.js'
    );

    let attempts = 0;
    const recoveredStream = createMockStream('recovered');
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      value: {
        async getUserMedia() {
          attempts += 1;
          if (attempts === 1) {
            const err = new Error('Camera busy right after unlock');
            err.name = 'NotReadableError';
            throw err;
          }
          return recoveredStream;
        }
      },
      configurable: true
    });

    let hookApi = null;
    function Harness() {
      const dirLightRef = React.useRef(null);
      const pol = useProofOfLocation({ user: null, dirLightRef });
      hookApi = pol;
      return React.createElement('video', {
        ref: (el) => {
          if (el) {
            el.play = () => Promise.resolve();
            el.pause = () => {};
          }
          pol.videoRef.current = el;
        }
      });
    }

    const view = RTL.render(React.createElement(Harness));
    await RTL.waitFor(
      () => {
        assert.equal(attempts, 2);
        assert.equal(hookApi.cameraReady, true);
        assert.equal(hookApi.videoRef.current.srcObject, recoveredStream);
      },
      { timeout: 2500 }
    );
    view.unmount();
  });

  test('usePairing auto-reconnects after unexpected WS drop on online and signals reconnected so AR camera refreshes', async () => {
    const { usePairing } = await loadJsxModule('client/src/hooks/usePairing.js');

    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        sockets.push(this);
      }
      send(data) {
        this.sent.push(JSON.parse(data));
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
      openAndPair(code) {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({
          data: JSON.stringify({ type: 'pair_connected', code })
        });
      }
    }
    const origWs = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    dom.window.WebSocket = FakeWebSocket;

    const events = [];
    let pairApi = null;

    function PairHarness() {
      const voxelsRef = React.useRef([]);
      const rawOrientationRef = React.useRef(null);
      const yawOffsetRef = React.useRef(0);
      pairApi = usePairing({
        user: null,
        voxels: [],
        voxelsRef,
        rawOrientationRef,
        yawOffsetRef,
        onConnectionStateChange: (ev) => events.push(ev)
      });
      return null;
    }

    try {
      const view = RTL.render(React.createElement(PairHarness));

      // Initial pair connection
      await RTL.act(async () => {
        pairApi.connectPairCode('ABC123');
      });
      assert.equal(sockets.length, 1);
      await RTL.act(async () => {
        sockets[0].openAndPair('ABC123');
      });
      assert.equal(pairApi.pairedCode, 'ABC123');
      assert.deepEqual(events.at(-1), {
        kind: 'desktop',
        status: 'connected',
        code: 'ABC123'
      });

      // Unexpected disconnect while offline, then reconnect when online returns
      await RTL.act(async () => {
        Object.defineProperty(dom.window.navigator, 'onLine', {
          value: false,
          configurable: true
        });
        sockets[0].close();
      });
      assert.equal(pairApi.pairedCode, '');
      assert.equal(events.at(-1).status, 'disconnected');
      assert.equal(events.at(-1).unexpected, true);

      await RTL.act(async () => {
        Object.defineProperty(dom.window.navigator, 'onLine', {
          value: true,
          configurable: true
        });
        dom.window.dispatchEvent(new dom.window.Event('online'));
      });
      assert.equal(sockets.length, 2);
      await RTL.act(async () => {
        sockets[1].openAndPair('ABC123');
      });
      assert.equal(pairApi.pairedCode, 'ABC123');
      assert.deepEqual(events.at(-1), {
        kind: 'desktop',
        status: 'reconnected',
        code: 'ABC123'
      });

      // Manual disconnect followed by manual reconnect also emits disconnected -> reconnected
      await RTL.act(async () => {
        pairApi.disconnectDesktopPair();
      });
      assert.equal(pairApi.pairedCode, '');
      assert.equal(events.at(-1).status, 'disconnected');
      assert.equal(events.at(-1).manual, true);

      await RTL.act(async () => {
        pairApi.connectPairCode('XYZ789');
      });
      assert.equal(sockets.length, 3);
      await RTL.act(async () => {
        sockets[2].openAndPair('XYZ789');
      });
      assert.equal(pairApi.pairedCode, 'XYZ789');
      assert.deepEqual(events.at(-1), {
        kind: 'desktop',
        status: 'reconnected',
        code: 'XYZ789'
      });

      view.unmount();
    } finally {
      globalThis.WebSocket = origWs;
      dom.window.WebSocket = origWs;
    }
  });

  test('DesktopQrScanner notifies onCameraRefreshNeeded after fallback stream closes and StudioHudTopBar shows calm recovery banner', async () => {
    const { default: DesktopQrScanner } = await loadJsxModule(
      'client/src/components/studio/DesktopQrScanner.jsx'
    );
    const { default: StudioHudTopBar } = await loadJsxModule(
      'client/src/components/studio/StudioHudTopBar.jsx'
    );

    const qrStream = createMockStream('qr-fallback');
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      value: {
        async getUserMedia() {
          return qrStream;
        }
      },
      configurable: true
    });

    const refreshCalls = [];
    const qrView = RTL.render(
      React.createElement(DesktopQrScanner, {
        existingVideoRef: { current: null },
        onCameraRefreshNeeded: (payload) => refreshCalls.push(payload),
        onDetected: () => {}
      })
    );

    await RTL.waitFor(() => {
      assert.equal(qrStream.track.stopped, false);
    });
    qrView.unmount();
    assert.equal(qrStream.track.stopped, true);
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].reason, 'qr_scanner_closed');

    // StudioHudTopBar displays calm recovering status instead of red error banner while refreshing
    const hudView = RTL.render(
      React.createElement(StudioHudTopBar, {
        user: null,
        mode: 'draw',
        dockOpen: false,
        location: null,
        pairedCode: '',
        voxels: [],
        quickSculpt: false,
        hasOwnedLand: false,
        ownedLandCount: 0,
        cameraReady: false,
        cameraRecovering: true,
        sensorBanner: 'Reconnecting camera…',
        originStatus: { originBlocked: false, reason: '' },
        sceneScan: { optimal: false, scannedCount: 0, targetCount: 9 }
      })
    );
    assert.ok(hudView.getByTestId('camera-recovering-banner'));
    assert.equal(hudView.queryByTestId('mobile-error-banner'), null);
    hudView.unmount();
  });

  test('ProofOfLocationTracker detects substantial movement on leave/return and resets cleanly', () => {
    assert.equal(computeHexHammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
    assert.equal(computeHexHammingDistance('f0f0f0f0f0f0f0f0', 'f0f0f0f0f0f0f0f0'), 0);
    assert.equal(shortestAngleDeltaDeg(5, 355), 10);
    assert.equal(shortestAngleDeltaDeg(355, 5), -10);
    assert.equal(Math.abs(shortestAngleDeltaDeg(10, 190)), 180);

    const baseCheckpoint = {
      lat: 39.7285,
      lng: -121.8375,
      accuracy: 5,
      yawDeg: 100,
      pitchDeg: 0,
      visualDHash: 'a5a5a5a5a5a5a5a5',
      scannedCount: 5,
      optimal: false,
      capturedAt: 10000
    };

    // Small hand jitter should NOT prompt restart
    const jitter = evaluateSubstantialDeviceMovement({
      checkpoint: baseCheckpoint,
      current: {
        lat: 39.728515,
        lng: -121.8375,
        accuracy: 5,
        yawDeg: 112,
        pitchDeg: 6,
        visualDHash: 'a5a5a5a5a5a5a5a4'
      },
      nowMs: 14000
    });
    assert.equal(jitter.movedSubstantially, false);

    // Walking >= 12m triggers gps_moved
    const gpsMoved = evaluateSubstantialDeviceMovement({
      checkpoint: baseCheckpoint,
      current: {
        lat: 39.72864,
        lng: -121.8375,
        accuracy: 5,
        yawDeg: 105,
        pitchDeg: 2,
        visualDHash: 'a5a5a5a5a5a5a5a5'
      },
      nowMs: 18000
    });
    assert.equal(gpsMoved.movedSubstantially, true);
    assert.equal(gpsMoved.reason, 'gps_moved');
    assert.ok(gpsMoved.distanceMeters >= 12);

    // Turning device >= 55 deg triggers orientation_changed
    const turned = evaluateSubstantialDeviceMovement({
      checkpoint: baseCheckpoint,
      current: {
        lat: 39.7285,
        lng: -121.8375,
        accuracy: 5,
        yawDeg: 175,
        pitchDeg: 0,
        visualDHash: 'a5a5a5a5a5a5a5a5'
      },
      nowMs: 15000
    });
    assert.equal(turned.movedSubstantially, true);
    assert.equal(turned.reason, 'orientation_changed');
    assert.equal(turned.yawDeltaDeg, 75);

    // Completely different camera view (dHash >= 22 bits) triggers scene_changed
    const sceneChanged = evaluateSubstantialDeviceMovement({
      checkpoint: baseCheckpoint,
      current: {
        lat: 39.7285,
        lng: -121.8375,
        accuracy: 5,
        yawDeg: 105,
        pitchDeg: 1,
        visualDHash: '5a5a5a5a5a5a5a5a'
      },
      nowMs: 15000
    });
    assert.equal(sceneChanged.movedSubstantially, true);
    assert.equal(sceneChanged.reason, 'scene_changed');
    assert.equal(sceneChanged.visualHammingBits, 64);

    // Tracker resetSceneScan clears sectors, fine grid, and anchor while keeping GPS fix
    const tracker = new ProofOfLocationTracker();
    tracker.recordGps({
      coords: { latitude: 39.7285, longitude: -121.8375, accuracy: 4, altitude: 60 }
    });
    tracker.recordGyro(120, 90, 0);
    tracker.cameraFrames = 4;
    tracker.sceneContrast = 12;
    tracker.visualDHash = 'a5a5a5a5a5a5a5a5';
    tracker.recordViewPose({ yawDeg: 0, pitchDeg: 0, hasCamera: true });
    for (const yaw of [-45, -15, 15, 45]) {
      for (const pitch of [-20, 0, 20]) {
        tracker.recordViewPose({ yawDeg: yaw, pitchDeg: pitch, hasCamera: true });
      }
    }
    assert.equal(tracker.getSceneCoverage().optimal, true);
    assert.equal(tracker.gpsSamples.length, 1);

    const resetCov = tracker.resetSceneScan({ preserveGps: true });
    assert.equal(resetCov.optimal, false);
    assert.equal(resetCov.scannedCount, 0);
    assert.equal(resetCov.coveragePct, 0);
    assert.equal(tracker.anchorYawDeg, null);
    assert.equal(tracker.cameraFrames, 0);
    assert.equal(tracker.visualDHash, '');
    assert.equal(tracker.gpsSamples.length, 1);
  });

  test('useProofOfLocation resumes mapping cleanly on leave/return, prompts restart on substantial movement, and resets on restartSceneMapping', async () => {
    const { useProofOfLocation } = await loadJsxModule(
      'client/src/hooks/useProofOfLocation.js'
    );

    const streams = [];
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      value: {
        async getUserMedia() {
          const s = createMockStream(`map-${streams.length + 1}`);
          streams.push(s);
          return s;
        }
      },
      configurable: true
    });

    let hookApi = null;
    function Harness() {
      const dirLightRef = React.useRef(null);
      const pol = useProofOfLocation({ user: null, dirLightRef });
      hookApi = pol;
      return React.createElement('video', {
        ref: (el) => {
          if (el) {
            el.play = () => Promise.resolve();
            el.pause = () => {};
            Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(el, 'videoWidth', { value: 1280, configurable: true });
            Object.defineProperty(el, 'videoHeight', { value: 720, configurable: true });
          }
          pol.videoRef.current = el;
        }
      });
    }

    const view = RTL.render(React.createElement(Harness));
    await RTL.waitFor(() => {
      assert.equal(hookApi.cameraReady, true);
    });

    // Seed partial scene mapping progress
    await RTL.act(async () => {
      hookApi.locationRef.current = { lat: 39.7285, lng: -121.8375, accuracy: 5 };
      hookApi.polRef.current.recordGps({
        coords: { latitude: 39.7285, longitude: -121.8375, accuracy: 5 }
      });
      hookApi.polRef.current.recordGyro(90, 90, 0);
      hookApi.polRef.current.cameraFrames = 3;
      hookApi.polRef.current.sceneContrast = 14;
      hookApi.polRef.current.recordViewPose({ yawDeg: 0, pitchDeg: 0, hasCamera: true });
      hookApi.polRef.current.recordViewPose({ yawDeg: 40, pitchDeg: 0, hasCamera: true });
      hookApi.setSceneScan(hookApi.polRef.current.getSceneCoverage());
    });
    assert.ok(hookApi.sceneScan.scannedCount >= 2);
    assert.equal(hookApi.mappingRestartPrompt, null);

    // 1. Leave & return without moving -> does not prompt restart, invalidates stale preview cache
    await RTL.act(async () => {
      hookApi.notifyMappingViewLeft();
      hookApi.lastUnmappedMaskRef.current = 'stale-mask';
      hookApi.notifyMappingViewReturned();
    });
    assert.equal(hookApi.mappingRestartPrompt, null);
    assert.notEqual(hookApi.lastUnmappedMaskRef.current, 'stale-mask');

    // 2. Leave, move device substantially (rotate 85 deg & walk 20m), and return -> prompts restart
    await RTL.act(async () => {
      hookApi.notifyMappingViewLeft();
      hookApi.polRef.current.recordGyro(175, 90, 0);
      hookApi.locationRef.current = { lat: 39.7287, lng: -121.8375, accuracy: 5 };
      hookApi.setScanBoxCollapsed(true);
      hookApi.notifyMappingViewReturned();
    });
    assert.ok(hookApi.mappingRestartPrompt);
    assert.equal(hookApi.mappingRestartPrompt.movedSubstantially, true);
    assert.equal(hookApi.scanBoxCollapsed, false);
    assert.equal(hookApi.unmappedGrid.every((v) => v === false), true);

    // 3. Restart mapping clears prompt and resets progress cleanly
    await RTL.act(async () => {
      await hookApi.restartSceneMapping({ reason: 'device_moved', refreshCameraFeed: false });
    });
    assert.equal(hookApi.mappingRestartPrompt, null);
    assert.equal(hookApi.sceneScan.scannedCount, 0);
    assert.equal(hookApi.sceneScan.coveragePct, 0);
    assert.equal(hookApi.sceneScan.optimal, false);
    assert.equal(hookApi.scanBoxCollapsed, false);

    // 4. Reaching 100% LOCKED auto-closes the mapping window, and resync/movement re-opens it automatically
    await RTL.act(async () => {
      hookApi.polRef.current.cameraFrames = 4;
      hookApi.polRef.current.sceneContrast = 14;
      hookApi.polRef.current.recordViewPose({ yawDeg: 0, pitchDeg: 0, hasCamera: true });
      for (const yaw of [-45, -15, 15, 45]) {
        for (const pitch of [-20, 0, 20]) {
          hookApi.polRef.current.recordViewPose({ yawDeg: yaw, pitchDeg: pitch, hasCamera: true });
        }
      }
      hookApi.setSceneScan(hookApi.polRef.current.getSceneCoverage());
    });
    assert.equal(hookApi.sceneScan.optimal, true);
    assert.equal(hookApi.scanBoxCollapsed, true);

    // Leaving and returning after moving substantially auto-opens the mapping window to resync
    await RTL.act(async () => {
      hookApi.notifyMappingViewLeft();
      hookApi.locationRef.current = { lat: 39.729, lng: -121.8375, accuracy: 5 };
      hookApi.notifyMappingViewReturned();
    });
    assert.ok(hookApi.mappingRestartPrompt);
    assert.equal(hookApi.scanBoxCollapsed, false);

    view.unmount();
  });

  test('SceneCoverageWidget renders Refresh icon to manually restart mapping and displays Restart Mapping prompt when moved', async () => {
    const { default: SceneCoverageWidget } = await loadJsxModule(
      'client/src/components/studio/SceneCoverageWidget.jsx'
    );

    const restartCalls = [];
    const baseScan = {
      coveragePct: 56,
      scannedCount: 5,
      targetCount: 9,
      sectors: Array.from({ length: 12 }, (_, i) => i < 5),
      cursorX: 0.5,
      cursorY: 0.5,
      optimal: false,
      precisionMeters: 1.15,
      hint: 'Pan right to sharpen lock'
    };
    const baseOrb = { engine: 'ORB-SLAM', keyframes: 2, relocalizedInliers: 0 };

    // 1. Expanded scanning state shows manual Refresh icon button
    const view1 = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: baseScan,
        orbStatus: baseOrb,
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        mappingRestartPrompt: null,
        onRestartMapping: (reason) => restartCalls.push(reason)
      })
    );
    const refreshBtn = view1.getByTestId('scene-scan-refresh-btn');
    assert.ok(refreshBtn);
    assert.equal(view1.getByTestId('scene-coverage-widget').getAttribute('data-needs-restart'), 'false');
    RTL.fireEvent.click(refreshBtn);
    assert.deepEqual(restartCalls, ['manual']);
    view1.unmount();

    // 2. Collapsed LOCKED state still keeps manual Refresh icon accessible
    const view2 = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: { ...baseScan, coveragePct: 100, scannedCount: 9, optimal: true },
        orbStatus: baseOrb,
        scanBoxCollapsed: true,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        mappingRestartPrompt: null,
        onRestartMapping: (reason) => restartCalls.push(reason)
      })
    );
    RTL.fireEvent.click(view2.getByTestId('scene-scan-refresh-btn'));
    assert.deepEqual(restartCalls, ['manual', 'manual']);
    view2.unmount();

    // 3. Substantial movement prompt shows MOVED badge, alert banner, and Restart Mapping CTA
    const view3 = RTL.render(
      React.createElement(SceneCoverageWidget, {
        sceneScan: baseScan,
        orbStatus: baseOrb,
        scanBoxCollapsed: false,
        onToggleCollapse: () => {},
        dockOpen: false,
        mode: 'draw',
        mappingRestartPrompt: {
          movedSubstantially: true,
          reason: 'gps_moved',
          summary: 'Device moved ~18m — restart mapping for accurate AR alignment.'
        },
        onRestartMapping: (reason) => restartCalls.push(reason)
      })
    );
    assert.equal(view3.getByTestId('scene-coverage-widget').getAttribute('data-needs-restart'), 'true');
    assert.ok(view3.getByText('MOVED'));
    assert.ok(view3.getByTestId('scene-scan-restart-banner'));
    assert.ok(view3.getByText(/Device moved ~18m/i));
    RTL.fireEvent.click(view3.getByTestId('scene-scan-restart-btn'));
    assert.deepEqual(restartCalls, ['manual', 'manual', 'gps_moved']);
    view3.unmount();
  });
});
