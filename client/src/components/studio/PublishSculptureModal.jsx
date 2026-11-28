import React, { useEffect, useMemo, useRef, useState } from 'react';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import {
  buildSculptureShareUrl,
  buildShareToXUrl,
  copyToClipboard
} from '../../utils/clipboard.js';
import { isWebAuthnSupported } from '../../utils/passkeyClient.js';
import { useSafeBackdropClose } from '../../utils/modalBackdropGuard.js';
import { projectVoxelsToIsoCubes } from '../../utils/sculptureThumbnailRenderer.js';
import { EmojiInput, EmojiTextarea } from '../EmojiField.jsx';
import EthAddressBadge from '../EthAddressBadge.jsx';
import InfoTip from '../InfoTip.jsx';
import { GlobalNotificationBell } from '../NotificationCenter.jsx';
import XeroIcon from '../XeroIcon.jsx';

export default function PublishSculptureModal({
  config,
  user,
  voxels,
  placedCatalogItem = null,
  artPreviewUrl = '',
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
  const safeVoxels = useMemo(() => (Array.isArray(voxels) ? voxels : []), [voxels]);
  const hasPublishableArt = safeVoxels.length > 0 || Boolean(placedCatalogItem);
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
  const modalCardRef = useRef(null);
  const titleInputRef = useRef(null);

  // Always start publish sheet at top with focus cleanly on Title (never Description!)
  useEffect(() => {
    if (mintReceipt) return undefined;
    if (modalCardRef.current) {
      modalCardRef.current.scrollTop = 0;
    }
    const focusTitle = () => {
      const el = titleInputRef.current;
      if (el && typeof el.focus === 'function') {
        try {
          el.focus({ preventScroll: false });
        } catch {
          el.focus();
        }
      }
    };
    focusTitle();
    const rafId =
      typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(focusTitle)
        : 0;
    return () => {
      if (rafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [mintReceipt]);

  const recipientWallet = user?.activeMintRecipient || user?.walletAddress || '';

  const isolatedPreviewUrl = mintReceipt
    ? mintReceipt.sculpture?.previewDataUrl || artPreviewUrl || ''
    : artPreviewUrl || placedCatalogItem?.previewImageUrl || '';
  const isoCubes = useMemo(() => {
    if (isolatedPreviewUrl) return [];
    const sourceVoxels =
      Array.isArray(mintReceipt?.sculpture?.voxels) && mintReceipt.sculpture.voxels.length > 0
        ? mintReceipt.sculpture.voxels
        : safeVoxels;
    if (sourceVoxels.length === 0) return [];
    return projectVoxelsToIsoCubes(sourceVoxels, { width: 280, height: 170, maxCubes: 220 });
  }, [isolatedPreviewUrl, mintReceipt, safeVoxels]);
  const showIsolatedPreview = Boolean(
    isolatedPreviewUrl || isoCubes.length > 0 || placedCatalogItem
  );
  const isolatedPreviewKind = isolatedPreviewUrl
    ? 'snapshot'
    : isoCubes.length > 0
    ? 'voxel-iso'
    : 'model-card';
  const isolatedPreviewTitle =
    placedCatalogItem && safeVoxels.length > 0
      ? 'Your Art & Placed 3D Model'
      : placedCatalogItem
      ? placedCatalogItem.title || 'Your Placed 3D Model'
      : mintReceipt?.sculpture?.title || title.trim() || 'Your New Art';

  const isolatedArtPreviewBlock = showIsolatedPreview ? (
    <div
      className="publish-art-preview-card"
      data-testid="publish-isolated-art-preview"
      data-isolated-only="true"
      data-preview-kind={isolatedPreviewKind}
    >
      <div className="publish-art-preview-stage">
        {isolatedPreviewUrl ? (
          <img
            src={isolatedPreviewUrl}
            alt={`Isolated preview of ${isolatedPreviewTitle}`}
            className="publish-art-preview-img"
            data-testid="publish-art-preview-img"
          />
        ) : isoCubes.length > 0 ? (
          <svg
            className="publish-art-preview-svg"
            data-testid="publish-art-preview-voxel-svg"
            viewBox="0 0 280 170"
            role="img"
            aria-label={`Isolated preview of ${isolatedPreviewTitle}`}
          >
            {isoCubes.map((cube, idx) => (
              <g key={idx}>
                <polygon points={cube.left} fill={cube.leftFill} />
                <polygon points={cube.right} fill={cube.rightFill} />
                <polygon points={cube.top} fill={cube.topFill} />
              </g>
            ))}
          </svg>
        ) : (
          <div
            className="publish-art-preview-model-fallback"
            data-testid="publish-art-preview-model-fallback"
          >
            <XeroIcon emoji="🧊" size={34} />
            <strong>{placedCatalogItem?.title || 'Placed 3D Model'}</strong>
            <span className="mono">
              {String(placedCatalogItem?.modelFormat || 'GLB').toUpperCase()}
              {placedCatalogItem?.sourceName ? ` · ${placedCatalogItem.sourceName}` : ''}
            </span>
          </div>
        )}
        <span className="publish-art-preview-pill">
          <XeroIcon emoji={placedCatalogItem && safeVoxels.length === 0 ? '🧊' : '🎨'} size={12} />
          <span>
            {placedCatalogItem && safeVoxels.length > 0
              ? 'Your Art + 3D Model'
              : placedCatalogItem
              ? 'Your Placed 3D Model'
              : 'Your New Art'}
          </span>
        </span>
        <span className="publish-art-preview-tag mono">Only your piece</span>
      </div>
    </div>
  ) : null;

  return (
    <div
      className="modal-backdrop publish-modal-backdrop"
      data-testid="publish-sculpture-modal"
      data-publish-isolated="true"
      {...backdropCloseProps}
    >
      <div
        ref={modalCardRef}
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {activeTargetLand && !mintReceipt ? (
              <>
                <XeroIcon emoji={targetLandFrozen ? '❄️' : '🎨'} size={20} />
                <span>
                  {targetLandFrozen ? `Frozen: ${targetLandName}` : `Add Art to ${targetLandName}`}
                </span>
              </>
            ) : (
              <>
                <XeroIcon emoji="🚀" size={20} />
                <span>Publish Art</span>
              </>
            )}
            {!mintReceipt && (
              <InfoTip title="Publish & Chain Details" mode="inline">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>Mints gas-free on IPFS &amp; Robinhood Chain (5% resale royalty).</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {safeVoxels.length} voxels · {polStats?.frames ?? 0} frames / {polStats?.flow ?? 0}% flow
                    {location?.altitude != null ? ` · ${Math.round(location.altitude)}m alt` : ''}
                    {orbStatus?.features >= 12
                      ? ` · ${orbStatus.keyframes}/3 ORB angles (${orbStatus.features} pts)`
                      : ''}
                  </div>
                </div>
              </InfoTip>
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
            {isolatedArtPreviewBlock}
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
            <div className="card" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
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
              {mintReceipt.ipfs?.metadataCid && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <strong>IPFS CID:</strong>{' '}
                  <EthAddressBadge
                    address={mintReceipt.ipfs.metadataCid}
                    prefixChars={8}
                    suffixChars={6}
                    testId="publish-receipt-cid"
                    copyTestId="publish-receipt-cid-copy-btn"
                    onCopied={(ok) => onShowHint?.(ok ? 'Copied IPFS CID!' : 'Copy unavailable')}
                  />
                </div>
              )}
              {mintReceipt.mint?.txHash && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <strong>Tx Hash:</strong>{' '}
                  <EthAddressBadge
                    address={mintReceipt.mint.txHash}
                    testId="publish-receipt-tx-hash"
                    copyTestId="publish-receipt-tx-copy-btn"
                    onCopied={(ok) => onShowHint?.(ok ? 'Copied tx hash!' : 'Copy unavailable')}
                  />
                </div>
              )}
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
          <form onSubmit={onSubmitPublish} style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {isolatedArtPreviewBlock}

            {(placedCatalogItem || safeVoxels.length > 0 || (user && isWebAuthnSupported())) && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {placedCatalogItem && (
                  <span className="badge gold" data-testid="publish-catalog-item-badge">
                    <XeroIcon emoji="🧊" size={13} /> {placedCatalogItem.title}
                  </span>
                )}
                {(safeVoxels.length > 0 || !placedCatalogItem) && (
                  <span className="badge teal">
                    <XeroIcon emoji="🧱" size={13} /> {safeVoxels.length} blocks
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
                    {passkeyCount > 0 ? `Passkey (${passkeyCount})` : 'Add Passkey'}
                  </button>
                )}
              </div>
            )}

            {activeTargetLand && (
              <div
                className="card"
                data-testid="publish-target-land-banner"
                data-parcel-id={activeTargetLand.parcelId || ''}
                style={{
                  padding: '8px 11px',
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
                    gap: 6,
                    flexWrap: 'wrap'
                  }}
                >
                  <XeroIcon emoji={targetLandFrozen ? '❄️' : '🎨'} size={14} />
                  <span>
                    {targetLandFrozen
                      ? `${targetLandName} is frozen`
                      : `Adding Art to: ${targetLandName}`}
                  </span>
                  <InfoTip title={targetLandFrozen ? 'Frozen Land' : 'Adding to Existing Land'}>
                    {targetLandFrozen
                      ? 'This land is frozen by its owner — new art cannot be added here.'
                      : 'You are inside this existing land. Publishing attaches your art here and will not mint a new land.'}
                  </InfoTip>
                </div>
              </div>
            )}

            {activeQuest && (
              <div
                className="card"
                style={{
                  padding: '8px 11px',
                  fontSize: 12,
                  borderColor: activeQuest.firstSparkBoost
                    ? 'rgba(255, 107, 53, 0.7)'
                    : 'rgba(0, 245, 212, 0.45)'
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    color: activeQuest.firstSparkBoost ? '#ff9f1c' : 'var(--accent)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap'
                  }}
                >
                  <span>{activeQuest.badgeLabel || '🎨 Quest Active'} · {activeQuest.title}</span>
                  <InfoTip title="Quest Details">
                    {selectedPlinthSlot ? `Snapped to plinth "${selectedPlinthSlot.label}". ` : ''}
                    {safeVoxels.length >= 3
                      ? '3+ blocks verified — qualifies for the 2% Contributor Pool & quest rewards.'
                      : `Add at least ${3 - safeVoxels.length} more block(s) to unlock the 2% Contributor Pool & awaken dormant land.`}
                  </InfoTip>
                </div>
              </div>
            )}

            <div>
              <div className="field-label">
                <span className="publish-field-label-group">
                  <span>Title</span>
                  <InfoTip title="Title">
                    Give your piece a short name (up to {policy?.titleMax || 48} characters). Type{' '}
                    <code>:</code> for emoji shortcuts.
                  </InfoTip>
                </span>
                <span className="mono">{title.length}/{policy?.titleMax || 48}</span>
              </div>
              <EmojiInput
                ref={titleInputRef}
                className="input"
                data-testid="publish-title-input"
                autoFocus
                required
                maxLength={policy?.titleMax || 48}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Name your art"
              />
            </div>

            <div>
              <div className="field-label">
                <span className="publish-field-label-group">
                  <span>Description</span>
                  <InfoTip title="Description">
                    Optional short story or note (Limited Terms: up to {policy?.descriptionMax || 240}{' '}
                    characters and {policy?.descriptionMaxWords || 45} words — currently {wordCount}/
                    {policy?.descriptionMaxWords || 45} words). Type <code>:</code> for emoji shortcuts.
                  </InfoTip>
                </span>
                <span className="mono">{description.length}/{policy?.descriptionMax || 240}</span>
              </div>
              <EmojiTextarea
                className="textarea"
                data-testid="publish-description-input"
                rows={3}
                required
                maxLength={policy?.descriptionMax || 240}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short note about this piece..."
              />
            </div>

            <div>
              <div className="field-label">
                <span className="publish-field-label-group">
                  <span>Chat Clue</span>
                  <InfoTip title="On-Site Chat Clue (Optional)">
                    Optional 24/7 solo unlock clue for visitors at this spot. Protected with E2EE ·
                    PBKDF2 on your device; your answer is never sent to the server. Leave blank for
                    peer-only unlock.
                  </InfoTip>
                </span>
                <span className="mono" style={{ opacity: 0.72 }}>Optional</span>
              </div>
              <EmojiInput
                className="input"
                data-testid="publish-clue-prompt-input"
                maxLength={140}
                value={cluePrompt}
                onChange={(e) => setCluePrompt(e.target.value)}
                placeholder="Question visible at this spot"
              />
              {cluePrompt.trim() && (
                <input
                  className="input"
                  style={{ marginTop: 6 }}
                  value={clueAnswer}
                  onChange={(e) => setClueAnswer(e.target.value)}
                  placeholder="Secret answer"
                  required
                />
              )}
            </div>

            {user && recipientWallet && (
              <div className="publish-wallet-row">
                <span className="publish-field-label-group" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <span>Wallet</span>
                  <InfoTip title="NFT Recipient Wallet">
                    Minted NFT recipient address on Robinhood Chain. Tap the copy icon to copy the
                    full wallet address.
                  </InfoTip>
                </span>
                <EthAddressBadge
                  address={recipientWallet}
                  testId="publish-recipient-wallet"
                  copyTestId="publish-wallet-copy-btn"
                  onCopied={(ok) => onShowHint?.(ok ? 'Copied wallet address!' : 'Copy unavailable')}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
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
                    SPRAY.LAND Terms
                  </button>
                </span>
              </label>
              <InfoTip title="Terms & Virtual Land Policy">
                Confirms real physical presence at this location, acceptance of the SPRAY.LAND Terms
                &amp; Virtual Land Policy, and the 5% Robinhood resale royalty.
              </InfoTip>
            </div>

            {publishError && (
              <div style={{ color: '#ffb3c1', fontSize: 12 }}>
                <XeroIcon emoji="⚠️" size={14} /> {publishError}
              </div>
            )}

            {mcpPairingsState.mcpActive && mcpPairingsState.activePairing && (
              <div
                className="card"
                style={{
                  padding: '8px 10px',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  flexWrap: 'wrap'
                }}
              >
                <span className="badge teal">
                  <XeroIcon emoji="🔑" size={12} /> Agent Connected
                </span>
                <InfoTip title="Paired AI Agent">
                  Pairing code <code>{mcpPairingsState.activePairing.code}</code>. Sign here on
                  mobile or delegate signing to your paired agent.
                </InfoTip>
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
                  disabled={publishing || !hasPublishableArt || targetLandFrozen}
                >
                  <XeroIcon emoji={activeTargetLand ? '🎨' : '🚀'} size={16} />
                  {publishing
                    ? 'Publishing...'
                    : targetLandFrozen
                    ? 'Land Frozen'
                    : activeTargetLand
                    ? `Add Art to ${targetLandName}`
                    : 'Sign & Publish'}
                </button>
              )}
              {mcpPairingsState.mcpActive && (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: '1 1 180px' }}
                  disabled={publishing || !hasPublishableArt || targetLandFrozen}
                  onClick={onCopyAgentPublishPrompt}
                >
                  <XeroIcon emoji="🤖" size={15} /> Copy Agent Publish Prompt
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={publishing || draftsBusy || (!hasPublishableArt && !title.trim() && !description.trim())}
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
                    ⏳ Waiting for Agent ({agentPublishPrompt.requestId.slice(0, 10)}…)
                  </strong>
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '4px 8px', fontSize: 11 }}
                    onClick={() => copyToClipboard(agentPublishPrompt.promptText)}
                  >
                    📋 Copy
                  </button>
                </div>
                <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 10, maxHeight: 140, overflowY: 'auto', color: 'var(--muted)' }}>
                  {agentPublishPrompt.promptText}
                </pre>
              </div>
            )}

            {!mcpPairingsState.mcpActive && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  onClick={onOpenPair}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    padding: 0,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    fontSize: 11.5
                  }}
                >
                  Pair AI Agent
                </button>
                <InfoTip title="AI Agent Signing">
                  Pair a <code>GLP-...</code> code under Pair Desktop &amp; MCP Agent to let your AI
                  agent sign and publish on your behalf.
                </InfoTip>
              </div>
            )}

            {draftStatusText && (
              <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                <XeroIcon emoji="💾" size={12} /> {draftStatusText}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
