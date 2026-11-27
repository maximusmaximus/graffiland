/**
 * Mobile portrait orientation lock, anti-zoom & anchored-HUD viewport utilities.
 *
 * - Attempts native `screen.orientation.lock('portrait-primary')` (falling back to `'portrait'`)
 *   on mobile mount, first user gesture, and fullscreen entry (works natively in Android Chrome
 *   fullscreen/PWA and fails silently on iOS Safari).
 * - Detects genuine physical landscape rotation while ignoring portrait soft-keyboard height
 *   shrink (where `innerHeight` shrinks below `innerWidth` while typing in an input).
 * - Blocks ALL mobile browser viewport zoom vectors (Safari gesturestart/change/end, multi-touch
 *   pinch-zoom touchstart/touchmove, double-tap zoom on non-interactive surfaces, and Ctrl+wheel
 *   pinch) while keeping dedicated map/3D canvas touch gestures intact.
 * - Auto-resets stray root scroll drift on keyboard dismissal & visualViewport updates so HUD
 *   buttons always remain anchored at their expected screen positions.
 */

const CANVAS_OR_MAP_SELECTOR =
  'canvas, .maplibregl-map, .leaflet-container, [data-allow-pinch="true"]';
const INTERACTIVE_TAP_SELECTOR =
  'button, a, input, textarea, select, label, [role="button"], canvas, .maplibregl-map, .leaflet-container';

export function isEditableElementFocused(doc = typeof document !== 'undefined' ? document : null) {
  const el = doc?.activeElement;
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

export function isCanvasOrMapTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest(CANVAS_OR_MAP_SELECTOR));
}

export function isInteractiveTapTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest(INTERACTIVE_TAP_SELECTOR));
}

/**
 * Returns true ONLY when a mobile device is genuinely rotated into landscape orientation.
 * Never false-triggers when a portrait phone's on-screen keyboard shrinks viewport height.
 */
export function isMobileLandscapeOrientation(
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!win) return false;

  const width = Number(win.innerWidth || 0);
  const height = Number(win.innerHeight || 0);
  const orientType = String(win.screen?.orientation?.type || '').toLowerCase();
  const legacyAngle = typeof win.orientation === 'number' ? win.orientation : null;

  // Explicit portrait reported by Screen Orientation API or legacy iOS window.orientation
  if (orientType.startsWith('portrait')) return false;
  if (legacyAngle === 0 || Math.abs(legacyAngle) === 180) return false;

  // Guard against portrait soft-keyboard shrink (e.g. 390x380 while typing in chat/forms)
  if (isEditableElementFocused(doc) && width > 0 && width <= 500) {
    return false;
  }

  // Explicit legacy iOS 90/-90 degree rotation
  if (legacyAngle !== null && Math.abs(legacyAngle) === 90) {
    return true;
  }

  // Screen Orientation API landscape + aspect check (prevents narrow keyboard shrink false triggers)
  if (orientType.startsWith('landscape')) {
    if (width <= 0 || height <= 0) return true;
    return width > height * 1.15;
  }

  // Media query landscape hint + aspect guard
  if (typeof win.matchMedia === 'function') {
    try {
      if (win.matchMedia('(orientation: landscape)')?.matches && width > 0 && height > 0) {
        return width > height * 1.15;
      }
    } catch {
      // ignore matchMedia errors in headless environments
    }
  }

  // Fallback for browsers without orientation APIs
  if (width > 0 && height > 0) {
    return width > height * 1.15;
  }

  return false;
}

/**
 * Synchronously toggles the `mobile-landscape-blocked` class on `<html>` / `<body>`
 * whenever a mobile viewport is turned horizontally so underlying AR/HUD content is
 * immediately locked out until the phone returns to Portrait.
 */
export function syncPortraitLockClass(
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!win || !doc) return false;
  const isLandscape = isMobileLandscapeOrientation(win, doc);
  doc.documentElement?.classList?.toggle('mobile-landscape-blocked', isLandscape);
  doc.body?.classList?.toggle('mobile-landscape-blocked', isLandscape);
  return isLandscape;
}

/**
 * Best-effort native portrait orientation lock. Always resolves to boolean and never throws.
 */
