import React, { useMemo, useState } from 'react';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import {
  buildSculptureShareUrl,
  buildShareToXUrl,
  copyToClipboard
} from '../../utils/clipboard.js';
import { isWebAuthnSupported } from '../../utils/passkeyClient.js';
import { useSafeBackdropClose } from '../../utils/modalBackdropGuard.js';
import { EmojiInput, EmojiTextarea } from '../EmojiField.jsx';
import { GlobalNotificationBell } from '../NotificationCenter.jsx';
import XeroIcon from '../XeroIcon.jsx';

export default function PublishSculptureModal({
  config,
  user,
  voxels,
  placedCatalogItem = null,
  polStats,
  location,
  orbStatus,
  activeQuest = null,
  selectedPlinthSlot = null,
  activeTargetLand = null,
  passkeyCount,
  passkeyBusy,
  onEnrollPasskey,
  title,
  setTitle,
  description,
  setDescription,
  cluePrompt,
  setCluePrompt,
  clueAnswer,
  setClueAnswer,
  termsAccepted,
  setTermsAccepted,
  publishing,
  publishError,
  setPublishError,
  mintReceipt,
  mcpPairingsState,
  agentPublishPrompt,
  draftsBusy,
  draftStatusText,
  onSubmitPublish,
  onCopyAgentPublishPrompt,
  onManualSaveDraft,
  onOpenInfo,
  onOpenPair,
  onOpenManageLand,
  onViewInARPreview,
  onRequestLogin = null,
  onShowHint,
  onClose
}) {
  const policy = config?.policy;
  const wordCount = useMemo(
    () => (description.trim() ? description.trim().split(/\s+/).filter(Boolean).length : 0),
    [description]
  );
  const targetLandName = activeTargetLand
    ? resolveLandDisplayName(activeTargetLand, { defaultName: 'Virtual Land' })
    : '';
  const targetLandFrozen = Boolean(activeTargetLand?.isFrozen);
  const backdropCloseProps = useSafeBackdropClose(onClose);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);

  return (
    <div className="modal-backdrop" {...backdropCloseProps}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            {activeTargetLand && !mintReceipt ? (
              <>
                <XeroIcon emoji={targetLandFrozen ? '❄️' : '🎨'} size={22} />{' '}
                {targetLandFrozen ? `Frozen Land: ${targetLandName}` : `Add Art to ${targetLandName}`}
              </>
            ) : (
              <>
                <XeroIcon emoji="🚀" size={22} /> Publish to IPFS &amp; Robinhood Chain
              </>
            )}
          </h3>
          <div className="modal-header-actions">
            <GlobalNotificationBell compact testId="publish-modal-notif-bell-btn" />
            {mintReceipt?.sculpture?.id && (
              <button
                type="button"
                className={`btn ${shareLinkCopied ? 'is-copy-confirmed' : ''}`}
                data-testid="publish-header-copy-link-btn"
                aria-label="Copy shareable link to published sculpture"
                title="Copy shareable link to published sculpture"
                onClick={async () => {
                  const ok = await copyToClipboard(buildSculptureShareUrl(mintReceipt.sculpture.id));
                  if (ok) {
                    setShareLinkCopied(true);
                    setTimeout(() => setShareLinkCopied(false), 1800);
                  }
                  onShowHint?.(ok ? 'Copied shareable deep link!' : 'Copy unavailable');
                }}
              >
                {shareLinkCopied ? '✓' : <XeroIcon emoji="📋" size={16} />}
              </button>
            )}
            <button className="btn" onClick={onClose} aria-label="Close publish sheet">
              <XeroIcon emoji="❌" size={15} />
            </button>
          </div>
        </div>

        {mintReceipt ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
              <XeroIcon emoji="✅" size={15} />{' '}
              {mintReceipt.addedToExistingLand
                ? `Added art to "${resolveLandDisplayName(
                    {
                      customName: mintReceipt.sculpture.parcelName || '',
                      displayName:
                        mintReceipt.landDisplayName || mintReceipt.sculpture.landDisplayName || '',
                      firstSculptureTitle: mintReceipt.sculpture.title || ''
                    },
                    { defaultName: 'Virtual Land' }
                  )}" & minted NFT!`
                : 'Minted directly to your wallet!'}
            </div>
            <div className="card" style={{ fontSize: 12 }}>
              <div><strong>Title:</strong> {mintReceipt.sculpture.title}</div>
              <div>
                <strong>Virtual Land:</strong>{' '}
                <span>
                  {resolveLandDisplayName(
                    {
                      customName: mintReceipt.sculpture.parcelName || '',
                      displayName: mintReceipt.sculpture.landDisplayName || '',
                      firstSculptureTitle: mintReceipt.sculpture.title || ''
                    },
                    { defaultName: 'Virtual Land' }
                  )}
                </span>
              </div>
              <div><strong>Token ID:</strong> <span className="mono">#{mintReceipt.mint.tokenId}</span></div>
              <div><strong>Resale Fee:</strong> 5% (ERC-2981)</div>
              <div style={{ wordBreak: 'break-all' }}>
                <strong>IPFS CID:</strong> <span className="mono">{mintReceipt.ipfs.metadataCid}</span>
              </div>
              <div style={{ wordBreak: 'break-all' }}>
                <strong>Tx Hash:</strong> <span className="mono">{mintReceipt.mint.txHash}</span>
              </div>
            </div>
            {mintReceipt.awakening && (
              <div
                className="card"
                style={{
                  fontSize: 12,
                  borderColor: mintReceipt.awakening.awakenedParcel
                    ? 'rgba(255, 107, 53, 0.7)'
                    : 'rgba(0, 245, 212, 0.4)'
                }}
              >
                <div style={{ fontWeight: 700, color: mintReceipt.awakening.awakenedParcel ? '#ff9f1c' : 'var(--accent)' }}>
                  {mintReceipt.awakening.awakenedParcel
                    ? `🔥 First-Spark Awakening! (+${mintReceipt.awakening.xpAwarded} XP · 2x Rush)`
                    : `⚡ Published to Virtual Land (+${mintReceipt.awakening.xpAwarded} XP)`}
                </div>
                <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                  {mintReceipt.awakening.qualifiesForContributorPool
                    ? '✅ Qualified for permanent 2% Human Contributor Pool share on this parcel.'
                    : `Sculpt at least ${mintReceipt.awakening.minVoxelsRequired || 3} voxels next time to unlock the 2% Human Pool share.`}
                  {mintReceipt.awakening.slotsUnlockedForAgent > 0 &&
                    ` AI Steward unlocked +${mintReceipt.awakening.slotsUnlockedForAgent} more free land slots!`}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={onViewInARPreview}>
                <XeroIcon emoji="👁️" size={16} /> View in AR Preview
              </button>
              <a
                className="btn"
                href={buildShareToXUrl({
                  title: mintReceipt.sculpture.title,
                  parcelId: mintReceipt.sculpture.parcelId,
                  sculptureId: mintReceipt.sculpture.id
                })}
                target="_blank"
                rel="noreferrer"
              >
                𝕏 Share to X
              </a>
              <button
                type="button"
                className="btn"
                style={{ borderColor: 'rgba(255, 209, 102, 0.6)', color: 'var(--accent-gold)' }}
                onClick={() => onOpenManageLand(mintReceipt.sculpture.parcelId || '')}
              >
                <XeroIcon emoji="🗺️" size={16} /> Manage Land &amp; Contributors
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmitPublish} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {placedCatalogItem && (
                <span className="badge gold" data-testid="publish-catalog-item-badge">
                  <XeroIcon emoji="🧊" size={13} /> {placedCatalogItem.title} ({placedCatalogItem.sourceName || '.GLB'})
                </span>
              )}
              <span className="badge teal">
                <XeroIcon emoji="🧱" size={13} /> {voxels.length} voxels
              </span>
              <span className="badge gold">
                <XeroIcon emoji="📷" size={13} /> {polStats.frames} frames / {polStats.flow}% flow
              </span>
              {location?.altitude != null && (
                <span className="badge teal">
                  <XeroIcon emoji="⛰️" size={13} /> {Math.round(location.altitude)}m alt
                </span>
              )}
              <span className="badge">
                <XeroIcon emoji="🪙" size={13} /> Gas Free · 5% Resale Fee
              </span>
              {orbStatus.features >= 12 && (
                <span className="badge teal">
                  <XeroIcon emoji="📡" size={13} /> {orbStatus.keyframes}/3 ORB Angles ({orbStatus.features} pts)
                </span>
              )}
              {user && isWebAuthnSupported() && (
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 11, padding: '3px 9px' }}
                  disabled={passkeyBusy}
                  onClick={async () => {
                    setPublishError('');
                    try {
                      await onEnrollPasskey();
                    } catch (err) {
                      setPublishError(err.message || 'Passkey registration failed');
                    }
                  }}
                >
                  <XeroIcon emoji="🛡️" size={12} />{' '}
                  {passkeyCount > 0 ? `Passkey Ready (${passkeyCount})` : 'Enroll Biometric Passkey'}
                </button>
              )}
            </div>

            {activeTargetLand && (
              <div
                className="card"
                data-testid="publish-target-land-banner"
                data-parcel-id={activeTargetLand.parcelId || ''}
                style={{
                  padding: '10px 12px',
                  fontSize: 12,
                  borderColor: targetLandFrozen
                    ? 'rgba(255, 92, 138, 0.72)'
                    : 'rgba(255, 209, 102, 0.72)',
                  background: targetLandFrozen
                    ? 'rgba(42, 10, 22, 0.88)'
                    : 'rgba(26, 20, 8, 0.88)'
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    color: targetLandFrozen ? '#ffb3c1' : '#ffd166',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  <XeroIcon emoji={targetLandFrozen ? '❄️' : '🎨'} size={14} />
                  <span>
                    {targetLandFrozen
                      ? `${targetLandName} is frozen`
                      : `Adding Art to: ${targetLandName}`}
                  </span>
                </div>
                <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                  {targetLandFrozen
                    ? 'This land is frozen by its owner — new art cannot be added here.'
                    : 'You are inside this existing land. Publishing attaches your art here and will not mint a new land.'}
                </div>
              </div>
            )}

            {activeQuest && (
              <div
                className="card"
                style={{
                  padding: 10,
                  fontSize: 12,
                  borderColor: activeQuest.firstSparkBoost
                    ? 'rgba(255, 107, 53, 0.7)'
                    : 'rgba(0, 245, 212, 0.45)'
                }}
              >
                <div style={{ fontWeight: 700, color: activeQuest.firstSparkBoost ? '#ff9f1c' : 'var(--accent)' }}>
                  {activeQuest.badgeLabel || '🎨 Quest Active on This Land'} · {activeQuest.title}
                </div>
                <div style={{ color: 'var(--muted)', marginTop: 3 }}>
                  {selectedPlinthSlot
                    ? `Snapped to plinth "${selectedPlinthSlot.label}". `
                    : ''}
                  {voxels.length >= 3
                    ? '✅ 3+ voxels verified — qualifies for 2% Contributor Pool & quest rewards!'
                    : `⚠️ Add at least ${3 - voxels.length} more voxel(s) to unlock the 2% Contributor Pool & awaken dormant land!`}
                </div>
              </div>
            )}

            <div>
              <div className="field-label">
                <span>Title</span>
                <span className="mono">{title.length}/{policy?.titleMax || 48}</span>
              </div>
              <EmojiInput
                className="input"
                required
                maxLength={policy?.titleMax || 48}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Name your 3D street sculpture (type : for emojis)"
              />
            </div>

            <div>
              <div className="field-label">
                <span>Description (Limited Terms)</span>
                <span className="mono">
                  {description.length}/{policy?.descriptionMax || 240} chars · {wordCount}/{policy?.descriptionMaxWords || 45} words
                </span>
              </div>
              <EmojiTextarea
                className="textarea"
                rows={3}
                required
                maxLength={policy?.descriptionMax || 240}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short story or inspiration for this piece (type : for emojis)..."
              />
            </div>

            <div>
              <div className="field-label">
                <span>Optional On-Site Chat Clue (24/7 Solo Unlock)</span>
                <span className="mono">E2EE · PBKDF2</span>
              </div>
              <EmojiInput
                className="input"
                maxLength={140}
                value={cluePrompt}
                onChange={(e) => setCluePrompt(e.target.value)}
                placeholder="Question visible at this spot (leave blank for peer-only)"
              />
              {cluePrompt.trim() && (
                <input
                  className="input"
                  style={{ marginTop: 6 }}
                  value={clueAnswer}
                  onChange={(e) => setClueAnswer(e.target.value)}
                  placeholder="Answer visible in person (never sent to server)"
                  required
                />
              )}
            </div>

            {user && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Minted NFT Recipient ({user.email}):
                <div className="mono" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
                  {user.activeMintRecipient}
                </div>
              </div>
            )}

            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
              />
              <span>
                I accept the{' '}
                <button
                  type="button"
                  onClick={onOpenInfo}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    padding: 0,
                    textDecoration: 'underline',
                    cursor: 'pointer'
                  }}
                >
                  SPRAY.LAND Terms &amp; Virtual Land Policy
                </button>
                , confirm real physical presence, and acknowledge the 5% Robinhood resale royalty.
              </span>
            </label>

            {publishError && (
              <div style={{ color: '#ffb3c1', fontSize: 12 }}>
                <XeroIcon emoji="⚠️" size={14} /> {publishError}
              </div>
            )}

            {mcpPairingsState.mcpActive && mcpPairingsState.activePairing && (
              <div className="card" style={{ padding: 10, fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge teal">
                    <XeroIcon emoji="🔑" size={12} /> Agent Keys Connected ({mcpPairingsState.activePairing.code})
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    Sign here on mobile OR delegate signing to your agent
                  </span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!user && typeof onRequestLogin === 'function' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: '1 1 180px' }}
                  onClick={onRequestLogin}
                >
                  <XeroIcon emoji="🔐" size={16} /> Sign in with Google to Publish
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-pink"
                  style={{ flex: '1 1 180px' }}
                  disabled={publishing || voxels.length === 0 || targetLandFrozen}
                >
                  <XeroIcon emoji={activeTargetLand ? '🎨' : '🚀'} size={16} />
                  {publishing
                    ? 'Verifying PoL, Pinning IPFS & Minting...'
                    : targetLandFrozen
                    ? 'Land Frozen'
                    : activeTargetLand
                    ? `Add Art to ${targetLandName}`
                    : 'Sign & Publish on Mobile'}
                </button>
              )}
              {mcpPairingsState.mcpActive && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: '1 1 180px' }}
                  disabled={publishing || voxels.length === 0 || targetLandFrozen}
                  onClick={onCopyAgentPublishPrompt}
                >
                  <XeroIcon emoji="🤖" size={15} /> Copy Agent Sign &amp; Publish Prompt
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={publishing || draftsBusy || (voxels.length === 0 && !title.trim() && !description.trim())}
                onClick={() => onManualSaveDraft({ closePublish: true })}
              >
                <XeroIcon emoji="💾" size={15} />
                <span>{draftsBusy ? 'Saving...' : 'Save Draft'}</span>
              </button>
            </div>

            {agentPublishPrompt && (
              <div className="card" style={{ padding: 10, fontSize: 12, borderColor: 'rgba(0, 245, 212, 0.45)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <strong style={{ color: 'var(--accent)' }}>
                    ⏳ Waiting for Agent Signature ({agentPublishPrompt.requestId.slice(0, 14)}...)
                  </strong>
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '4px 8px', fontSize: 11 }}
                    onClick={() => copyToClipboard(agentPublishPrompt.promptText)}
                  >
                    📋 Re-copy Prompt
                  </button>
                </div>
                <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 10, maxHeight: 140, overflowY: 'auto', color: 'var(--muted)' }}>
                  {agentPublishPrompt.promptText}
                </pre>
              </div>
            )}

            {!mcpPairingsState.mcpActive && (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                Want your AI agent to sign on your behalf? Pair a robust <code>GLP-...</code> code under{' '}
                <button
                  type="button"
                  onClick={onOpenPair}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    padding: 0,
                    textDecoration: 'underline',
                    cursor: 'pointer'
                  }}
                >
                  Pair Desktop &amp; MCP Agent
                </button>
                .
              </div>
            )}

            {draftStatusText && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                <XeroIcon emoji="💾" size={12} /> Auto-draft: {draftStatusText}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
