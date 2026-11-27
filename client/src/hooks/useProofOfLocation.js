import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import {
  CALIBRATION_MIN_SECTORS,
  buildCalibrationLossDetails,
  createCalibrationHealthState,
  evaluateCalibrationReadiness,
  isSessionOrbRelockMatch,
  stepCalibrationHealthMonitor
} from '../utils/arCalibrationManager.js';
import {
  acquireRearCameraStream,
  flushVideoElement,
  getRetryBackoffMs,
  getWatchdogCooldownMs,
  inspectCameraFeedHealth,
  isAutoplayBlockedError,
  isPermissionDeniedError,
  isTransientHardwareError,
  stopMediaStreamTracks
} from '../utils/cameraRecovery.js';
import {
  describeCameraError,
  describeGeolocationError,
  describeHttpsRequiredError,
  describeMotionError
} from '../utils/permissionMessages.js';
import { tryLockPortraitOrientation } from '../utils/mobilePortraitLock.js';
import { OrbLandmarkTracker } from '../utils/orbTracker.js';
import { isWebAuthnSupported, registerHardwarePasskey } from '../utils/passkeyClient.js';
import {
  ArOrientationFusion,
  ArPositionKalmanFilter
} from '../utils/arSensorFusion.js';
import { ArSpatialDrawTracker } from '../utils/arSpatialDrawTracker.js';
import { isWebXrArSupported } from '../utils/webxrArSession.js';
import { ProofOfLocationTracker } from '../components/ProofOfLocation.js';
import { computeSolarLightVector } from '../components/VoxelEngine3D.js';

/**
 * Manages mobile camera feed (with disconnect/reconnect, background/foreground,
 * track-ended, and frozen-frame auto-recovery), GPS watch, iOS/Android DeviceOrientation
 * (with graceful touch-drag fallback when gyro is denied), Proof-of-Location coverage,
 * WebXR probe, ORB keyframes, and WebAuthn biometric passkey status.
 */
