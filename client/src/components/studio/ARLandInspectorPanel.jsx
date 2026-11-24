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
import UserHandleBadge from '../UserHandleBadge.jsx';
import XeroIcon from '../XeroIcon.jsx';

/**
 * Interactive Land Details & Quick Actions overlay displayed directly over the live AR camera
 * view when the user taps on a visible nearby land (or the live "On / Near Land" camera pill).
 * While active, non-essential drawing HUD buttons are temporarily hidden so the user can
 * inspect and interact with the land effortlessly.
 */
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
  onOpenSculptureChat = null,
  onShowHint = null,
  onClose
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [localDisplayName, setLocalDisplayName] = useState('');
  const [checkInBusy, setCheckInBusy] = useState(false);
  const [checkedInDone, setCheckedInDone] = useState(false);
  const { unitSystem } = useMeasurementUnits(null, resolveLandCoords(land));

  // Reset inline rename & check-in state when switching to a different nearby land
  useEffect(() => {
    setIsRenaming(false);
    setRenameDraft('');
    setRenameError('');
    setLocalDisplayName('');
    setCheckInBusy(false);
    setCheckedInDone(false);
  }, [land?.parcelId]);

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
  const expBadgeClass =
    exp.state === 'expired' || exp.state === 'expiring-soon'
      ? 'badge danger'
      : exp.state === 'expiring' || exp.state === 'dormant'
      ? 'badge gold'
      : 'badge teal';

  const stewardHandle = land.stewardUsername || land.ownerSub || '';

  const sculptures = Array.isArray(land.sculptures) ? land.sculptures : [];
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
      {/* Top Status + Multi-Land Pager + Close */}
      <div className="ar-land-inspector-top">
        <div className="ar-land-status-pills">
          <span
            className={`badge ${land.isInside ? 'gold' : 'teal'}`}
            data-testid="ar-land-proximity-badge"
          >
            <XeroIcon emoji={land.isInside ? '✨' : '📍'} size={11} /> {proximityText}
          </span>
          {land.isOwned && (
            <span className="badge teal" data-testid="ar-land-owned-badge">
              👑 Your Land
            </span>
          )}
          {exp.state !== 'permanent' && (
            <span className={expBadgeClass} title={exp.detailText} data-testid="ar-land-expiry-badge">
              <XeroIcon
                emoji={exp.state === 'expired' ? '⏱️' : '⏳'}
                size={10}
              />{' '}
              {exp.badgeText}
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
            className="btn btn-xs"
            data-testid="ar-land-close-btn"
            aria-label="Close land details and return to camera drawing"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Land Identity (click-to-rename inline for owned land!) */}
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

        {land.centerLat !== null && land.centerLng !== null && (
          <div className="ar-land-subline mono">
            <span>
              {Number(land.centerLat).toFixed(4)}, {Number(land.centerLng).toFixed(4)}
            </span>
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

      {/* Compact Structured Land Metadata */}
      <div className="ar-land-meta-chips" data-testid="ar-land-meta-chips">
        {resolvedDimsLabel && (
          <span className="mobile-meta-chip">
            <XeroIcon emoji="📐" size={11} /> {resolvedDimsLabel}
          </span>
        )}
        {onOpenProfile && stewardHandle ? (
          <button
            type="button"
            className="mobile-meta-chip is-clickable"
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
          </button>
        ) : (
          <span className="mobile-meta-chip">
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
        <span className="mobile-meta-chip">
          <XeroIcon emoji="🎨" size={11} /> {sculptures.length} art
        </span>
        {Number(land.humanContributorCount || 0) > 0 && (
          <span className="mobile-meta-chip">
            <XeroIcon emoji="👥" size={11} /> {land.humanContributorCount}
          </span>
        )}
        <span className={`mobile-meta-chip ${land.isFrozen ? 'is-frozen' : ''}`}>
          <XeroIcon emoji={land.isFrozen ? '❄️' : '✅'} size={11} />{' '}
          {land.isFrozen ? 'Frozen' : 'Open'}
        </span>
      </div>

      {/* Primary Contextual Interactions */}
      <div className="ar-land-actions">
        {!land.isFrozen && onDrawHere && (
          <button
            type="button"
            className="btn btn-primary btn-xs ar-land-primary-cta"
            data-testid="ar-land-draw-btn"
            onClick={() => onDrawHere(land)}
          >
            <XeroIcon emoji="🎨" size={13} /> Draw Here
          </button>
        )}
        {typeof onCheckInLand === 'function' && (
          <button
            type="button"
            className={`btn btn-xs ${checkedInDone ? 'btn-primary' : ''}`}
            data-testid="ar-land-checkin-btn"
            disabled={checkInBusy}
            title="Verify your physical in-person presence (Camera + GPS) to keep this land active"
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
            <XeroIcon emoji={checkedInDone ? '✅' : '📍'} size={12} />{' '}
            {checkInBusy ? 'Verifying…' : checkedInDone ? 'Visited In Person' : 'Check In IRL'}
          </button>
        )}
        {onOpen3DMap && (
          <button
            type="button"
            className="btn btn-xs mobile-land-3d-btn"
            data-testid="ar-land-3d-map-btn"
            onClick={() => onOpen3DMap(land)}
          >
            <XeroIcon emoji="🧊" size={13} /> 3D Map
          </button>
        )}
        {land.isOwned && onManageLand && (
          <button
            type="button"
            className="btn btn-xs"
            data-testid="ar-land-manage-btn"
            onClick={() => onManageLand(land.parcelId)}
          >
            <XeroIcon emoji="⚙️" size={13} /> Manage
          </button>
        )}
        {land.googleMapsUrl && (
          <a
            className="btn btn-xs mobile-land-gmaps-btn"
            href={land.googleMapsUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="ar-land-gmaps-link"
            aria-label={`Navigate to ${displayName}`}
          >
            <XeroIcon emoji="🧭" size={12} /> Navigate
          </a>
        )}
        <button
          type="button"
          className="btn btn-xs"
          onClick={handleCopyShare}
          aria-label={`Share ${displayName}`}
        >
          <XeroIcon emoji="📤" size={12} /> Share
        </button>
      </div>

      {/* Sculptures Currently on This Land */}
      {sculptures.length > 0 && (
        <div className="ar-land-sculptures" data-testid="ar-land-sculptures-list">
          <div className="ar-land-sculptures-label">
            <XeroIcon emoji="🧊" size={11} /> Sculptures on this land ({sculptures.length})
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
                  {onOpenSculptureChat && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      aria-label={`Chat on ${sc.title}`}
                      onClick={() => onOpenSculptureChat(sc, land.distanceMeters ?? 0)}
                    >
                      <XeroIcon emoji="💬" size={12} />
                    </button>
                  )}
                  {onInspectSculpture && (
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      onClick={() => onInspectSculpture(sc)}
                    >
                      <XeroIcon emoji="🧊" size={11} /> 3D
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
