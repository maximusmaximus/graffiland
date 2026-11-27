import React from 'react';
import { formatShortLength, useMeasurementUnits } from '../../utils/measurementUnits.js';
import XeroIcon from '../XeroIcon.jsx';

export default function SceneCoverageWidget({
  sceneScan,
  orbStatus,
  scanBoxCollapsed,
  onToggleCollapse,
  dockOpen,
  mode,
  onRefreshOrbRescan,
  mappingRestartPrompt = null,
  onRestartMapping = null,
  onStartFresh = null,
  calibrationState = null,
  calibrationReadiness = null,
  calibrationLoss = null,
  calibrationJustLocked = false,
  cameraReady = true,
  needsGyroTap = false,
  onEnableIosGyro = null,
  onRetryCameraAccess = null,
  sensorStatus = null,
  voxelCount = 0
}) {
  const { unitSystem } = useMeasurementUnits();
  const activeLoss = mappingRestartPrompt || calibrationLoss || null;
  const needsRestart = Boolean(activeLoss || calibrationState === 'lost');
  const resolvedState = needsRestart
    ? 'lost'
    : calibrationState || (sceneScan?.optimal ? 'calibrated' : 'calibrating');
  const isCalibrated = resolvedState === 'calibrated';
  const isRelocalizing = resolvedState === 'relocalizing';
  const isCenteredOverlay = resolvedState === 'calibrating' || resolvedState === 'lost';

  const progressPct = Number.isFinite(calibrationReadiness?.progressPct)
    ? calibrationReadiness.progressPct
    : Number(sceneScan?.coveragePct || 0);
  const sweepTarget = calibrationReadiness?.sweepTarget || sceneScan?.targetCount || 7;
  const orbTarget = calibrationReadiness?.orbTarget || 2;
  const orbKeyframes = Number(orbStatus?.keyframes || 0);
  const checks = calibrationReadiness?.checks || null;

  const handleManualRestart = (e) => {
    e?.stopPropagation?.();
    onRestartMapping?.('manual');
  };
  const handlePromptRestart = () => {
    onRestartMapping?.(activeLoss?.code || activeLoss?.reason || 'device_moved');
  };
  const handleStartFreshClick = () => {
    onStartFresh?.();
  };

  // Minimized bottom-right icon when calibration is complete (or silently relocalizing)
  if (!isCenteredOverlay && scanBoxCollapsed) {
    return (
      <div
        className={`scene-scan-box hud-interactive collapsed minimized-fab ${
          isRelocalizing ? 'relocalizing' : 'optimal'
        } ${calibrationJustLocked ? 'just-locked' : ''} ${
          dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''
        }`}
        data-testid="scene-coverage-widget"
        data-placement="bottom-right"
        data-calibration-state={resolvedState}
        data-needs-restart="false"
        role="region"
        aria-label="AR calibration status icon"
      >
        {calibrationJustLocked && (
          <span className="calibration-just-locked-pill" role="status">
            Calibrated!
          </span>
        )}
        <button
          type="button"
          className="calibration-minimized-icon-btn"
          data-testid="calibration-minimized-fab"
          onClick={onToggleCollapse}
          aria-label={
            isRelocalizing
              ? 'Verifying AR calibration'
              : 'AR calibrated — tap for calibration details'
          }
          title={
            isRelocalizing
              ? 'Verifying AR visual lock…'
              : 'AR Calibrated (100%) — tap for details'
          }
        >
          <span className={`calibration-dot ${isRelocalizing ? 'pulsing' : 'locked'}`} />
          <XeroIcon emoji={isRelocalizing ? '📡' : '✅'} size={15} />
        </button>
        {onRestartMapping && (
          <button
            type="button"
            className="scene-scan-refresh calibration-mini-refresh"
            data-testid="scene-scan-refresh-btn"
            onClick={handleManualRestart}
            aria-label="Restart scene mapping"
            title="Recalibrate AR space"
          >
            <XeroIcon emoji="🔄" size={11} />
          </button>
        )}
      </div>
    );
  }

  // Front-and-center calibration card (initial calibration or lost calibration)
  // OR expanded bottom-right diagnostics popover when user taps the minimized icon
  const statusTag = needsRestart
    ? activeLoss?.movedSubstantially
      ? 'MOVED'
      : 'RE-LOCK'
    : isRelocalizing
      ? 'RELOCK'
      : isCalibrated
        ? 'LOCKED'
        : `${sceneScan?.scannedCount ?? 0}/${sweepTarget}`;

  const centerHeadline = needsRestart
    ? activeLoss?.title || 'Calibration Lost'
    : calibrationReadiness?.headline || 'Calibrating AR Space';

  const activeHint = needsRestart
    ? activeLoss?.summary || 'Tracking lost — pan slowly to re-lock AR.'
    : calibrationReadiness?.subHint || sceneScan?.hint || 'Pan phone slowly around your space';

  const gpsAccuracyM = checks?.gpsAccuracyM ?? sensorStatus?.gpsAccuracyM ?? null;
  const hasGps = Boolean(checks?.gps || gpsAccuracyM !== null);

  return (
    <div
      className={`scene-scan-box hud-interactive ${
        isCenteredOverlay ? 'is-centered' : 'is-popover'
      } ${
        needsRestart
          ? 'needs-restart'
          : isRelocalizing
            ? 'relocalizing'
            : isCalibrated
              ? 'optimal'
              : 'scanning'
      } ${dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''}`}
      data-testid="scene-coverage-widget"
      data-placement={isCenteredOverlay ? 'center' : 'bottom-right'}
      data-calibration-state={resolvedState}
      data-needs-restart={needsRestart ? 'true' : 'false'}
      role={isCenteredOverlay ? 'dialog' : 'region'}
      aria-label={isCenteredOverlay ? 'AR space calibration required' : 'AR calibration details'}
    >
      <div
        className="scene-scan-header"
        data-testid={isCenteredOverlay ? 'calibration-center-card' : 'calibration-status-popover'}
      >
        <div className="scene-scan-title">
          <XeroIcon
            emoji={needsRestart ? '⚠️' : isCalibrated ? '✅' : '📡'}
            size={isCenteredOverlay ? 15 : 12}
          />
          {isCenteredOverlay ? (
            <span className="calibration-card-heading">{centerHeadline}</span>
          ) : (
            <span className="mono">{progressPct}%</span>
          )}
          <span className="scene-scan-tag">{statusTag}</span>
        </div>
        <div className="scene-scan-header-actions">
          {isCenteredOverlay && !needsRestart && (
            <span className="mono calibration-pct-badge">{progressPct}%</span>
          )}
          {onRestartMapping && (
            <button
              type="button"
              className={`scene-scan-refresh ${needsRestart ? 'is-attention' : ''}`}
              data-testid="scene-scan-refresh-btn"
              onClick={handleManualRestart}
              aria-label="Restart scene mapping"
              title="Restart scene mapping"
            >
              <XeroIcon emoji="🔄" size={11} />
            </button>
          )}
          {!isCenteredOverlay && (
            <button
              type="button"
              className="scene-scan-collapse"
              onClick={onToggleCollapse}
              aria-label="Collapse scene coverage window"
              title="Minimize to bottom-right icon"
            >
              <XeroIcon emoji="➖" size={11} />
            </button>
          )}
        </div>
      </div>

      {needsRestart ? (
        <div
          className="scene-scan-restart-banner"
          data-testid="scene-scan-restart-banner"
          role="alert"
        >
          <div className="scene-scan-restart-msg">{activeHint}</div>
          {voxelCount > 0 && (
            <div className="calibration-preserved-note" data-testid="calibration-preserved-note">
              Your {voxelCount} placed block{voxelCount === 1 ? '' : 's'} are safely preserved.
            </div>
          )}
          <div className="calibration-action-row">
            {!cameraReady && onRetryCameraAccess && (
              <button
                type="button"
                className="btn btn-primary calibration-inline-cta"
                data-testid="calibration-retry-camera-btn"
                onClick={() => onRetryCameraAccess()}
              >
                <XeroIcon emoji="📷" size={13} /> Resume Camera
              </button>
            )}
            {onRestartMapping && (
              <button
                type="button"
                className="scene-scan-restart-btn"
                data-testid="scene-scan-restart-btn"
                onClick={handlePromptRestart}
              >
                <XeroIcon emoji="🔄" size={12} /> Recalibrate
              </button>
            )}
            {Boolean(activeLoss?.canStartFresh || activeLoss?.movedSubstantially) &&
              voxelCount > 0 &&
              onStartFresh && (
                <button
                  type="button"
                  className="btn calibration-start-fresh-btn"
                  data-testid="calibration-start-fresh-btn"
                  onClick={handleStartFreshClick}
                >
                  Start Fresh
                </button>
              )}
          </div>
        </div>
      ) : (
        <>
          {isCenteredOverlay && !cameraReady && onRetryCameraAccess && (
            <button
              type="button"
              className="btn btn-primary calibration-inline-cta"
              data-testid="calibration-retry-camera-btn"
              onClick={() => onRetryCameraAccess()}
            >
              <XeroIcon emoji="📷" size={14} /> Enable / Retry Camera
            </button>
          )}
          {isCenteredOverlay && cameraReady && needsGyroTap && onEnableIosGyro && (
            <button
              type="button"
              className="btn btn-primary calibration-inline-cta"
              data-testid="calibration-enable-motion-btn"
              onClick={() => onEnableIosGyro()}
            >
              <XeroIcon emoji="🧭" size={14} /> Enable Motion & Compass
            </button>
          )}

          <div className={`scene-scan-window ${isCenteredOverlay ? 'is-large' : ''}`} aria-hidden="true">
            <div className="scene-scan-grid">
              {(sceneScan?.sectors || Array(12).fill(false)).map((lit, i) => (
                <span key={i} className={`scene-scan-cell ${lit ? 'scanned' : ''}`} />
              ))}
            </div>
            <span
              className="scene-scan-dot"
              style={{
                left: `${(sceneScan?.cursorX ?? 0.5) * 100}%`,
                top: `${(sceneScan?.cursorY ?? 0.5) * 100}%`
              }}
            />
          </div>

          <div className="scene-scan-bar">
            <div className="scene-scan-bar-fill" style={{ width: `${progressPct}%` }} />
          </div>

          <div className="scene-scan-hint">{activeHint}</div>

          <div className="calibration-signal-chips">
            <span className={`cal-chip ${cameraReady && !calibrationReadiness?.lensOccluded ? 'ok' : 'warn'}`}>
              {cameraReady ? '✓' : '·'} Cam
            </span>
            <span className={`cal-chip ${checks?.motion !== false && !needsGyroTap ? 'ok' : 'warn'}`}>
              {checks?.motion !== false && !needsGyroTap ? '✓' : '·'} Motion
            </span>
            <span className={`cal-chip ${checks?.orb || orbKeyframes >= orbTarget ? 'ok' : ''}`}>
              {checks?.orb || orbKeyframes >= orbTarget ? '✓' : '·'} ORB {Math.min(orbKeyframes, 3)}/{orbTarget}
            </span>
            <span className={`cal-chip ${hasGps ? 'ok' : 'muted'}`}>
              {hasGps && gpsAccuracyM !== null ? `GPS ±${Math.round(gpsAccuracyM)}m` : hasGps ? '✓ GPS' : 'GPS…'}
            </span>
          </div>

          <div className="scene-scan-precision mono">
            ±{formatShortLength(sceneScan?.precisionMeters ?? 2.4, unitSystem, { decimals: 2, compact: true })} · {orbStatus?.engine || 'Gyro+ORB'} ({orbKeyframes}/3)
            {orbStatus?.relocalizedInliers > 0 ? ` · ${orbStatus.relocalizedInliers} pts` : ''}
            {orbStatus?.packStatus === 'no_pack' ? ' · Scan space on mobile to calibrate Visual Match' : ''}
          </div>

          {isCenteredOverlay && (
            <div className="calibration-gate-note">
              Drawing unlocks automatically once calibrated
            </div>
          )}

          {!isCenteredOverlay && mode === 'preview' && onRefreshOrbRescan && (
            <button
              type="button"
              className="btn"
              style={{ width: '100%', padding: '3px 6px', fontSize: 10, marginTop: 4 }}
              onClick={onRefreshOrbRescan}
            >
              <XeroIcon emoji="🔄" size={10} /> Re-scan ORB View
            </button>
          )}
        </>
      )}
    </div>
  );
}
