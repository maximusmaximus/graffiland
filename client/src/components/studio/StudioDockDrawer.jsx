import React from 'react';
import { GRAFFITI_PALETTE } from '../VoxelEngine3D.js';
import XeroIcon from '../XeroIcon.jsx';

export default function StudioDockDrawer({
  quickSculpt,
  dockOpen,
  onToggleDock,
  paletteOpen,
  onTogglePalette,
  mode,
  modeRef,
  tool,
  setMode,
  setTool,
  color,
  setColor,
  material,
  setMaterial,
  reachMeters,
  setReachMeters,
  occlusionEnabled,
  setOcclusionEnabled,
  draftsOpen,
  activeDraftId,
  draftStatusText,
  pairedCode,
  agentOpen,
  agentSessionCode,
  toolAvailability,
  ensureToolUsable,
  getDockHoldHandlers,
  commitTransformAndExit,
  onClearCanvas,
  onToggleTransformLock,
  onUndo,
  onRecenterAim,
  onOpenDraftsSheet,
  onOpenPairModal,
  onOpenAgentHandoff,
  onOpenPublishSheet
}) {
  return (
    <>
      <button
        className="floating-tools-toggle"
        onClick={onToggleDock}
        aria-label="Toggle tools"
        title="Tools"
      >
        <XeroIcon emoji={dockOpen ? '➖' : '🎨'} size={22} />
      </button>

      {dockOpen && paletteOpen && mode === 'draw' && (
        <div className="palette-strip hud-interactive">
          {GRAFFITI_PALETTE.map((hex) => (
            <button
              key={hex}
              className={`swatch ${color === hex ? 'active' : ''}`}
              style={{ backgroundColor: hex }}
              onClick={() => setColor(hex)}
              aria-label={`Color ${hex}`}
            />
          ))}
          <button
            className="dock-btn"
            style={{ width: 28, height: 28 }}
            onClick={() =>
              setMaterial((m) => (m === 'matte' ? 'neon' : m === 'neon' ? 'glass' : 'matte'))
            }
            title={`Material: ${material}`}
          >
            <XeroIcon emoji={material === 'neon' ? '✨' : material === 'glass' ? '🧊' : '🎨'} size={15} />
          </button>
          <button
            className="dock-btn"
            style={{ width: 28, height: 28 }}
            onClick={() => setReachMeters((r) => (r >= 2.8 ? 1.2 : Number((r + 0.6).toFixed(1))))}
            title={`Reach ${reachMeters}m`}
          >
            <XeroIcon emoji="🎯" size={15} />
          </button>
        </div>
      )}

      {dockOpen && (
        <div className="floating-dock hud-interactive">
          <button
            className={`dock-btn ${mode === 'draw' && tool === 'brush' ? 'active' : ''} ${!toolAvailability.brush.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.brush.usable || undefined}
            onClick={() => {
              if (!ensureToolUsable('brush')) return;
              if (modeRef.current === 'transform') {
                commitTransformAndExit('draw', 'brush');
              } else {
                setMode('draw');
                setTool('brush');
              }
            }}
            title={toolAvailability.brush.usable ? '3D Brush' : toolAvailability.brush.reason}
          >
            <XeroIcon emoji="🖌️" size={19} />
          </button>
          <button
            className={`dock-btn ${mode === 'draw' && tool === 'stack' ? 'active' : ''} ${!toolAvailability.stack.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.stack.usable || undefined}
            {...getDockHoldHandlers('stack')}
            onClick={() => {
              if (!ensureToolUsable('stack')) return;
              if (modeRef.current === 'transform') {
                commitTransformAndExit('draw', 'stack');
              } else {
                setMode('draw');
                setTool('stack');
              }
            }}
            aria-label="Stack (Hold to Draw)"
            title={
              toolAvailability.stack.usable
                ? 'Stack Voxels — Tap to select, hold down to continuously stack & draw'
                : toolAvailability.stack.reason
            }
          >
            <XeroIcon emoji="🧱" size={19} />
          </button>
          <button
            className={`dock-btn pink ${mode === 'draw' && tool === 'erase' ? 'active' : ''} ${!toolAvailability.erase.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.erase.usable || undefined}
            {...getDockHoldHandlers('erase')}
            onClick={() => {
              if (!ensureToolUsable('erase')) return;
              if (modeRef.current === 'transform') {
                commitTransformAndExit('draw', 'erase');
              } else {
                setMode('draw');
                setTool('erase');
              }
            }}
            aria-label="Eraser (Hold to Erase)"
            title={
              toolAvailability.erase.usable
                ? 'Eraser — Tap to select, hold down to continuously erase'
                : toolAvailability.erase.reason
            }
          >
            <XeroIcon emoji="🧽" size={19} />
          </button>
          <button
            className={`dock-btn pink ${!toolAvailability.clear.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.clear.usable || undefined}
            onClick={onClearCanvas}
            aria-label="Trash Bin — Erase Current Canvas"
            title={
              toolAvailability.clear.usable
                ? 'Trash Bin — Erase Current Canvas'
                : toolAvailability.clear.reason
            }
          >
            <XeroIcon emoji="🗑️" size={19} />
          </button>
          {!quickSculpt && (
            <button
              className={`dock-btn check-btn ${mode === 'transform' ? 'active' : ''} ${!toolAvailability.transform.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!toolAvailability.transform.usable || undefined}
              onClick={onToggleTransformLock}
              aria-label={
                mode === 'transform'
                  ? 'Confirm Transform & Back to Draw'
                  : 'Lock Art to Scale & Transform'
              }
              title={
                !toolAvailability.transform.usable
                  ? toolAvailability.transform.reason
                  : mode === 'transform'
                  ? 'Check — Return to Drawing Mode'
                  : 'Check — Lock Art, Scale & Transform'
              }
            >
              <XeroIcon emoji="✅" size={19} />
            </button>
          )}
          <button
            className={`dock-btn ${paletteOpen ? 'active' : ''} ${!toolAvailability.palette.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.palette.usable || undefined}
            onClick={() => {
              if (!ensureToolUsable('palette')) return;
              onTogglePalette();
            }}
            title={
              toolAvailability.palette.usable ? 'Colors & Finish' : toolAvailability.palette.reason
            }
          >
            <XeroIcon emoji="🎨" size={19} />
          </button>
          <button
            className={`dock-btn ${!toolAvailability.undo.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.undo.usable || undefined}
            onClick={onUndo}
            title={toolAvailability.undo.usable ? 'Undo / Restore Clear' : toolAvailability.undo.reason}
          >
            <XeroIcon emoji="↩️" size={18} />
          </button>
          <button className="dock-btn" onClick={onRecenterAim} title="Recenter Aim">
            <XeroIcon emoji="🧭" size={19} />
          </button>
          {!quickSculpt && (
            <button
              className={`dock-btn ${occlusionEnabled ? 'active' : ''} ${!toolAvailability.occlusion.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!toolAvailability.occlusion.usable || undefined}
              onClick={() => {
                if (!ensureToolUsable('occlusion')) return;
                setOcclusionEnabled((v) => !v);
              }}
              title={
                toolAvailability.occlusion.usable
                  ? 'Toggle Foreground Occlusion'
                  : toolAvailability.occlusion.reason
              }
              aria-label="Toggle Foreground Occlusion"
            >
              <XeroIcon emoji="🪞" size={19} />
            </button>
          )}
          <button
            className={`dock-btn ${mode === 'preview' ? 'active' : ''} ${!toolAvailability.preview.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.preview.usable || undefined}
            onClick={() => {
              if (!ensureToolUsable('preview')) return;
              if (modeRef.current === 'transform') {
                commitTransformAndExit('preview');
              } else {
                setMode((m) => (m === 'preview' ? 'draw' : 'preview'));
              }
            }}
            title={
              toolAvailability.preview.usable
                ? 'AR Preview Nearby Sculptures'
                : toolAvailability.preview.reason
            }
          >
            <XeroIcon emoji="👁️" size={19} />
          </button>
          <button
            className={`dock-btn ${draftsOpen || activeDraftId ? 'active' : ''}`}
            onClick={onOpenDraftsSheet}
            title={draftStatusText ? `Saved Drafts · ${draftStatusText}` : 'Saved Drafts'}
            aria-label="Saved Drafts"
          >
            <XeroIcon emoji="💾" size={19} />
          </button>
          {!quickSculpt && (
            <>
              <button
                className={`dock-btn ${pairedCode ? 'active' : ''}`}
                onClick={onOpenPairModal}
                title="Pair Desktop"
              >
                <XeroIcon emoji="🔗" size={19} />
              </button>
              <button
                className={`dock-btn ${agentOpen || agentSessionCode ? 'active' : ''} ${!toolAvailability.agent.usable ? 'is-unavailable' : ''}`}
                aria-disabled={!toolAvailability.agent.usable || undefined}
                onClick={onOpenAgentHandoff}
                title={
                  toolAvailability.agent.usable ? 'Copy Agent Code' : toolAvailability.agent.reason
                }
                aria-label="Copy Agent Code"
              >
                <XeroIcon emoji="📋" size={19} />
              </button>
            </>
          )}
          <button
            className={`dock-btn ${mode === 'publish' ? 'active' : ''} ${!toolAvailability.publish.usable ? 'is-unavailable' : ''}`}
            aria-disabled={!toolAvailability.publish.usable || undefined}
            onClick={onOpenPublishSheet}
            title={toolAvailability.publish.usable ? 'Publish & Mint' : toolAvailability.publish.reason}
          >
            <XeroIcon emoji="🚀" size={19} />
          </button>
        </div>
      )}
    </>
  );
}
