import React, { useState } from 'react';
import XeroIcon from '../XeroIcon.jsx';
import MobilePairApprovalDropdown from './MobilePairApprovalDropdown.jsx';

export default function StudioHudTopBar({
  user,
  mode,
  dockOpen,
  location,
  pairedCode,
  videoRef = null,
  pairCodeInput = '',
  setPairCodeInput,
  pairError = '',
  onConnectPairCode,
  onDisconnectDesktopPair,
  mcpPairingsState = { mcpActive: false, activePairing: null, pairings: [] },
  mcpPairBusy = false,
  mcpPairNotice = '',
  setMcpPairNotice,
  onCreateMcpPairing,
  onDisconnectMcpPairing,
  onOpenAgentHandoff,
  onOpenLogin,
  voxels,
  quickSculpt,
  onToggleQuickSculpt,
  onOpenTutorial,
  onOpenInfo,
  hasOwnedLand,
  ownedLandCount,
  onOpenLandManage,
  editingSculpture,
  savingCanvasEdit,
  onSaveCanvasModification,
  onCancelCanvasModification,
  surfaceAnchor,
  onToggleSurfaceLock,
  brushUsable,
  brushUnavailableReason,
  onSeedVoxelAtAnchor,
  onClearSurfaceAnchor,
  onSelectSurfaceCenter,
  needsGyroTap,
  gyroFallbackActive,
  cameraReady,
  onEnableIosGyro,
  onRetryCameraAccess,
  sensorBanner,
  arTargetedSculpture,
  arPinPreview,
  passkeyBusy,
  onEnrollPasskeyAndRetryPin,
  onOpenCameraSelectedChat,
  arSelectHint,
  originStatus,
  sceneScan,
  onOpenLoginFromHint,
  pendingSignatures = [],
  signatureHistory = [],
  pendingSigBusyId = '',
  onMobileSignPending,
  onMobileRejectPending,
  onRefreshSignatures,
  mapOpen,
  nearbyCount,
  onOpenAreaMap,
  activeQuest = null,
  selectedPlinthSlot = null,
  onSnapToPlinthSlot = null
}) {
  const [pairHubOpen, setPairHubOpen] = useState(false);
  const [pairHubTab, setPairHubTab] = useState('pair');

  const pendingCount = pendingSignatures.length;
  const isPaired = Boolean(pairedCode || mcpPairingsState?.mcpActive);

  const togglePairHub = (preferredTab = '') => {
    if (pairHubOpen && (!preferredTab || preferredTab === pairHubTab)) {
      setPairHubOpen(false);
      return;
    }
    const nextTab = preferredTab || (pendingCount > 0 ? 'pending' : 'pair');
    setPairHubTab(nextTab);
    setPairHubOpen(true);
  };

  return (
    <>
      <div className="mobile-top-hud-right hud-interactive">
        <div className="mobile-top-hud-row">
          <button
            type="button"
            data-pair-hub-trigger="1"
            data-testid="mobile-pair-hub-btn"
            className={`top-mini-pill pair-hub-pill ${pairHubOpen ? 'active' : ''} ${
              isPaired ? 'is-paired' : ''
            } ${pendingCount > 0 ? 'has-pending' : ''}`}
            onClick={() => togglePairHub()}
            aria-label={
              pendingCount > 0
                ? `Pairing and Approvals (${pendingCount} pending)`
                : 'Pairing and Approvals'
            }
            aria-expanded={pairHubOpen}
            aria-haspopup="dialog"
            title="Pair Desktop QR, copy Agent Connector, and approve pending agent requests"
          >
            <XeroIcon emoji="🔗" size={13} />
            <span>{isPaired ? 'Paired' : 'Pair'}</span>
            {isPaired && <span className="pair-live-dot" aria-hidden="true" />}
            {pendingCount > 0 && (
              <span
                className="pair-notify-badge"
                data-testid="mobile-pending-pill"
                aria-label={`${pendingCount} pending approvals`}
              >
                {pendingCount}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`top-mini-pill ${quickSculpt ? 'active' : ''}`}
            onClick={onToggleQuickSculpt}
            title={
              quickSculpt
                ? 'Quick Sculpt active (simplified HUD) — tap for Pro Mode'
                : 'Pro HUD active — tap for simplified Quick Sculpt Mode'
            }
          >
            <XeroIcon emoji="⚡" size={13} />
            <span>{quickSculpt ? 'Quick' : 'Pro'}</span>
          </button>

          <button
            type="button"
            className="info-fab-inline"
            onClick={onOpenInfo}
            aria-label="Info and Terms"
            title="Info & Terms"
          >
            <XeroIcon emoji="ℹ️" size={19} label="Info" />
          </button>
        </div>

        <div className="mobile-top-hud-subrow">
          {pendingCount > 0 && !pairHubOpen && (
            <button
              type="button"
              data-pair-hub-trigger="1"
              data-testid="mobile-pending-alert-pill"
              className="pending-alert-pill"
              onClick={() => togglePairHub('pending')}
              aria-label={`Review ${pendingCount} pending approval${pendingCount === 1 ? '' : 's'}`}
            >
              <XeroIcon emoji="🔔" size={12} />
              <span>
                {pendingCount} pending approval{pendingCount === 1 ? '' : 's'}
              </span>
              <span aria-hidden="true">▾</span>
            </button>
          )}

          {hasOwnedLand && (
            <button
              type="button"
              className="land-manage-pill"
              onClick={onOpenLandManage}
              aria-label="Land Management"
              title="Land Management (Contributors, 3D Models & Agent Controls)"
            >
              <XeroIcon emoji="🗺️" size={14} label="Land" />
              <span>Land ({ownedLandCount})</span>
            </button>
          )}

          <button
            type="button"
            className="top-mini-pill"
            onClick={onOpenTutorial}
            aria-label="Open Tutorial Guide"
            title="Quick Start Tutorial"
          >
            <XeroIcon emoji="❓" size={13} />
          </button>
        </div>

        <MobilePairApprovalDropdown
          open={pairHubOpen}
          activeTab={pairHubTab}
          onSelectTab={setPairHubTab}
          onClose={() => setPairHubOpen(false)}
          user={user}
          onOpenLogin={onOpenLogin || onOpenLoginFromHint}
          videoRef={videoRef}
          pairCodeInput={pairCodeInput}
          setPairCodeInput={setPairCodeInput}
          pairedCode={pairedCode}
          pairError={pairError}
          onConnectPairCode={onConnectPairCode}
          onDisconnectDesktopPair={onDisconnectDesktopPair}
          mcpPairingsState={mcpPairingsState}
          mcpPairBusy={mcpPairBusy}
          mcpPairNotice={mcpPairNotice}
          setMcpPairNotice={setMcpPairNotice}
          onCreateMcpPairing={onCreateMcpPairing}
          onDisconnectMcpPairing={onDisconnectMcpPairing}
          onOpenAgentHandoff={onOpenAgentHandoff}
          pendingSignatures={pendingSignatures}
          signatureHistory={signatureHistory}
          pendingSigBusyId={pendingSigBusyId}
          onMobileSignPending={onMobileSignPending}
          onMobileRejectPending={onMobileRejectPending}
          onRefreshSignatures={onRefreshSignatures}
        />
      </div>

      {editingSculpture && (
        <div
          className="mobile-hud-banner hud-interactive under-pol"
          style={{
            borderColor: 'rgba(0, 245, 212, 0.72)',
            background: 'rgba(10, 26, 30, 0.92)',
            zIndex: 28
          }}
        >
          <span className="mobile-hud-banner-text">
            <XeroIcon emoji="🖌️" size={14} />
            <span>
              Editing {editingSculpture.title} ({voxels.length} blocks)
            </span>
          </span>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '4px 10px', fontSize: 11 }}
              disabled={savingCanvasEdit}
              onClick={onSaveCanvasModification}
            >
              {savingCanvasEdit ? 'Saving...' : 'Save Edit'}
            </button>
            <button
              type="button"
              className="btn"
              style={{ padding: '4px 8px', fontSize: 11 }}
              onClick={onCancelCanvasModification}
            >
              Cancel
            </button>
          </span>
        </div>
      )}

      {dockOpen && (
        <div className="pol-pill">
          <XeroIcon emoji={location ? '📍' : '⏳'} size={14} />
          <span>
            {location
              ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
              : 'Acquiring GPS'}
          </span>
          {location?.altitude != null && (
            <>
              <span>|</span>
              <XeroIcon emoji="⛰️" size={14} />
              <span>{Math.round(location.altitude)}m</span>
            </>
          )}
          <span>|</span>
          <XeroIcon emoji="🧱" size={14} />
          <span>{voxels.length}</span>
          {pairedCode && (
            <>
              <span>|</span>
              <XeroIcon emoji="🔗" size={14} />
              <span>{pairedCode}</span>
            </>
          )}
        </div>
      )}

      {mode === 'draw' && !quickSculpt && (
        <div className={`surface-pill hud-interactive ${dockOpen ? 'under-pol' : ''}`}>
          {surfaceAnchor ? (
            <>
              <XeroIcon emoji="📌" size={13} />
              <span className="surface-pill-label">
                {surfaceAnchor.label} · {surfaceAnchor.depthM.toFixed(1)}m
              </span>
              <button
                type="button"
                className={`surface-pill-btn ${surfaceAnchor.locked ? 'active' : ''}`}
                onClick={onToggleSurfaceLock}
                title="Toggle start surface plane lock vs Free 3D air drawing"
              >
                <XeroIcon emoji={surfaceAnchor.locked ? '🔒' : '🌐'} size={12} />
                <span>{surfaceAnchor.locked ? 'Locked' : 'Free 3D'}</span>
              </button>
              <button
                type="button"
                className={`surface-pill-btn ${!brushUsable ? 'is-unavailable' : ''}`}
                aria-disabled={!brushUsable || undefined}
                onClick={onSeedVoxelAtAnchor}
                title={
                  brushUsable
                    ? 'Place first block flush on the selected surface'
                    : brushUnavailableReason
                }
              >
                + Seed
              </button>
              <button
                type="button"
                className="surface-pill-btn clear"
                onClick={onClearSurfaceAnchor}
                aria-label="Clear start surface"
                title="Clear start surface"
              >
                <XeroIcon emoji="✖️" size={11} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="surface-pill-prompt"
              onClick={onSelectSurfaceCenter}
            >
              <XeroIcon emoji="👆" size={13} />
              <span>Tap scene to set start surface</span>
            </button>
          )}
        </div>
      )}

      {mode === 'draw' && activeQuest && !quickSculpt && (
        <div
          className="surface-pill hud-interactive"
          style={{
            top: 98,
            borderColor: activeQuest.firstSparkBoost
              ? 'rgba(255, 107, 53, 0.7)'
              : 'rgba(0, 245, 212, 0.5)'
          }}
        >
          <span className="surface-pill-label" style={{ maxWidth: 190 }}>
            {activeQuest.firstSparkBoost ? '🔥 First-Spark (2x XP)' : '🎨 Quest'}: {activeQuest.title}
          </span>
          {(activeQuest.slotOffsets || []).find((s) => !s.claimedBySculptureId) && onSnapToPlinthSlot && (
            <button
              type="button"
              className={`surface-pill-btn ${selectedPlinthSlot ? 'active' : ''}`}
              onClick={() =>
                onSnapToPlinthSlot(
                  (activeQuest.slotOffsets || []).find((s) => !s.claimedBySculptureId)
                )
              }
            >
              {selectedPlinthSlot ? '✅ Snapped' : '🪑 Snap to Plinth'}
            </button>
          )}
        </div>
      )}

      {needsGyroTap && (
        <button
          className="btn btn-primary"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 40
          }}
          onClick={onEnableIosGyro}
        >
          <XeroIcon emoji="🧭" size={18} /> Enable Gyroscope 3D Brush
        </button>
      )}

      {!needsGyroTap && (gyroFallbackActive || !cameraReady) && !arSelectHint && (
        <div
          className={`mobile-hud-banner hud-interactive ${mode === 'draw' ? 'under-pol' : ''}`}
          style={{
            background: 'rgba(13, 18, 30, 0.88)',
            borderColor: 'rgba(255, 209, 102, 0.45)',
            zIndex: 24
          }}
        >
          <span className="mobile-hud-banner-text">
            <XeroIcon emoji={!cameraReady ? '📷' : '👆'} size={14} />
            <span>
              {!cameraReady
                ? 'Camera off/blocked — allow rear camera for AR & Proof of Location.'
                : 'Manual Touch-Drag Aim active (no gyro detected — drag screen to aim).'}
            </span>
          </span>
          {!cameraReady && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '4px 9px', fontSize: 11 }}
              onClick={onRetryCameraAccess}
            >
              Retry Camera
            </button>
          )}
        </div>
      )}

      {sensorBanner && dockOpen && (
        <div
          className={`mobile-hud-banner hud-interactive is-error ${mode === 'draw' ? 'under-pol' : ''}`}
          role="status"
          aria-live="polite"
          style={{ zIndex: 26 }}
        >
          <span className="mobile-hud-banner-text">
            <XeroIcon emoji="⚠️" size={14} />
            <span>{sensorBanner}</span>
          </span>
        </div>
      )}

      {mode === 'preview' && arTargetedSculpture && (() => {
        const targetSc = arTargetedSculpture.sculpture;
        const activePin = arPinPreview?.sculptureId === targetSc.id ? arPinPreview : null;
        return (
          <div
            className="ar-select-card hud-interactive"
            role="region"
            aria-label={`Selected sculpture ${targetSc.title}`}
            onClick={() =>
              onOpenCameraSelectedChat(targetSc, arTargetedSculpture.distanceM, activePin)
            }
          >
            <div className="ar-select-card-head">
              <div style={{ minWidth: 0 }}>
                <div className="ar-select-title">{targetSc.title}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                  {Math.round(arTargetedSculpture.distanceM)}m away · {targetSc.parcelId}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: 12, padding: '6px 10px', flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenCameraSelectedChat(targetSc, arTargetedSculpture.distanceM, activePin);
                }}
              >
                <XeroIcon emoji="💬" size={14} /> Open Chatbox
              </button>
            </div>

            {targetSc.description && (
              <div className="ar-select-desc">{targetSc.description}</div>
            )}

            {activePin?.status === 'loading' && (
              <div className="ar-select-pin locked">
                <XeroIcon emoji="⏳" size={12} /> Unlocking parcel-pinned IPFS messages...
              </div>
            )}

            {activePin?.status === 'unlocked' && activePin.pins.length > 0 && (
              <div className="ar-select-pin unlocked">
                <div style={{ fontWeight: 700, fontSize: 11, color: 'var(--accent-gold)', marginBottom: 2 }}>
                  <XeroIcon emoji="📌" size={12} /> Pinned IPFS Message ({activePin.pins.length})
                </div>
                {activePin.pins.slice(0, 2).map((p) => (
                  <div key={p.id} style={{ fontSize: 12, lineHeight: 1.35 }}>
                    &ldquo;{p.text}&rdquo;
                  </div>
                ))}
                {activePin.meta?.ipfsCid && (
                  <div className="mono" style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 2 }}>
                    ipfs://{activePin.meta.ipfsCid.slice(0, 14)}... · v{activePin.batchSeq}
                  </div>
                )}
              </div>
            )}

            {activePin?.status === 'locked' && (
              <div className="ar-select-pin locked">
                <div>
                  <XeroIcon emoji="🔒" size={12} /> {activePin.error}
                </div>
                {activePin.needsPasskey && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ marginTop: 6, padding: '4px 9px', fontSize: 11 }}
                    disabled={passkeyBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEnrollPasskeyAndRetryPin?.();
                    }}
                  >
                    <XeroIcon emoji="🛡️" size={12} />{' '}
                    {passkeyBusy ? 'Enrolling...' : 'Enroll Passkey & Retry Unlock'}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {arSelectHint && (
        <div
          className={`mobile-hud-banner hud-interactive ${dockOpen && mode === 'draw' ? 'under-pol' : ''} ${
            originStatus.originBlocked
              ? 'is-error'
              : sceneScan.optimal && arSelectHint.includes('Mapping complete')
              ? 'is-success'
              : ''
          }`}
          role="status"
          aria-live="polite"
        >
          <span className="mobile-hud-banner-text">
            <XeroIcon
              emoji={originStatus.originBlocked ? '⚠️' : sceneScan.optimal ? '✅' : '🔒'}
              size={14}
            />
            <span>{arSelectHint}</span>
          </span>
          {!user && arSelectHint.includes('Sign in') && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={onOpenLoginFromHint}
            >
              Sign In
            </button>
          )}
        </div>
      )}

      {mode === 'draw' && originStatus.originBlocked && !arSelectHint && (
        <div
          className={`mobile-hud-banner origin-blocked-banner is-error ${dockOpen ? 'under-pol' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span className="mobile-hud-banner-text">
            <XeroIcon emoji="⚠️" size={14} />
            <span>{originStatus.reason || 'Origin is blocked — clear obstruction to paint'}</span>
          </span>
        </div>
      )}

      <button
        type="button"
        className={`floating-map-btn hud-interactive ${mapOpen ? 'active' : ''}`}
        onClick={onOpenAreaMap}
        aria-label="Open Public Area Map"
        title="Public Area Sculpture Map & Directions"
      >
        <XeroIcon emoji="🗺️" size={22} />
        {nearbyCount > 0 && <span className="floating-map-badge">{nearbyCount}</span>}
      </button>
    </>
  );
}
