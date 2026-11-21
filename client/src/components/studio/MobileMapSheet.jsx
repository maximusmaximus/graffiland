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
  isLandOwnedByUser
} from '../../utils/landMapHelpers.js';
import { EmojiInput } from '../EmojiField.jsx';
import MapView from '../MapView.jsx';
import XeroIcon from '../XeroIcon.jsx';

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
  mapSelectedSculpture = null,
  selectedParcelId = '',
  focusParcelTick = 0,
  onSelectParcel,
  onSelectSculpture,
  onOpenProfile = null,
  onManageLand = null,
  onRenameLand = null,
  onShowHint,
  onClose,
  nowMsOverride = null
}) {
  const [mapHeightMode, setMapHeightMode] = useState('compact'); // 'compact' | 'expanded' | 'hidden'
  const [collapsedLandIds, setCollapsedLandIds] = useState({});
  const [nowMs, setNowMs] = useState(() => (nowMsOverride ?? Date.now()));
  const [editingParcelId, setEditingParcelId] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renamedNames, setRenamedNames] = useState({});
  const cardRefs = useRef(new Map());

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
        nowMs
      }),
    [effectiveParcels, effectiveSculptures, location, areaFilterMode, nowMs]
  );

  const displayedLands = grouped.displayedLands;
  const totalSculpturesInView = grouped.displayedSculptures.length;

  function toggleLandSculptures(parcelId) {
    setCollapsedLandIds((prev) => ({
      ...prev,
      [parcelId]: !prev[parcelId]
    }));
  }

  function handleSelectParcelOnMap(parcel) {
    const pid = parcel?.parcelId || '';
    if (!pid) return;
    onSelectParcel?.(pid);
    setCollapsedLandIds((prev) => ({ ...prev, [pid]: false }));
    const node = cardRefs.current.get(pid);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function handleFocusLandOnMap(parcelId) {
    if (mapHeightMode === 'hidden') {
      setMapHeightMode('compact');
    }
    onSelectParcel?.(parcelId);
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
        nextName ? `Renamed land to "${nextName}"!` : `Reset name for ${land.parcelId}`
      );
    } catch (err) {
      setRenameError(err?.message || 'Could not rename land');
    } finally {
      setRenameSaving(false);
    }
  }

  function cycleMapHeight() {
    setMapHeightMode((prev) =>
      prev === 'compact' ? 'expanded' : prev === 'expanded' ? 'hidden' : 'compact'
    );
  }

  const mapToggleLabel =
    mapHeightMode === 'compact'
      ? 'Expand Map'
      : mapHeightMode === 'expanded'
      ? 'Hide Map'
      : 'Show Map';

  return (
    <div className="mobile-map-overlay" role="dialog" aria-label="Nearest Lands and Sculptures Map">
      <div className="mobile-map-header">
        <div className="mobile-map-title-group">
          <XeroIcon emoji="🗺️" size={20} />
          <div style={{ minWidth: 0 }}>
            <div className="mobile-map-title">Nearest Lands</div>
            <div className="mobile-map-subtitle">
              Closest parcels · Sculptures · Expiry · Google Maps
            </div>
          </div>
        </div>
        <div className="mobile-map-header-actions">
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
            Nearest{grouped.nearbyLands.length > 0 ? ` (${grouped.nearbyLands.length})` : ' (5km)'}
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
          className="btn btn-xs"
          onClick={cycleMapHeight}
          aria-label={mapToggleLabel}
        >
          <XeroIcon emoji={mapHeightMode === 'hidden' ? '🗺️' : '↕️'} size={12} /> {mapToggleLabel}
        </button>
      </div>

      {mapHeightMode !== 'hidden' && (
        <div
          className={`mobile-map-canvas ${
            mapHeightMode === 'expanded' ? 'is-expanded' : 'is-compact'
          }`}
        >
          <MapView
            sculptures={grouped.displayedSculptures}
            parcels={displayedLands}
            userLocation={location}
            focusArea={areaFilterMode === 'nearby' && !grouped.autoFallbackToAll}
            areaRadiusMeters={5000}
            selectedSculptureId={mapSelectedSculpture?.id || ''}
            selectedParcelId={selectedParcelId}
            focusParcelTick={focusParcelTick}
            config={config}
            compact
            onSelectSculpture={onSelectSculpture}
            onSelectParcel={handleSelectParcelOnMap}
          />
        </div>
      )}

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
              <span className="mobile-map-fallback-note">None within 5 km · sorted closest</span>
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
              const isSelected = Boolean(selectedParcelId) && selectedParcelId === land.parcelId;
              const isOwned = isLandOwnedByUser(land, { user, ownedParcelIds });
              const isRenaming = isOwned && editingParcelId === land.parcelId;
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
                  className={`card mobile-land-card ${isSelected ? 'is-selected' : ''} ${
                    isOwned ? 'is-owned' : ''
                  } ${exp.urgent ? 'is-urgent-expiry' : ''}`}
                  data-testid="mobile-land-card"
                  data-parcel-id={land.parcelId}
                  data-owned={isOwned ? 'true' : 'false'}
                >
                  {/* Band 1: Identity + Distance + Expiration + Owner Gear */}
                  <div className="mobile-land-card-head">
                    <div className="mobile-land-title-col">
                      <div className="mobile-land-name-row">
                        <span className="mobile-land-rank">#{index + 1}</span>
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
                          <h3 className="mobile-land-name">{land.displayName}</h3>
                        )}
                      </div>
                      {isRenaming && renameError && (
                        <div className="mobile-land-rename-error" role="alert">
                          {renameError}
                        </div>
                      )}
                      <div className="mobile-land-id-row">
                        {land.customName && (
                          <span className="mobile-land-parcel-id">{land.parcelId}</span>
                        )}
                        {land.centerLat !== null && land.centerLng !== null && (
                          <span className="mobile-land-coords">
                            {land.centerLat.toFixed(4)}, {land.centerLng.toFixed(4)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mobile-land-head-badges">
                      {isOwned && onManageLand && (
                        <button
                          type="button"
                          className="btn btn-xs mobile-land-gear-btn"
                          data-testid="land-manage-gear-btn"
                          aria-label={`Manage ${land.displayName}`}
                          title="Manage this land"
                          onClick={() => onManageLand(land.parcelId)}
                        >
                          <XeroIcon emoji="⚙️" size={13} />
                        </button>
                      )}
                      {land.distanceLabel && (
                        <span className="badge teal" data-testid="land-distance-badge">
                          <XeroIcon emoji="📍" size={11} /> {land.distanceLabel}
                        </span>
                      )}
                      <span
                        className={expBadgeClass}
                        data-testid="land-expiration-badge"
                        title={exp.detailText}
                      >
                        <XeroIcon
                          emoji={
                            exp.state === 'permanent'
                              ? '♾️'
                              : exp.state === 'expired'
                              ? '⏱️'
                              : '⏳'
                          }
                          size={11}
                        />{' '}
                        {exp.badgeText}
                      </span>
                    </div>
                  </div>

                  {/* Band 2: Description, Expiration Detail & Relevant Land Metadata */}
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
                    {land.dimensionsLabel && (
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
                        <XeroIcon emoji={land.stewardType === 'agent' ? '🤖' : '👤'} size={11} />{' '}
                        {stewardLabel}
                      </button>
                    ) : (
                      <span className="mobile-meta-chip">
                        <XeroIcon emoji={land.stewardType === 'agent' ? '🤖' : '👤'} size={11} />{' '}
                        {stewardLabel}
                      </span>
                    )}
                    <span className="mobile-meta-chip">
                      <XeroIcon emoji="🎨" size={11} /> {land.sculptures.length} sculpture
                      {land.sculptures.length === 1 ? '' : 's'}
                    </span>
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

                  {/* Band 3: Land Action Row (Google Maps + Focus Map + Share) */}
                  <div className="mobile-land-actions">
                    {land.googleMapsUrl && (
                      <a
                        className="btn btn-xs mobile-land-gmaps-btn"
                        href={land.googleMapsUrl}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="land-google-maps-link"
                        aria-label={`Open ${land.displayName} in Google Maps`}
                      >
                        <XeroIcon emoji="🧭" size={12} /> Google Maps
                      </a>
                    )}
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => handleFocusLandOnMap(land.parcelId)}
                      aria-label={`Focus ${land.displayName} on map`}
                    >
                      <XeroIcon emoji="🎯" size={12} /> Focus Map
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => handleCopyLandShare(land)}
                      aria-label={`Copy share link for ${land.displayName}`}
                    >
                      <XeroIcon emoji="📤" size={12} /> Share
                    </button>
                  </div>

                  {/* Band 4: Nested Sculptures under this Land */}
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
                                  onClick={() => onSelectSculpture?.(sc)}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
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
                                      {sc.creatorName && (
                                        <span className="mobile-sc-chip">
                                          <XeroIcon emoji="👤" size={10} /> {sc.creatorName}
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
    </div>
  );
}
