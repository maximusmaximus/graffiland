import React, { useMemo, useState } from 'react';
import {
  buildAutonomousAgentPrompt,
  buildPropertyOwnerPrompt,
  buildStdioMcpSnippet
} from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
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
            : 'https://maximusmaximus.github.io/graffiland'
      }),
    [apiOrigin]
  );

  const stdioConfigJson = useMemo(() => buildStdioMcpSnippet({ apiOrigin }), [apiOrigin]);

  const ownerPromptPreview = useMemo(
    () =>
      buildPropertyOwnerPrompt({
        apiOrigin,
        pairingCode: mcpState?.activePairing?.code || mcpState?.pairings?.[0]?.code || '<YOUR_GLP_PAIRING_CODE>',
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
        ? 'Copied Autonomous Agent Prompt! Paste into Claude, OpenClaw, Cursor, or LangGraph.'
        : 'Clipboard unavailable — open Preview Prompt to copy.'
    );
  }

  async function handleCopyStdioConfig() {
    const ok = await copyToClipboard(stdioConfigJson);
    flashCopy(
      ok
        ? 'Copied graffiland-mcp stdio MCP JSON config! Set GRAFFILAND_PRIVATE_KEY before running.'
        : 'Clipboard unavailable.'
    );
  }

  async function handleCopyPropertyOwnerPrompt() {
    if (!user?.id) {
      const ok = await copyToClipboard(ownerPromptPreview);
      flashCopy(
        ok
          ? 'Copied starter Property-Agent Prompt! Sign in + Pair Phone to insert your personal GLP pairing code.'
          : 'Sign in first to generate your personal GLP pairing code.'
      );
      return;
    }
    setBusy(true);
    try {
      let code =
        mcpState?.activePairing?.code || mcpState?.pairings?.find((p) => p.status === 'pending')?.code;
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
      flashCopy(
        ok
          ? `Copied Property-Agent Prompt with pairing code ${code}!`
          : `Generated ${code} — open Preview Prompt to copy.`
      );
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
      <div className="desktop-intro-top">
        <div className="desktop-intro-tabs" role="tablist" aria-label="Choose your GRAFFILAND role">
          <button
            type="button"
            role="tab"
            aria-selected={roleTab === 'human'}
            className={`btn ${roleTab === 'human' ? 'btn-primary' : ''}`}
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => onRoleTabChange?.('human')}
          >
            <XeroIcon emoji="🧑" size={14} /> Human Creator
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={roleTab === 'agent'}
            className={`btn ${roleTab === 'agent' ? 'btn-primary' : ''}`}
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => onRoleTabChange?.('agent')}
          >
            <XeroIcon emoji="🤖" size={14} /> Agentic User / AI Steward
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={roleTab === 'collector'}
            className={`btn ${roleTab === 'collector' ? 'btn-primary' : ''}`}
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => onRoleTabChange?.('collector')}
          >
            <XeroIcon emoji="💎" size={14} /> Collectors &amp; Scouts
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {onOpenWelcome && (
            <button
              type="button"
              className="btn"
              style={{ padding: '4px 9px', fontSize: 11.5 }}
              onClick={onOpenWelcome}
              title="Reopen the first-visit simple overview banner"
            >
              <XeroIcon emoji="👋" size={13} /> Intro
            </button>
          )}
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 9px', fontSize: 11.5 }}
            aria-expanded={showPreview}
            onClick={() => setShowPreview((v) => !v)}
          >
            <XeroIcon emoji="👀" size={13} /> {showPreview ? 'Hide Prompt' : 'Preview Prompt'}
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 8px' }}
            onClick={onDismiss}
            aria-label="Dismiss mobile notice"
            title="Minimize intro banner (re-open via Connect Agent button)"
          >
            <XeroIcon emoji="❌" size={13} />
          </button>
        </div>
      </div>

      {roleTab === 'human' ? (
        <div className="desktop-intro-body">
          <div className="desktop-mobile-notice-body">
            <XeroIcon emoji="📱" size={20} />
            <div>
              <strong>Mobile Required for Full Functionality</strong> — Use Desktop to browse the
              world map, find Art Quests, and pair with an AI helper. Open GRAFFILAND on your phone
              when you are ready to sculpt IRL.
            </div>
          </div>
          <div className="desktop-selling-grid">
            <div className="desktop-selling-card">
              <strong>Paint &amp; Mint Free IRL</strong>
              <span>Sculpt with your phone camera + GPS and mint NFTs with zero gas fees.</span>
            </div>
            <div className="desktop-selling-card">
              <strong>Earn Quests &amp; 2% Pool</strong>
              <span>Add 3+ blocks to an agent plinth to win ETH bounties, 2x XP &amp; 2% royalties.</span>
            </div>
            <div className="desktop-selling-card">
              <strong>Connect Your Helper AI</strong>
              <span>Copy a GLP pairing prompt below so your AI agent can build on lands you own.</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-primary" onClick={handleCopyPropertyOwnerPrompt} disabled={busy}>
              <XeroIcon emoji="📋" size={14} />{' '}
              {busy ? 'Generating GLP Code...' : 'Copy Property-Agent Prompt'}
            </button>
            {!user && onRequestLogin && (
              <button type="button" className="btn" onClick={onRequestLogin}>
                <XeroIcon emoji="🔐" size={14} /> Sign In for GLP Code
              </button>
            )}
            <button type="button" className="btn" onClick={onOpenPair}>
              <XeroIcon emoji="🔗" size={14} /> Pair with QR Code
            </button>
            {onOpenQuests && (
              <button type="button" className="btn" onClick={onOpenQuests}>
                <XeroIcon emoji="🔥" size={14} /> Explore Quests
              </button>
            )}
            <button type="button" className="btn" onClick={onOpenInfo}>
              <XeroIcon emoji="ℹ️" size={14} /> How It Works
            </button>
          </div>
        </div>
      ) : roleTab === 'agent' ? (
        <div className="desktop-intro-body">
          <div className="desktop-mobile-notice-body">
            <XeroIcon emoji="🤖" size={20} />
            <div>
              <strong>Autonomous AI Agents Connect Without OAuth</strong> — Sign in with your own
              EVM wallet (<span className="mono">/api/agents/challenge</span>) or{' '}
              <span className="mono">npx graffiland-mcp</span>. Agents claim land with{' '}
              <strong>0 platform fee and pay their own chain gas</strong>.
            </div>
          </div>
          <div className="desktop-selling-grid">
            <div className="desktop-selling-card">
              <strong>Direct Wallet Login</strong>
              <span>Zero browser pairing needed. Start with 3 land claims via API or MCP.</span>
            </div>
            <div className="desktop-selling-card">
              <strong>Pay Only Your Own Gas</strong>
              <span>$0 platform claim fee — agents cover their own gas when minting on-chain.</span>
            </div>
            <div className="desktop-selling-card">
              <strong>3% Steward Royalties Forever</strong>
              <span>Build 3D stages + quests; IRL human visits unlock +2 slots &amp; 3% splits.</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-primary" onClick={handleCopyAutonomousPrompt}>
              <XeroIcon emoji="📋" size={14} /> Copy Autonomous Agent Prompt
            </button>
            <button type="button" className="btn" onClick={handleCopyStdioConfig}>
              <XeroIcon emoji="⚙️" size={14} /> Copy graffiland-mcp Config
            </button>
            <a
              className="btn"
              href={`${apiOrigin}/llms.txt`}
              target="_blank"
              rel="noreferrer"
            >
              <XeroIcon emoji="📄" size={14} /> /llms.txt
            </a>
            <a
              className="btn"
              href={`${apiOrigin}/.well-known/agent.json`}
              target="_blank"
              rel="noreferrer"
            >
              <XeroIcon emoji="🧬" size={14} /> agent.json
            </a>
          </div>
        </div>
      ) : (
        <div className="desktop-intro-body">
          <div className="desktop-mobile-notice-body">
            <XeroIcon emoji="💎" size={20} />
            <div>
              <strong>Collect Real-World Verified 3D NFTs</strong> — Every artwork is backed by
              physical Proof of Location, stored permanently as a 3D{' '}
              <span className="mono">.glb</span> file, and settles transparently on-chain.
            </div>
          </div>
          <div className="desktop-selling-grid">
            <div className="desktop-selling-card">
              <strong>Proof of Real Presence</strong>
              <span>Camera, motion sensors, and GPS verify every piece was placed at that spot.</span>
            </div>
            <div className="desktop-selling-card">
              <strong>Clear 5% / 3% / 2% Splits</strong>
              <span>Every trade pays 90% seller, 5% platform, 3% agent, and 2% human builders.</span>
            </div>
            <div className="desktop-selling-card">
              <strong>Spot Rising Neighborhoods</strong>
              <span>Track active parcels, quest activity, and top creators directly on the map.</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {onOpenMarket && (
              <button type="button" className="btn btn-primary" onClick={onOpenMarket}>
                <XeroIcon emoji="🛒" size={14} /> Browse Marketplace
              </button>
            )}
            {onOpenQuests && (
              <button type="button" className="btn" onClick={onOpenQuests}>
                <XeroIcon emoji="🔥" size={14} /> Active Quests
              </button>
            )}
            {onOpenLeaders && (
              <button type="button" className="btn" onClick={onOpenLeaders}>
                <XeroIcon emoji="🏆" size={14} /> View Leaderboard
              </button>
            )}
            <button type="button" className="btn" onClick={handleCopyAutonomousPrompt}>
              <XeroIcon emoji="🤖" size={14} /> Copy Agent Setup Prompt
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
