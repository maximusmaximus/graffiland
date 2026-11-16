import QRCode from 'qrcode';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMobileLaunchUrl, getWsUrl } from '../utils/device.js';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import { GRAFFITI_PALETTE } from './VoxelEngine3D.js';
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

export default function PairWorkbench3D({ inModal = false }) {
  const wsRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const [pairCode, setPairCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [mobileConnected, setMobileConnected] = useState(false);
  const [liveVoxels, setLiveVoxels] = useState(() => loadSavedPairVoxels());
  const [restoredFromLastSession, setRestoredFromLastSession] = useState(
    () => loadSavedPairVoxels().length > 0
  );
  const [hasClearedBackup, setHasClearedBackup] = useState(false);
  const [liveCursor, setLiveCursor] = useState(null);
  const [liveQuaternion, setLiveQuaternion] = useState(null);
  const [mobileState, setMobileState] = useState({ mode: 'draw', tool: 'brush', color: '#00f5d4' });
  const [pairNotice, setPairNotice] = useState('');

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
          setMobileConnected(true);
          setRestoredFromLastSession(false);
        } else if (msg.type === 'mobile_disconnected') {
          setMobileConnected(false);
          setLiveCursor(null);
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
          setMobileState({
            mode: msg.mode || 'draw',
            tool: msg.tool || 'brush',
            color: msg.color || '#00f5d4'
          });
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
    <div className="pair-layout">
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
            <XeroIcon emoji="🔗" size={20} /> Device Pairing
          </div>
          <span className={`badge ${mobileConnected ? 'teal' : 'gold'}`}>
            {mobileConnected ? 'Live Phone Paired' : 'Waiting for Phone'}
          </span>
        </div>

        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Scan this QR code on your mobile phone or enter the Pair Code inside the mobile app so
          your phone becomes a pure 3D brush while your full sculpture renders live here.
        </p>

        {qrDataUrl && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <img
              src={qrDataUrl}
              alt="Pair QR Code"
              style={{
                width: 190,
                height: 190,
                borderRadius: 14,
                border: '1px solid rgba(0, 245, 212, 0.35)'
              }}
            />
          </div>
        )}

        <div
          className="mono"
          style={{
            textAlign: 'center',
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: '0.2em',
            color: 'var(--accent)',
            padding: '10px 0',
            background: 'rgba(0, 245, 212, 0.08)',
            borderRadius: 12,
            border: '1px solid rgba(0, 245, 212, 0.28)'
          }}
        >
          {pairCode || '......'}
        </div>

        <button className="btn" onClick={startSession}>
          <XeroIcon emoji="🔄" size={15} /> New Pair Code
        </button>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Remote Phone Brush Controls
          </div>
          {pairNotice && (
            <div
              role="status"
              aria-live="polite"
              style={{
                marginBottom: 8,
                padding: '7px 10px',
                borderRadius: 10,
                background: 'rgba(255, 209, 102, 0.14)',
                border: '1px solid rgba(255, 209, 102, 0.45)',
                fontSize: 12,
                color: '#ffe8a3',
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}
            >
              <XeroIcon emoji="🔒" size={13} />
              <span>{pairNotice}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              className={`btn ${mobileState.tool === 'brush' ? 'btn-primary' : ''} ${!pairAvailability.brush.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.brush.usable || undefined}
              title={pairAvailability.brush.usable ? 'Switch phone to 3D Brush' : pairAvailability.brush.reason}
              onClick={() => runPairAction('brush', 'set_tool', { tool: 'brush' })}
            >
              <XeroIcon emoji="🖌️" size={14} /> Brush
            </button>
            <button
              className={`btn ${mobileState.tool === 'stack' ? 'btn-primary' : ''} ${!pairAvailability.stack.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.stack.usable || undefined}
              title={pairAvailability.stack.usable ? 'Switch phone to Stack mode' : pairAvailability.stack.reason}
              onClick={() => runPairAction('stack', 'set_tool', { tool: 'stack' })}
            >
              <XeroIcon emoji="🧱" size={14} /> Stack
            </button>
            <button
              className={`btn ${mobileState.tool === 'erase' ? 'btn-pink' : ''} ${!pairAvailability.erase.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.erase.usable || undefined}
              title={pairAvailability.erase.usable ? 'Switch phone to Erase mode' : pairAvailability.erase.reason}
              onClick={() => runPairAction('erase', 'set_tool', { tool: 'erase' })}
            >
              <XeroIcon emoji="🧽" size={14} /> Erase
            </button>
            <button
              className={`btn ${!pairAvailability.undo.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.undo.usable || undefined}
              title={pairAvailability.undo.usable ? 'Undo last block on phone' : pairAvailability.undo.reason}
              onClick={() => runPairAction('undo', 'undo')}
            >
              <XeroIcon emoji="↩️" size={14} /> Undo
            </button>
            <button
              className={`btn ${!pairAvailability.recenter.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.recenter.usable || undefined}
              title={pairAvailability.recenter.usable ? 'Recenter phone gyroscope aim' : pairAvailability.recenter.reason}
              onClick={() => runPairAction('recenter', 'recenter')}
            >
              <XeroIcon emoji="🧭" size={14} /> Recenter
            </button>
            <button
              className={`btn ${mobileState.mode === 'preview' ? 'btn-primary' : ''} ${!pairAvailability.preview.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.preview.usable || undefined}
              title={pairAvailability.preview.usable ? 'Toggle AR Preview on phone' : pairAvailability.preview.reason}
              onClick={() =>
                runPairAction('preview', 'set_mode', {
                  mode: mobileState.mode === 'preview' ? 'draw' : 'preview'
                })
              }
            >
              <XeroIcon emoji="👁️" size={14} /> AR Preview
            </button>
            <button
              className={`btn btn-pink ${!pairAvailability.publish.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.publish.usable || undefined}
              title={pairAvailability.publish.usable ? 'Open Publish sheet on phone' : pairAvailability.publish.reason}
              onClick={() => runPairAction('publish', 'set_mode', { mode: 'publish' })}
            >
              <XeroIcon emoji="🚀" size={14} /> Open Publish
            </button>
            <button
              className={`btn btn-danger ${!pairAvailability.clear.usable ? 'is-unavailable' : ''}`}
              aria-disabled={!pairAvailability.clear.usable || undefined}
              title={pairAvailability.clear.usable ? 'Clear phone canvas' : pairAvailability.clear.reason}
              onClick={() => runPairAction('clear', 'clear')}
            >
              <XeroIcon emoji="🗑️" size={14} /> Clear
            </button>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {GRAFFITI_PALETTE.map((hex) => (
              <button
                key={hex}
                className={`swatch ${mobileState.color === hex ? 'active' : ''} ${!pairAvailability.palette.usable ? 'is-unavailable' : ''}`}
                style={{ backgroundColor: hex }}
                aria-disabled={!pairAvailability.palette.usable || undefined}
                title={pairAvailability.palette.usable ? `Select color ${hex}` : pairAvailability.palette.reason}
                onClick={() => runPairAction('palette', 'set_color', { color: hex })}
              />
            ))}
          </div>
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
          height={inModal ? 480 : 540}
          autoRotate={false}
          liveCursor={liveCursor}
          liveQuaternion={liveQuaternion}
        />
      </div>
    </div>
  );
}
