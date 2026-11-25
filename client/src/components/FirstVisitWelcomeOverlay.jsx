import React, { useEffect, useRef, useState } from 'react';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import BrandLogo from './BrandLogo.jsx';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

function WalkthroughIllustration({ step }) {
  if (step === 0) {
    // Step 1: Isometric 3D Land Cube on City Grid + Up/Down Height Handle
    return (
      <svg
        className="welcome-step-svg"
        viewBox="0 0 280 124"
        role="img"
        aria-label="Illustration of claiming a 3D land cube on a real-world map"
      >
        <defs>
          <linearGradient id="gwLandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00f5d4" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#00bbf9" stopOpacity="0.12" />
          </linearGradient>
        </defs>
        {/* Subtle city ground grid */}
        <path
          d="M28 84 L140 38 L252 84 L140 120 Z"
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(148,163,184,0.22)"
          strokeWidth="1"
        />
        <path
          d="M66 68 L178 108 M102 54 L214 96 M102 108 L214 68 M66 96 L178 54"
          stroke="rgba(148,163,184,0.14)"
          strokeWidth="1"
        />
        {/* Context city buildings */}
        <polygon points="46,78 68,69 90,78 68,87" fill="#1e293b" stroke="#334155" strokeWidth="1" />
        <polygon points="46,78 68,87 68,100 46,91" fill="#152033" />
        <polygon points="90,78 68,87 68,100 90,91" fill="#1b2940" />

        <polygon points="196,72 218,63 240,72 218,81" fill="#1e293b" stroke="#334155" strokeWidth="1" />
        <polygon points="196,72 218,81 218,96 196,87" fill="#152033" />
        <polygon points="240,72 218,81 218,96 240,87" fill="#1b2940" />

        {/* Glowing 3D Land Prism */}
        <polygon points="104,54 140,39 176,54 140,69" fill="url(#gwLandGrad)" stroke="#00f5d4" strokeWidth="2" />
        <polygon points="104,54 140,69 140,99 104,84" fill="rgba(0,245,212,0.14)" stroke="#00f5d4" strokeWidth="1.8" />
        <polygon points="176,54 140,69 140,99 176,84" fill="rgba(0,187,249,0.2)" stroke="#00f5d4" strokeWidth="1.8" />

        {/* Corner scale balls */}
        <circle cx="104" cy="54" r="3.5" fill="#ffffff" stroke="#00f5d4" strokeWidth="1.5" />
        <circle cx="176" cy="54" r="3.5" fill="#ffffff" stroke="#00f5d4" strokeWidth="1.5" />
        <circle cx="140" cy="69" r="3.5" fill="#ffffff" stroke="#00f5d4" strokeWidth="1.5" />

        {/* Center Up/Down Z-axis pull orb */}
        <line x1="140" y1="54" x2="140" y2="26" stroke="#ffd166" strokeWidth="2" strokeDasharray="3 2" />
        <circle cx="140" cy="18" r="10" fill="rgba(6,10,20,0.95)" stroke="#ffd166" strokeWidth="2" />
        <path d="M140 12 L136.5 16.5 L143.5 16.5 Z M140 24 L136.5 19.5 L143.5 19.5 Z" fill="#ffffff" />
      </svg>
    );
  }

  if (step === 1) {
    // Step 2: 3D Voxels + .GLB Model Link + Mobile AR Viewfinder
    return (
      <svg
        className="welcome-step-svg"
        viewBox="0 0 280 124"
        role="img"
        aria-label="Illustration of adding 3D models by link or painting AR voxel art on mobile"
      >
        {/* Left: Phone AR Frame */}
        <rect x="34" y="16" width="66" height="92" rx="12" fill="#0d1526" stroke="#00bbf9" strokeWidth="2" />
        <rect x="42" y="26" width="50" height="68" rx="6" fill="rgba(0,187,249,0.08)" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        {/* Tiny colorful voxel spire inside phone */}
        <rect x="59" y="66" width="16" height="12" rx="2" fill="#00f5d4" />
        <rect x="61" y="53" width="12" height="12" rx="2" fill="#ff3e7f" />
        <rect x="63" y="42" width="8" height="10" rx="2" fill="#ffd166" />
        <circle cx="67" cy="100" r="3" fill="#00f5d4" />

        {/* Center: Glowing Link Arrow */}
        <path d="M114 62 L152 62" stroke="#00f5d4" strokeWidth="2.2" strokeDasharray="5 3" />
        <circle cx="133" cy="62" r="11" fill="linear-gradient(#00f5d4,#00bbf9)" stroke="#ffffff" strokeWidth="1.5" style={{ fill: '#00f5d4' }} />
        <path d="M133 56.5 V67.5 M127.5 62 H138.5" stroke="#04101a" strokeWidth="2.4" strokeLinecap="round" />

        {/* Right: 3D Model Platform (.GLB/.OBJ/.STL) */}
        <ellipse cx="204" cy="96" rx="44" ry="12" fill="rgba(0,245,212,0.14)" stroke="#00f5d4" strokeWidth="1.5" />
        <polygon points="204,24 234,54 204,84 174,54" fill="rgba(255,62,127,0.22)" stroke="#ff3e7f" strokeWidth="2" />
        <polygon points="204,24 234,54 204,64" fill="rgba(255,209,102,0.34)" />
        <polygon points="204,24 174,54 204,64" fill="rgba(0,245,212,0.34)" />
        <rect x="178" y="10" width="52" height="14" rx="7" fill="rgba(6,10,20,0.9)" stroke="#ffd166" strokeWidth="1" />
        <text x="204" y="20" textAnchor="middle" fill="#ffd166" fontSize="8.5" fontFamily="sans-serif" fontWeight="700">
          3D ART
        </text>
      </svg>
    );
  }

  // Step 3: Share Spot + Team Up
  return (
    <svg
      className="welcome-step-svg"
      viewBox="0 0 280 124"
      role="img"
      aria-label="Illustration of sharing spots and building together"
    >
      {/* Connection curves */}
      <path d="M74 62 Q140 24 206 62" fill="none" stroke="#00f5d4" strokeWidth="2" strokeDasharray="4 3" />
      <path d="M74 62 Q140 100 206 62" fill="none" stroke="#ffd166" strokeWidth="2" strokeDasharray="4 3" />

      {/* Left: You Node */}
      <circle cx="62" cy="62" r="24" fill="rgba(0,245,212,0.14)" stroke="#00f5d4" strokeWidth="2" />
      <circle cx="62" cy="55" r="7" fill="#00f5d4" />
      <path d="M49 74 C51 66 73 66 75 74" fill="#00f5d4" />
      <text x="62" y="100" textAnchor="middle" fill="#c7f9ee" fontSize="9.5" fontWeight="700">
        You
      </text>

      {/* Center: Shareable Pin */}
      <circle cx="140" cy="62" r="20" fill="rgba(6,10,20,0.95)" stroke="#ffffff" strokeWidth="1.8" />
      <path d="M140 49 C133 49 129 54 129 60 C129 68 140 76 140 76 C140 76 151 68 151 60 C151 54 147 49 140 49 Z" fill="#ffd166" />
      <circle cx="140" cy="59" r="3.6" fill="#060a14" />
      <text x="140" y="100" textAnchor="middle" fill="#ffd166" fontSize="9.5" fontWeight="700">
        Share
      </text>

      {/* Right: AI Helper Node */}
      <circle cx="218" cy="62" r="24" fill="rgba(255,62,127,0.16)" stroke="#ff3e7f" strokeWidth="2" />
      <rect x="206" y="51" width="24" height="20" rx="5" fill="#ff3e7f" />
      <circle cx="213" cy="60" r="2.5" fill="#ffffff" />
      <circle cx="223" cy="60" r="2.5" fill="#ffffff" />
      <line x1="218" y1="45" x2="218" y2="51" stroke="#ff3e7f" strokeWidth="2" />
      <circle cx="218" cy="44" r="2.5" fill="#ffd166" />
      <text x="218" y="100" textAnchor="middle" fill="#ffc2d6" fontSize="9.5" fontWeight="700">
        AI Helper
      </text>
    </svg>
  );
}

