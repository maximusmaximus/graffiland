import { useEffect, useRef, useState } from 'react';
import { computeVisualViewportLayout } from '../utils/visualViewportMetrics.js';

function isTextInputElement(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color'].includes(
      type
    );
  }
  return Boolean(el.isContentEditable);
}

/**
 * Tracks the live visual viewport (height, top offset, virtual keyboard open state)
 * so full-screen mobile overlays (like Land Chat) shrink and pin seamlessly above
 * iOS Safari & Android Chrome/Samsung virtual keyboards.
 */
export function useVisualViewportLayout(active = true) {
  const baselineRef = useRef({ width: 0, height: 0 });
  const inputFocusedRef = useRef(false);

  const [metrics, setMetrics] = useState(() => {
    if (typeof window === 'undefined') {
      return {
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        keyboardInset: 0,
        keyboardOpen: false,
        compact: false
      };
    }
    const init = computeVisualViewportLayout(window);
    baselineRef.current = { width: init.width, height: Math.max(init.height, window.innerHeight || 0) };
    return init;
  });

  useEffect(() => {
    if (!active || typeof window === 'undefined') return undefined;

    const timers = new Set();
    const queueTimeout = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    const measure = () => {
      const curW = Math.round(window.visualViewport?.width || window.innerWidth || 0);
      const curH = Math.max(
        Math.round(window.visualViewport?.height || 0),
        Math.round(window.innerHeight || 0)
      );

      // Reset baseline when device rotates (width changes significantly)
      if (Math.abs(curW - baselineRef.current.width) > 40) {
        baselineRef.current = { width: curW, height: curH };
      } else if (curH > baselineRef.current.height) {
        baselineRef.current.height = curH;
      }

      const next = computeVisualViewportLayout(window, {
        baselineHeight: baselineRef.current.height,
        inputFocused: inputFocusedRef.current
      });

      setMetrics((prev) => {
        if (
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height &&
          prev.keyboardInset === next.keyboardInset &&
          prev.keyboardOpen === next.keyboardOpen &&
          prev.compact === next.compact
        ) {
          return prev;
        }
        return next;
      });
    };

    const onFocusIn = (e) => {
      if (isTextInputElement(e?.target)) {
        inputFocusedRef.current = true;
        measure();
        // Follow-up measurements after mobile virtual keyboard animation completes
        queueTimeout(measure, 160);
        queueTimeout(measure, 360);
      }
    };

    const onFocusOut = () => {
      queueTimeout(() => {
        inputFocusedRef.current = isTextInputElement(document.activeElement);
        measure();
      }, 60);
    };

    measure();

    const vv = window.visualViewport;
    vv?.addEventListener?.('resize', measure);
    vv?.addEventListener?.('scroll', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      vv?.removeEventListener?.('resize', measure);
      vv?.removeEventListener?.('scroll', measure);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [active]);

  return metrics;
}
