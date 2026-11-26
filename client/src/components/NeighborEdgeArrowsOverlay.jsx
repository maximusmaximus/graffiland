import React from 'react';

function ArrowGlyph({ deg }) {
  return (
    <span
      className="neighbor-edge-arrow-cap"
      aria-hidden="true"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        className="neighbor-edge-arrow-svg"
        style={{ transform: `rotate(${deg}deg)` }}
      >
        <path
          d="M2.5 8H12.2M8.8 3.8L13.2 8L8.8 12.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function buildArrowheadPoints(fromX, fromY, targetX, targetY) {
  const dx = targetX - fromX;
  const dy = targetY - fromY;
  const len = Math.hypot(dx, dy);
  if (len < 9) return '';
  const angle = Math.atan2(dy, dx);
  const tipOffset = 3.2;
  const tipX = targetX - tipOffset * Math.cos(angle);
  const tipY = targetY - tipOffset * Math.sin(angle);
  const headLen = 6.8;
  const spread = 0.45;
  const x1 = tipX - headLen * Math.cos(angle - spread);
  const y1 = tipY - headLen * Math.sin(angle - spread);
  const x2 = tipX - headLen * Math.cos(angle + spread);
  const y2 = tipY - headLen * Math.sin(angle + spread);
  return `${tipX.toFixed(1)},${tipY.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

/**
 * Renders clickable tags for other lands & sculptures:
 * - On-screen targets (desktop views) render cleanly near their location with a
 *   same-color SVG leader line + arrowhead + anchor dot pointing to that location.
 * - Off-screen targets stay pinned to the viewport edges with directional arrows
 *   so the user can still click them and navigate directly to them.
 */
export default function NeighborEdgeArrowsOverlay({
  arrows = [],
  viewportWidth = 0,
  viewportHeight = 0,
  className = '',
  onSelectParcel = null,
  onSelectSculpture = null
}) {
  if (!Array.isArray(arrows) || arrows.length === 0) return null;

  const stopPropagation = (e) => {
    e.stopPropagation();
  };

  const onScreenLeaders = arrows.filter(
    (item) =>
      item?.placement === 'on-screen' &&
      Number.isFinite(Number(item.fromX)) &&
      Number.isFinite(Number(item.fromY)) &&
      Number.isFinite(Number(item.targetX)) &&
      Number.isFinite(Number(item.targetY))
  );

  const vw = Number(viewportWidth) || 0;
  const vh = Number(viewportHeight) || 0;

  return (
    <div
      className={`neighbor-edge-arrows-layer ${className}`.trim()}
      data-testid="neighbor-edge-arrows-layer"
      onPointerDown={stopPropagation}
      onTouchStart={stopPropagation}
      onMouseDown={stopPropagation}
    >
      {onScreenLeaders.length > 0 && (
        <svg
          className="neighbor-edge-leaders-svg"
          data-testid="neighbor-tag-leaders-svg"
          viewBox={vw > 0 && vh > 0 ? `0 0 ${vw} ${vh}` : undefined}
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          {onScreenLeaders.map((item) => {
            const key = item.id || item.parcelId || item.sculptureId;
            const color =
              item.accentColor || (item.kind === 'sculpture' ? '#00f5d4' : '#ffb703');
            const dotColor =
              item.dotColor || (item.kind === 'sculpture' ? '#eafffc' : '#fff3c4');
            const headPts = buildArrowheadPoints(
              item.fromX,
              item.fromY,
              item.targetX,
              item.targetY
            );
            const dash = item.isPendingPreview ? '5 4' : undefined;

            return (
              <g
                key={key}
                data-testid="neighbor-tag-leader-line"
                data-kind={item.kind || 'land'}
                data-parcel-id={item.parcelId || undefined}
                data-sculpture-id={item.sculptureId || undefined}
                data-line-color={color}
                data-target-x={item.targetX}
                data-target-y={item.targetY}
              >
                <line
                  x1={item.fromX}
                  y1={item.fromY}
                  x2={item.targetX}
                  y2={item.targetY}
                  stroke="rgba(4, 10, 20, 0.84)"
                  strokeWidth="3.4"
                  strokeLinecap="round"
                  strokeDasharray={dash}
                />
                <line
                  x1={item.fromX}
                  y1={item.fromY}
                  x2={item.targetX}
                  y2={item.targetY}
                  stroke={color}
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeDasharray={dash}
                />
                {headPts && <polygon points={headPts} fill={color} />}
                <circle
                  cx={item.targetX}
                  cy={item.targetY}
                  r="4.2"
                  fill="rgba(4, 10, 20, 0.84)"
                />
                <circle
                  cx={item.targetX}
                  cy={item.targetY}
                  r="2.8"
                  fill={dotColor}
                  stroke={color}
                  strokeWidth="1.4"
                />
              </g>
            );
          })}
        </svg>
      )}

      {arrows.map((item) => {
        const isOnScreen = item.placement === 'on-screen';
        const isSculpture = item.kind === 'sculpture';
        const accentColor = item.accentColor || (isSculpture ? '#00f5d4' : '#ffb703');
        const textColor = item.textColor || (isSculpture ? '#d9fff9' : '#fff3c4');

        const arrowOnLeft =
          !isOnScreen &&
          (item.side === 'left' ||
            ((item.side === 'top' || item.side === 'bottom') &&
              Math.cos((item.arrowDeg * Math.PI) / 180) < -0.15));

        const inset = Number.isFinite(Number(item.edgeInsetX)) ? Number(item.edgeInsetX) : 6;
        const posStyle = isOnScreen
          ? { left: `${item.x}px`, top: `${item.y}px` }
          : item.side === 'left'
            ? { left: `${inset}px`, top: `${item.y}px` }
            : item.side === 'right'
              ? { right: `${inset}px`, top: `${item.y}px` }
              : { left: `${item.x}px`, top: `${item.y}px` };

        const btnStyle = {
          ...posStyle,
          '--tag-accent': accentColor,
          '--tag-text': textColor
        };

        const itemKey = item.id || item.parcelId || item.sculptureId;
        const ariaLabel = isSculpture
          ? `Select sculpture ${item.fullLabel}${
              item.distanceLabel ? `, ${item.distanceLabel} away` : ''
            }`
          : `Select neighboring land ${item.fullLabel}${
              item.distanceLabel ? `, ${item.distanceLabel} away` : ''
            }`;

        return (
          <button
            key={itemKey}
            type="button"
            className={`neighbor-edge-arrow-btn ${
              isOnScreen
                ? 'is-on-screen'
                : `is-${item.side} ${arrowOnLeft ? 'has-arrow-left' : 'has-arrow-right'}`
            } ${isSculpture ? 'is-sculpture' : 'is-land'}`}
            data-testid="neighbor-edge-arrow"
            data-kind={item.kind || 'land'}
            data-placement={isOnScreen ? 'on-screen' : 'edge'}
            data-tag-color={accentColor}
            data-parcel-id={item.parcelId || undefined}
            data-sculpture-id={item.sculptureId || undefined}
            data-edge-side={item.side}
            data-arrow-deg={item.arrowDeg}
            style={btnStyle}
            aria-label={ariaLabel}
            title={`Jump to ${item.fullLabel}${
              item.distanceLabel ? ` (${item.distanceLabel})` : ''
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (isSculpture) {
                onSelectSculpture?.(item.sculpture);
              } else {
                onSelectParcel?.(item.parcel);
              }
            }}
          >
            {isOnScreen ? (
              <span className="neighbor-edge-arrow-body is-on-screen">
                <span className="neighbor-onscreen-dot" aria-hidden="true" />
                <span className="neighbor-edge-arrow-name">{item.label}</span>
                {item.distanceLabel && (
                  <span className="neighbor-edge-arrow-dist mono">{` ${item.distanceLabel}`}</span>
                )}
              </span>
            ) : (
              <>
                {arrowOnLeft && <ArrowGlyph deg={item.arrowDeg} />}
                <span className="neighbor-edge-arrow-body">
                  <span className="neighbor-edge-arrow-name">{item.label}</span>
                  {item.distanceLabel && (
                    <span className="neighbor-edge-arrow-dist mono">{` ${item.distanceLabel}`}</span>
                  )}
                </span>
                {!arrowOnLeft && <ArrowGlyph deg={item.arrowDeg} />}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
