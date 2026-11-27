import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildAutonomousAgentPrompt,
  buildPropertyOwnerPrompt,
  buildStdioMcpSnippet
} from '../../../../shared/landSignatureMessage.mjs';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import { API_BASE } from '../../utils/api.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { parseDesktopPairQrText } from '../../utils/qrPairScanner.js';
import { isPendingSculptureAction } from '../../utils/pendingApprovalPreview.js';
import InfoTip from '../InfoTip.jsx';
import XeroIcon from '../XeroIcon.jsx';
import DesktopQrScanner from './DesktopQrScanner.jsx';

function formatRelativeTime(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatExpiresIn(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const remainMin = Math.max(0, Math.ceil((ts - Date.now()) / 60000));
  if (remainMin === 0) return 'expiring soon';
  return `${remainMin}m left`;
}

function getActionEmoji(action = '') {
  if (action === 'create_sculpture' || action === 'publish_sculpture') return '🎨';
  if (action === 'update_sculpture' || action === 'rollback_sculpture_revision') return '🛠️';
  if (action === 'set_sculpture_visibility') return '👁️';
  if (action === 'delete_sculpture' || action === 'erase_land') return '🗑️';
  if (action === 'update_land_settings') return '❄️';
  if (action === 'update_land_volume') return '📐';
  if (action === 'update_parcel') return '🏷️';
  return '✍️';
}

function fallbackSummary(item) {
  const title =
    item?.summaryTitle ||
    String(item?.action || 'Land Action')
      .replace(/_/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase());
  const desc =
    item?.summaryDescription ||
    item?.payload?.description ||
    item?.payload?.reason ||
    `Execute ${String(item?.action || 'action').replace(/_/g, ' ')} on ${resolveLandDisplayName(
      { customName: item?.parcelName || item?.landDisplayName || '' },
      { defaultName: 'your land' }
    )}.`;
  return { title, desc };
}

export default function MobilePairApprovalDropdown({
  open,
  activeTab,
  onSelectTab,
  onClose,
  user,
  onOpenLogin,
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
  repairNotice = null,
  onDismissRepairNotice = null,
  onCreateMcpPairing,
  onDisconnectMcpPairing,
  onOpenAgentHandoff,
  pendingSignatures = [],
  signatureHistory = [],
  pendingSigBusyId = '',
  pendingSigErrors = {},
  onMobileSignPending,
  onMobileRejectPending,
  onPreviewPending = null,
  onNavigateToLand = null,
  onRefreshSignatures
}) {
  const panelRef = useRef(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [lastApprovedBanner, setLastApprovedBanner] = useState(null);

  useEffect(() => {
    if (!open) {
      setScannerOpen(false);
      setLastApprovedBanner(null);
      return undefined;
    }
    onRefreshSignatures?.({ includeHistory: true });
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    const onOutside = (e) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        !e.target.closest?.('[data-pair-hub-trigger="1"]')
      ) {
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
    };
  }, [open, onClose, onRefreshSignatures]);

  const apiOrigin = useMemo(
    () => API_BASE || (typeof window !== 'undefined' ? window.location.origin : ''),
    []
  );

  const activeMcpCode =
    mcpPairingsState?.activePairing?.code ||
    mcpPairingsState?.pairings?.find((p) => p.status === 'pending')?.code ||
    '';

  if (!open) return null;

  const flashCopy = (msg) => {
    setCopyStatus(msg);
    setTimeout(() => setCopyStatus((prev) => (prev === msg ? '' : prev)), 3200);
  };

  const handleDesktopConnect = (rawInput) => {
    const parsed = parseDesktopPairQrText(rawInput);
    if (parsed?.kind === 'desktop') {
      setPairCodeInput?.(parsed.code);
      onConnectPairCode?.(parsed.code);
      setScannerOpen(false);
      flashCopy(`Connecting to Desktop ${parsed.code}…`);
      return;
    }
    const clean = String(rawInput || '').trim().toUpperCase();
    if (clean) {
      onConnectPairCode?.(clean);
    }
  };

  const handleQrDetected = (parsed) => {
    if (!parsed?.code) return;
    if (parsed.kind === 'desktop') {
      setPairCodeInput?.(parsed.code);
      onConnectPairCode?.(parsed.code);
      setScannerOpen(false);
      flashCopy(`✅ Scanned Desktop code ${parsed.code}`);
    } else if (parsed.kind === 'mcp') {
      setScannerOpen(false);
      copyToClipboard(parsed.code).then(() => {
        flashCopy(`✅ Scanned MCP code ${parsed.code} (copied)`);
      });
    }
  };

  const handleCopyAgentConnector = async () => {
    if (!user) {
      onOpenLogin?.();
      return;
    }
    if (!activeMcpCode) {
      await onCreateMcpPairing?.();
      return;
    }
    const txt = buildPropertyOwnerPrompt({
      apiOrigin,
      pairingCode: activeMcpCode,
      ownerAddress: user?.activeMintRecipient || user?.walletAddress
    });
    const ok = await copyToClipboard(txt);
    setMcpPairNotice?.(ok ? 'Copied full Agent Connector Prompt!' : 'Copy failed — try again.');
    flashCopy(ok ? '✅ Copied Agent Connector Prompt!' : 'Could not copy to clipboard.');
  };

  const handleCopyMcpJson = async () => {
    const snippet = buildStdioMcpSnippet({ apiOrigin });
    const ok = await copyToClipboard(snippet);
    flashCopy(ok ? '✅ Copied MCP JSON config!' : 'Could not copy MCP JSON.');
  };

  const handleCopyAutonomousGuide = async () => {
    const txt = buildAutonomousAgentPrompt({
      apiOrigin,
      publicUrl: typeof window !== 'undefined' ? window.location.origin + window.location.pathname : ''
    });
    const ok = await copyToClipboard(txt);
    flashCopy(ok ? '✅ Copied Autonomous Agent Guide!' : 'Could not copy guide.');
  };

  const connectionSummary = pairedCode
    ? `Desktop ${pairedCode}`
    : mcpPairingsState?.mcpActive
    ? 'MCP Active'
    : 'Ready to Pair';

  const handleApproveAndTrack = async (item, options = {}) => {
    const res = await onMobileSignPending?.(item, options);
    if (res?.ok !== false && res) {
      const targetParcelId = String(
        res?.result?.sculpture?.parcelId ||
          res?.result?.parcel?.parcelId ||
          res?.request?.parcelId ||
          item?.parcelId ||
          ''
      ).trim();
      const { title } = fallbackSummary(item);
      setLastApprovedBanner({
        title,
        parcelId: targetParcelId
      });
    }
  };

  return (
    <div
      ref={panelRef}
      className="mobile-pair-dropdown hud-interactive"
      role="dialog"
      aria-label="Mobile Pairing and Approvals"
      data-testid="mobile-pair-dropdown"
    >
      <div className="mobile-pair-dropdown-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <XeroIcon emoji="🔗" size={16} />
          <strong style={{ fontSize: 13.5 }}>Pair &amp; Approvals</strong>
          <span
            className={`badge ${
              pairedCode || mcpPairingsState?.mcpActive ? 'teal' : 'gold'
            }`}
            style={{ fontSize: 10, padding: '2px 7px' }}
          >
            {connectionSummary}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          aria-label="Close Pairing and Approvals"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="mobile-pair-tabs" role="tablist" aria-label="Pairing and approval sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'pending'}
          className={`mobile-pair-tab ${activeTab === 'pending' ? 'active' : ''}`}
          onClick={() => onSelectTab('pending')}
        >
          <span>🔔 Pending</span>
          {pendingSignatures.length > 0 && (
            <span className="mobile-pair-tab-pill is-alert">{pendingSignatures.length}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'pair'}
          className={`mobile-pair-tab ${activeTab === 'pair' ? 'active' : ''}`}
          onClick={() => onSelectTab('pair')}
        >
          <span>🔗 Pair</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
          className={`mobile-pair-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => {
            onSelectTab('history');
            onRefreshSignatures?.({ includeHistory: true });
          }}
        >
          <span>📜 History</span>
          {signatureHistory.length > 0 && (
            <span className="mobile-pair-tab-pill">{signatureHistory.length}</span>
          )}
        </button>
      </div>

      <div className="mobile-pair-dropdown-body">
        {activeTab === 'pending' && (
          <div className="mobile-approval-list" data-testid="mobile-pending-list">
            {lastApprovedBanner && (
              <div
                className="settings-inline-saved notif-settings-saved-pill notif-approval-status-bar"
                data-testid="mobile-approval-success-banner"
                role="status"
              >
                <span className="notif-approval-status-text">
                  ✅ Approved &amp; minted{' '}
                  {lastApprovedBanner.title.includes('"')
                    ? lastApprovedBanner.title
                    : `"${lastApprovedBanner.title}"`}
                  !
                </span>
                {lastApprovedBanner.parcelId && onNavigateToLand && (
                  <button
                    type="button"
                    className="btn btn-xs btn-primary notif-approved-go-land-btn"
                    data-testid="mobile-approval-go-land-btn"
                    onClick={() => {
                      const pid = lastApprovedBanner.parcelId;
                      onClose?.();
                      onNavigateToLand(pid);
                    }}
                  >
                    📍 Go to Land →
                  </button>
                )}
              </div>
            )}
            {!user ? (
              <div className="mobile-pair-empty">
                <div>Sign in to view and approve AI agent requests for your land.</div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    onClose?.();
                    onOpenLogin?.();
                  }}
                >
                  🔐 Sign In
                </button>
              </div>
            ) : pendingSignatures.length === 0 ? (
              <div className="mobile-pair-empty">
                <div style={{ fontWeight: 600, color: 'var(--text)' }}>No pending approvals</div>
                <div>
                  When a paired AI agent requests a land edit, 3D placement, or signature, it will
                  appear here for you to approve or reject.
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-xs btn-primary"
                    onClick={() => onSelectTab('pair')}
                  >
                    🔗 Pair Agent / Desktop
                  </button>
                  {signatureHistory.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      onClick={() => onSelectTab('history')}
                    >
                      📜 View History ({signatureHistory.length})
                    </button>
                  )}
                </div>
              </div>
            ) : (
              pendingSignatures.map((item) => {
                const busy = pendingSigBusyId === item.id;
                const { title, desc } = fallbackSummary(item);
                const isExpanded = expandedId === item.id;
                const itemError = pendingSigErrors?.[item.id] || null;
                const canAutoFit =
                  itemError?.code === 'exceeds_land_bounds' &&
                  Number(itemError?.maxSafeScale) >= 0.001;
                return (
                  <div
                    key={item.id}
                    className="mobile-approval-card is-pending"
                    data-testid="mobile-pending-item"
                  >
                    <div className="mobile-approval-card-head">
                      <span className="mobile-approval-title">
                        <XeroIcon emoji={getActionEmoji(item.action)} size={14} />
                        <span>{title}</span>
                      </span>
                      <span className="mobile-approval-time">{formatExpiresIn(item.expiresAt)}</span>
                    </div>

                    <div className="mobile-approval-meta">
                      <span>🤖 {item.agentName || 'MCP Agent'}</span>
                      <span>·</span>
                      <span>
                        {resolveLandDisplayName(
                          { customName: item.parcelName || item.landDisplayName || '' },
                          { defaultName: 'Virtual Land' }
                        )}
                      </span>
                    </div>

                    <p className="mobile-approval-desc">{desc}</p>

                    {itemError?.message && (
                      <div
                        className="approval-inline-error"
                        data-testid="mobile-approval-error"
                        role="alert"
                      >
                        <div className="approval-inline-error-msg">⚠️ {itemError.message}</div>
                        {canAutoFit && (
                          <button
                            type="button"
                            className="btn btn-xs btn-primary"
                            data-testid="mobile-autofit-approve-btn"
                            disabled={busy}
                            onClick={() => handleApproveAndTrack(item, { autoFitScale: true })}
                          >
                            {busy
                              ? 'Fitting & Placing…'
                              : `📐 Auto-Fit (${itemError.maxSafeScale}×) & Approve`}
                          </button>
                        )}
                      </div>
                    )}

                    {isExpanded && (
                      <div className="mobile-approval-details mono">
                        <div>Action: {item.action}</div>
                        <div>Request: {item.id}</div>
                        {item.sculptureId && <div>Sculpture: {item.sculptureId}</div>}
                        {item.pairingCode && <div>Pair: {item.pairingCode}</div>}
                      </div>
                    )}

                    <div className="mobile-approval-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        onClick={() => handleApproveAndTrack(item)}
                      >
                        {busy ? 'Approving…' : '✅ Yes, Approve'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => onMobileRejectPending?.(item.id)}
                      >
                        {busy ? 'Working…' : '✕ No, Reject'}
                      </button>
                      {onPreviewPending && isPendingSculptureAction(item.action) && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          data-testid="mobile-approval-preview-btn"
                          onClick={() => {
                            onClose?.();
                            onPreviewPending(item);
                          }}
                        >
                          👁️ Preview
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setExpandedId(isExpanded ? '' : item.id)}
                      >
                        {isExpanded ? 'Hide' : 'Details'}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'pair' && (
          <div className="mobile-pair-sections" data-testid="mobile-pair-panel">
            {(repairNotice || mcpPairingsState?.needsRepair || mcpPairingsState?.expiringSoon) && (
              <div
                className="mobile-repair-banner"
                data-testid="mobile-repair-banner"
                role="alert"
              >
                <div className="mobile-repair-banner-text">
                  <strong>🔗 Re-pair Needed</strong>
                  <span>
                    {repairNotice?.message ||
                      (mcpPairingsState?.expiringSoon
                        ? 'Your AI agent pairing expires soon — generate a fresh code to stay connected.'
                        : 'Your previous pairing expired or disconnected — generate a fresh code or scan Desktop QR to re-pair.')}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {repairNotice?.kind === 'desktop' ? (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      onClick={() => setScannerOpen(true)}
                    >
                      📷 Scan QR to Re-pair
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      disabled={mcpPairBusy}
                      onClick={() => onCreateMcpPairing?.()}
                    >
                      {mcpPairBusy ? 'Generating…' : '🔑 Generate Fresh Code'}
                    </button>
                  )}
                  {onDismissRepairNotice && repairNotice && (
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={onDismissRepairNotice}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Section 1: Desktop Live Mirror + QR Scanner */}
            <div className="mobile-pair-card">
              <div className="mobile-pair-card-head">
                <strong style={{ fontSize: 12.5 }}>Desktop Live 3D Pair</strong>
                <InfoTip title="Desktop Live Mirror" align="right">
                  Scan the QR code on Desktop → Pairing (or type its 6-character code) to mirror
                  your mobile 3D brush live on a big screen.
                </InfoTip>
              </div>

              {pairedCode ? (
                <div className="mobile-pair-connected-row">
                  <button
                    type="button"
                    className="badge teal pair-code-copy-pill"
                    data-testid="mobile-desktop-code-value"
                    title="Tap to copy Desktop pair code"
                    aria-label={`Copy Desktop pair code ${pairedCode}`}
                    onClick={async () => {
                      const ok = await copyToClipboard(pairedCode);
                      flashCopy(ok ? `✅ Copied ${pairedCode}` : 'Copy failed.');
                    }}
                  >
                    <XeroIcon emoji="✅" size={12} /> Paired to {pairedCode}{' '}
                    <span aria-hidden="true">📋</span>
                  </button>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      data-testid="mobile-desktop-code-copy-btn"
                      aria-label="Copy Desktop pair code"
                      title="Copy Desktop pair code"
                      onClick={async () => {
                        const ok = await copyToClipboard(pairedCode);
                        flashCopy(ok ? `✅ Copied ${pairedCode}` : 'Copy failed.');
                      }}
                    >
                      <XeroIcon emoji="📋" size={12} /> Copy
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-danger"
                      onClick={onDisconnectDesktopPair}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    style={{ width: '100%' }}
                    onClick={() => setScannerOpen((v) => !v)}
                  >
                    <XeroIcon emoji="📷" size={15} />{' '}
                    {scannerOpen ? 'Hide QR Scanner' : 'Scan Desktop QR Code'}
                  </button>

                  {scannerOpen && (
                    <DesktopQrScanner
                      existingVideoRef={videoRef}
                      onCameraRefreshNeeded={onCameraRefreshNeeded}
                      onDetected={handleQrDetected}
                      onClose={() => setScannerOpen(false)}
                    />
                  )}

                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input
                      className="input mono"
                      style={{ flex: 1, minWidth: 0, padding: '6px 9px', fontSize: 12 }}
                      aria-label="Desktop pair code"
                      value={pairCodeInput}
                      onChange={(e) => setPairCodeInput(e.target.value.toUpperCase())}
                      placeholder="6-char code or URL"
                      maxLength={120}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={() => handleDesktopConnect(pairCodeInput)}
                    >
                      Connect
                    </button>
                  </div>
                </>
              )}

              {pairError && (
                <div style={{ color: '#ff99ac', fontSize: 11.5, marginTop: 4 }}>{pairError}</div>
              )}
            </div>

            {/* Section 2: Agent Connector & MCP Pairing */}
            <div className="mobile-pair-card">
              <div className="mobile-pair-card-head">
                <strong style={{ fontSize: 12.5 }}>AI Agent Connector (MCP)</strong>
                <span
                  className={`badge ${mcpPairingsState?.mcpActive ? 'teal' : 'gold'}`}
                  style={{ fontSize: 10, padding: '2px 6px', marginLeft: 'auto' }}
                >
                  {mcpPairingsState?.mcpActive
                    ? mcpPairingsState.activePairing?.keyConnected
                      ? '🟢 Keys Live'
                      : '🟢 Active'
                    : '🟡 Standby'}
                </span>
                <InfoTip title="Agent Connector & Approvals" align="right">
                  Copy your connector prompt or MCP config into Claude, Cursor, or OpenClaw. If
                  your agent does not hold your wallet key, every edit lands in your Pending tab
                  here for one-tap Yes/No approval.
                </InfoTip>
              </div>

              {activeMcpCode && (
                <div className="mobile-mcp-code-row">
                  <button
                    type="button"
                    className="mobile-mcp-code-btn mono"
                    data-testid="mobile-mcp-code-value"
                    title="Tap to copy pairing code"
                    aria-label={`Copy pairing code ${activeMcpCode}`}
                    onClick={async () => {
                      const ok = await copyToClipboard(activeMcpCode);
                      flashCopy(ok ? `✅ Copied ${activeMcpCode}` : 'Copy failed.');
                    }}
                  >
                    <span>{activeMcpCode}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs btn-outline"
                    data-testid="mobile-mcp-code-copy-btn"
                    aria-label="Copy pairing code"
                    title="Copy pairing code"
                    onClick={async () => {
                      const ok = await copyToClipboard(activeMcpCode);
                      flashCopy(ok ? `✅ Copied ${activeMcpCode}` : 'Copy failed.');
                    }}
                  >
                    <XeroIcon emoji="📋" size={12} /> Copy
                  </button>
                </div>
              )}

              <button
                type="button"
                className="btn btn-sm btn-primary"
                style={{ width: '100%' }}
                disabled={mcpPairBusy}
                onClick={handleCopyAgentConnector}
              >
                <XeroIcon emoji="📋" size={14} />{' '}
                {mcpPairBusy
                  ? 'Generating…'
                  : activeMcpCode
                  ? 'Copy Agent Connector Prompt'
                  : 'Generate & Copy Agent Connector'}
              </button>

              <div className="mobile-pair-secondary-grid">
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={handleCopyMcpJson}
                >
                  📋 MCP JSON
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-outline"
                  onClick={handleCopyAutonomousGuide}
                >
                  🤖 Agent Guide
                </button>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {onOpenAgentHandoff && (
                  <button
                    type="button"
                    className="btn btn-xs btn-outline"
                    style={{ flex: 1 }}
                    onClick={() => {
                      onClose?.();
                      onOpenAgentHandoff();
                    }}
                  >
                    <XeroIcon emoji="🤖" size={12} /> Agent Sculpture Code
                  </button>
                )}
                {mcpPairingsState?.activePairing && (
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    disabled={mcpPairBusy}
                    onClick={() => onDisconnectMcpPairing?.(mcpPairingsState.activePairing.code)}
                  >
                    Disconnect MCP
                  </button>
                )}
              </div>

              {(copyStatus || mcpPairNotice) && (
                <div className="mono" style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4 }}>
                  {copyStatus || mcpPairNotice}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="mobile-approval-list" data-testid="mobile-history-list">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                Past approved, rejected &amp; expired items
              </span>
            </div>

            {!user ? (
              <div className="mobile-pair-empty">Sign in to view approval history.</div>
            ) : signatureHistory.length === 0 ? (
              <div className="mobile-pair-empty">
                No past approval items yet. Items you approve or reject will be logged here.
              </div>
            ) : (
              signatureHistory.map((item) => {
                const { title, desc } = fallbackSummary(item);
                const statusBadge =
                  item.status === 'executed'
                    ? { cls: 'teal', label: '✅ Approved' }
                    : item.status === 'rejected'
                    ? { cls: 'crimson', label: '❌ Rejected' }
                    : { cls: 'gold', label: '⏱️ Expired' };
                return (
                  <div
                    key={item.id}
                    className={`mobile-approval-card is-history status-${item.status}`}
                    data-testid="mobile-history-item"
                  >
                    <div className="mobile-approval-card-head">
                      <span className="mobile-approval-title">
                        <XeroIcon emoji={getActionEmoji(item.action)} size={13} />
                        <span>{title}</span>
                      </span>
                      <span className={`badge ${statusBadge.cls}`} style={{ fontSize: 10, padding: '2px 6px' }}>
                        {statusBadge.label}
                      </span>
                    </div>
                    <p className="mobile-approval-desc">{desc}</p>
                    <div className="mobile-approval-meta">
                      <span>🤖 {item.agentName || item.requestedBy || 'Agent'}</span>
                      <span>·</span>
                      <span>
                        {resolveLandDisplayName(
                          { customName: item.parcelName || item.landDisplayName || '' },
                          { defaultName: 'Virtual Land' }
                        )}
                      </span>
                      {item.signedBy && (
                        <>
                          <span>·</span>
                          <span>{item.signedBy}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>{formatRelativeTime(item.updatedAt || item.createdAt)}</span>
                    </div>
                    {item.status === 'executed' && item.parcelId && onNavigateToLand && (
                      <div className="mobile-approval-actions" style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          data-testid="mobile-history-go-land-btn"
                          onClick={() => {
                            onClose?.();
                            onNavigateToLand(item.parcelId);
                          }}
                        >
                          📍 Go to Land →
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
