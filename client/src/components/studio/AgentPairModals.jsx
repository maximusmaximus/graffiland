import React, { useEffect, useState } from 'react';
import {
  buildAutonomousAgentPrompt,
  buildPropertyOwnerPrompt,
  buildStdioMcpSnippet
} from '../../../../shared/landSignatureMessage.mjs';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import { API_BASE } from '../../utils/api.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { buildMobileLocationAgentPrompt } from '../../utils/mobileAgentPrompt.js';
import { useSafeBackdropClose } from '../../utils/modalBackdropGuard.js';
import { parseDesktopPairQrText } from '../../utils/qrPairScanner.js';
import { GlobalNotificationBell } from '../NotificationCenter.jsx';
import XeroIcon from '../XeroIcon.jsx';
import DesktopQrScanner from './DesktopQrScanner.jsx';

export function PairDesktopMcpModal({
  user,
  videoRef = null,
  onCameraRefreshNeeded = null,
  pairCodeInput,
  setPairCodeInput,
  pairedCode,
  pairError,
  onConnectPairCode,
  onDisconnectDesktopPair,
  mcpPairingsState,
  mcpPairBusy,
  mcpPairNotice,
  setMcpPairNotice,
  onCreateMcpPairing,
  onDisconnectMcpPairing,
  onClose
}) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const apiOrigin = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  const activeCode =
    mcpPairingsState.activePairing?.code ||
    mcpPairingsState.pairings?.find((p) => p.status === 'pending')?.code ||
    '';

  const handleDesktopConnect = (rawInput) => {
    const parsed = parseDesktopPairQrText(rawInput);
    if (parsed?.kind === 'desktop') {
      setPairCodeInput(parsed.code);
      onConnectPairCode(parsed.code);
      setScannerOpen(false);
      return;
    }
    onConnectPairCode(rawInput);
  };

  const backdropCloseProps = useSafeBackdropClose(onClose);

  return (
    <div className="modal-backdrop" {...backdropCloseProps}>
      <div className="modal-card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            <XeroIcon emoji="🔗" size={22} /> Pair Desktop &amp; MCP Agent
          </h3>
          <div className="modal-header-actions">
            <GlobalNotificationBell compact />
            <button className="btn" onClick={onClose}>
              <XeroIcon emoji="❌" size={15} />
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            Desktop Live 3D View Pair (6-char or QR)
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
            Scan the QR code from Desktop or enter its 6-character code to mirror your 3D drawing
            live on a big screen.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ width: '100%', marginBottom: 8 }}
            onClick={() => setScannerOpen((v) => !v)}
          >
            <XeroIcon emoji="📷" size={15} />{' '}
            {scannerOpen ? 'Hide QR Scanner' : 'Scan Desktop QR Code'}
          </button>
          {scannerOpen && (
            <div style={{ marginBottom: 8 }}>
              <DesktopQrScanner
                existingVideoRef={videoRef}
                onCameraRefreshNeeded={onCameraRefreshNeeded}
                onDetected={(parsed) => {
                  if (parsed?.kind === 'desktop') {
                    setPairCodeInput(parsed.code);
                    onConnectPairCode(parsed.code);
                    setScannerOpen(false);
                  }
                }}
                onClose={() => setScannerOpen(false)}
              />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              value={pairCodeInput}
              onChange={(e) => setPairCodeInput(e.target.value.toUpperCase())}
              placeholder="ABC123 or Desktop URL"
              maxLength={120}
            />
            <button className="btn btn-primary" onClick={() => handleDesktopConnect(pairCodeInput)}>
              <XeroIcon emoji="🔗" size={16} /> Connect
            </button>
          </div>
          {pairedCode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <div className="badge teal">
                <XeroIcon emoji="✅" size={14} /> Paired to {pairedCode}
              </div>
              {onDisconnectDesktopPair && (
                <button
                  type="button"
                  className="btn btn-xs btn-danger"
                  onClick={onDisconnectDesktopPair}
                >
                  Disconnect
                </button>
              )}
            </div>
          )}
          {pairError && (
            <div style={{ marginTop: 10, color: 'var(--danger)', fontSize: 12 }}>{pairError}</div>
          )}
        </div>

        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>AI Agent Connector (MCP Pairing)</strong>
            <span className={`badge ${mcpPairingsState.mcpActive ? 'teal' : 'gold'}`}>
              {mcpPairingsState.mcpActive
                ? mcpPairingsState.activePairing?.keyConnected
                  ? '🟢 MCP Active · Keys Connected'
                  : '🟢 MCP Active'
                : '🟡 Inactive Until Connected'}
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>
            Copy your Agent Connector prompt or MCP config. MCP tools stay inactive until an AI
            agent connects with your <code>GLP-...</code> code.
          </p>

          {activeCode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="mono" style={{ fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all' }}>
                {mcpPairingsState.activePairing ? 'Active Code: ' : 'Pending Code: '}
                {activeCode}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    const txt = buildPropertyOwnerPrompt({
                      apiOrigin,
                      pairingCode: activeCode,
                      ownerAddress: user?.activeMintRecipient || user?.walletAddress
                    });
                    const ok = await copyToClipboard(txt);
                    setMcpPairNotice(ok ? 'Copied full Agent Connector Prompt!' : 'Copy failed.');
                  }}
                >
                  <XeroIcon emoji="📋" size={14} /> Copy Agent Connector
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={async () => {
                    const ok = await copyToClipboard(buildStdioMcpSnippet({ apiOrigin }));
                    setMcpPairNotice(ok ? 'Copied MCP JSON config!' : 'Copy failed.');
                  }}
                >
                  📋 Copy MCP JSON
                </button>
                {mcpPairingsState.activePairing && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={mcpPairBusy}
                    onClick={() => onDisconnectMcpPairing(mcpPairingsState.activePairing.code)}
                  >
                    Disconnect MCP
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={mcpPairBusy}
                onClick={onCreateMcpPairing}
              >
                <XeroIcon emoji="🔑" size={14} />{' '}
                {mcpPairBusy ? 'Generating...' : 'Generate & Copy Agent Connector'}
              </button>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={async () => {
                    const ok = await copyToClipboard(buildStdioMcpSnippet({ apiOrigin }));
                    setMcpPairNotice(ok ? 'Copied MCP JSON config!' : 'Copy failed.');
                  }}
                >
                  📋 Copy MCP JSON
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={async () => {
                    const ok = await copyToClipboard(buildAutonomousAgentPrompt({ apiOrigin }));
                    setMcpPairNotice(ok ? 'Copied Autonomous Agent Guide!' : 'Copy failed.');
                  }}
                >
                  🤖 Agent Guide
                </button>
              </div>
            </div>
          )}

          {mcpPairNotice && (
            <div className="mono" style={{ marginTop: 8, fontSize: 11, color: 'var(--accent)' }}>
              {mcpPairNotice}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentHandoffModal({
  agentBusy = false,
  agentError = '',
  agentSession = null,
  agentCopied = false,
  setAgentCopied,
  location = null,
  activeLand = null,
  pairingCode = '',
  onRetryGenerateSession = null,
  onRefreshAgentDraft,
  onInspectInAR,
  onPublishOnPhone,
  onNotifyCopied = null,
  onClose
}) {
  const [copyFeedback, setCopyFeedback] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.info-tip-popover')) return;
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const apiOrigin =
    API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
  const publicUrl =
    typeof window !== 'undefined' ? window.location.origin : 'https://spray.land';
  const promptText = buildMobileLocationAgentPrompt({
    location: location || agentSession?.location || null,
    activeLand,
    agentSession,
    pairingCode,
    apiOrigin,
    publicUrl
  });

  const isOnLand = Boolean(activeLand?.parcelId);
  const landDisplayName = isOnLand
    ? resolveLandDisplayName(activeLand, { defaultName: 'Virtual Land' })
    : agentSession?.parcelName || agentSession?.landDisplayName
    ? resolveLandDisplayName(
        { customName: agentSession.parcelName || agentSession.landDisplayName || '' },
        { defaultName: 'Virtual Land' }
      )
    : '';
  const hasCoords =
    Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng));

  const handleCopyPrompt = async () => {
    setCopyFailed(false);
    const ok = await copyToClipboard(promptText);
    setAgentCopied?.(ok);
    if (ok) {
      const msg = isOnLand
        ? `Prompt copied! Paste into your AI agent to add to "${landDisplayName}" or engage here.`
        : 'Prompt copied! Paste into your AI agent to claim new land, build 3D art, or engage here.';
      setCopyFeedback(msg);
      onNotifyCopied?.(msg);
    } else {
      setCopyFailed(true);
      setCopyFeedback('');
    }
  };

  const handleCopyCodeOnly = async () => {
    if (!agentSession?.code) return;
    setCopyFailed(false);
    const ok = await copyToClipboard(agentSession.code);
    setAgentCopied?.(ok);
    if (ok) {
      const msg = `Copied session code ${agentSession.code} to clipboard!`;
      setCopyFeedback(msg);
      onNotifyCopied?.(msg);
    } else {
      setCopyFailed(true);
      setCopyFeedback('');
    }
  };

  const showCopiedState = Boolean(agentCopied || copyFeedback);

  return (
    <div
      className="modal-backdrop mobile-agent-prompt-backdrop is-fullscreen-sheet"
      data-testid="mobile-agent-prompt-modal"
      data-camera-hidden="true"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="modal-card mobile-agent-prompt-card"
        role="dialog"
        aria-modal="true"
        aria-label="Copy AI Agent Prompt"
      >
        <div className="modal-header mobile-catalog-search-header">
          <div className="mobile-catalog-search-heading">
            <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 16 }}>
              <XeroIcon emoji="🤖" size={20} />
              <span>Copy Agent Prompt</span>
            </h3>
            <div
              className="mobile-catalog-camera-paused-note"
              data-testid="mobile-agent-camera-paused-note"
            >
              <XeroIcon emoji="📷" size={11} />
              <span>Camera hidden while configuring your AI agent</span>
            </div>
          </div>
          <div className="modal-header-actions">
            <GlobalNotificationBell compact />
            <button
              type="button"
              className="btn btn-sm mobile-catalog-close-btn"
              data-testid="agent-prompt-close-btn"
              aria-label="Close agent prompt and return to camera"
              onClick={() => onClose?.()}
            >
              <XeroIcon emoji="✕" size={14} />
              <span>Camera</span>
            </button>
          </div>
        </div>

        <div className="mobile-catalog-search-body mobile-agent-prompt-body">
          <div
            className={`card agent-location-context-card ${isOnLand ? 'is-on-land' : 'is-open-spot'}`}
            data-testid="agent-location-context"
            data-on-land={isOnLand ? 'true' : 'false'}
          >
            <div className="agent-location-context-title">
              <XeroIcon emoji={isOnLand ? '📍' : '✨'} size={15} />
              <strong>
                {isOnLand
                  ? `On Land: ${landDisplayName}`
                  : 'Open Spot — Claim New Land or Build Here'}
              </strong>
            </div>
            <p className="agent-location-context-desc">
              {isOnLand
                ? 'Copy this prompt so your AI agent can add 3D models or voxel art to this land, inspect artworks, or engage with it just like a human.'
                : 'Copy this prompt so your AI agent can claim a new 3D land at your spot, add ready-made 3D models or voxel sculptures, or engage with nearby lands like a human.'}
            </p>
            <div className="agent-location-context-meta mono">
              {isOnLand && <span>{activeLand.parcelId}</span>}
              {hasCoords ? (
                <span>
                  {Number(location.lat).toFixed(5)}, {Number(location.lng).toFixed(5)}
                </span>
              ) : (
                <span>GPS acquiring…</span>
              )}
              {agentSession?.code && (
                <span className="badge teal" style={{ fontSize: 10.5 }}>
                  Code: {agentSession.code}
                </span>
              )}
            </div>
          </div>

          <div className="agent-prompt-primary-actions">
            <button
              type="button"
              className={`btn btn-primary agent-copy-prompt-cta ${showCopiedState ? 'is-copied' : ''}`}
              data-testid="copy-agent-prompt-btn"
              onClick={handleCopyPrompt}
            >
              <XeroIcon emoji={showCopiedState ? '✅' : '📋'} size={16} />
              <span>{showCopiedState ? 'Prompt Copied to Clipboard!' : 'Copy Agent Prompt'}</span>
            </button>

            <div className="agent-prompt-secondary-row">
              {agentSession?.code && (
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="copy-agent-code-btn"
                  onClick={handleCopyCodeOnly}
                >
                  <XeroIcon emoji="🔑" size={13} /> Copy Code ({agentSession.code})
                </button>
              )}
              {agentSession?.code && (
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="agent-check-draft-btn"
                  onClick={onRefreshAgentDraft}
                >
                  <XeroIcon emoji="🔄" size={13} /> Check Draft
                </button>
              )}
              {!agentSession?.code && !agentBusy && typeof onRetryGenerateSession === 'function' && (
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="agent-retry-session-btn"
                  onClick={onRetryGenerateSession}
                >
                  <XeroIcon emoji="📍" size={13} /> Generate Location Code
                </button>
              )}
            </div>
          </div>

          {showCopiedState && (
            <div
              className="agent-copy-confirmation"
              data-testid="agent-copy-confirmation"
              role="status"
              aria-live="polite"
            >
              <XeroIcon emoji="✅" size={15} />
              <span>
                {copyFeedback ||
                  'Prompt copied to clipboard! Paste it into your AI agent to add to this land, claim new land, or engage here.'}
              </span>
            </div>
          )}

          {copyFailed && (
            <div
              className="status-banner status-banner-error"
              data-testid="agent-copy-error"
              role="alert"
              style={{ fontSize: 12 }}
            >
              ⚠️ Browser blocked automatic clipboard access — long-press and copy the prompt box below.
            </div>
          )}

          {agentBusy && (
            <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
              ⏳ Locking live GPS location code… (you can already copy the prompt above)
            </div>
          )}

          {agentError && (
            <div
              className="status-banner"
              data-testid="agent-session-notice"
              style={{ fontSize: 12, color: '#ffd166' }}
            >
              <XeroIcon emoji="⚠️" size={13} /> {agentError} — You can still copy the general Agent Prompt above.
            </div>
          )}

          {agentSession?.status === 'ready' && (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>
                ✨ Agent staged {agentSession.voxelCount || agentSession.draftVoxels?.length || 0} blocks!
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={onInspectInAR}>
                  <XeroIcon emoji="👁️" size={14} /> Inspect in AR
                </button>
                <button type="button" className="btn btn-pink btn-sm" onClick={onPublishOnPhone}>
                  <XeroIcon emoji="🚀" size={14} /> Publish on Phone
                </button>
              </div>
            </div>
          )}

          <div className="agent-prompt-preview-box">
            <div className="agent-prompt-preview-label">
              <span>Prompt Preview (includes land, GPS, 3D Catalog &amp; MCP instructions)</span>
            </div>
            <pre
              className="agent-prompt-preview mono"
              data-testid="agent-prompt-preview"
            >
              {promptText}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SavedDraftsModal({
  user,
  title,
  description,
  voxelsLength,
  activeDraftId,
  draftStatusText,
  draftsBusy,
  draftError,
  cloudDrafts,
  onManualSaveDraft,
  onStartNewDraft,
  onLoadDraft,
  onDeleteCloudDraft,
  onOpenLogin,
  onClose
}) {
  const backdropCloseProps = useSafeBackdropClose(onClose);
  return (
    <div className="modal-backdrop" {...backdropCloseProps}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            <XeroIcon emoji="💾" size={22} /> Saved Drafts
          </h3>
          <div className="modal-header-actions">
            <GlobalNotificationBell compact />
            <button className="btn" onClick={onClose}>
              <XeroIcon emoji="❌" size={15} />
            </button>
          </div>
        </div>

        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
          Your canvas auto-saves on this device as you work, and syncs to your account when
          signed in so you never lose unfinished sculptures before publishing.
        </p>

        <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ fontSize: 13 }}>
                {title.trim() || 'Current Workspace Draft'}
              </strong>
              <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                {voxelsLength} blocks · {draftStatusText || 'Ready'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={draftsBusy || (voxelsLength === 0 && !title.trim() && !description.trim())}
                onClick={() => onManualSaveDraft({ forceNew: false })}
              >
                <XeroIcon emoji="💾" size={14} /> Save Draft
              </button>
              {user && activeDraftId && (
                <button
                  type="button"
                  className="btn"
                  disabled={draftsBusy || (voxelsLength === 0 && !title.trim() && !description.trim())}
                  onClick={() => onManualSaveDraft({ forceNew: true })}
                >
                  <XeroIcon emoji="📄" size={14} /> Save Copy
                </button>
              )}
              <button type="button" className="btn" onClick={onStartNewDraft}>
                <XeroIcon emoji="📝" size={14} /> New Blank
              </button>
            </div>
          </div>
          {!user && (
            <button
              type="button"
              className="btn"
              style={{ alignSelf: 'flex-start' }}
              onClick={onOpenLogin}
            >
              <XeroIcon emoji="🔐" size={14} /> Sign in with Google to Sync Cloud Drafts
            </button>
          )}
        </div>

        {draftError && (
          <div style={{ color: '#ffb3c1', fontSize: 12, marginBottom: 10 }}>
            <XeroIcon emoji="⚠️" size={14} /> {draftError}
          </div>
        )}

        {user && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>Cloud Saved Drafts ({cloudDrafts.length})</strong>
            </div>

            {cloudDrafts.length === 0 ? (
              <div className="card" style={{ padding: 14, fontSize: 12, color: 'var(--muted)' }}>
                {draftsBusy
                  ? 'Loading cloud drafts...'
                  : 'No cloud drafts yet. Start sculpting or tap Save Draft to back up your work.'}
              </div>
            ) : (
              cloudDrafts.map((d) => (
                <div
                  key={d.id}
                  className="card"
                  style={{
                    padding: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    borderColor: d.id === activeDraftId ? 'var(--accent)' : undefined
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.title || 'Untitled Draft'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      <span className="badge teal">
                        <XeroIcon emoji="🧱" size={11} /> {d.voxelCount} blocks
                      </span>
                      {(d.parcelName || d.landDisplayName) && (
                        <span className="badge">
                          <XeroIcon emoji="📍" size={11} />{' '}
                          {resolveLandDisplayName(
                            { customName: d.parcelName || d.landDisplayName || '' },
                            { defaultName: 'Virtual Land' }
                          )}
                        </span>
                      )}
                      <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>
                        {d.updatedAt ? new Date(d.updatedAt).toLocaleString() : ''}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={draftsBusy}
                      onClick={() => onLoadDraft(d)}
                    >
                      <XeroIcon emoji="📂" size={13} /> Load
                    </button>
                    <button
                      type="button"
                      className="btn btn-pink"
                      disabled={draftsBusy}
                      onClick={() => onDeleteCloudDraft(d.id)}
                      aria-label={`Delete draft ${d.title || d.id}`}
                    >
                      <XeroIcon emoji="🗑️" size={13} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
