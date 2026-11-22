import React, { useState } from 'react';
import {
  buildAutonomousAgentPrompt,
  buildPropertyOwnerPrompt,
  buildStdioMcpSnippet
} from '../../../../shared/landSignatureMessage.mjs';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import { API_BASE } from '../../utils/api.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { parseDesktopPairQrText } from '../../utils/qrPairScanner.js';
import XeroIcon from '../XeroIcon.jsx';
import DesktopQrScanner from './DesktopQrScanner.jsx';

export function PairDesktopMcpModal({
  user,
  videoRef = null,
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            <XeroIcon emoji="🔗" size={22} /> Pair Desktop &amp; MCP Agent
          </h3>
          <button className="btn" onClick={onClose}>
            <XeroIcon emoji="❌" size={15} />
          </button>
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
  agentBusy,
  agentError,
  agentSession,
  agentCopied,
  setAgentCopied,
  onRefreshAgentDraft,
  onInspectInAR,
  onPublishOnPhone,
  onClose
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            <XeroIcon emoji="🤖" size={22} /> Agent Sculpture Code
          </h3>
          <button className="btn" onClick={onClose}>
            <XeroIcon emoji="❌" size={15} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
          Give this location-locked code to your AI agent so it can read our 4x voxel tools,
          12 colors, and 3 block types to build a 3D sculpture here. You must inspect and tap{' '}
          <strong>Publish</strong> on your phone to mint.
        </p>

        {agentBusy && (
          <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
            Generating location code...
          </div>
        )}

        {agentError && (
          <div style={{ color: '#ffb3c1', fontSize: 12, marginBottom: 8 }}>
            <XeroIcon emoji="⚠️" size={14} /> {agentError}
          </div>
        )}

        {agentSession?.code && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.06em' }}>
                  {agentSession.code}
                </span>
                <span className={`badge ${agentSession.status === 'ready' ? 'teal' : 'gold'}`}>
                  {agentSession.status === 'ready'
                    ? `Loaded ${agentSession.voxelCount || agentSession.draftVoxels?.length || 0} voxels`
                    : 'Waiting for agent build...'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {resolveLandDisplayName(
                  { customName: agentSession.parcelName || agentSession.landDisplayName || '' },
                  { defaultName: 'Virtual Land' }
                )}{' '}
                · 4x (0.05m/block) · 10000×10000×10000 limit
              </div>
              {agentSession.endpoints?.spec && (
                <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>
                  Spec: <span className="mono">{agentSession.endpoints.spec}</span>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  const ok = await copyToClipboard(agentSession.clipboardText);
                  setAgentCopied(ok);
                }}
              >
                <XeroIcon emoji="📋" size={15} />{' '}
                {agentCopied ? 'Copied Prompt & Code!' : 'Copy Agent Prompt & Code'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const ok = await copyToClipboard(agentSession.code);
                  setAgentCopied(ok);
                }}
              >
                Copy Code Only
              </button>
              <button type="button" className="btn" onClick={onRefreshAgentDraft}>
                <XeroIcon emoji="🔄" size={15} /> Check Draft
              </button>
            </div>

            {agentSession.status === 'ready' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary" onClick={onInspectInAR}>
                  <XeroIcon emoji="👁️" size={15} /> Inspect in AR
                </button>
                <button type="button" className="btn btn-pink" onClick={onPublishOnPhone}>
                  <XeroIcon emoji="🚀" size={15} /> Publish on Phone
                </button>
              </div>
            )}
          </div>
        )}
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
  onRefreshCloudDrafts,
  onLoadDraft,
  onDeleteCloudDraft,
  onOpenLogin,
  onClose
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            <XeroIcon emoji="💾" size={22} /> Saved Drafts
          </h3>
          <button className="btn" onClick={onClose}>
            <XeroIcon emoji="❌" size={15} />
          </button>
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
              <button
                type="button"
                className="btn"
                disabled={draftsBusy}
                onClick={onRefreshCloudDrafts}
              >
                <XeroIcon emoji="🔄" size={13} /> Refresh
              </button>
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
