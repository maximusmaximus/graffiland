/**
 * Desktop Pinch-to-Zoom -> Map-Only Router.
 *
 * Ensures that when a desktop user pinch-zooms via trackpad (Chrome/Edge/Firefox `ctrl+wheel`,
 * macOS Safari `gesturestart`/`gesturechange`/`gestureend`) or a desktop touchscreen
 * (2-finger pinch), ONLY the active map zooms and NEVER the browser page or surrounding
 * UI elements (headers, sidebars, labels, buttons, modals).
 *
 * - Native canvas/map pinch handlers (MapLibre `.maplibregl-canvas`, Leaflet `.leaflet-container`,
 *   Three.js OrbitControls `<canvas>`) still run first and are never double-zoomed.
 * - Any unhandled pinch anywhere on the page (floating map labels, HUD overlays, wireframe canvas,
 *   sidebars, header chrome, or Safari `gesturechange` events) has browser zoom prevented and is
 *   smoothly routed straight into the active/topmost visible map.
 */

const NATIVE_TOUCH_SELECTOR =
  '.maplibregl-canvas-container, .leaflet-container, [data-allow-pinch="true"]';
const OVERLAY_DIALOG_SELECTOR =
  '[role="dialog"], .modal-backdrop, .plot-visit-overlay, .mobile-map-sheet';

/**
 * @typedef {{
 *   id: string,
 *   getContainer: () => Element | null | undefined,
 *   getNativeTarget?: () => Element | null | undefined,
 *   zoomByDelta: (zoomDelta: number, clientX?: number, clientY?: number) => boolean | void
 * }} RegisteredDesktopMap
 */

/** @type {RegisteredDesktopMap[]} */
const registeredMaps = [];

let nextMapEntrySeq = 1;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Registers a mounted desktop map instance so unhandled page-wide pinch gestures
 * zoom ONLY this map instead of browser-zooming the page.
 * Returns an unregister cleanup function.
 *
 * @param {{
 *   id?: string,
 *   getContainer: () => Element | null | undefined,
 *   getNativeTarget?: () => Element | null | undefined,
 *   zoomByDelta: (zoomDelta: number, clientX?: number, clientY?: number) => boolean | void
 * }} entry
 * @returns {() => void}
 */
export function registerDesktopZoomableMap(entry) {
  if (!entry || typeof entry.zoomByDelta !== 'function') {
    return () => {};
  }
  const record = {
    id: entry.id || `desktop-map-${nextMapEntrySeq++}`,
    getContainer: entry.getContainer || (() => null),
    getNativeTarget: entry.getNativeTarget || entry.getContainer || (() => null),
    zoomByDelta: entry.zoomByDelta
  };
  registeredMaps.push(record);
  return () => {
    const idx = registeredMaps.indexOf(record);
    if (idx >= 0) registeredMaps.splice(idx, 1);
  };
}

export function getRegisteredDesktopMapsCount() {
  return registeredMaps.length;
}

export function clearRegisteredDesktopMaps() {
  registeredMaps.length = 0;
}

function getSafeRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    return el.getBoundingClientRect();
  } catch {
    return null;
  }
}

function isPointInsideRect(rect, clientX, clientY) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function isContainerHiddenByCss(el, win) {
  if (!el) return true;
  if (el.isConnected === false) return true;
  if (typeof win?.getComputedStyle === 'function') {
    try {
      const style = win.getComputedStyle(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') {
        return true;
      }
    } catch {
      // ignore detached node errors
    }
  }
  return false;
}

/**
 * Selects the best registered map to receive a pinch zoom gesture:
 * 1. Most recently mounted map whose outer container contains `target`
 * 2. Most recently mounted visible map whose bounding box contains `(clientX, clientY)`
 * 3. Topmost (most recently mounted) visible map on screen (e.g. when cursor is over header/sidebar)
 */
export function resolveTargetDesktopMap(
  target = null,
  clientX = NaN,
  clientY = NaN,
  win = typeof window !== 'undefined' ? window : null
) {
  if (registeredMaps.length === 0) return null;

  const active = [];
  for (let i = registeredMaps.length - 1; i >= 0; i -= 1) {
    const entry = registeredMaps[i];
    const container = entry.getContainer?.() || null;
    if (container && isContainerHiddenByCss(container, win)) continue;
    active.push({ entry, container, rect: getSafeRect(container) });
  }
  if (active.length === 0) return null;

  // Scope to the active modal/overlay if the pointer is inside a dialog/overlay,
  // so pinching on a modal never zooms an occluded background map behind it.
  const activeOverlay =
    target && typeof target.closest === 'function'
      ? target.closest(OVERLAY_DIALOG_SELECTOR)
      : null;
  const scoped = activeOverlay
    ? active.filter(
        (item) =>
          item.container &&
          typeof activeOverlay.contains === 'function' &&
          activeOverlay.contains(item.container)
      )
    : active;
  if (scoped.length === 0) return null;

  // 1. Direct DOM containment (deepest / topmost modal map wins)
  if (target) {
    for (const item of scoped) {
      if (item.container && typeof item.container.contains === 'function') {
        if (item.container.contains(target)) {
          return item.entry;
        }
      }
    }
  }

  // 2. Pointer hit within map container bounds
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    for (const item of scoped) {
      if (isPointInsideRect(item.rect, clientX, clientY)) {
        return item.entry;
      }
    }
  }

  // 3. Topmost visible map on screen (prefer non-zero bounding rect when layout is available)
  const sizedVisible = scoped.find((item) => item.rect && item.rect.width > 0 && item.rect.height > 0);
  if (sizedVisible) return sizedVisible.entry;

  return scoped[0].entry;
}

