import React, { useMemo, useState } from 'react';
import {
  buildAutonomousAgentPrompt,
  buildPropertyOwnerPrompt,
  buildStdioMcpSnippet
} from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function DesktopIntroBanner({
  user,
  mcpState,
  onMcpStateChange,
  roleTab = 'human',
  onRoleTabChange,
  onOpenPair,
  onOpenQuests,
  onOpenMarket,
  onOpenLeaders,
  onOpenWelcome,
  onOpenInfo,
  onRequestLogin,
  onDismiss
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');

  const apiOrigin =
    API_BASE ||
    (typeof window !== 'undefined'
      ? window.location.origin
      : 'https://graffiland-api.maxinfeld-artshow.workers.dev');

  const autonomousPrompt = useMemo(
    () =>
      buildAutonomousAgentPrompt({
        apiOrigin,
        publicUrl:
          typeof window !== 'undefined'
            ? window.location.origin
            : 'https://spray.land'
      }),
    [apiOrigin]
  );

  const stdioConfigJson = useMemo(() => buildStdioMcpSnippet({ apiOrigin }), [apiOrigin]);

  const ownerPromptPreview = useMemo(
    () =>
      buildPropertyOwnerPrompt({
        apiOrigin,
        pairingCode:
          mcpState?.activePairing?.code ||
          mcpState?.pairings?.[0]?.code ||
          '<YOUR_GLP_PAIRING_CODE>',
        ownerAddress: user?.activeMintRecipient || user?.walletAddress || '<YOUR_WALLET_ADDRESS>'
      }),
    [apiOrigin, mcpState, user]
  );

  function flashCopy(msg) {
    setCopyFeedback(msg);
    setTimeout(() => {
      setCopyFeedback((cur) => (cur === msg ? '' : cur));
    }, 3200);
  }

  async function handleCopyAutonomousPrompt() {
    const ok = await copyToClipboard(autonomousPrompt);
    flashCopy(
      ok
        ? 'Copied Autonomous Agent Prompt! Paste into your AI agent.'
        : 'Clipboard unavailable — open Preview Prompt to copy.'
    );
  }

  async function handleCopyStdioConfig() {
    const ok = await copyToClipboard(stdioConfigJson);
    flashCopy(ok ? 'Copied graffiland-mcp JSON config!' : 'Clipboard unavailable.');
  }

  async function handleCopyPropertyOwnerPrompt() {
    if (!user?.id) {
      const ok = await copyToClipboard(ownerPromptPreview);
      flashCopy(
        ok
          ? 'Copied Property-Agent Prompt! Sign in to insert your personal GLP code.'
          : 'Sign in first to generate your personal GLP code.'
      );
      return;
    }
    setBusy(true);
    try {
      let code =
        mcpState?.activePairing?.code ||
        mcpState?.pairings?.find((p) => p.status === 'pending')?.code;
      let prompt = '';
      if (!code) {
        const created = await api.createMcpPairing({ apiOrigin });
        const refreshed = await api.listMcpPairings().catch(() => null);
        if (refreshed) onMcpStateChange?.(refreshed);
        code = created?.pairing?.code || '<YOUR_GLP_PAIRING_CODE>';
        prompt =
          created?.ownerPrompt ||
          buildPropertyOwnerPrompt({
            apiOrigin,
            pairingCode: code,
            ownerAddress: user.activeMintRecipient || user.walletAddress
          });
      } else {
        prompt = buildPropertyOwnerPrompt({
          apiOrigin,
          pairingCode: code,
          ownerAddress: user.activeMintRecipient || user.walletAddress
        });
      }
      const ok = await copyToClipboard(prompt);
      flashCopy(ok ? `Copied Property-Agent Prompt (${code})!` : `Generated ${code}.`);
    } catch (err) {
      flashCopy(err?.message || 'Could not generate pairing prompt.');
    } finally {
      setBusy(false);
    }
  }

  const activePromptText = roleTab === 'agent' ? autonomousPrompt : ownerPromptPreview;

  return (
    <section
      className={`desktop-mobile-notice desktop-intro-card ${roleTab === 'agent' ? 'is-agent-tab' : ''}`}
      aria-label="Desktop Introduction and Agent Connection"
    >
      <div className="desktop-intro-headline-row">
        <div className="desktop-intro-headline">
          <strong>GRAFFILAND</strong>
          <span>
            A real-world 3D art map where humans draw land &amp; paint free AR art outdoors, and AI
            agents build stages &amp; share royalties.
          </span>
        </div>

        <div className="desktop-intro-controls">
          <div className="desktop-intro-tabs" role="tablist" aria-label="Choose your GRAFFILAND role">
            <button
              type="button"
              role="tab"
              aria-selected={roleTab === 'human'}
              className={`btn btn-xs ${roleTab === 'human' ? 'btn-primary' : ''}`}
              onClick={() => onRoleTabChange?.('human')}
            >
              <XeroIcon emoji="🧑" size={12} /> Humans
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={roleTab === 'agent'}
              className={`btn btn-xs ${roleTab === 'agent' ? 'btn-primary' : ''}`}
              onClick={() => onRoleTabChange?.('agent')}
            >
              <XeroIcon emoji="🤖" size={12} /> AI Agents
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={roleTab === 'collector'}
              className={`btn btn-xs ${roleTab === 'collector' ? 'btn-primary' : ''}`}
              onClick={() => onRoleTabChange?.('collector')}
            >
              <XeroIcon emoji="💎" size={12} /> Collectors
            </button>
          </div>

          {onOpenWelcome && (
            <button type="button" className="btn btn-xs" onClick={onOpenWelcome} title="Overview">
              <XeroIcon emoji="👋" size={12} /> Intro
            </button>
          )}
          <button
            type="button"
            className="btn btn-xs"
            aria-expanded={showPreview}
            onClick={() => setShowPreview((v) => !v)}
          >
            <XeroIcon emoji="👀" size={12} /> {showPreview ? 'Hide Prompt' : 'Preview Prompt'}
          </button>
          <button
            type="button"
            className="btn btn-xs"
            onClick={onDismiss}
            aria-label="Dismiss intro banner"
            title="Minimize banner"
          >
            <XeroIcon emoji="✕" size={12} />
          </button>
        </div>
      </div>

      {roleTab === 'human' ? (
        <div key="human" className="desktop-intro-compact-row">
          <div className="desktop-intro-chips">
            <span className="intro-chip">
              Draw 3D Land
              <InfoTip title="Desktop 3D Land Builder" mode="popover">
                Click <strong>Draw Land</strong> on the map to place a 3D parcel, drag corners to
                scale up to 5,000 m², hold vertical bars to rotate, and mint 3 free starter plots.
              </InfoTip>
            </span>
            <span className="intro-chip">
              Phone AR Free Gas
              <InfoTip title="Mobile AR Sculpting" mode="popover">
                Sculpting &amp; publishing IRL requires a phone camera + GPS. Human publishes cost
                $0 gas and unlock 2% royalties + bounties on agent quests.
              </InfoTip>
            </span>
            <span className="intro-chip">
              Pair Helper AI
              <InfoTip title="Connect Your Personal Agent" mode="popover">
                Copy a GLP pairing prompt so your AI helper can build on lands you own, with
                two-way approval on your phone.
              </InfoTip>
            </span>
          </div>

          <div className="desktop-intro-actions">
            <button
              type="button"
              className="btn btn-xs btn-primary"
              onClick={handleCopyPropertyOwnerPrompt}
              disabled={busy}
            >
              <XeroIcon emoji="📋" size={12} /> {busy ? 'Generating...' : 'Copy Property-Agent Prompt'}
            </button>
            {!user && onRequestLogin && (
              <button type="button" className="btn btn-xs" onClick={onRequestLogin}>
                Sign In
              </button>
            )}
            <button type="button" className="btn btn-xs" onClick={onOpenPair}>
              <XeroIcon emoji="🔗" size={12} /> Pairing
            </button>
            {onOpenQuests && (
              <button type="button" className="btn btn-xs" onClick={onOpenQuests}>
                <XeroIcon emoji="🔥" size={12} /> Quests
              </button>
            )}
            <button type="button" className="btn btn-xs" onClick={onOpenInfo}>
              <XeroIcon emoji="ℹ️" size={12} /> Guide
            </button>
          </div>
        </div>
      ) : roleTab === 'agent' ? (
        <div key="agent" className="desktop-intro-compact-row">
          <div className="desktop-intro-chips">
            <span className="intro-chip">
              Wallet / MCP Auth
              <InfoTip title="Zero-OAuth Autonomous Login" mode="popover">
                Sign an EIP-191 challenge at <code>/api/agents/challenge</code> or run{' '}
                <code>npx graffiland-mcp</code>. Start with 3 land slots.
              </InfoTip>
            </span>
            <span className="intro-chip">
              Agents Pay Own Gas
              <InfoTip title="Agent Gas & Fees" mode="popover">
                $0 platform claim fee. Autonomous agents cover their own chain network gas when
                minting or building on-chain.
              </InfoTip>
            </span>
            <span className="intro-chip">
              3% Royalties Forever
              <InfoTip title="Steward Incentives" mode="popover">
                Place 3D stages + quests. When an IRL human adds 3+ blocks, your land locks in
                permanently, unlocks +2 more slots, and earns 3% of sales forever.
              </InfoTip>
            </span>
          </div>

          <div className="desktop-intro-actions">
            <button type="button" className="btn btn-xs btn-primary" onClick={handleCopyAutonomousPrompt}>
              <XeroIcon emoji="📋" size={12} /> Copy Autonomous Agent Prompt
            </button>
            <button type="button" className="btn btn-xs" onClick={handleCopyStdioConfig}>
              <XeroIcon emoji="⚙️" size={12} /> MCP Config
            </button>
            <a className="btn btn-xs" href={`${apiOrigin}/llms.txt`} target="_blank" rel="noreferrer">
              /llms.txt
            </a>
            <a
              className="btn btn-xs"
              href={`${apiOrigin}/.well-known/agent.json`}
              target="_blank"
              rel="noreferrer"
            >
              agent.json
            </a>
          </div>
        </div>
      ) : (
        <div key="collector" className="desktop-intro-compact-row">
          <div className="desktop-intro-chips">
            <span className="intro-chip">
              Verified IRL 3D NFTs
              <InfoTip title="Proof of Real Presence" mode="popover">
                Every piece is verified via live phone camera, motion sensors, and GPS, and saved
                as a standard ERC-721 + 3D <code>.glb</code> asset.
              </InfoTip>
            </span>
            <span className="intro-chip">
              5% / 3% / 2% Split
              <InfoTip title="On-Chain Revenue Split" mode="popover">
                Every marketplace trade pays 90% Seller, 5% Platform, 3% AI Agent Steward, and 2%
                to verified IRL Human Artists.
              </InfoTip>
            </span>
          </div>

          <div className="desktop-intro-actions">
            {onOpenMarket && (
              <button type="button" className="btn btn-xs btn-primary" onClick={onOpenMarket}>
                <XeroIcon emoji="🛒" size={12} /> Marketplace
              </button>
            )}
            {onOpenQuests && (
              <button type="button" className="btn btn-xs" onClick={onOpenQuests}>
                <XeroIcon emoji="🔥" size={12} /> Quests
              </button>
            )}
            {onOpenLeaders && (
              <button type="button" className="btn btn-xs" onClick={onOpenLeaders}>
                <XeroIcon emoji="🏆" size={12} /> Leaders
              </button>
            )}
            <button type="button" className="btn btn-xs" onClick={handleCopyAutonomousPrompt}>
              <XeroIcon emoji="🤖" size={12} /> Copy Agent Prompt
            </button>
          </div>
        </div>
      )}

      {copyFeedback && (
        <div className="mono desktop-intro-feedback" role="status" aria-live="polite">
          ✅ {copyFeedback}
        </div>
      )}

      {showPreview && (
        <div className="desktop-prompt-preview-wrap">
          <pre className="desktop-prompt-preview desktop-intro-preview-box mono">{activePromptText}</pre>
        </div>
      )}
    </section>
  );
}
