import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

import {
  STALE_DRAW_ERASE_DISTANCE_FEET,
  STALE_DRAW_ERASE_DISTANCE_METERS,
  STALE_DRAW_ERASE_IDLE_MINUTES,
  STALE_DRAW_ERASE_IDLE_MS
} from '../shared/constants.mjs';
import {
  evaluateStaleDrawErase,
  normalizeDrawLocation,
  resolveInitialDrawActivity
} from '../client/src/utils/staleDrawGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function offsetNorth(origin, metersNorth) {
  return {
    lat: origin.lat + metersNorth / 111320,
    lng: origin.lng,
    accuracy: origin.accuracy ?? 4
  };
}

describe('Stale In-View Drawing Auto-Erase (>20ft Move + 5 Min Idle)', () => {
  test('enforces exact >20 ft (6.096 m) distance and >=5 minute (300,000 ms) idle thresholds', () => {
    assert.equal(STALE_DRAW_ERASE_DISTANCE_FEET, 20);
    assert.equal(STALE_DRAW_ERASE_DISTANCE_METERS, 6.096);
    assert.equal(STALE_DRAW_ERASE_IDLE_MINUTES, 5);
    assert.equal(STALE_DRAW_ERASE_IDLE_MS, 300000);

    const origin = { lat: 37.7749, lng: -122.4194, accuracy: 4 };
    const t0 = 1_700_000_000_000;

    // 1. Stayed at origin for 10 minutes -> NOT erased
    const sameSpot = evaluateStaleDrawErase({
      hasDrawnContent: true,
      lastDrawAt: t0,
      drawLocation: origin,
      currentLocation: origin,
      nowMs: t0 + 10 * 60 * 1000
    });
    assert.equal(sameSpot.shouldErase, false);
    assert.equal(sameSpot.reason, 'within_distance');

    // 2. Moved exactly 19.5 ft (~5.94 m <= 6.096 m) after 6 minutes -> NOT erased
    const within20ft = evaluateStaleDrawErase({
      hasDrawnContent: true,
      lastDrawAt: t0,
      drawLocation: origin,
      currentLocation: offsetNorth(origin, 5.94),
      nowMs: t0 + 6 * 60 * 1000
    });
    assert.equal(within20ft.shouldErase, false);
    assert.equal(within20ft.reason, 'within_distance');

    // 3. Moved 25 ft (~7.62 m > 6.096 m) but drew 4m59s ago -> NOT erased
    const recentDraw = evaluateStaleDrawErase({
      hasDrawnContent: true,
      lastDrawAt: t0,
      drawLocation: origin,
      currentLocation: offsetNorth(origin, 7.62),
      nowMs: t0 + STALE_DRAW_ERASE_IDLE_MS - 1
    });
    assert.equal(recentDraw.shouldErase, false);
    assert.equal(recentDraw.reason, 'recent_draw');

    // 4. Moved 20.5 ft (~6.25 m > 6.096 m) and 5m00s without drawing -> ERASED
    const movedAndIdle = evaluateStaleDrawErase({
      hasDrawnContent: true,
      lastDrawAt: t0,
      drawLocation: origin,
      currentLocation: offsetNorth(origin, 6.25),
      nowMs: t0 + STALE_DRAW_ERASE_IDLE_MS
    });
    assert.equal(movedAndIdle.shouldErase, true);
    assert.equal(movedAndIdle.reason, 'moved_and_idle');
    assert.ok(movedAndIdle.distanceMeters > STALE_DRAW_ERASE_DISTANCE_METERS);
    assert.ok(movedAndIdle.distanceFeet > 20);
    assert.equal(movedAndIdle.idleMs, STALE_DRAW_ERASE_IDLE_MS);

    // 5. Actively mid-stroke or publishing -> NEVER erased
    const midStroke = evaluateStaleDrawErase({
      hasDrawnContent: true,
      isActivelyDrawing: true,
      lastDrawAt: t0,
      drawLocation: origin,
      currentLocation: offsetNorth(origin, 25),
      nowMs: t0 + 10 * 60 * 1000
    });
    assert.equal(midStroke.shouldErase, false);
    assert.equal(midStroke.reason, 'drawing');

    const publishing = evaluateStaleDrawErase({
      hasDrawnContent: true,
      isPublishing: true,
      lastDrawAt: t0,
      drawLocation: origin,
      currentLocation: offsetNorth(origin, 25),
      nowMs: t0 + 10 * 60 * 1000
    });
    assert.equal(publishing.shouldErase, false);
    assert.equal(publishing.reason, 'publishing');

    // 6. Empty canvas or missing location -> NOT erased
    assert.equal(
      evaluateStaleDrawErase({
        hasDrawnContent: false,
        lastDrawAt: t0,
        drawLocation: origin,
        currentLocation: offsetNorth(origin, 25),
        nowMs: t0 + 10 * 60 * 1000
      }).shouldErase,
      false
    );
    assert.equal(
      evaluateStaleDrawErase({
        hasDrawnContent: true,
        lastDrawAt: t0,
        drawLocation: null,
        currentLocation: offsetNorth(origin, 25),
        nowMs: t0 + 10 * 60 * 1000
      }).shouldErase,
      false
    );
  });

  test('normalizes GPS coordinates and resolves initial draft draw activity cleanly', () => {
    assert.equal(normalizeDrawLocation(null), null);
    assert.equal(normalizeDrawLocation({ lat: '', lng: -122 }), null);
    assert.equal(normalizeDrawLocation({ lat: 95, lng: 0 }), null);
    assert.deepEqual(normalizeDrawLocation({ lat: '37.77', lng: '-122.41', accuracy: '5' }), {
      lat: 37.77,
      lng: -122.41,
      accuracy: 5
    });

    assert.deepEqual(resolveInitialDrawActivity({ voxels: [] }), {
      lastDrawAt: null,
      drawLocation: null
    });

    const t0 = 1_700_000_000_000;
    const restored = resolveInitialDrawActivity({
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
      lastDrawAt: t0,
      drawLocation: { lat: 37.7749, lng: -122.4194 }
    });
    assert.equal(restored.lastDrawAt, t0);
    assert.deepEqual(restored.drawLocation, { lat: 37.7749, lng: -122.4194 });

    const legacyIso = '2026-11-25T20:00:00.000Z';
    const legacy = resolveInitialDrawActivity({
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4' }],
      updatedAt: legacyIso
    });
    assert.equal(legacy.lastDrawAt, Date.parse(legacyIso));
    assert.equal(legacy.drawLocation, null);
  });

  test('MobileStudio, useDrafts, and useProofOfLocation wire location refresh and local-draft persistence', () => {
    const mobileSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/MobileStudio.jsx'),
      'utf8'
    );
    const draftsSrc = fs.readFileSync(path.join(ROOT, 'client/src/hooks/useDrafts.js'), 'utf8');
    const polSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/hooks/useProofOfLocation.js'),
      'utf8'
    );

    assert.match(mobileSrc, /refreshLocationNow:\s*pol\.refreshLocationNow/);
    assert.match(mobileSrc, /onAutoEraseStaleDrawing:/);
    assert.match(mobileSrc, /drafts\.discardActiveCanvasDraft\(\)/);
    assert.match(draftsSrc, /lastDrawAt:\s*drawActivity\?\.lastDrawAt/);
    assert.match(draftsSrc, /drawLocation:\s*drawActivity\?\.drawLocation/);
    assert.match(polSrc, /refreshLocationNow/);
  });
});

