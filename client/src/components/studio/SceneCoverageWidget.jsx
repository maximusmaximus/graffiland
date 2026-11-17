import React from 'react';
import XeroIcon from '../XeroIcon.jsx';

export default function SceneCoverageWidget({
  sceneScan,
  orbStatus,
  scanBoxCollapsed,
  onToggleCollapse,
  dockOpen,
  mode,
  onRefreshOrbRescan
}) {
  return (
    <div
      className={`scene-scan-box hud-interactive ${sceneScan.optimal ? 'optimal' : 'scanning'} ${scanBoxCollapsed ? 'collapsed' : ''} ${dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''}`}
      role="region"
      aria-label="Scene analysis coverage window"
    >
      <div className="scene-scan-header">
        <div className="scene-scan-title">
          <XeroIcon emoji={sceneScan.optimal ? '✅' : '📡'} size={12} />
          <span className="mono">{sceneScan.coveragePct}%</span>
          <span className="scene-scan-tag">
            {sceneScan.optimal ? 'LOCKED' : `${sceneScan.scannedCount}/${sceneScan.targetCount}`}
          </span>
        </div>
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

      {!scanBoxCollapsed && (
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
            ±{sceneScan.precisionMeters.toFixed(2)}m · {orbStatus.engine} ({orbStatus.keyframes}/3)
            {orbStatus.relocalizedInliers > 0 ? ` · ${orbStatus.relocalizedInliers} pts` : ''}
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
    </div>
  );
}
