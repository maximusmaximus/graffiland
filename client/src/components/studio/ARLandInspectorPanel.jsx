import React, { useEffect, useState } from 'react';
import {
  buildParcelShareUrl,
  resolveLandDisplayName
} from '../../../../shared/landVolume.mjs';
import { api } from '../../utils/api.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import {
  formatDistanceMeters,
  formatLandDimensions,
  formatSculptureAssetMeta,
  formatShortDate,
  resolveLandCoords
} from '../../utils/landMapHelpers.js';
import { useMeasurementUnits } from '../../utils/measurementUnits.js';
import { EmojiInput } from '../EmojiField.jsx';
import InfoTip from '../InfoTip.jsx';
import UserHandleBadge from '../UserHandleBadge.jsx';
import XeroIcon from '../XeroIcon.jsx';

/**
 * Interactive Land Details & Quick Actions overlay displayed directly over the live AR camera
 * view when the user taps on a visible nearby land (or the live "On / Near Land" camera pill).
 * While active, non-essential drawing HUD buttons are temporarily hidden so the user can
 * inspect and interact with the land effortlessly.
 */
/**
 * Resolves the single canonical chat target for a Virtual Land so all visitors and
 * artworks on that land share one chat room (preferring an initialized board, else
 * the earliest sculpture on the land, else the parcel itself for an empty land).
 */
