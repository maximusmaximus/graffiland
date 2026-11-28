import React, { useEffect, useRef, useState } from 'react';
import {
  CHAT_SIGHT_MAX_DISTANCE_M,
  PIN_PARCEL_MAX_DISTANCE_M
} from '../../../../shared/chatPolicy.mjs';
import {
  buildParcelShareUrl,
  resolveLandDisplayName
} from '../../../../shared/landVolume.mjs';
import { api } from '../../utils/api.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import {
  evaluateArLandActionProximity,
  evaluateLandChatAvailability,
  getLandChatLiveSummary,
  resolveLandChatTarget
} from '../../utils/landChatHelpers.js';
import {
  formatDistanceMeters,
  formatLandDimensions,
  formatSculptureAssetMeta,
  formatShortDate,
  resolveLandCoords
} from '../../utils/landMapHelpers.js';
import { useMeasurementUnits } from '../../utils/measurementUnits.js';
import { notifySettingsSaved } from '../../utils/toastNotice.js';
import { EmojiInput } from '../EmojiField.jsx';
import InfoTip from '../InfoTip.jsx';
import UserHandleBadge from '../UserHandleBadge.jsx';
import XeroIcon from '../XeroIcon.jsx';

export { evaluateArLandActionProximity, resolveLandChatTarget };

