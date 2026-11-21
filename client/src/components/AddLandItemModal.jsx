import React, { useMemo, useState } from 'react';
import { buildLandAdd3DItemAgentPrompt } from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

const SUPPORTED_ITEM_TYPES = [
  { id: 'voxel', label: '3D Voxel Sculpture', ext: 'VOXEL', note: '4x grid (0.05m), up to 4,096 blocks, matte/neon/glass' },
  { id: 'glb', label: '.GLB 3D Model', ext: 'GLB', note: 'Binary glTF 2.0 (Draco / Meshopt supported, <= 150k tris)' },
  { id: 'gltf', label: '.GLTF 3D Model', ext: 'GLTF', note: 'Standard glTF 2.0 JSON mesh' },
  { id: 'obj', label: '.OBJ 3D Mesh', ext: 'OBJ', note: 'Wavefront OBJ geometry' },
  { id: 'stl', label: '.STL 3D Mesh', ext: 'STL', note: 'ASCII or binary STL mesh' },
  { id: 'ply', label: '.PLY 3D Mesh', ext: 'PLY', note: 'Polygon / point cloud mesh' }
];

const VOXEL_STYLES = ['custom', 'plinth', 'arch', 'totem', 'pyramid', 'beacon'];

export default function AddLandItemModal({
  parcel,
  existingSculptures = [],
  user = null,
  mcpState = null,
  onMcpStateChange = null,
  onToggleFreeze = null,
  onToggleSculptureVisibility = null,
  onSelectSculpture = null,
  onOpenLandManagement = null,
  onClose
}) {
  const [itemFormat, setItemFormat] = useState('voxel');
  const [itemTitle, setItemTitle] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [stylePreset, setStylePreset] = useState('custom');
  const [modelUrl, setModelUrl] = useState('');
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [dz, setDz] = useState(0);
  const [yaw, setYaw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [visBusyId, setVisBusyId] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [pairingOverride, setPairingOverride] = useState('');

  const apiOrigin =
    API_BASE ||
    (typeof window !== 'undefined'
      ? window.location.origin
      : 'https://graffiland-api.maxinfeld-artshow.workers.dev');

  const activePairingCode =
    pairingOverride ||
    mcpState?.activePairing?.code ||
    mcpState?.pairings?.find((p) => p.status === 'active' || p.status === 'pending')?.code ||
    '<YOUR_GLP_PAIRING_CODE>';

  const ownerAddress =
    user?.activeMintRecipient || user?.walletAddress || '<YOUR_WALLET_ADDRESS>';

  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);

  const promptText = useMemo(
    () =>
      buildLandAdd3DItemAgentPrompt({
        parcel,
        itemFormat,
        itemTitle: itemTitle.trim() || `Custom ${itemFormat === 'voxel' ? 'Voxel' : itemFormat.toUpperCase()} Artwork`,
        itemDescription: itemDescription.trim(),
        stylePreset,
        modelUrl: modelUrl.trim(),
        anchorOffset: { dx: Number(dx || 0), dy: Number(dy || 0), dz: Number(dz || 0), yaw: Number(yaw || 0) },
        existingSculptures,
        apiOrigin,
        pairingCode: activePairingCode,
        ownerAddress
      }),
    [
      parcel,
      itemFormat,
      itemTitle,
      itemDescription,
      stylePreset,
      modelUrl,
      dx,
      dy,
      dz,
      yaw,
      existingSculptures,
      apiOrigin,
      activePairingCode,
      ownerAddress
    ]
  );

  if (!parcel) return null;

  async function handleCopyPrompt() {
    setBusy(true);
    setStatusMsg('');
    try {
      let codeToUse = activePairingCode;
      if (user?.id && codeToUse === '<YOUR_GLP_PAIRING_CODE>') {
        const created = await api.createMcpPairing({ apiOrigin }).catch(() => null);
        if (created?.pairing?.code) {
          codeToUse = created.pairing.code;
          setPairingOverride(codeToUse);
          const refreshed = await api.listMcpPairings().catch(() => null);
          if (refreshed) onMcpStateChange?.(refreshed);
        }
      }
      const finalPrompt = buildLandAdd3DItemAgentPrompt({
        parcel,
        itemFormat,
        itemTitle: itemTitle.trim() || `Custom ${itemFormat === 'voxel' ? 'Voxel' : itemFormat.toUpperCase()} Artwork`,
        itemDescription: itemDescription.trim(),
        stylePreset,
        modelUrl: modelUrl.trim(),
        anchorOffset: { dx: Number(dx || 0), dy: Number(dy || 0), dz: Number(dz || 0), yaw: Number(yaw || 0) },
        existingSculptures,
        apiOrigin,
        pairingCode: codeToUse,
        ownerAddress
      });
      const ok = await copyToClipboard(finalPrompt);
      setStatusMsg(
        ok
          ? `Copied 3D item agent prompt for ${parcel.parcelId}! Paste into your AI agent.`
          : 'Prompt ready below — select & copy.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleFreezeClick() {
    if (!onToggleFreeze) return;
    setFreezeBusy(true);
    setStatusMsg('');
    try {
      await onToggleFreeze(parcel.parcelId, !isFrozen);
      setStatusMsg(
        !isFrozen
          ? `Frozen ${parcel.parcelId} — no new sculptures can be placed here.`
          : `Unfrozen ${parcel.parcelId} — new sculptures are allowed again.`
      );
    } catch (err) {
      setStatusMsg(err?.message || 'Could not update freeze setting.');
    } finally {
      setFreezeBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card add-item-modal-card"
        style={{ maxWidth: 690 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Add 3D item to ${parcel.parcelId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="add-item-plus-badge">+</span>
            <span>Add 3D Item to {parcel.customName || parcel.parcelId}</span>
            <InfoTip title="Agent 3D Placement & Curation">
              Pick any supported 3D format and copy this prompt for your AI agent. Your agent can
              add new items, modify or reposition existing artworks on this land, hide/unhide
              pieces, or freeze/unfreeze placements.
            </InfoTip>
          </h2>
          <button type="button" className="btn" aria-label="Close add 3D item modal" onClick={onClose}>
            <XeroIcon emoji="✕" size={15} />
          </button>
        </div>

        <div className="add-item-meta-strip mono">
          <span>
            <strong>{parcel.parcelId}</strong>
            {parcel.volume
              ? ` · ${Math.round(parcel.volume.widthMeters)}×${Math.round(parcel.volume.depthMeters)}×${Math.round(parcel.volume.heightMeters)}m`
              : ''}
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge ${isFrozen ? 'badge-error' : 'teal'}`}>
              {isFrozen ? '❄️ Frozen (Placements Blocked)' : '✅ Open for 3D Placements'}
            </span>
            {onToggleFreeze && (
              <button
                type="button"
                className={`btn btn-xs ${isFrozen ? 'btn-primary' : ''}`}
                disabled={freezeBusy}
                onClick={handleFreezeClick}
              >
                {freezeBusy ? 'Saving…' : isFrozen ? '🔓 Unfreeze Land' : '❄️ Freeze Land'}
              </button>
            )}
          </div>
        </div>

        {/* Supported 3D Item Format Selector */}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
            Choose 3D Format Supported by GRAFFILAND
          </div>
          <div className="add-item-format-grid" role="radiogroup" aria-label="Supported 3D item format">
            {SUPPORTED_ITEM_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={itemFormat === t.id}
                className={`add-item-format-pill ${itemFormat === t.id ? 'is-selected' : ''}`}
                onClick={() => setItemFormat(t.id)}
                title={t.note}
              >
                <strong>{t.ext}</strong>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Item Description & Placement Controls */}
        <div className="add-item-form-grid">
          <label className="land-name-field">
            <span>3D Item Title</span>
            <input
              type="text"
              maxLength={48}
              value={itemTitle}
              onChange={(e) => setItemTitle(e.target.value)}
              placeholder="e.g. Glowing Cyber Dragon"
            />
          </label>

          {itemFormat === 'voxel' ? (
            <label className="land-name-field">
              <span>Voxel Style / Prefab Hint</span>
              <select
                className="input"
                value={stylePreset}
                onChange={(e) => setStylePreset(e.target.value)}
              >
                {VOXEL_STYLES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="land-name-field">
              <span>3D Model URL (optional — or agent uploads base64)</span>
              <input
                type="text"
                value={modelUrl}
                onChange={(e) => setModelUrl(e.target.value)}
                placeholder={`https://.../model.${itemFormat} or ipfs://...`}
              />
            </label>
          )}
        </div>

        <label className="land-name-field" style={{ marginTop: 8 }}>
          <span>What should your AI agent build or modify?</span>
          <textarea
            className="textarea"
            rows={2}
            maxLength={240}
            value={itemDescription}
            onChange={(e) => setItemDescription(e.target.value)}
            placeholder="Describe the 3D sculpture, colors, scale, or edits to existing items on this land..."
          />
        </label>

        <div className="add-item-offset-row">
          <label>
            <span>dx (m)</span>
            <input type="number" step="0.5" value={dx} onChange={(e) => setDx(e.target.value)} />
          </label>
          <label>
            <span>dy (m)</span>
            <input type="number" step="0.5" value={dy} onChange={(e) => setDy(e.target.value)} />
          </label>
          <label>
            <span>dz (m)</span>
            <input type="number" step="0.5" value={dz} onChange={(e) => setDz(e.target.value)} />
          </label>
          <label>
            <span>yaw (°)</span>
            <input type="number" step="15" value={yaw} onChange={(e) => setYaw(e.target.value)} />
          </label>
        </div>

        {/* Copyable AI Agent Prompt */}
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12.5 }}>Copyable AI Agent Prompt</strong>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={handleCopyPrompt}
              >
                <XeroIcon emoji="📋" size={13} />{' '}
                {busy ? 'Preparing…' : 'Copy 3D Item Agent Prompt'}
              </button>
              {onOpenLandManagement && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    onClose?.();
                    onOpenLandManagement(parcel.parcelId);
                  }}
                >
                  ⚙️ Land Settings
                </button>
              )}
            </div>
          </div>
          {statusMsg && (
            <div className="status-banner" role="status" style={{ marginBottom: 6 }}>
              {statusMsg}
            </div>
          )}
          <textarea
            readOnly
            className="land-agent-preview"
            aria-label="Add 3D item agent prompt preview"
            value={promptText}
            onFocus={(e) => e.target.select()}
          />
        </div>

        {/* Existing Artworks on This Land (Quick Modify / Hide / Restore) */}
        {existingSculptures.length > 0 && (
          <div className="add-item-existing-list">
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              Artworks Currently on This Land ({existingSculptures.length})
            </div>
            {existingSculptures.map((sc) => (
              <div key={sc.id} className="add-item-existing-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{sc.title}</span>
                    {sc.hidden && <span className="badge badge-error" style={{ fontSize: 10 }}>Hidden</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                    {sc.modelType === 'custom-3d'
                      ? `.${sc.customModel?.format || 'glb'}`
                      : `${sc.voxelCount || 0} voxels`}{' '}
                    · by {sc.creatorName || 'Artist'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                  {onSelectSculpture && (
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => {
                        onClose?.();
                        onSelectSculpture(sc);
                      }}
                    >
                      ✏️ Inspect / Modify
                    </button>
                  )}
                  {onToggleSculptureVisibility && (
                    <button
                      type="button"
                      className={`btn btn-xs ${sc.hidden ? 'btn-primary' : ''}`}
                      disabled={visBusyId === sc.id}
                      onClick={async () => {
                        setVisBusyId(sc.id);
                        try {
                          await onToggleSculptureVisibility(sc.id, !sc.hidden);
                          setStatusMsg(
                            sc.hidden
                              ? `Restored "${sc.title}" to public map & 3D view.`
                              : `Hidden "${sc.title}" from public map & AR feeds.`
                          );
                        } catch (err) {
                          setStatusMsg(err?.message || 'Visibility update failed.');
                        } finally {
                          setVisBusyId('');
                        }
                      }}
                    >
                      {sc.hidden ? '👁️ Unhide' : '🙈 Hide'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
