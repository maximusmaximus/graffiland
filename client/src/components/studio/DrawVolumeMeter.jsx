import React, { useEffect, useRef, useState } from 'react';

/**
 * Pure helper computing volumetric meter remaining pixel/block capacity & warning state.
 */
export function computeDrawVolumeMeterState({
  usedVoxels = 0,
  maxVoxels = 4096,
  brushColor = '#00f5d4'
} = {}) {
  const safeMax = Math.max(1, Math.round(Number(maxVoxels) || 4096));
  const safeUsed = Math.max(0, Math.min(safeMax, Math.round(Number(usedVoxels) || 0)));
  const remaining = Math.max(0, safeMax - safeUsed);
  const remainingRatio = remaining / safeMax;
  const remainingPct = Math.round(remainingRatio * 100);

  let state = 'normal';
  if (remaining === 0) state = 'empty';
  else if (remainingRatio <= 0.12) state = 'critical';
  else if (remainingRatio <= 0.3) state = 'low';

  const fillColor =
    state === 'empty' || state === 'critical'
      ? '#ff3e7f'
      : state === 'low'
      ? '#ffd166'
      : typeof brushColor === 'string' && brushColor.trim()
      ? brushColor.trim()
      : '#00f5d4';

  return {
    usedVoxels: safeUsed,
    maxVoxels: safeMax,
    remaining,
    remainingRatio,
    remainingPct,
    state,
    fillColor
  };
}

/**
 * Side volumetric liquid/ink capacity bar shown while the user holds down a drawing tool
 * (Brush, Stack, Pencil, or Eraser), communicating in real time how many pixels/blocks
 * remain before the sculpture reaches the per-piece limit.
 */
export default function DrawVolumeMeter({
  active = false,
  painting = false,
  usedVoxels = 0,
  maxVoxels = 4096,
  brushColor = '#00f5d4',
  tool = 'brush',
  lingerMs = 950
}) {
  const [renderedVisible, setRenderedVisible] = useState(Boolean(active || painting));
  const hideTimerRef = useRef(null);

  const isHeld = Boolean(active || painting);

  useEffect(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (isHeld) {
      setRenderedVisible(true);
      return undefined;
    }
    if (renderedVisible) {
      const wait = Math.max(0, Number(lingerMs) || 0);
      if (wait === 0) {
        setRenderedVisible(false);
      } else {
        hideTimerRef.current = setTimeout(() => {
          setRenderedVisible(false);
          hideTimerRef.current = null;
        }, wait);
      }
    }
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [isHeld, lingerMs, renderedVisible]);

  const meter = computeDrawVolumeMeterState({ usedVoxels, maxVoxels, brushColor });
  const fillPct = Number((meter.remainingRatio * 100).toFixed(2));
  const isErasing = tool === 'erase';

  return (
    <aside
      className={`draw-volume-meter ${renderedVisible ? 'is-visible' : 'is-hidden'} ${
        painting ? 'is-spraying' : ''
      } ${isErasing ? 'is-refilling' : ''} is-state-${meter.state}`}
      data-testid="draw-volume-meter"
      data-visible={renderedVisible ? 'true' : 'false'}
      data-state={meter.state}
      data-remaining={String(meter.remaining)}
      data-max={String(meter.maxVoxels)}
      role="progressbar"
      aria-label={`Remaining drawing pixels: ${meter.remaining.toLocaleString()} of ${meter.maxVoxels.toLocaleString()}`}
      aria-valuemin={0}
      aria-valuemax={meter.maxVoxels}
      aria-valuenow={meter.remaining}
      aria-hidden={!renderedVisible}
    >
      <div className="draw-volume-pct mono" data-testid="draw-volume-percent">
        {meter.state === 'empty' ? '0%' : `${meter.remainingPct}%`}
      </div>

      <div className="draw-volume-tube" aria-hidden="true">
        <div className="draw-volume-ticks">
          <span className="draw-volume-tick" style={{ bottom: '75%' }} />
          <span className="draw-volume-tick is-mid" style={{ bottom: '50%' }} />
          <span className="draw-volume-tick" style={{ bottom: '25%' }} />
        </div>
        <div
          className="draw-volume-fill"
          data-testid="draw-volume-fill"
          style={{
            height: `${fillPct}%`,
            '--vol-color': meter.fillColor
          }}
        >
          <span className="draw-volume-meniscus" />
        </div>
        <div className="draw-volume-glass-glare" />
      </div>

      <div className="draw-volume-readout">
        <span className="draw-volume-remaining mono" data-testid="draw-volume-remaining">
          {meter.remaining.toLocaleString()}
        </span>
        <span className="draw-volume-caption">
          {meter.state === 'empty' ? 'LIMIT' : 'px left'}
        </span>
      </div>
    </aside>
  );
}