/**
 * Smoothly zooms a MapLibre GL map by `zoomDelta`, anchored around `(clientX, clientY)` when
 * the cursor lies over the map container or around the map center otherwise.
 */
export function zoomMapLibreByDelta(map, zoomDelta, clientX, clientY, onUserZoom = null) {
  if (!map || !Number.isFinite(zoomDelta) || Math.abs(zoomDelta) < 1e-4) return false;
  const curZoom = Number(map.getZoom?.());
  if (!Number.isFinite(curZoom)) return false;

  const rawMin = Number(map.getMinZoom?.());
  const rawMax = Number(map.getMaxZoom?.());
  const minZoom = Number.isFinite(rawMin) ? rawMin : 1;
  const maxZoom = Number.isFinite(rawMax) ? rawMax : 22.5;
  const nextZoom = clamp(curZoom + zoomDelta, minZoom, maxZoom);

  let around = null;
  const container = typeof map.getContainer === 'function' ? map.getContainer() : null;
  const rect = getSafeRect(container);
  if (
    isPointInsideRect(rect, clientX, clientY) &&
    typeof map.unproject === 'function'
  ) {
    try {
      around = map.unproject([clientX - rect.left, clientY - rect.top]);
    } catch {
      around = null;
    }
  }

  try {
    if (typeof map.zoomTo === 'function') {
      map.zoomTo(nextZoom, around ? { around, duration: 0 } : { duration: 0 });
    } else if (typeof map.setZoom === 'function') {
      map.setZoom(nextZoom);
    } else if (typeof map.jumpTo === 'function') {
      map.jumpTo({ zoom: nextZoom });
    } else {
      return false;
    }
    onUserZoom?.(nextZoom);
    return true;
  } catch {
    return false;
  }
}

/**
 * Smoothly zooms a Leaflet 2D map by `zoomDelta`, anchored around `(clientX, clientY)` when
 * the cursor lies over the map container or around the map center otherwise.
 */
export function zoomLeafletByDelta(map, zoomDelta, clientX, clientY, onUserZoom = null) {
  if (!map || !Number.isFinite(zoomDelta) || Math.abs(zoomDelta) < 1e-4) return false;
  const curZoom = Number(map.getZoom?.());
  if (!Number.isFinite(curZoom)) return false;

  const rawMin = Number(map.getMinZoom?.());
  const rawMax = Number(map.getMaxZoom?.());
  const minZoom = Number.isFinite(rawMin) ? rawMin : 1;
  const maxZoom = Number.isFinite(rawMax) ? rawMax : 21.5;
  const nextZoom = clamp(curZoom + zoomDelta, minZoom, maxZoom);

  const container = typeof map.getContainer === 'function' ? map.getContainer() : null;
  const rect = getSafeRect(container);

  try {
    if (
      isPointInsideRect(rect, clientX, clientY) &&
      typeof map.containerPointToLatLng === 'function' &&
      typeof map.setZoomAround === 'function'
    ) {
      const lngLat = map.containerPointToLatLng([clientX - rect.left, clientY - rect.top]);
      map.setZoomAround(lngLat, nextZoom, { animate: false });
    } else if (typeof map.setZoom === 'function') {
      map.setZoom(nextZoom, { animate: false });
    } else {
      return false;
    }
    onUserZoom?.(nextZoom);
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts a browser `ctrl+wheel` trackpad pinch delta into a smooth map zoom level delta.
 */
export function wheelEventToPinchZoomDelta(ev) {
  const rawY = Number(ev?.deltaY || 0);
  if (!Number.isFinite(rawY) || rawY === 0) return 0;
  const mode = Number(ev?.deltaMode || 0);
  const pixelY = mode === 1 ? rawY * 40 : mode === 2 ? rawY * 800 : rawY;
  return clamp(-pixelY / 100, -1.2, 1.2);
}

function isNativeTouchTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest(NATIVE_TOUCH_SELECTOR));
}

function getTouchPairMetrics(touches) {
  if (!touches || touches.length < 2) return null;
  const t0 = touches[0];
  const t1 = touches[1];
  const x0 = Number(t0?.clientX ?? 0);
  const y0 = Number(t0?.clientY ?? 0);
  const x1 = Number(t1?.clientX ?? 0);
  const y1 = Number(t1?.clientY ?? 0);
  return {
    span: Math.hypot(x1 - x0, y1 - y0),
    midX: (x0 + x1) / 2,
    midY: (y0 + y1) / 2
  };
}

