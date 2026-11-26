import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import {
  buildParcelShareUrl,
  computeMaxHeightForFootprint,
  normalizeRotationDeg,
  resolveLandDisplayName,
  scaleFootprintToLimit,
  validateLandTitle
} from '../../../shared/landVolume.mjs';
import { buildLandAcquisitionAgentPrompt } from '../../../shared/landSignatureMessage.mjs';
import { api } from '../utils/api.js';
import { EmojiInput } from './EmojiField.jsx';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

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

function formatLocationCopyLine(parcel, origin, pathname) {
  const title = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
  const vol = parcel.volume || parcel;
  const lat = Number(vol?.centerLat ?? parcel.centerLat ?? parcel.lat);
  const lng = Number(vol?.centerLng ?? parcel.centerLng ?? parcel.lng);
  const coords =
    Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : '';
  const dims =
    Number.isFinite(Number(vol?.widthMeters)) && Number.isFinite(Number(vol?.depthMeters))
      ? `${Math.round(vol.widthMeters)}×${Math.round(vol.depthMeters)}×${Math.round(
          vol.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters
        )}m`
      : '';
  const shareUrl = buildParcelShareUrl({
    origin,
    pathname,
    parcelId: parcel.parcelId,
    customName: parcel.customName || '',
    compact: true
  });
  return [title, coords ? `(${coords})` : '', dims, shareUrl].filter(Boolean).join(' · ');
}

