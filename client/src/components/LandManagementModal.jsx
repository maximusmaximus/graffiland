import React, { useCallback, useEffect, useRef, useState } from 'react';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import {
  buildParcelShareUrl,
  resolveLandDisplayName
} from '../../../shared/landVolume.mjs';
import { api, API_BASE } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { isWebAuthnSupported, registerHardwarePasskey } from '../utils/passkeyClient.js';
import { EmojiInput, EmojiTextarea } from './EmojiField.jsx';
import InfoTip from './InfoTip.jsx';
import LandIsometricPreview from './LandIsometricPreview.jsx';
import SculptureRevisionsPanel from './SculptureRevisionsPanel.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function LandManagementModal({
  user,
  initialParcelId = '',
  userLocation = null,
  onSelectSculpture,
  onOpenAddLandItem = null,
  onFocusParcel = null,
  onWorkspaceChanged,
  onClose
}) {
  const [workspace, setWorkspace] = useState(null);
  const [selectedParcelId, setSelectedParcelId] = useState(initialParcelId || '');
  const selectedParcelIdRef = useRef(selectedParcelId);
  selectedParcelIdRef.current = selectedParcelId;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [customName, setCustomName] = useState('');
  const [curationNote, setCurationNote] = useState('');
  const [allowAgentErase, setAllowAgentErase] = useState(true);
  const [allowContributorEdits, setAllowContributorEdits] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [requirePasskeyUnlock, setRequirePasskeyUnlock] = useState(false);
  const [requireOrbUnlock, setRequireOrbUnlock] = useState(false);
  const [minOrbInliers, setMinOrbInliers] = useState(8);
  const [passkeys, setPasskeys] = useState([]);
  const [expandedRevIds, setExpandedRevIds] = useState({});
  const [manualContribInput, setManualContribInput] = useState('');
  const [eraseConfirmInput, setEraseConfirmInput] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  const [showLocalUpload, setShowLocalUpload] = useState(false);

  // Direct browser custom 3D model uploader + anchorOffset calibration
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadFormat, setUploadFormat] = useState('glb');
  const [uploadBase64, setUploadBase64] = useState('');
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadScale, setUploadScale] = useState(1);
  const [anchorOffset, setAnchorOffset] = useState({ dx: 0, dy: 0, dz: 0, yaw: 0 });

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const [res, pkRes] = await Promise.all([
        api.getMyLands(),
        api.getPasskeyStatus().catch(() => ({ passkeys: [] }))
      ]);
      setWorkspace(res);
      setPasskeys(pkRes?.passkeys || []);
      const list = res?.parcels || [];
      if (list.length > 0) {
        const preferredId = selectedParcelIdRef.current || initialParcelId;
        const picked = list.find((p) => p.parcelId === preferredId) || list[0];
        setSelectedParcelId(picked.parcelId);
        setCustomName(
          picked.customName || resolveLandDisplayName(picked, { defaultName: '' })
        );
        setCurationNote(picked.description || picked.curationNote || '');
        setAllowAgentErase(picked.settings?.allowAgentErase !== false);
        setAllowContributorEdits(picked.settings?.allowContributorEdits !== false);
        setFrozen(Boolean(picked.settings?.frozen || picked.frozen));
        setRequirePasskeyUnlock(Boolean(picked.securityPolicy?.requirePasskeyUnlock));
        setRequireOrbUnlock(Boolean(picked.securityPolicy?.requireOrbUnlock));
        setMinOrbInliers(Number(picked.securityPolicy?.minOrbInliers || 8));
      } else {
        setSelectedParcelId('');
      }
    } catch (err) {
      setErrorMsg(err.message || 'Could not load Virtual Land workspace');
    } finally {
      setLoading(false);
    }
  }, [initialParcelId]);

  useEffect(() => {
    if (user?.id) loadWorkspace();
  }, [user?.id, loadWorkspace]);

  const activeParcel =
    workspace?.parcels?.find((p) => p.parcelId === selectedParcelId) ||
    workspace?.parcels?.[0] ||
    null;

  function selectParcel(p) {
    setSelectedParcelId(p.parcelId);
    setCustomName(p.customName || resolveLandDisplayName(p, { defaultName: '' }));
    setCurationNote(p.description || p.curationNote || '');
    setAllowAgentErase(p.settings?.allowAgentErase !== false);
    setAllowContributorEdits(p.settings?.allowContributorEdits !== false);
    setFrozen(Boolean(p.settings?.frozen || p.frozen));
    setRequirePasskeyUnlock(Boolean(p.securityPolicy?.requirePasskeyUnlock));
    setRequireOrbUnlock(Boolean(p.securityPolicy?.requireOrbUnlock));
    setMinOrbInliers(Number(p.securityPolicy?.minOrbInliers || 8));
    setEraseConfirmInput('');
    setNotice('');
    setErrorMsg('');
  }

  async function handleRegisterPasskey() {
    setBusy('passkey');
    setNotice('');
    setErrorMsg('');
    try {
      const label = navigator.userAgent?.includes('Mobile') ? 'Mobile Passkey' : 'Desktop Passkey';
      const out = await registerHardwarePasskey(label);
      const pkRes = await api.getPasskeyStatus();
      setPasskeys(pkRes?.passkeys || []);
      setNotice(`Registered Passkey (${out.passkey?.deviceLabel || 'Device'}).`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not register Passkey');
    } finally {
      setBusy('');
    }
  }

  async function handleDeletePasskey(pkId) {
    setBusy('passkey');
    setNotice('');
    setErrorMsg('');
    try {
      await api.deletePasskey(pkId);
      const pkRes = await api.getPasskeyStatus();
      setPasskeys(pkRes?.passkeys || []);
      setNotice('Removed Passkey.');
    } catch (err) {
      setErrorMsg(err.message || 'Could not remove Passkey');
    } finally {
      setBusy('');
    }
  }

  function handleModelFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!['glb', 'gltf', 'obj', 'stl', 'ply'].includes(ext)) {
      setErrorMsg('Unsupported format. Use .glb, .gltf, .obj, .stl, or .ply.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrorMsg('File exceeds 5 MB limit.');
      return;
    }
    setErrorMsg('');
    setUploadFormat(ext);
    setUploadFileName(file.name);
    if (!uploadTitle.trim()) {
      setUploadTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 48));
    }
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      setUploadBase64(btoa(bin));
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleUpload3DModelSubmit(e) {
    e.preventDefault();
    if (!activeParcel || !uploadBase64) return;
    setBusy('upload');
    setNotice('');
    setErrorMsg('');
    const activeLandLabel = resolveLandDisplayName(
      { ...activeParcel, customName: customName || activeParcel.customName },
      { defaultName: 'Virtual Land' }
    );
    try {
      const res = await api.createSculptureOnLand(activeParcel.parcelId, {
        title: uploadTitle.trim() || uploadFileName || '3D Model Sculpture',
        description:
          uploadDesc.trim() ||
          `Custom ${uploadFormat.toUpperCase()} 3D model placed on "${activeLandLabel}".`,
        modelFormat: uploadFormat,
        modelBase64: uploadBase64,
        modelScale: Number(uploadScale || 1),
        anchorOffset: {
          dx: Number(anchorOffset.dx || 0),
          dy: Number(anchorOffset.dy || 0),
          dz: Number(anchorOffset.dz || 0),
          yaw: Number(anchorOffset.yaw || 0)
        }
      });
      setUploadTitle('');
      setUploadDesc('');
      setUploadBase64('');
      setUploadFileName('');
      setShowLocalUpload(false);
      await loadWorkspace();
      onWorkspaceChanged?.();
      setNotice(
        `Uploaded "${res?.sculpture?.title || '3D Model'}" (${uploadFormat.toUpperCase()}) onto "${activeLandLabel}".`
      );
    } catch (err) {
      setErrorMsg(err.message || 'Could not upload 3D model');
    } finally {
      setBusy('');
    }
  }

  async function handleSaveCurationAndSettings(e) {
    e.preventDefault();
    if (!activeParcel) return;
    setBusy('save');
    setNotice('');
    setErrorMsg('');
    try {
      await api.updateLandParcel(activeParcel.parcelId, {
        customName,
        description: curationNote,
        curationNote
      });
      await api.updateLandSettings(activeParcel.parcelId, {
        allowAgentErase,
        allowContributorEdits,
        frozen
      });
      await api.updateLandSecurityPolicy(activeParcel.parcelId, {
        requirePasskeyUnlock,
        requireOrbUnlock,
        minOrbInliers: Number(minOrbInliers || 8)
      });
      await loadWorkspace();
      onWorkspaceChanged?.();
      const savedLabel = resolveLandDisplayName(
        { ...activeParcel, customName: customName || activeParcel.customName },
        { defaultName: 'Virtual Land' }
      );
      setNotice(`Saved settings for "${savedLabel}".`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not update land settings');
    } finally {
      setBusy('');
    }
  }

  async function handleAddContributor(payload) {
    if (!activeParcel) return;
    setBusy('contrib');
    setNotice('');
    setErrorMsg('');
    try {
      const res = await api.addLandContributor(activeParcel.parcelId, payload);
      setManualContribInput('');
      await loadWorkspace();
      onWorkspaceChanged?.();
      setNotice(
        `Added ${res?.contributor?.name || res?.contributor?.email || 'visitor'} as Contributor.`
      );
    } catch (err) {
      setErrorMsg(err.message || 'Could not add contributor');
    } finally {
      setBusy('');
    }
  }

  async function handleRemoveContributor(contributorSub) {
    if (!activeParcel) return;
    setBusy('contrib');
    setNotice('');
    setErrorMsg('');
    try {
      await api.removeLandContributor(activeParcel.parcelId, contributorSub);
      await loadWorkspace();
      onWorkspaceChanged?.();
      const activeLandLabel = resolveLandDisplayName(
        { ...activeParcel, customName: customName || activeParcel.customName },
        { defaultName: 'Virtual Land' }
      );
      setNotice(`Removed contributor from "${activeLandLabel}".`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not remove contributor');
    } finally {
      setBusy('');
    }
  }

  async function handleCopyMcpPrompt() {
    if (!activeParcel) return;
    setBusy('mcp');
    setNotice('');
    setErrorMsg('');
    try {
      const pairingsRes = await api.listMcpPairings();
      let code =
        pairingsRes.activePairing?.code ||
        pairingsRes.pairings?.find((p) => p.status === 'pending')?.code;
      const origin = API_BASE || window.location.origin;
      if (!code) {
        const created = await api.createMcpPairing({ apiOrigin: origin });
        code = created.pairing?.code;
      }
      const promptText = buildPropertyOwnerPrompt({
        apiOrigin: origin,
        pairingCode: code,
        ownerAddress: workspace?.ownerAddress || user?.activeMintRecipient || user?.walletAddress,
        parcelId: activeParcel.parcelId
      });
      await copyToClipboard(promptText);
      setPromptCopied(true);
      const activeLandLabel = resolveLandDisplayName(
        { ...activeParcel, customName: customName || activeParcel.customName },
        { defaultName: 'Virtual Land' }
      );
      setNotice(`Copied MCP Agent Prompt for "${activeLandLabel}" (${code}).`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not copy MCP prompt');
    } finally {
      setBusy('');
    }
  }

  async function handleEraseLand() {
    if (!activeParcel) return;
    const activeLandLabel = resolveLandDisplayName(
      { ...activeParcel, customName: customName || activeParcel.customName },
      { defaultName: 'Virtual Land' }
    );
    const typed = eraseConfirmInput.trim();
    const matchesConfirm =
      typed.toLowerCase() === activeLandLabel.toLowerCase() ||
      typed.toUpperCase() === 'ERASE' ||
      typed.toUpperCase() === activeParcel.parcelId;
    if (!matchesConfirm) {
      setErrorMsg(`Type "${activeLandLabel}" (or ERASE) to confirm erasing.`);
      return;
    }
    setBusy('erase');
    setNotice('');
    setErrorMsg('');
    try {
      const res = await api.eraseLand(activeParcel.parcelId, {
        reason: 'Erased via Land Management dashboard'
      });
      setEraseConfirmInput('');
      await loadWorkspace();
      onWorkspaceChanged?.();
      setNotice(
        `Erased "${activeLandLabel}" (${res.erasedSculptureCount} item(s) removed).`
      );
    } catch (err) {
      setErrorMsg(err.message || 'Could not erase land');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card wide land-mgmt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Land Management"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <XeroIcon emoji="🗺️" size={21} />
            <span>Land Management</span>
            <InfoTip title="How Land Management Works">
              Manage your minted Virtual Land parcels in one place: edit land name &amp; description,
              share visit links, freeze placements, add verified IRL contributors, upload or curate
              3D artworks, and configure unlock security.
            </InfoTip>
          </h2>
          <button type="button" className="btn" onClick={onClose} aria-label="Close land management">
            <XeroIcon emoji="✕" size={15} />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
            <XeroIcon emoji="⏳" size={18} /> Loading your lands…
          </div>
        ) : !workspace?.parcels?.length ? (
          <div className="card" style={{ padding: 16, textAlign: 'center', fontSize: 13 }}>
            No minted land parcels yet. Draw and mint a 3D plot on the map to manage it here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Organized Parcel Selector with Quick Prev/Next for Multi-Land Owners */}
            <div className="land-mgmt-selector-bar" role="tablist" aria-label="Your owned lands">
              <div className="land-mgmt-selector-pills">
                {workspace.parcels.map((p) => {
                  const isActive = activeParcel?.parcelId === p.parcelId;
                  return (
                    <button
                      key={p.parcelId}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={`btn btn-sm land-mgmt-parcel-tab ${isActive ? 'btn-primary is-active' : ''}`}
                      onClick={() => selectParcel(p)}
                    >
                      <XeroIcon emoji={p.frozen || p.settings?.frozen ? '❄️' : '📍'} size={13} />{' '}
                      <span>{resolveLandDisplayName(p, { defaultName: 'Virtual Land' })}</span>
                      <span className="land-mgmt-tab-count">· {p.sculptureCount}</span>
                    </button>
                  );
                })}
              </div>
              {workspace.parcels.length > 1 && activeParcel && (
                <div className="land-mgmt-selector-nav">
                  <button
                    type="button"
                    className="btn btn-xs"
                    aria-label="Previous land"
                    onClick={() => {
                      const idx = workspace.parcels.findIndex(
                        (item) => item.parcelId === activeParcel.parcelId
                      );
                      const prevIdx = (idx - 1 + workspace.parcels.length) % workspace.parcels.length;
                      selectParcel(workspace.parcels[prevIdx]);
                    }}
                  >
                    ‹
                  </button>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {workspace.parcels.findIndex((item) => item.parcelId === activeParcel.parcelId) + 1}
                    /{workspace.parcels.length}
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs"
                    aria-label="Next land"
                    onClick={() => {
                      const idx = workspace.parcels.findIndex(
                        (item) => item.parcelId === activeParcel.parcelId
                      );
                      const nextIdx = (idx + 1) % workspace.parcels.length;
                      selectParcel(workspace.parcels[nextIdx]);
                    }}
                  >
                    ›
                  </button>
                </div>
              )}
            </div>

            {notice && (
              <div className="status-banner" role="status">
                {notice}
              </div>
            )}
            {errorMsg && (
              <div className="status-banner status-banner-error" role="alert">
                {errorMsg}
              </div>
            )}

            {activeParcel && (
              <>
                {/* 0) Perfectly Fit Isometric Geographic Map Preview */}
                <LandIsometricPreview
                  parcel={activeParcel}
                  displayNameOverride={customName}
                  frozenOverride={frozen}
                  allParcels={workspace.parcels}
                  userLocation={userLocation}
                  onSelectParcel={(p) => selectParcel(p)}
                  onSelectSculpture={
                    onSelectSculpture
                      ? (sc) => {
                          onClose?.();
                          onSelectSculpture(sc);
                        }
                      : null
                  }
                  onFocusParcel={
                    onFocusParcel
                      ? (p, vol) => {
                          onClose?.();
                          onFocusParcel(p, vol);
                        }
                      : null
                  }
                />

                {/* 1) Land Details, Permissions & Security */}
                <form
                  onSubmit={handleSaveCurationAndSettings}
                  className="card land-mgmt-section"
                >
                  <div className="land-mgmt-section-head">
                    <div className="land-mgmt-heading">
                      <strong>
                        {resolveLandDisplayName(
                          { ...activeParcel, customName: customName || activeParcel.customName },
                          { defaultName: 'Land Details' }
                        )}
                      </strong>
                      <InfoTip title="Land Name, Description & MCP">
                        Set a public name and description for this parcel (type <code>:</code> like{' '}
                        <code>:fire:</code> to insert emojis). Your name also creates a friendly
                        share slug URL for mobile visitors.
                      </InfoTip>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-xs"
                        aria-label={`Copy share link for ${resolveLandDisplayName(
                          { ...activeParcel, customName: customName || activeParcel.customName },
                          { defaultName: 'Virtual Land' }
                        )}`}
                        onClick={async () => {
                          const shareUrl = buildParcelShareUrl({
                            origin: window.location.origin,
                            pathname: window.location.pathname,
                            parcelId: activeParcel.parcelId,
                            customName: customName || activeParcel.customName || '',
                            compact: true
                          });
                          const ok = await copyToClipboard(shareUrl);
                          setNotice(ok ? `Copied share link: ${shareUrl}` : shareUrl);
                        }}
                      >
                        🔗 Share
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        disabled={busy !== ''}
                        onClick={handleCopyMcpPrompt}
                      >
                        <XeroIcon emoji="📋" size={12} />{' '}
                        {promptCopied ? 'Copied!' : 'MCP Prompt'}
                      </button>
                    </div>
                  </div>

                  <div className="land-mgmt-fields">
                    <label className="land-name-field">
                      <span>Land Name</span>
                      <EmojiInput
                        className="input"
                        aria-label="Land Name"
                        maxLength={48}
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                        placeholder="e.g. Neon Courtyard (type : for emojis)"
                      />
                    </label>
                    <label className="land-name-field">
                      <span>Land Description</span>
                      <EmojiTextarea
                        className="textarea"
                        aria-label="Land Description"
                        rows={2}
                        maxLength={240}
                        value={curationNote}
                        onChange={(e) => setCurationNote(e.target.value)}
                        placeholder="Short description for visitors & agents (type : for emojis)"
                      />
                    </label>
                  </div>

                  {/* Concise Permission Checkboxes with Clickable "i" Context */}
                  <div className="land-mgmt-toggle-grid">
                    <div className="land-mgmt-toggle-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={allowContributorEdits}
                          onChange={(e) => setAllowContributorEdits(e.target.checked)}
                        />
                        <span>Contributor Edits</span>
                      </label>
                      <InfoTip title="Contributor Edits">
                        Allows verified IRL chat visitors you add in the Contributors section below
                        to edit and refine artworks on this land.
                      </InfoTip>
                    </div>

                    <div className="land-mgmt-toggle-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={frozen}
                          onChange={(e) => setFrozen(e.target.checked)}
                        />
                        <span>❄️ Freeze Land</span>
                      </label>
                      <InfoTip title="Freeze Land">
                        Blocks all new sculptures and 3D models from being placed on{' '}
                        <strong>
                          {resolveLandDisplayName(
                            { ...activeParcel, customName: customName || activeParcel.customName },
                            { defaultName: 'this land' }
                          )}
                        </strong>
                        . Mobile visitors can still view existing art in AR.
                      </InfoTip>
                    </div>

                    <div className="land-mgmt-toggle-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={allowAgentErase}
                          onChange={(e) => setAllowAgentErase(e.target.checked)}
                        />
                        <span>Agent Erase</span>
                      </label>
                      <InfoTip title="Agent Erase Permission" align="right">
                        Allows your paired MCP agent (with your EIP-191 signature or mobile
                        approval) to run <code>erase_land</code> on this parcel.
                      </InfoTip>
                    </div>
                  </div>

                  {/* Compact Pin-Unlock & ORB Security Sub-Panel */}
                  <div className="land-mgmt-security-box">
                    <div className="land-mgmt-section-head">
                      <div className="land-mgmt-heading">
                        <XeroIcon emoji="🔐" size={13} />
                        <strong style={{ fontSize: 12, color: 'var(--accent)' }}>
                          Unlock Security
                        </strong>
                        <InfoTip title="Pin-Unlock & Visual ORB Security">
                          Protect encrypted pinned notes on this parcel by requiring a hardware
                          WebAuthn Passkey (FaceID / biometrics) and/or a live camera ORB visual
                          landmark match on-site.
                        </InfoTip>
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className={`badge ${activeParcel.landmarkAnchor?.hasLandmark ? 'teal' : ''}`} style={{ fontSize: 10 }}>
                          {activeParcel.landmarkAnchor?.hasLandmark
                            ? `ORB: ${activeParcel.landmarkAnchor.featureCount} pts`
                            : 'No ORB Pack'}
                        </span>
                        {isWebAuthnSupported() && (
                          <button
                            type="button"
                            className="btn btn-xs"
                            disabled={busy !== ''}
                            onClick={handleRegisterPasskey}
                          >
                            <XeroIcon emoji="🛡️" size={11} />{' '}
                            {passkeys.length > 0 ? `Passkeys (${passkeys.length})` : '+ Passkey'}
                          </button>
                        )}
                      </div>
                    </div>

                    {passkeys.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {passkeys.map((pk) => (
                          <span
                            key={pk.id}
                            className="badge"
                            style={{ fontSize: 10.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                          >
                            <XeroIcon emoji="🛡️" size={10} />
                            <span>{pk.deviceLabel || pk.id.slice(0, 8)}</span>
                            <button
                              type="button"
                              aria-label={`Delete passkey ${pk.deviceLabel || pk.id}`}
                              disabled={busy !== ''}
                              onClick={() => handleDeletePasskey(pk.id)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#ffb3c1',
                                cursor: 'pointer',
                                padding: 0,
                                fontWeight: 700
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="land-mgmt-toggle-grid">
                      <div className="land-mgmt-toggle-item">
                        <label>
                          <input
                            type="checkbox"
                            checked={requirePasskeyUnlock}
                            onChange={(e) => setRequirePasskeyUnlock(e.target.checked)}
                          />
                          <span>Passkey Unlock</span>
                        </label>
                        <InfoTip title="Hardware Passkey Unlock">
                          Requires a registered WebAuthn Passkey (FaceID, TouchID, or security key)
                          before unlocking encrypted pinned notes here.
                        </InfoTip>
                      </div>

                      <div className="land-mgmt-toggle-item">
                        <label>
                          <input
                            type="checkbox"
                            checked={requireOrbUnlock}
                            onChange={(e) => setRequireOrbUnlock(e.target.checked)}
                          />
                          <span>ORB Visual Match</span>
                        </label>
                        <input
                          type="number"
                          aria-label="Minimum ORB inliers"
                          min={4}
                          max={64}
                          value={minOrbInliers}
                          onChange={(e) => setMinOrbInliers(Number(e.target.value || 8))}
                          className="land-mgmt-inliers-input"
                          title="Minimum ORB visual match inliers"
                        />
                        <InfoTip title="ORB Visual Landmark Match" align="right">
                          Requires on-site camera visual pose matching against this parcel&apos;s
                          ORB landmark pack (higher min inliers = stricter physical match).
                        </InfoTip>
                      </div>
                    </div>
                  </div>

                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== ''}>
                    <XeroIcon emoji="✅" size={13} /> Save Land Settings
                  </button>
                </form>

                {/* 2) Contributors */}
                <div className="card land-mgmt-section">
                  <div className="land-mgmt-section-head">
                    <div className="land-mgmt-heading">
                      <XeroIcon emoji="🤝" size={14} />
                      <strong>
                        Contributors ({activeParcel.contributors?.length || 0})
                      </strong>
                      <InfoTip title="How Contributors Work">
                        Only accounts that physically visited this parcel and joined its AR chat can
                        be added as Contributors to modify artworks here. Enter a visitor&apos;s
                        email or 0x wallet, or click + Add next to eligible IRL visitors.
                      </InfoTip>
                    </div>
                  </div>

                  {activeParcel.eligibleVisitors?.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {activeParcel.eligibleVisitors.map((vis) => {
                        const alreadyAdded = activeParcel.contributors?.some(
                          (c) => c.contributorSub === vis.userId
                        );
                        return (
                          <div key={vis.userId} className="land-mgmt-row">
                            <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <UserHandleBadge
                                user={{
                                  id: vis.userId,
                                  username: vis.username,
                                  avatarImage: vis.avatarImage,
                                  name: vis.name
                                }}
                                fallback="Visitor"
                                size="xs"
                              />
                              <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                                {vis.walletAddress ? vis.walletAddress.slice(0, 10) : ''}
                              </span>
                            </div>
                            {alreadyAdded ? (
                              <span className="badge teal" style={{ fontSize: 10 }}>Active</span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-xs btn-primary"
                                disabled={busy !== ''}
                                onClick={() => handleAddContributor({ contributorUserId: vis.userId })}
                              >
                                + Add
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      No eligible IRL visitors yet.
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      value={manualContribInput}
                      onChange={(e) => setManualContribInput(e.target.value)}
                      placeholder="Visitor email or 0x wallet…"
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy !== '' || !manualContribInput.trim()}
                      onClick={() => {
                        const val = manualContribInput.trim();
                        if (val.startsWith('0x') && val.length >= 40) {
                          handleAddContributor({ walletAddress: val });
                        } else {
                          handleAddContributor({ email: val });
                        }
                      }}
                    >
                      Add
                    </button>
                  </div>

                  {activeParcel.contributors?.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {activeParcel.contributors.map((c) => (
                        <div key={c.contributorSub} className="land-mgmt-row is-active">
                          <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <UserHandleBadge
                              user={{
                                id: c.contributorSub,
                                username: c.username,
                                avatarImage: c.avatarImage,
                                name: c.name
                              }}
                              fallback="Artist"
                              size="xs"
                            />
                            {c.walletAddress && (
                              <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                                {c.walletAddress.slice(0, 10)}…
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="btn btn-xs btn-danger"
                            disabled={busy !== ''}
                            onClick={() => handleRemoveContributor(c.contributorSub)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 3) 3D Items & Direct File Upload */}
                <div className="card land-mgmt-section">
                  <div className="land-mgmt-section-head">
                    <div className="land-mgmt-heading">
                      <XeroIcon emoji="🗿" size={14} />
                      <strong>3D Items ({activeParcel.sculptures?.length || 0})</strong>
                      <InfoTip title="3D Items, Uploads & Revisions">
                        Add 3D items by URL or AI prompt with <strong>+ Add 3D Item</strong>, upload
                        a local <code>.glb/.gltf/.obj/.stl/.ply</code> file (max 5 MB), hide or
                        restore visitor pieces, or roll back immutable IPFS revisions.
                      </InfoTip>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {onOpenAddLandItem && (
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          onClick={() => {
                            onClose?.();
                            onOpenAddLandItem(activeParcel);
                          }}
                        >
                          + Add 3D Item
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        aria-expanded={showLocalUpload}
                        onClick={() => setShowLocalUpload((v) => !v)}
                      >
                        📤 {showLocalUpload ? 'Hide Upload' : 'Upload File'}
                      </button>
                    </div>
                  </div>

                  {showLocalUpload && (
                    <form onSubmit={handleUpload3DModelSubmit} className="land-mgmt-upload-box">
                      <div className="land-mgmt-heading">
                        <strong style={{ fontSize: 12, color: 'var(--accent)' }}>
                          Local 3D File (.GLB / .GLTF / .OBJ / .STL / .PLY)
                        </strong>
                        <InfoTip title="Local 3D Upload Specs">
                          Uploads directly to IPFS (max 5 MB, up to 150,000 triangles and 8
                          textures; Draco &amp; Meshopt supported). Use dx/dy/dz/yaw to fine-tune
                          placement on your parcel.
                        </InfoTip>
                      </div>
                      <input
                        type="file"
                        accept=".glb,.gltf,.obj,.stl,.ply"
                        onChange={handleModelFileSelected}
                        style={{ fontSize: 11.5 }}
                      />
                      {uploadFileName && (
                        <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                          Loaded {uploadFileName} ({uploadFormat.toUpperCase()})
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <EmojiInput
                          className="input"
                          wrapperStyle={{ flex: '1 1 160px' }}
                          maxLength={48}
                          value={uploadTitle}
                          onChange={(e) => setUploadTitle(e.target.value)}
                          placeholder="Title (type : for emojis)"
                        />
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                          <span>Scale</span>
                          <input
                            type="number"
                            className="input"
                            style={{ width: 64 }}
                            min={0.1}
                            max={20}
                            step={0.1}
                            value={uploadScale}
                            onChange={(e) => setUploadScale(Number(e.target.value || 1))}
                          />
                        </label>
                      </div>
                      <EmojiInput
                        className="input"
                        maxLength={240}
                        value={uploadDesc}
                        onChange={(e) => setUploadDesc(e.target.value)}
                        placeholder="Short description (10–240 chars, type : for emojis)"
                      />
                      <div className="add-item-offset-row" style={{ marginTop: 0 }}>
                        <label>
                          <span>dx (m)</span>
                          <input
                            type="number"
                            step={0.1}
                            value={anchorOffset.dx}
                            onChange={(e) => setAnchorOffset((p) => ({ ...p, dx: Number(e.target.value || 0) }))}
                          />
                        </label>
                        <label>
                          <span>dy (m)</span>
                          <input
                            type="number"
                            step={0.1}
                            value={anchorOffset.dy}
                            onChange={(e) => setAnchorOffset((p) => ({ ...p, dy: Number(e.target.value || 0) }))}
                          />
                        </label>
                        <label>
                          <span>dz (m)</span>
                          <input
                            type="number"
                            step={0.1}
                            value={anchorOffset.dz}
                            onChange={(e) => setAnchorOffset((p) => ({ ...p, dz: Number(e.target.value || 0) }))}
                          />
                        </label>
                        <label>
                          <span>yaw (rad)</span>
                          <input
                            type="number"
                            step={0.1}
                            value={anchorOffset.yaw}
                            onChange={(e) => setAnchorOffset((p) => ({ ...p, yaw: Number(e.target.value || 0) }))}
                          />
                        </label>
                      </div>
                      <button
                        type="submit"
                        className="btn btn-sm btn-primary"
                        disabled={busy !== '' || !uploadBase64}
                      >
                        <XeroIcon emoji="📤" size={12} />{' '}
                        {busy === 'upload' ? 'Uploading…' : 'Place 3D Model on Land'}
                      </button>
                    </form>
                  )}

                  {(activeParcel.sculptures || []).length === 0 ? (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      No 3D items on this land yet.
                    </div>
                  ) : (
                    (activeParcel.sculptures || []).map((sc) => {
                      const revOpen = Boolean(expandedRevIds[sc.id]);
                      return (
                        <div key={sc.id} className="land-mgmt-item-card">
                          <div className="land-mgmt-row" style={{ background: 'transparent', padding: 0 }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 12.5, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                {onSelectSculpture ? (
                                  <button
                                    type="button"
                                    className="artwork-title-link-btn"
                                    data-testid="land-mgmt-artwork-label"
                                    title={`View "${sc.title || 'Artwork'}" in 3D`}
                                    onClick={() => {
                                      onClose?.();
                                      onSelectSculpture(sc);
                                    }}
                                  >
                                    <span>{sc.title}</span>
                                    <span className="artwork-title-link-arrow" aria-hidden="true">↗</span>
                                  </button>
                                ) : (
                                  <span>{sc.title}</span>
                                )}
                                <span className="badge teal" style={{ fontSize: 10 }}>
                                  v{sc.currentRev || 1}
                                </span>
                                {sc.hidden && (
                                  <span className="badge badge-error" style={{ fontSize: 10 }}>
                                    Hidden
                                  </span>
                                )}
                              </div>
                              <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                <span>
                                  {sc.modelType === 'custom-3d'
                                    ? `.${String(sc.customModel?.format || 'glb').toUpperCase()}`
                                    : `${sc.voxelCount} blocks`}
                                </span>
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
                                {sc.meshStats?.triangleCount > 0
                                  ? ` · ${sc.meshStats.triangleCount.toLocaleString()} tris`
                                  : ''}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className={`btn btn-xs ${sc.hidden ? 'btn-primary' : ''}`}
                                disabled={busy !== ''}
                                onClick={async () => {
                                  setBusy(`vis-${sc.id}`);
                                  setErrorMsg('');
                                  setNotice('');
                                  try {
                                    await api.setSculptureVisibility(sc.id, {
                                      hidden: !sc.hidden,
                                      reason: sc.hidden ? '' : 'Hidden by Virtual Land owner'
                                    });
                                    await loadWorkspace();
                                    onWorkspaceChanged?.();
                                    setNotice(
                                      sc.hidden
                                        ? `Restored "${sc.title}".`
                                        : `Hidden "${sc.title}" from public view.`
                                    );
                                  } catch (err) {
                                    setErrorMsg(err.message || 'Could not update visibility');
                                  } finally {
                                    setBusy('');
                                  }
                                }}
                              >
                                {sc.hidden ? '👁️ Unhide' : '🙈 Hide'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() =>
                                  setExpandedRevIds((prev) => ({ ...prev, [sc.id]: !prev[sc.id] }))
                                }
                              >
                                📜 {revOpen ? 'Hide' : 'History'}
                              </button>
                              {onSelectSculpture && (
                                <button
                                  type="button"
                                  className="btn btn-xs"
                                  onClick={() => {
                                    onClose?.();
                                    onSelectSculpture(sc);
                                  }}
                                >
                                  ✏️ Edit
                                </button>
                              )}
                            </div>
                          </div>
                          {revOpen && (
                            <SculptureRevisionsPanel
                              sculptureId={sc.id}
                              currentRev={sc.currentRev || 1}
                              lastErc4906TxHash={sc.lastErc4906TxHash || ''}
                              canRollback
                              onRolledBack={async (res) => {
                                await loadWorkspace();
                                onWorkspaceChanged?.();
                                setNotice(
                                  `Rolled back ${sc.title} to v${res?.restoredFromRev} (now v${res?.revNum}).`
                                );
                              }}
                            />
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* 4) Compact Erase Land Zone */}
                <div
                  className="card land-mgmt-section"
                  style={{ borderColor: 'rgba(255, 94, 126, 0.38)' }}
                >
                  <div className="land-mgmt-heading">
                    <XeroIcon emoji="🗑️" size={14} />
                    <strong style={{ fontSize: 12.5, color: 'var(--danger, #ff5e7e)' }}>
                      Erase Land
                    </strong>
                    <InfoTip title="Erase Virtual Land">
                      Removes your active sculptures, custom 3D models, curations, and contributor
                      access on{' '}
                      <strong>
                        {resolveLandDisplayName(
                          { ...activeParcel, customName: customName || activeParcel.customName },
                          { defaultName: 'this land' }
                        )}
                      </strong>{' '}
                      from public feeds. Type the land name or ERASE below to confirm.
                    </InfoTip>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      value={eraseConfirmInput}
                      onChange={(e) => setEraseConfirmInput(e.target.value)}
                      placeholder={`Type "${resolveLandDisplayName(
                        { ...activeParcel, customName: customName || activeParcel.customName },
                        { defaultName: 'ERASE' }
                      )}" to confirm`}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy !== ''}
                      onClick={handleEraseLand}
                    >
                      Erase Land
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
