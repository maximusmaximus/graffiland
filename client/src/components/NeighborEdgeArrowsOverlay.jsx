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

/**
 * Renders clickable viewport-edge directional arrow labels pointing from the
 * currently focused land toward selectable neighboring lands.
 */
export default function NeighborEdgeArrowsOverlay({
  arrows = [],
  onSelectParcel = null
}) {
  if (!Array.isArray(arrows) || arrows.length === 0) return null;

  const stopPropagation = (e) => {
    e.stopPropagation();
  };

  return (
    <div
      className="neighbor-edge-arrows-layer"
      data-testid="neighbor-edge-arrows-layer"
      onPointerDown={stopPropagation}
      onTouchStart={stopPropagation}
      onMouseDown={stopPropagation}
    >
      {arrows.map((item) => {
        const arrowOnLeft =
          item.side === 'left' ||
          ((item.side === 'top' || item.side === 'bottom') && Math.cos((item.arrowDeg * Math.PI) / 180) < -0.15);

        const inset = Number.isFinite(Number(item.edgeInsetX)) ? Number(item.edgeInsetX) : 6;
        const posStyle =
          item.side === 'left'
            ? { left: `${inset}px`, top: `${item.y}px` }
            : item.side === 'right'
              ? { right: `${inset}px`, top: `${item.y}px` }
              : { left: `${item.x}px`, top: `${item.y}px` };

        return (
          <button
            key={item.parcelId}
            type="button"
            className={`neighbor-edge-arrow-btn is-${item.side} ${
              arrowOnLeft ? 'has-arrow-left' : 'has-arrow-right'
            }`}
            data-testid="neighbor-edge-arrow"
            data-parcel-id={item.parcelId}
            data-edge-side={item.side}
            data-arrow-deg={item.arrowDeg}
            style={posStyle}
            aria-label={`Select neighboring land ${item.fullLabel}${
              item.distanceLabel ? `, ${item.distanceLabel} away` : ''
            }`}
            title={`Jump to ${item.fullLabel}${
              item.distanceLabel ? ` (${item.distanceLabel})` : ''
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onSelectParcel?.(item.parcel);
            }}
          >
            {arrowOnLeft && <ArrowGlyph deg={item.arrowDeg} />}
            <span className="neighbor-edge-arrow-body">
              <span className="neighbor-edge-arrow-name">{item.label}</span>
              {item.distanceLabel && (
                <span className="neighbor-edge-arrow-dist mono">{` ${item.distanceLabel}`}</span>
              )}
            </span>
            {!arrowOnLeft && <ArrowGlyph deg={item.arrowDeg} />}
          </button>
        );
      })}
    </div>
  );
}
