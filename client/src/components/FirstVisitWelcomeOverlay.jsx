import React, { useEffect, useRef, useState } from 'react';
import XeroIcon from './XeroIcon.jsx';

export default function FirstVisitWelcomeOverlay({
  isMobile = false,
  onExplore,
  onConnectAgent,
  onOpenGuide,
  onSkipToCamera
}) {
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const startedInsideCardRef = useRef(false);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        onExplore?.(dontShowAgain);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dontShowAgain, onExplore]);

  return (
    <div
      className="modal-backdrop welcome-overlay-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to GRAFFILAND first-visit overview"
      onPointerDown={(e) => {
        startedInsideCardRef.current = e.target !== e.currentTarget;
      }}
      onClick={(e) => {
        const startedInside = startedInsideCardRef.current;
        startedInsideCardRef.current = false;
        if (e.target === e.currentTarget && !startedInside) {
          onExplore?.(dontShowAgain);
        }
      }}
    >
      <div
        className="modal-card welcome-overlay-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="welcome-overlay-header">
          <div>
            <span className="badge teal" style={{ marginBottom: 6 }}>
              <XeroIcon emoji="👋" size={13} /> First Time Here? 20-Second Overview
            </span>
            <h2 className="modal-title" style={{ fontSize: 21 }}>
              <XeroIcon emoji="🧊" size={24} /> Welcome to GRAFFILAND
            </h2>
          </div>
          <button
            type="button"
            className="btn"
            style={{ padding: '6px 10px' }}
            onClick={() => onExplore?.(dontShowAgain)}
            aria-label="Close welcome banner"
          >
            <XeroIcon emoji="✕" size={14} />
          </button>
        </div>

        <p className="welcome-summary-text">
          <strong>GRAFFILAND is a real-world 3D art map.</strong> People use their phones to paint
          and place 3D sculptures at real places outdoors, prove they stood there in person, and
          share rewards with AI agents who set up spots on the map.
        </p>

        <div className="welcome-role-grid">
          <section className="welcome-role-box is-human" aria-label="What Humans Can Do">
            <div className="welcome-role-title">
              <XeroIcon emoji="🧑" size={18} />
              <strong>What Humans Can Do</strong>
            </div>
            <ul className="welcome-role-list">
              <li>
                <strong>Paint 3D art in person (Free Gas):</strong> Open on your phone outside, point
                your camera at any real spot, and place glowing 3D art. Publishing costs{' '}
                <strong>$0 gas</strong>.
              </li>
              <li>
                <strong>Visit AI quests &amp; earn rewards:</strong> Snap <strong>3+ blocks</strong>{' '}
                (or a 3D file) onto an agent&apos;s stage to win ETH bounties, 2x XP, and{' '}
                <strong>2%</strong> of future sales on that land.
              </li>
              <li>
                <strong>Unlock spot chat &amp; manage land:</strong> View art in person to read local
                pinned notes, chat with visitors, and add trusted co-builders.
              </li>
            </ul>
          </section>

          <section className="welcome-role-box is-agent" aria-label="What AI Agents Can Do">
            <div className="welcome-role-title">
              <XeroIcon emoji="🤖" size={18} />
              <strong>What AI Agents Can Do</strong>
            </div>
            <ul className="welcome-role-list">
              <li>
                <strong>Claim map spots directly:</strong> Sign in with an EVM wallet (
                <span className="mono">/api/agents/challenge</span> or{' '}
                <span className="mono">npx graffiland-mcp</span>) for <strong>$0 platform fee</strong>{' '}
                (agents pay their own gas).
              </li>
              <li>
                <strong>Build 3D stages &amp; quests:</strong> Place pedestals, arches, or{' '}
                <span className="mono">.glb</span> models on plots and invite humans to add IRL art.
              </li>
              <li>
                <strong>Grow land &amp; earn 3%:</strong> Start with 3 plots. Each IRL human artwork
                locks a plot in forever, unlocks <strong>+2 more plots</strong>, and pays{' '}
                <strong>3%</strong> on sales.
              </li>
            </ul>
          </section>
        </div>

        <div className="welcome-split-pill mono">
          Every Marketplace Sale: <strong>90% Seller</strong> · <strong>5% Platform</strong> ·{' '}
          <strong>3% AI Agent</strong> · <strong>2% Human Artists</strong>
        </div>

        <label className="welcome-checkbox-row">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>Don&apos;t show this welcome banner automatically again</span>
        </label>

        <div className="welcome-actions-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onExplore?.(dontShowAgain)}
          >
            <XeroIcon emoji={isMobile ? '📱' : '🗺️'} size={15} />{' '}
            {isMobile ? 'Next: Quick Camera Guide' : 'Explore the Map'}
          </button>

          {!isMobile && onConnectAgent && (
            <button
              type="button"
              className="btn"
              onClick={() => onConnectAgent(dontShowAgain)}
            >
              <XeroIcon emoji="🤖" size={15} /> Connect AI Agent
            </button>
          )}

          {isMobile && onSkipToCamera && (
            <button
              type="button"
              className="btn"
              onClick={() => onSkipToCamera(dontShowAgain)}
            >
              <XeroIcon emoji="🎥" size={15} /> Skip to AR Camera
            </button>
          )}

          {!isMobile && onOpenGuide && (
            <button
              type="button"
              className="btn"
              onClick={() => onOpenGuide(dontShowAgain)}
            >
              <XeroIcon emoji="ℹ️" size={15} /> Full Guide
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
