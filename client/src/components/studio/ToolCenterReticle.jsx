import React, { useEffect, useRef, useState } from 'react';
import { computeCenterToolReticleMetrics } from '../../utils/toolReticleSizing.js';

const BRUSH_HOLD_DELAY_MS = 90;

/**
 * Interactive center-screen reticle circle for Brush and Pencil tools.
 *
 * - Renders a center circle dynamically sized to the selected tool (Brush vs Pencil)
 *   and block size (S / M / L / XL) at the active surface or reach depth.
 * - First click/tap inside the circle sets & locks the surface at that center location.
 * - Subsequent taps (Pencil or quick Brush dab) draw right at that location, and holding
 *   inside the circle in Brush mode continuously spray-paints from the center aim.
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
  onDrawAtCenter = null,
  onStartCenterBrushHold = null,
  onStopCenterBrushHold = null
}) {
  const [viewportH, setViewportH] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight || 844 : 844
  );

  const holdTimerRef = useRef(null);
  const holdingSprayRef = useRef(false);
  const pendingTapActionRef = useRef('');
  const handledPointerUpRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncH = () => setViewportH(window.innerHeight || 844);
    window.addEventListener('resize', syncH, { passive: true });
    return () => window.removeEventListener('resize', syncH);
  }, []);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (holdingSprayRef.current) {
        holdingSprayRef.current = false;
        onStopCenterBrushHold?.();
      }
    };
  }, [onStopCenterBrushHold]);

  if (tool !== 'brush' && tool !== 'pencil') {
    return <div className="reticle" />;
  }

  const hasSurfaceAnchor = Boolean(surfaceAnchor);
  const activeDepthM =
    surfaceAnchor?.locked && Number(surfaceAnchor.depthM) > 0
      ? Number(surfaceAnchor.depthM)
      : Number(reachMeters) || 1.8;

  const metrics = computeCenterToolReticleMetrics({
    tool,
    blockSize,
    depthMeters: activeDepthM,
    vFovDeg,
    viewportHeightPx: viewportH
  });

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const handlePointerDown = (e) => {
    if (e.button && e.button !== 0) return;
    e.stopPropagation();
    handledPointerUpRef.current = false;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore synthetic pointers
    }
    clearHoldTimer();
    holdingSprayRef.current = false;

    if (!hasSurfaceAnchor) {
      pendingTapActionRef.current = 'set-surface';
      return;
    }

    pendingTapActionRef.current = 'draw-center';
    if (tool === 'brush') {
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        if (pendingTapActionRef.current !== 'draw-center') return;
        holdingSprayRef.current = true;
        pendingTapActionRef.current = '';
        onStartCenterBrushHold?.();
      }, BRUSH_HOLD_DELAY_MS);
    }
  };

  const handlePointerUp = (e) => {
    e.stopPropagation();
    clearHoldTimer();
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    const action = pendingTapActionRef.current;
    pendingTapActionRef.current = '';

    if (holdingSprayRef.current) {
      holdingSprayRef.current = false;
      handledPointerUpRef.current = true;
      onStopCenterBrushHold?.();
      return;
    }

    if (action === 'set-surface') {
      handledPointerUpRef.current = true;
      onSetCenterSurface?.();
    } else if (action === 'draw-center') {
      handledPointerUpRef.current = true;
      onDrawAtCenter?.();
    }
  };

  const handlePointerCancel = (e) => {
    e.stopPropagation();
    clearHoldTimer();
    pendingTapActionRef.current = '';
    if (holdingSprayRef.current) {
      holdingSprayRef.current = false;
      onStopCenterBrushHold?.();
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    if (handledPointerUpRef.current) {
      handledPointerUpRef.current = false;
      return;
    }
    if (!hasSurfaceAnchor) {
      onSetCenterSurface?.();
    } else {
      onDrawAtCenter?.();
    }
  };

  const ariaLabel = !hasSurfaceAnchor
    ? `Set drawing surface at center (${tool === 'brush' ? 'Brush' : 'Pencil'}, size ${metrics.sizePresetLabel})`
    : tool === 'brush'
    ? `Paint at center with Brush (size ${metrics.sizePresetLabel})`
    : `Draw block at center with Pencil (size ${metrics.sizePresetLabel})`;

  return (
    <button
      type="button"
      className={`reticle is-tool-circle is-tool-${tool} ${
        hasSurfaceAnchor ? 'is-surface-set' : 'needs-surface'
      } ${painting ? 'is-painting' : ''}`}
      data-testid="tool-center-reticle"
      data-tool={tool}
      data-block-size={String(metrics.blockScale)}
      data-size-label={metrics.sizePresetLabel}
      data-diameter-px={String(metrics.diameterPx)}
      data-block-diameter-px={String(metrics.blockDiameterPx)}
      data-surface-set={hasSurfaceAnchor ? 'true' : 'false'}
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
          className={`tool-reticle-caption ${hasSurfaceAnchor ? 'is-locked' : 'is-prompt'}`}
          data-testid="tool-reticle-caption"
          aria-hidden="true"
        >
          {!hasSurfaceAnchor
            ? 'Tap circle to set surface'
            : `${metrics.sizePresetLabel} · ${tool === 'brush' ? 'Hold/tap' : 'Tap'}`}
        </span>
      )}
    </button>
  );
}
