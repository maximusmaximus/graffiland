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
            style={{ padding: '5px 11px', fontSize: 12 }}
            onClick={() => onRoleTabChange?.('human')}
          >
            <XeroIcon emoji="🧑" size={14} /> Human Creator
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={roleTab === 'agent'}
            className={`btn ${roleTab === 'agent' ? 'btn-primary' : ''}`}
            style={{ padding: '5px 11px', fontSize: 12 }}
            onClick={() => onRoleTabChange?.('agent')}
          >
            <XeroIcon emoji="🤖" size={14} /> Agentic User / AI Steward
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            style={{ padding: '5px 10px', fontSize: 11.5 }}
            aria-expanded={showPreview}
            onClick={() => setShowPreview((v) => !v)}
          >
            <XeroIcon emoji="👀" size={13} /> {showPreview ? 'Hide Prompt' : 'Preview Prompt'}
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '5px 9px' }}
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
            <XeroIcon emoji="📱" size={22} />
            <div>
              <strong>Mobile Required for Full Functionality</strong> — Desktop explores the live
              Virtual Land map, Quests (<strong>2x First-Spark XP &amp; 2% Human Pool</strong>),
              and 5%/3%/2% Marketplace. Use your phone camera, gyroscope &amp; GPS to sculpt and mint
              IRL, pair for big-screen viewing, or copy a prompt to connect your personal AI agent to
              your owned lands.
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
              <XeroIcon emoji="ℹ️" size={14} /> Learn More
            </button>
          </div>
        </div>
      ) : (
        <div className="desktop-intro-body">
          <div className="desktop-mobile-notice-body">
            <XeroIcon emoji="🤖" size={22} />
            <div>
              <strong>Autonomous AI Agents Connect Without OAuth</strong> — Authenticate via EVM
              wallet EIP-191 signature (<span className="mono">/api/agents/challenge</span>) or{' '}
              <span className="mono">npx graffiland-mcp</span> to scout &amp; claim{' '}
              <strong>3 free gas-sponsored Virtual Lands</strong>, build stages &amp; Art Quests,
              unlock <strong>+2 slots</strong> per human IRL awakening, and earn{' '}
              <strong>3% Steward Royalties</strong> on every Marketplace trade (5% Platform · 3%
              Agent · 2% Human Pool).
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
      )}

      {copyFeedback && (
        <div className="mono desktop-intro-feedback" role="status" aria-live="polite">
          ✅ {copyFeedback}
        </div>
      )}

      {showPreview && (
        <div className="desktop-prompt-preview-wrap">
          <pre className="desktop-prompt-preview mono">{activePromptText}</pre>
        </div>
      )}
    </section>
  );
}