export default function ARLandInspectorPanel({
  land,
  nearbyLands = [],
  onSelectNearbyLand = null,
  onDrawHere = null,
  onCheckInLand = null,
  onOpen3DMap = null,
  onManageLand = null,
  onRenameLand = null,
  onOpenProfile = null,
  onInspectSculpture = null,
  onOpenLandChat = null,
  onOpenSculptureChat = null,
  onShowHint = null,
  isDesktop = false,
  isSignedIn = true,
  cameraReady = true,
  hasLocation = true,
  expanded = undefined,
  defaultExpanded = true,
  onToggleExpanded = null,
  onClose
}) {
  const [internalExpanded, setInternalExpanded] = useState(Boolean(defaultExpanded));
  const isExpanded = typeof expanded === 'boolean' ? expanded : internalExpanded;
  const handleToggleExpanded = () => {
    const next = !isExpanded;
    if (typeof onToggleExpanded === 'function') {
      onToggleExpanded(next);
    } else {
      setInternalExpanded(next);
    }
  };
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [localDisplayName, setLocalDisplayName] = useState('');
  const [checkInBusy, setCheckInBusy] = useState(false);
  const [checkedInDone, setCheckedInDone] = useState(false);
  const [visitLockNotice, setVisitLockNotice] = useState('');
  const [visitLockPulse, setVisitLockPulse] = useState(false);
  const visitLockTimerRef = useRef(null);
  const proximity = evaluateArLandActionProximity(land);
  const {
    edgeDistM,
    canDrawAtLand,
    canCheckInAtLand,
    canChatAtLand
  } = proximity;
  const { unitSystem } = useMeasurementUnits(null, resolveLandCoords(land));

  // Reset inline rename & check-in state when switching to a different nearby land
  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft('');
    setRenameError('');
    setLocalDisplayName('');
    setCheckInBusy(false);
    setCheckedInDone(false);
    setVisitLockNotice('');
    setVisitLockPulse(false);
  }, [land?.parcelId]);

  useEffect(() => {
    return () => {
      if (visitLockTimerRef.current) {
        clearTimeout(visitLockTimerRef.current);
        visitLockTimerRef.current = null;
      }
    };
  }, []);

  if (!land) return null;

  const displayName = resolveLandDisplayName({
    customName: localDisplayName || String(land.customName || '').trim(),
    displayName: land.displayName || '',
    firstSculptureTitle: land.sculptures?.[0]?.title || ''
  });
  const exp = land.expiration || {
    state: 'permanent',
    urgent: false,
    badgeText: 'Permanent',
    detailText: 'Permanent land — does not expire'
  };

  const stewardHandle = land.stewardUsername || land.ownerSub || '';

  const sculptures = Array.isArray(land.sculptures) ? land.sculptures : [];
  const canonicalChatTarget = resolveLandChatTarget(land, displayName);
  const canOpenLandChat = Boolean(
    canonicalChatTarget &&
      (typeof onOpenLandChat === 'function' || typeof onOpenSculptureChat === 'function')
  );
  const landChatSummary = getLandChatLiveSummary(land);
  const landChatMessageCount = landChatSummary.messageCount;
  const chatAvailability = evaluateLandChatAvailability({
    land,
    displayName,
    proximity,
    isDesktop,
    isSignedIn,
    cameraReady,
    hasLocation,
    unitSystem
  });
  const isChatUnlocked = chatAvailability.canChat;
  const notifyVisitRequired = (actionLabel, maxDistMeters) => {
    const withinLabel = formatDistanceMeters(maxDistMeters, unitSystem);
    const awayDetail =
      edgeDistM !== null
        ? `you're ${formatDistanceMeters(edgeDistM, unitSystem)} away — walk within ${withinLabel}`
        : `enable GPS and walk within ${withinLabel}`;
    const msg = `Visit ${displayName} in person to ${actionLabel} (${awayDetail}).`;
    setVisitLockNotice(msg);
    setVisitLockPulse(true);
    if (visitLockTimerRef.current) clearTimeout(visitLockTimerRef.current);
    visitLockTimerRef.current = setTimeout(() => {
      setVisitLockPulse(false);
    }, 4500);
    notifySettingsSaved(msg, {
      tone: 'warning',
      durationMs: 5200,
      ...(land.googleMapsUrl
        ? {
            actionLabel: '🧭 Navigate',
            onAction: () => {
              if (typeof window !== 'undefined' && typeof window.open === 'function') {
                window.open(land.googleMapsUrl, '_blank', 'noopener,noreferrer');
              }
            }
          }
        : {})
    });
  };

  const handleOpenLandChat = () => {
    if (!canChatAtLand) {
      notifyVisitRequired('join Land Chat', CHAT_SIGHT_MAX_DISTANCE_M);
      return;
    }
    if (!isChatUnlocked) {
      const msg = chatAvailability.reason || `Land Chat is currently locked at ${displayName}.`;
      setVisitLockNotice(msg);
      setVisitLockPulse(true);
      if (visitLockTimerRef.current) clearTimeout(visitLockTimerRef.current);
      visitLockTimerRef.current = setTimeout(() => {
        setVisitLockPulse(false);
      }, 4500);
      notifySettingsSaved(msg, { tone: 'warning', durationMs: 4800 });
      return;
    }
    if (!canonicalChatTarget) return;
    if (typeof onOpenLandChat === 'function') {
      onOpenLandChat(land, canonicalChatTarget);
    } else if (typeof onOpenSculptureChat === 'function') {
      onOpenSculptureChat(canonicalChatTarget, land.distanceMeters ?? 0);
    }
  };
  const currentIdx = nearbyLands.findIndex((item) => item?.parcelId === land.parcelId);
  const hasMultipleNearby = nearbyLands.length > 1 && currentIdx >= 0 && typeof onSelectNearbyLand === 'function';

  function stepNearbyLand(delta) {
    if (!hasMultipleNearby) return;
    const nextIdx = (currentIdx + delta + nearbyLands.length) % nearbyLands.length;
    onSelectNearbyLand(nearbyLands[nextIdx]);
  }

  function startRename() {
    if (!land.isOwned || renameSaving) return;
    setIsRenaming(true);
    setRenameDraft(localDisplayName || String(land.customName || ''));
    setRenameError('');
  }

  function cancelRename() {
    if (renameSaving) return;
    setIsRenaming(false);
    setRenameDraft('');
    setRenameError('');
  }

  async function submitRename(e) {
    e.preventDefault();
    if (!land?.parcelId || renameSaving) return;
    const nextName = String(renameDraft || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 48);
    if (nextName === String(localDisplayName || land.customName || '').trim()) {
      setIsRenaming(false);
      return;
    }
    setRenameSaving(true);
    setRenameError('');
    try {
      if (typeof onRenameLand === 'function') {
        await onRenameLand(land, nextName);
      } else {
        await api.updateLandParcel(land.parcelId, { customName: nextName });
      }
      setLocalDisplayName(nextName);
      setIsRenaming(false);
      onShowHint?.(
        nextName ? `Renamed land to "${nextName}"!` : 'Updated land name'
      );
    } catch (err) {
      setRenameError(err?.message || 'Could not rename land');
    } finally {
      setRenameSaving(false);
    }
  }

  async function handleCopyShare() {
    const shareUrl = buildParcelShareUrl({
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
      parcelId: land.parcelId,
      customName: localDisplayName || land.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    onShowHint?.(ok ? `Copied share link for ${displayName}!` : 'Copy unavailable');
  }

  const proximityText = land.isInside
    ? 'Inside Land'
    : land.edgeDistanceMeters !== undefined && Number.isFinite(Number(land.edgeDistanceMeters))
    ? `${formatDistanceMeters(land.edgeDistanceMeters, unitSystem)} away`
    : land.distanceLabel || 'Nearby';
  const resolvedDimsLabel = land.volume
    ? formatLandDimensions(land, unitSystem)
    : land.dimensionsLabel;

  const hasPrimaryDraw = Boolean(!land.isFrozen && !land.isInside && onDrawHere);
  const hasPrimaryCheckIn = Boolean(exp.state !== 'permanent' && typeof onCheckInLand === 'function');
  const primaryActionCount =
    (hasPrimaryDraw ? 1 : 0) + (canOpenLandChat ? 1 : 0) + (hasPrimaryCheckIn ? 1 : 0);
  const hasAnyLockedAction = Boolean(
    (hasPrimaryDraw && !canDrawAtLand) ||
      (canOpenLandChat && !canChatAtLand) ||
      (hasPrimaryCheckIn && !canCheckInAtLand)
  );
  const defaultVisitLockMessage =
    edgeDistM !== null
      ? `Visit ${displayName} in person (${formatDistanceMeters(edgeDistM, unitSystem)} away) to unlock locked on-site actions.`
      : `Enable GPS and visit ${displayName} in person to unlock locked on-site actions.`;

  if (!isExpanded) {
    const artCountLabel =
      sculptures.length > 0
        ? ` · ${sculptures.length} ${sculptures.length === 1 ? 'artwork' : 'artworks'}`
        : '';
    return (
      <section
        className="ar-land-inspector is-collapsed hud-interactive"
        role="dialog"
        aria-label={`Land details for ${displayName}`}
        data-testid="ar-land-inspector"
        data-expanded="false"
        data-parcel-id={land.parcelId}
        data-owned={land.isOwned ? 'true' : 'false'}
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="ar-land-compact-bar">
          <button
            type="button"
            className="ar-land-compact-summary"
            data-testid="ar-land-compact-summary"
            onClick={handleToggleExpanded}
            aria-label={`Show details for ${displayName}`}
          >
            <div className="ar-land-compact-eyebrow">
              <span
                className={`ar-land-status-text ${land.isInside ? 'is-gold' : 'is-teal'}`}
                data-testid="ar-land-proximity-badge"
              >
                <span className="ar-land-status-dot" aria-hidden="true" />
                {proximityText}
              </span>
              {artCountLabel && <span className="ar-land-compact-count">{artCountLabel}</span>}
            </div>
            <div className="ar-land-compact-title">{displayName}</div>
          </button>

          <div className="ar-land-compact-actions">
            {hasMultipleNearby && (
              <div className="ar-land-pager" role="group" aria-label="Switch nearby land">
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => stepNearbyLand(-1)}
                  aria-label="Previous nearby land"
                >
                  ◂
                </button>
                <span className="mono ar-land-pager-count">
                  {currentIdx + 1}/{nearbyLands.length}
                </span>
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => stepNearbyLand(1)}
                  aria-label="Next nearby land"
                >
                  ▸
                </button>
              </div>
            )}
            {!land.isInside && land.googleMapsUrl ? (
              <a
                className="btn btn-xs ar-land-compact-cta"
                href={land.googleMapsUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="ar-land-compact-nav-link"
                aria-label={`Navigate to ${displayName}`}
              >
                <XeroIcon emoji="🧭" size={13} />
                <span>Go</span>
              </a>
            ) : null}
            <button
              type="button"
              className="btn btn-xs ar-land-expand-toggle"
              data-testid="ar-land-details-toggle"
              aria-expanded="false"
              onClick={handleToggleExpanded}
            >
              ▲ Details
            </button>
            <button
              type="button"
              className="btn btn-xs ar-land-close-btn"
              data-testid="ar-land-close-btn"
              aria-label="Close land details and return to camera drawing"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className="ar-land-inspector is-expanded hud-interactive"
      role="dialog"
      aria-label={`Land details for ${displayName}`}
      data-testid="ar-land-inspector"
      data-expanded="true"
      data-parcel-id={land.parcelId}
      data-owned={land.isOwned ? 'true' : 'false'}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* ZONE 1: IDENTITY & READ-ONLY LAND INFO */}
      <div className="ar-land-info-section" data-testid="ar-land-info-section">
        <div className="ar-land-inspector-top">
          <div className="ar-land-status-strip">
            <span
              className={`ar-land-status-text ${land.isInside ? 'is-gold' : 'is-teal'}`}
              data-testid="ar-land-proximity-badge"
            >
              <span className="ar-land-status-dot" aria-hidden="true" />
              {proximityText}
            </span>
            {land.isOwned && (
              <span className="ar-land-status-text is-owned" data-testid="ar-land-owned-badge">
                <span aria-hidden="true">·</span> 👑 Your Land
              </span>
            )}
            {exp.state !== 'permanent' && (
              <span
                className={`ar-land-status-text ${
                  exp.state === 'expired' || exp.state === 'expiring-soon' ? 'is-danger' : 'is-gold'
                }`}
                title={exp.detailText}
                data-testid="ar-land-expiry-badge"
              >
                <span aria-hidden="true">·</span> {exp.badgeText}
              </span>
            )}
          </div>

          <div className="ar-land-top-right">
            {hasMultipleNearby && (
              <div className="ar-land-pager" role="group" aria-label="Switch nearby land">
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => stepNearbyLand(-1)}
                  aria-label="Previous nearby land"
                >
                  ◂
                </button>
                <span className="mono ar-land-pager-count">
                  {currentIdx + 1}/{nearbyLands.length}
                </span>
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => stepNearbyLand(1)}
                  aria-label="Next nearby land"
                >
                  ▸
                </button>
              </div>
            )}
            <button
              type="button"
              className="btn btn-xs ar-land-copy-icon-btn"
              data-testid="ar-land-copy-link-btn"
              onClick={handleCopyShare}
              aria-label={`Copy share link for ${displayName}`}
              title={`Copy share link for ${displayName}`}
            >
              <XeroIcon emoji="📋" size={18} />
            </button>
            <button
              type="button"
              className="btn btn-xs ar-land-expand-toggle"
              data-testid="ar-land-details-toggle"
              aria-expanded="true"
              onClick={handleToggleExpanded}
            >
              ▾ Hide
            </button>
            <button
              type="button"
              className="btn btn-xs ar-land-close-btn"
              data-testid="ar-land-close-btn"
              aria-label="Close land details and return to camera drawing"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Land Identity (click-to-rename inline for owned land) */}
        <div className="ar-land-identity">
          {isRenaming ? (
            <form
              className="mobile-land-rename-form"
              data-testid="ar-land-rename-form"
              onSubmit={submitRename}
            >
              <EmojiInput
                autoFocus
                wrapperClassName="mobile-land-rename-wrap"
                className="input mobile-land-rename-input"
                aria-label="Rename land"
                maxLength={48}
                value={renameDraft}
                disabled={renameSaving}
                placeholder="Name your land… (type : for emojis)"
                onChange={(e) => {
                  setRenameDraft(e.target.value);
                  if (renameError) setRenameError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
              />
              <div className="mobile-land-rename-actions">
                <button
                  type="submit"
                  className="btn btn-xs btn-primary"
                  disabled={renameSaving}
                  data-testid="ar-land-rename-save"
                  aria-label="Save land name"
                >
                  {renameSaving ? '…' : '✓'}
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={renameSaving}
                  data-testid="ar-land-rename-cancel"
                  aria-label="Cancel rename"
                  onClick={cancelRename}
                >
                  ✕
                </button>
              </div>
            </form>
          ) : land.isOwned ? (
            <button
              type="button"
              className="mobile-land-name-btn ar-land-title-btn"
              data-testid="ar-land-title-edit-trigger"
              aria-label={`Rename ${displayName}`}
              title="Tap to rename your land"
              onClick={startRename}
            >
              <span className="ar-land-title">{displayName}</span>
              <span className="mobile-land-name-edit-cue" aria-hidden="true">
                ✏️
              </span>
            </button>
          ) : (
            <h2 className="ar-land-title">{displayName}</h2>
          )}

          {isRenaming && renameError && (
            <div className="mobile-land-rename-error" role="alert">
              {renameError}
            </div>
          )}
        </div>

        {land.description && <p className="ar-land-desc">{land.description}</p>}

        {exp.state !== 'permanent' && (
          <div className={`mobile-land-expiry-banner ${exp.urgent ? 'is-urgent' : ''}`}>
            <XeroIcon emoji={exp.state === 'expired' ? '⚠️' : '⏳'} size={12} />
            <span>{exp.detailText}</span>
          </div>
        )}

        {/* Quiet Read-Only Land Info Card (distinct from action buttons — zero button borders!) */}
        <div
          className="ar-land-info-card"
          data-testid="ar-land-meta-chips"
          aria-label="Land information"
        >
          <div className="ar-land-info-row">
            <div className="ar-land-info-cell">
              <span className="ar-land-info-key">Owner</span>
              {onOpenProfile && stewardHandle ? (
                <button
                  type="button"
                  className="ar-land-info-link"
                  onClick={() => onOpenProfile(stewardHandle)}
                >
                  <UserHandleBadge
                    user={{
                      id: land.ownerSub || land.stewardSub,
                      username: land.stewardUsername,
                      stewardName: land.stewardName,
                      stewardType: land.stewardType,
                      avatarImage: land.stewardAvatar
                    }}
                    fallback={land.stewardType === 'agent' ? 'AI Steward' : 'Land Holder'}
                    size="xs"
                  />
                  <span className="ar-land-info-link-arrow" aria-hidden="true">
                    ↗
                  </span>
                </button>
              ) : (
                <span className="ar-land-info-val">
                  <UserHandleBadge
                    user={{
                      id: land.ownerSub || land.stewardSub,
                      username: land.stewardUsername,
                      stewardName: land.stewardName,
                      stewardType: land.stewardType,
                      avatarImage: land.stewardAvatar
                    }}
                    fallback={land.stewardType === 'agent' ? 'AI Steward' : 'Land Holder'}
                    size="xs"
                  />
                </span>
              )}
            </div>

            <div className="ar-land-info-cell is-right">
              <span className="ar-land-info-key">Status</span>
              <span className={`ar-land-info-val ${land.isFrozen ? 'is-frozen' : 'is-open'}`}>
                <span className="ar-land-info-dot" aria-hidden="true" />
                {land.isFrozen ? 'Frozen' : 'Open'}
                {Number(land.humanContributorCount || 0) > 0
                  ? ` · ${land.humanContributorCount} ${
                      Number(land.humanContributorCount) === 1 ? 'artist' : 'artists'
                    }`
                  : ''}
              </span>
            </div>
          </div>

          <div className="ar-land-info-row is-secondary">
            {resolvedDimsLabel && (
              <div className="ar-land-info-cell">
                <span className="ar-land-info-key">Size</span>
                <span className="ar-land-info-val">{resolvedDimsLabel}</span>
              </div>
            )}
            <div className="ar-land-info-cell is-right">
              <span className="ar-land-info-key">Views</span>
              <span className="ar-land-info-val mono" data-testid="ar-land-views-readout">
                🚶 {Math.max(0, Number(land.inPersonViews || 0))} IRL · 👁️{' '}
                {Math.max(0, Number(land.pageViews || 0))}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ZONE 2: CLEAR INTERACTIVE ACTIONS */}
      <div className="ar-land-actions-section" data-testid="ar-land-actions-section">
        <div className="ar-land-section-kicker">Actions</div>

        {hasAnyLockedAction && (
          <div
            className={`ar-land-visit-lock-note ${visitLockPulse ? 'is-pulsed' : ''}`}
            data-testid="ar-land-visit-lock-note"
            role="status"
            aria-live="polite"
          >
            <XeroIcon emoji="🔒" size={12} />
            <span>{visitLockNotice || defaultVisitLockMessage}</span>
          </div>
        )}

        {primaryActionCount > 0 && (
          <div
            className={`ar-land-primary-grid ${primaryActionCount === 1 ? 'is-single' : ''}`}
            data-testid="ar-land-primary-actions"
          >
            {hasPrimaryDraw && (
              <button
                type="button"
                className={`btn ar-land-primary-btn ${
                  canDrawAtLand ? 'btn-primary' : 'is-action-locked'
                }`}
                data-testid="ar-land-draw-btn"
                data-locked={canDrawAtLand ? 'false' : 'true'}
                aria-disabled={canDrawAtLand ? undefined : 'true'}
                title={
                  !canDrawAtLand
                    ? `Visit ${displayName} in person to draw on this land`
                    : exp.state !== 'permanent'
                    ? 'Draw manually in Mobile AR here to fully mint & permanently own this land (removes timer)'
                    : 'Draw manually in Mobile AR on this land'
                }
                onClick={() => {
                  if (!canDrawAtLand) {
                    notifyVisitRequired('draw on this land', PIN_PARCEL_MAX_DISTANCE_M);
                    return;
                  }
                  onDrawHere(land);
                }}
              >
                <XeroIcon emoji={canDrawAtLand ? '🎨' : '🔒'} size={14} />
                <span>{exp.state !== 'permanent' ? 'Draw Here to Own' : 'Draw Here'}</span>
              </button>
            )}
            {canOpenLandChat &&
              (isChatUnlocked ? (
                <button
                  type="button"
                  className="btn ar-land-secondary-primary-btn"
                  data-testid="ar-land-chat-btn"
                  data-locked="false"
                  aria-label={`Open chat for ${displayName}`}
                  title={`Open encrypted in-person chat for ${displayName}`}
                  onClick={handleOpenLandChat}
                >
                  <XeroIcon emoji="💬" size={14} />
                  <span>
                    Land Chat{landChatMessageCount > 0 ? ` (${landChatMessageCount})` : ''}
                  </span>
                </button>
              ) : (
                <div className="ar-land-chat-lock-row" data-testid="ar-land-chat-lock-row">
                  <button
                    type="button"
                    className="btn ar-land-secondary-primary-btn is-action-locked"
                    data-testid="ar-land-chat-btn"
                    data-locked="true"
                    aria-disabled="true"
                    aria-label={chatAvailability.reason || `Land Chat locked for ${displayName}`}
                    title={chatAvailability.reason || `Land Chat locked for ${displayName}`}
                    onClick={handleOpenLandChat}
                  >
                    <XeroIcon emoji="🔒" size={14} />
                    <span>
                      Land Chat{landChatMessageCount > 0 ? ` (${landChatMessageCount})` : ''}
                    </span>
                  </button>
                  <span
                    className="ar-land-chat-lock-info"
                    data-testid="ar-land-chat-lock-info"
                  >
                    <InfoTip
                      title={chatAvailability.title || 'Why Land Chat is locked'}
                      mode="popover"
                      align="right"
                    >
                      {chatAvailability.reason}
                    </InfoTip>
                  </span>
                </div>
              ))}
            {hasPrimaryCheckIn && (
              <button
                type="button"
                className={`btn ar-land-secondary-primary-btn ${
                  !canCheckInAtLand
                    ? 'is-action-locked'
                    : checkedInDone
                    ? 'btn-primary'
                    : ''
                }`}
                data-testid="ar-land-checkin-btn"
                data-locked={canCheckInAtLand ? 'false' : 'true'}
                aria-disabled={canCheckInAtLand ? undefined : 'true'}
                disabled={canCheckInAtLand && checkInBusy}
                title={
                  canCheckInAtLand
                    ? "Verify your physical in-person presence (Camera + GPS) to extend this land's timer (draw art to make it permanent)"
                    : `Visit ${displayName} in person to check in IRL`
                }
                onClick={async () => {
                  if (!canCheckInAtLand) {
                    notifyVisitRequired('check in IRL', PIN_PARCEL_MAX_DISTANCE_M);
                    return;
                  }
                  if (checkInBusy) return;
                  setCheckInBusy(true);
                  try {
                    const ok = await onCheckInLand(land);
                    if (ok) setCheckedInDone(true);
                  } finally {
                    setCheckInBusy(false);
                  }
                }}
              >
                <XeroIcon
                  emoji={!canCheckInAtLand ? '🔒' : checkedInDone ? '✅' : '📍'}
                  size={13}
                />
                <span>
                  {!canCheckInAtLand
                    ? 'Check In IRL'
                    : checkInBusy
                    ? 'Verifying…'
                    : checkedInDone
                    ? 'Visited IRL'
                    : 'Check In IRL'}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Uniform Secondary Quick-Tool Action Bar */}
        <div className="ar-land-tools-bar" data-testid="ar-land-secondary-actions">
          {onOpen3DMap && (
            <button
              type="button"
              className="ar-land-tool-btn"
              data-testid="ar-land-3d-map-btn"
              onClick={() => onOpen3DMap(land)}
            >
              <XeroIcon emoji="🧊" size={14} />
              <span>3D Map</span>
            </button>
          )}
          {land.isOwned && onManageLand && (
            <button
              type="button"
              className="ar-land-tool-btn"
              data-testid="ar-land-manage-btn"
              onClick={() => onManageLand(land.parcelId)}
            >
              <XeroIcon emoji="⚙️" size={18} />
              <span>Manage</span>
            </button>
          )}
          {land.googleMapsUrl && (
            <a
              className={`ar-land-tool-btn ${!canDrawAtLand ? 'is-recommended' : ''}`}
              href={land.googleMapsUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="ar-land-gmaps-link"
              aria-label={`Navigate to ${displayName}`}
            >
              <XeroIcon emoji="🧭" size={14} />
              <span>Navigate</span>
            </a>
          )}
        </div>
      </div>

      {/* ZONE 3: ART ON THIS LAND */}
      {sculptures.length > 0 && (
        <div className="ar-land-sculptures" data-testid="ar-land-sculptures-list">
          <div className="ar-land-section-kicker">
            Art on This Land ({sculptures.length})
          </div>
          <div className="ar-land-sculptures-scroll">
            {sculptures.map((sc) => (
              <div
                key={sc.id}
                className={`ar-land-sc-row${onInspectSculpture ? ' is-clickable' : ''}`}
                data-testid="ar-land-sculpture-row"
                role={onInspectSculpture ? 'button' : undefined}
                tabIndex={onInspectSculpture ? 0 : undefined}
                title={
                  onInspectSculpture
                    ? `View "${sc.title || 'Untitled Artwork'}" in 3D`
                    : undefined
                }
                onClick={onInspectSculpture ? () => onInspectSculpture(sc) : undefined}
                onKeyDown={
                  onInspectSculpture
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onInspectSculpture(sc);
                        }
                      }
                    : undefined
                }
              >
                <div className="ar-land-sc-info">
                  <div
                    className={`ar-land-sc-title${onInspectSculpture ? ' artwork-title-link-btn' : ''}`}
                    data-testid="ar-land-artwork-label"
                  >
                    <span>{sc.title || 'Untitled Artwork'}</span>
                    {onInspectSculpture && (
                      <span className="artwork-title-link-arrow" aria-hidden="true">↗</span>
                    )}
                  </div>
                  <div className="ar-land-sc-meta mono" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span>{formatSculptureAssetMeta(sc)}</span>
                    {(sc.creatorUsername || sc.creatorName) && (
                      <>
                        <span>·</span>
                        <UserHandleBadge
                          user={{
                            id: sc.creatorSub,
                            username: sc.creatorUsername,
                            creatorName: sc.creatorName,
                            avatarImage: sc.creatorAvatar
                          }}
                          fallback="Creator"
                          size="xs"
                        />
                      </>
                    )}
                    {formatShortDate(sc.createdAt) ? ` · ${formatShortDate(sc.createdAt)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
