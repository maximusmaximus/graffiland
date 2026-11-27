import React from 'react';
import { KEY_CAROUSEL_SLOT_PX, KEY_TOOLS } from '../../hooks/useVoxelBrush.js';
import XeroIcon from '../XeroIcon.jsx';

export default function ToolCarouselBar({
  activeKeyTool,
  toolAvailability,
  canTouch,
  swipeDragPx,
  isDraggingKey,
  painting,
  mode,
  dockOpen,
  voxelsLength,
  placedCatalogItem = null,
  artTransform,
  onSetArtTransform,
  onToggleTransformLock,
  onStepKeyTool,
  onKeyPointerDown,
  onKeyPointerMove,
  onKeyPointerUp,
  onKeyPointerCancel
}) {
  const visibleTools = KEY_TOOLS;
  const idx = visibleTools.findIndex((t) => t.id === activeKeyTool);
  const safeIdx = idx >= 0 ? idx : 0;
  const activeItem = visibleTools[safeIdx] || visibleTools[0];
  const slots = [-2, -1, 0, 1, 2];
  const activeAvail = toolAvailability[activeItem.id] || { usable: true, reason: '' };
  const activeUnavailable = !activeAvail.usable;

  return (
    <>
      <div className="key-carousel hud-interactive" data-testid="key-carousel">
        <div className={`key-tool-caption ${activeUnavailable ? 'is-unavailable' : ''}`}>
          <XeroIcon emoji={activeUnavailable ? '🔒' : '🔑'} size={12} />
          <span>{activeItem.label}</span>
          <span className="key-tool-hint">
            {activeUnavailable
              ? '· Tap for fix'
              : activeAvail.needsAuth
              ? '· Tap to sign in'
              : canTouch
              ? '· Swipe'
              : '· Arrows / Swipe'}
          </span>
        </div>
        <div className="key-carousel-row">
          {!canTouch && (
            <button
              type="button"
              className="key-arrow-btn"
              onClick={() => onStepKeyTool(-1, { visibleTools })}
              aria-label="Previous tool"
              title="Previous tool"
            >
              <XeroIcon emoji="◀️" size={13} />
            </button>
          )}

          <div
            className={`key-carousel-track ${isDraggingKey ? 'dragging' : ''}`}
            onPointerDown={onKeyPointerDown}
            onPointerMove={(e) => onKeyPointerMove(e, visibleTools)}
            onPointerUp={(e) => onKeyPointerUp(e, visibleTools)}
            onPointerCancel={onKeyPointerCancel}
            onContextMenu={(e) => e.preventDefault()}
            role="group"
            aria-label="Fluid bottom tool switcher (swipe left or right)"
          >
            {slots.map((rel) => {
              const toolIdx =
                (((safeIdx + rel) % visibleTools.length) + visibleTools.length) % visibleTools.length;
              const item = visibleTools[toolIdx];
              const itemAvail = toolAvailability[item.id] || { usable: true, reason: '' };
              const isUnavailable = !itemAvail.usable;
              const offsetPx = rel * KEY_CAROUSEL_SLOT_PX + swipeDragPx;
              const distNorm = Math.min(2, Math.abs(offsetPx) / KEY_CAROUSEL_SLOT_PX);
              const scale = Math.max(0.46, 1 - distNorm * 0.34);
              const opacity = Math.max(0.16, 1 - distNorm * 0.44);
              const isCenterSlot = rel === 0;
              return (
                <button
                  key={`${rel}-${item.id}`}
                  type="button"
                  data-tool-rel={rel}
                  data-tool-id={item.id}
                  data-testid={isCenterSlot ? `key-slot-center-${item.id}` : `key-slot-${item.id}`}
                  aria-disabled={isUnavailable || undefined}
                  className={`key-slot-btn ${isCenterSlot ? `is-center tool-${item.id} ${painting ? 'painting' : ''}` : 'is-neighbor'} ${isUnavailable ? 'is-unavailable' : ''}`}
                  style={{
                    transform: `translate(-50%, -50%) translateX(${offsetPx}px) scale(${scale})`,
                    opacity: isUnavailable ? opacity * 0.44 : opacity,
                    zIndex: isCenterSlot ? 4 : 3 - Math.abs(rel),
                    transition: isDraggingKey
                      ? 'none'
                      : 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease'
                  }}
                  aria-label={
                    isCenterSlot
                      ? `${item.label} tool button (${isUnavailable ? itemAvail.reason : item.hint})`
                      : `Switch to ${item.label}${isUnavailable ? ` — ${itemAvail.reason}` : ''}`
                  }
                  title={isUnavailable ? itemAvail.reason : item.hint}
                >
                  <XeroIcon emoji={item.emoji} size={28} />
                </button>
              );
            })}
          </div>

          {!canTouch && (
            <button
              type="button"
              className="key-arrow-btn"
              onClick={() => onStepKeyTool(1, { visibleTools })}
              aria-label="Next tool"
              title="Next tool"
            >
              <XeroIcon emoji="▶️" size={13} />
            </button>
          )}
        </div>
      </div>

      {mode === 'transform' && (
        <div
          className={`transform-bar hud-interactive ${dockOpen ? 'with-dock' : ''}`}
          role="region"
          aria-label="Scale and transform art piece"
        >
          <div className="transform-bar-top">
            <span className="transform-bar-title">
              <XeroIcon emoji="📐" size={14} />
              <span>
                {placedCatalogItem
                  ? `Scale ${placedCatalogItem.title}${voxelsLength > 0 ? ` (+${voxelsLength})` : ''}`
                  : `Lock & Scale (${voxelsLength})`}
              </span>
            </span>
            <button
              type="button"
              className="transform-done-btn"
              onClick={onToggleTransformLock}
              title="Confirm transform & return to drawing mode"
            >
              <XeroIcon emoji="✅" size={14} />
              <span>Draw</span>
            </button>
          </div>

          <div className="transform-nudge-row">
            <button
              type="button"
              className="transform-chip-btn"
              onClick={() =>
                onSetArtTransform((p) => ({ ...p, offsetY: Number((p.offsetY - 0.1).toFixed(2)) }))
              }
              title="Lower art (-10cm)"
            >
              -Y
            </button>
            <button
              type="button"
              className="transform-chip-btn"
              onClick={() =>
                onSetArtTransform((p) => ({ ...p, offsetY: Number((p.offsetY + 0.1).toFixed(2)) }))
              }
              title="Raise art (+10cm)"
            >
              +Y
            </button>
            <button
              type="button"
              className="transform-chip-btn"
              onClick={() =>
                onSetArtTransform((p) => ({ ...p, offsetZ: Number((p.offsetZ + 0.15).toFixed(2)) }))
              }
              title="Bring closer"
            >
              Near
            </button>
            <button
              type="button"
              className="transform-chip-btn"
              onClick={() =>
                onSetArtTransform((p) => ({ ...p, offsetZ: Number((p.offsetZ - 0.15).toFixed(2)) }))
              }
              title="Push further"
            >
              Far
            </button>
            <button
              type="button"
              className="transform-chip-btn"
              onClick={() =>
                onSetArtTransform({
                  scale: 1,
                  rotYDeg: 0,
                  rotZDeg: 0,
                  offsetX: 0,
                  offsetY: 0,
                  offsetZ: 0
                })
              }
              title="Reset transform"
            >
              Reset
            </button>
            <span className="transform-gesture-note">2-finger twist = Z</span>
          </div>

          <div className="transform-sliders">
            <label className="transform-slider-field">
              <span>
                <XeroIcon emoji="🔍" size={12} /> {artTransform.scale.toFixed(2)}x
              </span>
              <input
                type="range"
                min={0.25}
                max={2}
                step={0.05}
                value={artTransform.scale}
                onChange={(e) =>
                  onSetArtTransform((p) => ({ ...p, scale: Number(e.target.value) }))
                }
                data-testid="transform-scale-slider"
                aria-label="Scale sculpture"
              />
            </label>

            <label className="transform-slider-field">
              <span>
                <XeroIcon emoji="🔄" size={12} /> Y {artTransform.rotYDeg || 0}°
              </span>
              <input
                type="range"
                min={-180}
                max={180}
                step={2}
                value={artTransform.rotYDeg || 0}
                onChange={(e) =>
                  onSetArtTransform((p) => ({ ...p, rotYDeg: Number(e.target.value) }))
                }
                data-testid="transform-roty-slider"
                aria-label="Rotate sculpture Y axis"
              />
            </label>

            <label className="transform-slider-field">
              <span>
                <XeroIcon emoji="🌀" size={12} /> Z {artTransform.rotZDeg || 0}°
              </span>
              <input
                type="range"
                min={-180}
                max={180}
                step={2}
                value={artTransform.rotZDeg || 0}
                onChange={(e) =>
                  onSetArtTransform((p) => ({ ...p, rotZDeg: Number(e.target.value) }))
                }
                data-testid="transform-rotz-slider"
                aria-label="Rotate sculpture Z axis"
              />
            </label>
          </div>
        </div>
      )}
    </>
  );
}
