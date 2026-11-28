import React from 'react';
import { formatShortLength, useMeasurementUnits } from '../../utils/measurementUnits.js';
import BrandLogo from '../BrandLogo.jsx';
import InfoTip from '../InfoTip.jsx';
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
  voxelCount = 0,
  showWebXrPreCalPrompt = false,
  webxrActive = false,
  webxrStarting = false,
  onStartWebXrPreCal = null,
  onSkipWebXrPreCal = null
}) {
  const { unitSystem } = useMeasurementUnits();
  const activeLoss = mappingRestartPrompt || calibrationLoss || null;
  const needsRestart = Boolean(activeLoss || calibrationState === 'lost');
  const resolvedState = needsRestart
    ? 'lost'
    : calibrationState || (sceneScan?.optimal ? 'calibrated' : 'calibrating');
  const isCalibrated = resolvedState === 'calibrated';
  const isRelocalizing = resolvedState === 'relocalizing';
  const isWebXrPreCal = Boolean(
    showWebXrPreCalPrompt && !needsRestart && !isCalibrated && !webxrActive
  );
  const isCenteredOverlay = isWebXrPreCal || resolvedState === 'calibrating' || resolvedState === 'lost';

  const progressPct = Number.isFinite(calibrationReadiness?.progressPct)
    ? calibrationReadiness.progressPct
    : Number(sceneScan?.coveragePct || 0);
  const sweepTarget = calibrationReadiness?.sweepTarget || sceneScan?.targetCount || 7;
  const orbTarget = calibrationReadiness?.orbTarget || 2;
  const orbKeyframes = Number(orbStatus?.keyframes || 0);
  const checks = calibrationReadiness?.checks || null;
  const gpsAccuracyM = checks?.gpsAccuracyM ?? sensorStatus?.gpsAccuracyM ?? null;
  const hasGps = Boolean(checks?.gps || gpsAccuracyM !== null);

  const rawSectors =
    Array.isArray(sceneScan?.sectors) && sceneScan.sectors.length === 12
      ? sceneScan.sectors
      : Array.from({ length: 12 }, (_, idx) => idx < Number(sceneScan?.scannedCount || 0));
  const logoComplete = Boolean(isCalibrated || progressPct >= 100);
  const revealedTileCount = logoComplete ? rawSectors.length : rawSectors.filter(Boolean).length;

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

  const renderTechnicalInfoTip = ({ preCal = false } = {}) => (
    <span className="calibration-info-tip" data-testid="calibration-tech-info-tip">
      <InfoTip
        title={preCal ? 'Enhanced AR Tracking Details' : 'How AR Calibration Works'}
        mode="popover"
        align="right"
      >
        <div className="calibration-tech-info-body" data-testid="calibration-tech-info-body">
          {preCal ? (
            <p className="calibration-tech-info-copy">
              <strong>6-DoF ARCore (WebXR)</strong> fuses hardware visual-inertial odometry with
              compass &amp; ORB landmark anchors for centimeter-level world lock. Standard Scan uses
              cross-browser Gyro + ORB visual matching.
            </p>
          ) : (
            <p className="calibration-tech-info-copy">
              Moving your phone captures multi-angle <strong>ORB visual landmarks</strong> and fuses
              camera frames with <strong>gyroscope/compass</strong> and <strong>GPS</strong> so your
              3D art stays anchored in real space.
            </p>
          )}
          <div className="calibration-signal-chips">
            {webxrActive && (
              <span className="cal-chip ok" data-testid="cal-chip-webxr">
                ✓ 6-DoF
              </span>
            )}
            <span
              className={`cal-chip ${cameraReady && !calibrationReadiness?.lensOccluded ? 'ok' : 'warn'}`}
            >
              {cameraReady ? '✓' : '·'} Cam
            </span>
            <span className={`cal-chip ${checks?.motion !== false && !needsGyroTap ? 'ok' : 'warn'}`}>
              {checks?.motion !== false && !needsGyroTap ? '✓' : '·'} Motion
            </span>
            <span className={`cal-chip ${checks?.orb || orbKeyframes >= orbTarget ? 'ok' : ''}`}>
              {checks?.orb || orbKeyframes >= orbTarget ? '✓' : '·'} ORB {Math.min(orbKeyframes, 3)}/
              {orbTarget}
            </span>
            <span className={`cal-chip ${hasGps ? 'ok' : 'muted'}`}>
              {hasGps && gpsAccuracyM !== null
                ? `GPS ±${Math.round(gpsAccuracyM)}m`
                : hasGps
                ? '✓ GPS'
                : 'GPS…'}
            </span>
          </div>
          <div className="scene-scan-precision mono">
            ±
            {formatShortLength(sceneScan?.precisionMeters ?? 2.4, unitSystem, {
              decimals: 2,
              compact: true
            })}{' '}
            · {orbStatus?.engine || 'Gyro+ORB'} ({orbKeyframes}/3)
            {orbStatus?.relocalizedInliers > 0 ? ` · ${orbStatus.relocalizedInliers} pts` : ''}
            {orbStatus?.packStatus === 'no_pack'
              ? ' · Scan space on mobile to calibrate Visual Match'
              : ''}
          </div>
        </div>
      </InfoTip>
    </span>
  );

  // Minimized icon docked right above the side-scroll tool selector caption when calibrated
  if (!isCenteredOverlay && scanBoxCollapsed) {
    return (
      <div
        className={`scene-scan-box hud-interactive collapsed minimized-fab ${
          isRelocalizing ? 'relocalizing' : 'optimal'
        } ${calibrationJustLocked ? 'just-locked' : ''} ${
          dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''
        }`}
        data-testid="scene-coverage-widget"
        data-placement="above-carousel"
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
              ? 'Checking AR alignment'
              : 'Space lined up — tap for setup details'
          }
          title={
            isRelocalizing
              ? 'Checking AR alignment…'
              : 'Ready to draw (100%) — tap for details'
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
            aria-label="Restart setup scan"
            title="Scan your space again"
          >
            <XeroIcon emoji="🔄" size={11} />
          </button>
        )}
      </div>
    );
  }

  // Default pre-calibration prompt shown FIRST on ARCore-capable devices
  // before standard sweep calibration (configurable on/off in Profile ⚙️ Settings).
  if (isWebXrPreCal) {
    return (
      <div
        className={`scene-scan-box hud-interactive is-centered is-webxr-precal scanning ${
          dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''
        }`}
        data-testid="scene-coverage-widget"
        data-placement="center"
        data-calibration-state="webxr-precalibration"
        data-calibration-phase="webxr-precalibration"
        data-needs-restart="false"
        role="dialog"
        aria-label="Enable Enhanced AR for setup"
      >
        <div className="scene-scan-header" data-testid="webxr-precalibration-prompt">
          <div className="scene-scan-title">
            <XeroIcon emoji="✨" size={15} />
            <span className="calibration-card-heading">Enhanced AR Ready</span>
          </div>
          <div className="scene-scan-header-actions">{renderTechnicalInfoTip({ preCal: true })}</div>
        </div>
        <div className="webxr-precal-body">
          <p className="webxr-precal-copy">
            Your phone supports smoother, steadier AR tracking. Turn it on before looking around
            your space.
          </p>
          <div className="webxr-precal-actions">
            <button
              type="button"
              className="btn btn-primary calibration-inline-cta"
              data-testid="webxr-precalibration-start-btn"
              disabled={webxrStarting}
              onClick={() => onStartWebXrPreCal?.()}
            >
              <XeroIcon emoji="✨" size={14} />{' '}
              {webxrStarting ? 'Starting Enhanced AR…' : 'Turn On Enhanced AR'}
            </button>
            <button
              type="button"
              className="btn btn-xs webxr-precal-skip-btn"
              data-testid="webxr-precalibration-skip-btn"
              disabled={webxrStarting}
              onClick={() => onSkipWebXrPreCal?.()}
            >
              Use Standard Scan
            </button>
          </div>
          <div className="calibration-gate-note">
            Change this anytime in Profile ⚙️ Settings.
          </div>
        </div>
      </div>
    );
  }

  // Front-and-center calibration card (initial calibration or lost calibration)
  // OR expanded diagnostics popover when user taps the minimized icon
  const statusTag = needsRestart
    ? activeLoss?.movedSubstantially
      ? 'MOVED'
      : 'RESET'
    : isRelocalizing
      ? 'SYNCING'
      : isCalibrated
        ? 'READY'
        : `${Math.min(sceneScan?.scannedCount ?? 0, sweepTarget)}/${sweepTarget}`;

  const centerHeadline = needsRestart
    ? activeLoss?.title || 'Line Up Your Space'
    : calibrationReadiness?.headline || 'Look Around to Set Up';

  const activeHint = needsRestart
    ? activeLoss?.summary || 'Move your phone slowly around you to line things back up.'
    : calibrationReadiness?.subHint ||
      sceneScan?.hint ||
      'Move your phone slowly around you to reveal the logo';

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
      data-placement={isCenteredOverlay ? 'center' : 'above-carousel'}
      data-calibration-state={resolvedState}
      data-needs-restart={needsRestart ? 'true' : 'false'}
      role={isCenteredOverlay ? 'dialog' : 'region'}
      aria-label={isCenteredOverlay ? 'Space setup required' : 'AR setup details'}
    >
      <div
        className="scene-scan-header"
        data-testid={isCenteredOverlay ? 'calibration-center-card' : 'calibration-status-popover'}
      >
        <div className="scene-scan-title">
          <XeroIcon
            emoji={needsRestart ? '⚠️' : isCalibrated ? '✅' : '✨'}
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
          {renderTechnicalInfoTip({ preCal: false })}
          {onRestartMapping && (
            <button
              type="button"
              className={`scene-scan-refresh ${needsRestart ? 'is-attention' : ''}`}
              data-testid="scene-scan-refresh-btn"
              onClick={handleManualRestart}
              aria-label="Restart scene mapping"
              title="Scan your space again"
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
              title="Minimize above tool selector"
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
                <XeroIcon emoji="🔄" size={12} /> Scan Again
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
              <XeroIcon emoji="🧭" size={14} /> Allow Motion Access
            </button>
          )}

          {/* Interactive 4x3 tile grid that reveals the SPRAY.LAND site logo as you scan around */}
          <div
            className={`scene-scan-window is-logo-reveal ${isCenteredOverlay ? 'is-large' : ''} ${
              logoComplete ? 'is-logo-complete' : ''
            }`}
            data-testid="calibration-logo-reveal"
            data-revealed-tiles={revealedTileCount}
            data-total-tiles={rawSectors.length}
            data-logo-complete={logoComplete ? 'true' : 'false'}
            aria-hidden="true"
          >
            <div className="scene-scan-logo-layer is-ghost">
              <BrandLogo
                variant="lockup"
                tone="dark"
                decorative
                height={isCenteredOverlay ? 44 : 26}
                className="scene-scan-logo-img"
              />
            </div>
            <div className="scene-scan-logo-layer is-vibrant">
              <BrandLogo
                variant="lockup"
                tone="dark"
                decorative
                height={isCenteredOverlay ? 44 : 26}
                className="scene-scan-logo-img"
              />
            </div>
            <div className="scene-scan-grid">
              {rawSectors.map((lit, i) => {
                const revealed = Boolean(lit || logoComplete);
                return (
                  <span
                    key={i}
                    className={`scene-scan-cell ${revealed ? 'scanned' : ''}`}
                    data-revealed={revealed ? 'true' : 'false'}
                  />
                );
              })}
            </div>
            {!logoComplete && (
              <span
                className="scene-scan-dot"
                style={{
                  left: `${(sceneScan?.cursorX ?? 0.5) * 100}%`,
                  top: `${(sceneScan?.cursorY ?? 0.5) * 100}%`
                }}
              />
            )}
          </div>

          <div className="scene-scan-bar">
            <div className="scene-scan-bar-fill" style={{ width: `${progressPct}%` }} />
          </div>

          <div className="scene-scan-hint">{activeHint}</div>

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
              <XeroIcon emoji="🔄" size={10} /> Re-scan View
            </button>
          )}
        </>
      )}
    </div>
  );
}
