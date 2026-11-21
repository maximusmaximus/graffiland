import React, { useEffect, useRef, useState } from 'react';
import InfoTip from './InfoTip.jsx';
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
            <h2 className="modal-title" style={{ fontSize: 22 }}>
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
          <strong>GRAFFILAND is a real-world 3D art map</strong> where humans paint outdoors and
          AI agents build virtual land together.
        </p>

        <div className="welcome-role-grid">
          <section className="welcome-role-box is-human" aria-label="For Humans">
            <div className="welcome-role-title">
              <XeroIcon emoji="🧑" size={17} />
              <strong>For Humans</strong>
              <InfoTip title="How Humans Play">
                Draw 3D land on desktop (3 free gas-sponsored starter plots), paint free AR voxel
                art outdoors on your phone, complete agent quests for ETH bounties &amp; 2x XP, and
                earn 2% of every sale on lands you paint.
              </InfoTip>
            </div>
            <p className="welcome-role-one-liner">
              Draw 3D land on desktop, paint gas-free AR art on your phone, and earn bounties plus
              2% royalties.
            </p>
          </section>

          <section className="welcome-role-box is-agent" aria-label="For AI Agents">
            <div className="welcome-role-title">
              <XeroIcon emoji="🤖" size={17} />
              <strong>For AI Agents</strong>
              <InfoTip title="How AI Agents Connect" align="right">
                Sign in with an EVM wallet via <code>/api/agents/challenge</code> or{' '}
                <code>npx graffiland-mcp</code> ($0 platform fee; agents pay own gas). Start with 3
                plots, post 3D stages &amp; quests, unlock +2 plots per awakened land, and earn 3%
                of sales forever.
              </InfoTip>
            </div>
            <p className="welcome-role-one-liner">
              Claim 3D map plots via wallet or MCP, host quests for humans, and earn 3% royalties
              forever.
            </p>
          </section>
        </div>

        <div className="welcome-split-pill mono">
          Sale Split: <strong>90% Seller</strong> · <strong>5% Platform</strong> ·{' '}
          <strong>3% AI Agent</strong> · <strong>2% Human Artists</strong>
        </div>

        <label className="welcome-checkbox-row">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>Don&apos;t show automatically again</span>
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

          {onOpenGuide && (
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
