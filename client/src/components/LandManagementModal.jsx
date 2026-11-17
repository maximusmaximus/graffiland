import React, { useCallback, useEffect, useState } from 'react';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import { isWebAuthnSupported, registerHardwarePasskey } from '../utils/passkeyClient.js';
import SculptureRevisionsPanel from './SculptureRevisionsPanel.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function LandManagementModal({
  user,
  initialParcelId = '',
  onSelectSculpture,
  onWorkspaceChanged,
  onClose
}) {
  const [workspace, setWorkspace] = useState(null);
  const [selectedParcelId, setSelectedParcelId] = useState(initialParcelId || '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [customName, setCustomName] = useState('');
  const [curationNote, setCurationNote] = useState('');
  const [allowAgentErase, setAllowAgentErase] = useState(true);
  const [allowContributorEdits, setAllowContributorEdits] = useState(true);
  const [requirePasskeyUnlock, setRequirePasskeyUnlock] = useState(false);
  const [requireOrbUnlock, setRequireOrbUnlock] = useState(false);
  const [minOrbInliers, setMinOrbInliers] = useState(8);
  const [passkeys, setPasskeys] = useState([]);
  const [expandedRevIds, setExpandedRevIds] = useState({});
  const [manualContribInput, setManualContribInput] = useState('');
  const [eraseConfirmInput, setEraseConfirmInput] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);

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
        const picked =
          list.find((p) => p.parcelId === (selectedParcelId || initialParcelId)) || list[0];
        setSelectedParcelId(picked.parcelId);
        setCustomName(picked.customName || '');
        setCurationNote(picked.curationNote || '');
        setAllowAgentErase(picked.settings?.allowAgentErase !== false);
        setAllowContributorEdits(picked.settings?.allowContributorEdits !== false);
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
  }, [initialParcelId, selectedParcelId]);

  useEffect(() => {
    if (user?.id) loadWorkspace();
  }, [user?.id, loadWorkspace]);

  const activeParcel =
    workspace?.parcels?.find((p) => p.parcelId === selectedParcelId) ||
    workspace?.parcels?.[0] ||
    null;

  function selectParcel(p) {
    setSelectedParcelId(p.parcelId);
    setCustomName(p.customName || '');
    setCurationNote(p.curationNote || '');
    setAllowAgentErase(p.settings?.allowAgentErase !== false);
    setAllowContributorEdits(p.settings?.allowContributorEdits !== false);
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
      setNotice(`Registered hardware ES256 Passkey (${out.passkey?.deviceLabel || 'Device'}).`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not register hardware Passkey');
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
      setNotice('Removed Passkey credential.');
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
      setErrorMsg('Unsupported 3D file type. Use .glb, .gltf, .obj, .stl, or .ply.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrorMsg('3D file exceeds 5 MB upload cap. Compress meshes or use Draco.');
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
    try {
      const res = await api.createSculptureOnLand(activeParcel.parcelId, {
        title: uploadTitle.trim() || uploadFileName || '3D Model Sculpture',
        description:
          uploadDesc.trim() ||
          `Custom ${uploadFormat.toUpperCase()} 3D model placed directly on Virtual Land ${activeParcel.parcelId}.`,
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
      await loadWorkspace();
      onWorkspaceChanged?.();
      setNotice(
        `Uploaded "${res?.sculpture?.title || '3D Model'}" (${uploadFormat.toUpperCase()}) onto ${activeParcel.parcelId}.`
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
        curationNote
      });
      await api.updateLandSettings(activeParcel.parcelId, {
        allowAgentErase,
        allowContributorEdits
      });
      await api.updateLandSecurityPolicy(activeParcel.parcelId, {
        requirePasskeyUnlock,
        requireOrbUnlock,
        minOrbInliers: Number(minOrbInliers || 8)
      });
      await loadWorkspace();
      onWorkspaceChanged?.();
      setNotice(`Saved settings, permissions & security policy for ${activeParcel.parcelId}.`);
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
        `Added ${res?.contributor?.name || res?.contributor?.email || 'visitor'} as Contributor on ${activeParcel.parcelId}.`
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
      setNotice(`Removed contributor from ${activeParcel.parcelId}.`);
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
      await navigator.clipboard?.writeText(promptText);
      setPromptCopied(true);
      setNotice(
        `Copied Property Agent MCP Prompt for ${activeParcel.parcelId} (Code: ${code}) — includes load_3d_model_on_land & erase_land.`
      );
    } catch (err) {
      setErrorMsg(err.message || 'Could not copy MCP prompt');
    } finally {
      setBusy('');
    }
  }

  async function handleEraseLand() {
    if (!activeParcel) return;
    if (eraseConfirmInput.trim().toUpperCase() !== activeParcel.parcelId) {
      setErrorMsg(`Type "${activeParcel.parcelId}" exactly to confirm erasing this land.`);
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
        `Erased ${res.parcelId} (${res.erasedSculptureCount} sculpture(s) removed from public land).`
      );
    } catch (err) {
      setErrorMsg(err.message || 'Could not erase land');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">
              <XeroIcon emoji="🗺️" size={22} /> Land Management
            </h2>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Manage owned Virtual Land parcels, IRL Contributor permissions, non-voxel MCP 3D models &amp; erasure rights
            </div>
          </div>
          <button type="button" className="btn" onClick={onClose} aria-label="Close land management">
            <XeroIcon emoji="❌" size={16} />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
            <XeroIcon emoji="⏳" size={18} /> Loading your Virtual Land parcels...
          </div>
        ) : !workspace?.parcels?.length ? (
          <div className="card" style={{ padding: 16, textAlign: 'center' }}>
            <p style={{ margin: '0 0 8px', fontSize: 13 }}>
              No active Virtual Land parcels found under your account yet.
            </p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
              Publish your first 3D sculpture on mobile to claim a parcel and unlock post-publish Land Management.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Parcel Selector */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {workspace.parcels.map((p) => (
                <button
                  key={p.parcelId}
                  type="button"
                  className={`btn ${activeParcel?.parcelId === p.parcelId ? 'btn-primary' : ''}`}
                  onClick={() => selectParcel(p)}
                >
                  <XeroIcon emoji="📍" size={14} />{' '}
                  {p.customName ? `${p.customName} (${p.parcelId})` : p.parcelId} ·{' '}
                  {p.sculptureCount} item{p.sculptureCount === 1 ? '' : 's'}
                </button>
              ))}
            </div>

            {activeParcel && (
              <>
                {/* Land Details & Agent Permissions */}
                <form
                  onSubmit={handleSaveCurationAndSettings}
                  className="card"
                  style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent)' }}>
                      Parcel Curations &amp; Permissions ({activeParcel.parcelId})
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ fontSize: 11, padding: '5px 10px' }}
                      disabled={busy !== ''}
                      onClick={handleCopyMcpPrompt}
                    >
                      <XeroIcon emoji="📋" size={13} />{' '}
                      {promptCopied ? 'Copied MCP Prompt!' : 'Copy Agent MCP Prompt (3D Models + Erase)'}
                    </button>
                  </div>

                  <input
                    className="input"
                    maxLength={48}
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Custom Virtual Land title (e.g. Neon Courtyard)"
                  />
                  <input
                    className="input"
                    maxLength={240}
                    value={curationNote}
                    onChange={(e) => setCurationNote(e.target.value)}
                    placeholder="Parcel description or visitor curation note"
                  />

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={allowContributorEdits}
                      onChange={(e) => setAllowContributorEdits(e.target.checked)}
                    />
                    <span>
                      Allow added <strong>Contributors</strong> (verified IRL visitors who chatted here) to modify sculptures on this land
                    </span>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={allowAgentErase}
                      onChange={(e) => setAllowAgentErase(e.target.checked)}
                    />
                    <span>
                      Allow paired <strong>MCP Agent</strong> (with your authorization signature) to erase this land (<code>erase_land</code>)
                    </span>
                  </label>

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: '9px 11px',
                      borderRadius: 10,
                      background: 'rgba(0, 245, 212, 0.05)',
                      border: '1px solid rgba(0, 245, 212, 0.22)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 12, color: 'var(--accent)' }}>
                        <XeroIcon emoji="🔐" size={13} /> Parcel Pin-Unlock &amp; Visual ORB Policy
                      </strong>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {activeParcel.landmarkAnchor ? (
                          <span className="badge teal" style={{ fontSize: 10.5 }}>
                            ORB Pack: {activeParcel.landmarkAnchor.featureCount} features
                          </span>
                        ) : (
                          <span className="badge" style={{ fontSize: 10.5 }}>No ORB Pack Yet</span>
                        )}
                        {isWebAuthnSupported() && (
                          <button
                            type="button"
                            className="btn"
                            style={{ fontSize: 10.5, padding: '3px 8px' }}
                            disabled={busy !== ''}
                            onClick={handleRegisterPasskey}
                          >
                            <XeroIcon emoji="🛡️" size={12} />{' '}
                            {passkeys.length > 0 ? `Passkey Ready (${passkeys.length})` : 'Register Device Passkey'}
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
                            style={{ fontSize: 10.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                          >
                            <XeroIcon emoji="🛡️" size={11} />
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
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={requirePasskeyUnlock}
                        onChange={(e) => setRequirePasskeyUnlock(e.target.checked)}
                      />
                      <span>Require Hardware <strong>WebAuthn Passkey</strong> (FaceID / Biometrics) on pinned unlocks</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={requireOrbUnlock}
                        onChange={(e) => setRequireOrbUnlock(e.target.checked)}
                      />
                      <span>
                        Require live <strong>ORB Visual Landmark</strong> pose match (min inliers:
                        <input
                          type="number"
                          min={4}
                          max={64}
                          value={minOrbInliers}
                          onChange={(e) => setMinOrbInliers(Number(e.target.value || 8))}
                          style={{ width: 52, marginLeft: 6, background: 'rgba(0,0,0,0.35)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: '2px 5px' }}
                        />
                        )
                      </span>
                    </label>
                  </div>

                  <button type="submit" className="btn btn-primary" disabled={busy !== ''}>
                    <XeroIcon emoji="✅" size={14} /> Save Land Settings &amp; Security Policy
                  </button>
                </form>

                {/* Contributor Accounts (Must have visited & chatted IRL on this parcel) */}
                <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent-gold)' }}>
                    <XeroIcon emoji="🤝" size={15} /> Contributor Accounts (IRL Chat Visitors Only)
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Only accounts that visited this parcel in real life and gained AR chat access / interacted on this land can be added as Contributors to modify sculptures.
                  </div>

                  {/* Quick-Add Eligible IRL Visitors */}
                  {activeParcel.eligibleVisitors?.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                        Eligible IRL Chat Visitors Here:
                      </div>
                      {activeParcel.eligibleVisitors.map((vis) => {
                        const alreadyAdded = activeParcel.contributors?.some(
                          (c) => c.contributorSub === vis.userId
                        );
                        return (
                          <div
                            key={vis.userId}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                              padding: '6px 9px',
                              borderRadius: 8,
                              background: 'rgba(255,255,255,0.04)'
                            }}
                          >
                            <div style={{ fontSize: 12 }}>
                              <strong>{vis.name}</strong>{' '}
                              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                                ({vis.email || vis.walletAddress.slice(0, 10)})
                              </span>
                            </div>
                            {alreadyAdded ? (
                              <span className="badge teal">Contributor Active</span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ fontSize: 11, padding: '4px 9px' }}
                                disabled={busy !== ''}
                                onClick={() => handleAddContributor({ contributorUserId: vis.userId })}
                              >
                                + Add Contributor
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      No non-owner IRL chat visitors recorded on this parcel yet. Once a visitor scans and enters this parcel&apos;s AR chat in real life, they appear here automatically.
                    </div>
                  )}

                  {/* Add by Email or Wallet (verified server-side for IRL visit) */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      value={manualContribInput}
                      onChange={(e) => setManualContribInput(e.target.value)}
                      placeholder="Add IRL visitor by email or 0x wallet address..."
                    />
                    <button
                      type="button"
                      className="btn"
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

                  {/* Active Contributors */}
                  {activeParcel.contributors?.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>
                        Active Contributors ({activeParcel.contributors.length}):
                      </div>
                      {activeParcel.contributors.map((c) => (
                        <div
                          key={c.contributorSub}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 9px',
                            borderRadius: 8,
                            border: '1px solid rgba(0, 245, 212, 0.25)'
                          }}
                        >
                          <div style={{ fontSize: 12 }}>
                            <strong>{c.name}</strong> ·{' '}
                            <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                              {c.email || c.walletAddress}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="btn btn-danger"
                            style={{ fontSize: 11, padding: '4px 8px' }}
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

                {/* Sculptures & Non-Voxel 3D Models on Land */}
                <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    Items on {activeParcel.parcelId} ({activeParcel.sculptures?.length || 0})
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    Upload a non-voxel 3D file (<code>.glb</code>, <code>.gltf</code>, <code>.obj</code>,{' '}
                    <code>.stl</code>, <code>.ply</code>, max 5 MB) directly or via paired MCP{' '}
                    <code>load_3d_model_on_land</code>.
                  </div>

                  <form
                    onSubmit={handleUpload3DModelSubmit}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: 10,
                      borderRadius: 8,
                      background: 'rgba(0, 245, 212, 0.05)',
                      border: '1px solid rgba(0, 245, 212, 0.22)'
                    }}
                  >
                    <strong style={{ fontSize: 12, color: 'var(--accent)' }}>
                      <XeroIcon emoji="🗿" size={13} /> Upload Custom 3D Model (.GLB/.OBJ/.STL/.PLY)
                    </strong>
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
                      <input
                        className="input"
                        style={{ flex: '1 1 160px' }}
                        maxLength={48}
                        value={uploadTitle}
                        onChange={(e) => setUploadTitle(e.target.value)}
                        placeholder="Sculpture title"
                      />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <span>Scale</span>
                        <input
                          type="number"
                          className="input"
                          style={{ width: 68 }}
                          min={0.1}
                          max={20}
                          step={0.1}
                          value={uploadScale}
                          onChange={(e) => setUploadScale(Number(e.target.value || 1))}
                        />
                      </label>
                    </div>
                    <input
                      className="input"
                      maxLength={240}
                      value={uploadDesc}
                      onChange={(e) => setUploadDesc(e.target.value)}
                      placeholder="Short Limited Terms description (10-240 chars)"
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, fontSize: 10.5 }}>
                      <label>
                        dx (m)
                        <input
                          type="number"
                          step={0.1}
                          className="input"
                          value={anchorOffset.dx}
                          onChange={(e) => setAnchorOffset((p) => ({ ...p, dx: Number(e.target.value || 0) }))}
                        />
                      </label>
                      <label>
                        dy (m)
                        <input
                          type="number"
                          step={0.1}
                          className="input"
                          value={anchorOffset.dy}
                          onChange={(e) => setAnchorOffset((p) => ({ ...p, dy: Number(e.target.value || 0) }))}
                        />
                      </label>
                      <label>
                        dz (m)
                        <input
                          type="number"
                          step={0.1}
                          className="input"
                          value={anchorOffset.dz}
                          onChange={(e) => setAnchorOffset((p) => ({ ...p, dz: Number(e.target.value || 0) }))}
                        />
                      </label>
                      <label>
                        yaw (rad)
                        <input
                          type="number"
                          step={0.1}
                          className="input"
                          value={anchorOffset.yaw}
                          onChange={(e) => setAnchorOffset((p) => ({ ...p, yaw: Number(e.target.value || 0) }))}
                        />
                      </label>
                    </div>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ fontSize: 11.5 }}
                      disabled={busy !== '' || !uploadBase64}
                    >
                      <XeroIcon emoji="📤" size={13} />{' '}
                      {busy === 'upload' ? 'Pinning to IPFS...' : 'Place 3D Model on Land'}
                    </button>
                  </form>
                  {(activeParcel.sculptures || []).map((sc) => {
                    const revOpen = Boolean(expandedRevIds[sc.id]);
                    return (
                      <div
                        key={sc.id}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          padding: '8px 10px',
                          borderRadius: 8,
                          background: 'rgba(255,255,255,0.04)'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                              {sc.title}{' '}
                              <span className="badge teal" style={{ fontSize: 10, marginLeft: 4 }}>
                                v{sc.currentRev || 1}
                              </span>
                            </div>
                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                              {sc.modelType === 'custom-3d'
                                ? `3D File (${String(sc.customModel?.format || 'glb').toUpperCase()})`
                                : `${sc.voxelCount} blocks`}{' '}
                              · {sc.id.slice(0, 8)}...
                              {sc.meshStats?.triangleCount > 0 ? ` · ${sc.meshStats.triangleCount.toLocaleString()} tris` : ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn"
                              style={{ fontSize: 11, padding: '4px 9px' }}
                              onClick={() =>
                                setExpandedRevIds((prev) => ({ ...prev, [sc.id]: !prev[sc.id] }))
                              }
                            >
                              <XeroIcon emoji="📜" size={12} /> {revOpen ? 'Hide History' : 'Revisions'}
                            </button>
                            {onSelectSculpture && (
                              <button
                                type="button"
                                className="btn"
                                style={{ fontSize: 11, padding: '4px 9px' }}
                                onClick={() => {
                                  onClose?.();
                                  onSelectSculpture(sc);
                                }}
                              >
                                <XeroIcon emoji="✏️" size={12} /> Inspect / Edit
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
                                `Rolled back ${sc.title} to v${res?.restoredFromRev} (now v${res?.revNum}) · ERC-4906 emitted.`
                              );
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Erase Land Section */}
                <div
                  className="card"
                  style={{
                    padding: 12,
                    borderColor: 'rgba(255, 94, 126, 0.4)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--danger, #ff5e7e)' }}>
                    <XeroIcon emoji="🗑️" size={14} /> Erase Existing Land ({activeParcel.parcelId})
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    Removes all active sculptures, curations, and contributor access on{' '}
                    <strong>{activeParcel.parcelId}</strong> from public feeds.
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="input"
                      value={eraseConfirmInput}
                      onChange={(e) => setEraseConfirmInput(e.target.value)}
                      placeholder={`Type ${activeParcel.parcelId} to confirm`}
                    />
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy !== ''}
                      onClick={handleEraseLand}
                    >
                      Erase Land
                    </button>
                  </div>
                </div>
              </>
            )}

            {notice && (
              <div className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
                {notice}
              </div>
            )}
            {errorMsg && (
              <div className="mono" style={{ fontSize: 12, color: 'var(--danger, #ff5e7e)' }}>
                {errorMsg}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
