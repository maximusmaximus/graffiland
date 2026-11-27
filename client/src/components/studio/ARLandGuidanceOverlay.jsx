import React from 'react';
import { AR_MAX_VISIBLE_DISTANCE_FEET } from '../../../../shared/constants.mjs';
import { formatDistanceMeters, resolveLandCoords } from '../../utils/landMapHelpers.js';
import { useMeasurementUnits } from '../../utils/measurementUnits.js';

function ChevronSvg({ direction = 'right' }) {
  const rotation =
    direction === 'left'
      ? 180
      : direction === 'top'
      ? -90
      : direction === 'bottom'
      ? 90
      : 0;
  return (
    <svg
      className="ar-guide-chevron-svg"
      viewBox="0 0 24 24"
      width="26"
      height="26"
      aria-hidden="true"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path
        d="M8.5 4.5 L16.5 12 L8.5 19.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Live AR directional guidance & proximity-sharpness HUD overlay for a selected nearby land.
 * - Off-screen: shows blinking cascading directional chevron arrows on the exact screen edge
 *   guiding the user to move/turn their phone camera toward the land.
 * - In-view: hides off-screen arrows and shows clear loading status + live sharpness readout
 *   that sharpens to Ultra-Sharp as the user walks closer.
 */
export default function ARLandGuidanceOverlay({
  land,
  guidance,
  loadState = null,
  hasBottomInspector = true
}) {
  const { unitSystem } = useMeasurementUnits(null, resolveLandCoords(land));
  if (!land) return null;

  if (land.outOfArRange) {
    const outName = land.displayName || 'Virtual Land';
    const outDist = Number.isFinite(Number(land.edgeDistanceMeters ?? land.distanceMeters))
      ? formatDistanceMeters(land.edgeDistanceMeters ?? land.distanceMeters, unitSystem)
      : land.distanceLabel || '';
    return (
      <div
        className={`ar-guidance-stage ${hasBottomInspector ? 'has-inspector' : ''}`}
        data-testid="ar-land-out-of-range-overlay"
        data-out-of-range="true"
        aria-live="polite"
      >
        <div className="ar-in-view-pill is-tier-distant" data-testid="ar-land-out-of-range-badge">
          <div className="ar-in-view-head">
            <span className="ar-in-view-dot" aria-hidden="true" />
            <span className="ar-in-view-title">{outName}</span>
            {outDist && <span className="ar-in-view-dist mono">{outDist}</span>}
          </div>
          <div className="ar-sharpness-label mono" style={{ marginTop: 4 }}>
            Walk within {AR_MAX_VISIBLE_DISTANCE_FEET} ft to view in AR camera
          </div>
        </div>
      </div>
    );
  }

  if (!guidance) return null;

  const displayName = guidance.displayName || land.displayName || 'Nearby Land';
  const distText = land.isInside
    ? 'Inside'
    : Number.isFinite(Number(guidance.distanceMeters))
    ? formatDistanceMeters(guidance.distanceMeters, unitSystem)
    : land.distanceLabel || 'Nearby';

  const isLoading =
    loadState &&
    loadState.parcelId === land.parcelId &&
    loadState.status === 'loading';

  const edge = guidance.edge || 'right';
  const isVerticalEdge = edge === 'top' || edge === 'bottom';
  const chevrons = [0, 1, 2];

  // For left/top, reverse visual wave order so the blink travels outward toward the edge
  const orderedChevrons = edge === 'left' || edge === 'top' ? [2, 1, 0] : chevrons;

  const sharpnessPct = Number.isFinite(Number(guidance.sharpnessPct))
    ? guidance.sharpnessPct
    : 100;
  const tier = guidance.tier || 'sharp';
  const tierLabel = guidance.tierLabel || 'Sharp';

  return (
    <div
      className={`ar-guidance-stage ${hasBottomInspector ? 'has-inspector' : ''}`}
      data-testid="ar-land-guidance-overlay"
      data-in-view={guidance.inView ? 'true' : 'false'}
      data-edge={edge}
      aria-live="polite"
    >
      {!guidance.inView ? (
        <div
          className={`ar-guide-beacon is-edge-${edge}`}
          data-testid="ar-land-guide-arrows"
          data-direction={edge}
          data-angle-deg={guidance.angleDeg}
        >
          {(edge === 'left' || edge === 'top') && (
            <div
              className={`ar-guide-chevrons ${isVerticalEdge ? 'is-vertical' : 'is-horizontal'}`}
              aria-hidden="true"
            >
              {orderedChevrons.map((delayIdx, i) => (
                <span
                  key={i}
                  className="ar-guide-chevron-step"
                  style={{ animationDelay: `${delayIdx * 0.16}s` }}
                >
                  <ChevronSvg direction={edge} />
                </span>
              ))}
            </div>
          )}

          <div className="ar-guide-pill" data-testid="ar-land-guide-pill">
            <div className="ar-guide-pill-top">
              <span className="ar-guide-pill-title-wrap">
                <span
                  className={`ar-guide-live-dot ${land.isInside ? 'is-inside' : ''}`}
                  aria-hidden="true"
                />
                <span className="ar-guide-land-name">{displayName}</span>
              </span>
              <span className={`ar-guide-land-dist mono ${land.isInside ? 'is-inside' : ''}`}>
                {distText}
              </span>
            </div>
            <div className="ar-guide-pill-cue">
              <span className="ar-guide-instruction">{guidance.instruction}</span>
              {Number(guidance.turnDegrees || 0) > 0 && (
                <span className="mono ar-guide-angle">{guidance.turnDegrees}°</span>
              )}
            </div>
          </div>

          {(edge === 'right' || edge === 'bottom') && (
            <div
              className={`ar-guide-chevrons ${isVerticalEdge ? 'is-vertical' : 'is-horizontal'}`}
              aria-hidden="true"
            >
              {orderedChevrons.map((delayIdx, i) => (
                <span
                  key={i}
                  className="ar-guide-chevron-step"
                  style={{ animationDelay: `${delayIdx * 0.16}s` }}
                >
                  <ChevronSvg direction={edge} />
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          className={`ar-in-view-pill is-tier-${tier} ${isLoading ? 'is-loading' : ''}`}
          data-testid="ar-land-in-view-badge"
          data-sharpness-pct={sharpnessPct}
          data-sharpness-tier={tier}
        >
          <div className="ar-in-view-head">
            <span className="ar-in-view-dot" aria-hidden="true" />
            <span className="ar-in-view-title">
              {isLoading ? `Loading ${displayName}…` : displayName}
            </span>
            <span className="ar-in-view-dist mono">{distText}</span>
          </div>
          <div className="ar-in-view-sharpness" data-testid="ar-land-sharpness-meter">
            <span className="ar-sharpness-track" aria-hidden="true">
              <span
                className="ar-sharpness-fill"
                style={{ width: `${Math.max(12, Math.min(100, sharpnessPct))}%` }}
              />
            </span>
            <span className="ar-sharpness-label mono">
              {isLoading
                ? 'Hydrating 3D…'
                : tier === 'ultra'
                ? '✨ Ultra-Sharp'
                : `${tierLabel} ${sharpnessPct}% · Move closer`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
