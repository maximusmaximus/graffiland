import { useEffect, useRef } from 'react';

const MAX_TRAIL_LENGTH = 30;

/**
 * Pure controller that synchronizes browser History API (`pushState` / `replaceState` / `popstate`)
 * with an in-app view stack so pressing the phone's Back button or desktop browser Back arrow
 * ALWAYS returns the user to their previous in-app view rather than leaving SPRAY.LAND for the
 * previous website in browser history.
 *
 * @param {{
 *   win?: Window | null,
 *   initialViewKey?: string,
 *   onBackStep: (context: { previousKey: string | null, currentKey: string, stack: string[] }) => boolean | void
 * }} options
 */
export function createInAppHistoryController({
  win = typeof window !== 'undefined' ? window : null,
  initialViewKey = 'root',
  onBackStep
} = {}) {
  const historyObj = win?.history;
  let destroyed = false;
  let handlingPop = false;
  let seq = 1;
  let stack = [String(initialViewKey || 'root')];

  const getSafeUrl = () => {
    try {
      return win?.location?.href || '/';
    } catch {
      return '/';
    }
  };

  const pushGuardEntry = (key, depth) => {
    if (!historyObj || typeof historyObj.pushState !== 'function') return;
    try {
      seq += 1;
      historyObj.pushState(
        {
          __spraylandInApp: true,
          __spraylandSeq: seq,
          __spraylandDepth: depth,
          __spraylandKey: key
        },
        '',
        getSafeUrl()
      );
    } catch {
      // ignore restricted history environments (e.g. opaque sandbox origins)
    }
  };

  // Anchor a root sentinel and immediately push one in-app frame above it so even pressing Back
  // on the initial screen stays safely inside SPRAY.LAND instead of leaving the site.
  if (historyObj && typeof historyObj.replaceState === 'function') {
    try {
      const existing =
        historyObj.state && typeof historyObj.state === 'object' ? historyObj.state : {};
      historyObj.replaceState(
        {
          ...existing,
          __spraylandRoot: true,
          __spraylandKey: stack[0]
        },
        '',
        getSafeUrl()
      );
    } catch {
      // ignore
    }
    pushGuardEntry(stack[0], 1);
  }

  const syncViewKey = (nextRawKey) => {
    if (destroyed) return;
    const nextKey = String(nextRawKey || 'root');
    const currentKey = stack[stack.length - 1];
    if (nextKey === currentKey) return;

    if (handlingPop) {
      // Update top to match the restored view without pushing a duplicate forward entry
      if (stack.length > 1 && stack[stack.length - 2] === nextKey) {
        stack.pop();
      } else {
        stack[stack.length - 1] = nextKey;
      }
      return;
    }

    // If user closed a modal via its UI X / Back button returning to the exact previous view,
    // pop the dismissed layer from the logical stack so browser Back steps cleanly past it.
    if (stack.length >= 2 && stack[stack.length - 2] === nextKey) {
      stack.pop();
      return;
    }

    // Genuine forward in-app navigation -> push onto logical stack AND browser history
    stack.push(nextKey);
    if (stack.length > MAX_TRAIL_LENGTH) {
      stack = stack.slice(stack.length - MAX_TRAIL_LENGTH);
    }
    pushGuardEntry(nextKey, stack.length);
  };

  const handlePopState = (ev) => {
    if (destroyed) return;
    const currentKey = stack[stack.length - 1] || 'root';
    const previousKey = stack.length >= 2 ? stack[stack.length - 2] : null;
    const hitRootSentinel = Boolean(ev?.state?.__spraylandRoot) || !ev?.state?.__spraylandInApp;

    handlingPop = true;
    let handled = false;
    try {
      handled = Boolean(
        onBackStep?.({
          previousKey,
          currentKey,
          stack: [...stack]
        })
      );
      if (handled && stack.length > 1) {
        stack.pop();
      }
    } finally {
      // Release pop guard after React commits state updates triggered by onBackStep
      Promise.resolve().then(() => {
        handlingPop = false;
      });
    }

    // Always re-anchor an in-app history entry if Back reached the root sentinel so the user
    // NEVER gets ejected to the previous website in their browser.
    if (hitRootSentinel) {
      const topKey = stack[stack.length - 1] || 'root';
      pushGuardEntry(topKey, Math.max(1, stack.length));
    }
  };

  win?.addEventListener?.('popstate', handlePopState);

  return {
    syncViewKey,
    getStack: () => [...stack],
    destroy: () => {
      destroyed = true;
      win?.removeEventListener?.('popstate', handlePopState);
    }
  };
}

/**
 * React hook that binds browser/device Back navigation (`popstate`) to in-app views.
 *
 * @param {{
 *   activeViewKey: string,
 *   onBackStep: (context: { previousKey: string | null, currentKey: string, stack: string[] }) => boolean | void,
 *   enabled?: boolean
 * }} options
 */
export function useInAppBackHistory({ activeViewKey, onBackStep, enabled = true }) {
  const onBackStepRef = useRef(onBackStep);
  onBackStepRef.current = onBackStep;
  const controllerRef = useRef(null);
  const initialViewKeyRef = useRef(activeViewKey);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const ctrl = createInAppHistoryController({
      win: window,
      initialViewKey: initialViewKeyRef.current,
      onBackStep: (ctx) => onBackStepRef.current?.(ctx)
    });
    controllerRef.current = ctrl;
    return () => {
      ctrl.destroy();
      if (controllerRef.current === ctrl) {
        controllerRef.current = null;
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    controllerRef.current?.syncViewKey(activeViewKey);
  }, [activeViewKey, enabled]);
}