export function useProofOfLocation({
  user,
  dirLightRef,
  onLocationUpdate,
  onCameraRefreshed = null,
  onNetworkReconnect = null,
  mappingPausedRef = null,
  cameraSuspendedRef = null
}) {
  const videoRef = useRef(null);
  const polRef = useRef(new ProofOfLocationTracker());
  const orbTrackerRef = useRef(new OrbLandmarkTracker());
  const orbKeyframesRef = useRef(new Map());
  const orbPackCacheRef = useRef(new Map());
  const latestOrbProofRef = useRef(null);

  const rawOrientationRef = useRef(null);
  const yawOffsetRef = useRef(0);
  const draftYawOffsetRef = useRef(0);
  const orientationFusionRef = useRef(new ArOrientationFusion());
  const positionFilterRef = useRef(new ArPositionKalmanFilter());
  const spatialDrawTrackerRef = useRef(new ArSpatialDrawTracker());
  const orientationDetachRef = useRef(null);
  const webxrActiveRef = useRef(false);
  const fallbackEulerRef = useRef({ yaw: 0, pitch: 0 });
  const cameraStreamRef = useRef(null);
  const locationRef = useRef(null);
  const cameraReadyRef = useRef(false);
  const onLocationUpdateRef = useRef(onLocationUpdate);
  const onCameraRefreshedRef = useRef(onCameraRefreshed);
  const onNetworkReconnectRef = useRef(onNetworkReconnect);
  const mappingPausedBridgeRef = useRef(mappingPausedRef);
  const cameraSuspendedBridgeRef = useRef(cameraSuspendedRef);

  const cameraOpIdRef = useRef(0);
  const unmountedRef = useRef(false);
  const tearingDownCameraRef = useRef(false);
  const inFlightCameraRef = useRef(null);
  const lastRefreshStartAtRef = useRef(0);
  const streamStartedAtRef = useRef(0);
  const trackMutedSinceRef = useRef(0);
  const trackCleanupRef = useRef(null);
  const videoCleanupRef = useRef(null);
  const boundVideoElRef = useRef(null);
  const gestureResumeCleanupRef = useRef(null);
  const rvfcCleanupRef = useRef(null);
  const rvfcFrameCountRef = useRef(0);
  const healthSampleRef = useRef(null);
  const cameraRetryTimerRef = useRef(null);
  const cameraRetryAttemptRef = useRef(0);
  const watchdogRestartCountRef = useRef(0);
  const lastWatchdogRestartAtRef = useRef(0);
  const permissionBlockedRef = useRef(false);
  const needsRefreshOnVisibleRef = useRef(false);
  const wasHiddenRef = useRef(false);
  const wasOfflineRef = useRef(false);
  const hasEverStartedCameraRef = useRef(false);
  const refreshCameraRef = useRef(null);
  const ensureCameraLiveRef = useRef(null);
  const refreshLocationNowRef = useRef(null);
  const lastManualGpsRefreshAtRef = useRef(0);

  useEffect(() => {
    onLocationUpdateRef.current = onLocationUpdate;
    onCameraRefreshedRef.current = onCameraRefreshed;
    onNetworkReconnectRef.current = onNetworkReconnect;
    mappingPausedBridgeRef.current = mappingPausedRef;
    cameraSuspendedBridgeRef.current = cameraSuspendedRef;
  }, [onLocationUpdate, onCameraRefreshed, onNetworkReconnect, mappingPausedRef, cameraSuspendedRef]);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraRecovering, setCameraRecovering] = useState(false);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  );
  const [sensorBanner, setSensorBanner] = useState('');
  const [needsGyroTap, setNeedsGyroTap] = useState(false);
  const [gyroFallbackActive, setGyroFallbackActive] = useState(false);
  const [location, setLocation] = useState(null);
  const [polStats, setPolStats] = useState({ frames: 0, gyro: 0, flow: 0 });
  const [sceneScan, setSceneScan] = useState({
    coveragePct: 0,
    scannedCount: 0,
    targetCount: CALIBRATION_MIN_SECTORS,
    sectors: Array(12).fill(false),
    cursorX: 0.5,
    cursorY: 0.5,
    relYaw: 0,
    optimal: false,
    precisionMeters: 2.4,
    hint: 'Pan phone slowly around your space'
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
  const [mappingRestartPrompt, setMappingRestartPrompt] = useState(null);
  const [calibrationState, setCalibrationState] = useState('calibrating'); // 'calibrating' | 'relocalizing' | 'calibrated' | 'lost'
  const [calibrationLoss, setCalibrationLoss] = useState(null);
  const [calibrationJustLocked, setCalibrationJustLocked] = useState(false);
  const [calibrationStartedAt, setCalibrationStartedAt] = useState(() => Date.now());
  const [calibrationElapsedTick, setCalibrationElapsedTick] = useState(0);
  const [passkeyCount, setPasskeyCount] = useState(0);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [webxrSupported, setWebxrSupported] = useState(false);
  const [webxrActive, setWebxrActive] = useState(false);
  const [sensorStatus, setSensorStatus] = useState(() =>
    orientationFusionRef.current.getSensorQuality()
  );

  const lastUnmappedMaskRef = useRef('');
  const mappingCompletedNoticeShownRef = useRef(false);
  const mappingRestartPromptRef = useRef(null);
  const calibrationStateRef = useRef('calibrating');
  const calibrationHealthRef = useRef(createCalibrationHealthState());
  const calibratedAnchorLocRef = useRef(null);
  const lastOrientationEventTsRef = useRef(0);
  const hasOrientationHardwareRef = useRef(false);
  const lastLocationTsRef = useRef(0);
  const orbRelockBusyRef = useRef(false);
  const justLockedTimerRef = useRef(null);
  const leaveCheckpointRef = useRef(null);
  const pendingReturnCheckRef = useRef(false);
  const notifyMappingViewLeftRef = useRef(null);
  const notifyMappingViewReturnedRef = useRef(null);
  const lastScanUiRef = useRef({
    coveragePct: -1,
    scannedCount: -1,
    optimal: false,
    cursorX: -1,
    cursorY: -1,
    hint: ''
  });

  useEffect(() => {
    mappingRestartPromptRef.current = mappingRestartPrompt;
  }, [mappingRestartPrompt]);

  useEffect(() => {
    calibrationStateRef.current = calibrationState;
  }, [calibrationState]);

  useEffect(() => {
    return () => {
      if (justLockedTimerRef.current) {
        clearTimeout(justLockedTimerRef.current);
        justLockedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  const refreshLocationNow = useCallback(({ notifyNearby = false, force = false } = {}) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation?.getCurrentPosition) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastManualGpsRefreshAtRef.current < 4000) {
      return;
    }
    lastManualGpsRefreshAtRef.current = now;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (unmountedRef.current) return;
        polRef.current.recordGps(pos);
        orientationFusionRef.current.setLocation(pos.coords.latitude, pos.coords.longitude);
        const kalmanLoc = positionFilterRef.current.updateGps(pos);
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
        const polRefined = polRef.current.getRefinedLocation(loc) || loc;
        const refined = kalmanLoc
          ? {
              ...polRefined,
              lat: kalmanLoc.lat,
              lng: kalmanLoc.lng,
              accuracy: kalmanLoc.accuracy,
              altitude: kalmanLoc.altitude ?? polRefined.altitude,
              speed: kalmanLoc.speed
            }
          : polRefined;
        setLocation(refined);
        locationRef.current = refined;
        lastLocationTsRef.current = Date.now();
        setSensorBanner((prev) =>
          prev && /location|gps/i.test(prev) ? '' : prev
        );
        if (notifyNearby) {
          onLocationUpdateRef.current?.(loc, refined);
        }
      },
      (err) => {
        if (!unmountedRef.current && !locationRef.current) {
          setSensorBanner(describeGeolocationError(err));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
    );
  }, []);
  refreshLocationNowRef.current = refreshLocationNow;

  const enterFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen()
        .then(() => tryLockPortraitOrientation())
        .catch(() => {});
    } else {
      tryLockPortraitOrientation();
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (cameraRetryTimerRef.current) {
      clearTimeout(cameraRetryTimerRef.current);
      cameraRetryTimerRef.current = null;
    }
  }, []);

  const clearGestureResume = useCallback(() => {
    if (gestureResumeCleanupRef.current) {
      gestureResumeCleanupRef.current();
      gestureResumeCleanupRef.current = null;
    }
  }, []);

  const clearRvfcWatcher = useCallback(() => {
    if (rvfcCleanupRef.current) {
      rvfcCleanupRef.current();
      rvfcCleanupRef.current = null;
    }
  }, []);

  const detachTrackListeners = useCallback(() => {
    if (trackCleanupRef.current) {
      trackCleanupRef.current();
      trackCleanupRef.current = null;
    }
  }, []);

  const detachVideoListeners = useCallback(() => {
    if (videoCleanupRef.current) {
      videoCleanupRef.current();
      videoCleanupRef.current = null;
      boundVideoElRef.current = null;
    }
  }, []);

  const startRvfcWatcher = useCallback(
    (videoEl) => {
      clearRvfcWatcher();
      if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') return;
      let cancelled = false;
      let handle = 0;
      const onFrame = () => {
        if (cancelled || unmountedRef.current) return;
        rvfcFrameCountRef.current += 1;
        watchdogRestartCountRef.current = 0;
        try {
          handle = videoEl.requestVideoFrameCallback(onFrame);
        } catch {
          // ignore if video was torn down
        }
      };
      try {
        handle = videoEl.requestVideoFrameCallback(onFrame);
      } catch {
        return;
      }
      rvfcCleanupRef.current = () => {
        cancelled = true;
        if (handle && typeof videoEl.cancelVideoFrameCallback === 'function') {
          try {
            videoEl.cancelVideoFrameCallback(handle);
          } catch {
            // ignore
          }
        }
      };
    },
    [clearRvfcWatcher]
  );

  const bindGesturePlayResume = useCallback(
    (videoEl) => {
      clearGestureResume();
      if (!videoEl || typeof window === 'undefined') return;
      const onGesture = () => {
        clearGestureResume();
        if (unmountedRef.current) return;
        const activeVideo = videoRef.current || videoEl;
        if (!activeVideo) return;
        if (cameraStreamRef.current && activeVideo.srcObject !== cameraStreamRef.current) {
          activeVideo.srcObject = cameraStreamRef.current;
        }
        const playPromise = typeof activeVideo.play === 'function' ? activeVideo.play() : null;
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(() => {
              if (!unmountedRef.current) {
                setCameraReady(true);
                cameraReadyRef.current = true;
                setSensorBanner('');
              }
            })
            .catch(() => {
              refreshCameraRef.current?.({ reason: 'gesture_resume', force: true });
            });
        }
      };
      window.addEventListener('pointerdown', onGesture, { passive: true, once: true });
      window.addEventListener('touchstart', onGesture, { passive: true, once: true });
      window.addEventListener('click', onGesture, { passive: true, once: true });
      gestureResumeCleanupRef.current = () => {
        window.removeEventListener('pointerdown', onGesture);
        window.removeEventListener('touchstart', onGesture);
        window.removeEventListener('click', onGesture);
      };
    },
    [clearGestureResume]
  );

  const attachVideoListeners = useCallback(
    (videoEl) => {
      if (!videoEl || boundVideoElRef.current === videoEl) return;
      detachVideoListeners();
      boundVideoElRef.current = videoEl;

      const onPlaying = () => {
        if (unmountedRef.current || tearingDownCameraRef.current) return;
        if (cameraStreamRef.current) {
          setCameraReady(true);
          cameraReadyRef.current = true;
          setCameraRecovering(false);
          setSensorBanner((prev) =>
            prev === 'Reconnecting camera…' || prev.includes('Camera') ? '' : prev
          );
        }
      };

      const onPause = () => {
        if (unmountedRef.current || tearingDownCameraRef.current) return;
        if (cameraSuspendedBridgeRef.current?.current) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          needsRefreshOnVisibleRef.current = true;
          return;
        }
        if (!cameraStreamRef.current) return;
        const live = cameraStreamRef.current
          .getVideoTracks?.()
          .some((t) => t?.readyState === 'live');
        if (!live) {
          refreshCameraRef.current?.({ reason: 'video_pause_dead_track', force: true });
          return;
        }
        const p = typeof videoEl.play === 'function' ? videoEl.play() : null;
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            if (isAutoplayBlockedError(err)) {
              bindGesturePlayResume(videoEl);
            } else {
              refreshCameraRef.current?.({ reason: 'video_pause_recovery', force: true });
            }
          });
        }
      };

      const onStalledOrError = (ev) => {
        if (unmountedRef.current || tearingDownCameraRef.current) return;
        if (cameraSuspendedBridgeRef.current?.current) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          needsRefreshOnVisibleRef.current = true;
          return;
        }
        if (!cameraStreamRef.current) return;
        refreshCameraRef.current?.({
          reason: `video_${ev?.type || 'stalled'}`,
          force: true
        });
      };

      videoEl.addEventListener('playing', onPlaying);
      videoEl.addEventListener('loadeddata', onPlaying);
      videoEl.addEventListener('pause', onPause);
      videoEl.addEventListener('stalled', onStalledOrError);
      videoEl.addEventListener('emptied', onStalledOrError);
      videoEl.addEventListener('error', onStalledOrError);
      videoEl.addEventListener('abort', onStalledOrError);

      videoCleanupRef.current = () => {
        videoEl.removeEventListener('playing', onPlaying);
        videoEl.removeEventListener('loadeddata', onPlaying);
        videoEl.removeEventListener('pause', onPause);
        videoEl.removeEventListener('stalled', onStalledOrError);
        videoEl.removeEventListener('emptied', onStalledOrError);
        videoEl.removeEventListener('error', onStalledOrError);
        videoEl.removeEventListener('abort', onStalledOrError);
      };
    },
    [bindGesturePlayResume, detachVideoListeners]
  );

  const attachTrackListeners = useCallback(
    (stream) => {
      detachTrackListeners();
      const tracks = typeof stream?.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
      if (!tracks.length) return;

      const cleanups = [];
      for (const track of tracks) {
        if (!track || typeof track.addEventListener !== 'function') continue;

        const onEnded = () => {
          if (
            unmountedRef.current ||
            tearingDownCameraRef.current ||
            cameraStreamRef.current !== stream
          ) {
            return;
          }
          setCameraReady(false);
          cameraReadyRef.current = false;
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            needsRefreshOnVisibleRef.current = true;
            return;
          }
          refreshCameraRef.current?.({ reason: 'track_ended', force: true });
        };

        const onMute = () => {
          if (
            unmountedRef.current ||
            tearingDownCameraRef.current ||
            cameraStreamRef.current !== stream
          ) {
            return;
          }
          if (!trackMutedSinceRef.current) {
            trackMutedSinceRef.current = Date.now();
          }
        };

        const onUnmute = () => {
          if (unmountedRef.current || cameraStreamRef.current !== stream) return;
          trackMutedSinceRef.current = 0;
          const videoEl = videoRef.current;
          if (videoEl && videoEl.paused && typeof videoEl.play === 'function') {
            videoEl.play().catch(() => {});
          }
        };

        track.addEventListener('ended', onEnded);
        track.addEventListener('mute', onMute);
        track.addEventListener('unmute', onUnmute);
        cleanups.push(() => {
          track.removeEventListener('ended', onEnded);
          track.removeEventListener('mute', onMute);
          track.removeEventListener('unmute', onUnmute);
        });
      }

      trackCleanupRef.current = () => {
        for (const fn of cleanups) fn();
      };
    },
    [detachTrackListeners]
  );

  const refreshCamera = useCallback(
    async ({ reason = 'manual', force = false, isWatchdog = false } = {}) => {
      if (unmountedRef.current) return false;

      if (!navigator.mediaDevices?.getUserMedia) {
        setSensorBanner(describeHttpsRequiredError());
        return false;
      }

      if (reason === 'manual') {
        permissionBlockedRef.current = false;
        cameraRetryAttemptRef.current = 0;
        watchdogRestartCountRef.current = 0;
      }

      if (permissionBlockedRef.current && reason !== 'manual') {
        try {
          const perm = await navigator.permissions?.query?.({ name: 'camera' });
          if (perm?.state === 'granted') {
            permissionBlockedRef.current = false;
          } else {
            return false;
          }
        } catch {
          return false;
        }
      }

      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden' &&
        reason !== 'manual'
      ) {
        needsRefreshOnVisibleRef.current = true;
        return false;
      }

      if (inFlightCameraRef.current) {
        const elapsed = Date.now() - lastRefreshStartAtRef.current;
        if (!force || (reason !== 'manual' && elapsed < 280)) {
          return inFlightCameraRef.current;
        }
      }

      clearRetryTimer();
      clearGestureResume();
      clearRvfcWatcher();

      const opId = ++cameraOpIdRef.current;
      lastRefreshStartAtRef.current = Date.now();

      if (hasEverStartedCameraRef.current && reason !== 'initial') {
        setCameraRecovering(true);
      }

      const task = (async () => {
        try {
          tearingDownCameraRef.current = true;
          detachTrackListeners();
          const oldStream = cameraStreamRef.current;
          cameraStreamRef.current = null;
          const videoElBefore = videoRef.current;
          const attachedStream = videoElBefore?.srcObject || null;
          stopMediaStreamTracks(oldStream);
          if (attachedStream && attachedStream !== oldStream) {
            stopMediaStreamTracks(attachedStream);
          }
          flushVideoElement(videoElBefore);
          tearingDownCameraRef.current = false;

          const stream = await acquireRearCameraStream(navigator.mediaDevices);

          if (unmountedRef.current || opId !== cameraOpIdRef.current) {
            stopMediaStreamTracks(stream);
            return false;
          }

          const startedAt = Date.now();
          cameraStreamRef.current = stream;
          hasEverStartedCameraRef.current = true;
          streamStartedAtRef.current = startedAt;
          trackMutedSinceRef.current = 0;
          rvfcFrameCountRef.current = 0;
          healthSampleRef.current = {
            currentTime: 0,
            totalFrames: 0,
            rvfcFrameCount: 0,
            videoWidth: 0,
            videoHeight: 0,
            lastProgressAt: startedAt
          };
          cameraRetryAttemptRef.current = 0;
          permissionBlockedRef.current = false;
          needsRefreshOnVisibleRef.current = false;

          attachTrackListeners(stream);

          const videoEl = videoRef.current;
          if (videoEl) {
            attachVideoListeners(videoEl);
            videoEl.playsInline = true;
            videoEl.muted = true;
            videoEl.autoplay = true;
            videoEl.srcObject = stream;
            try {
              if (typeof videoEl.play === 'function') {
                await videoEl.play();
              }
            } catch (playErr) {
              if (isAutoplayBlockedError(playErr)) {
                bindGesturePlayResume(videoEl);
              }
            }
            if (unmountedRef.current || opId !== cameraOpIdRef.current) {
              return false;
            }
            startRvfcWatcher(videoEl);
            setCameraReady(true);
            cameraReadyRef.current = true;
            setSensorBanner('');
            onCameraRefreshedRef.current?.({ reason, isWatchdog });
          }
          return true;
        } catch (err) {
          tearingDownCameraRef.current = false;
          if (unmountedRef.current || opId !== cameraOpIdRef.current) {
            return false;
          }
          setCameraReady(false);
          cameraReadyRef.current = false;

          if (isPermissionDeniedError(err)) {
            permissionBlockedRef.current = true;
            setSensorBanner(describeCameraError(err));
          } else if (isTransientHardwareError(err)) {
            const backoff = getRetryBackoffMs(cameraRetryAttemptRef.current);
            if (backoff !== null) {
              cameraRetryAttemptRef.current += 1;
              setSensorBanner('Reconnecting camera…');
              cameraRetryTimerRef.current = setTimeout(() => {
                cameraRetryTimerRef.current = null;
                refreshCameraRef.current?.({ reason: 'hardware_retry', force: true });
              }, backoff);
            } else {
              setSensorBanner(describeCameraError(err));
            }
          } else {
            setSensorBanner(describeCameraError(err));
          }
          return false;
        } finally {
          tearingDownCameraRef.current = false;
          if (opId === cameraOpIdRef.current) {
            inFlightCameraRef.current = null;
            setCameraRecovering(false);
          }
        }
      })();

      inFlightCameraRef.current = task;
      return task;
    },
    [
      attachTrackListeners,
      attachVideoListeners,
      bindGesturePlayResume,
      clearGestureResume,
      clearRetryTimer,
      clearRvfcWatcher,
      detachTrackListeners,
      startRvfcWatcher
    ]
  );

  refreshCameraRef.current = refreshCamera;

  const ensureCameraLive = useCallback(
    async ({ reason = 'health_check', allowRestart = true } = {}) => {
      if (unmountedRef.current || inFlightCameraRef.current) return false;
      if (cameraSuspendedBridgeRef.current?.current) return false;
      if (permissionBlockedRef.current) return false;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      if (!navigator.mediaDevices?.getUserMedia) return false;

      const now = Date.now();
      const videoEl = videoRef.current;
      const stream = cameraStreamRef.current;

      const health = inspectCameraFeedHealth(videoEl, stream, healthSampleRef.current, now, {
        streamStartedAt: streamStartedAtRef.current,
        mutedSince: trackMutedSinceRef.current,
        rvfcFrameCount: rvfcFrameCountRef.current
      });
      healthSampleRef.current = health.nextSample;

      if (health.frameAdvanced) {
        watchdogRestartCountRef.current = 0;
      }

      if (health.healthy) {
        if (videoEl) {
          attachVideoListeners(videoEl);
        }
        if (!cameraReadyRef.current && videoEl && videoEl.readyState >= 2) {
          setCameraReady(true);
          cameraReadyRef.current = true;
        }
        return true;
      }

      if (health.action === 'reattach' && videoEl && stream) {
        attachVideoListeners(videoEl);
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.autoplay = true;
        videoEl.srcObject = stream;
        try {
          if (typeof videoEl.play === 'function') {
            await videoEl.play();
          }
          startRvfcWatcher(videoEl);
          setCameraReady(true);
          cameraReadyRef.current = true;
          return true;
        } catch (playErr) {
          if (isAutoplayBlockedError(playErr)) {
            bindGesturePlayResume(videoEl);
            return false;
          }
        }
      }

      if (health.action === 'play' && videoEl) {
        try {
          if (typeof videoEl.play === 'function') {
            await videoEl.play();
          }
          if (!videoEl.paused) {
            setCameraReady(true);
            cameraReadyRef.current = true;
            return true;
          }
        } catch (playErr) {
          if (isAutoplayBlockedError(playErr)) {
            bindGesturePlayResume(videoEl);
            return false;
          }
        }
      }

      if (!allowRestart) return false;

      if (reason === 'watchdog') {
        const cooldown = getWatchdogCooldownMs(watchdogRestartCountRef.current);
        if (now - lastWatchdogRestartAtRef.current < cooldown) {
          return false;
        }
        watchdogRestartCountRef.current += 1;
        lastWatchdogRestartAtRef.current = now;
      }

      return refreshCamera({
        reason: health.reason || reason,
        force: true,
        isWatchdog: reason === 'watchdog'
      });
    },
    [attachVideoListeners, bindGesturePlayResume, refreshCamera, startRvfcWatcher]
  );

  ensureCameraLiveRef.current = ensureCameraLive;

  const reattachVideoStream = useCallback(() => {
    if (unmountedRef.current) return;
    const videoEl = videoRef.current;
    if (!videoEl) return;
    attachVideoListeners(videoEl);
    const stream = cameraStreamRef.current;
    const hasLiveTrack = Boolean(
      stream?.getVideoTracks?.().some((t) => t?.readyState === 'live')
    );
    if (stream && hasLiveTrack) {
      if (videoEl.srcObject !== stream) {
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.autoplay = true;
        videoEl.srcObject = stream;
      }
      if (typeof videoEl.play === 'function') {
        videoEl.play().catch((err) => {
          if (isAutoplayBlockedError(err)) {
            bindGesturePlayResume(videoEl);
          } else {
            refreshCameraRef.current?.({ reason: 'video_remount', force: true });
          }
        });
      }
      startRvfcWatcher(videoEl);
    } else if (hasEverStartedCameraRef.current && !inFlightCameraRef.current) {
      refreshCameraRef.current?.({ reason: 'video_remount', force: true });
    }
  }, [attachVideoListeners, bindGesturePlayResume, startRvfcWatcher]);

  const initCamera = useCallback(
    () => refreshCamera({ reason: 'manual', force: true }),
    [refreshCamera]
  );

  useEffect(() => {
    unmountedRef.current = false;
    const initialVideoEl = videoRef.current;
    refreshCamera({ reason: 'initial', force: true });

    let lastHealthCheckAt = 0;
    const samplerId = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (cameraSuspendedBridgeRef.current?.current) return;
      const nowMs = Date.now();
      const curCalState = calibrationStateRef.current;
      const checkPendingReturn = pendingReturnCheckRef.current && Boolean(leaveCheckpointRef.current);

      // Periodic tick while calibrating so low-texture ORB fallback timer stays responsive
      if (curCalState === 'calibrating') {
        setCalibrationElapsedTick((n) => (n + 1) % 10000);
      }

      // Continuous lightweight health & silent ORB relocalization monitor while calibrated/relocalizing
      if (
        (curCalState === 'calibrated' || curCalState === 'relocalizing') &&
        !mappingPausedBridgeRef.current?.current &&
        !mappingRestartPromptRef.current
      ) {
        if (nowMs - lastHealthCheckAt >= 900) {
          lastHealthCheckAt = nowMs;
          const videoEl = videoRef.current;
          const videoLive = Boolean(
            videoEl &&
              videoEl.readyState >= 2 &&
              videoEl.videoWidth > 0 &&
              !videoEl.paused
          );
          if (videoLive) {
            polRef.current.sampleLightHealth(videoEl);
          }

          const hasSessionOrb = orbKeyframesRef.current.size > 0;
          const healthResult = stepCalibrationHealthMonitor(calibrationHealthRef.current, {
            nowMs,
            isVisible: true,
            cameraReady: cameraReadyRef.current && videoLive,
            cameraRecovering: Boolean(inFlightCameraRef.current),
            sceneContrast: polRef.current.sceneContrast,
            horizonLuminance: polRef.current.horizonLuminance,
            hasOrientationHardware: hasOrientationHardwareRef.current,
            lastOrientationEventTs: lastOrientationEventTsRef.current,
            webxrActive: webxrActiveRef.current,
            magneticInterference: Boolean(orientationFusionRef.current?.magneticInterference),
            anchorLocation: calibratedAnchorLocRef.current,
            currentLocation: locationRef.current,
            currentLocationTs: lastLocationTsRef.current,
            hasSessionOrbKeyframes: hasSessionOrb,
            orbRelockMatched: false
          });

          if (healthResult.status === 'relocalizing') {
            if (calibrationStateRef.current !== 'relocalizing') {
              calibrationStateRef.current = 'relocalizing';
              setCalibrationState('relocalizing');
            }
            if (hasSessionOrb && videoLive && !orbRelockBusyRef.current) {
              orbRelockBusyRef.current = true;
              const sessionPack = {
                descriptorDigest: 'session-local',
                keyframes: Array.from(orbKeyframesRef.current.values())
              };
              orbTrackerRef.current
                ?.matchLiveFrame(videoEl, sessionPack)
                .then((matchRes) => {
                  if (unmountedRef.current || calibrationStateRef.current !== 'relocalizing') return;
                  if (isSessionOrbRelockMatch(matchRes)) {
                    if (
                      Number.isFinite(matchRes.poseCorrectionYawRad) &&
                      Math.abs(matchRes.poseCorrectionYawRad) <= 0.45
                    ) {
                      orientationFusionRef.current.setOrbYawCorrectionRad(
                        matchRes.poseCorrectionYawRad
                      );
                    }
                    stepCalibrationHealthMonitor(calibrationHealthRef.current, {
                      nowMs: Date.now(),
                      orbRelockMatched: true
                    });
                    if (locationRef.current) {
                      calibratedAnchorLocRef.current = { ...locationRef.current };
                    }
                    calibrationStateRef.current = 'calibrated';
                    setCalibrationState('calibrated');
                    setCalibrationLoss(null);
                    setOrbStatus((prev) => ({
                      ...prev,
                      relocalizedInliers: matchRes.inlierCount || prev.relocalizedInliers,
                      reprojErrPx:
                        Number.isFinite(matchRes.reprojectionErrorPx)
                          ? Math.round(matchRes.reprojectionErrorPx * 10) / 10
                          : prev.reprojErrPx
                    }));
                  }
                })
                .catch(() => {})
                .finally(() => {
                  orbRelockBusyRef.current = false;
                });
            }
          } else if (healthResult.status === 'lost' && healthResult.loss) {
            calibrationStateRef.current = 'lost';
            setCalibrationState('lost');
            setCalibrationLoss(healthResult.loss);
            mappingRestartPromptRef.current = healthResult.loss;
            setMappingRestartPrompt(healthResult.loss);
            setScanBoxCollapsed(false);
            lastUnmappedMaskRef.current = '0'.repeat(48);
            setUnmappedGrid(Array(48).fill(false));
          }
        }

        if (!checkPendingReturn) return;
      }

      if (mappingPausedBridgeRef.current?.current && !checkPendingReturn) return;
      if (mappingRestartPromptRef.current) return;
      const isAlreadyOptimal = polRef.current.getSceneCoverage().optimal;
      if (isAlreadyOptimal && curCalState === 'calibrated' && !checkPendingReturn) return;
      if (
        videoRef.current &&
        videoRef.current.readyState >= 2 &&
        videoRef.current.videoWidth > 0 &&
        !videoRef.current.paused
      ) {
        const snap = polRef.current.sampleCameraFrame(videoRef.current);
        if (snap) {
          if (checkPendingReturn) {
            const checkpoint = leaveCheckpointRef.current;
            pendingReturnCheckRef.current = false;
            leaveCheckpointRef.current = null;
            const moveCheck = polRef.current.evaluateMovementSince(checkpoint, {
              location: locationRef.current,
              visualDHash: snap.visualDHash || ''
            });
            if (moveCheck.movedSubstantially) {
              const lossDetails = buildCalibrationLossDetails('relocated', {
                distanceMeters: moveCheck.distanceMeters
              });
              if (orbKeyframesRef.current.size > 0 && calibrationStateRef.current === 'calibrated') {
                // Give session ORB a ~2.4s silent chance to confirm whether user is still in same room
                calibrationHealthRef.current.relocalizingSinceMs = Date.now();
                calibrationHealthRef.current.relocalizingReason = 'relocated';
                calibrationHealthRef.current.relocalizingMeta = {
                  distanceMeters: moveCheck.distanceMeters
                };
                calibrationStateRef.current = 'relocalizing';
                setCalibrationState('relocalizing');
              } else {
                calibrationStateRef.current = 'lost';
                setCalibrationState('lost');
                setCalibrationLoss(lossDetails);
                mappingRestartPromptRef.current = { ...moveCheck, ...lossDetails };
                setMappingRestartPrompt({ ...moveCheck, ...lossDetails });
                setScanBoxCollapsed(false);
                lastUnmappedMaskRef.current = '0'.repeat(48);
                setUnmappedGrid(Array(48).fill(false));
              }
              return;
            }
            if (isAlreadyOptimal && calibrationStateRef.current === 'calibrated') {
              return;
            }
          }

          setPolStats({
            frames: snap.cameraFrames,
            gyro: snap.gyroSamples,
            flow: Math.round(snap.opticalFlowCorrelation * 100)
          });
          const cov = polRef.current.getSceneCoverage();
          if (cov.optimal) {
            lastUnmappedMaskRef.current = '0'.repeat(48);
            setUnmappedGrid(Array(48).fill(false));
          } else {
            const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
            const vpKey = vpGrid.map((b) => (b ? '1' : '0')).join('');
            if (lastUnmappedMaskRef.current !== vpKey) {
              lastUnmappedMaskRef.current = vpKey;
              setUnmappedGrid(vpGrid);
            }
          }
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

    const watchdogId = setInterval(() => {
      if (!hasEverStartedCameraRef.current && !cameraStreamRef.current) return;
      ensureCameraLiveRef.current?.({ reason: 'watchdog' });
    }, 1500);

    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        wasHiddenRef.current = true;
        notifyMappingViewLeftRef.current?.();
        return;
      }
      if (document.visibilityState === 'visible') {
        const returningFromHidden = wasHiddenRef.current;
        if (returningFromHidden || needsRefreshOnVisibleRef.current) {
          wasHiddenRef.current = false;
          watchdogRestartCountRef.current = 0;
          cameraRetryAttemptRef.current = 0;
          refreshCameraRef.current?.({ reason: 'visibility_visible', force: true });
        } else {
          ensureCameraLiveRef.current?.({ reason: 'visibility_check' });
        }
        if (returningFromHidden) {
          refreshLocationNowRef.current?.({ notifyNearby: false });
        }
        notifyMappingViewReturnedRef.current?.();
      }
    };

    const onPageShow = (ev) => {
      if (ev?.persisted || needsRefreshOnVisibleRef.current) {
        watchdogRestartCountRef.current = 0;
        cameraRetryAttemptRef.current = 0;
        refreshCameraRef.current?.({ reason: 'pageshow', force: true });
        refreshLocationNowRef.current?.({ notifyNearby: false });
      } else {
        ensureCameraLiveRef.current?.({ reason: 'pageshow_check' });
      }
      notifyMappingViewReturnedRef.current?.();
    };

    const onFocus = () => {
      ensureCameraLiveRef.current?.({ reason: 'window_focus' });
    };

    const onOffline = () => {
      setIsOnline(false);
      wasOfflineRef.current = true;
    };

    const onOnline = () => {
      setIsOnline(true);
      const reconnectingAfterDrop = wasOfflineRef.current;
      wasOfflineRef.current = false;
      watchdogRestartCountRef.current = 0;
      cameraRetryAttemptRef.current = 0;
      refreshCameraRef.current?.({
        reason: reconnectingAfterDrop ? 'network_reconnected' : 'network_online',
        force: true
      });
      refreshLocationNowRef.current?.({ notifyNearby: true, force: true });
      onNetworkReconnectRef.current?.();
    };

    const onDeviceChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        needsRefreshOnVisibleRef.current = true;
        return;
      }
      watchdogRestartCountRef.current = 0;
      refreshCameraRef.current?.({ reason: 'devicechange', force: true });
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('focus', onFocus);
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

    return () => {
      unmountedRef.current = true;
      cameraOpIdRef.current += 1;
      clearInterval(samplerId);
      clearInterval(watchdogId);
      clearRetryTimer();
      clearGestureResume();
      clearRvfcWatcher();
      const activeVideoEl = boundVideoElRef.current || initialVideoEl;
      detachTrackListeners();
      detachVideoListeners();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('online', onOnline);
      }
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      tearingDownCameraRef.current = true;
      stopMediaStreamTracks(cameraStreamRef.current);
      cameraStreamRef.current = null;
      flushVideoElement(activeVideoEl);
      tearingDownCameraRef.current = false;
    };
  }, [
    clearGestureResume,
    clearRetryTimer,
    clearRvfcWatcher,
    detachTrackListeners,
    detachVideoListeners,
    refreshCamera
  ]);

  useEffect(() => {
    let active = true;
    const tracker = orbTrackerRef.current;
    isWebXrArSupported()
      .then((supported) => {
        if (active && supported) {
          setWebxrSupported(true);
          setOrbStatus((prev) => ({ ...prev, engine: 'WebXR+ORB' }));
        }
      })
      .catch(() => {});
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

  const syncSensorStatus = useCallback(() => {
    const next = orientationFusionRef.current.getSensorQuality({
      gpsAccuracyM: locationRef.current?.accuracy ?? null,
      webxrActive: webxrActiveRef.current
    });
    setSensorStatus((prev) => {
      if (
        prev.source === next.source &&
        prev.trueNorthLocked === next.trueNorthLocked &&
        prev.headingAccuracyDeg === next.headingAccuracyDeg &&
        prev.gpsAccuracyM === next.gpsAccuracyM &&
        prev.magneticInterference === next.magneticInterference &&
        prev.needsCompassCalibration === next.needsCompassCalibration &&
        prev.manualYawNudgeDeg === next.manualYawNudgeDeg &&
        prev.confidenceLabel === next.confidenceLabel &&
        Math.abs((prev.headingDeg ?? 0) - (next.headingDeg ?? 0)) < 2
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      setSensorBanner('GPS unsupported. Open in Safari or Chrome.');
      return undefined;
    }

    let lastFetchAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        polRef.current.recordGps(pos);
        orientationFusionRef.current.setLocation(pos.coords.latitude, pos.coords.longitude);
        orientationFusionRef.current.updateFromGpsCourse({
          headingDeg: pos.coords.heading,
          speedMps: pos.coords.speed,
          accuracyM: pos.coords.accuracy
        });
        const kalmanLoc = positionFilterRef.current.updateGps(pos);
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
        const polRefined = polRef.current.getRefinedLocation(loc) || loc;
        const refined = kalmanLoc
          ? {
              ...polRefined,
              lat: kalmanLoc.lat,
              lng: kalmanLoc.lng,
              accuracy: kalmanLoc.accuracy,
              altitude: kalmanLoc.altitude ?? polRefined.altitude,
              speed: kalmanLoc.speed
            }
          : polRefined;
        setLocation(refined);
        locationRef.current = refined;
        lastLocationTsRef.current = Date.now();
        setSensorBanner((prev) =>
          prev && /location|gps/i.test(prev) ? '' : prev
        );
        syncSensorStatus();

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
        setSensorBanner(describeGeolocationError(err));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [dirLightRef, syncSensorStatus]);

  const attachOrientation = useCallback(() => {
    if (orientationDetachRef.current) {
      orientationDetachRef.current();
      orientationDetachRef.current = null;
    }

    const getScreenAngle = () =>
      (typeof window !== 'undefined' && (window.screen?.orientation?.angle ?? window.orientation)) || 0;

    let absSensor = null;
    let absSensorActive = false;

    const onAbsSensorReading = () => {
      if (!absSensor?.quaternion) return;
      absSensorActive = true;
      lastOrientationEventTsRef.current = Date.now();
      hasOrientationHardwareRef.current = true;
      orientationFusionRef.current.updateFromAbsoluteSensor(absSensor.quaternion, getScreenAngle());
      const headingDeg = orientationFusionRef.current.getTrueHeadingDeg();
      const alpha = (360 - headingDeg) % 360;
      const beta = rawOrientationRef.current?.beta ?? 90;
      const gamma = rawOrientationRef.current?.gamma ?? 0;
      rawOrientationRef.current = {
        alpha,
        beta,
        gamma,
        absolute: true
      };
      polRef.current.recordFusedHeading({
        headingDeg,
        pitchDeg: beta - 90,
        source: 'absolute-sensor',
        trueNorthLocked: true
      });
      polRef.current.recordGyro(alpha, beta, gamma);
      setGyroFallbackActive(false);
    };

    try {
      if (typeof window !== 'undefined' && typeof window.AbsoluteOrientationSensor === 'function') {
        absSensor = new window.AbsoluteOrientationSensor({
          frequency: 60,
          referenceFrame: 'device'
        });
        absSensor.addEventListener('reading', onAbsSensorReading);
        absSensor.addEventListener('error', () => {
          absSensorActive = false;
        });
        absSensor.start();
      }
    } catch {
      absSensor = null;
    }

    const absOrientationHandler = (e) => {
      if (e.alpha === null && e.beta === null) return;
      lastOrientationEventTsRef.current = Date.now();
      hasOrientationHardwareRef.current = true;
      if (!absSensorActive) {
        orientationFusionRef.current.updateFromDeviceOrientation(
          {
            alpha: e.alpha,
            beta: e.beta,
            gamma: e.gamma,
            absolute: true
          },
          getScreenAngle()
        );
      }
      rawOrientationRef.current = {
        alpha: e.alpha || 0,
        beta: e.beta || 0,
        gamma: e.gamma || 0,
        absolute: true
      };
      if (orientationFusionRef.current.initialized) {
        polRef.current.recordFusedHeading({
          headingDeg: orientationFusionRef.current.getTrueHeadingDeg(),
          pitchDeg: (e.beta || 90) - 90,
          source: orientationFusionRef.current.source,
          trueNorthLocked: orientationFusionRef.current.trueNorthLocked
        });
      }
      setGyroFallbackActive(false);
      polRef.current.recordGyro(e.alpha, e.beta, e.gamma);
    };

    const orientationHandler = (e) => {
      if (e.alpha === null && e.beta === null) return;
      lastOrientationEventTsRef.current = Date.now();
      hasOrientationHardwareRef.current = true;
      orientationFusionRef.current.updateFromDeviceOrientation(e, getScreenAngle());
      rawOrientationRef.current = {
        alpha: e.alpha || 0,
        beta: e.beta || 0,
        gamma: e.gamma || 0,
        absolute: Boolean(e.absolute || typeof e.webkitCompassHeading === 'number'),
        webkitCompassHeading: e.webkitCompassHeading,
        webkitCompassAccuracy: e.webkitCompassAccuracy
      };
      if (orientationFusionRef.current.initialized) {
        polRef.current.recordFusedHeading({
          headingDeg: orientationFusionRef.current.getTrueHeadingDeg(),
          pitchDeg: (e.beta || 90) - 90,
          source: orientationFusionRef.current.source,
          trueNorthLocked: orientationFusionRef.current.trueNorthLocked
        });
      }
      setGyroFallbackActive(false);
      polRef.current.recordGyro(e.alpha, e.beta, e.gamma);
    };

    const motionHandler = (e) => {
      const screenAngle = getScreenAngle();
      orientationFusionRef.current.updateFromDeviceMotion(e, screenAngle);
      if (orientationFusionRef.current.initialized) {
        positionFilterRef.current.updateImuMotion({
          accelWithGravity: e.accelerationIncludingGravity,
          headingDeg: orientationFusionRef.current.getTrueHeadingDeg()
        });
        if (e.acceleration) {
          spatialDrawTrackerRef.current.updateFromDeviceMotion({
            acceleration: e.acceleration,
            cameraQuat: orientationFusionRef.current.getCameraQuaternion(),
            screenOrientDeg: screenAngle
          });
        }
      }
    };

    window.addEventListener('deviceorientationabsolute', absOrientationHandler, true);
    window.addEventListener('deviceorientation', orientationHandler, true);
    window.addEventListener('devicemotion', motionHandler, true);

    const statusInterval = setInterval(() => {
      syncSensorStatus();
    }, 650);

    const detach = () => {
      clearInterval(statusInterval);
      window.removeEventListener('deviceorientationabsolute', absOrientationHandler, true);
      window.removeEventListener('deviceorientation', orientationHandler, true);
      window.removeEventListener('devicemotion', motionHandler, true);
      if (absSensor) {
        try {
          absSensor.removeEventListener('reading', onAbsSensorReading);
          absSensor.stop();
        } catch {
          // ignore sensor teardown error
        }
        absSensor = null;
      }
    };
    orientationDetachRef.current = detach;
    return detach;
  }, [syncSensorStatus]);

  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      setNeedsGyroTap(true);
      return () => {
        if (orientationDetachRef.current) {
          orientationDetachRef.current();
          orientationDetachRef.current = null;
        }
      };
    }
    const detach = attachOrientation();
    const fallbackProbe = setTimeout(() => {
      if (!rawOrientationRef.current && !orientationFusionRef.current.initialized) {
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
      if (
        typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function'
      ) {
        // Request DeviceMotion permission on the same user tap for 60Hz gyro + gravity + steps
        await DeviceMotionEvent.requestPermission().catch(() => {});
      }
      if (res === 'granted') {
        setNeedsGyroTap(false);
        setGyroFallbackActive(false);
        attachOrientation();
      } else {
        setNeedsGyroTap(false);
        setGyroFallbackActive(true);
        setSensorBanner(describeMotionError('denied'));
      }
    } catch {
      setNeedsGyroTap(false);
      setGyroFallbackActive(true);
      setSensorBanner(describeMotionError('unavailable'));
    }
  }, [attachOrientation, enterFullscreen]);

  const resetSpatialDrawOrigin = useCallback(() => {
    const pf = positionFilterRef.current;
    spatialDrawTrackerRef.current.resetOrigin({
      currentEnu: pf?.initialized ? { east: pf.east, north: pf.north } : null
    });
  }, []);

  // Recenter ONLY re-anchors spatial draw origin when no piece is locked, keeping
  // GPS-anchored lands & existing placed artwork strictly locked in real world space!
  const recenterAim = useCallback(() => {
    resetSpatialDrawOrigin();
    if (orientationFusionRef.current.initialized) {
      const headingDeg = orientationFusionRef.current.getTrueHeadingDeg();
      draftYawOffsetRef.current = -(headingDeg * Math.PI) / 180;
    } else if (rawOrientationRef.current) {
      draftYawOffsetRef.current = ((rawOrientationRef.current.alpha || 0) * Math.PI) / 180;
    } else {
      fallbackEulerRef.current = { yaw: 0, pitch: 0 };
    }
  }, [resetSpatialDrawOrigin]);

  const adjustCompassNudge = useCallback(
    (deltaDeg) => {
      orientationFusionRef.current.adjustManualYawNudgeDeg(deltaDeg);
      syncSensorStatus();
    },
    [syncSensorStatus]
  );

  const resetCompassNudge = useCallback(() => {
    orientationFusionRef.current.setManualYawNudgeDeg(0);
    syncSensorStatus();
  }, [syncSensorStatus]);

  const setWebxrState = useCallback(
    (active) => {
      const wasActive = webxrActiveRef.current;
      const next = Boolean(active);
      webxrActiveRef.current = next;
      polRef.current.setWebxrActive(next);
      setWebxrActive(next);
      setSceneScan(polRef.current.getSceneCoverage());
      if (wasActive && !next && calibrationStateRef.current === 'calibrated') {
        if (orbKeyframesRef.current.size > 0) {
          calibrationHealthRef.current.relocalizingSinceMs = Date.now();
          calibrationHealthRef.current.relocalizingReason = 'webxr_lost';
          calibrationHealthRef.current.relocalizingMeta = {};
          calibrationStateRef.current = 'relocalizing';
          setCalibrationState('relocalizing');
        }
      }
      syncSensorStatus();
    },
    [syncSensorStatus]
  );

  const resetOrbKeyframes = useCallback(() => {
    orbKeyframesRef.current.clear();
    setOrbStatus((prev) => ({ ...prev, keyframes: 0, features: 0, relocalizedInliers: 0 }));
  }, []);

  const invalidateScanPreviewCaches = useCallback(() => {
    lastUnmappedMaskRef.current = '';
    lastScanUiRef.current = {
      coveragePct: -1,
      scannedCount: -1,
      optimal: false,
      cursorX: -1,
      cursorY: -1,
      hint: ''
    };
  }, []);

  const notifyMappingViewLeft = useCallback(() => {
    if (mappingRestartPromptRef.current) return;
    if (!leaveCheckpointRef.current) {
      leaveCheckpointRef.current = polRef.current.captureScanCheckpoint(locationRef.current);
    }
    pendingReturnCheckRef.current = false;
  }, []);

  const notifyMappingViewReturned = useCallback(() => {
    invalidateScanPreviewCaches();

    if (mappingRestartPromptRef.current) {
      lastUnmappedMaskRef.current = '0'.repeat(48);
      setUnmappedGrid(Array(48).fill(false));
      setScanBoxCollapsed(false);
      ensureCameraLiveRef.current?.({
        reason: 'mapping_return_pending_restart',
        allowRestart: true
      });
      return;
    }

    const checkpoint = leaveCheckpointRef.current;
    if (!checkpoint || (checkpoint.scannedCount <= 0 && !checkpoint.optimal)) {
      leaveCheckpointRef.current = null;
      pendingReturnCheckRef.current = false;
      const cov = polRef.current.getSceneCoverage();
      setSceneScan(cov);
      if (cov.optimal) {
        lastUnmappedMaskRef.current = '0'.repeat(48);
        setUnmappedGrid(Array(48).fill(false));
      } else {
        const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
        lastUnmappedMaskRef.current = vpGrid.map((b) => (b ? '1' : '0')).join('');
        setUnmappedGrid(vpGrid);
      }
      ensureCameraLiveRef.current?.({ reason: 'mapping_return', allowRestart: true });
      return;
    }

    // Immediate accuracy-aware physical relocation check
    const immediateCheck = polRef.current.evaluateMovementSince(checkpoint, {
      location: locationRef.current,
      visualDHash: ''
    });
    if (immediateCheck.movedSubstantially) {
      leaveCheckpointRef.current = null;
      pendingReturnCheckRef.current = false;
      const lossDetails = buildCalibrationLossDetails('relocated', {
        distanceMeters: immediateCheck.distanceMeters
      });
      if (orbKeyframesRef.current.size > 0 && calibrationStateRef.current === 'calibrated') {
        calibrationHealthRef.current.relocalizingSinceMs = Date.now();
        calibrationHealthRef.current.relocalizingReason = 'relocated';
        calibrationHealthRef.current.relocalizingMeta = {
          distanceMeters: immediateCheck.distanceMeters
        };
        calibrationStateRef.current = 'relocalizing';
        setCalibrationState('relocalizing');
        ensureCameraLiveRef.current?.({ reason: 'mapping_return_relocalizing', allowRestart: true });
        return;
      }
      calibrationStateRef.current = 'lost';
      setCalibrationState('lost');
      setCalibrationLoss(lossDetails);
      const mergedPrompt = { ...immediateCheck, ...lossDetails };
      mappingRestartPromptRef.current = mergedPrompt;
      setMappingRestartPrompt(mergedPrompt);
      setScanBoxCollapsed(false);
      lastUnmappedMaskRef.current = '0'.repeat(48);
      setUnmappedGrid(Array(48).fill(false));
      ensureCameraLiveRef.current?.({ reason: 'mapping_return_moved', allowRestart: true });
      return;
    }

    // Defer secondary check until fresh post-return frame arrives (never interrupts unless GPS moved)
    leaveCheckpointRef.current = { ...checkpoint, returnedAt: Date.now() };
    pendingReturnCheckRef.current = true;
    const cov = polRef.current.getSceneCoverage();
    setSceneScan(cov);
    if (!cov.optimal) {
      const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
      lastUnmappedMaskRef.current = vpGrid.map((b) => (b ? '1' : '0')).join('');
      setUnmappedGrid(vpGrid);
    }
    ensureCameraLiveRef.current?.({ reason: 'mapping_return', allowRestart: true });
  }, [invalidateScanPreviewCaches]);

  notifyMappingViewLeftRef.current = notifyMappingViewLeft;
  notifyMappingViewReturnedRef.current = notifyMappingViewReturned;

  const orbWorkerSupported = typeof Worker !== 'undefined';
  const calibrationReadiness = useMemo(
    () =>
      evaluateCalibrationReadiness({
        cameraReady,
        cameraFrames: Math.max(polStats.frames, polRef.current.cameraFrames || 0),
        sceneContrast: polRef.current.sceneContrast || 0,
        horizonLuminance: polRef.current.horizonLuminance ?? 128,
        needsGyroTap,
        orientationInitialized: Boolean(
          orientationFusionRef.current?.initialized ||
            rawOrientationRef.current ||
            (polRef.current.gyroSamples || 0) > 0
        ),
        gyroSamples: Math.max(polStats.gyro, polRef.current.gyroSamples || 0),
        gyroFallbackActive,
        webxrActive,
        scannedCount: sceneScan?.scannedCount || 0,
        orbKeyframes: orbStatus?.keyframes || 0,
        orbWorkerSupported,
        elapsedScanningMs: Math.max(0, Date.now() - calibrationStartedAt),
        gpsAccuracyM: location?.accuracy ?? null,
        hasLocation: Boolean(location),
        magneticInterference: Boolean(sensorStatus?.magneticInterference),
        sweepHint: sceneScan?.hint
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      cameraReady,
      polStats.frames,
      polStats.gyro,
      needsGyroTap,
      gyroFallbackActive,
      webxrActive,
      sceneScan?.scannedCount,
      sceneScan?.optimal,
      sceneScan?.hint,
      orbStatus?.keyframes,
      orbWorkerSupported,
      calibrationStartedAt,
      calibrationElapsedTick,
      location,
      sensorStatus?.magneticInterference
    ]
  );

  const prevCalibrationReadyRef = useRef(false);
  useEffect(() => {
    const isSufficient = Boolean(calibrationReadiness.sufficient && !mappingRestartPrompt);
    if (isSufficient && calibrationStateRef.current === 'calibrating') {
      calibrationStateRef.current = 'calibrated';
      setCalibrationState('calibrated');
      setCalibrationLoss(null);
      calibrationHealthRef.current = createCalibrationHealthState();
      calibratedAnchorLocRef.current = locationRef.current ? { ...locationRef.current } : null;
      setScanBoxCollapsed(true);
      setCalibrationJustLocked(true);
      if (justLockedTimerRef.current) clearTimeout(justLockedTimerRef.current);
      justLockedTimerRef.current = setTimeout(() => {
        justLockedTimerRef.current = null;
        setCalibrationJustLocked(false);
      }, 1500);
      prevCalibrationReadyRef.current = true;
      return;
    }

    // Legacy direct-state sync compatibility (e.g. sceneScan.optimal set programmatically)
    const wasReady = prevCalibrationReadyRef.current;
    if (!wasReady && sceneScan?.optimal && !mappingRestartPrompt && calibrationReadiness.sufficient) {
      setScanBoxCollapsed(true);
      prevCalibrationReadyRef.current = true;
    } else if (wasReady && (!sceneScan?.optimal || Boolean(mappingRestartPrompt))) {
      setScanBoxCollapsed(false);
      prevCalibrationReadyRef.current = false;
    }
  }, [calibrationReadiness.sufficient, mappingRestartPrompt, sceneScan?.optimal]);

  useEffect(() => {
    if (mappingRestartPrompt) {
      setScanBoxCollapsed(false);
    }
  }, [mappingRestartPrompt]);

  const markCalibrationLost = useCallback((code = 'manual', meta = {}) => {
    const loss = buildCalibrationLossDetails(code, meta);
    calibrationStateRef.current = 'lost';
    setCalibrationState('lost');
    setCalibrationLoss(loss);
    mappingRestartPromptRef.current = loss;
    setMappingRestartPrompt(loss);
    setScanBoxCollapsed(false);
    lastUnmappedMaskRef.current = '0'.repeat(48);
    setUnmappedGrid(Array(48).fill(false));
  }, []);

  const restartSceneMapping = useCallback(
    async ({ reason = 'manual', refreshCameraFeed = true } = {}) => {
      leaveCheckpointRef.current = null;
      pendingReturnCheckRef.current = false;
      mappingRestartPromptRef.current = null;
      setMappingRestartPrompt(null);
      setCalibrationLoss(null);
      setCalibrationJustLocked(false);
      calibrationHealthRef.current = createCalibrationHealthState();
      calibratedAnchorLocRef.current = null;
      calibrationStateRef.current = 'calibrating';
      setCalibrationState('calibrating');
      setCalibrationStartedAt(Date.now());
      mappingCompletedNoticeShownRef.current = false;
      invalidateScanPreviewCaches();

      const freshCov = polRef.current.resetSceneScan({ preserveGps: true });
      resetOrbKeyframes();
      setSceneScan(freshCov);
      setUnmappedGrid(Array(48).fill(false));
      setPolStats((prev) => ({ frames: 0, gyro: prev.gyro, flow: 0 }));
      setScanBoxCollapsed(false);

      if (orientationFusionRef.current.initialized) {
        draftYawOffsetRef.current = -(orientationFusionRef.current.getTrueHeadingDeg() * Math.PI) / 180;
      } else if (rawOrientationRef.current) {
        draftYawOffsetRef.current = ((rawOrientationRef.current.alpha || 0) * Math.PI) / 180;
      }

      if (refreshCameraFeed) {
        const videoEl = videoRef.current;
        const videoLive = Boolean(
          videoEl &&
            videoEl.readyState >= 2 &&
            videoEl.videoWidth > 0 &&
            !videoEl.paused
        );
        if (!videoLive) {
          await refreshCameraRef.current?.({
            reason: `mapping_restart_${reason}`,
            force: true
          });
        } else {
          ensureCameraLiveRef.current?.({
            reason: `mapping_restart_${reason}`,
            allowRestart: true
          });
          const snap = polRef.current.sampleCameraFrame(videoEl);
          if (snap) {
            const cov = polRef.current.getSceneCoverage();
            setPolStats({
              frames: snap.cameraFrames,
              gyro: snap.gyroSamples,
              flow: Math.round(snap.opticalFlowCorrelation * 100)
            });
            setSceneScan(cov);
            const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
            lastUnmappedMaskRef.current = vpGrid.map((b) => (b ? '1' : '0')).join('');
            setUnmappedGrid(vpGrid);
          }
        }
      }

      return freshCov;
    },
    [invalidateScanPreviewCaches, resetOrbKeyframes]
  );

  const calibrationReady = calibrationState === 'calibrated';

  return {
    videoRef,
    polRef,
    orbTrackerRef,
    orbKeyframesRef,
    orbPackCacheRef,
    latestOrbProofRef,
    rawOrientationRef,
    yawOffsetRef,
    draftYawOffsetRef,
    orientationFusionRef,
    positionFilterRef,
    spatialDrawTrackerRef,
    resetSpatialDrawOrigin,
    fallbackEulerRef,
    sensorStatus,
    adjustCompassNudge,
    resetCompassNudge,
    webxrSupported,
    webxrActive,
    webxrActiveRef,
    setWebxrState,
    locationRef,
    cameraReadyRef,
    cameraReady,
    cameraRecovering,
    isOnline,
    retryCameraAccess: initCamera,
    refreshCamera,
    ensureCameraLive,
    reattachVideoStream,
    sensorBanner,
    setSensorBanner,
    needsGyroTap,
    gyroFallbackActive,
    enableIosGyro,
    recenterAim,
    location,
    setLocation,
    refreshLocationNow,
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
    mappingRestartPrompt,
    setMappingRestartPrompt,
    calibrationState,
    calibrationReady,
    calibrationReadiness,
    calibrationLoss,
    calibrationJustLocked,
    markCalibrationLost,
    notifyMappingViewLeft,
    notifyMappingViewReturned,
    restartSceneMapping,
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