export async function tryLockPortraitOrientation(
  win = typeof window !== 'undefined' ? window : null
) {
  const lockFn = win?.screen?.orientation?.lock;
  if (typeof lockFn !== 'function') return false;
  try {
    await lockFn.call(win.screen.orientation, 'portrait-primary');
    return true;
  } catch {
    try {
      await lockFn.call(win.screen.orientation, 'portrait');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Keeps root mobile scroll pinned at (0, 0) whenever an input is not focused so fixed HUD buttons
 * never drift out of view after keyboard dismissal or rubber-band gestures.
 */
export function resetMobileViewportAnchor(
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!win || !doc) return false;
  if (isEditableElementFocused(doc)) return false;
  const sx = Number(win.scrollX ?? win.pageXOffset ?? 0);
  const sy = Number(win.scrollY ?? win.pageYOffset ?? 0);
  if (sx !== 0 || sy !== 0) {
    try {
      win.scrollTo?.(0, 0);
    } catch {
      // ignore non-scrollable environments
    }
    return true;
  }
  return false;
}

/**
 * Syncs `--mobile-app-height` and `--mobile-app-width` on `:root` to the exact visible
 * viewport dimensions so bottom-anchored HUD controls (Map button, ToolCarouselBar, Palette FAB)
 * NEVER fall off the bottom edge after orientation changes, fullscreen toggles, or Android
 * Chrome address-bar height transitions where CSS `100dvh` can desync by 50-90px.
 */
export function syncMobileViewportDimensions(
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!win || !doc?.documentElement?.style) return null;
  const vv = win.visualViewport;
  const innerW = Number(win.innerWidth || 0);
  const innerH = Number(win.innerHeight || 0);
  const vvW = Number(vv?.width || 0);
  const vvH = Number(vv?.height || 0);
  const editingInput = isEditableElementFocused(doc);

  let visibleH = innerH;
  if (!editingInput && vvH > 0) {
    visibleH = innerH > 0 ? Math.min(vvH, innerH) : vvH;
  } else if (visibleH <= 0 && vvH > 0) {
    visibleH = vvH;
  }

  let visibleW = innerW;
  if (!editingInput && vvW > 0) {
    visibleW = innerW > 0 ? Math.min(vvW, innerW) : vvW;
  } else if (visibleW <= 0 && vvW > 0) {
    visibleW = vvW;
  }

  const roundedH = Math.round(visibleH);
  const roundedW = Math.round(visibleW);
  if (roundedH > 0) {
    doc.documentElement.style.setProperty('--mobile-app-height', `${roundedH}px`);
  }
  if (roundedW > 0) {
    doc.documentElement.style.setProperty('--mobile-app-width', `${roundedW}px`);
  }
  return { width: roundedW, height: roundedH };
}

/**
 * Locks mobile viewport against pinch-zoom, double-tap zoom, input auto-zoom drift,
 * overscroll shift, and landscape rotation so HUD buttons stay firmly anchored.
 * Returns a cleanup callback.
 */
export function installMobileViewportLock({
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
} = {}) {
  if (!win || !doc) return () => {};

  doc.documentElement?.classList?.add('mobile-portrait-locked');
  doc.body?.classList?.add('mobile-portrait-locked');

  tryLockPortraitOrientation(win);
  syncMobileViewportDimensions(win, doc);
  resetMobileViewportAnchor(win, doc);
  syncPortraitLockClass(win, doc);

  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const settleTimers = new Set();

  const scheduleSettleSync = () => {
    tryLockPortraitOrientation(win);
    syncMobileViewportDimensions(win, doc);
    resetMobileViewportAnchor(win, doc);
    syncPortraitLockClass(win, doc);
    for (const delayMs of [120, 360]) {
      const id = setTimeout(() => {
        settleTimers.delete(id);
        syncMobileViewportDimensions(win, doc);
        resetMobileViewportAnchor(win, doc);
        syncPortraitLockClass(win, doc);
      }, delayMs);
      settleTimers.add(id);
    }
  };

  let orientationLockedOnce = false;
  const onGestureTryLock = () => {
    syncMobileViewportDimensions(win, doc);
    const landscapeNow = syncPortraitLockClass(win, doc);
    if (!orientationLockedOnce || landscapeNow) {
      tryLockPortraitOrientation(win).then((ok) => {
        if (ok) orientationLockedOnce = true;
      });
    }
  };

  const preventPageGesture = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }
  };

  const onTouchStart = (ev) => {
    const touchCount = ev?.touches?.length || 0;
    if (touchCount > 1 && !isCanvasOrMapTarget(ev.target)) {
      ev.preventDefault();
    }
  };

  const onTouchMove = (ev) => {
    const touchCount = ev?.touches?.length || 0;
    const isPinchScale = typeof ev?.scale === 'number' && ev.scale !== 1;
    if (touchCount > 1 || isPinchScale) {
      // Bubble-phase cancel stops browser-level page zoom even after canvas/map handlers run
      ev.preventDefault();
    }
  };

  const onTouchEnd = (ev) => {
    if (!ev || (ev.touches && ev.touches.length > 0)) return;
    const changed = ev.changedTouches;
    if (!changed || changed.length !== 1) return;
    // Never swallow rapid clicks on interactive buttons/controls (CSS touch-action handles them)
    if (isInteractiveTapTarget(ev.target)) {
      lastTapAt = 0;
      return;
    }
    const now = Date.now();
    const pt = changed[0];
    const dx = Math.abs((pt?.clientX || 0) - lastTapX);
    const dy = Math.abs((pt?.clientY || 0) - lastTapY);
    if (lastTapAt > 0 && now - lastTapAt <= 320 && dx <= 40 && dy <= 40) {
      ev.preventDefault();
      lastTapAt = 0;
      return;
    }
    lastTapAt = now;
    lastTapX = pt?.clientX || 0;
    lastTapY = pt?.clientY || 0;
  };

  const onWheel = (ev) => {
    if (ev?.ctrlKey && !isCanvasOrMapTarget(ev.target)) {
      ev.preventDefault();
    }
  };

  const onAnchorCheck = () => {
    syncMobileViewportDimensions(win, doc);
    resetMobileViewportAnchor(win, doc);
    syncPortraitLockClass(win, doc);
  };

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') {
      scheduleSettleSync();
    }
  };

  const screenOrient = win.screen?.orientation;
  const landscapeMq =
    typeof win.matchMedia === 'function' ? win.matchMedia('(orientation: landscape)') : null;

  win.addEventListener('pointerdown', onGestureTryLock, { passive: true });
  win.addEventListener('touchstart', onGestureTryLock, { passive: true });
  win.addEventListener('resize', onAnchorCheck, { passive: true });
  win.addEventListener('orientationchange', scheduleSettleSync, { passive: true });
  win.addEventListener('pageshow', scheduleSettleSync, { passive: true });
  screenOrient?.addEventListener?.('change', scheduleSettleSync);
  landscapeMq?.addEventListener?.('change', scheduleSettleSync);
  doc.addEventListener('fullscreenchange', scheduleSettleSync, { passive: true });
  doc.addEventListener('webkitfullscreenchange', scheduleSettleSync, { passive: true });
  doc.addEventListener('visibilitychange', onVisibilityChange, { passive: true });
  doc.addEventListener('gesturestart', preventPageGesture, { passive: false });
  doc.addEventListener('gesturechange', preventPageGesture, { passive: false });
  doc.addEventListener('gestureend', preventPageGesture, { passive: false });
  doc.addEventListener('touchstart', onTouchStart, { passive: false });
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('touchend', onTouchEnd, { passive: false });
  doc.addEventListener('wheel', onWheel, { passive: false });
  doc.addEventListener('focusout', scheduleSettleSync, { passive: true });
  win.visualViewport?.addEventListener?.('resize', onAnchorCheck);
  win.visualViewport?.addEventListener?.('scroll', onAnchorCheck);

  return () => {
    for (const id of settleTimers) clearTimeout(id);
    settleTimers.clear();
    doc.documentElement?.classList?.remove('mobile-portrait-locked', 'mobile-landscape-blocked');
    doc.body?.classList?.remove('mobile-portrait-locked', 'mobile-landscape-blocked');
    doc.documentElement?.style?.removeProperty('--mobile-app-height');
    doc.documentElement?.style?.removeProperty('--mobile-app-width');
    win.removeEventListener('pointerdown', onGestureTryLock);
    win.removeEventListener('touchstart', onGestureTryLock);
    win.removeEventListener('resize', onAnchorCheck);
    win.removeEventListener('orientationchange', scheduleSettleSync);
    win.removeEventListener('pageshow', scheduleSettleSync);
    screenOrient?.removeEventListener?.('change', scheduleSettleSync);
    landscapeMq?.removeEventListener?.('change', scheduleSettleSync);
    doc.removeEventListener('fullscreenchange', scheduleSettleSync);
    doc.removeEventListener('webkitfullscreenchange', scheduleSettleSync);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    doc.removeEventListener('gesturestart', preventPageGesture);
    doc.removeEventListener('gesturechange', preventPageGesture);
    doc.removeEventListener('gestureend', preventPageGesture);
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('touchend', onTouchEnd);
    doc.removeEventListener('wheel', onWheel);
    doc.removeEventListener('focusout', scheduleSettleSync);
    win.visualViewport?.removeEventListener?.('resize', onAnchorCheck);
    win.visualViewport?.removeEventListener?.('scroll', onAnchorCheck);
  };
}
