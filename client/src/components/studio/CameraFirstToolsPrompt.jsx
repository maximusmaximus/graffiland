import React from 'react';
import XeroIcon from '../XeroIcon.jsx';

export const FIRST_CAMERA_TOOLS = [
  {
    id: 'pencil',
    testId: 'first-tools-btn-draw',
    emoji: '✏️',
    label: 'Draw',
    desc: 'Tap to place & stack blocks'
  },
  {
    id: 'brush',
    testId: 'first-tools-btn-paint',
    emoji: '🖌️',
    label: 'Paint',
    desc: 'Hold & sweep like a spray can'
  },
  {
    id: 'search',
    testId: 'first-tools-btn-search',
    emoji: '🔍',
    label: 'Add 3D Model',
    desc: 'Search & place 3D models'
  }
];

/**
 * Shown once on a user's first entry into the mobile AR camera view.
 * Introduces Draw, Paint, and Add 3D Model visually and lets the user pick
 * any of the three tools to start as soon as AR calibration succeeds.
 */
export default function CameraFirstToolsPrompt({
  calibrationReady = false,
  calibrationProgressPct = 0,
  onSelectTool,
  onDismiss
}) {
  const clampedPct = Math.max(0, Math.min(100, Math.round(Number(calibrationProgressPct) || 0)));

  return (
    <section
      className={`camera-first-tools-card hud-interactive ${
        calibrationReady ? 'is-ready' : 'is-calibrating'
      }`}
      data-testid="camera-first-tools-prompt"
      data-calibration-ready={calibrationReady ? 'true' : 'false'}
      role="region"
      aria-label="Choose a starting AR creation tool"
    >
      <div className="camera-first-tools-head">
        <div className="camera-first-tools-title-wrap">
          <div className="camera-first-tools-title">
            <XeroIcon emoji={calibrationReady ? '✨' : '🎨'} size={14} />
            <span>You can Draw, Paint, or Add a 3D Model</span>
          </div>
          <div
            className={`camera-first-tools-status ${calibrationReady ? 'is-ready' : ''}`}
            data-testid="camera-first-tools-status"
          >
            {calibrationReady
              ? '✅ Calibrated! Tap a tool below to get started:'
              : `📡 Calibrating (${clampedPct}%) — select a tool once calibrated`}
          </div>
        </div>
        {typeof onDismiss === 'function' && (
          <button
            type="button"
            className="camera-first-tools-dismiss"
            data-testid="first-tools-dismiss-btn"
            aria-label="Dismiss starter tools message"
            title="Dismiss"
            onClick={() => onDismiss?.()}
          >
            ✕
          </button>
        )}
      </div>

      <div className="camera-first-tools-grid" role="group" aria-label="Starting creation tools">
        {FIRST_CAMERA_TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`camera-first-tool-tile is-tool-${tool.id} ${
              calibrationReady ? 'is-enabled' : 'is-locked'
            }`}
            data-testid={tool.testId}
            data-tool-id={tool.id}
            disabled={!calibrationReady}
            aria-disabled={!calibrationReady || undefined}
            title={
              calibrationReady
                ? `Start with ${tool.label}: ${tool.desc}`
                : `${tool.label} — unlocks after AR calibration completes`
            }
            onClick={() => {
              if (!calibrationReady) return;
              onSelectTool?.(tool.id);
            }}
          >
            <span className="camera-first-tool-icon" aria-hidden="true">
              <XeroIcon emoji={tool.emoji} size={22} />
            </span>
            <span className="camera-first-tool-label">{tool.label}</span>
            <span className="camera-first-tool-desc">{tool.desc}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
