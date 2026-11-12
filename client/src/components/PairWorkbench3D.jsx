import QRCode from 'qrcode';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getMobileLaunchUrl, getWsUrl } from '../utils/device.js';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import { GRAFFITI_PALETTE } from './VoxelEngine3D.js';
import XeroIcon from './XeroIcon.jsx';

export default function PairWorkbench3D() {
  const wsRef = useRef(null);
  const [pairCode, setPairCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [mobileConnected, setMobileConnected] = useState(false);
  const [liveVoxels, setLiveVoxels] = useState([]);
  const [liveCursor, setLiveCursor] = useState(null);
  const [liveQuaternion, setLiveQuaternion] = useState(null);
  const [mobileState, setMobileState] = useState({ mode: 'draw', tool: 'brush', color: '#00f5d4' });

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
        } else if (msg.type === 'mobile_disconnected') {
          setMobileConnected(false);
          setLiveCursor(null);
        } else if (msg.type === 'voxels_sync') {
          setLiveVoxels(msg.voxels || []);
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
    return () => wsRef.current?.close();
  }, [startSession]);

  function sendCommand(action, extra = {}) {
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
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              className={`btn ${mobileState.tool === 'brush' ? 'btn-primary' : ''}`}
              disabled={!mobileConnected}
              onClick={() => sendCommand('set_tool', { tool: 'brush' })}
            >
              <XeroIcon emoji="🖌️" size={14} /> Brush
            </button>
            <button
              className={`btn ${mobileState.tool === 'stack' ? 'btn-primary' : ''}`}
              disabled={!mobileConnected}
              onClick={() => sendCommand('set_tool', { tool: 'stack' })}
            >
              <XeroIcon emoji="🧱" size={14} /> Stack
            </button>
            <button
              className={`btn ${mobileState.tool === 'erase' ? 'btn-pink' : ''}`}
              disabled={!mobileConnected}
              onClick={() => sendCommand('set_tool', { tool: 'erase' })}
            >
              <XeroIcon emoji="🗑️" size={14} /> Erase
            </button>
            <button
              className="btn"
              disabled={!mobileConnected}
              onClick={() => sendCommand('undo')}
            >
              <XeroIcon emoji="↩️" size={14} /> Undo
            </button>
            <button
              className="btn"
              disabled={!mobileConnected}
              onClick={() => sendCommand('recenter')}
            >
              <XeroIcon emoji="🧭" size={14} /> Recenter
            </button>
            <button
              className={`btn ${mobileState.mode === 'preview' ? 'btn-primary' : ''}`}
              disabled={!mobileConnected}
              onClick={() =>
                sendCommand('set_mode', {
                  mode: mobileState.mode === 'preview' ? 'draw' : 'preview'
                })
              }
            >
              <XeroIcon emoji="👁️" size={14} /> AR Preview
            </button>
            <button
              className="btn btn-pink"
              disabled={!mobileConnected}
              onClick={() => sendCommand('set_mode', { mode: 'publish' })}
            >
              <XeroIcon emoji="🚀" size={14} /> Open Publish
            </button>
            <button
              className="btn btn-danger"
              disabled={!mobileConnected}
              onClick={() => sendCommand('clear')}
            >
              <XeroIcon emoji="🧹" size={14} /> Clear
            </button>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {GRAFFITI_PALETTE.map((hex) => (
              <button
                key={hex}
                className={`swatch ${mobileState.color === hex ? 'active' : ''}`}
                style={{ backgroundColor: hex }}
                disabled={!mobileConnected}
                onClick={() => sendCommand('set_color', { color: hex })}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
            <XeroIcon emoji="🖥️" size={20} /> Live 3D Sculpture Workbench
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="badge teal">
              <XeroIcon emoji="🧱" size={13} /> {liveVoxels.length} voxels
            </span>
            <span className="badge">
              Mode: {mobileState.mode} · Tool: {mobileState.tool}
            </span>
          </div>
        </div>

        <SculptureViewer3D
          voxels={liveVoxels}
          height={540}
          autoRotate={false}
          liveCursor={liveCursor}
          liveQuaternion={liveQuaternion}
        />
      </div>
    </div>
  );
}