/**
 * Installs page-wide desktop pinch-zoom interception so trackpad and touchscreen pinches
 * NEVER zoom browser UI elements and instead smoothly zoom ONLY the active map.
 * Returns a cleanup callback.
 */
export function installDesktopMapPinchZoom({
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
} = {}) {
  if (!win || !doc) return () => {};

  doc.documentElement?.classList?.add('desktop-map-pinch-locked');
  doc.body?.classList?.add('desktop-map-pinch-locked');

  let lastGestureScale = 1;
  let lastGestureAt = 0;
  let lastTouchSpan = 0;

  const onWheel = (ev) => {
    // Only intercept pinch-to-zoom trackpad gestures (`ctrlKey: true`).
    // Regular non-ctrl wheel scrolling inside sidebars, modals, and lists remains untouched.
    if (!ev?.ctrlKey) return;

    // If a native map canvas (MapLibre / Leaflet) or 3D canvas (Three.js OrbitControls)
    // already handled this pinch and prevented default, do NOT double-zoom!
    if (ev.defaultPrevented) return;

    ev.preventDefault();

    // Guard against browsers that emit both Safari gesturechange and ctrl+wheel together
    if (Date.now() - lastGestureAt < 36) return;

    const zoomDelta = wheelEventToPinchZoomDelta(ev);
    if (zoomDelta === 0) return;

    const targetMap = resolveTargetDesktopMap(ev.target, ev.clientX, ev.clientY, win);
    targetMap?.zoomByDelta?.(zoomDelta, ev.clientX, ev.clientY);
  };

  const onGestureStart = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }
    const scale = Number(ev?.scale);
    lastGestureScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  };

  const onGestureChange = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }
    const scale = Number(ev?.scale);
    if (!Number.isFinite(scale) || scale <= 0) return;
    const prev = lastGestureScale > 0 ? lastGestureScale : 1;
    const ratio = scale / prev;
    lastGestureScale = scale;
    lastGestureAt = Date.now();
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-4) return;

    const zoomDelta = clamp(Math.log2(ratio), -1.5, 1.5);
    const targetMap = resolveTargetDesktopMap(ev.target, ev.clientX, ev.clientY, win);
    targetMap?.zoomByDelta?.(zoomDelta, ev.clientX, ev.clientY);
  };

  const onGestureEnd = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }
    lastGestureScale = 1;
  };

  const onTouchStart = (ev) => {
    const touchCount = ev?.touches?.length || 0;
    if (touchCount < 2) {
      lastTouchSpan = 0;
      return;
    }
    const metrics = getTouchPairMetrics(ev.touches);
    lastTouchSpan = metrics ? metrics.span : 0;
    if (!isNativeTouchTarget(ev.target) && !ev.defaultPrevented) {
      ev.preventDefault();
    }
  };

  const onTouchMove = (ev) => {
    const touchCount = ev?.touches?.length || 0;
    const isPinchScale = typeof ev?.scale === 'number' && ev.scale !== 1;
    if (touchCount < 2 && !isPinchScale) return;

    // If native map touchZoomRotate / touchZoom already consumed it, stop browser zoom without double-zooming
    if (ev.defaultPrevented) return;

    ev.preventDefault();

    if (isNativeTouchTarget(ev.target) || touchCount < 2) return;
    const metrics = getTouchPairMetrics(ev.touches);
    if (!metrics) return;

    if (lastTouchSpan > 4 && metrics.span > 4) {
      const ratio = metrics.span / lastTouchSpan;
      lastTouchSpan = metrics.span;
      if (Math.abs(ratio - 1) >= 1e-4) {
        const zoomDelta = clamp(Math.log2(ratio), -1.5, 1.5);
        const targetMap = resolveTargetDesktopMap(ev.target, metrics.midX, metrics.midY, win);
        targetMap?.zoomByDelta?.(zoomDelta, metrics.midX, metrics.midY);
      }
    } else {
      lastTouchSpan = metrics.span;
    }
  };

  const onTouchEnd = (ev) => {
    if ((ev?.touches?.length || 0) < 2) {
      lastTouchSpan = 0;
    }
  };

  doc.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('gesturestart', onGestureStart, { passive: false });
  doc.addEventListener('gesturechange', onGestureChange, { passive: false });
  doc.addEventListener('gestureend', onGestureEnd, { passive: false });
  doc.addEventListener('touchstart', onTouchStart, { passive: false });
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('touchend', onTouchEnd, { passive: true });
  doc.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    doc.documentElement?.classList?.remove('desktop-map-pinch-locked');
    doc.body?.classList?.remove('desktop-map-pinch-locked');
    doc.removeEventListener('wheel', onWheel);
    doc.removeEventListener('gesturestart', onGestureStart);
    doc.removeEventListener('gesturechange', onGestureChange);
    doc.removeEventListener('gestureend', onGestureEnd);
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('touchend', onTouchEnd);
    doc.removeEventListener('touchcancel', onTouchEnd);
  };
}
