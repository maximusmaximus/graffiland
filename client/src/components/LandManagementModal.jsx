import React, { useCallback, useEffect, useState } from 'react';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
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
  const [manualContribInput, setManualContribInput] = useState('');
  const [eraseConfirmInput, setEraseConfirmInput] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await api.getMyLands();
      setWorkspace(res);
      const list = res?.parcels || [];
      if (list.length > 0) {
        const picked =
          list.find((p) => p.parcelId === (selectedParcelId || initialParcelId)) || list[0];
        setSelectedParcelId(picked.parcelId);
        setCustomName(picked.customName || '');
        setCurationNote(picked.curationNote || '');
        setAllowAgentErase(picked.settings?.allowAgentErase !== false);
        setAllowContributorEdits(picked.settings?.allowContributorEdits !== false);
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
    setEraseConfirmInput('');
    setNotice('');
    setErrorMsg('');
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
      await loadWorkspace();
      onWorkspaceChanged?.();
      setNotice(`Saved settings & permissions for ${activeParcel.parcelId}.`);
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

                  <button type="submit" className="btn btn-primary" disabled={busy !== ''}>
                    <XeroIcon emoji="✅" size={14} /> Save Land Settings
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
                    Your paired MCP agent can also load any <code>.glb</code>, <code>.gltf</code>,{' '}
                    <code>.obj</code>, <code>.stl</code>, or <code>.ply</code> non-voxel 3D model here via{' '}
                    <code>load_3d_model_on_land</code>.
                  </div>
                  {(activeParcel.sculptures || []).map((sc) => (
                    <div
                      key={sc.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 10px',
                        borderRadius: 8,
                        background: 'rgba(255,255,255,0.04)'
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{sc.title}</div>
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                          {sc.modelType === 'custom-3d'
                            ? `3D File (${String(sc.customModel?.format || 'glb').toUpperCase()})`
                            : `${sc.voxelCount} blocks`}{' '}
                          · {sc.id.slice(0, 8)}...
                        </div>
                      </div>
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
                  ))}
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
