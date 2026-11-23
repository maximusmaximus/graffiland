import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
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
import { describeCameraError, describeGeolocationError } from '../utils/permissionMessages.js';
import { OrbLandmarkTracker } from '../utils/orbTracker.js';
import { isWebAuthnSupported, registerHardwarePasskey } from '../utils/passkeyClient.js';
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
  mappingPausedRef = null
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
  const onCameraRefreshedRef = useRef(onCameraRefreshed);
  const onNetworkReconnectRef = useRef(onNetworkReconnect);
  const mappingPausedBridgeRef = useRef(mappingPausedRef);

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

  useEffect(() => {
    onLocationUpdateRef.current = onLocationUpdate;
    onCameraRefreshedRef.current = onCameraRefreshed;
    onNetworkReconnectRef.current = onNetworkReconnect;
    mappingPausedBridgeRef.current = mappingPausedRef;
  }, [onLocationUpdate, onCameraRefreshed, onNetworkReconnect, mappingPausedRef]);

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
        setSensorBanner('Camera API requires HTTPS on mobile.');
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

    const samplerId = setInterval(() => {
      if (mappingPausedBridgeRef.current?.current) return;
      if (
        videoRef.current &&
        videoRef.current.readyState >= 2 &&
        videoRef.current.videoWidth > 0
      ) {
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

    const watchdogId = setInterval(() => {
      if (!hasEverStartedCameraRef.current && !cameraStreamRef.current) return;
      ensureCameraLiveRef.current?.({ reason: 'watchdog' });
    }, 1500);

    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        wasHiddenRef.current = true;
        return;
      }
      if (document.visibilityState === 'visible') {
        if (wasHiddenRef.current || needsRefreshOnVisibleRef.current) {
          wasHiddenRef.current = false;
          watchdogRestartCountRef.current = 0;
          cameraRetryAttemptRef.current = 0;
          refreshCameraRef.current?.({ reason: 'visibility_visible', force: true });
        } else {
          ensureCameraLiveRef.current?.({ reason: 'visibility_check' });
        }
      }
    };

    const onPageShow = (ev) => {
      if (ev?.persisted || needsRefreshOnVisibleRef.current) {
        watchdogRestartCountRef.current = 0;
        cameraRetryAttemptRef.current = 0;
        refreshCameraRef.current?.({ reason: 'pageshow', force: true });
      } else {
        ensureCameraLiveRef.current?.({ reason: 'pageshow_check' });
      }
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
      if (navigator.geolocation?.getCurrentPosition) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (unmountedRef.current) return;
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
            onLocationUpdateRef.current?.(loc, refined);
          },
          () => {},
          { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
        );
      }
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
        setSensorBanner(describeGeolocationError(err));
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
