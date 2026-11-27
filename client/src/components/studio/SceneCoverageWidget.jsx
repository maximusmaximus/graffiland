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
  onRestartMapping = null
}) {
  const { unitSystem } = useMeasurementUnits();
  const needsRestart = Boolean(mappingRestartPrompt);
  const handleManualRestart = () => {
    onRestartMapping?.('manual');
  };
  const handlePromptRestart = () => {
    onRestartMapping?.(mappingRestartPrompt?.reason || 'device_moved');
  };

  return (
    <div
      className={`scene-scan-box hud-interactive ${
        needsRestart ? 'needs-restart' : sceneScan.optimal ? 'optimal' : 'scanning'
      } ${scanBoxCollapsed ? 'collapsed' : ''} ${
        dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''
      }`}
      data-testid="scene-coverage-widget"
      data-needs-restart={needsRestart ? 'true' : 'false'}
      role="region"
      aria-label="Scene analysis coverage window"
    >
      <div className="scene-scan-header">
        <div className="scene-scan-title">
          <XeroIcon emoji={needsRestart ? '⚠️' : sceneScan.optimal ? '✅' : '📡'} size={12} />
          <span className="mono">{sceneScan.coveragePct}%</span>
          <span className="scene-scan-tag">
            {needsRestart
              ? 'MOVED'
              : sceneScan.optimal
              ? 'LOCKED'
              : `${sceneScan.scannedCount}/${sceneScan.targetCount}`}
          </span>
        </div>
        <div className="scene-scan-header-actions">
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
          <button
            type="button"
            className="scene-scan-collapse"
            onClick={onToggleCollapse}
            aria-label={scanBoxCollapsed ? 'Expand scene coverage window' : 'Collapse scene coverage window'}
            title={scanBoxCollapsed ? 'Show scene scan window' : 'Minimize'}
          >
            <XeroIcon emoji={scanBoxCollapsed ? '🔍' : '➖'} size={11} />
          </button>
        </div>
      </div>

      {!scanBoxCollapsed && (
        <>
          {needsRestart ? (
            <div className="scene-scan-restart-banner" data-testid="scene-scan-restart-banner" role="alert">
              <div className="scene-scan-restart-msg">
                {mappingRestartPrompt?.summary || 'Moved spots — tap Restart to rescan.'}
              </div>
              {onRestartMapping && (
                <button
                  type="button"
                  className="scene-scan-restart-btn"
                  data-testid="scene-scan-restart-btn"
                  onClick={handlePromptRestart}
                >
                  <XeroIcon emoji="🔄" size={11} /> Restart Mapping
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="scene-scan-window" aria-hidden="true">
                <div className="scene-scan-grid">
                  {sceneScan.sectors.map((lit, i) => (
                    <span key={i} className={`scene-scan-cell ${lit ? 'scanned' : ''}`} />
                  ))}
                </div>
                <span
                  className="scene-scan-dot"
                  style={{
                    left: `${sceneScan.cursorX * 100}%`,
                    top: `${sceneScan.cursorY * 100}%`
                  }}
                />
              </div>

              <div className="scene-scan-bar">
                <div className="scene-scan-bar-fill" style={{ width: `${sceneScan.coveragePct}%` }} />
              </div>

              <div className="scene-scan-hint">{sceneScan.hint}</div>
              <div className="scene-scan-precision mono">
                ±{formatShortLength(sceneScan.precisionMeters, unitSystem, { decimals: 2, compact: true })} · {orbStatus.engine} ({orbStatus.keyframes}/3)
                {orbStatus.relocalizedInliers > 0 ? ` · ${orbStatus.relocalizedInliers} pts` : ''}
                {orbStatus.packStatus === 'no_pack' ? ' · Scan space on mobile to calibrate Visual Match' : ''}
              </div>
              {mode === 'preview' && onRefreshOrbRescan && (
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
        </>
      )}
    </div>
  );
}
