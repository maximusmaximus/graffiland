import React, { useState } from 'react';
import BrandLogo from '../BrandLogo.jsx';
import InfoTip from '../InfoTip.jsx';
import XeroIcon from '../XeroIcon.jsx';

const TUTORIAL_STEPS = [
  {
    emoji: '📡',
    title: '1. Aim & Lock Your Starting Surface',
    body: 'Allow Camera, GPS & Gyroscope, sweep to scan your spot, and tap a surface to start.',
    infoTitle: 'Surface Scan & Anchor Details',
    infoBody:
      'Watch the bottom-right scan box reach 100% so Proof of Location locks your real-world spot. Tap any floor, wall, ledge, or mid-air anchor, then tap + Seed to place your first block.'
  },
  {
    emoji: '🧱',
    title: '2. Sculpt 4x Blocks or Hand Off to AI',
    body: 'Hold and move your phone like a spray can to paint in 3D, or stack and erase blocks.',
    infoTitle: 'Brush, Stack, Erase & Pro Tools',
    infoBody:
      'Swipe the bottom carousel between Brush (🖌️), Stack (🧱 — hold to build off faces), and Erase (🧽). Toggle ⚡ Quick mode for a clean studio or Pro mode for Lock & Scale (✅), Foreground Occlusion (🪞), and Agent Code (📋).'
  },
  {
    emoji: '🚀',
    title: '3. Claim Virtual Land, Chat & Curate',
    body: 'Publish your art in person IRL to mint permanent free land and invite others.',
    infoTitle: 'Minting, Royalties & Local AR Chat',
    infoBody:
      'Human IRL publishes pin your 3D art to IPFS and mint gas-free on Robinhood Chain (5% creator royalty) with permanent land ownership and no expiry timer. Visitors IRL can inspect nearby glowing bases, unlock pinned notes, or join camera-locked chat.'
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
      aria-label="SPRAY.LAND Quick Start Guide"
      onClick={() => onClose(dontShowAgain)}
    >
      <div className="modal-card tutorial-card" style={{ maxWidth: 430 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <h3 className="modal-title" aria-label="SPRAY.LAND">
              <BrandLogo variant="lockup" height={30} />
            </h3>
            <InfoTip title="How Info Icons Work">
              Tap any <strong>i</strong> icon anytime to see extra details about a tool or step.
            </InfoTip>
          </div>
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
            <InfoTip title={step.infoTitle}>{step.infoBody}</InfoTip>
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
            <div style={{ fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="⚡" size={13} /> Quick Sculpt Mode
              <InfoTip title="Quick vs Pro HUD">
                <strong>Quick mode</strong> keeps only Brush, Stack, Erase, Preview &amp; Publish on
                screen. <strong>Pro HUD</strong> unlocks Transform, Foreground Occlusion, and AI
                Agent tools.
              </InfoTip>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {quickSculpt ? 'Simple studio controls.' : 'Full Pro studio tools.'}
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
          <span>Don&apos;t show automatically next time (re-open anytime via Guide &amp; Terms)</span>
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