describe('Stale Drawing Auto-Erase React Hook + Three.js Draft Mesh Integration', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let useVoxelBrush;
  let ProofOfLocationTracker;

  before(async () => {
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
    dom.window.HTMLCanvasElement.prototype.getContext = () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
      drawImage: () => {},
      clearRect: () => {},
      fillRect: () => {}
    });

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
    ({ useVoxelBrush } = await import('../client/src/hooks/useVoxelBrush.js'));
    ({ ProofOfLocationTracker } = await import('../client/src/components/ProofOfLocation.js'));
  });

  after(() => {
    cleanup?.();
    dom?.window?.close();
  });

  test('ProofOfLocationTracker.getRefinedLocation ignores >60s old samples so post-break moves >20ft are not pulled back', () => {
    const tracker = new ProofOfLocationTracker();
    const locA = { lat: 37.7749, lng: -122.4194, accuracy: 12 };
    const locB = offsetNorth(locA, 8.5); // ~28 ft north (>20 ft, within 13.2m cluster radius of 12m acc)

    const origNow = Date.now;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;
    try {
      for (let i = 0; i < 8; i += 1) {
        fakeNow += 1500;
        tracker.recordGps({
          coords: { latitude: locA.lat, longitude: locA.lng, accuracy: 12 }
        });
      }
      // 6 minutes later, user arrives 28 ft north
      fakeNow += 6 * 60 * 1000;
      tracker.recordGps({
        coords: { latitude: locB.lat, longitude: locB.lng, accuracy: 12 }
      });
      const refined = tracker.getRefinedLocation(locB);
      assert.ok(Math.abs(refined.lat - locB.lat) < 1e-7, 'Must reflect fresh Location B, not old Location A');
    } finally {
      Date.now = origNow;
    }
  });

  function createBrushHarness({ initialDraft = {}, initialLocation = null, onAutoErase = () => {} } = {}) {
    const latest = { brush: null, draftGroup: new THREE.Group(), hints: [], gpsRefreshes: 0 };
    const isPublishingRef = { current: false };
    const locationRef = { current: initialLocation };

    function Harness({ loc }) {
      locationRef.current = loc;
      const canvasHostRef = React.useRef(null);
      const cameraRef = React.useRef(new THREE.PerspectiveCamera());
      const draftGroupRef = React.useRef(latest.draftGroup);
      const transformBoxRef = React.useRef(new THREE.Box3Helper(new THREE.Box3()));
      const surfaceMarkerRef = React.useRef(new THREE.Group());
      const shadowPlaneRef = React.useRef(new THREE.Mesh());
      const gridHelperRef = React.useRef(new THREE.GridHelper(2, 2));
      const nearbyGroupRef = React.useRef(new THREE.Group());
      const polRef = React.useRef({ analyzeSurfacePatch: () => ({ sharpnessScore: 0.5 }) });
      const rawOrientationRef = React.useRef(null);
      const fallbackEulerRef = React.useRef({ yaw: 0, pitch: 0 });
      const arTargetedIdRef = React.useRef('');

      const brush = useVoxelBrush({
        config: { policy: { maxVoxels: 4096 } },
        initialDraft,
        user: null,
        location: loc,
        locationRef,
        cameraReady: true,
        sceneScan: { optimal: true, scannedCount: 9, targetCount: 9 },
        polRef,
        rawOrientationRef,
        fallbackEulerRef,
        enterFullscreen: () => {},
        setSensorBanner: () => {},
        showTemporaryHint: (msg) => latest.hints.push(msg),
        canvasHostRef,
        cameraRef,
        draftGroupRef,
        transformBoxRef,
        surfaceMarkerRef,
        shadowPlaneRef,
        gridHelperRef,
        nearbyGroupRef,
        arTargetedIdRef,
        setArTargetedSculpture: () => {},
        arPinPreview: null,
        openCameraSelectedChat: () => {},
        openAgentHandoffRef: { current: null },
        openPublishSheetRef: { current: null },
        refreshLocationNow: () => {
          latest.gpsRefreshes += 1;
        },
        isPublishingRef,
        onAutoEraseStaleDrawing: onAutoErase
      });

      latest.brush = brush;
      return null;
    }

    const view = RTL.render(React.createElement(Harness, { loc: initialLocation }));
    return {
      latest,
      isPublishingRef,
      locationRef,
      setLocation: (nextLoc) => {
        locationRef.current = nextLoc;
        RTL.act(() => {
          view.rerender(React.createElement(Harness, { loc: nextLoc }));
        });
      },
      unmount: () => view.unmount()
    };
  }

  test('erases drawn voxels, 3D draft meshes, and surfaceAnchor once user moves >20ft AND goes 5 min without drawing', async () => {
    const locA = { lat: 37.7749, lng: -122.4194, accuracy: 4 };
    const locB = offsetNorth(locA, 8); // ~26.2 ft north (>20 ft)
    const locC = offsetNorth(locB, 8); // ~26.2 ft further north
    let autoEraseCalls = 0;

    const origNow = Date.now;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;

    const harness = createBrushHarness({
      initialLocation: locA,
      onAutoErase: () => {
        autoEraseCalls += 1;
      }
    });

    try {
      // Draw 2 blocks & set surface anchor at Location A (t = 0)
      await RTL.act(async () => {
        harness.latest.brush.applyVoxelBatch([
          { action: 'add', x: 0, y: 0, z: 0 },
          { action: 'add', x: 0.05, y: 0, z: 0 }
        ]);
        harness.latest.brush.setSurfaceAnchor({
          x: 0,
          y: 0,
          z: 0,
          nx: 0,
          ny: 1,
          nz: 0,
          locked: true
        });
      });
      assert.equal(harness.latest.brush.voxels.length, 2);
      assert.equal(harness.latest.draftGroup.children.length, 2);
      assert.ok(harness.latest.brush.surfaceAnchor);

      // Move 26.2 ft to Location B at t + 2 min -> NOT erased (under 5 min)
      fakeNow += 2 * 60 * 1000;
      harness.setLocation(locB);
      assert.equal(harness.latest.brush.voxels.length, 2);
      assert.equal(harness.latest.draftGroup.children.length, 2);
      assert.equal(autoEraseCalls, 0);

      // Paint another block at Location B at t + 3 min -> resets 5 min timer AND updates draw origin to Location B!
      fakeNow += 1 * 60 * 1000;
      await RTL.act(async () => {
        harness.latest.brush.applyVoxelBatch([{ action: 'add', x: 0.1, y: 0, z: 0 }]);
      });
      assert.equal(harness.latest.brush.voxels.length, 3);

      // At t + 6 min (only 3 min since last paint at Location B) -> NOT erased
      fakeNow += 3 * 60 * 1000;
      await RTL.act(async () => {
        harness.latest.brush.checkStaleDrawErase({ nowMs: fakeNow });
      });
      assert.equal(harness.latest.brush.voxels.length, 3);
      assert.equal(autoEraseCalls, 0);

      // At t + 8 min (5 min since last paint) STILL at Location B (0 ft from last paint) -> NOT erased
      fakeNow += 2 * 60 * 1000;
      await RTL.act(async () => {
        harness.latest.brush.checkStaleDrawErase({ nowMs: fakeNow, nudgeGpsIfIdle: true });
      });
      assert.equal(harness.latest.brush.voxels.length, 3);
      assert.equal(harness.latest.gpsRefreshes, 1, 'Idle check nudges fresh GPS read when >=5 min idle');
      assert.equal(autoEraseCalls, 0);

      // While publishing is in flight, moving >20ft does NOT wipe voxels mid-submit
      harness.isPublishingRef.current = true;
      harness.setLocation(locC);
      assert.equal(harness.latest.brush.voxels.length, 3);
      assert.equal(autoEraseCalls, 0);

      // Publishing finished/cancelled -> moving >20ft to Location C after 5 min idle ERASES everything in view!
      harness.isPublishingRef.current = false;
      await RTL.act(async () => {
        harness.latest.brush.checkStaleDrawErase({ nowMs: fakeNow });
      });
      assert.equal(harness.latest.brush.voxels.length, 0);
      assert.equal(harness.latest.draftGroup.children.length, 0, 'All 3D draft meshes removed from view');
      assert.equal(harness.latest.brush.surfaceAnchor, null, 'Surface anchor cleared from view');
      assert.equal(harness.latest.brush.hasClearedBackup, false, 'Undo cleared backup wiped');
      assert.equal(autoEraseCalls, 1);
      assert.ok(
        harness.latest.hints.some((h) => /20ft/i.test(h) && /5 min/i.test(h)),
        `Expected auto-erase notice, got: ${JSON.stringify(harness.latest.hints)}`
      );
    } finally {
      harness.unmount();
      Date.now = origNow;
    }
  });

  test('erases restored localStorage draft immediately on GPS lock when reopened >20ft away and >5 min later', () => {
    const locA = { lat: 37.7749, lng: -122.4194, accuracy: 4 };
    const locFar = offsetNorth(locA, 15); // ~49 ft north
    let autoEraseCalls = 0;

    const origNow = Date.now;
    const fakeNow = 1_700_000_600_000;
    Date.now = () => fakeNow;

    const harness = createBrushHarness({
      initialLocation: null,
      initialDraft: {
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte', scale: 1 },
          { x: 0.05, y: 0, z: 0, color: '#ff3e7f', material: 'matte', scale: 1 }
        ],
        surfaceAnchor: { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, locked: true },
        lastDrawAt: fakeNow - 6 * 60 * 1000,
        drawLocation: locA
      },
      onAutoErase: () => {
        autoEraseCalls += 1;
      }
    });

    try {
      // Before GPS locks, restored draft is waiting
      assert.equal(harness.latest.brush.voxels.length, 2);
      assert.equal(harness.latest.draftGroup.children.length, 2);

      // GPS resolves 49 ft away -> immediately erased!
      harness.setLocation(locFar);
      assert.equal(harness.latest.brush.voxels.length, 0);
      assert.equal(harness.latest.draftGroup.children.length, 0);
      assert.equal(harness.latest.brush.surfaceAnchor, null);
      assert.equal(autoEraseCalls, 1);
    } finally {
      harness.unmount();
      Date.now = origNow;
    }
  });
});
