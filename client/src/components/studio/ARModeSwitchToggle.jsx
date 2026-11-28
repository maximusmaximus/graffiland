import React from 'react';
import XeroIcon from '../XeroIcon.jsx';

const TOOL_META = {
  brush: { emoji: '🖌️', label: 'Brush' },
  pencil: { emoji: '✏️', label: 'Pencil' },
  erase: { emoji: '🧽', label: 'Erase' },
  transform: { emoji: '✅', label: 'Scale' },
  stack: { emoji: '🧱', label: 'Stack' },
  search: { emoji: '🔍', label: '3D Items' },
  undo: { emoji: '↩️', label: 'Undo' },
  clear: { emoji: '🗑️', label: 'Clear' },
  recenter: { emoji: '🧭', label: 'Aim' },
  drafts: { emoji: '💾', label: 'Drafts' },
  publish: { emoji: '🚀', label: 'Publish' }
};

export function resolveToggleToolMeta(toolId) {
  const clean = String(toolId || '').trim().toLowerCase();
  if (clean && clean !== 'preview' && TOOL_META[clean]) {
    return { id: clean, ...TOOL_META[clean] };
  }
  return { id: 'brush', ...TOOL_META.brush };
}

/**
 * Prominent right-edge 2-button AR mode switch so users always see clearly whether
 * they are in Review mode or using their currently selected tool, and can toggle
 * between them with a single thumb tap.
 */
export default function ARModeSwitchToggle({
  mode = 'draw',
  selectedToolId = 'brush',
  onSelectTool,
  onSelectReview
}) {
  const isReview = mode === 'preview';
  const toolMeta = resolveToggleToolMeta(selectedToolId);

  return (
    <div
      className={`ar-mode-switch-toggle${isReview ? ' is-review-active' : ' is-tool-active'}`}
      data-testid="ar-mode-switch-toggle"
      data-active-state={isReview ? 'review' : toolMeta.id}
      role="group"
      aria-label="AR mode switch"
    >
      <button
        type="button"
        className={`ar-mode-switch-btn ar-mode-switch-btn--tool${!isReview ? ' is-active' : ''}`}
        data-testid="ar-mode-toggle-tool"
        data-tool-id={toolMeta.id}
        aria-pressed={!isReview}
        title={`Switch to ${toolMeta.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelectTool?.(toolMeta.id);
        }}
      >
        <span className="ar-mode-switch-icon" aria-hidden="true">
          <XeroIcon emoji={toolMeta.emoji} size={24} />
        </span>
        <span className="ar-mode-switch-label">{toolMeta.label}</span>
      </button>

      <div className="ar-mode-switch-divider" aria-hidden="true" />

      <button
        type="button"
        className={`ar-mode-switch-btn ar-mode-switch-btn--review${isReview ? ' is-active' : ''}`}
        data-testid="ar-mode-toggle-review"
        aria-pressed={isReview}
        title="Switch to Review mode"
        onClick={(e) => {
          e.stopPropagation();
          onSelectReview?.();
        }}
      >
        <span className="ar-mode-switch-icon" aria-hidden="true">
          <XeroIcon emoji="👁️" size={24} />
        </span>
        <span className="ar-mode-switch-label">Review</span>
      </button>
    </div>
  );
}
