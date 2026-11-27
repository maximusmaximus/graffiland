import React, { useEffect, useRef } from 'react';
import {
  BLOCK_SIZE_PRESETS,
  STANDARD_COLOR_PRESETS,
  normalizeBlockScale
} from '../../../../shared/voxelStroke.mjs';
import XeroIcon from '../XeroIcon.jsx';

const REACH_PRESETS = [0.8, 1.2, 1.8, 2.4, 3.0];

/**
 * Paint & Brush Kit Palette (Block Size, Preset Colors, Finish & Reach).
 * Tool selection (Brush, Pencil, Stack, Eraser, etc.) lives exclusively in the
 * bottom-center swipe menu (ToolCarouselBar). When open, this palette floats
 * cleanly above the center tool button so the selected tool remains visible,
 * and clicking/tapping anywhere off the kit minimizes it back to its icon.
 */
export default function StudioDockDrawer({
  dockOpen,
  onToggleDock,
  onCloseDock = null,
  tool,
  onOpenBrushGuide = null,
  blockSize = 1,
  setBlockSize = null,
  color,
  setColor,
  material,
  setMaterial,
  reachMeters,
  setReachMeters
}) {
  const toggleBtnRef = useRef(null);
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!dockOpen) return undefined;
    let dismissed = false;
    const closeKit = () => {
      if (dismissed) return;
      dismissed = true;
      if (onCloseDock) {
        onCloseDock();
      } else {
        onToggleDock?.();
      }
    };
    const handleOutsideInteraction = (ev) => {
      const target = ev.target;
      if (
        (popoverRef.current && popoverRef.current.contains(target)) ||
        (toggleBtnRef.current && toggleBtnRef.current.contains(target))
      ) {
        return;
      }
      closeKit();
    };
    const handleKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        closeKit();
      }
    };
    document.addEventListener('pointerdown', handleOutsideInteraction, true);
    document.addEventListener('mousedown', handleOutsideInteraction, true);
    document.addEventListener('click', handleOutsideInteraction, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true);
      document.removeEventListener('mousedown', handleOutsideInteraction, true);
      document.removeEventListener('click', handleOutsideInteraction, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [dockOpen, onCloseDock, onToggleDock]);

  const activeScale = normalizeBlockScale(blockSize);
  const activeSizePreset =
    BLOCK_SIZE_PRESETS.find((p) => Math.abs(p.scale - activeScale) < 0.05) || BLOCK_SIZE_PRESETS[1];
  const activeToolHint =
    tool === 'erase'
      ? 'Eraser active below · tap or hold blocks to erase'
      : tool === 'pencil'
      ? 'Pencil active below · tap blocks to replace or stack'
      : tool === 'stack'
      ? 'Stack active below · hold to stack onto block faces'
      : 'Brush active below · hold & sweep like a spray can';

  const handleMinimize = () => {
    if (onCloseDock) {
      onCloseDock();
    } else {
      onToggleDock?.();
    }
  };

  return (
    <>
      <button
        ref={toggleBtnRef}
        type="button"
        className={`floating-tools-toggle palette-fab-btn ${dockOpen ? 'is-open' : ''}`}
        data-testid="palette-options-toggle"
        onClick={onToggleDock}
        aria-expanded={dockOpen}
        aria-label={dockOpen ? 'Minimize paint and brush kit' : 'Open paint and brush kit'}
        title={`Paint & Brush Kit · Size ${activeSizePreset.label} · Color ${color}`}
      >
        {dockOpen ? (
          <XeroIcon emoji="✖️" size={18} />
        ) : (
          <>
            <XeroIcon emoji="🎨" size={22} />
            <span
              className="palette-fab-color-dot"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
            <span className="palette-fab-size-tag" aria-hidden="true">
              {activeSizePreset.label}
            </span>
          </>
        )}
      </button>

      {dockOpen && (
        <div
          ref={popoverRef}
          className="brush-options-popover hud-interactive"
          data-testid="brush-options-popup"
          role="dialog"
          aria-label="Paint and Brush Kit"
        >
          <div className="brush-opt-header">
            <div className="brush-opt-title-group">
              <span className="brush-opt-title">
                <XeroIcon emoji="🎨" size={13} /> Paint &amp; Brush Kit
              </span>
              <span className="brush-opt-mode-hint">{activeToolHint}</span>
            </div>
            <div className="brush-opt-header-actions">
              {tool === 'brush' && onOpenBrushGuide && (
                <button
                  type="button"
                  className="brush-opt-help-btn"
                  data-testid="palette-brush-guide-btn"
                  aria-label="How to use Spray Brush"
                  title="How to use Spray Brush"
                  onClick={onOpenBrushGuide}
                >
                  ?
                </button>
              )}
              <button
                type="button"
                className="brush-opt-min-btn"
                data-testid="palette-minimize-btn"
                aria-label="Minimize paint and brush kit"
                title="Minimize to icon"
                onClick={handleMinimize}
              >
                <XeroIcon emoji="➖" size={11} />
              </button>
            </div>
          </div>

          {/* Block Size Selector */}
          <div className="brush-opt-section">
            <div className="brush-opt-label-row">
              <span>Block Size</span>
              <strong className="mono">{activeSizePreset.hint}</strong>
            </div>
            <div className="brush-size-grid" role="group" aria-label="Block size presets">
              {BLOCK_SIZE_PRESETS.map((preset) => {
                const isSelected = Math.abs(preset.scale - activeScale) < 0.05;
                const boxPx = Math.round(8 + preset.scale * 5);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`brush-size-pill ${isSelected ? 'active' : ''}`}
                    data-testid={`block-size-${preset.id}`}
                    aria-pressed={isSelected}
                    title={preset.hint}
                    onClick={() => setBlockSize?.(preset.scale)}
                  >
                    <span
                      className="brush-size-cube"
                      style={{ width: boxPx, height: boxPx, backgroundColor: color }}
                      aria-hidden="true"
                    />
                    <span className="brush-size-label">{preset.label}</span>
                    <span className="brush-size-scale">{preset.scale}×</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Standard Preset Colors */}
          <div className="brush-opt-section">
            <div className="brush-opt-label-row">
              <span>Preset Colors</span>
              <span className="mono">{color}</span>
            </div>
            <div className="brush-color-grid" role="group" aria-label="Standard preset colors">
              {STANDARD_COLOR_PRESETS.map((preset) => {
                const isSelected = String(color || '').toLowerCase() === preset.hex.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    className={`swatch brush-color-swatch ${isSelected ? 'active' : ''}`}
                    style={{ backgroundColor: preset.hex }}
                    aria-label={`Color ${preset.name}`}
                    aria-pressed={isSelected}
                    title={`${preset.name} (${preset.hex})`}
                    onClick={() => setColor?.(preset.hex)}
                  />
                );
              })}
            </div>
          </div>

          {/* Finish & Reach */}
          <div className="brush-opt-footer-grid">
            <div className="brush-opt-mini-group">
              <span className="brush-opt-mini-label">Finish</span>
              <div className="brush-opt-pill-row">
                {[
                  { id: 'matte', emoji: '🎨', label: 'Matte' },
                  { id: 'neon', emoji: '✨', label: 'Neon' },
                  { id: 'glass', emoji: '🧊', label: 'Glass' }
                ].map((fin) => (
                  <button
                    key={fin.id}
                    type="button"
                    className={`brush-mini-pill ${material === fin.id ? 'active' : ''}`}
                    aria-pressed={material === fin.id}
                    onClick={() => setMaterial?.(fin.id)}
                  >
                    <XeroIcon emoji={fin.emoji} size={12} /> {fin.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="brush-opt-mini-group">
              <span className="brush-opt-mini-label">Reach ({reachMeters}m)</span>
              <div className="brush-opt-pill-row">
                {REACH_PRESETS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`brush-mini-pill ${Math.abs(Number(reachMeters) - r) < 0.15 ? 'active' : ''}`}
                    aria-pressed={Math.abs(Number(reachMeters) - r) < 0.15}
                    onClick={() => setReachMeters?.(r)}
                  >
                    {r}m
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