export function DesktopLandBuilderPanel({
  draftParcels = [],
  ownedParcels = [],
  recentlyMintedParcels = [],
  selectedDraftId = '',
  drawMode = false,
  onToggleDrawMode,
  onAddDraftAtCenter,
  onSelectDraft,
  onUpdateDraft,
  onRemoveDraft,
  onClearDrafts,
  onUndoDraft = null,
  onRedoDraft = null,
  canUndo = false,
  canRedo = false,
  undoLabel = '',
  hasCopiedDraft = false,
  onCopySelectedLand = null,
  onPasteCopiedLand = null,
  onDraftGestureStart = null,
  onDraftGestureEnd = null,
  onMintDraft,
  onMintAll,
  onUpdateOwnedVolume,
  onOpenAddLandItem = null,
  onOpenTitleOwned = null,
  onCopyOwnedShareLink = null,
  onToggleFreezeParcel = null,
  onOpenLandManagement = null,
  mintLimitError = null,
  onDismissMintLimitError = null,
  checkLandNameFn = null,
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
  const limits = useMemo(
    () => ({
      ...LAND_VOLUME_LIMITS,
      ...(config?.landVolumeLimits || config?.policy?.landVolumeLimits || {})
    }),
    [config]
  );

  const [copyBanner, setCopyBanner] = useState('');
  const [showManualDims, setShowManualDims] = useState(false);
  const [showMintedAgentPreview, setShowMintedAgentPreview] = useState(false);
  const [nameAvailabilityByDraft, setNameAvailabilityByDraft] = useState({});

  const origin = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    return publicUrl || 'https://spray.land';
  }, [publicUrl]);

  const pathname = useMemo(() => {
    if (typeof window !== 'undefined' && window.location?.pathname) {
      return window.location.pathname;
    }
    return '/';
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

  // Live uniqueness check for active draft land title
  const activeDraftId = activeDraft?.id || '';
  const activeDraftTitleRaw = activeDraft?.customName || '';
  useEffect(() => {
    if (!activeDraftId) return undefined;
    const local = validateLandTitle(activeDraftTitleRaw);
    if (!local.ok) {
      setNameAvailabilityByDraft((prev) => ({
        ...prev,
        [activeDraftId]: {
          state: activeDraftTitleRaw.trim() ? 'invalid' : 'empty',
          name: local.normalized,
          message: local.error
        }
      }));
      return undefined;
    }

    let cancelled = false;
    setNameAvailabilityByDraft((prev) => ({
      ...prev,
      [activeDraftId]: { state: 'checking', name: local.normalized, message: 'Checking availability…' }
    }));

    const timer = window.setTimeout(async () => {
      try {
        const checker = checkLandNameFn || ((name) => api.checkLandName(name));
        const res = await checker(local.normalized);
        if (cancelled) return;
        if (res?.available) {
          setNameAvailabilityByDraft((prev) => ({
            ...prev,
            [activeDraftId]: {
              state: 'available',
              name: local.normalized,
              message: 'Title is available'
            }
          }));
        } else {
          setNameAvailabilityByDraft((prev) => ({
            ...prev,
            [activeDraftId]: {
              state: 'taken',
              name: local.normalized,
              message: res?.reason || `"${local.normalized}" is already taken.`
            }
          }));
        }
      } catch {
        if (cancelled) return;
        // Offline/mock fallback: treat locally valid titles as mintable (server still validates on submit)
        setNameAvailabilityByDraft((prev) => ({
          ...prev,
          [activeDraftId]: { state: 'available', name: local.normalized, message: '' }
        }));
      }
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeDraftId, activeDraftTitleRaw, checkLandNameFn]);

  // Detect duplicate titles across drafts in the same batch
  const batchDuplicateIds = useMemo(() => {
    const seen = new Map();
    const dupes = new Set();
    for (const d of draftParcels) {
      const norm = String(d.customName || '').trim().toLowerCase();
      if (!norm) continue;
      if (seen.has(norm)) {
        dupes.add(seen.get(norm));
        dupes.add(d.id);
      } else {
        seen.set(norm, d.id);
      }
    }
    return dupes;
  }, [draftParcels]);

  const getDraftTitleState = useCallback(
    (draft) => {
      if (!draft) return { ok: false, state: 'empty', message: 'Enter a unique land title.' };
      const local = validateLandTitle(draft.customName || '');
      if (!local.ok) {
        return {
          ok: false,
          state: String(draft.customName || '').trim() ? 'invalid' : 'empty',
          message: local.error
        };
      }
      if (batchDuplicateIds.has(draft.id)) {
        return {
          ok: false,
          state: 'taken',
          message: 'Duplicate title inside your current batch — each land needs a unique name.'
        };
      }
      const asyncState = nameAvailabilityByDraft[draft.id];
      if (asyncState && asyncState.name === local.normalized) {
        if (asyncState.state === 'taken' || asyncState.state === 'invalid') {
          return { ok: false, state: asyncState.state, message: asyncState.message };
        }
        if (asyncState.state === 'checking') {
          return { ok: false, state: 'checking', message: 'Checking availability…' };
        }
        return { ok: true, state: 'available', message: asyncState.message || 'Title is available' };
      }
      return { ok: true, state: 'valid', message: '' };
    },
    [batchDuplicateIds, nameAvailabilityByDraft]
  );

  const activeMode = activeOwned ? 'owned' : activeDraft ? 'draft' : null;
  const activeItem = activeOwned || activeDraft || null;
  const activeVolume = activeOwned ? ownedDraftVol || activeOwned.volume || {} : activeDraft || {};

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
    () =>
      draftParcels.filter((item) => {
        if (item.valid === false || item.hasOverlap) return false;
        const t = getDraftTitleState(item);
        return t.ok;
      }),
    [draftParcels, getDraftTitleState]
  );

  const untitledOrInvalidDrafts = useMemo(
    () =>
      draftParcels.filter((item) => {
        if (item.valid === false || item.hasOverlap) return false;
        return !getDraftTitleState(item).ok;
      }),
    [draftParcels, getDraftTitleState]
  );

  // Combine freshly minted lands & owned lands for post-mint copy options
  const copyableMintedParcels = useMemo(() => {
    const byId = new Map();
    for (const p of recentlyMintedParcels || []) {
      if (p?.parcelId) byId.set(p.parcelId, p);
    }
    for (const p of ownedParcels || []) {
      if (p?.parcelId && !byId.has(p.parcelId)) {
        byId.set(p.parcelId, p);
      }
    }
    return Array.from(byId.values());
  }, [recentlyMintedParcels, ownedParcels]);

  const enrichedMintedProperties = useMemo(() => {
    return copyableMintedParcels.map((parcel) => {
      const vol = parcel.volume || parcel;
      return {
        ...parcel,
        centerLat: Number(vol?.centerLat ?? parcel.centerLat ?? parcel.lat ?? 0),
        centerLng: Number(vol?.centerLng ?? parcel.centerLng ?? parcel.lng ?? 0),
        widthMeters: Number(vol?.widthMeters || limits.defaultWidthMeters),
        depthMeters: Number(vol?.depthMeters || limits.defaultDepthMeters),
        heightMeters: Number(vol?.heightMeters || limits.defaultHeightMeters),
        rotationDeg: Number(vol?.rotationDeg || 0),
        customName: resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' }),
        shareUrl: buildParcelShareUrl({
          origin,
          pathname,
          parcelId: parcel.parcelId,
          customName: parcel.customName || '',
          compact: true
        })
      };
    });
  }, [copyableMintedParcels, origin, pathname, limits]);

  const mintedAgentPromptText = useMemo(() => {
    if (!enrichedMintedProperties.length) return '';
    return buildLandAcquisitionAgentPrompt({
      properties: enrichedMintedProperties,
      apiOrigin: apiOrigin || origin,
      publicUrl: publicUrl || `${origin}${pathname}`,
      pairingCode: pairingCode || undefined,
      ownerAddress: user?.walletAddress || user?.address || undefined
    });
  }, [enrichedMintedProperties, apiOrigin, origin, publicUrl, pathname, pairingCode, user]);

  const mintedAllLocationsText = useMemo(() => {
    return copyableMintedParcels
      .map((parcel) => formatLocationCopyLine(parcel, origin, pathname))
      .join('\n');
  }, [copyableMintedParcels, origin, pathname]);

  const flashCopy = (msg) => setCopyBanner(msg);

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
    const label = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
    flashCopy(ok ? `Copied link for "${label}"` : shareUrl);
  };

  const handleCopyMintedParcelLocation = async (parcel) => {
    if (!parcel?.parcelId) return;
    const text = formatLocationCopyLine(parcel, origin, pathname);
    const ok = await copyTextSafe(text);
    const label = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
    flashCopy(ok ? `Copied location for "${label}"` : text);
  };

  const handleCopyAllMintedLocations = async () => {
    if (!copyableMintedParcels.length) return;
    const ok = await copyTextSafe(mintedAllLocationsText);
    flashCopy(
      ok
        ? `Copied all ${copyableMintedParcels.length} minted location(s)`
        : mintedAllLocationsText
    );
  };

  const handleCopyAllMintedForAgent = async () => {
    if (!enrichedMintedProperties.length) return;
    setShowMintedAgentPreview(true);
    const ok = await copyTextSafe(mintedAgentPromptText);
    flashCopy(
      ok
        ? `Copied AI agent prompt for all ${enrichedMintedProperties.length} minted land(s)`
        : 'Prepared AI agent prompt below'
    );
  };

  const patchActiveDimensions = (patch, options = undefined) => {
    if (!activeItem) return;
    if (activeMode === 'draft') {
      onUpdateDraft?.(activeDraft.id, patch, options);
    } else if (activeMode === 'owned') {
      setOwnedDraftVol((prev) => ({ ...(prev || activeOwned?.volume || {}), ...patch }));
    }
  };

  const activeDraftTitleState = activeMode === 'draft' ? getDraftTitleState(activeDraft) : null;
  const canMintActiveDraft =
    activeMode === 'draft' &&
    activeDraft &&
    activeDraft.valid !== false &&
    !activeDraft.hasOverlap &&
    Boolean(activeDraftTitleState?.ok) &&
    !mintBusy;

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
          <strong>side bars</strong> to stretch an edge, drag <strong>top rim bars</strong> up/down
          for height, hold &amp; move <strong>vertical corner bars</strong> to rotate, or drag the{' '}
          <strong>center</strong> to move. Shortcuts: <strong>Ctrl/Cmd+Z</strong> undo,{' '}
          <strong>Delete</strong> removes an unminted plot, <strong>Ctrl/Cmd+C</strong> &amp;{' '}
          <strong>Ctrl/Cmd+V</strong> duplicate.
        </InfoTip>
      </div>

      {(onUndoDraft || onCopySelectedLand || onPasteCopiedLand) &&
        (canUndo || canRedo || hasCopiedDraft || Boolean(activeItem)) && (
          <div className="land-draft-history-bar" data-testid="land-draft-history-bar">
            {onUndoDraft && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                data-testid="land-undo-btn"
                disabled={!canUndo}
                onClick={onUndoDraft}
                title={
                  undoLabel
                    ? `Undo: ${undoLabel} (Ctrl+Z / Cmd+Z)`
                    : 'Undo last land action (Ctrl+Z / Cmd+Z)'
                }
              >
                ↩ Undo
              </button>
            )}
            {onRedoDraft && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                data-testid="land-redo-btn"
                disabled={!canRedo}
                onClick={onRedoDraft}
                title="Redo land action (Ctrl+Shift+Z / Cmd+Shift+Z)"
              >
                ↪ Redo
              </button>
            )}
            {onCopySelectedLand && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                data-testid="land-copy-btn"
                disabled={!activeItem}
                onClick={onCopySelectedLand}
                title="Copy selected land (Ctrl+C / Cmd+C)"
              >
                📋 Copy
              </button>
            )}
            {onPasteCopiedLand && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                data-testid="land-paste-btn"
                disabled={!hasCopiedDraft || draftParcels.length >= limits.maxSelectionBatch}
                onClick={onPasteCopiedLand}
                title="Paste duplicate land (Ctrl+V / Cmd+V)"
              >
                📌 Paste
              </button>
            )}
            {activeMode === 'draft' && activeDraft && onRemoveDraft && (
              <button
                type="button"
                className="btn btn-xs btn-ghost land-delete-draft-btn"
                data-testid="land-delete-draft-btn"
                onClick={() => onRemoveDraft(activeDraft.id)}
                title="Delete selected unminted land (Delete / Backspace — Undo brings it back)"
              >
                🗑️ Delete
              </button>
            )}
          </div>
        )}

      <div className="land-limits-compact" data-testid="land-limits-card">
        <span className="mono">
          Limits: <b>{limits.maxFootprintAreaSqM.toLocaleString()} m²</b> ·{' '}
          <b>{limits.maxVolumeCubicM.toLocaleString()} m³</b> ·{' '}
          <b>{limits.starterFreeHumanClaims} free human claims</b>
        </span>
        <InfoTip title="3D Land Limits & Rules" align="right">
          <div>
            Width / Depth: {limits.minWidthMeters}–{limits.maxWidthMeters}m (max{' '}
            {limits.maxFootprintAreaSqM.toLocaleString()} m²)
          </div>
          <div>
            Height (Z): {limits.minHeightMeters}–{limits.maxHeightMeters}m (max{' '}
            {limits.maxVolumeCubicM.toLocaleString()} m³)
          </div>
          <div>
            Rotation: {limits.rotationMinDeg}°–{limits.rotationMaxDeg}° · Batch: up to{' '}
            {limits.maxSelectionBatch} plots
          </div>
          <div>
            Humans get {limits.starterFreeHumanClaims} free starter Desktop lands. Build a sculpture
            on one to unlock another Desktop slot, or sculpt IRL on mobile anytime!
          </div>
        </InfoTip>
      </div>

      {/* Rich Free Desktop Land Limit Notification Card */}
      {mintLimitError && (
        <div className="land-limit-alert-card" role="alert" data-testid="mint-limit-notification">
          <div className="land-limit-alert-head">
            <strong>
              🛑 Free Desktop Land Limit Reached ({mintLimitError.usedSlots ?? limits.starterFreeHumanClaims}/
              {mintLimitError.maxSlots ?? limits.starterFreeHumanClaims})
            </strong>
            {onDismissMintLimitError && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                aria-label="Dismiss limit notice"
                onClick={onDismissMintLimitError}
              >
                ✕
              </button>
            )}
          </div>
          <p className="land-limit-alert-copy">
            You already have{' '}
            <strong>
              {mintLimitError.usedSlots ?? limits.starterFreeHumanClaims} unbuilt starter lands
            </strong>
            . To unlock more Desktop minting slots, place or publish a sculpture on one of your
            existing lands first:
          </p>
          {Array.isArray(mintLimitError.unbuiltParcels) &&
            mintLimitError.unbuiltParcels.length > 0 && (
              <div className="land-limit-unbuilt-list">
                {mintLimitError.unbuiltParcels.map((p) => (
                  <button
                    key={p.parcelId}
                    type="button"
                    className="btn btn-xs btn-outline"
                    onClick={() => onSelectDraft?.(`owned:${p.parcelId}`)}
                  >
                    🏗️ {resolveLandDisplayName(p, { defaultName: 'Virtual Land' })}
                  </button>
                ))}
              </div>
            )}
          <div className="land-limit-mobile-callout">
            <div className="land-limit-mobile-copy">
              <strong>📱 Want to claim land right now?</strong>
              <span>
                You can still make sculptures in person on Mobile AR — every IRL sculpture
                automatically claims land with no Desktop slot wait!
              </span>
            </div>
          </div>
        </div>
      )}

      {statusText && (
        <div
          className={`status-banner ${statusIsError ? 'status-banner-error' : ''}`}
          role="status"
        >
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

      {/* Draft Plots Queue */}
      <div className="land-section-header">
        <strong>
          Draft Plots ({draftParcels.length}/{limits.maxSelectionBatch})
        </strong>
        <div className="land-builder-legend" aria-label="Wireframe color key">
          <span>
            <i className="legend-dot legend-cyan" /> Draft
          </span>
          <span>
            <i className="legend-dot legend-amber" /> Minted
          </span>
          <span>
            <i className="legend-dot legend-crimson" /> Conflict
          </span>
        </div>
      </div>

      {draftParcels.length === 0 ? (
        <div
          className="empty-state"
          style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12 }}
        >
          {isDrawActive ? (
            <>
              <strong>Draw mode active!</strong> Click or drag anywhere on the map to place a 3D
              plot, or press <strong>+ Add Square</strong>.
            </>
          ) : (
            <>
              Click <strong>✏️ Draw Land</strong> and drag on the map, or press{' '}
              <strong>+ Add Square</strong>.
            </>
          )}
        </div>
      ) : (
        <div className="land-draft-list" role="list">
          {draftParcels.map((draft, idx) => {
            const isSelected = activeMode === 'draft' && activeDraft?.id === draft.id;
            const titleState = getDraftTitleState(draft);
            const hasGeomIssue = draft.valid === false || draft.hasOverlap;
            const hasTitleIssue = !titleState.ok;
            const label = draft.customName?.trim() || `Plot #${idx + 1}`;
            return (
              <div
                key={draft.id}
                role="listitem"
                className={`land-draft-item ${isSelected ? 'selected' : ''} ${
                  hasGeomIssue ? 'has-issue' : ''
                }`}
                onClick={() => onSelectDraft?.(draft.id)}
              >
                <div className="land-draft-main">
                  <div className="land-draft-title">
                    <span className="land-draft-index">#{idx + 1}</span>
                    <EmojiInput
                      type="text"
                      className="land-draft-inline-title"
                      wrapperStyle={{ flex: '1 1 auto', minWidth: 96, maxWidth: 180 }}
                      aria-label={`Title for plot #${idx + 1}`}
                      maxLength={48}
                      value={draft.customName || ''}
                      placeholder="Name this land (required)…"
                      onFocus={() => onSelectDraft?.(draft.id)}
                      onChange={(e) => onUpdateDraft?.(draft.id, { customName: e.target.value })}
                    />
                  </div>
                  <div className="land-draft-meta">
                    {Math.round(draft.widthMeters)}×{Math.round(draft.depthMeters)}×
                    {Math.round(draft.heightMeters)}m · {Math.round(draft.rotationDeg || 0)}° ·{' '}
                    {Math.round(draft.footprintAreaSqM || 0)} m²
                  </div>
                </div>
                <div className="land-draft-badges">
                  <span
                    className={`badge ${
                      hasGeomIssue ? 'badge-error' : hasTitleIssue ? 'gold' : 'badge-cyan'
                    }`}
                  >
                    {draft.hasOverlap
                      ? 'Overlap'
                      : draft.valid === false
                      ? 'Limit'
                      : titleState.state === 'taken'
                      ? 'Taken'
                      : titleState.state === 'checking'
                      ? 'Checking…'
                      : hasTitleIssue
                      ? 'Name Req.'
                      : 'Ready'}
                  </span>
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

      {/* Selected Draft or Owned Land Editor */}
      {activeItem && (
        <div className="land-selected-editor" data-testid="land-selected-editor">
          <div className="land-editor-header">
            <div className="land-editor-title-row">
              <div className="land-editor-title">
                {activeMode === 'owned'
                  ? activeOwned?.customName || 'Minted 3D Volume'
                  : 'Mint New Land'}
              </div>
              <InfoTip title="Shape Controls" align="right">
                Drag handles directly on the 3D map (corner balls scale, edge bars stretch one side,
                vertical bars rotate, center moves) or expand the manual sliders below.
              </InfoTip>
            </div>
            <div className="land-editor-id">
              {activeArea.toLocaleString()} m² · {activeCubic.toLocaleString()} m³
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
                <span className="land-name-field-label">
                  Land Title <em className="req-star">*</em>
                </span>
                <EmojiInput
                  id="land-square-name-input"
                  type="text"
                  maxLength={48}
                  required
                  placeholder="Enter a unique land name (e.g., Sunset Courtyard)"
                  value={activeDraft.customName || ''}
                  onChange={(e) => onUpdateDraft?.(activeDraft.id, { customName: e.target.value })}
                />
                {activeDraftTitleState && (
                  <span
                    className={`land-title-validation is-${activeDraftTitleState.state}`}
                    data-testid="land-title-validation"
                  >
                    {activeDraftTitleState.state === 'available'
                      ? '✓ Title is available'
                      : activeDraftTitleState.state === 'checking'
                      ? '⏳ Checking title availability…'
                      : activeDraftTitleState.message}
                  </span>
                )}
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

          {/* Compact Expandable Manual Sliders Section */}
          <div className="land-dims-accordion">
            <button
              type="button"
              className="land-dims-toggle"
              data-testid="land-sliders-toggle"
              aria-expanded={showManualDims}
              onClick={() => setShowManualDims((prev) => !prev)}
            >
              <span className="land-dims-summary mono">
                📐 {Math.round(activeWidth)}×{Math.round(activeDepth)}×{Math.round(activeHeight)}m ·{' '}
                {activeRotation}° ({areaLimitPct}% max)
              </span>
              <span className="land-dims-caret">
                {showManualDims ? 'Hide Sliders ▴' : 'Manual Sliders ▾'}
              </span>
            </button>

            {showManualDims && (
              <div className="land-dims-sliders-body" data-testid="land-sliders-body">
                <div className="land-slider-row">
                  <div className="land-slider-label">
                    <span>
                      Scale ({areaLimitPct}% max)
                      <InfoTip title="Proportional Scale">
                        Scales width &amp; depth together up to the{' '}
                        {limits.maxFootprintAreaSqM.toLocaleString()} m² limit while keeping your
                        orientation and aspect ratio.
                      </InfoTip>
                    </span>
                    <strong>
                      {activeWidth}×{activeDepth} m
                    </strong>
                  </div>
                  <input
                    type="range"
                    aria-label="Scale Footprint to Limit"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(footprintScaleRatio * 100)}
                    onPointerDown={() =>
                      activeMode === 'draft' &&
                      activeDraft &&
                      onDraftGestureStart?.(activeDraft.id, 'scale')
                    }
                    onPointerUp={() => onDraftGestureEnd?.()}
                    onBlur={() => onDraftGestureEnd?.()}
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
                        patchActiveDimensions(
                          {
                            widthMeters: maxFootprintFit.widthMeters,
                            depthMeters: maxFootprintFit.depthMeters,
                            heightMeters: maxFootprintFit.heightMeters,
                            zScale: maxFootprintFit.zScale
                          },
                          { discrete: true, label: 'Max land size' }
                        )
                      }
                    >
                      Max Limit Size ({maxFootprintFit.widthMeters}×{maxFootprintFit.depthMeters}m)
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() =>
                        patchActiveDimensions(
                          {
                            rotationDeg: normalizeRotationDeg(cameraBearingDeg)
                          },
                          { discrete: true, label: 'Match map angle' }
                        )
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
                    onPointerDown={() =>
                      activeMode === 'draft' &&
                      activeDraft &&
                      onDraftGestureStart?.(activeDraft.id, 'width')
                    }
                    onPointerUp={() => onDraftGestureEnd?.()}
                    onBlur={() => onDraftGestureEnd?.()}
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
                    onPointerDown={() =>
                      activeMode === 'draft' &&
                      activeDraft &&
                      onDraftGestureStart?.(activeDraft.id, 'depth')
                    }
                    onPointerUp={() => onDraftGestureEnd?.()}
                    onBlur={() => onDraftGestureEnd?.()}
                    onChange={(e) => patchActiveDimensions({ depthMeters: Number(e.target.value) })}
                  />
                </div>

                <div className="land-slider-row">
                  <div className="land-slider-label">
                    <span>
                      Rotate (°)
                      <InfoTip title="Rotate Plot">
                        Hold and move any vertical corner bar on the 3D box on the map to rotate
                        freely, or use the slider below.
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
                    onPointerDown={() =>
                      activeMode === 'draft' &&
                      activeDraft &&
                      onDraftGestureStart?.(activeDraft.id, 'rotate')
                    }
                    onPointerUp={() => onDraftGestureEnd?.()}
                    onBlur={() => onDraftGestureEnd?.()}
                    onChange={(e) => patchActiveDimensions({ rotationDeg: Number(e.target.value) })}
                  />
                  <div className="land-nudge-row">
                    {[-15, 0, 15, 45].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() =>
                          patchActiveDimensions(
                            {
                              rotationDeg: delta === 0 ? 0 : normalizeDeg(activeRotation + delta)
                            },
                            { discrete: true, label: 'Rotate land' }
                          )
                        }
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
                        Adjusts vertical height from {limits.minHeightMeters}m up to{' '}
                        {maxHeightInfo.heightMeters}m within the{' '}
                        {limits.maxVolumeCubicM.toLocaleString()} m³ volume cap.
                      </InfoTip>
                    </span>
                    <strong>
                      {activeZScale.toFixed(2)}× ({Math.round(activeHeight)} m)
                    </strong>
                  </div>
                  <input
                    type="range"
                    aria-label="Z-Axis Scale"
                    min={limits.minZScale}
                    max={Math.max(limits.minZScale, maxHeightInfo.zScale)}
                    step={0.05}
                    value={Math.min(activeZScale, Math.max(limits.minZScale, maxHeightInfo.zScale))}
                    onPointerDown={() =>
                      activeMode === 'draft' &&
                      activeDraft &&
                      onDraftGestureStart?.(activeDraft.id, 'height')
                    }
                    onPointerUp={() => onDraftGestureEnd?.()}
                    onBlur={() => onDraftGestureEnd?.()}
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
                        patchActiveDimensions(
                          {
                            zScale: maxHeightInfo.zScale,
                            heightMeters: maxHeightInfo.heightMeters
                          },
                          { discrete: true, label: 'Max land height' }
                        )
                      }
                    >
                      Max Height ({maxHeightInfo.heightMeters}m)
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="land-editor-actions">
            {activeMode === 'draft' ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                style={{ flex: 1 }}
                disabled={!canMintActiveDraft}
                onClick={() => onMintDraft?.(activeDraft)}
              >
                {mintBusy ? 'Minting…' : 'Mint This Land'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => handleCopyMintedParcelLink(activeOwned)}
                >
                  <XeroIcon emoji="📋" size={16} /> Copy Link
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={Boolean(mintBusy)}
                  onClick={() =>
                    onUpdateOwnedVolume?.(activeOwned.parcelId, {
                      centerLat: activeVolume.centerLat,
                      centerLng: activeVolume.centerLng,
                      widthMeters: activeWidth,
                      depthMeters: activeDepth,
                      heightMeters: activeHeight,
                      zScale: activeZScale,
                      rotationDeg: activeRotation
                    })
                  }
                >
                  {mintBusy ? 'Saving…' : 'Save 3D Volume'}
                </button>
                {onOpenAddLandItem && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => onOpenAddLandItem(activeOwned)}
                  >
                    + Add 3D Item
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
                      ? '🔓 Unfreeze'
                      : '❄️ Freeze'}
                  </button>
                )}
                {onOpenLandManagement && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => onOpenLandManagement(activeOwned.parcelId)}
                  >
                    <XeroIcon emoji="⚙️" size={16} /> Manage
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Clean Batch Mint Window (shown when queueing 2+ draft plots) */}
      {draftParcels.length >= 2 && (
        <div className="land-batch-card" data-testid="land-batch-mint">
          <div className="land-batch-head">
            <div>
              <strong>⚡ Batch Mint</strong>
              <span className="land-batch-sub">
                {readyDrafts.length} of {draftParcels.length} plots titled &amp; ready
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={readyDrafts.length === 0 || Boolean(mintBusy)}
              onClick={onMintAll}
            >
              {mintBusy ? 'Minting…' : `Mint All (${readyDrafts.length})`}
            </button>
          </div>
          {untitledOrInvalidDrafts.length > 0 && (
            <div className="land-batch-hint">
              Add a unique Land Title to every plot above before batch minting.
            </div>
          )}
        </div>
      )}

      {/* Post-Mint Locations & Copy Tools (Only available after lands are minted!) */}
      {copyableMintedParcels.length > 0 && (
        <div className="land-minted-panel" data-testid="minted-lands-copy-panel">
          <div className="land-section-header">
            <strong>Your Minted Lands ({copyableMintedParcels.length})</strong>
            <InfoTip title="Share & Export Minted Lands" align="right">
              Copy an individual land link or location with its icons, or copy all minted locations
              at once — including AI agent prompt format!
            </InfoTip>
          </div>

          <div className="land-minted-bulk-actions">
            <button
              type="button"
              className="btn btn-xs btn-outline"
              data-testid="copy-all-minted-locations-btn"
              onClick={handleCopyAllMintedLocations}
            >
              📍 Copy All Locations
            </button>
            <button
              type="button"
              className="btn btn-xs btn-primary"
              data-testid="copy-all-minted-prompt-btn"
              onClick={handleCopyAllMintedForAgent}
            >
              🤖 Copy Prompt (All)
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowMintedAgentPreview((prev) => !prev)}
            >
              {showMintedAgentPreview ? 'Hide' : 'Preview'}
            </button>
          </div>

          {showMintedAgentPreview && (
            <textarea
              readOnly
              className="land-agent-preview"
              aria-label="Minted lands AI agent prompt preview"
              value={mintedAgentPromptText}
              rows={7}
            />
          )}

          <div className="land-minted-list">
            {copyableMintedParcels.slice(0, 10).map((parcel) => {
              const ownedKey = `owned:${parcel.parcelId}`;
              const isSelected = selectedDraftId === ownedKey;
              const isFrozen = Boolean(parcel.frozen || parcel.settings?.frozen);
              const displayTitle = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
              return (
                <div
                  key={parcel.parcelId}
                  className={`land-minted-row ${isSelected ? 'selected' : ''}`}
                >
                  <button
                    type="button"
                    className="land-minted-name-btn"
                    onClick={() => onSelectDraft?.(ownedKey)}
                    title={`Select ${displayTitle}`}
                  >
                    <span>
                      {isFrozen ? '❄️ ' : '📍 '}
                      {displayTitle}
                    </span>
                  </button>
                  <div className="land-minted-row-icons">
                    <button
                      type="button"
                      className="btn btn-xs btn-outline land-icon-btn"
                      aria-label={`Copy share link for ${displayTitle}`}
                      title="Copy share link"
                      onClick={() => handleCopyMintedParcelLink(parcel)}
                    >
                      <XeroIcon emoji="📋" size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-outline land-icon-btn"
                      aria-label={`Copy location coordinates for ${displayTitle}`}
                      title="Copy location & coordinates"
                      onClick={() => handleCopyMintedParcelLocation(parcel)}
                    >
                      <XeroIcon emoji="📍" size={14} />
                    </button>
                    {onOpenAddLandItem && (
                      <button
                        type="button"
                        className="btn btn-xs btn-primary land-owned-plus-btn"
                        aria-label={`Add 3D item to ${displayTitle}`}
                        title="Add 3D item or open AI agent prompt"
                        onClick={() => onOpenAddLandItem(parcel)}
                      >
                        +
                      </button>
                    )}
                    {onOpenTitleOwned && (
                      <button
                        type="button"
                        className="btn btn-xs btn-outline land-icon-btn"
                        aria-label={`Rename ${displayTitle}`}
                        title="Edit land title & description"
                        onClick={() => onOpenTitleOwned(parcel)}
                      >
                        ✎
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
export default DesktopLandBuilderPanel;
