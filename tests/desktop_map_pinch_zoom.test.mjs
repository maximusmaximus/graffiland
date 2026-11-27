import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  clearRegisteredDesktopMaps,
  getRegisteredDesktopMapsCount,
  installDesktopMapPinchZoom,
  registerDesktopZoomableMap,
  resolveTargetDesktopMap,
  zoomLeafletByDelta,
  zoomMapLibreByDelta
} from '../client/src/utils/desktopMapPinchZoom.js';

let dom;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://spray.land/'
  });
});

after(() => {
  clearRegisteredDesktopMaps();
  dom?.window?.close();
});

function mockRect(el, rect) {
  el.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top
  });
}

describe('Desktop Pinch-to-Zoom -> Map-Only Router', () => {
  test('Ctrl+wheel trackpad pinch over header/sidebar/labels prevents page zoom and zooms ONLY the active map', () => {
    clearRegisteredDesktopMaps();
    const { window: win } = dom;
    const { document: doc } = win;
    doc.body.innerHTML = `
      <header id="top-bar"><button id="nav-btn">Home</button></header>
      <aside id="sidebar"><div id="sidebar-item">Sidebar List</div></aside>
      <div id="map-wrap">
        <div id="map-host" class="maplibregl-map"><div class="maplibregl-canvas-container"><canvas id="map-canvas"></canvas></div></div>
        <button id="floating-label">Stibblez Land</button>
      </div>
    `;

    const mapWrap = doc.getElementById('map-wrap');
    const mapHost = doc.getElementById('map-host');
    const mapCanvas = doc.getElementById('map-canvas');
    const floatingLabel = doc.getElementById('floating-label');
    const sidebarItem = doc.getElementById('sidebar-item');
    const navBtn = doc.getElementById('nav-btn');
    mockRect(mapWrap, { left: 300, top: 60, width: 900, height: 700 });
    mockRect(mapHost, { left: 300, top: 60, width: 900, height: 700 });

    const zoomCalls = [];
    const unregister = registerDesktopZoomableMap({
      id: 'main-3d-map',
      getContainer: () => mapWrap,
      getNativeTarget: () => mapHost,
      zoomByDelta: (delta, cx, cy) => {
        zoomCalls.push({ delta, cx, cy });
        return true;
      }
    });
    const uninstall = installDesktopMapPinchZoom({ win, doc });

    try {
      assert.equal(doc.documentElement.classList.contains('desktop-map-pinch-locked'), true);
      assert.equal(getRegisteredDesktopMapsCount(), 1);

      // 1) Pinching over the top header (outside map) -> blocks browser zoom & zooms map!
      const headerPinch = new win.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -60,
        clientX: 120,
        clientY: 25
      });
      navBtn.dispatchEvent(headerPinch);
      assert.equal(headerPinch.defaultPrevented, true, 'Browser page zoom MUST be prevented on header pinch');
      assert.equal(zoomCalls.length, 1);
      assert.ok(zoomCalls[0].delta > 0, 'Negative deltaY (pinch out) must zoom map IN');

      // 2) Pinching over a floating map label pill -> blocks browser zoom & zooms map around cursor!
      const labelPinch = new win.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: 50,
        clientX: 620,
        clientY: 310
      });
      floatingLabel.dispatchEvent(labelPinch);
      assert.equal(labelPinch.defaultPrevented, true);
      assert.equal(zoomCalls.length, 2);
      assert.ok(zoomCalls[1].delta < 0, 'Positive deltaY (pinch in) must zoom map OUT');
      assert.equal(zoomCalls[1].cx, 620);
      assert.equal(zoomCalls[1].cy, 310);

      // 3) Regular non-ctrl wheel scroll over sidebar -> NOT blocked & does NOT zoom map!
      const normalScroll = new win.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: false,
        deltaY: 120,
        clientX: 120,
        clientY: 300
      });
      sidebarItem.dispatchEvent(normalScroll);
      assert.equal(normalScroll.defaultPrevented, false, 'Regular sidebar scrolling must stay unlocked');
      assert.equal(zoomCalls.length, 2);

      // 4) Native MapLibre canvas handler already prevented default -> MUST NOT double-zoom!
      const nativeHandler = (ev) => ev.preventDefault();
      mapCanvas.addEventListener('wheel', nativeHandler);
      const nativePinch = new win.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -40,
        clientX: 500,
        clientY: 300
      });
      mapCanvas.dispatchEvent(nativePinch);
      mapCanvas.removeEventListener('wheel', nativeHandler);
      assert.equal(nativePinch.defaultPrevented, true);
      assert.equal(zoomCalls.length, 2, 'Must never double-zoom when native map canvas already handled event');
    } finally {
      uninstall();
      unregister();
    }

    assert.equal(doc.documentElement.classList.contains('desktop-map-pinch-locked'), false);
    assert.equal(getRegisteredDesktopMapsCount(), 0);
  });

  test('Safari gesturestart/gesturechange/gestureend and touchscreen 2-finger pinch zoom ONLY the topmost map', () => {
    clearRegisteredDesktopMaps();
    const { window: win } = dom;
    const { document: doc } = win;
    doc.body.innerHTML = `
      <div id="bg-map"></div>
      <div id="modal-shell" class="plot-visit-overlay" role="dialog">
        <div id="modal-header">Plot Visit</div>
        <div id="modal-map"></div>
      </div>
    `;

    const bgMap = doc.getElementById('bg-map');
    const modalMap = doc.getElementById('modal-map');
    const modalHeader = doc.getElementById('modal-header');
    mockRect(bgMap, { left: 0, top: 0, width: 1200, height: 800 });
    mockRect(modalMap, { left: 200, top: 100, width: 800, height: 500 });

    const bgZooms = [];
    const modalZooms = [];
    const unregBg = registerDesktopZoomableMap({
      id: 'bg-map',
      getContainer: () => bgMap,
      zoomByDelta: (d) => bgZooms.push(d)
    });
    const unregModal = registerDesktopZoomableMap({
      id: 'modal-map',
      getContainer: () => modalMap,
      zoomByDelta: (d) => modalZooms.push(d)
    });
    const uninstall = installDesktopMapPinchZoom({ win, doc });

    try {
      // Topmost modal map should be chosen when pinching on modal header
      assert.equal(resolveTargetDesktopMap(modalHeader, 400, 40, win)?.id, 'modal-map');

      // 1) Safari gesturestart + gesturechange (scale 1 -> 1.5 -> zoom IN by log2(1.5) ≈ +0.585)
      const gStart = new win.Event('gesturestart', { bubbles: true, cancelable: true });
      Object.defineProperty(gStart, 'scale', { value: 1 });
      modalHeader.dispatchEvent(gStart);
      assert.equal(gStart.defaultPrevented, true);

      const gChange = new win.Event('gesturechange', { bubbles: true, cancelable: true });
      Object.defineProperty(gChange, 'scale', { value: 1.5 });
      Object.defineProperty(gChange, 'clientX', { value: 500 });
      Object.defineProperty(gChange, 'clientY', { value: 300 });
      modalHeader.dispatchEvent(gChange);
      assert.equal(gChange.defaultPrevented, true);
      assert.equal(bgZooms.length, 0, 'Background map must not zoom while modal map is topmost');
      assert.equal(modalZooms.length, 1);
      assert.ok(Math.abs(modalZooms[0] - Math.log2(1.5)) < 0.01);

      const gEnd = new win.Event('gestureend', { bubbles: true, cancelable: true });
      modalHeader.dispatchEvent(gEnd);
      assert.equal(gEnd.defaultPrevented, true);

      // 2) Desktop touchscreen 2-finger pinch over modal header (span 100px -> 200px => +1.0 zoom level)
      const tStart = new win.Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(tStart, 'touches', {
        value: [
          { clientX: 350, clientY: 50 },
          { clientX: 450, clientY: 50 }
        ]
      });
      modalHeader.dispatchEvent(tStart);
      assert.equal(tStart.defaultPrevented, true);

      const tMove = new win.Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(tMove, 'touches', {
        value: [
          { clientX: 300, clientY: 50 },
          { clientX: 500, clientY: 50 }
        ]
      });
      modalHeader.dispatchEvent(tMove);
      assert.equal(tMove.defaultPrevented, true);
      assert.equal(modalZooms.length, 2);
      assert.ok(Math.abs(modalZooms[1] - 1) < 0.01);
    } finally {
      uninstall();
      unregModal();
      unregBg();
    }
  });

  test('zoomMapLibreByDelta and zoomLeafletByDelta clamp cleanly and anchor around cursor when over map', () => {
    const mlContainer = {};
    mockRect(mlContainer, { left: 100, top: 50, width: 600, height: 400 });
    let mlZoom = 16;
    const mlCalls = [];
    const fakeMlMap = {
      getZoom: () => mlZoom,
      getMinZoom: () => 2,
      getMaxZoom: () => 22,
      getContainer: () => mlContainer,
      unproject: ([x, y]) => ({ lng: -121.84 + x * 0.0001, lat: 39.73 - y * 0.0001 }),
      zoomTo: (z, opts) => {
        mlZoom = z;
        mlCalls.push({ z, opts });
      }
    };

    // Inside map container -> zooms around unprojected cursor lngLat
    assert.equal(zoomMapLibreByDelta(fakeMlMap, 0.8, 400, 250), true);
    assert.equal(mlZoom, 16.8);
    assert.ok(mlCalls[0].opts.around);
    assert.equal(mlCalls[0].opts.duration, 0);

    // Outside map container -> zooms around center (no around point) & clamps at maxZoom
    assert.equal(zoomMapLibreByDelta(fakeMlMap, 10, 20, 20), true);
    assert.equal(mlZoom, 22);
    assert.equal(mlCalls[1].opts.around, undefined);

    // Leaflet 2D map adapter
    const lfContainer = {};
    mockRect(lfContainer, { left: 100, top: 50, width: 600, height: 400 });
    let lfZoom = 14;
    const lfCalls = [];
    const fakeLfMap = {
      getZoom: () => lfZoom,
      getMinZoom: () => 1,
      getMaxZoom: () => 21.5,
      getContainer: () => lfContainer,
      containerPointToLatLng: ([x, y]) => ({ lat: 39.73 - y * 0.0001, lng: -121.84 + x * 0.0001 }),
      setZoomAround: (latlng, z, opts) => {
        lfZoom = z;
        lfCalls.push({ kind: 'around', latlng, z, opts });
      },
      setZoom: (z, opts) => {
        lfZoom = z;
        lfCalls.push({ kind: 'center', z, opts });
      }
    };

    assert.equal(zoomLeafletByDelta(fakeLfMap, 1.25, 300, 200), true);
    assert.equal(lfZoom, 15.25);
    assert.equal(lfCalls[0].kind, 'around');

    assert.equal(zoomLeafletByDelta(fakeLfMap, -0.5, 10, 10), true);
    assert.equal(lfZoom, 14.75);
    assert.equal(lfCalls[1].kind, 'center');
  });
});
