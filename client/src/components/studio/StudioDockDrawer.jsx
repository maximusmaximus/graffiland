import React from 'react';
import {
  BLOCK_SIZE_PRESETS,
  STANDARD_COLOR_PRESETS,
  normalizeBlockScale
} from '../../../../shared/voxelStroke.mjs';
import XeroIcon from '../XeroIcon.jsx';

const REACH_PRESETS = [1.2, 1.8, 2.4, 3.0];

/**
 * Bottom-right Brush, Pencil & Eraser Options Palette.
 * Core studio/canvas features live in the bottom-center swipe menu (ToolCarouselBar),
 * while this dedicated palette exposes quick switching between Brush (fluid spray can),
 * Pencil (single-block place/stack/replace), and Eraser, plus block size, standard colors,
 * material finish, and reach distance.
 */
export default function StudioDockDrawer({
  dockOpen,
  onToggleDock,
  mode,
  tool,
  onSelectDrawTool = null,
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
  const activeScale = normalizeBlockScale(blockSize);
  const activeSizePreset =
    BLOCK_SIZE_PRESETS.find((p) => Math.abs(p.scale - activeScale) < 0.05) || BLOCK_SIZE_PRESETS[1];
  const activeToolLabel =
    tool === 'erase' ? 'Eraser' : tool === 'pencil' ? 'Pencil' : 'Brush';
  const activeToolHint =
    tool === 'erase'
      ? 'Tap or hold on blocks to erase'
      : tool === 'pencil'
      ? 'Tap blocks to replace · move phone to stack'
      : 'Hold & sweep phone like a spray can';

  return (
    <>
      <button
        type="button"
        className={`floating-tools-toggle palette-fab-btn ${dockOpen ? 'is-open' : ''}`}
        data-testid="palette-options-toggle"
        onClick={onToggleDock}
        aria-expanded={dockOpen}
        aria-label={dockOpen ? 'Close brush, pencil & eraser options' : 'Brush, pencil & eraser options'}
        title={`${activeToolLabel} options · Size ${activeSizePreset.label} · Color ${color}`}
      >
        {dockOpen ? (
          <XeroIcon emoji="✖️" size={18} />
        ) : (
          <>
            <XeroIcon emoji={tool === 'erase' ? '🧽' : '🎨'} size={22} />
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
          className="brush-options-popover hud-interactive"
          data-testid="brush-options-popup"
          role="dialog"
          aria-label="Brush, Pencil & Eraser Options"
        >
          <div className="brush-opt-header is-stacked">
            <div className="brush-opt-tool-switch" role="group" aria-label="Draw mode">
              <button
                type="button"
                className={`brush-opt-mode-btn ${mode === 'draw' && tool === 'brush' ? 'active' : ''}`}
                data-testid="palette-select-brush"
                onClick={() => onSelectDrawTool?.('brush')}
              >
                <XeroIcon emoji="🖌️" size={13} /> Brush
              </button>
              <button
                type="button"
                className={`brush-opt-mode-btn ${mode === 'draw' && tool === 'pencil' ? 'active' : ''}`}
                data-testid="palette-select-pencil"
                onClick={() => onSelectDrawTool?.('pencil')}
              >
                <XeroIcon emoji="✏️" size={13} /> Pencil
              </button>
              <button
                type="button"
                className={`brush-opt-mode-btn is-eraser ${mode === 'draw' && tool === 'erase' ? 'active' : ''}`}
                data-testid="palette-select-erase"
                onClick={() => onSelectDrawTool?.('erase')}
              >
                <XeroIcon emoji="🧽" size={13} /> Eraser
              </button>
            </div>
            <div className="brush-opt-hint-row">
              <span className="brush-opt-mode-hint">{activeToolHint}</span>
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
