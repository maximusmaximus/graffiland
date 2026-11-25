import QRCode from 'qrcode';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BLOCK_SIZE_PRESETS,
  STANDARD_COLOR_PRESETS
} from '../../../shared/voxelStroke.mjs';
import { copyToClipboard } from '../utils/clipboard.js';
import { getMobileLaunchUrl, getWsUrl } from '../utils/device.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import XeroIcon from './XeroIcon.jsx';

const PAIR_VOXELS_STORAGE_KEY = 'graffiland_last_pair_voxels_v1';

function loadSavedPairVoxels() {
  try {
    const raw = localStorage.getItem(PAIR_VOXELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function PairWorkbench3D({ inModal = false, onPhonePairedChange = null }) {
  const wsRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const onPhonePairedChangeRef = useRef(onPhonePairedChange);
  onPhonePairedChangeRef.current = onPhonePairedChange;
  const [pairCode, setPairCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [mobileConnected, setMobileConnected] = useState(false);
  const [needsPhoneRepair, setNeedsPhoneRepair] = useState(false);
  const phoneWasConnectedRef = useRef(false);
  const [liveVoxels, setLiveVoxels] = useState(() => loadSavedPairVoxels());
  const [restoredFromLastSession, setRestoredFromLastSession] = useState(
    () => loadSavedPairVoxels().length > 0
  );
  const [hasClearedBackup, setHasClearedBackup] = useState(false);
  const [liveCursor, setLiveCursor] = useState(null);
  const [liveQuaternion, setLiveQuaternion] = useState(null);
  const [mobileState, setMobileState] = useState({
    mode: 'draw',
    tool: 'brush',
    color: '#00f5d4',
    blockSize: 1
  });
  const [pairNotice, setPairNotice] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [showRemoteControls, setShowRemoteControls] = useState(false);
  const mobileLaunchUrl = useMemo(() => getMobileLaunchUrl(pairCode), [pairCode]);

  const startSession = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'create_pair' }));
    };

    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pair_created') {
          setPairCode(msg.code);
          const url = getMobileLaunchUrl(msg.code);
          const qr = await QRCode.toDataURL(url, {
            width: 220,
            margin: 1,
            color: { dark: '#00f5d4', light: '#0b101b' }
          });
          setQrDataUrl(qr);
        } else if (msg.type === 'pair_connected') {
          phoneWasConnectedRef.current = true;
          setMobileConnected(true);
          setNeedsPhoneRepair(false);
          setRestoredFromLastSession(false);
          onPhonePairedChangeRef.current?.(true);
        } else if (msg.type === 'mobile_disconnected') {
          setMobileConnected(false);
          setLiveCursor(null);
          onPhonePairedChangeRef.current?.(false);
          if (phoneWasConnectedRef.current) {
            setNeedsPhoneRepair(true);
            notifySettingsSaved(
              '🔗 Phone disconnected — scan the QR code or enter the Pair Code on your phone to re-pair.',
              { tone: 'warning', durationMs: 6000 }
            );
          }
        } else if (msg.type === 'voxels_sync') {
          const incoming = Array.isArray(msg.voxels) ? msg.voxels : [];
          setLiveVoxels(incoming);
          setRestoredFromLastSession(false);
          try {
            localStorage.setItem(PAIR_VOXELS_STORAGE_KEY, JSON.stringify(incoming.slice(0, 4096)));
          } catch {
            // ignore quota errors
          }
        } else if (msg.type === 'brush_state') {
          setLiveCursor(msg.cursor || null);
          setLiveQuaternion(msg.q || null);
          setMobileState((prev) => ({
            ...prev,
            mode: msg.mode || 'draw',
            tool: msg.tool || 'brush',
            color: msg.color || '#00f5d4',
            ...(msg.blockSize != null ? { blockSize: Number(msg.blockSize) } : {})
          }));
        }
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    startSession();
    return () => {
      clearTimeout(noticeTimerRef.current);
      wsRef.current?.close();
    };
  }, [startSession]);

  useEffect(() => {
    if (liveVoxels.length > 0 && hasClearedBackup) {
      setHasClearedBackup(false);
    }
  }, [liveVoxels.length, hasClearedBackup]);

  const pairAvailability = useMemo(() => {
    const connectReason =
      'Pair your mobile phone first by scanning the QR code or entering the Pair Code.';
    const hasBlocks = liveVoxels.length > 0;
    const blockReason = (verb) =>
      `Place at least 1 block on your mobile phone first before ${verb}.`;

    return {
      brush: { usable: mobileConnected, reason: mobileConnected ? '' : connectReason },
      pencil: { usable: mobileConnected, reason: mobileConnected ? '' : connectReason },
      stack: {
        usable: mobileConnected && hasBlocks,
        reason: !mobileConnected ? connectReason : !hasBlocks ? blockReason('stacking onto block faces') : ''
      },
      erase: {
        usable: mobileConnected && hasBlocks,
        reason: !mobileConnected ? connectReason : !hasBlocks ? blockReason('erasing blocks') : ''
      },
      undo: {
        usable: mobileConnected && (hasBlocks || hasClearedBackup),
        reason: !mobileConnected
          ? connectReason
          : !hasBlocks && !hasClearedBackup
          ? 'Nothing to undo yet — place or clear blocks on your phone first.'
          : ''
      },
      recenter: { usable: mobileConnected, reason: mobileConnected ? '' : connectReason },
      preview: { usable: mobileConnected, reason: mobileConnected ? '' : connectReason },
      publish: {
        usable: mobileConnected && hasBlocks,
        reason: !mobileConnected ? connectReason : !hasBlocks ? blockReason('opening Publish') : ''
      },
      clear: {
        usable: mobileConnected && hasBlocks,
        reason: !mobileConnected
          ? connectReason
          : !hasBlocks
          ? 'Canvas is already empty — draw blocks on your phone first before clearing.'
          : ''
      },
      palette: { usable: mobileConnected, reason: mobileConnected ? '' : connectReason }
    };
  }, [mobileConnected, liveVoxels.length, hasClearedBackup]);

  function notifyPairUnavailable(reason) {
    setPairNotice(reason || 'Complete the prerequisite step first.');
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setPairNotice(''), 4200);
  }

  function runPairAction(key, action, extra = {}) {
    const avail = pairAvailability[key];
    if (avail && !avail.usable) {
      notifyPairUnavailable(avail.reason);
      return;
    }
    setPairNotice('');
    if (action === 'clear' && liveVoxels.length > 0) {
      setHasClearedBackup(true);
    } else if (action === 'undo' && liveVoxels.length === 0 && hasClearedBackup) {
      setHasClearedBackup(false);
    }
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'desktop_command', action, ...extra }));
    }
  }

  return (
    <div className="pair-layout pair-layout-clean">
      <div className="card pair-qr-card">
        <div className="pair-card-head">
          <div className="pair-card-title">
            <XeroIcon emoji="📱" size={18} />
            <span>Phone QR Pairing</span>
          </div>
          <span className={`badge ${mobileConnected ? 'teal' : 'gold'}`}>
            {mobileConnected
              ? '🟢 Phone Connected'
              : needsPhoneRepair
              ? '⚠️ Re-pair Needed'
              : 'Waiting for Phone'}
          </span>
        </div>

        {needsPhoneRepair && !mobileConnected && (
          <div
            className="desktop-repair-banner"
            data-testid="desktop-phone-repair-banner"
            role="alert"
          >
            <span>
              🔗 Your phone disconnected — scan the QR code below or tap <strong>New</strong> to generate a fresh Pair Code and re-pair.
            </span>
            <button
              type="button"
              className="btn btn-xs btn-primary"
              onClick={() => {
                setNeedsPhoneRepair(false);
                startSession();
              }}
            >
              🔄 Fresh Code
            </button>
          </div>
        )}

        <ol className="pair-quick-steps">
          <li><strong>Scan QR</strong> on your phone camera (or open Mobile Studio).</li>
          <li><strong>Sculpt in AR</strong> while watching the live 3D view beside this card.</li>
          <li><strong>Publish on mobile</strong> to mint with GPS Proof-of-Location.</li>
        </ol>

        <div className="pair-qr-stage">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Pair QR Code"
              className="pair-qr-img"
            />
          ) : (
            <div className="pair-qr-skeleton">Generating QR…</div>
          )}
          <div className="pair-code-block">
            <span className="pair-code-label">PAIR CODE</span>
            <div className="pair-code-value mono">{pairCode || '......'}</div>
            <div className="pair-code-actions">
              <button
                type="button"
                className="btn btn-xs btn-outline"
                disabled={!pairCode}
                onClick={async () => {
                  if (!pairCode) return;
                  await copyToClipboard(pairCode);
                  setCopiedCode(true);
                  window.setTimeout(() => setCopiedCode(false), 1600);
                }}
              >
                {copiedCode ? '✓ Copied' : '📋 Copy Code'}
              </button>
              <button type="button" className="btn btn-xs btn-ghost" onClick={startSession}>
                🔄 New
              </button>
              <a
                href={mobileLaunchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-xs btn-outline"
              >
                📱 Open Link ↗
              </a>
            </div>
          </div>
        </div>

        <div className="pair-remote-section">
          <button
            type="button"
            className="pair-remote-toggle"
            aria-expanded={showRemoteControls || mobileConnected}
            onClick={() => setShowRemoteControls((prev) => !prev)}
          >
            <span>🎛️ Remote Phone Brush Controls</span>
            <span>{showRemoteControls || mobileConnected ? '▾' : '▸'}</span>
          </button>

          {(showRemoteControls || mobileConnected) && (
            <div className="pair-remote-body">
              {pairNotice && (
                <div role="status" aria-live="polite" className="pair-remote-notice">
                  <XeroIcon emoji="🔒" size={13} />
                  <span>{pairNotice}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                <button
                  className={`btn btn-xs ${mobileState.tool === 'brush' ? 'btn-primary' : ''} ${!pairAvailability.brush.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.brush.usable || undefined}
                  title={pairAvailability.brush.usable ? 'Switch phone to connected 3D Brush' : pairAvailability.brush.reason}
                  onClick={() => runPairAction('brush', 'set_tool', { tool: 'brush' })}
                >
                  <XeroIcon emoji="🖌️" size={13} /> Brush
                </button>
                <button
                  className={`btn btn-xs ${mobileState.tool === 'pencil' ? 'btn-primary' : ''} ${!pairAvailability.pencil.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.pencil.usable || undefined}
                  title={pairAvailability.pencil.usable ? 'Switch phone to single-block Pencil' : pairAvailability.pencil.reason}
                  onClick={() => runPairAction('pencil', 'set_tool', { tool: 'pencil' })}
                >
                  <XeroIcon emoji="✏️" size={13} /> Pencil
                </button>
                <button
                  className={`btn btn-xs ${mobileState.tool === 'stack' ? 'btn-primary' : ''} ${!pairAvailability.stack.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.stack.usable || undefined}
                  title={pairAvailability.stack.usable ? 'Switch phone to Stack mode' : pairAvailability.stack.reason}
                  onClick={() => runPairAction('stack', 'set_tool', { tool: 'stack' })}
                >
                  <XeroIcon emoji="🧱" size={13} /> Stack
                </button>
                <button
                  className={`btn btn-xs ${mobileState.tool === 'erase' ? 'btn-pink' : ''} ${!pairAvailability.erase.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.erase.usable || undefined}
                  title={pairAvailability.erase.usable ? 'Switch phone to Erase mode' : pairAvailability.erase.reason}
                  onClick={() => runPairAction('erase', 'set_tool', { tool: 'erase' })}
                >
                  <XeroIcon emoji="🧽" size={13} /> Erase
                </button>
                <button
                  className={`btn btn-xs ${!pairAvailability.undo.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.undo.usable || undefined}
                  title={pairAvailability.undo.usable ? 'Undo last block on phone' : pairAvailability.undo.reason}
                  onClick={() => runPairAction('undo', 'undo')}
                >
                  <XeroIcon emoji="↩️" size={13} /> Undo
                </button>
                <button
                  className={`btn btn-xs ${!pairAvailability.recenter.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.recenter.usable || undefined}
                  title={pairAvailability.recenter.usable ? 'Recenter phone gyroscope aim' : pairAvailability.recenter.reason}
                  onClick={() => runPairAction('recenter', 'recenter')}
                >
                  <XeroIcon emoji="🧭" size={13} /> Recenter
                </button>
                <button
                  className={`btn btn-xs ${mobileState.mode === 'preview' ? 'btn-primary' : ''} ${!pairAvailability.preview.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.preview.usable || undefined}
                  title={pairAvailability.preview.usable ? 'Toggle AR Preview on phone' : pairAvailability.preview.reason}
                  onClick={() =>
                    runPairAction('preview', 'set_mode', {
                      mode: mobileState.mode === 'preview' ? 'draw' : 'preview'
                    })
                  }
                >
                  <XeroIcon emoji="👁️" size={13} /> AR Preview
                </button>
                <button
                  className={`btn btn-xs btn-pink ${!pairAvailability.publish.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.publish.usable || undefined}
                  title={pairAvailability.publish.usable ? 'Open Publish sheet on phone' : pairAvailability.publish.reason}
                  onClick={() => runPairAction('publish', 'set_mode', { mode: 'publish' })}
                >
                  <XeroIcon emoji="🚀" size={13} /> Publish
                </button>
                <button
                  className={`btn btn-xs btn-danger ${!pairAvailability.clear.usable ? 'is-unavailable' : ''}`}
                  aria-disabled={!pairAvailability.clear.usable || undefined}
                  title={pairAvailability.clear.usable ? 'Clear phone canvas' : pairAvailability.clear.reason}
                  onClick={() => runPairAction('clear', 'clear')}
                >
                  <XeroIcon emoji="🗑️" size={13} /> Clear
                </button>
              </div>

              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                {BLOCK_SIZE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`btn btn-xs ${Math.abs((mobileState.blockSize || 1) - preset.scale) < 0.05 ? 'btn-primary' : 'btn-outline'} ${!pairAvailability.palette.usable ? 'is-unavailable' : ''}`}
                    aria-disabled={!pairAvailability.palette.usable || undefined}
                    title={pairAvailability.palette.usable ? `Block size ${preset.hint}` : pairAvailability.palette.reason}
                    onClick={() => {
                      setMobileState((prev) => ({ ...prev, blockSize: preset.scale }));
                      runPairAction('palette', 'set_block_size', { blockSize: preset.scale });
                    }}
                  >
                    {preset.label} ({preset.scale}×)
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STANDARD_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.hex}
                    className={`swatch ${mobileState.color === preset.hex ? 'active' : ''} ${!pairAvailability.palette.usable ? 'is-unavailable' : ''}`}
                    style={{ backgroundColor: preset.hex }}
                    aria-disabled={!pairAvailability.palette.usable || undefined}
                    title={pairAvailability.palette.usable ? `Select ${preset.name} (${preset.hex})` : pairAvailability.palette.reason}
                    onClick={() => runPairAction('palette', 'set_color', { color: preset.hex })}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
            <XeroIcon emoji="🖥️" size={20} /> Large Live 3D Drawing View
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge teal">
              <XeroIcon emoji="🧱" size={13} /> {liveVoxels.length} voxels
            </span>
            {restoredFromLastSession && !mobileConnected && liveVoxels.length > 0 && (
              <span className="badge gold">
                <XeroIcon emoji="🕒" size={12} /> Last Session Preview
              </span>
            )}
            <span className="badge">
              Mode: {mobileState.mode} · Tool: {mobileState.tool}
            </span>
          </div>
        </div>

        <SculptureViewer3D
          voxels={liveVoxels}
          height={inModal ? 420 : 540}
          autoRotate={false}
          liveCursor={liveCursor}
          liveQuaternion={liveQuaternion}
        />
      </div>
    </div>
  );
}
