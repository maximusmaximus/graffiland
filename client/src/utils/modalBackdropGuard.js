import { useCallback, useRef } from 'react';

const POINTERUP_STAMP_KEY = '__SPRAYLAND_MODAL_POINTERUP_AT__';

function readPointerUpStamp() {
  return Number(globalThis?.[POINTERUP_STAMP_KEY] || 0);
}

function writePointerUpStamp(val) {
  if (typeof globalThis === 'object' && globalThis) {
    globalThis[POINTERUP_STAMP_KEY] = val;
  }
}

/**
 * Stamps the exact timestamp when a pointerup gesture (such as tapping a tool in
 * `ToolCarouselBar`) opens a modal or sheet. Mobile browsers synthesize a `click`
 * event ~10-80ms after `pointerup` at the exact same coordinates — if a newly mounted
 * `.modal-backdrop` sits underneath the lifted finger, that ghost click would
 * immediately dismiss the modal unless guarded.
 */
export function markModalOpenedFromPointerUp(nowMs = Date.now()) {
  writePointerUpStamp(nowMs);
}

export function isWithinPointerUpGhostWindow(graceMs = 450, nowMs = Date.now()) {
  const stamp = readPointerUpStamp();
  return stamp > 0 && nowMs - stamp < graceMs;
}

export function resetPointerUpGhostWindow() {
  writePointerUpStamp(0);
}

/**
 * Returns safe backdrop event props (`onPointerDown`, `onMouseDown`, `onClick`) for
 * modal backdrops so:
 * 1. Synthetic mobile ghost clicks emitted right after a `pointerup` modal trigger
 *    (when no fresh pointerdown occurred on the backdrop) NEVER immediately close the modal.
 * 2. Dragging text inside a modal input and releasing outside on the backdrop NEVER
 *    accidentally dismisses the modal.
 * 3. Deliberate clicks/taps directly on the backdrop close immediately with zero lag.
 */
export function useSafeBackdropClose(onClose, { graceMs = 450 } = {}) {
  const pointerDownOnBackdropRef = useRef(false);
  const sawPointerDownSinceMountRef = useRef(false);

  const onPointerDown = useCallback((e) => {
    sawPointerDownSinceMountRef.current = true;
    pointerDownOnBackdropRef.current = e.target === e.currentTarget;
  }, []);

  const onMouseDown = useCallback((e) => {
    sawPointerDownSinceMountRef.current = true;
    pointerDownOnBackdropRef.current = e.target === e.currentTarget;
  }, []);

  const onClick = useCallback(
    (e) => {
      if (e.target !== e.currentTarget) return;
      // Drag started inside modal content and ended on backdrop -> ignore
      if (sawPointerDownSinceMountRef.current && !pointerDownOnBackdropRef.current) {
        return;
      }
      // Synthetic ghost click arriving right after ToolCarouselBar pointerup -> ignore
      if (!pointerDownOnBackdropRef.current && isWithinPointerUpGhostWindow(graceMs)) {
        return;
      }
      pointerDownOnBackdropRef.current = false;
      onClose?.(e);
    },
    [graceMs, onClose]
  );

  return { onPointerDown, onMouseDown, onClick };
}
