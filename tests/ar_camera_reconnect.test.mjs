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
});
