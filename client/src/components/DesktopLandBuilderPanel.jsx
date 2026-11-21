import React, { useEffect, useMemo, useState } from 'react';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import {
  buildParcelShareUrl,
  computeMaxHeightForFootprint,
  normalizeRotationDeg,
  scaleFootprintToLimit
} from '../../../shared/landVolume.mjs';
import { buildLandAcquisitionAgentPrompt } from '../../../shared/landSignatureMessage.mjs';
import { EmojiInput } from './EmojiField.jsx';
import InfoTip from './InfoTip.jsx';

async function copyTextSafe(text) {
  const payload = String(text || '');
  if (!payload) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      return true;
    }
  } catch {
    // Fallback below when clipboard permission is denied
  }
  try {
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(ta);
      return Boolean(copied);
    }
  } catch {
    return false;
  }
  return false;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeDeg(value) {
  const n = Math.round(Number(value) || 0);
  return ((n % 360) + 360) % 360;
}

export function DesktopLandBuilderPanel({
  draftParcels = [],
  ownedParcels = [],
  selectedDraftId = '',
  drawMode = false,
  onToggleDrawMode,
  onAddDraftAtCenter,
  onSelectDraft,
  onUpdateDraft,
  onRemoveDraft,
  onClearDrafts,
  onMintDraft,
  onMintAll,
  onUpdateOwnedVolume,
  onOpenAddLandItem = null,
  onOpenTitleDraft = null,
  onOpenTitleOwned = null,
  onCopyOwnedShareLink = null,
  onToggleFreezeParcel = null,
  onOpenLandManagement = null,
  mintBusy = false,
  landStatus = '',
  cameraBearingDeg = 315,
  user = null,
  pairingCode = '',
  publicUrl = '',
  apiOrigin = '',
  config = null,
  onSignIn
}) {
  const limits = useMemo(() => ({
    ...LAND_VOLUME_LIMITS,
    ...(config?.landVolumeLimits || config?.policy?.landVolumeLimits || {})
  }), [config]);

  const [copyBanner, setCopyBanner] = useState('');
  const [showAgentPreview, setShowAgentPreview] = useState(false);

  const origin = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    return publicUrl || 'https://maximusmaximus.github.io';
  }, [publicUrl]);

  const pathname = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.pathname) {
      return window.location.pathname;
    }
    return '/graffiland/';
  }, []);

  const activeDraft = useMemo(
    () => draftParcels.find((item) => item.id === selectedDraftId) || draftParcels[0] || null,
    [draftParcels, selectedDraftId]
  );

  const ownedSelectionId = selectedDraftId.startsWith('owned:') ? selectedDraftId.slice(6) : '';
  const activeOwned = useMemo(
    () => (ownedSelectionId ? ownedParcels.find((p) => p.parcelId === ownedSelectionId) || null : null),
    [ownedParcels, ownedSelectionId]
  );

  const [ownedDraftVol, setOwnedDraftVol] = useState(null);
  useEffect(() => {
    if (!activeOwned) {
      setOwnedDraftVol(null);
      return;
    }
    setOwnedDraftVol({ ...(activeOwned.volume || {}) });
  }, [activeOwned]);

  const activeMode = activeOwned ? 'owned' : activeDraft ? 'draft' : null;
  const activeItem = activeOwned || activeDraft || null;
  const activeVolume = activeOwned ? (ownedDraftVol || activeOwned.volume || {}) : activeDraft || {};

  const activeWidth = clampNum(
    activeVolume.widthMeters,
    limits.minWidthMeters,
    limits.maxWidthMeters,
    limits.defaultWidthMeters
  );
  const activeDepth = clampNum(
    activeVolume.depthMeters,
    limits.minDepthMeters,
    limits.maxDepthMeters,
    limits.defaultDepthMeters
  );
  const activeZScale = clampNum(
    activeVolume.zScale,
    limits.minZScale,
    Number((limits.maxHeightMeters / limits.defaultHeightMeters).toFixed(2)),
    limits.defaultZScale
  );
  const activeHeight = clampNum(
    activeVolume.heightMeters,
    limits.minHeightMeters,
    limits.maxHeightMeters,
    Math.round(limits.defaultHeightMeters * activeZScale)
  );
  const activeRotation = normalizeDeg(activeVolume.rotationDeg);
  const activeArea = Math.round(Number(activeVolume.footprintAreaSqM) || activeWidth * activeDepth);
  const activeCubic = Math.round(Number(activeVolume.volumeCubicM) || activeArea * activeHeight);

  const maxFootprintFit = useMemo(
    () =>
      scaleFootprintToLimit({
        widthMeters: activeWidth,
        depthMeters: activeDepth,
        heightMeters: activeHeight,
        ratio: 1,
        limits
      }),
    [activeWidth, activeDepth, activeHeight, limits]
  );

  const footprintScaleRatio = useMemo(() => {
    const span = Math.max(0.1, maxFootprintFit.maxWidthForAspect - maxFootprintFit.minWidthForAspect);
    return clampNum((activeWidth - maxFootprintFit.minWidthForAspect) / span, 0, 1, 0);
  }, [activeWidth, maxFootprintFit.minWidthForAspect, maxFootprintFit.maxWidthForAspect]);

  const maxHeightInfo = useMemo(
    () =>
      computeMaxHeightForFootprint({
        widthMeters: activeWidth,
        depthMeters: activeDepth,
        limits
      }),
    [activeWidth, activeDepth, limits]
  );
  const areaLimitPct = Math.min(100, Math.round((activeArea / limits.maxFootprintAreaSqM) * 100));
  const volLimitPct = Math.min(100, Math.round((activeCubic / limits.maxVolumeCubicM) * 100));

  const readyDrafts = useMemo(
    () => draftParcels.filter((item) => item.valid !== false && !item.hasOverlap),
    [draftParcels]
  );

  const enrichedProperties = useMemo(() => {
    return draftParcels.map((draft, idx) => ({
      ...draft,
      customName: draft.customName || `Land Plot #${idx + 1}`,
      shareUrl: buildParcelShareUrl({
        origin,
        pathname,
        parcelId: draft.parcelId,
        lat: draft.centerLat ?? draft.lat,
        lng: draft.centerLng ?? draft.lng,
        volume: draft,
        customName: draft.customName
      })
    }));
  }, [draftParcels, origin, pathname]);

  const agentPromptText = useMemo(() => {
    return buildLandAcquisitionAgentPrompt({
      properties: enrichedProperties,
      apiOrigin: apiOrigin || origin,
      publicUrl: publicUrl || `${origin}${pathname}`,
      pairingCode: pairingCode || undefined,
      ownerAddress: user?.walletAddress || user?.address || undefined
    });
  }, [enrichedProperties, apiOrigin, origin, publicUrl, pathname, pairingCode, user]);

  const allLinksText = useMemo(() => {
    return enrichedProperties.map((prop) => `${prop.customName || prop.parcelId}: ${prop.shareUrl}`).join('\n');
  }, [enrichedProperties]);

  const flashCopy = (msg) => setCopyBanner(msg);

  const handleCopySingleLink = async () => {
    if (!activeItem) return;
    const shareUrl = buildParcelShareUrl({
      origin,
      pathname,
      parcelId: activeItem.parcelId,
      lat: activeVolume.centerLat ?? activeItem.lat,
      lng: activeVolume.centerLng ?? activeItem.lng,
      volume: activeVolume,
      customName: activeItem.customName,
      compact: activeMode === 'owned'
    });
    const ok = await copyTextSafe(shareUrl);
    flashCopy(ok ? `Copied parcel link for ${activeItem.parcelId}` : shareUrl);
  };

  const handleCopyMintedParcelLink = async (parcel) => {
    if (!parcel?.parcelId) return;
    if (onCopyOwnedShareLink) {
      await onCopyOwnedShareLink(parcel);
      return;
    }
    const shareUrl = buildParcelShareUrl({
      origin,
      pathname,
      parcelId: parcel.parcelId,
      customName: parcel.customName || '',
      compact: true
    });
    const ok = await copyTextSafe(shareUrl);
    flashCopy(ok ? `Copied share link for ${parcel.customName || parcel.parcelId}` : shareUrl);
  };

  const handleCopyAllForAgent = async () => {
    if (!enrichedProperties.length) return;
    setShowAgentPreview(true);
    const ok = await copyTextSafe(agentPromptText);
    flashCopy(
      ok
        ? `Copied ${enrichedProperties.length} propert${enrichedProperties.length === 1 ? 'y' : 'ies'} for your agent`
        : 'Prepared agent acquisition text below'
    );
  };

  const handleCopyAllLinks = async () => {
    if (!enrichedProperties.length) return;
    const ok = await copyTextSafe(allLinksText);
    flashCopy(ok ? `Copied ${enrichedProperties.length} parcel share link(s)` : allLinksText);
  };

  const patchActiveDimensions = (patch) => {
    if (!activeItem) return;
    if (activeMode === 'draft') {
      onUpdateDraft?.(activeDraft.id, patch);
    } else if (activeMode === 'owned') {
      setOwnedDraftVol((prev) => ({ ...(prev || activeOwned?.volume || {}), ...patch }));
    }
  };

  const statusText = typeof landStatus === 'string' ? landStatus : landStatus?.text || '';
  const statusIsError = typeof landStatus === 'object' ? Boolean(landStatus?.isError) : false;
  const isDrawActive = drawMode === true || drawMode === 'draw';

  return (
    <div className="land-builder-panel" data-testid="desktop-land-builder-panel">
      <div className="land-builder-actions">
        <button
          type="button"
          className={`btn btn-sm ${isDrawActive ? 'btn-primary' : 'btn-outline'}`}
          aria-pressed={isDrawActive}
          onClick={onToggleDrawMode}
        >
          {isDrawActive ? '✏️ Drawing on Map' : '✏️ Draw Land'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={draftParcels.length >= limits.maxSelectionBatch}
          onClick={onAddDraftAtCenter}
        >
          + Add Square
        </button>
        {draftParcels.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClearDrafts}>
            Clear ({draftParcels.length})
          </button>
        )}
        <InfoTip title="On-Map 3D Controls" align="right">
          Hover a plot to select it. Drag <strong>corner balls</strong> to scale, drag{' '}
          <strong>side bars</strong> to stretch an edge, hold &amp; move{' '}
          <strong>vertical corner bars</strong> to rotate, or drag the <strong>center</strong> to
          move.
        </InfoTip>
      </div>

      <div className="land-limits-compact" data-testid="land-limits-card">
        <span className="mono">
          Limits: <b>{limits.maxFootprintAreaSqM.toLocaleString()} m²</b> ·{' '}
          <b>{limits.maxVolumeCubicM.toLocaleString()} m³</b> ·{' '}
          <b>{limits.starterFreeHumanClaims} free human claims</b>
        </span>
        <InfoTip title="3D Land Limits & Rules" align="right">
          <div>Width / Depth: {limits.minWidthMeters}–{limits.maxWidthMeters}m (max {limits.maxFootprintAreaSqM.toLocaleString()} m²)</div>
          <div>Height (Z): {limits.minHeightMeters}–{limits.maxHeightMeters}m (max {limits.maxVolumeCubicM.toLocaleString()} m³)</div>
          <div>Rotation: {limits.rotationMinDeg}°–{limits.rotationMaxDeg}° · Batch: up to {limits.maxSelectionBatch} plots</div>
          <div>Humans get {limits.starterFreeHumanClaims} gas-free starter claims. AI agents pay own gas.</div>
        </InfoTip>
      </div>

      {statusText && (
        <div className={`status-banner ${statusIsError ? 'status-banner-error' : ''}`} role="status">
          {statusText}
        </div>
      )}
      {copyBanner && (
        <div className="status-banner" role="status">
          {copyBanner}
        </div>
      )}

      {!user && (
        <div className="land-signin-callout">
          <span>Sign in to mint free starter plots.</span>
          {onSignIn && (
            <button type="button" className="btn btn-xs btn-primary" onClick={onSignIn}>
              Sign In
            </button>
          )}
        </div>
      )}

      <div className="land-section-header">
        <strong>
          Plots ({draftParcels.length}/{limits.maxSelectionBatch})
        </strong>
        <div className="land-builder-legend" aria-label="Wireframe color key">
          <span><i className="legend-dot legend-cyan" /> Draft</span>
          <span><i className="legend-dot legend-amber" /> Owned</span>
          <span><i className="legend-dot legend-crimson" /> Conflict</span>
        </div>
      </div>

      {draftParcels.length === 0 ? (
        <div className="empty-state" style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12 }}>
          Click <strong>✏️ Draw Land</strong> and drag on the map, or press <strong>+ Add Square</strong>.
        </div>
      ) : (
        <div className="land-draft-list" role="list">
          {draftParcels.map((draft, idx) => {
            const isSelected = activeMode === 'draft' && activeDraft?.id === draft.id;
            const hasIssue = draft.valid === false || draft.hasOverlap;
            const label = draft.customName?.trim() || draft.parcelId;
            return (
              <div
                key={draft.id}
                role="listitem"
                className={`land-draft-item ${isSelected ? 'selected' : ''} ${hasIssue ? 'has-issue' : ''}`}
                onClick={() => onSelectDraft?.(draft.id)}
              >
                <div className="land-draft-main">
                  <div className="land-draft-title">
                    <span className="land-draft-index">#{idx + 1}</span>
                    <EmojiInput
                      type="text"
                      className="land-draft-inline-title"
                      wrapperStyle={{ flex: '1 1 auto', minWidth: 80, maxWidth: 160 }}
                      aria-label={`Title for plot #${idx + 1}`}
                      maxLength={48}
                      value={draft.customName || ''}
                      placeholder={`Title ${draft.parcelId}…`}
                      onFocus={() => onSelectDraft?.(draft.id)}
                      onChange={(e) =>
                        onUpdateDraft?.(draft.id, { customName: e.target.value })
                      }
                    />
                  </div>
                  <div className="land-draft-meta">
                    {Math.round(draft.widthMeters)}×{Math.round(draft.depthMeters)}×{Math.round(draft.heightMeters)}m · {Math.round(draft.rotationDeg || 0)}° · {Math.round(draft.footprintAreaSqM || 0)} m²
                  </div>
                </div>
                <div className="land-draft-badges">
                  <span className={`badge ${hasIssue ? 'badge-error' : 'badge-cyan'}`}>
                    {draft.hasOverlap ? 'Overlap' : draft.valid === false ? 'Limit' : 'Ready'}
                  </span>
                  {onOpenTitleDraft && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs land-icon-btn"
                      aria-label={`Title popup for ${label}`}
                      title="Title & describe land in popup"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenTitleDraft(draft);
                      }}
                    >
                      ✎
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    aria-label={`Remove ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveDraft?.(draft.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {ownedParcels.length > 0 && (
        <div className="land-owned-strip">
          <div className="land-section-header">
            <strong>Your Owned Plots ({ownedParcels.length})</strong>
            <InfoTip title="Add 3D Items & Manage Minted Land" align="right">
              Click <strong>+</strong> next to any minted land to copy an AI agent prompt for adding
              a custom 3D item (voxels or .glb/.gltf/.obj/.stl/.ply), modifying artworks, or freezing
              placements.
            </InfoTip>
          </div>
          <div className="land-owned-pills">
            {ownedParcels.slice(0, 8).map((parcel) => {
              const ownedKey = `owned:${parcel.parcelId}`;
              const isSelected = selectedDraftId === ownedKey;
              const isFrozen = Boolean(parcel.frozen || parcel.settings?.frozen);
              return (
                <div key={parcel.parcelId} className="land-owned-pill-group">
                  <button
                    type="button"
                    className={`btn btn-xs ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => onSelectDraft?.(ownedKey)}
                  >
                    {isFrozen ? '❄️ ' : ''}
                    {parcel.customName || parcel.parcelId}
                  </button>
                  {onOpenAddLandItem && (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary land-owned-plus-btn"
                      aria-label={`Add 3D item to ${parcel.parcelId}`}
                      title={`Add 3D item to ${parcel.parcelId} (Model Link or Agent Prompt)`}
                      onClick={() => onOpenAddLandItem(parcel)}
                    >
                      +
                    </button>
                  )}
                  {onOpenTitleOwned && (
                    <button
                      type="button"
                      className="btn btn-xs btn-outline land-icon-btn"
                      aria-label={`Rename ${parcel.parcelId}`}
                      title="Edit land name & description"
                      onClick={() => onOpenTitleOwned(parcel)}
                    >
                      ✎
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-xs btn-outline land-icon-btn"
                    aria-label={`Copy share link for ${parcel.parcelId}`}
                    title="Copy shareable visit link for this minted parcel"
                    onClick={() => handleCopyMintedParcelLink(parcel)}
                  >
                    🔗
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeItem && (
        <div className="land-selected-editor" data-testid="land-selected-editor">
          <div className="land-editor-header">
            <div className="land-editor-title-row">
              <div className="land-editor-title">
                {activeMode === 'owned' ? 'Owned 3D Volume' : 'Selected Plot'}
              </div>
              <InfoTip title="Shape Controls" align="right">
                Use sliders below or drag handles directly on the map: corner balls scale, edge bars
                stretch one side, vertical corner bars rotate, center moves.
              </InfoTip>
            </div>
            <div className="land-editor-id">
              <code>{activeItem.parcelId}</code> · {activeArea.toLocaleString()} m² · {activeCubic.toLocaleString()} m³
            </div>
          </div>

          {activeMode === 'draft' && (activeDraft?.hasOverlap || activeDraft?.valid === false) && (
            <div className="land-validation-errors" role="alert">
              {activeDraft.hasOverlap && <div>Overlaps another plot. Move or shrink it.</div>}
              {(activeDraft.errors || []).map((err) => (
                <div key={err}>{err}</div>
              ))}
            </div>
          )}

          {activeMode === 'draft' && (
            <>
              <label className="land-name-field" htmlFor="land-square-name-input">
                <span>Land Title</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <EmojiInput
                    id="land-square-name-input"
                    type="text"
                    wrapperStyle={{ flex: 1, minWidth: 0 }}
                    maxLength={48}
                    placeholder="e.g., Corner Plaza (: for emojis)"
                    value={activeDraft.customName || ''}
                    onChange={(e) => onUpdateDraft?.(activeDraft.id, { customName: e.target.value })}
                  />
                  {onOpenTitleDraft && (
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      aria-label="Open title popup for selected plot"
                      title="Edit title & description in popup"
                      onClick={() => onOpenTitleDraft(activeDraft)}
                    >
                      ✎
                    </button>
                  )}
                </div>
              </label>
              <label className="land-name-field" htmlFor="land-square-desc-input">
                <span>Description (optional)</span>
                <EmojiInput
                  id="land-square-desc-input"
                  type="text"
                  maxLength={240}
                  placeholder="Short description (: for emojis)"
                  value={activeDraft.description || ''}
                  onChange={(e) => onUpdateDraft?.(activeDraft.id, { description: e.target.value })}
                />
              </label>
            </>
          )}

          <div className="land-slider-row">
            <div className="land-slider-label">
              <span>
                Scale ({areaLimitPct}% max)
                <InfoTip title="Proportional Scale">
                  Scales width &amp; depth together up to the {limits.maxFootprintAreaSqM.toLocaleString()} m² limit while keeping your orientation and aspect ratio.
                </InfoTip>
              </span>
              <strong>{activeWidth}×{activeDepth} m</strong>
            </div>
            <input
              type="range"
              aria-label="Scale Footprint to Limit"
              min={0}
              max={100}
              step={1}
              value={Math.round(footprintScaleRatio * 100)}
              onChange={(e) => {
                const scaled = scaleFootprintToLimit({
                  widthMeters: activeWidth,
                  depthMeters: activeDepth,
                  heightMeters: activeHeight,
                  ratio: Number(e.target.value) / 100,
                  limits
                });
                patchActiveDimensions({
                  widthMeters: scaled.widthMeters,
                  depthMeters: scaled.depthMeters,
                  heightMeters: scaled.heightMeters,
                  zScale: scaled.zScale
                });
              }}
            />
            <div className="land-nudge-row">
              <button
                type="button"
                className="btn btn-outline btn-xs"
                onClick={() =>
                  patchActiveDimensions({
                    widthMeters: maxFootprintFit.widthMeters,
                    depthMeters: maxFootprintFit.depthMeters,
                    heightMeters: maxFootprintFit.heightMeters,
                    zScale: maxFootprintFit.zScale
                  })
                }
              >
                Max Limit Size ({maxFootprintFit.widthMeters}×{maxFootprintFit.depthMeters}m)
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() =>
                  patchActiveDimensions({
                    rotationDeg: normalizeRotationDeg(cameraBearingDeg)
                  })
                }
              >
                Match Map Angle ({Math.round(normalizeRotationDeg(cameraBearingDeg))}°)
              </button>
            </div>
          </div>

          <div className="land-slider-row">
            <div className="land-slider-label">
              <span>Width (m)</span>
              <strong>{Number(activeWidth.toFixed(1))} m</strong>
            </div>
            <input
              type="range"
              aria-label="Width (m)"
              min={limits.minWidthMeters}
              max={limits.maxWidthMeters}
              step={1}
              value={activeWidth}
              onChange={(e) => patchActiveDimensions({ widthMeters: Number(e.target.value) })}
            />
          </div>

          <div className="land-slider-row">
            <div className="land-slider-label">
              <span>Depth (m)</span>
              <strong>{Number(activeDepth.toFixed(1))} m</strong>
            </div>
            <input
              type="range"
              aria-label="Depth (m)"
              min={limits.minDepthMeters}
              max={limits.maxDepthMeters}
              step={1}
              value={activeDepth}
              onChange={(e) => patchActiveDimensions({ depthMeters: Number(e.target.value) })}
            />
          </div>

          <div className="land-slider-row">
            <div className="land-slider-label">
              <span>
                Rotate (°)
                <InfoTip title="Rotate Plot">
                  Hold and move any vertical corner bar on the 3D box on the map to rotate freely,
                  or use the slider below.
                </InfoTip>
              </span>
              <strong>{activeRotation}°</strong>
            </div>
            <input
              type="range"
              aria-label="Rotate (°)"
              min={limits.rotationMinDeg}
              max={limits.rotationMaxDeg}
              step={1}
              value={activeRotation}
              onChange={(e) => patchActiveDimensions({ rotationDeg: Number(e.target.value) })}
            />
            <div className="land-nudge-row">
              {[-15, 0, 15, 45].map((delta) => (
                <button
                  key={delta}
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => patchActiveDimensions({
                    rotationDeg: delta === 0 ? 0 : normalizeDeg(activeRotation + delta)
                  })}
                >
                  {delta === 0 ? '0°' : delta > 0 ? `+${delta}°` : `${delta}°`}
                </button>
              ))}
            </div>
          </div>

          <div className="land-slider-row">
            <div className="land-slider-label">
              <span>
                Z-Axis Scale ({volLimitPct}% vol)
                <InfoTip title="3D Height & Volume">
                  Adjusts vertical height from {limits.minHeightMeters}m up to {maxHeightInfo.heightMeters}m
                  within the {limits.maxVolumeCubicM.toLocaleString()} m³ volume cap.
                </InfoTip>
              </span>
              <strong>{activeZScale.toFixed(2)}× ({Math.round(activeHeight)} m)</strong>
            </div>
            <input
              type="range"
              aria-label="Z-Axis Scale"
              min={limits.minZScale}
              max={Math.max(limits.minZScale, maxHeightInfo.zScale)}
              step={0.05}
              value={Math.min(activeZScale, Math.max(limits.minZScale, maxHeightInfo.zScale))}
              onChange={(e) => {
                const nextScale = Number(e.target.value);
                const nextHeight = clampNum(
                  Math.round(limits.defaultHeightMeters * nextScale),
                  limits.minHeightMeters,
                  maxHeightInfo.heightMeters,
                  limits.defaultHeightMeters
                );
                patchActiveDimensions({ zScale: nextScale, heightMeters: nextHeight });
              }}
            />
            <div className="land-nudge-row">
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() =>
                  patchActiveDimensions({
                    zScale: maxHeightInfo.zScale,
                    heightMeters: maxHeightInfo.heightMeters
                  })
                }
              >
                Max Height ({maxHeightInfo.heightMeters}m)
              </button>
            </div>
          </div>

          <div className="land-editor-actions">
            <button type="button" className="btn btn-sm btn-outline" onClick={handleCopySingleLink}>
              Copy Parcel Link
            </button>
            {activeMode === 'draft' ? (
              <>
                {onOpenTitleDraft && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    aria-label="Title and mint selected land"
                    title="Open title popup before minting"
                    onClick={() => onOpenTitleDraft(activeDraft)}
                  >
                    🏷️ Title
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={activeDraft.valid === false || activeDraft.hasOverlap || Boolean(mintBusy)}
                  onClick={() => onMintDraft?.(activeDraft)}
                >
                  {mintBusy ? 'Minting…' : 'Mint This Land'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={Boolean(mintBusy)}
                  onClick={() => onUpdateOwnedVolume?.(activeOwned.parcelId, {
                    centerLat: activeVolume.centerLat,
                    centerLng: activeVolume.centerLng,
                    widthMeters: activeWidth,
                    depthMeters: activeDepth,
                    heightMeters: activeHeight,
                    zScale: activeZScale,
                    rotationDeg: activeRotation
                  })}
                >
                  {mintBusy ? 'Saving…' : 'Save 3D Volume'}
                </button>
                {onOpenAddLandItem && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => onOpenAddLandItem(activeOwned)}
                  >
                    + Add 3D Item (Prompt)
                  </button>
                )}
                {onToggleFreezeParcel && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    disabled={Boolean(mintBusy)}
                    onClick={() =>
                      onToggleFreezeParcel(
                        activeOwned.parcelId,
                        !(activeOwned.frozen || activeOwned.settings?.frozen)
                      )
                    }
                  >
                    {activeOwned.frozen || activeOwned.settings?.frozen
                      ? '🔓 Unfreeze Land'
                      : '❄️ Freeze Land'}
                  </button>
                )}
                {onOpenLandManagement && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => onOpenLandManagement(activeOwned.parcelId)}
                  >
                    ⚙️ Manage
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {draftParcels.length > 0 && (
        <div className="land-agent-export" data-testid="land-agent-export">
          <div className="land-section-header">
            <strong>
              Agent Export &amp; Batch Mint
              <InfoTip title="Paste Into Your AI Agent" align="right">
                Copies every selected plot&apos;s GPS center, corners, 3D dimensions, share links,
                and exact API/MCP payload so your AI agent can acquire them.
              </InfoTip>
            </strong>
          </div>
          <div className="land-agent-export-actions">
            <button type="button" className="btn btn-sm btn-outline" onClick={handleCopyAllForAgent}>
              Copy All Properties for Agent
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setShowAgentPreview((prev) => !prev)}
            >
              {showAgentPreview ? 'Hide Text' : 'Preview Text'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={handleCopyAllLinks}>
              Copy Links
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={readyDrafts.length === 0 || Boolean(mintBusy)}
              onClick={onMintAll}
            >
              {mintBusy ? 'Minting…' : `Mint All (${readyDrafts.length})`}
            </button>
          </div>
          {showAgentPreview && (
            <textarea
              readOnly
              className="land-agent-preview"
              aria-label="Agent properties prompt preview"
              value={agentPromptText}
              rows={8}
            />
          )}
        </div>
      )}
    </div>
  );
}
export default DesktopLandBuilderPanel;
