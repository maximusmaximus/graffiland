const SETTINGS_SAVED_EVENT = 'graffiland:settings-saved';

/** @type {Set<(detail: { id: number, message: string, tone: string, durationMs: number }) => void>} */
const fallbackListeners = new Set();

function nextToastId() {
  if (typeof globalThis !== 'undefined') {
    const cur = Number(globalThis.__graffilandToastSeq || 0) + 1;
    globalThis.__graffilandToastSeq = cur;
    return cur;
  }
  return Date.now();
}

/**
 * Emits a global floating notification confirming that user/land/sculpture settings were saved.
 * Uses `window` CustomEvent when available so lazy-loaded chunks and standalone bundles always communicate cleanly.
 * @param {string} message
 * @param {{ tone?: 'success' | 'info' | 'warning' | 'error', durationMs?: number }} [opts]
 */
export function notifySettingsSaved(message, { tone = 'success', durationMs = 3400 } = {}) {
  const cleanMsg = String(message || '').trim();
  if (!cleanMsg) return;
  const detail = {
    id: nextToastId(),
    message: cleanMsg,
    tone,
    durationMs: Math.max(1200, Math.min(10000, Number(durationMs) || 3400))
  };

  if (
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function' &&
    typeof window.CustomEvent === 'function'
  ) {
    try {
      window.dispatchEvent(new window.CustomEvent(SETTINGS_SAVED_EVENT, { detail }));
      return;
    } catch {
      // fall through to direct listeners
    }
  }

  for (const fn of fallbackListeners) {
    try {
      fn(detail);
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * Subscribes to global settings-saved toast notifications.
 * @param {(detail: { id: number, message: string, tone: string, durationMs: number }) => void} handler
 * @returns {() => void}
 */
export function subscribeSettingsSaved(handler) {
  if (typeof handler !== 'function') return () => {};

  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function' &&
    typeof window.removeEventListener === 'function'
  ) {
    const onEvt = (evt) => {
      if (evt?.detail) handler(evt.detail);
    };
    window.addEventListener(SETTINGS_SAVED_EVENT, onEvt);
    return () => {
      window.removeEventListener(SETTINGS_SAVED_EVENT, onEvt);
    };
  }

  fallbackListeners.add(handler);
  return () => {
    fallbackListeners.delete(handler);
  };
}
