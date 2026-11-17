import React, { useState } from 'react';
import XeroIcon from '../XeroIcon.jsx';

const TUTORIAL_STEPS = [
  {
    emoji: '📡',
    title: '1. Aim & Lock Your Starting Surface',
    body: 'Allow Camera, GPS & Gyroscope so Proof of Location maps your spot (watch the bottom-right scan box reach 100%). Tap the camera view anywhere to lock onto a floor, ledge, wall, or mid-air anchor, then tap + Seed to place your first block.'
  },
  {
    emoji: '🧱',
    title: '2. Sculpt 4x Blocks or Hand Off to AI',
    body: 'Swipe the bottom carousel between Brush (🖌️), Stack (🧱 — hold down to build off faces), and Erase (🧽). Toggle ⚡ Quick mode for an ultra-simple studio or Pro mode for Lock & Scale (✅), Foreground Occlusion (🪞), and Agent Code (📋).'
  },
  {
    emoji: '🚀',
    title: '3. Claim Virtual Land, Chat & Curate',
    body: 'Publish to pin your sculpture to IPFS + mint on Robinhood Chain (5% creator royalty) and claim that 3D Virtual Land parcel! Visitors IRL can view nearby AR glowing bases, unlock parcel-pinned encrypted messages, or join camera-locked chat.'
  }
];

export default function FirstRunTutorialModal({
  quickSculpt,
  onToggleQuickSculpt,
  onClose
}) {
  const [stepIdx, setStepIdx] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const step = TUTORIAL_STEPS[stepIdx];

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="GRAFFILAND Quick Start Guide"
      onClick={() => onClose(dontShowAgain)}
    >
      <div className="modal-card tutorial-card" style={{ maxWidth: 430 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            <XeroIcon emoji={step.emoji} size={22} /> Welcome to GRAFFILAND
          </h3>
          <button
            type="button"
            className="btn"
            onClick={() => onClose(dontShowAgain)}
            aria-label="Close guide"
          >
            <XeroIcon emoji="❌" size={14} />
          </button>
        </div>

        <div className="tutorial-step-pills" role="tablist" aria-label="Tutorial steps">
          {TUTORIAL_STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              role="tab"
              aria-selected={i === stepIdx}
              className={`tutorial-step-pill ${i === stepIdx ? 'active' : ''}`}
              onClick={() => setStepIdx(i)}
            >
              Step {i + 1}
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <XeroIcon emoji={step.emoji} size={20} />
            <strong style={{ fontSize: 14 }}>{step.title}</strong>
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)', margin: 0 }}>
            {step.body}
          </p>
        </div>

        <div
          className="card"
          style={{
            padding: 10,
            marginBottom: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 12 }}>
              <XeroIcon emoji="⚡" size={13} /> Quick Sculpt Mode
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {quickSculpt
                ? 'Simplified HUD: Brush, Stack, Erase, Preview & Publish only.'
                : 'Pro HUD: Full Transform, Occlusion & AI Agent controls enabled.'}
            </div>
          </div>
          <button
            type="button"
            className={`btn ${quickSculpt ? 'btn-primary' : ''}`}
            style={{ fontSize: 11, padding: '5px 10px', flexShrink: 0 }}
            onClick={onToggleQuickSculpt}
          >
            {quickSculpt ? '⚡ Quick ON' : 'Pro HUD'}
          </button>
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--muted)',
            marginBottom: 12,
            cursor: 'pointer'
          }}
        >
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>Don&apos;t show automatically next time (re-open anytime via ❓)</span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button
            type="button"
            className="btn"
            disabled={stepIdx === 0}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
          >
            Back
          </button>
          {stepIdx < TUTORIAL_STEPS.length - 1 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStepIdx((i) => Math.min(TUTORIAL_STEPS.length - 1, i + 1))}
            >
              Next Step →
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onClose(dontShowAgain)}
            >
              <XeroIcon emoji="🖌️" size={15} /> Start Sculpting
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
