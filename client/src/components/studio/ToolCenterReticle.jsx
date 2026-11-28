import React, { useEffect, useRef, useState } from 'react';
import { computeCenterToolReticleMetrics } from '../../utils/toolReticleSizing.js';

export const RETICLE_HOLD_LOCK_DRAW_MS = 180;
const POINTER_CLICK_DEDUPE_MS = 400;

/**
 * Interactive center-screen reticle circle for Brush and Pencil tools.
 *
 * - Renders a center circle dynamically sized to the selected tool (Brush vs Pencil)
 *   and block size (S / M / L / XL) at the active surface or reach depth.
 * - Click & hold on the circle locks the drawing surface at that center location and
 *   immediately draws (continuous spray for Brush, block placement for Pencil).
 * - While locked, holding the circle again draws on that locked surface; clicking/tapping
 *   the circle again unlocks it so the user can move and lock a new location.
 */
export default function ToolCenterReticle({
  tool = 'brush',
  blockSize = 1,
  color = '#00f5d4',
  reachMeters = 1.8,
  surfaceAnchor = null,
  painting = false,
  vFovDeg = 65,
  onSetCenterSurface = null,
  onUnlockCenterSurface = null,
  onDrawAtCenter = null,
  onStartCenterBrushHold = null,
  onStopCenterBrushHold = null
}) {
  const [viewportH, setViewportH] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight || 844 : 844
  );

  const holdTimerRef = useRef(null);
  const activePointerIdRef = useRef(null);
  const holdTriggeredRef = useRef(false);
  const holdingBrushSprayRef = useRef(false);
  const wasLockedOnDownRef = useRef(false);
  const lastPointerHandledAtRef = useRef(0);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncH = () => setViewportH(window.innerHeight || 844);
    const handleWindowBlur = () => {
      clearHoldTimer();
      activePointerIdRef.current = null;
      holdTriggeredRef.current = false;
      if (holdingBrushSprayRef.current) {
        holdingBrushSprayRef.current = false;
        onStopCenterBrushHold?.();
      }
    };
    window.addEventListener('resize', syncH, { passive: true });
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('resize', syncH);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [onStopCenterBrushHold]);

  // Clean up timers & active hold spray on unmount or tool switch
  useEffect(() => {
    return () => {
      clearHoldTimer();
      activePointerIdRef.current = null;
      holdTriggeredRef.current = false;
      if (holdingBrushSprayRef.current) {
        holdingBrushSprayRef.current = false;
        onStopCenterBrushHold?.();
      }
    };
  }, [tool, onStopCenterBrushHold]);

  if (tool !== 'brush' && tool !== 'pencil') {
    return <div className="reticle" />;
  }

  const isSurfaceLocked = Boolean(surfaceAnchor?.locked);
  const activeDepthM =
    isSurfaceLocked && Number(surfaceAnchor.depthM) > 0
      ? Number(surfaceAnchor.depthM)
      : Number(reachMeters) || 1.8;

  const metrics = computeCenterToolReticleMetrics({
    tool,
    blockSize,
    depthMeters: activeDepthM,
    vFovDeg,
    viewportHeightPx: viewportH
  });

  const handlePointerDown = (e) => {
    if (e.button && e.button !== 0) return;
    e.stopPropagation();
    // Ignore secondary multi-touch pointers while a primary hold/tap owns the circle
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    activePointerIdRef.current = e.pointerId;
    holdTriggeredRef.current = false;
    holdingBrushSprayRef.current = false;
    wasLockedOnDownRef.current = isSurfaceLocked;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore synthetic pointers
    }
    clearHoldTimer();

    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      if (activePointerIdRef.current === null) return;
      holdTriggeredRef.current = true;

      if (!wasLockedOnDownRef.current) {
        const lockedResult = onSetCenterSurface?.({ silent: true });
        if (lockedResult === null || lockedResult === false) {
          return;
        }
      }

      navigator.vibrate?.(8);
      if (tool === 'brush') {
        holdingBrushSprayRef.current = true;
        onStartCenterBrushHold?.();
      } else {
        onDrawAtCenter?.();
      }
    }, RETICLE_HOLD_LOCK_DRAW_MS);
  };

  const handlePointerUp = (e) => {
    e.stopPropagation();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    clearHoldTimer();
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    const hadActivePointer = activePointerIdRef.current !== null;
    activePointerIdRef.current = null;
    lastPointerHandledAtRef.current = performance.now();

    const wasHold = holdTriggeredRef.current;
    holdTriggeredRef.current = false;

    if (holdingBrushSprayRef.current) {
      holdingBrushSprayRef.current = false;
      onStopCenterBrushHold?.();
      return;
    }

    if (wasHold || !hadActivePointer) {
      return;
    }

    // Quick click/tap: if already locked -> unlock so user can change draw location;
    // if unlocked -> lock at current center location (and place block on Pencil).
    if (wasLockedOnDownRef.current) {
      navigator.vibrate?.(6);
      onUnlockCenterSurface?.();
    } else {
      const lockedResult = onSetCenterSurface?.();
      if (lockedResult !== null && lockedResult !== false && tool === 'pencil') {
        onDrawAtCenter?.();
      }
    }
  };

  const handlePointerCancel = (e) => {
    e.stopPropagation();
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) {
      return;
    }
    clearHoldTimer();
    activePointerIdRef.current = null;
    holdTriggeredRef.current = false;
    lastPointerHandledAtRef.current = performance.now();
    if (holdingBrushSprayRef.current) {
      holdingBrushSprayRef.current = false;
      onStopCenterBrushHold?.();
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (performance.now() - lastPointerHandledAtRef.current < POINTER_CLICK_DEDUPE_MS) {
      return;
    }
    if (isSurfaceLocked) {
      onUnlockCenterSurface?.();
    } else {
      const lockedResult = onSetCenterSurface?.();
      if (lockedResult !== null && lockedResult !== false && tool === 'pencil') {
        onDrawAtCenter?.();
      }
    }
  };

  const ariaLabel = isSurfaceLocked
    ? `Location locked (${tool === 'brush' ? 'Brush' : 'Pencil'}, size ${metrics.sizePresetLabel}) — hold to draw here or click to change location`
    : `Hold circle to lock and draw here (${tool === 'brush' ? 'Brush' : 'Pencil'}, size ${metrics.sizePresetLabel})`;

  return (
    <button
      type="button"
      className={`reticle is-tool-circle is-tool-${tool} ${
        isSurfaceLocked ? 'is-surface-set is-surface-locked' : 'needs-surface'
      } ${painting ? 'is-painting' : ''}`}
      data-testid="tool-center-reticle"
      data-tool={tool}
      data-block-size={String(metrics.blockScale)}
      data-size-label={metrics.sizePresetLabel}
      data-diameter-px={String(metrics.diameterPx)}
      data-block-diameter-px={String(metrics.blockDiameterPx)}
      data-surface-set={isSurfaceLocked ? 'true' : 'false'}
      data-surface-locked={isSurfaceLocked ? 'true' : 'false'}
      style={{
        width: `${metrics.hitDiameterPx}px`,
        height: `${metrics.hitDiameterPx}px`,
        '--reticle-color': color || '#00f5d4'
      }}
      aria-label={ariaLabel}
      title={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span
        className="tool-reticle-ring"
        data-testid="tool-reticle-ring"
        style={{
          width: `${metrics.diameterPx}px`,
          height: `${metrics.diameterPx}px`
        }}
        aria-hidden="true"
      >
        {isSurfaceLocked && (
          <span
            className="tool-reticle-lock-dot"
            data-testid="tool-reticle-lock-dot"
            aria-hidden="true"
          >
            🔒
          </span>
        )}
        {tool === 'brush' ? (
          <span
            className="tool-reticle-inner-block is-brush-core"
            style={{
              width: `${metrics.blockDiameterPx}px`,
              height: `${metrics.blockDiameterPx}px`
            }}
          />
        ) : (
          <span
            className="tool-reticle-inner-block is-pencil-cube"
            style={{
              width: `${Math.max(10, Math.round(metrics.blockDiameterPx * 0.68))}px`,
              height: `${Math.max(10, Math.round(metrics.blockDiameterPx * 0.68))}px`
            }}
          />
        )}
        <span className="tool-reticle-center-dot" />
      </span>
      {!painting && (
        <span
          className={`tool-reticle-caption ${isSurfaceLocked ? 'is-locked' : 'is-prompt'}`}
          data-testid="tool-reticle-caption"
          aria-hidden="true"
        >
          {isSurfaceLocked
            ? `${metrics.sizePresetLabel} · Hold draw · Tap to move`
            : `${metrics.sizePresetLabel} · Hold to lock & draw`}
        </span>
      )}
    </button>
  );
}