export function resolveLandChatTarget(land, displayName = '') {
  if (!land) return null;
  const sculptures = Array.isArray(land.sculptures) ? land.sculptures : [];
  const label =
    displayName ||
    resolveLandDisplayName({
      customName: String(land.customName || '').trim(),
      displayName: land.displayName || '',
      firstSculptureTitle: sculptures[0]?.title || ''
    });

  if (sculptures.length > 0) {
    const initialized = sculptures.find((s) => s?.chatSummary?.initialized);
    const chosen = initialized || sculptures[0];
    return {
      ...chosen,
      parcelId: chosen.parcelId || land.parcelId,
      parcelName: chosen.parcelName || land.customName || label
    };
  }

  if (!land.parcelId) return null;
  const lat = land.centerLat ?? land.volume?.centerLat ?? null;
  const lng = land.centerLng ?? land.volume?.centerLng ?? null;
  return {
    id: land.parcelId,
    parcelId: land.parcelId,
    parcelName: label,
    customName: land.customName || '',
    title: label,
    lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
    lng: Number.isFinite(Number(lng)) ? Number(lng) : null,
    creatorSub: land.ownerSub || land.stewardSub || '',
    creatorUsername: land.stewardUsername || '',
    creatorName: land.stewardName || '',
    creatorAvatar: land.stewardAvatar || '',
    isParcelChat: true
  };
}

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
  sensorStatus = null,
  onAdjustCompassNudge = null,
  onResetCompassNudge = null,
  webxrSupported = false,
  webxrActive = false,
  onToggleWebxr = null,
  onClose
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [localDisplayName, setLocalDisplayName] = useState('');
  const [checkInBusy, setCheckInBusy] = useState(false);
  const [checkedInDone, setCheckedInDone] = useState(false);
  const hasAlignTool = typeof onAdjustCompassNudge === 'function';
  const autoExpandAlign = Boolean(
    sensorStatus?.manualYawNudgeDeg || sensorStatus?.needsCompassCalibration || webxrActive
  );
  const [alignExpanded, setAlignExpanded] = useState(autoExpandAlign);
  const { unitSystem } = useMeasurementUnits(null, resolveLandCoords(land));

  useEffect(() => {
    if (autoExpandAlign) setAlignExpanded(true);
  }, [autoExpandAlign]);

  // Reset inline rename & check-in state when switching to a different nearby land
  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft('');
    setRenameError('');
    setLocalDisplayName('');
    setCheckInBusy(false);
    setCheckedInDone(false);
    setAlignExpanded(autoExpandAlign);
  }, [land?.parcelId, autoExpandAlign]);

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
  const landChatMessageCount = sculptures.reduce(
    (maxCnt, sc) => Math.max(maxCnt, Number(sc?.chatSummary?.messageCount || 0)),
    Number(land?.chatMessageCount || 0)
  );
  const handleOpenLandChat = () => {
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

  const hasPrimaryDraw = Boolean(!land.isFrozen && onDrawHere);
  const hasPrimaryCheckIn = Boolean(exp.state !== 'permanent' && typeof onCheckInLand === 'function');
  const primaryActionCount =
    (hasPrimaryDraw ? 1 : 0) + (canOpenLandChat ? 1 : 0) + (hasPrimaryCheckIn ? 1 : 0);

  return (
    <section
      className="ar-land-inspector hud-interactive"
      role="dialog"
      aria-label={`Land details for ${displayName}`}
      data-testid="ar-land-inspector"
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
            {land.centerLat !== null && land.centerLng !== null && (
              <div className="ar-land-info-cell is-right">
                <span className="ar-land-info-key">GPS</span>
                <span className="ar-land-info-val mono">
                  {Number(land.centerLat).toFixed(4)}, {Number(land.centerLng).toFixed(4)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ZONE 2: CLEAR INTERACTIVE ACTIONS */}
      <div className="ar-land-actions-section" data-testid="ar-land-actions-section">
        <div className="ar-land-section-kicker">Actions</div>

        {primaryActionCount > 0 && (
          <div
            className={`ar-land-primary-grid ${primaryActionCount === 1 ? 'is-single' : ''}`}
            data-testid="ar-land-primary-actions"
          >
            {hasPrimaryDraw && (
              <button
                type="button"
                className="btn btn-primary ar-land-primary-btn"
                data-testid="ar-land-draw-btn"
                title={
                  exp.state !== 'permanent'
                    ? 'Draw manually in Mobile AR here to fully mint & permanently own this land (removes timer)'
                    : 'Draw manually in Mobile AR on this land'
                }
                onClick={() => onDrawHere(land)}
              >
                <XeroIcon emoji="🎨" size={14} />
                <span>{exp.state !== 'permanent' ? 'Draw Here to Own' : 'Draw Here'}</span>
              </button>
            )}
            {canOpenLandChat && (
              <button
                type="button"
                className="btn ar-land-secondary-primary-btn"
                data-testid="ar-land-chat-btn"
                aria-label={`Open chat for ${displayName}`}
                title={`Open encrypted in-person chat for ${displayName}`}
                onClick={handleOpenLandChat}
              >
                <XeroIcon emoji="💬" size={14} />
                <span>
                  Land Chat{landChatMessageCount > 0 ? ` (${landChatMessageCount})` : ''}
                </span>
              </button>
            )}
            {hasPrimaryCheckIn && (
              <button
                type="button"
                className={`btn ar-land-secondary-primary-btn ${
                  checkedInDone ? 'btn-primary' : ''
                }`}
                data-testid="ar-land-checkin-btn"
                disabled={checkInBusy}
                title="Verify your physical in-person presence (Camera + GPS) to extend this land's timer (draw art to make it permanent)"
                onClick={async () => {
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
                <XeroIcon emoji={checkedInDone ? '✅' : '📍'} size={13} />
                <span>
                  {checkInBusy ? 'Verifying…' : checkedInDone ? 'Visited IRL' : 'Check In IRL'}
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
              <XeroIcon emoji="⚙️" size={14} />
              <span>Manage</span>
            </button>
          )}
          {land.googleMapsUrl && (
            <a
              className="ar-land-tool-btn"
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
          <button
            type="button"
            className="ar-land-tool-btn"
            onClick={handleCopyShare}
            aria-label={`Share ${displayName}`}
          >
            <XeroIcon emoji="📤" size={14} />
            <span>Share</span>
          </button>
          {hasAlignTool && (
            <button
              type="button"
              className={`ar-land-tool-btn ${
                alignExpanded || sensorStatus?.manualYawNudgeDeg ? 'is-active' : ''
              }`}
              data-testid="ar-compass-align-toggle-btn"
              aria-expanded={alignExpanded}
              onClick={() => setAlignExpanded((prev) => !prev)}
            >
              <XeroIcon emoji="🎯" size={14} />
              <span>
                {sensorStatus?.manualYawNudgeDeg
                  ? `Align ${sensorStatus.manualYawNudgeDeg > 0 ? '+' : ''}${
                      sensorStatus.manualYawNudgeDeg
                    }°`
                  : 'Align AR'}
              </span>
            </button>
          )}
        </div>

        {/* Collapsible Compass Fine-Align Nudge & 6-DoF ARCore Controls */}
        {hasAlignTool && alignExpanded && (
          <div
            className="ar-compass-nudge-bar"
            data-testid="ar-compass-nudge-controls"
            aria-label="Compass fine alignment"
          >
            <div className="ar-compass-nudge-head">
              <span className="ar-compass-nudge-label">
                <XeroIcon emoji="🧭" size={12} /> Fine-Align Bearing
                <InfoTip title="Fine-Align Compass Bearing">
                  Near steel buildings or cars, phone magnetometers can drift by a few degrees. Tap
                  −5° / −1° / +1° / +5° to fine-align lands to your real-world view, or wave your
                  phone in a figure-8 to recalibrate.
                </InfoTip>
              </span>
              <span className="mono ar-compass-nudge-readout">
                {sensorStatus?.manualYawNudgeDeg
                  ? `${sensorStatus.manualYawNudgeDeg > 0 ? '+' : ''}${sensorStatus.manualYawNudgeDeg}°`
                  : '0°'}
              </span>
            </div>
            <div className="ar-compass-nudge-btns">
              <button
                type="button"
                className="btn btn-xs"
                data-testid="ar-compass-nudge-left5"
                onClick={() => onAdjustCompassNudge(-5)}
                aria-label="Nudge compass left 5 degrees"
              >
                −5°
              </button>
              <button
                type="button"
                className="btn btn-xs"
                data-testid="ar-compass-nudge-left1"
                onClick={() => onAdjustCompassNudge(-1)}
                aria-label="Nudge compass left 1 degree"
              >
                −1°
              </button>
              <button
                type="button"
                className="btn btn-xs"
                data-testid="ar-compass-nudge-reset"
                disabled={!sensorStatus?.manualYawNudgeDeg}
                onClick={() => onResetCompassNudge?.()}
              >
                Reset
              </button>
              <button
                type="button"
                className="btn btn-xs"
                data-testid="ar-compass-nudge-right1"
                onClick={() => onAdjustCompassNudge(1)}
                aria-label="Nudge compass right 1 degree"
              >
                +1°
              </button>
              <button
                type="button"
                className="btn btn-xs"
                data-testid="ar-compass-nudge-right5"
                onClick={() => onAdjustCompassNudge(5)}
                aria-label="Nudge compass right 5 degrees"
              >
                +5°
              </button>
              {webxrSupported && typeof onToggleWebxr === 'function' && (
                <button
                  type="button"
                  className={`btn btn-xs ${webxrActive ? 'btn-primary' : ''}`}
                  data-testid="ar-inspector-webxr-btn"
                  onClick={onToggleWebxr}
                >
                  {webxrActive ? '6-DoF ON' : '6-DoF'}
                </button>
              )}
            </div>
          </div>
        )}
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
                className="ar-land-sc-row"
                data-testid="ar-land-sculpture-row"
              >
                <div className="ar-land-sc-info">
                  {onInspectSculpture ? (
                    <button
                      type="button"
                      className="ar-land-sc-title artwork-title-link-btn"
                      data-testid="ar-land-artwork-label"
                      title={`View "${sc.title || 'Untitled Artwork'}" in 3D`}
                      onClick={() => onInspectSculpture(sc)}
                    >
                      <span>{sc.title || 'Untitled Artwork'}</span>
                      <span className="artwork-title-link-arrow" aria-hidden="true">↗</span>
                    </button>
                  ) : (
                    <div className="ar-land-sc-title">{sc.title || 'Untitled Artwork'}</div>
                  )}
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
                <div className="ar-land-sc-actions">
                  {onInspectSculpture && (
                    <button
                      type="button"
                      className="btn btn-xs ar-land-sc-view-btn"
                      onClick={() => onInspectSculpture(sc)}
                    >
                      <XeroIcon emoji="🧊" size={11} /> View 3D
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
