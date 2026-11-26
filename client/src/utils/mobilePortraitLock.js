/**
 * Mobile portrait orientation lock & anti-tilt viewport utilities.
 *
 * - Attempts native `screen.orientation.lock('portrait-primary')` (falling back to `'portrait'`)
 *   on mobile mount, first user gesture, and fullscreen entry (works natively in Android Chrome
 *   fullscreen/PWA and fails silently on iOS Safari).
 * - Detects genuine physical landscape rotation while ignoring portrait soft-keyboard height
 *   shrink (where `innerHeight` shrinks below `innerWidth` while typing in an input).
 * - Prevents browser-level Safari `gesturestart` pinch/tilt zoom and overscroll bounce on mobile.
 */

export function isEditableElementFocused(doc = typeof document !== 'undefined' ? document : null) {
  const el = doc?.activeElement;
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
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

  // Fallback for browsers without orientation APIs
  if (width > 0 && height > 0) {
    return width > height * 1.15;
  }

  return false;
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
 * Locks mobile viewport against page-level pinch/tilt zoom, overscroll tilt, and landscape rotation.
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

  const onFirstGesture = () => {
    tryLockPortraitOrientation(win);
  };

  const preventPageGesture = (ev) => {
    if (ev && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }
  };

  win.addEventListener('pointerdown', onFirstGesture, { passive: true, once: true });
  win.addEventListener('touchstart', onFirstGesture, { passive: true, once: true });
  doc.addEventListener('gesturestart', preventPageGesture, { passive: false });
  doc.addEventListener('gesturechange', preventPageGesture, { passive: false });
  doc.addEventListener('gestureend', preventPageGesture, { passive: false });

  return () => {
    doc.documentElement?.classList?.remove('mobile-portrait-locked');
    doc.body?.classList?.remove('mobile-portrait-locked');
    win.removeEventListener('pointerdown', onFirstGesture);
    win.removeEventListener('touchstart', onFirstGesture);
    doc.removeEventListener('gesturestart', preventPageGesture);
    doc.removeEventListener('gesturechange', preventPageGesture);
    doc.removeEventListener('gestureend', preventPageGesture);
  };
}
