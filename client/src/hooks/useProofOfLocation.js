import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { OrbLandmarkTracker } from '../utils/orbTracker.js';
import { isWebAuthnSupported, registerHardwarePasskey } from '../utils/passkeyClient.js';
import { ProofOfLocationTracker } from '../components/ProofOfLocation.js';
import { computeSolarLightVector } from '../components/VoxelEngine3D.js';

/**
 * Manages mobile camera feed, GPS watch, iOS/Android DeviceOrientation (with graceful
 * touch-drag fallback when gyro is denied), Proof-of-Location coverage, WebXR probe,
 * ORB keyframes, and WebAuthn biometric passkey status.
 */
export function useProofOfLocation({
  user,
  dirLightRef,
  onLocationUpdate
}) {
  const videoRef = useRef(null);
  const polRef = useRef(new ProofOfLocationTracker());
  const orbTrackerRef = useRef(new OrbLandmarkTracker());
  const orbKeyframesRef = useRef(new Map());
  const orbPackCacheRef = useRef(new Map());
  const latestOrbProofRef = useRef(null);

  const rawOrientationRef = useRef(null);
  const yawOffsetRef = useRef(0);
  const fallbackEulerRef = useRef({ yaw: 0, pitch: 0 });
  const cameraStreamRef = useRef(null);
  const locationRef = useRef(null);
  const cameraReadyRef = useRef(false);
  const onLocationUpdateRef = useRef(onLocationUpdate);

  useEffect(() => {
    onLocationUpdateRef.current = onLocationUpdate;
  }, [onLocationUpdate]);

  const [cameraReady, setCameraReady] = useState(false);
  const [sensorBanner, setSensorBanner] = useState('');
  const [needsGyroTap, setNeedsGyroTap] = useState(false);
  const [gyroFallbackActive, setGyroFallbackActive] = useState(false);
  const [location, setLocation] = useState(null);
  const [polStats, setPolStats] = useState({ frames: 0, gyro: 0, flow: 0 });
  const [sceneScan, setSceneScan] = useState({
    coveragePct: 0,
    scannedCount: 0,
    targetCount: 9,
    sectors: Array(12).fill(false),
    cursorX: 0.5,
    cursorY: 0.5,
    optimal: false,
    precisionMeters: 2.4,
    hint: 'Move phone around scene'
  });
  const [scanBoxCollapsed, setScanBoxCollapsed] = useState(false);
  const [unmappedGrid, setUnmappedGrid] = useState(() => Array(48).fill(false));
  const [orbStatus, setOrbStatus] = useState({
    keyframes: 0,
    features: 0,
    relocalizedInliers: 0,
    reprojErrPx: null,
    engine: 'Gyro+ORB'
  });
  const [passkeyCount, setPasskeyCount] = useState(0);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const lastUnmappedMaskRef = useRef('');
  const mappingCompletedNoticeShownRef = useRef(false);
  const lastScanUiRef = useRef({
    coveragePct: -1,
    scannedCount: -1,
    optimal: false,
    cursorX: -1,
    cursorY: -1,
    hint: ''
  });

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  const enterFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  const initCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setSensorBanner('Camera API requires HTTPS on mobile.');
      return;
    }
    try {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
        setCameraReady(true);
        cameraReadyRef.current = true;
        setSensorBanner('');
      }
    } catch (err) {
      setCameraReady(false);
      cameraReadyRef.current = false;
      setSensorBanner(`Camera access needed for 3D AR & Proof of Location (${err.message})`);
    }
  }, []);

  useEffect(() => {
    initCamera();

    const samplerId = setInterval(() => {
      if (videoRef.current && videoRef.current.readyState >= 2) {
        const snap = polRef.current.sampleCameraFrame(videoRef.current);
        if (snap) {
          setPolStats({
            frames: snap.cameraFrames,
            gyro: snap.gyroSamples,
            flow: Math.round(snap.opticalFlowCorrelation * 100)
          });
          const cov = polRef.current.getSceneCoverage();
          lastScanUiRef.current = {
            coveragePct: cov.coveragePct,
            scannedCount: cov.scannedCount,
            optimal: cov.optimal,
            cursorX: cov.cursorX,
            cursorY: cov.cursorY,
            hint: cov.hint
          };
          setSceneScan(cov);
        }
      }
    }, 450);

    return () => {
      clearInterval(samplerId);
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((t) => t.stop());
        cameraStreamRef.current = null;
      }
    };
  }, [initCamera]);

  useEffect(() => {
    let active = true;
    const tracker = orbTrackerRef.current;
    if (typeof navigator !== 'undefined' && navigator.xr?.isSessionSupported) {
      navigator.xr
        .isSessionSupported('immersive-ar')
        .then((supported) => {
          if (active && supported) {
            setOrbStatus((prev) => ({ ...prev, engine: 'WebXR+ORB' }));
          }
        })
        .catch(() => {});
    }
    return () => {
      active = false;
      tracker?.dispose();
    };
  }, []);

  const refreshPasskeyStatus = useCallback(async () => {
    if (!user?.id) {
      setPasskeyCount(0);
      return 0;
    }
    try {
      const res = await api.getPasskeyStatus();
      const cnt = (res?.passkeys || []).length;
      setPasskeyCount(cnt);
      return cnt;
    } catch {
      return 0;
    }
  }, [user?.id]);

  useEffect(() => {
    refreshPasskeyStatus();
  }, [refreshPasskeyStatus]);

  const handleEnrollPasskey = useCallback(async () => {
    if (!user?.id || !isWebAuthnSupported()) return false;
    setPasskeyBusy(true);
    try {
      await registerHardwarePasskey('Mobile Biometric Passkey');
      await refreshPasskeyStatus();
      return true;
    } finally {
      setPasskeyBusy(false);
    }
  }, [refreshPasskeyStatus, user?.id]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setSensorBanner('GPS Geolocation not supported on this browser.');
      return undefined;
    }

    let lastFetchAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        polRef.current.recordGps(pos);
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
        const refined = polRef.current.getRefinedLocation(loc) || loc;
        setLocation(refined);
        locationRef.current = refined;

        if (dirLightRef.current) {
          const sun = computeSolarLightVector(loc.lat, loc.lng, new Date());
          dirLightRef.current.position.set(sun.x, sun.y, sun.z);
          dirLightRef.current.intensity = sun.isDaylight ? 1.55 : 0.95;
        }

        const now = Date.now();
        if (now - lastFetchAt > 12000) {
          lastFetchAt = now;
          try {
            await onLocationUpdateRef.current?.(loc, refined);
          } catch {
            // ignore offline fetch retry
          }
        }
      },
      (err) => {
        setSensorBanner(`GPS permission required for Virtual Land (${err.message})`);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [dirLightRef]);

  const attachOrientation = useCallback(() => {
    const handler = (e) => {
      if (e.alpha === null && e.beta === null) return;
      rawOrientationRef.current = {
        alpha: e.alpha || 0,
        beta: e.beta || 0,
        gamma: e.gamma || 0
      };
      setGyroFallbackActive(false);
      polRef.current.recordGyro(e.alpha, e.beta, e.gamma);
    };
    window.addEventListener('deviceorientation', handler, true);
    return () => window.removeEventListener('deviceorientation', handler, true);
  }, []);

  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      setNeedsGyroTap(true);
      return undefined;
    }
    const detach = attachOrientation();
    const fallbackProbe = setTimeout(() => {
      if (!rawOrientationRef.current) {
        setGyroFallbackActive(true);
      }
    }, 2400);
    return () => {
      clearTimeout(fallbackProbe);
      detach();
    };
  }, [attachOrientation]);

  const enableIosGyro = useCallback(async () => {
    enterFullscreen();
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') {
        setNeedsGyroTap(false);
        setGyroFallbackActive(false);
        attachOrientation();
      } else {
        setNeedsGyroTap(false);
        setGyroFallbackActive(true);
        setSensorBanner('Gyroscope permission denied; drag screen to aim 3D brush.');
      }
    } catch {
      setNeedsGyroTap(false);
      setGyroFallbackActive(true);
      setSensorBanner('Gyroscope unavailable on this browser; drag screen to aim 3D brush.');
    }
  }, [attachOrientation, enterFullscreen]);

  const recenterAim = useCallback(() => {
    if (rawOrientationRef.current) {
      yawOffsetRef.current = rawOrientationRef.current.alpha;
    } else {
      fallbackEulerRef.current = { yaw: 0, pitch: 0 };
    }
  }, []);

  const resetOrbKeyframes = useCallback(() => {
    orbKeyframesRef.current.clear();
    setOrbStatus((prev) => ({ ...prev, keyframes: 0, features: 0 }));
  }, []);

  return {
    videoRef,
    polRef,
    orbTrackerRef,
    orbKeyframesRef,
    orbPackCacheRef,
    latestOrbProofRef,
    rawOrientationRef,
    yawOffsetRef,
    fallbackEulerRef,
    locationRef,
    cameraReadyRef,
    cameraReady,
    retryCameraAccess: initCamera,
    sensorBanner,
    setSensorBanner,
    needsGyroTap,
    gyroFallbackActive,
    enableIosGyro,
    recenterAim,
    location,
    setLocation,
    polStats,
    sceneScan,
    setSceneScan,
    scanBoxCollapsed,
    setScanBoxCollapsed,
    unmappedGrid,
    setUnmappedGrid,
    lastUnmappedMaskRef,
    mappingCompletedNoticeShownRef,
    lastScanUiRef,
    orbStatus,
    setOrbStatus,
    resetOrbKeyframes,
    passkeyCount,
    setPasskeyCount,
    passkeyBusy,
    refreshPasskeyStatus,
    handleEnrollPasskey,
    enterFullscreen
  };
}
