import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildParcelShareUrl } from '../../../../shared/landVolume.mjs';
import { api } from '../../utils/api.js';
import { getSculptureChainLinks } from '../../utils/chainLinks.js';
import {
  buildSculptureShareUrl,
  copyToClipboard
} from '../../utils/clipboard.js';
import {
  formatSculptureAssetMeta,
  formatShortDate,
  groupNearestLandsWithSculptures,
  isLandOwnedByUser,
  resolveLandCoords
} from '../../utils/landMapHelpers.js';
import {
  formatRadiusLabel,
  useMeasurementUnits
} from '../../utils/measurementUnits.js';
import { buildPendingPreviewSculptures } from '../../utils/pendingApprovalPreview.js';
import { EmojiInput } from '../EmojiField.jsx';
import MapView from '../MapView.jsx';
import { GlobalNotificationBell } from '../NotificationCenter.jsx';
import UserHandleBadge from '../UserHandleBadge.jsx';
import XeroIcon from '../XeroIcon.jsx';
import MobileIsometricMap from './MobileIsometricMap.jsx';

export default function MobileMapSheet({
  user = null,
  ownedParcelIds = [],
  config,
  location,
  areaFilterMode = 'nearby',
  setAreaFilterMode,
  mapLoading = false,
  loadPublicMapData,
  displayedMapSculptures = [],
  areaSculpturesSorted = [],
  mapParcels = [],
  pendingSignatures = [],
  mapSelectedSculpture = null,
  selectedParcelId = '',
  focusParcelTick = 0,
  initialDimensionMode = '3d',
  onSelectParcel,
  onSelectSculpture,
  onFindLandInAR = null,
  onMarkLandSeen = null,
  onOpenProfile = null,
  onManageLand = null,
  onRenameLand = null,
  onShowHint,
  onClose,
  nowMsOverride = null
}) {
  const [mapHeightMode, setMapHeightMode] = useState('compact'); // 'compact' | 'fullscreen'
  const [mapDimensionMode, setMapDimensionMode] = useState(() =>
    initialDimensionMode === '2d' ? '2d' : '3d'
  ); // '3d' | '2d'
  const [localSelectedParcelId, setLocalSelectedParcelId] = useState(selectedParcelId || '');
  const [localFocusTick, setLocalFocusTick] = useState(0);
  const [expandedLandIds, setExpandedLandIds] = useState({});
  const [collapsedLandIds, setCollapsedLandIds] = useState({});
  const [nowMs, setNowMs] = useState(() => (nowMsOverride ?? Date.now()));
  const [editingParcelId, setEditingParcelId] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renamedNames, setRenamedNames] = useState({});
  const cardRefs = useRef(new Map());
  const mapCanvasRef = useRef(null);
  const sharedFullViewportRef = useRef(null);

  useEffect(() => {
    setLocalSelectedParcelId(selectedParcelId || '');
  }, [selectedParcelId]);

  const effectiveSelectedParcelId = localSelectedParcelId;

  const fallbackParcelCoords = useMemo(() => {
    for (const p of mapParcels || []) {
      const c = resolveLandCoords(p);
      if (c) return c;
    }
    return null;
  }, [mapParcels]);
  const { unitSystem } = useMeasurementUnits(location, fallbackParcelCoords);
  const nearbyRadiusLabel = formatRadiusLabel(5000, unitSystem);

  useEffect(() => {
    if (nowMsOverride !== null) {
      setNowMs(nowMsOverride);
      return undefined;
    }
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [nowMsOverride]);

  const effectiveParcels = useMemo(() => {
    const keys = Object.keys(renamedNames);
    if (keys.length === 0) return mapParcels;
    return (mapParcels || []).map((p) =>
      p?.parcelId && Object.prototype.hasOwnProperty.call(renamedNames, p.parcelId)
        ? { ...p, customName: renamedNames[p.parcelId] }
        : p
    );
  }, [mapParcels, renamedNames]);

  const effectiveSculptures = useMemo(
    () => (areaSculpturesSorted.length > 0 ? areaSculpturesSorted : displayedMapSculptures),
    [areaSculpturesSorted, displayedMapSculptures]
  );

  const grouped = useMemo(
    () =>
      groupNearestLandsWithSculptures({
        parcels: effectiveParcels,
        sculptures: effectiveSculptures,
        location,
        filterMode: areaFilterMode,
        radiusMeters: 5000,
        nowMs,
        unitSystem
      }),
    [effectiveParcels, effectiveSculptures, location, areaFilterMode, nowMs, unitSystem]
  );

  const displayedLands = grouped.displayedLands;
  const totalSculpturesInView = grouped.displayedSculptures.length;
  const pendingPreviewSculptures = useMemo(
    () =>
      buildPendingPreviewSculptures(pendingSignatures, {
        parcels: displayedLands,
        existingSculptures: grouped.displayedSculptures
      }),
    [pendingSignatures, displayedLands, grouped.displayedSculptures]
  );
  const mapDisplaySculptures = useMemo(
    () => [...grouped.displayedSculptures, ...pendingPreviewSculptures],
    [grouped.displayedSculptures, pendingPreviewSculptures]
  );
  const isFullMap = mapHeightMode === 'fullscreen';
  const focusedLand = useMemo(
    () =>
      displayedLands.find((l) => l.parcelId === effectiveSelectedParcelId) ||
      displayedLands[0] ||
      null,
    [displayedLands, effectiveSelectedParcelId]
  );

  function markLandSeenById(parcelId) {
    if (!parcelId || typeof onMarkLandSeen !== 'function') return;
    const match = displayedLands.find((l) => l.parcelId === parcelId);
    onMarkLandSeen(parcelId, Array.isArray(match?.sculptures) ? match.sculptures.length : null);
  }

  function toggleCardExpanded(parcelId) {
    if (!parcelId) return;
    setExpandedLandIds((prev) => {
      const opening = !prev[parcelId];
      if (opening) markLandSeenById(parcelId);
      return {
        ...prev,
        [parcelId]: opening
      };
    });
  }

  function handleClickLandRank(parcelId) {
    if (!parcelId) return;
    markLandSeenById(parcelId);
    setLocalSelectedParcelId(parcelId);
    onSelectParcel?.(parcelId);
    setLocalFocusTick((t) => t + 1);
    setExpandedLandIds((prev) => ({ ...prev, [parcelId]: true }));
    setCollapsedLandIds((prev) => ({ ...prev, [parcelId]: false }));
  }

  function toggleLandSculptures(parcelId) {
    setCollapsedLandIds((prev) => ({
      ...prev,
      [parcelId]: !prev[parcelId]
    }));
  }

  function handleSelectParcelOnMap(parcel) {
    const pid = parcel?.parcelId || '';
    if (!pid) return;
    markLandSeenById(pid);
    setLocalSelectedParcelId(pid);
    onSelectParcel?.(pid);
    setExpandedLandIds((prev) => ({ ...prev, [pid]: true }));
    setCollapsedLandIds((prev) => ({ ...prev, [pid]: false }));
    const node = cardRefs.current.get(pid);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function handleFocusLandOnMap(parcelId) {
    if (!parcelId) return;
    if (editingParcelId && editingParcelId !== parcelId && !renameSaving) {
      cancelInlineRename();
    }
    markLandSeenById(parcelId);
    setLocalSelectedParcelId(parcelId);
    onSelectParcel?.(parcelId);
    setLocalFocusTick((t) => t + 1);
  }

  function handleCardBlankAreaClick(e, parcelId) {
    if (!parcelId) return;
    // Preserve clicks on buttons, links, rename inputs/forms, and nested sculpture items
    const interactive = e.target?.closest?.(
      'button, a, input, textarea, select, form, [role="button"]'
    );
    if (interactive) return;
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (selection && String(selection).trim().length > 0) return;
    handleFocusLandOnMap(parcelId);
  }

  function handleOpenLandIn3D(parcelId) {
    if (!parcelId) return;
    markLandSeenById(parcelId);
    setLocalSelectedParcelId(parcelId);
    onSelectParcel?.(parcelId);
    setMapDimensionMode('3d');
    setLocalFocusTick((t) => t + 1);
  }

  async function handleCopyLandShare(land) {
    const shareUrl = buildParcelShareUrl({
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
      parcelId: land.parcelId,
      customName: land.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    onShowHint?.(ok ? `Copied share link for ${land.displayName}!` : 'Copy unavailable');
  }

  function startInlineRename(land) {
    if (!land?.parcelId || renameSaving) return;
    setEditingParcelId(land.parcelId);
    setRenameDraft(String(land.customName || ''));
    setRenameError('');
  }

  function cancelInlineRename() {
    if (renameSaving) return;
    setEditingParcelId('');
    setRenameDraft('');
    setRenameError('');
  }

  async function submitInlineRename(e, land) {
    e.preventDefault();
    if (!land?.parcelId || renameSaving) return;
    const nextName = String(renameDraft || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 48);
    if (nextName === String(land.customName || '').trim()) {
      setEditingParcelId('');
      setRenameError('');
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
      setRenamedNames((prev) => ({ ...prev, [land.parcelId]: nextName }));
      setEditingParcelId('');
      setRenameDraft('');
      onShowHint?.(
        nextName ? `Renamed land to "${nextName}"!` : 'Updated land name'
      );
    } catch (err) {
      setRenameError(err?.message || 'Could not rename land');
    } finally {
      setRenameSaving(false);
    }
  }

  function toggleFullMap() {
    setMapHeightMode((prev) => (prev === 'fullscreen' ? 'compact' : 'fullscreen'));
  }

  const mapToggleLabel = isFullMap ? 'Exit Full' : 'Expand Map';

  return (
    <div className="mobile-map-overlay" role="dialog" aria-label="Nearest Lands and Sculptures Map">
      <div className="mobile-map-header">
        <div className="mobile-map-title-group">
          <XeroIcon emoji="🗺️" size={20} />
          <div style={{ minWidth: 0 }}>
            <div className="mobile-map-title">Nearest Lands</div>
            <div className="mobile-map-subtitle">
              Closest parcels · Sculptures · Expiry · Navigate
            </div>
          </div>
        </div>
        <div className="mobile-map-header-actions">
          <GlobalNotificationBell compact testId="mobile-map-notif-bell-btn" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={mapLoading}
            onClick={loadPublicMapData}
            aria-label="Refresh nearest lands"
            title="Refresh lands & sculptures"
          >
            <XeroIcon emoji="🔄" size={14} />
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close map"
            title="Close"
          >
            <XeroIcon emoji="❌" size={14} />
          </button>
        </div>
      </div>

      <div className="mobile-map-controls">
        <div className="mobile-map-segmented" role="group" aria-label="Distance filter">
          <button
            type="button"
            className={`btn btn-xs ${areaFilterMode === 'nearby' ? 'btn-primary' : ''}`}
            onClick={() => setAreaFilterMode?.('nearby')}
          >
            Nearest{grouped.nearbyLands.length > 0 ? ` (${grouped.nearbyLands.length})` : ` (${nearbyRadiusLabel})`}
          </button>
          <button
            type="button"
            className={`btn btn-xs ${areaFilterMode === 'all' ? 'btn-primary' : ''}`}
            onClick={() => setAreaFilterMode?.('all')}
          >
            All Lands ({grouped.allLands.length})
          </button>
        </div>

        <button
          type="button"
          className={`btn btn-xs ${isFullMap ? 'btn-primary' : ''}`}
          data-testid="mobile-map-expand-header-btn"
          onClick={toggleFullMap}
          aria-label={mapToggleLabel}
        >
          <XeroIcon emoji={isFullMap ? '↙️' : '↕️'} size={12} /> {mapToggleLabel}
        </button>
      </div>

      <div
        ref={mapCanvasRef}
        className={`mobile-map-canvas ${
          isFullMap ? 'is-fullscreen' : 'is-compact'
        }`}
        data-testid="mobile-map-canvas"
        data-map-expanded={isFullMap ? 'fullscreen' : 'compact'}
        data-focused-parcel-id={effectiveSelectedParcelId || ''}
      >
        {mapDimensionMode === '3d' ? (
          <MobileIsometricMap
            parcels={displayedLands}
            sculptures={mapDisplaySculptures}
            userLocation={location}
            selectedParcelId={effectiveSelectedParcelId}
            selectedSculptureId={mapSelectedSculpture?.id || ''}
            focusParcelTick={focusParcelTick + localFocusTick}
            isFullExpanded={isFullMap}
            initialView={isFullMap ? sharedFullViewportRef.current : null}
            onViewportChange={(vp) => {
              sharedFullViewportRef.current = vp;
            }}
            onToggle2D={() => setMapDimensionMode('2d')}
            onToggleFullMap={toggleFullMap}
            onSelectParcel={handleSelectParcelOnMap}
            onSelectSculpture={onSelectSculpture}
            onOpenSculptureView={onSelectSculpture}
          />
        ) : (
          <MapView
            sculptures={mapDisplaySculptures}
            parcels={displayedLands}
            userLocation={location}
            focusArea={areaFilterMode === 'nearby' && !grouped.autoFallbackToAll}
            areaRadiusMeters={5000}
            selectedSculptureId={mapSelectedSculpture?.id || ''}
            selectedParcelId={effectiveSelectedParcelId}
            focusParcelTick={focusParcelTick + localFocusTick}
            initialView={isFullMap ? sharedFullViewportRef.current : null}
            onViewportChange={(vp) => {
              sharedFullViewportRef.current = {
                ...(sharedFullViewportRef.current || {}),
                ...vp
              };
            }}
            config={config}
            compact
            isFullExpanded={isFullMap}
            onToggle3D={() => setMapDimensionMode('3d')}
            onToggleFullMap={toggleFullMap}
            onSelectSculpture={onSelectSculpture}
            onSelectParcel={handleSelectParcelOnMap}
          />
        )}
      </div>

      {isFullMap && focusedLand && (
        <div className="mobile-map-fullscreen-dock" data-testid="mobile-map-fullscreen-dock">
          <div className="mobile-map-fullscreen-dock-info">
            <strong className="mobile-map-fullscreen-dock-title">{focusedLand.displayName}</strong>
            <span className="mobile-map-fullscreen-dock-meta mono">
              {focusedLand.dimensionsLabel ? `${focusedLand.dimensionsLabel} · ` : ''}
              {`${focusedLand.sculptures.length} art`}
            </span>
          </div>
          <div className="mobile-map-fullscreen-dock-actions">
            {onFindLandInAR && location && (
              <button
                type="button"
                className="btn btn-xs btn-primary"
                data-testid="mobile-map-dock-find-ar-btn"
                onClick={() => {
                  markLandSeenById(focusedLand.parcelId);
                  onFindLandInAR(focusedLand);
                }}
                aria-label={`Find ${focusedLand.displayName} in AR camera`}
              >
                <XeroIcon emoji="👁️" size={12} /> Find in AR
              </button>
            )}
            {focusedLand.googleMapsUrl && (
              <a
                className="btn btn-xs mobile-land-gmaps-btn"
                href={focusedLand.googleMapsUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => markLandSeenById(focusedLand.parcelId)}
                aria-label={`Navigate to ${focusedLand.displayName}`}
              >
                <XeroIcon emoji="🧭" size={12} /> Navigate
              </a>
            )}
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => setMapHeightMode('compact')}
            >
              ▴ List
            </button>
          </div>
        </div>
      )}

      {!isFullMap && (
      <div className="mobile-map-list" data-testid="mobile-nearest-lands-list">
        <div className="mobile-map-summary">
          <div className="mobile-map-summary-left">
            <strong>
              {grouped.autoFallbackToAll
                ? `Closest Lands (${displayedLands.length})`
                : areaFilterMode === 'nearby' && location
                ? `Nearest Lands (${displayedLands.length})`
                : `All Lands (${displayedLands.length})`}
            </strong>
            {grouped.autoFallbackToAll && (
              <span className="mobile-map-fallback-note">
                None within {nearbyRadiusLabel} · sorted closest
              </span>
            )}
          </div>
          <div className="mobile-map-summary-stats">
            <span className="badge">
              <XeroIcon emoji="🎨" size={11} /> {totalSculpturesInView}
            </span>
            {grouped.expiringCount > 0 && (
              <span className="badge gold">
                <XeroIcon emoji="⏳" size={11} /> {grouped.expiringCount} expiring
              </span>
            )}
          </div>
        </div>

        {mapLoading && displayedLands.length === 0 ? (
          <div className="card mobile-land-empty-state">Loading nearest lands &amp; sculptures...</div>
        ) : displayedLands.length === 0 ? (
          <div className="card mobile-land-empty-state">
            No virtual lands claimed yet. Be the first to claim land or paint &amp; mint nearby!
          </div>
        ) : (
          <div className="mobile-land-stack">
            {displayedLands.map((land, index) => {
              const isSelected =
                Boolean(effectiveSelectedParcelId) && effectiveSelectedParcelId === land.parcelId;
              const isOwned = isLandOwnedByUser(land, { user, ownedParcelIds });
              const isRenaming = isOwned && editingParcelId === land.parcelId;
              const isExpanded = Boolean(expandedLandIds[land.parcelId]);
              const isCollapsed = Boolean(collapsedLandIds[land.parcelId]);
              const exp = land.expiration;
              const expBadgeClass =
                exp.state === 'expired' || exp.state === 'expiring-soon'
                  ? 'badge danger'
                  : exp.state === 'expiring' || exp.state === 'dormant'
                  ? 'badge gold'
                  : 'badge teal';
              const stewardHandle = land.stewardUsername || land.ownerSub || '';
              const stewardLabel = land.stewardUsername
                ? `${land.stewardType === 'agent' ? 'AI' : '@'}${land.stewardType === 'agent' ? `: @${land.stewardUsername}` : land.stewardUsername}`
                : land.stewardName
                ? `${land.stewardType === 'agent' ? 'AI' : 'Steward'}: ${land.stewardName}`
                : land.stewardType === 'agent'
                ? 'AI Steward'
                : 'Human Steward';

              return (
                <article
                  key={land.parcelId}
                  ref={(el) => {
                    if (el) cardRefs.current.set(land.parcelId, el);
                    else cardRefs.current.delete(land.parcelId);
                  }}
                  className={`card mobile-land-card ${isExpanded ? 'is-open' : 'is-closed'} ${
                    isSelected ? 'is-selected' : ''
                  } ${isOwned ? 'is-owned' : ''} ${exp.urgent ? 'is-urgent-expiry' : ''}`}
                  data-testid="mobile-land-card"
                  data-parcel-id={land.parcelId}
                  data-owned={isOwned ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : 'false'}
                  data-expanded={isExpanded ? 'true' : 'false'}
                  onClick={(e) => handleCardBlankAreaClick(e, land.parcelId)}
                >
                  {/* Compact Header Row: Triangle + Clickable #Rank (Focus Map & Open) + Name + Top-Right Share */}
                  <div className="mobile-land-card-head">
                    <div className="mobile-land-title-col">
                      <div className="mobile-land-name-row">
                        <button
                          type="button"
                          className={`mobile-land-triangle-btn ${isExpanded ? 'is-open' : ''}`}
                          data-testid="land-card-expand-toggle"
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? `Collapse details for ${land.displayName}`
                              : `Expand details for ${land.displayName}`
                          }
                          title={isExpanded ? 'Hide details' : 'Show details'}
                          onClick={() => toggleCardExpanded(land.parcelId)}
                        >
                          <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                        </button>
                        <button
                          type="button"
                          className="mobile-land-rank mobile-land-rank-btn"
                          data-testid="land-card-rank-btn"
                          aria-label={`Focus ${land.displayName} on map and open details`}
                          title="Jump map to this land & open details"
                          onClick={() => handleClickLandRank(land.parcelId)}
                        >
                          #{index + 1}
                        </button>
                        {isRenaming ? (
                          <form
                            className="mobile-land-rename-form"
                            data-testid="land-inline-rename-form"
                            onSubmit={(e) => submitInlineRename(e, land)}
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
                                  cancelInlineRename();
                                }
                              }}
                            />
                            <div className="mobile-land-rename-actions">
                              <button
                                type="submit"
                                className="btn btn-xs btn-primary"
                                disabled={renameSaving}
                                data-testid="land-inline-rename-save"
                                aria-label="Save land name"
                              >
                                {renameSaving ? '…' : '✓'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs"
                                disabled={renameSaving}
                                data-testid="land-inline-rename-cancel"
                                aria-label="Cancel rename"
                                onClick={cancelInlineRename}
                              >
                                ✕
                              </button>
                            </div>
                          </form>
                        ) : isOwned ? (
                          <button
                            type="button"
                            className="mobile-land-name-btn"
                            data-testid="land-title-edit-trigger"
                            aria-label={`Rename ${land.displayName}`}
                            title="Tap to rename this land"
                            onClick={() => startInlineRename(land)}
                          >
                            <span className="mobile-land-name">{land.displayName}</span>
                            <span className="mobile-land-name-edit-cue" aria-hidden="true">
                              ✏️
                            </span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="mobile-land-name-btn mobile-land-name-target-btn"
                            data-testid="land-title-target-trigger"
                            aria-label={`Target ${land.displayName} on map`}
                            title={`Target ${land.displayName} on map`}
                            onClick={() => handleFocusLandOnMap(land.parcelId)}
                          >
                            <span className="mobile-land-name">{land.displayName}</span>
                          </button>
                        )}
                      </div>
                      {isRenaming && renameError && (
                        <div className="mobile-land-rename-error" role="alert">
                          {renameError}
                        </div>
                      )}

                      {/* Compact single-line summary strip so more lands fit inline */}
                      <div className="mobile-land-compact-meta" data-testid="land-compact-meta">
                        {land.distanceLabel && (
                          <span className="mobile-land-compact-stat is-accent" data-testid="land-distance-badge">
                            <XeroIcon emoji="📍" size={10} /> {land.distanceLabel}
                          </span>
                        )}
                        <span className="mobile-land-compact-stat">
                          <XeroIcon emoji="🎨" size={10} /> {land.sculptures.length}
                        </span>
                        {land.compactDimensionsLabel && (
                          <span className="mobile-land-compact-stat mono">
                            {land.compactDimensionsLabel}
                          </span>
                        )}
                        {exp.state !== 'permanent' && (
                          <span
                            className={`mobile-land-compact-exp ${expBadgeClass}`}
                            data-testid="land-expiration-badge"
                            title={exp.detailText}
                          >
                            <XeroIcon
                              emoji={exp.state === 'expired' ? '⏱️' : '⏳'}
                              size={10}
                            />{' '}
                            {exp.badgeText}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Top-Right Actions (Always visible on closed & open card, with Share at top-right) */}
                    <div className="mobile-land-head-actions">
                      {isOwned && onManageLand && (
                        <button
                          type="button"
                          className="btn btn-xs mobile-land-gear-btn"
                          data-testid="land-manage-gear-btn"
                          aria-label={`Manage ${land.displayName}`}
                          title="Manage this land"
                          onClick={() => onManageLand(land.parcelId)}
                        >
                          <XeroIcon emoji="⚙️" size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-xs mobile-land-share-btn"
                        data-testid="land-card-share-btn"
                        onClick={() => handleCopyLandShare(land)}
                        aria-label={`Copy share link for ${land.displayName}`}
                        title="Share land link"
                      >
                        <XeroIcon emoji="📤" size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Land Details & Sculptures Drawer */}
                  {isExpanded && (
                    <div className="mobile-land-details-body" data-testid="mobile-land-card-details">
                      {land.description && (
                        <p className="mobile-land-description">{land.description}</p>
                      )}

                      {exp.state !== 'permanent' && (
                        <div
                          className={`mobile-land-expiry-banner ${exp.urgent ? 'is-urgent' : ''}`}
                          data-testid="land-expiration-detail"
                        >
                          <XeroIcon emoji={exp.state === 'expired' ? '⚠️' : '⏳'} size={12} />
                          <span>
                            {exp.detailText}
                            {land.firstSparkBoost && exp.state !== 'expired' ? ' · 🔥 2x First-Spark XP' : ''}
                          </span>
                        </div>
                      )}

                      <div className="mobile-land-meta-chips" data-testid="land-metadata">
                        {land.dimensionsLabel && !land.compactDimensionsLabel && (
                          <span className="mobile-meta-chip" title="3D land volume dimensions">
                            <XeroIcon emoji="📐" size={11} /> {land.dimensionsLabel}
                          </span>
                        )}
                        {onOpenProfile && stewardHandle ? (
                          <button
                            type="button"
                            className="mobile-meta-chip is-clickable"
                            onClick={() => onOpenProfile(stewardHandle)}
                            title={`View public profile for ${stewardLabel}`}
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
                        {land.centerLat !== null && land.centerLng !== null && (
                          <span className="mobile-meta-chip mono mobile-land-coords">
                            {land.centerLat.toFixed(4)}, {land.centerLng.toFixed(4)}
                          </span>
                        )}
                        {Number(land.humanContributorCount || 0) > 0 && (
                          <span className="mobile-meta-chip">
                            <XeroIcon emoji="👥" size={11} /> {land.humanContributorCount} contributor
                            {land.humanContributorCount === 1 ? '' : 's'}
                          </span>
                        )}
                        {Number(land.openQuestCount || 0) > 0 && (
                          <span className="mobile-meta-chip is-quest">
                            <XeroIcon emoji="🎯" size={11} /> {land.openQuestCount} open quest
                            {land.openQuestCount === 1 ? '' : 's'}
                          </span>
                        )}
                        {land.isFrozen && (
                          <span className="mobile-meta-chip is-frozen">
                            <XeroIcon emoji="❄️" size={11} /> Frozen
                          </span>
                        )}
                      </div>

                      {/* Land Action Row (Find in AR + Navigate + 3D Map) */}
                      <div className="mobile-land-actions">
                        {onFindLandInAR && location && (
                          <button
                            type="button"
                            className="btn btn-xs btn-primary"
                            data-testid="land-card-find-ar-btn"
                            onClick={() => {
                              markLandSeenById(land.parcelId);
                              onFindLandInAR(land);
                            }}
                            aria-label={`Guide camera to ${land.displayName} in AR`}
                          >
                            <XeroIcon emoji="👁️" size={12} /> Find in AR
                          </button>
                        )}
                        {land.googleMapsUrl && (
                          <a
                            className="btn btn-xs mobile-land-gmaps-btn"
                            href={land.googleMapsUrl}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="land-google-maps-link"
                            onClick={() => markLandSeenById(land.parcelId)}
                            aria-label={`Navigate to ${land.displayName}`}
                          >
                            <XeroIcon emoji="🧭" size={12} /> Navigate
                          </a>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs mobile-land-3d-btn"
                          data-testid="land-card-3d-map-btn"
                          onClick={() => handleOpenLandIn3D(land.parcelId)}
                          aria-label={`View ${land.displayName} in 3D isometric map`}
                        >
                          <XeroIcon emoji="🧊" size={12} /> 3D Map
                        </button>
                      </div>

                      {/* Nested Sculptures under this Land */}
                      <div className="mobile-land-sculptures" data-testid="land-sculptures-section">
                    {land.sculptures.length > 0 ? (
                      <>
                        <button
                          type="button"
                          className="mobile-land-sculptures-toggle"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleLandSculptures(land.parcelId)}
                        >
                          <span className="mobile-land-sculptures-heading">
                            <XeroIcon emoji="🧊" size={12} />
                            <span>
                              Sculptures on this land ({land.sculptures.length})
                            </span>
                          </span>
                          <span className="mobile-land-chevron" aria-hidden="true">
                            {isCollapsed ? '▸' : '▾'}
                          </span>
                        </button>

                        {!isCollapsed && (
                          <div className="mobile-land-sculpture-list">
                            {land.sculptures.map((sc) => {
                              const chainLinks = getSculptureChainLinks(sc, config);
                              const txShort = sc.chain?.txHash
                                ? `${sc.chain.txHash.slice(0, 8)}...`
                                : '';
                              const assetMeta = formatSculptureAssetMeta(sc);
                              const polScore =
                                sc.proofOfLocation?.score ?? sc.polScore ?? null;
                              const createdLabel = formatShortDate(sc.createdAt);
                              const isFeatured =
                                Boolean(land.featuredSculptureId) &&
                                sc.id === land.featuredSculptureId;
                              const roleLabel = isFeatured
                                ? '⭐ Featured'
                                : sc.layerRole === 'steward_stage'
                                ? '🏛️ Stage'
                                : '🎨 Artwork';

                              return (
                                <div
                                  key={sc.id}
                                  className="mobile-land-sculpture-item"
                                  data-testid="land-sculpture-item"
                                  onClick={() => {
                                    markLandSeenById(land.parcelId);
                                    onSelectSculpture?.(sc);
                                  }}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      markLandSeenById(land.parcelId);
                                      onSelectSculpture?.(sc);
                                    }
                                  }}
                                >
                                  <div className="mobile-land-sculpture-info">
                                    <div className="mobile-land-sculpture-title-row">
                                      <span className="mobile-land-sculpture-title">
                                        {sc.title || 'Untitled Sculpture'}
                                      </span>
                                      <span className="mobile-land-sculpture-role">
                                        {roleLabel}
                                      </span>
                                    </div>

                                    {sc.description && (
                                      <div className="mobile-land-sculpture-desc">
                                        {sc.description}
                                      </div>
                                    )}

                                    <div className="mobile-land-sculpture-meta">
                                      {assetMeta && (
                                        <span className="mobile-sc-chip">
                                          <XeroIcon
                                            emoji={sc.modelType === 'custom-3d' ? '📦' : '🧱'}
                                            size={10}
                                          />{' '}
                                          {assetMeta}
                                        </span>
                                      )}
                                      {(sc.creatorUsername || sc.creatorName) && (
                                        <span className="mobile-sc-chip">
                                          <UserHandleBadge
                                            user={{
                                              id: sc.creatorSub,
                                              username: sc.creatorUsername,
                                              creatorName: sc.creatorName,
                                              avatarImage: sc.creatorAvatar
                                            }}
                                            fallback="Creator"
                                            size="xs"
                                            onClick={
                                              onOpenProfile && (sc.creatorUsername || sc.creatorSub)
                                                ? () =>
                                                    onOpenProfile(
                                                      sc.creatorUsername || sc.creatorSub
                                                    )
                                                : null
                                            }
                                          />
                                        </span>
                                      )}
                                      {polScore !== null && Number.isFinite(Number(polScore)) && (
                                        <span className="mobile-sc-chip">
                                          <XeroIcon emoji="🛡️" size={10} /> PoL{' '}
                                          {Math.round(Number(polScore))}
                                        </span>
                                      )}
                                      {createdLabel && (
                                        <span className="mobile-sc-chip">
                                          <XeroIcon emoji="📅" size={10} /> {createdLabel}
                                        </span>
                                      )}
                                      {chainLinks.txUrl ? (
                                        <a
                                          className="mobile-sc-chip is-link"
                                          href={chainLinks.txUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          title="View mint transaction on chain"
                                        >
                                          <XeroIcon emoji="⛓️" size={10} /> Tx {txShort}
                                        </a>
                                      ) : txShort ? (
                                        <span className="mobile-sc-chip">
                                          <XeroIcon emoji="⛓️" size={10} />{' '}
                                          {chainLinks.isSimulated ? 'Pre-chain' : 'Tx'} {txShort}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>

                                  <div className="mobile-land-sculpture-actions">
                                    <button
                                      type="button"
                                      className="btn btn-xs"
                                      title="Copy sculpture link"
                                      aria-label={`Copy share link for ${sc.title}`}
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        const ok = await copyToClipboard(
                                          buildSculptureShareUrl(sc.id)
                                        );
                                        onShowHint?.(
                                          ok ? 'Copied sculpture link!' : 'Copy unavailable'
                                        );
                                      }}
                                    >
                                      <XeroIcon emoji="📤" size={12} />
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-xs"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        markLandSeenById(land.parcelId);
                                        onSelectSculpture?.(sc);
                                      }}
                                    >
                                      <XeroIcon emoji="🧊" size={12} /> 3D
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mobile-land-no-sculptures">
                        {land.isFrozen
                          ? '❄️ No sculptures yet · Land is frozen'
                          : exp.state === 'expiring' ||
                            exp.state === 'expiring-soon' ||
                            exp.state === 'dormant'
                          ? '🔥 No sculptures yet — place the first artwork for 2x XP & awaken this land!'
                          : 'No sculptures placed on this land yet.'}
                      </div>
                    )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}

            {areaFilterMode === 'nearby' &&
              !grouped.autoFallbackToAll &&
              grouped.allLands.length > displayedLands.length && (
                <button
                  type="button"
                  className="btn btn-sm mobile-land-show-all-btn"
                  onClick={() => setAreaFilterMode?.('all')}
                >
                  Show All {grouped.allLands.length} Lands Worldwide
                </button>
              )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
