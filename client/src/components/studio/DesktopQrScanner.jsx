import React, { useEffect, useRef, useState } from 'react';
import {
  decodeQrFromCanvas,
  decodeQrFromImageFile,
  parseDesktopPairQrText
} from '../../utils/qrPairScanner.js';
import XeroIcon from '../XeroIcon.jsx';

/**
 * Mobile QR scanner for Desktop Pair QR codes (?pair=ABC123 or raw 6-char code).
 * Reuses the active MobileStudio AR rear camera <video> when live to avoid iOS dual-stream
 * conflicts, falls back to its own getUserMedia stream if needed, and also supports photo capture.
 */
export default function DesktopQrScanner({
  existingVideoRef = null,
  onCameraRefreshNeeded = null,
  onDetected,
  onClose
}) {
  const canvasRef = useRef(null);
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const openedOwnStreamRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  const onCameraRefreshNeededRef = useRef(onCameraRefreshNeeded);
  const cameraActiveRef = useRef(false);
  const [statusText, setStatusText] = useState('Point camera at Desktop Pair QR code…');
  const [errorText, setErrorText] = useState('');
  const [cameraActive, setCameraActive] = useState(false);

  useEffect(() => {
    onDetectedRef.current = onDetected;
    onCameraRefreshNeededRef.current = onCameraRefreshNeeded;
  }, [onDetected, onCameraRefreshNeeded]);

  useEffect(() => {
    let active = true;
    let rafId = 0;
    let lastDecodeAt = 0;
    let decoding = false;

    const getSourceVideo = () => {
      const existing = existingVideoRef?.current;
      if (existing && existing.readyState >= 2 && existing.videoWidth > 0) {
        return existing;
      }
      const local = localVideoRef.current;
      if (local && local.readyState >= 2 && local.videoWidth > 0) {
        return local;
      }
      return null;
    };

    const markCameraActive = () => {
      if (!cameraActiveRef.current) {
        cameraActiveRef.current = true;
        setCameraActive(true);
      }
    };

    const startOwnCameraIfNeeded = async () => {
      if (getSourceVideo()) {
        markCameraActive();
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorText('Live camera unavailable — use "Scan QR Photo" below or enter the 6-char code.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        openedOwnStreamRef.current = true;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          await localVideoRef.current.play().catch(() => {});
        }
        markCameraActive();
      } catch {
        if (active) {
          setErrorText('Camera blocked. Allow Camera in phone Settings, or tap "Scan QR Photo".');
        }
      }
    };

    const tick = async () => {
      if (!active) return;
      const vid = getSourceVideo();
      const canvas = canvasRef.current;
      if (vid && canvas) {
        markCameraActive();
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          // Center-crop square from live video feed
          const vw = vid.videoWidth || 640;
          const vh = vid.videoHeight || 480;
          const side = Math.min(vw, vh);
          const sx = Math.floor((vw - side) / 2);
          const sy = Math.floor((vh - side) / 2);
          ctx.drawImage(vid, sx, sy, side, side, 0, 0, w, h);

          const now = Date.now();
          if (!decoding && now - lastDecodeAt >= 220) {
            decoding = true;
            lastDecodeAt = now;
            try {
              const raw = await decodeQrFromCanvas(canvas, ctx);
              if (active && raw) {
                const parsed = parseDesktopPairQrText(raw);
                if (parsed) {
                  setStatusText(`Detected code ${parsed.code}!`);
                  onDetectedRef.current?.(parsed);
                  return;
                }
                setStatusText('QR detected, but it is not a SPRAY.LAND Pair code.');
              }
            } finally {
              decoding = false;
            }
          }
        }
      }
      if (active) {
        if (typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(tick);
        }
      }
    };

    startOwnCameraIfNeeded().then(() => {
      if (active && typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(tick);
      }
    });

    return () => {
      active = false;
      cameraActiveRef.current = false;
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      if (openedOwnStreamRef.current) {
        openedOwnStreamRef.current = false;
        onCameraRefreshNeededRef.current?.({ reason: 'qr_scanner_closed', force: true });
      }
    };
  }, [existingVideoRef]);

  const handlePhotoFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    onCameraRefreshNeededRef.current?.({ reason: 'qr_photo_captured', force: true });
    if (!file) return;
    setErrorText('');
    setStatusText('Scanning QR photo…');
    try {
      const raw = await decodeQrFromImageFile(file);
      const parsed = parseDesktopPairQrText(raw);
      if (!parsed) {
        setErrorText('No SPRAY.LAND Pair QR code found in that image. Try a clearer shot.');
        setStatusText('Point camera at Desktop Pair QR code…');
        return;
      }
      setStatusText(`Detected code ${parsed.code}!`);
      onDetected?.(parsed);
    } catch (err) {
      setErrorText(err?.message || 'Could not scan QR image.');
    }
  };

  return (
    <div className="qr-scanner-box" data-testid="desktop-qr-scanner">
      <div className="qr-scanner-head">
        <span style={{ fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <XeroIcon emoji="📷" size={14} /> Scan Desktop QR Code
        </span>
        {onClose && (
          <button type="button" className="btn btn-xs" onClick={onClose}>
            Close Scanner
          </button>
        )}
      </div>

      <video ref={localVideoRef} playsInline muted style={{ display: 'none' }} />

      <div className="qr-scanner-viewport">
        <canvas ref={canvasRef} width={320} height={320} className="qr-scanner-canvas" />
        <div className="qr-scanner-reticle" aria-hidden="true">
          <span className="qr-corner tl" />
          <span className="qr-corner tr" />
          <span className="qr-corner bl" />
          <span className="qr-corner br" />
        </div>
        {!cameraActive && !errorText && (
          <div className="qr-scanner-placeholder">Starting camera viewfinder…</div>
        )}
      </div>

      <div className="qr-scanner-status">{errorText || statusText}</div>

      <div className="qr-scanner-actions">
        <label className="btn btn-xs btn-outline" style={{ cursor: 'pointer' }}>
          <XeroIcon emoji="🖼️" size={13} /> Scan QR Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={handlePhotoFile}
          />
        </label>
      </div>
    </div>
  );
}