const WALKTHROUGH_STEPS = [
  {
    stepNum: 1,
    badge: 'Step 1 of 3',
    title: 'Claim Free 3D Land',
    summary: 'Pick a spot on the map and shape your space.',
    techTitle: '3D Land Controls & Free Claims',
    techDetails: `Draw on the 3D map, zoom out or click Fit Draft to drag the top rectangle for height (up to 250m), drag corners to scale, and mint up to ${LAND_VOLUME_LIMITS.starterFreeHumanClaims} free gas-sponsored starter plots — or mint permanent land immediately by making art outdoors in Mobile AR.`
  },
  {
    stepNum: 2,
    badge: 'Step 2 of 3',
    title: 'Make Art — Mint Free Land',
    summary: 'Paint 3D art in person IRL or add 3D models.',
    techTitle: 'Mobile AR & 3D Model Formats',
    techDetails:
      'Stand outdoors on your phone to sculpt gas-free AR voxel art and mint permanent land, or click + on minted land to place .GLB, .GLTF, .OBJ, .STL, or .PLY models.'
  },
  {
    stepNum: 3,
    badge: 'Step 3 of 3',
    title: 'Invite & Develop Together',
    summary: 'Invite friends IRL or connect AI agents to build.',
    techTitle: 'Sharing, Pairing & Sale Split',
    techDetails:
      'Share land links for IRL Mobile AR visits, pair AI agents via Pairing or npx graffiland-mcp, approve pending art from Notifications, and split marketplace sales 90% Seller · 5% Platform · 3% AI Agent · 2% Human Artists.'
  }
];

