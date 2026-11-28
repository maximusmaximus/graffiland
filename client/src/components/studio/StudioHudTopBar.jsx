import React, { useEffect, useState } from 'react';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import { evaluateLandChatAvailability } from '../../utils/landChatHelpers.js';
import {
  formatDistance,
  useMeasurementUnits
} from '../../utils/measurementUnits.js';
import { describeCameraNeededAction } from '../../utils/permissionMessages.js';
import { notifySettingsSaved } from '../../utils/toastNotice.js';
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
  onOpenInfo,
  onOpenCatalogSearch = null,
  hasPlacedCatalogItem = false,
  onOpenProfile = null,
  editingSculpture,
  savingCanvasEdit,
  onSaveCanvasModification,
  onCancelCanvasModification,
  needsGyroTap,
  calibrationOverlayVisible = false,
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

        {((pendingCount > 0 && !pairHubOpen) || (needsRepairAlert && !pairHubOpen)) && (
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
          </div>
        )}

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
        {!isInteractingWithLand &&
          nearbyCameraLand &&
          (mode === 'draw' || mode === 'preview') &&
          (onInspectArLand || (mode === 'draw' && nearbyCameraLand.isInside)) && (() => {
            const isAddingArt = mode === 'draw' && Boolean(nearbyCameraLand.isInside);
            const isFrozenAdding = isAddingArt && Boolean(nearbyCameraLand.isFrozen);
            const pillClass = `ar-nearby-land-pill hud-interactive ${
              nearbyCameraLand.isInside ? 'is-inside' : ''
            } ${isFrozenAdding ? 'is-frozen-land' : isAddingArt ? 'is-adding-art' : ''}`;
            const pillEmoji = isFrozenAdding
              ? '❄️'
              : isAddingArt
              ? '🎨'
              : nearbyCameraLand.isInside
              ? '✨'
              : '📍';
            const pillPrefix = isFrozenAdding
              ? 'Frozen Land: '
              : isAddingArt
              ? 'Adding Art to: '
              : nearbyCameraLand.isInside
              ? 'On Land: '
              : 'Near: ';
            const pillAria = isAddingArt
              ? `Adding art to ${nearbyCameraLand.displayName}`
              : `Inspect nearby land ${nearbyCameraLand.displayName}`;
            return (
              <button
                type="button"
                className={pillClass}
                data-testid="ar-nearby-land-pill"
                data-parcel-id={nearbyCameraLand.parcelId}
                data-adding-to-land={isAddingArt && !isFrozenAdding ? 'true' : 'false'}
                data-frozen-land={isFrozenAdding ? 'true' : 'false'}
                data-land-name={nearbyCameraLand.displayName}
                onClick={() => onInspectArLand?.(nearbyCameraLand)}
                aria-label={pillAria}
              >
                <span className="ar-nearby-land-pill-main">
                  <XeroIcon emoji={pillEmoji} size={13} />
                  <span className="ar-nearby-land-pill-label">
                    {pillPrefix}
                    <strong>{nearbyCameraLand.displayName}</strong>
                    {isFrozenAdding ? ' · View only' : ''}
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
                {onInspectArLand && (
                  <span className="ar-nearby-land-pill-cta">
                    {nearbyCameraLandCount > 1 ? `+${nearbyCameraLandCount - 1} · ` : ''}
                    Details ▸
                  </span>
                )}
              </button>
            );
          })()}

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

      {needsGyroTap && !calibrationOverlayVisible && (
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
        const targetLandLabel = resolveLandDisplayName(
          {
            customName: targetSc.parcelName || '',
            displayName: targetSc.landDisplayName || '',
            firstSculptureTitle: targetSc.title || ''
          },
          { defaultName: 'Virtual Land' }
        );
        const targetChatAvail = evaluateLandChatAvailability({
          land: {
            parcelId: targetSc.parcelId,
            displayName: targetLandLabel,
            edgeDistanceMeters: arTargetedSculpture.distanceM,
            isInside: Number(arTargetedSculpture.distanceM) <= 1.5,
            chatAccessMode:
              nearbyCameraLand?.parcelId === targetSc.parcelId
                ? nearbyCameraLand.chatAccessMode
                : undefined,
            ownerSub:
              nearbyCameraLand?.parcelId === targetSc.parcelId
                ? nearbyCameraLand.ownerSub
                : targetSc.creatorSub,
            contributorSubs:
              nearbyCameraLand?.parcelId === targetSc.parcelId
                ? nearbyCameraLand.contributorSubs
                : undefined,
            chatWhitelistSubs:
              nearbyCameraLand?.parcelId === targetSc.parcelId
                ? nearbyCameraLand.chatWhitelistSubs
                : undefined,
            sculptures:
              nearbyCameraLand?.parcelId === targetSc.parcelId
                ? nearbyCameraLand.sculptures
                : [targetSc]
          },
          displayName: targetLandLabel,
          isDesktop: false,
          isSignedIn: Boolean(user),
          userId: user?.id || '',
          cameraReady: cameraReady !== false,
          hasLocation: Boolean(location),
          unitSystem
        });
        return (
          <div
            className="ar-select-card hud-interactive"
            role="region"
            aria-label={`Selected sculpture ${targetSc.title}`}
            onClick={() => {
              if (!targetChatAvail.canChat) {
                notifySettingsSaved(targetChatAvail.reason, { tone: 'warning' });
                return;
              }
              onOpenCameraSelectedChat(targetSc, arTargetedSculpture.distanceM, activePin);
            }}
          >
            <div className="ar-select-card-head">
              <div style={{ minWidth: 0 }}>
                <div className="ar-select-title">{targetSc.title}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                  {Math.round(arTargetedSculpture.distanceM)}m away · {targetLandLabel}
                </div>
              </div>
              {targetChatAvail.canChat ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="ar-select-land-chat-btn"
                  data-locked="false"
                  style={{ fontSize: 12, padding: '6px 10px', flexShrink: 0 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenCameraSelectedChat(targetSc, arTargetedSculpture.distanceM, activePin);
                  }}
                >
                  <XeroIcon emoji="💬" size={14} /> Land Chat
                </button>
              ) : (
                <span
                  className="chat-locked-inline-group"
                  style={{ flexShrink: 0 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="btn is-action-locked"
                    data-testid="ar-select-land-chat-btn"
                    data-locked="true"
                    aria-disabled="true"
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      notifySettingsSaved(targetChatAvail.reason, { tone: 'warning' });
                    }}
                  >
                    <XeroIcon emoji="🔒" size={13} /> Land Chat
                  </button>
                  <span data-testid="ar-select-land-chat-lock-info">
                    <InfoTip
                      title={targetChatAvail.title || 'Why Land Chat is locked'}
                      mode="popover"
                      align="right"
                    >
                      {targetChatAvail.reason}
                    </InfoTip>
                  </span>
                </span>
              )}
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

      {!isInteractingWithLand && typeof onOpenCatalogSearch === 'function' && (
        <button
          type="button"
          className={`floating-catalog-search-btn hud-interactive ${
            hasPlacedCatalogItem ? 'is-active' : ''
          }`}
          data-testid="mobile-catalog-search-btn"
          onClick={onOpenCatalogSearch}
          aria-label="Search premade 3D items to place"
          title="Search & place premade 3D models & emojis (SimReady, Pixels, XeroEmoji)"
        >
          <XeroIcon emoji="🔍" size={20} label="Search 3D" />
          <span
            className="floating-search-mini-badge"
            data-testid="floating-search-blocks-badge"
            aria-hidden="true"
          >
            <svg viewBox="0 0 18 18" width="13" height="13" fill="none">
              {/* Top centered 3D block */}
              <polygon points="9,1.2 12.6,3.1 9,5 5.4,3.1" fill="#00f5d4" />
              <polygon points="5.4,3.1 9,5 9,8.4 5.4,6.5" fill="#00b89e" />
              <polygon points="12.6,3.1 9,5 9,8.4 12.6,6.5" fill="#008f7a" />
              {/* Bottom-left 3D block */}
              <polygon points="5.2,8 8.8,9.9 5.2,11.8 1.6,9.9" fill="#ffd166" />
              <polygon points="1.6,9.9 5.2,11.8 5.2,15.2 1.6,13.3" fill="#e0a82e" />
              <polygon points="8.8,9.9 5.2,11.8 5.2,15.2 8.8,13.3" fill="#b88418" />
              {/* Bottom-right 3D block */}
              <polygon points="12.8,8 16.4,9.9 12.8,11.8 9.2,9.9" fill="#ff3e7f" />
              <polygon points="9.2,9.9 12.8,11.8 12.8,15.2 9.2,13.3" fill="#d92662" />
              <polygon points="16.4,9.9 12.8,11.8 12.8,15.2 16.4,13.3" fill="#a81a4a" />
            </svg>
          </span>
        </button>
      )}

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

      {!isInteractingWithLand && !dockOpen && typeof onOpenAgentHandoff === 'function' && (
        <button
          type="button"
          className="floating-agent-prompt-btn hud-interactive"
          data-testid="floating-agent-prompt-btn"
          onClick={onOpenAgentHandoff}
          aria-label="Copy AI Agent Prompt for this location"
          title="Copy AI Agent Prompt — add to this land, claim new land, or engage like a human"
        >
          <XeroIcon emoji="📋" size={20} />
          <span className="floating-agent-mini-badge" aria-hidden="true">
            🤖
          </span>
        </button>
      )}
    </>
  );
}
