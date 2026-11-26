import React, { useEffect, useState } from 'react';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import {
  formatDistance,
  formatShortLength,
  useMeasurementUnits
} from '../../utils/measurementUnits.js';
import { describeCameraNeededAction } from '../../utils/permissionMessages.js';
import NotificationCenter from '../NotificationCenter.jsx';
import InfoTip from '../InfoTip.jsx';
import UserHandleBadge from '../UserHandleBadge.jsx';
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
  repairNotice = null,
  onDismissRepairNotice = null,
  openPairHubSignal = null,
  onCreateMcpPairing,
  onDisconnectMcpPairing,
  onOpenAgentHandoff,
  onOpenLogin,
  voxels,
  onOpenTutorial,
  onOpenInfo,
  onOpenProfile = null,
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
  cameraRecovering = false,
  onEnableIosGyro,
  onRetryCameraAccess,
  onRetryLocation = null,
  onCameraRefreshNeeded = null,
  sensorBanner,
  onDismissSensorBanner = null,
  arTargetedSculpture,
  arPinPreview,
  passkeyBusy,
  onEnrollPasskeyAndRetryPin,
  onOpenCameraSelectedChat,
  arSelectHint,
  onDismissHint = null,
  originStatus,
  sceneScan,
  onOpenLoginFromHint,
  pendingSignatures = [],
  signatureHistory = [],
  pendingSigBusyId = '',
  pendingSigErrors = {},
  onMobileSignPending,
  onMobileRejectPending,
  onRefreshSignatures,
  mapOpen,
  nearbyCount,
  onOpenAreaMap,
  activeQuest = null,
  selectedPlinthSlot = null,
  onSnapToPlinthSlot = null,
  isInteractingWithLand = false,
  nearbyCameraLand = null,
  nearbyCameraLandCount = 0,
  nearbyOtherItemsCount = 0,
  fadeOtherItems = false,
  onToggleFadeOtherItems = null,
  sensorStatus = null,
  webxrSupported = false,
  webxrActive = false,
  onToggleWebxr = null,
  onInspectArLand = null,
  onExitArLand = null,
  arExitLabel = 'Back to Draw',
  notifRefreshSignal = 0,
  onNotificationAction = null,
  onApprovalResolved = null,
  onPreviewPending = null,
  onNavigateToLand = null
}) {
  const [pairHubOpen, setPairHubOpen] = useState(false);
  const [pairHubTab, setPairHubTab] = useState('pair');
  const { unitSystem } = useMeasurementUnits(location);

  useEffect(() => {
    if (!openPairHubSignal?.ts) return;
    setPairHubTab(openPairHubSignal.tab === 'pending' ? 'pending' : 'pair');
    setPairHubOpen(true);
  }, [openPairHubSignal]);

  const needsRepairAlert = Boolean(
    repairNotice || mcpPairingsState?.needsRepair || mcpPairingsState?.expiringSoon
  );

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

  const showRedSensorError = Boolean(
    !cameraRecovering &&
      sensorBanner &&
      (dockOpen || !cameraReady || !location || gyroFallbackActive)
  );
  const showCameraFallbackBanner =
    !cameraRecovering &&
    !showRedSensorError &&
    !needsGyroTap &&
    (gyroFallbackActive || !cameraReady) &&
    !arSelectHint;
  const sensorNeedsGpsRetry = Boolean(
    !location && typeof onRetryLocation === 'function' && /location|gps/i.test(sensorBanner || '')
  );
  const hintNeedsCameraRetry = Boolean(
    !cameraReady && typeof onRetryCameraAccess === 'function' && /camera/i.test(arSelectHint || '')
  );
  const hintNeedsGpsRetry = Boolean(
    !location && typeof onRetryLocation === 'function' && /location|gps/i.test(arSelectHint || '')
  );
  const openLoginAction = onOpenLogin || onOpenLoginFromHint;

  return (
    <>
      {/* Top-Left Mobile Account / Sign-In & Telemetry Stack (minimal Back pill when inspecting land) */}
      <div className="mobile-top-hud-left hud-interactive">
        {isInteractingWithLand ? (
          <button
            type="button"
            className="top-mini-pill ar-land-exit-pill"
            data-testid="ar-land-exit-top-btn"
            onClick={onExitArLand}
            aria-label={arExitLabel}
          >
            <span aria-hidden="true">←</span>
            <span>{arExitLabel}</span>
          </button>
        ) : user ? (
          <button
            type="button"
            className="top-mini-pill mobile-profile-pill"
            data-testid="mobile-profile-btn"
            onClick={onOpenProfile}
            aria-label={user.username ? `Open profile @${user.username}` : 'Open profile'}
            title="Open Profile, edit @username, bio, icon & header banner"
          >
            <UserHandleBadge user={user} fallback="Creator" size="xs" />
          </button>
        ) : (
          <button
            type="button"
            className="top-mini-pill mobile-signin-pill"
            data-testid="mobile-signin-btn"
            onClick={openLoginAction}
            aria-label="Sign in with Google"
            title="Sign in with Google to save drafts, claim land, and mint AR sculptures"
          >
            <XeroIcon emoji="🔐" size={13} />
            <span>Sign In</span>
          </button>
        )}

        {!isInteractingWithLand && dockOpen && (
          <div className="pol-pill">
            <XeroIcon emoji={location ? '📍' : '⏳'} size={13} />
            <span>
              {location
                ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
                : 'Acquiring GPS'}
            </span>
            {location?.altitude != null && (
              <>
                <span>|</span>
                <XeroIcon emoji="⛰️" size={13} />
                <span>{Math.round(location.altitude)}m</span>
              </>
            )}
            <span>|</span>
            <XeroIcon emoji="🧱" size={13} />
            <span>{voxels.length}</span>
            {pairedCode && (
              <>
                <span>|</span>
                <XeroIcon emoji="🔗" size={13} />
                <span>{pairedCode}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Top-Right Mobile Controls & Pair/Approvals Hub (keeps Notifications accessible even while interacting with land) */}
      {isInteractingWithLand ? (
      <div className="mobile-top-hud-right hud-interactive" data-testid="ar-land-top-right-hud">
        <div className="mobile-top-hud-row">
          <NotificationCenter
            user={user}
            variant="mobile"
            refreshSignal={notifRefreshSignal}
            pendingApprovals={pendingSignatures}
            onApprovalResolved={onApprovalResolved}
            onAction={onNotificationAction}
          />
        </div>
      </div>
      ) : (
      <div className="mobile-top-hud-right hud-interactive">
        <div className="mobile-top-hud-row">
          <NotificationCenter
            user={user}
            variant="mobile"
            refreshSignal={notifRefreshSignal}
            pendingApprovals={pendingSignatures}
            onApprovalResolved={onApprovalResolved}
            onAction={onNotificationAction}
          />
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

          {needsRepairAlert && !pairHubOpen && (
            <button
              type="button"
              data-pair-hub-trigger="1"
              data-testid="mobile-repair-pill"
              className="pending-alert-pill is-repair"
              onClick={() => togglePairHub('pair')}
              aria-label="Re-pair needed — open pairing panel"
            >
              <XeroIcon emoji="🔗" size={12} />
              <span>Re-pair needed</span>
              <span aria-hidden="true">▾</span>
            </button>
          )}

          {isPaired && hasOwnedLand && (
            <button
              type="button"
              className="land-manage-pill"
              data-testid="mobile-land-management-btn"
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
          onCameraRefreshNeeded={onCameraRefreshNeeded}
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
          repairNotice={repairNotice}
          onDismissRepairNotice={onDismissRepairNotice}
          onCreateMcpPairing={onCreateMcpPairing}
          onDisconnectMcpPairing={onDisconnectMcpPairing}
          onOpenAgentHandoff={onOpenAgentHandoff}
          pendingSignatures={pendingSignatures}
          signatureHistory={signatureHistory}
          pendingSigBusyId={pendingSigBusyId}
          pendingSigErrors={pendingSigErrors}
          onMobileSignPending={onMobileSignPending}
          onMobileRejectPending={onMobileRejectPending}
          onPreviewPending={onPreviewPending}
          onNavigateToLand={onNavigateToLand}
          onRefreshSignatures={onRefreshSignatures}
        />
      </div>
      )}

      {/* Unified Non-Overlapping Vertical HUD Status & Alert Stack */}
      <div
        className={`mobile-hud-stack ${dockOpen ? 'has-pol' : ''} ${
          isInteractingWithLand ? 'is-land-inspect' : ''
        }`}
      >
        {sensorStatus &&
          (isInteractingWithLand ||
            mode === 'preview' ||
            sensorStatus.needsCompassCalibration ||
            webxrActive) && (
            <div className="ar-sensor-hud-row hud-interactive">
              <div
                className={`ar-sensor-status-pill ${
                  webxrActive
                    ? 'is-xr'
                    : sensorStatus.needsCompassCalibration
                    ? 'is-warn'
                    : sensorStatus.trueNorthLocked
                    ? 'is-locked'
                    : ''
                }`}
                data-testid="ar-sensor-status-pill"
                data-sensor-source={sensorStatus.source || 'none'}
                data-true-north={sensorStatus.trueNorthLocked ? 'true' : 'false'}
              >
                <XeroIcon
                  emoji={
                    webxrActive
                      ? '✨'
                      : sensorStatus.needsCompassCalibration
                      ? '⚠️'
                      : '🧭'
                  }
                  size={12}
                />
                <span>
                  {webxrActive
                    ? '6-DoF ARCore Lock'
                    : sensorStatus.needsCompassCalibration
                    ? sensorStatus.magneticInterference
                      ? 'Magnetic interference · Wave phone in figure-8'
                      : 'Calibrate compass (wave figure-8)'
                    : sensorStatus.trueNorthLocked
                    ? `True North${
                        sensorStatus.headingAccuracyDeg != null
                          ? ` ±${sensorStatus.headingAccuracyDeg}°`
                          : ''
                      }${
                        sensorStatus.gpsAccuracyM != null
                          ? ` · GPS ±${sensorStatus.gpsAccuracyM}m`
                          : ''
                      }`
                    : `Compass Waiting${
                        sensorStatus.gpsAccuracyM != null
                          ? ` · GPS ±${sensorStatus.gpsAccuracyM}m`
                          : ''
                      }`}
                </span>
                <InfoTip title="Multi-Sensor AR Alignment">
                  Fuses True-North compass, gyroscope, gravity horizon, geomagnetic declination (
                  {sensorStatus.declinationDeg >= 0 ? '+' : ''}
                  {sensorStatus.declinationDeg ?? 0}°), Kalman GPS + step motion, and visual ORB
                  landmarks so lands stay locked in real-world position and direction.
                  {sensorStatus.needsCompassCalibration
                    ? ' Move your phone smoothly in a figure-8 away from steel or cars to recalibrate.'
                    : ''}
                </InfoTip>
              </div>

              {webxrSupported && typeof onToggleWebxr === 'function' && (isInteractingWithLand || mode === 'preview') && (
                <button
                  type="button"
                  className={`ar-webxr-pill ${webxrActive ? 'is-active' : ''}`}
                  data-testid="ar-webxr-toggle-btn"
                  aria-pressed={webxrActive}
                  onClick={onToggleWebxr}
                  title="Toggle ARCore 6-DoF WebXR tracking for centimeter walking stability"
                >
                  <XeroIcon emoji="📐" size={12} />
                  <span>{webxrActive ? 'Exit 6-DoF' : '6-DoF AR'}</span>
                </button>
              )}
            </div>
          )}

        {!isInteractingWithLand &&
          nearbyCameraLand &&
          (mode === 'draw' || mode === 'preview') &&
          onInspectArLand && (
            <button
              type="button"
              className={`ar-nearby-land-pill hud-interactive ${
                nearbyCameraLand.isInside ? 'is-inside' : ''
              }`}
              data-testid="ar-nearby-land-pill"
              data-parcel-id={nearbyCameraLand.parcelId}
              onClick={() => onInspectArLand(nearbyCameraLand)}
              aria-label={`Inspect nearby land ${nearbyCameraLand.displayName}`}
            >
              <span className="ar-nearby-land-pill-main">
                <XeroIcon emoji={nearbyCameraLand.isInside ? '✨' : '📍'} size={13} />
                <span className="ar-nearby-land-pill-label">
                  {nearbyCameraLand.isInside ? 'On Land: ' : 'Near: '}
                  <strong>{nearbyCameraLand.displayName}</strong>
                </span>
                {!nearbyCameraLand.isInside && nearbyCameraLand.edgeDistanceMeters !== undefined && (
                  <span className="ar-nearby-land-pill-dist mono">
                    {formatDistance(nearbyCameraLand.edgeDistanceMeters, unitSystem, { compact: true })}
                  </span>
                )}
                {nearbyCameraLand.isOwned && (
                  <span className="ar-nearby-land-pill-own">👑</span>
                )}
              </span>
              <span className="ar-nearby-land-pill-cta">
                {nearbyCameraLandCount > 1 ? `+${nearbyCameraLandCount - 1} · ` : ''}
                Details ▸
              </span>
            </button>
          )}

        {!isInteractingWithLand &&
          mode === 'draw' &&
          nearbyOtherItemsCount > 0 &&
          typeof onToggleFadeOtherItems === 'function' && (
            <button
              type="button"
              className={`ar-fade-items-pill hud-interactive ${fadeOtherItems ? 'is-faded' : ''}`}
              data-testid="ar-fade-other-items-btn"
              aria-pressed={fadeOtherItems}
              onClick={onToggleFadeOtherItems}
              title="Fade other placed art on this land while drawing (collision protection stays active)"
            >
              <XeroIcon emoji={fadeOtherItems ? '👻' : '👁️'} size={13} />
              <span>
                {fadeOtherItems
                  ? `Other Art Faded (${nearbyOtherItemsCount}) · Show`
                  : `Fade Other Art (${nearbyOtherItemsCount})`}
              </span>
            </button>
          )}

        {!isInteractingWithLand && editingSculpture && (
          <div
            className="mobile-hud-banner hud-interactive"
            style={{
              borderColor: 'rgba(0, 245, 212, 0.72)',
              background: 'rgba(10, 26, 30, 0.92)'
            }}
          >
            <span className="mobile-hud-banner-text">
              <XeroIcon emoji="🖌️" size={14} />
              <span>
                Editing {editingSculpture.title} ({voxels.length} blocks)
              </span>
            </span>
            <span className="mobile-hud-banner-actions">
              <button
                type="button"
                className="btn btn-primary btn-xs"
                disabled={savingCanvasEdit}
                onClick={onSaveCanvasModification}
              >
                {savingCanvasEdit ? 'Saving...' : 'Save Edit'}
              </button>
              <button
                type="button"
                className="btn btn-xs"
                onClick={onCancelCanvasModification}
              >
                Cancel
              </button>
            </span>
          </div>
        )}

        {!isInteractingWithLand && mode === 'draw' && (
          <div className="surface-pill hud-interactive">
            {surfaceAnchor ? (
              <>
                <XeroIcon emoji="📌" size={13} />
                <span className="surface-pill-label">
                  {surfaceAnchor.label} · {formatShortLength(surfaceAnchor.depthM, unitSystem, { decimals: 1, compact: true })}
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

        {!isInteractingWithLand && mode === 'draw' && activeQuest && (
          <div
            className="surface-pill hud-interactive"
            style={{
              borderColor: activeQuest.firstSparkBoost
                ? 'rgba(255, 107, 53, 0.7)'
                : 'rgba(0, 245, 212, 0.5)'
            }}
          >
            <span className="surface-pill-label" style={{ maxWidth: 190 }}>
              {activeQuest.firstSparkBoost ? '🔥 First-Spark (2x XP)' : '🎨 Quest'}:{' '}
              {activeQuest.title}
            </span>
            {(activeQuest.slotOffsets || []).find((s) => !s.claimedBySculptureId) &&
              onSnapToPlinthSlot && (
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

        {cameraRecovering && (
          <div
            className="mobile-hud-banner hud-interactive"
            data-testid="camera-recovering-banner"
            role="status"
            aria-live="polite"
          >
            <span className="mobile-hud-banner-text">
              <XeroIcon emoji="🔄" size={14} />
              <span>Refreshing AR camera…</span>
            </span>
          </div>
        )}

        {!isInteractingWithLand && showRedSensorError && (
          <div
            className="mobile-hud-banner hud-interactive is-error"
            data-testid="mobile-error-banner"
            role="status"
            aria-live="polite"
          >
            <span className="mobile-hud-banner-text">
              <XeroIcon emoji="⚠️" size={14} />
              <span>{sensorBanner}</span>
            </span>
            <span className="mobile-hud-banner-actions">
              {!cameraReady && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={onRetryCameraAccess}
                >
                  Retry Camera
                </button>
              )}
              {sensorNeedsGpsRetry && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={onRetryLocation}
                >
                  Retry GPS
                </button>
              )}
              {onDismissSensorBanner && (
                <button
                  type="button"
                  className="btn btn-xs mobile-banner-dismiss"
                  onClick={onDismissSensorBanner}
                  aria-label="Dismiss alert"
                  title="Dismiss"
                >
                  ✕
                </button>
              )}
            </span>
          </div>
        )}

        {!isInteractingWithLand && showCameraFallbackBanner && (
          <div
            className="mobile-hud-banner hud-interactive is-warn"
            role="status"
            aria-live="polite"
          >
            <span className="mobile-hud-banner-text">
              <XeroIcon emoji={!cameraReady ? '📷' : '👆'} size={14} />
              <span>
                {!cameraReady
                  ? describeCameraNeededAction()
                  : 'Motion sensors off — drag screen to aim, or enable Motion in Settings.'}
              </span>
            </span>
            {!cameraReady && (
              <span className="mobile-hud-banner-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={onRetryCameraAccess}
                >
                  Retry Camera
                </button>
              </span>
            )}
          </div>
        )}

        {arSelectHint && !(isInteractingWithLand && arSelectHint.includes('Mapping complete')) && (
          <div
            className={`mobile-hud-banner hud-interactive ${
              !isInteractingWithLand && originStatus.originBlocked
                ? 'is-error'
                : !isInteractingWithLand && sceneScan.optimal && arSelectHint.includes('Mapping complete')
                ? 'is-success'
                : ''
            }`}
            role="status"
            aria-live="polite"
          >
            <span className="mobile-hud-banner-text">
              <XeroIcon
                emoji={
                  isInteractingWithLand
                    ? '👁️'
                    : originStatus.originBlocked
                    ? '⚠️'
                    : sceneScan.optimal
                    ? '✅'
                    : '🔒'
                }
                size={14}
              />
              <span>{arSelectHint}</span>
            </span>
            <span className="mobile-hud-banner-actions">
              {!user && arSelectHint.includes('Sign in') && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={onOpenLoginFromHint}
                >
                  Sign In
                </button>
              )}
              {hintNeedsCameraRetry && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={onRetryCameraAccess}
                >
                  Retry Camera
                </button>
              )}
              {hintNeedsGpsRetry && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={onRetryLocation}
                >
                  Retry GPS
                </button>
              )}
              {onDismissHint && (
                <button
                  type="button"
                  className="btn btn-xs mobile-banner-dismiss"
                  onClick={onDismissHint}
                  aria-label="Dismiss notice"
                  title="Dismiss"
                >
                  ✕
                </button>
              )}
            </span>
          </div>
        )}

        {!isInteractingWithLand && mode === 'draw' && originStatus.originBlocked && !arSelectHint && (
          <div
            className="mobile-hud-banner origin-blocked-banner hud-interactive is-error"
            role="status"
            aria-live="polite"
          >
            <span className="mobile-hud-banner-text">
              <XeroIcon emoji="⚠️" size={14} />
              <span>{originStatus.reason || 'View blocked. Move object away from camera.'}</span>
            </span>
          </div>
        )}
      </div>

      {needsGyroTap && (
        <button
          className="btn btn-primary"
          data-testid="enable-gyro-compass-btn"
          style={{
            position: 'absolute',
            top: isInteractingWithLand ? '36%' : '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 40
          }}
          onClick={onEnableIosGyro}
        >
          <XeroIcon emoji="🧭" size={18} />{' '}
          {isInteractingWithLand ? 'Enable Compass' : 'Enable Gyroscope 3D Brush'}
        </button>
      )}

      {!isInteractingWithLand && mode === 'preview' && arTargetedSculpture && (() => {
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
                  {Math.round(arTargetedSculpture.distanceM)}m away ·{' '}
                  {resolveLandDisplayName(
                    {
                      customName: targetSc.parcelName || '',
                      displayName: targetSc.landDisplayName || '',
                      firstSculptureTitle: targetSc.title || ''
                    },
                    { defaultName: 'Virtual Land' }
                  )}
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
                <XeroIcon emoji="💬" size={14} /> Land Chat
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

      {!isInteractingWithLand && (
        <button
          type="button"
          className={`floating-map-btn hud-interactive ${mapOpen ? 'active' : ''}`}
          onClick={onOpenAreaMap}
          aria-label="Open Nearest Lands Map"
          title="Nearest Lands, Sculptures & Google Maps Directions"
        >
          <XeroIcon emoji="🗺️" size={22} />
          {nearbyCount > 0 && (
            <span className="floating-map-badge" data-testid="floating-map-badge">
              {nearbyCount}
            </span>
          )}
        </button>
      )}
    </>
  );
}