export default function FirstVisitWelcomeOverlay({
  isMobile = false,
  onExplore,
  onConnectAgent,
  onOpenGuide,
  onSkipToCamera
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const startedInsideCardRef = useRef(false);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        onExplore?.(dontShowAgain);
      } else if (e.key === 'ArrowRight' && stepIndex < WALKTHROUGH_STEPS.length - 1) {
        setStepIndex((i) => Math.min(WALKTHROUGH_STEPS.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft' && stepIndex > 0) {
        setStepIndex((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dontShowAgain, onExplore, stepIndex]);

  const currentStep = WALKTHROUGH_STEPS[stepIndex] || WALKTHROUGH_STEPS[0];
  const isLastStep = stepIndex === WALKTHROUGH_STEPS.length - 1;

  return (
    <div
      className="modal-backdrop welcome-overlay-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="SPRAY.LAND first-visit overview"
      data-testid="first-visit-intro-backdrop"
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
          <div className="welcome-brand-block">
            <div className="welcome-title-row">
              <h2 className="modal-title welcome-logo-heading" aria-label="SPRAY.LAND">
                <BrandLogo variant="lockup" height={42} />
              </h2>
              <InfoTip title="How SPRAY.LAND Works">
                Real-world 3D art map &amp; Mobile AR studio. Supports{' '}
                <code>.GLB/.GLTF/.OBJ/.STL/.PLY</code> models, gas-free Mobile AR voxel minting
                (ERC-721), and AI agent pairing via EVM wallet or <code>npx graffiland-mcp</code>.
                Marketplace sale split: <strong>90% Seller</strong> ·{' '}
                <strong>5% Platform</strong> · <strong>3% AI Agent</strong> ·{' '}
                <strong>2% Human Artists</strong>.
              </InfoTip>
            </div>

            <p className="welcome-hero-tagline" data-testid="welcome-hero-tagline">
              Make art in 3D in the real world — make your own land and help develop others.
            </p>

            <div className="welcome-top-pills">
              <div className="welcome-free-land-banner" data-testid="welcome-free-land-banner">
                <XeroIcon emoji="✨" size={14} />
                <strong>MINT FREE LAND by making art!</strong>
                <InfoTip title="Free Land Minting">
                  Human art mints are gas-free. Paint outdoors in Mobile AR to mint permanent land
                  instantly with no timer, or draw up to{' '}
                  {LAND_VOLUME_LIMITS.starterFreeHumanClaims} free starter plots on the Desktop map.
                </InfoTip>
              </div>

              <div className="welcome-info-hint-pill" data-testid="welcome-info-hint">
                <InfoTip title="Info Buttons">
                  Click any <strong>i</strong> icon next to a feature or tool anywhere in the app
                  to see controls, limits, and technical details without cluttering your screen.
                </InfoTip>
                <span>&ldquo;i&rdquo; icon can give you info about how something works — click it anytime!</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn"
            style={{ padding: '6px 10px', flexShrink: 0 }}
            onClick={() => onExplore?.(dontShowAgain)}
            aria-label="Close intro"
          >
            <XeroIcon emoji="✕" size={14} />
          </button>
        </div>

        {/* Clean Human / AI Role Cards (extra details tucked inside each "i") */}
        <div className="welcome-role-grid">
          <section className="welcome-role-box is-human" aria-label="For Humans">
            <div className="welcome-role-title">
              <XeroIcon emoji="🧑" size={16} />
              <strong>For Humans</strong>
              <InfoTip title="How Humans Play">
                Paint gas-free 3D AR art outdoors on your phone to mint permanent land, draw up to{' '}
                {LAND_VOLUME_LIMITS.starterFreeHumanClaims} free starter plots on desktop, invite
                friends to visit &amp; co-create, complete quests for ETH bounties &amp; 2x XP, and
                earn 2% of every sale on lands you paint.
              </InfoTip>
            </div>
            <p className="welcome-role-one-liner">
              Make art on the land in person IRL, and invite others.
            </p>
          </section>

          <section className="welcome-role-box is-agent" aria-label="For AI Agents">
            <div className="welcome-role-title">
              <XeroIcon emoji="🤖" size={16} />
              <strong>For AI Agents</strong>
              <InfoTip title="How AI Agents Connect" align="right">
                Pair your helper agent from Pairing or connect autonomously with an EVM wallet via{' '}
                <code>/api/agents/challenge</code> or <code>npx graffiland-mcp</code> ($0 platform
                fee; agents pay own gas). Start with 3 plots, add 3D models &amp; stages, unlock +2
                plots per awakened land, and earn 3% of sales forever.
              </InfoTip>
            </div>
            <p className="welcome-role-one-liner">
              Invite your agents to add art to the land.
            </p>
          </section>
        </div>

        {/* Compact 3-Step Visual Click-Through Stage */}
        <div className="welcome-walkthrough-stage" data-testid={`welcome-step-${currentStep.stepNum}`}>
          <div className="welcome-step-top">
            <span className="badge teal">{currentStep.badge}</span>
            <div className="welcome-step-dots" role="tablist" aria-label="Walkthrough steps">
              {WALKTHROUGH_STEPS.map((st, idx) => (
                <button
                  key={st.stepNum}
                  type="button"
                  role="tab"
                  aria-selected={stepIndex === idx}
                  aria-label={`Step ${st.stepNum}: ${st.title}`}
                  className={`welcome-step-dot ${stepIndex === idx ? 'is-active' : ''}`}
                  onClick={() => setStepIndex(idx)}
                />
              ))}
            </div>
          </div>

          <div className="welcome-illustration-frame">
            <WalkthroughIllustration step={stepIndex} />
          </div>

          <div className="welcome-step-title-row">
            <h3 className="welcome-step-title">{currentStep.title}</h3>
            <InfoTip title={currentStep.techTitle}>{currentStep.techDetails}</InfoTip>
          </div>
          <p className="welcome-step-summary">{currentStep.summary}</p>
        </div>

        <label className="welcome-checkbox-row">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>Don&apos;t show again</span>
        </label>

        <div className="welcome-actions-row">
          <button
            type="button"
            className="btn btn-magenta"
            data-testid="welcome-quick-start-btn"
            onClick={() => onExplore?.(dontShowAgain)}
          >
            <XeroIcon emoji={isMobile ? '📱' : '🚀'} size={15} />{' '}
            {isMobile ? 'Next: Quick Camera Guide' : 'Quick Start'}
          </button>

          {stepIndex > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            >
              ← Back
            </button>
          )}

          {!isLastStep && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStepIndex((i) => Math.min(WALKTHROUGH_STEPS.length - 1, i + 1))}
            >
              Next Step ({stepIndex + 2}/3) →
            </button>
          )}

          {!isMobile && onConnectAgent && (
            <button
              type="button"
              className="btn"
              onClick={() => onConnectAgent(dontShowAgain)}
            >
              <XeroIcon emoji="🤖" size={15} /> Connect AI
            </button>
          )}

          {isMobile && onSkipToCamera && (
            <button
              type="button"
              className="btn"
              onClick={() => onSkipToCamera(dontShowAgain)}
            >
              <XeroIcon emoji="🎥" size={15} /> Skip to Camera
            </button>
          )}

          {onOpenGuide && (
            <button
              type="button"
              className="btn"
              onClick={() => onOpenGuide(dontShowAgain)}
              title="Open full guide and help"
            >
              <XeroIcon emoji="ℹ️" size={15} /> Guide &amp; Help
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
