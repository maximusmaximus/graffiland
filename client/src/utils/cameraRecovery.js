/**
 * Pure AR camera health inspection, stream teardown, progressive rear-camera
 * acquisition, and freeze/reconnect recovery helpers for MobileStudio.
 */

export const CAMERA_CONSTRAINT_CANDIDATES = [
  {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  },
  {
    video: {
      facingMode: { ideal: 'environment' }
    },
    audio: false
  },
  {
    video: true,
    audio: false
  }
];

export const CAMERA_RETRY_BACKOFF_MS = [450, 1100, 2200];

export function isPermissionDeniedError(err) {
  const name = String(err?.name || '');
  return (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    name === 'SecurityError'
  );
}

export function isConstraintFallbackError(err) {
  const name = String(err?.name || '');
  return (
    name === 'OverconstrainedError' ||
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'ConstraintNotSatisfiedError'
  );
}

export function isTransientHardwareError(err) {
  const name = String(err?.name || '');
  return (
    name === 'NotReadableError' ||
    name === 'AbortError' ||
    name === 'TrackStartError' ||
    name === 'OperationError' ||
    name === 'UnknownError'
  );
}

export function isAutoplayBlockedError(err) {
  const name = String(err?.name || '');
  return name === 'NotAllowedError' || name === 'AbortError';
}

export function getRetryBackoffMs(attemptIndex) {
  if (attemptIndex < 0 || attemptIndex >= CAMERA_RETRY_BACKOFF_MS.length) {
    return null;
  }
  return CAMERA_RETRY_BACKOFF_MS[attemptIndex];
}

export function getWatchdogCooldownMs(consecutiveWatchdogRestarts = 0) {
  const clamped = Math.max(0, Math.min(4, Number(consecutiveWatchdogRestarts) || 0));
  return Math.min(16000, 3500 * Math.pow(2, clamped));
}

export function stopMediaStreamTracks(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore already-stopped track errors
    }
  }
}

/**
 * Forces mobile WebKit/Chromium hardware decoders to release a frozen video surface
 * before rebinding a fresh MediaStream.
 */
export function flushVideoElement(videoEl) {
  if (!videoEl) return;
  try {
    if (typeof videoEl.pause === 'function') {
      videoEl.pause();
    }
  } catch {
    // ignore
  }
  try {
    if (videoEl.srcObject) {
      videoEl.srcObject = null;
    }
  } catch {
    // ignore
  }
}

export async function acquireRearCameraStream(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    const err = new Error('Camera API unavailable');
    err.name = 'NotSupportedError';
    throw err;
  }
  let lastError = null;
  for (let i = 0; i < CAMERA_CONSTRAINT_CANDIDATES.length; i += 1) {
    try {
      return await mediaDevices.getUserMedia(CAMERA_CONSTRAINT_CANDIDATES[i]);
    } catch (err) {
      lastError = err;
      if (!isConstraintFallbackError(err) || i === CAMERA_CONSTRAINT_CANDIDATES.length - 1) {
        throw err;
      }
    }
  }
  throw lastError || new Error('Camera unavailable');
}

/**
 * Inspects whether the live AR camera <video> and its MediaStream tracks are healthy
 * and actively advancing frames, or whether a reattach, play(), or full restart is needed.
 */
export function inspectCameraFeedHealth(
  videoEl,
  stream,
  prevSample = null,
  nowMs = Date.now(),
  options = {}
) {
  const {
    streamStartedAt = 0,
    mutedSince = 0,
    rvfcFrameCount = 0,
    startupGraceMs = 2800,
    mutedGraceMs = 1800,
    stallThresholdMs = 3400
  } = options;

  const baseSample = {
    currentTime: Number(videoEl?.currentTime || 0),
    totalFrames: Number(videoEl?.getVideoPlaybackQuality?.()?.totalVideoFrames || 0),
    rvfcFrameCount: Number(rvfcFrameCount || 0),
    videoWidth: Number(videoEl?.videoWidth || 0),
    videoHeight: Number(videoEl?.videoHeight || 0),
    lastProgressAt: prevSample?.lastProgressAt || streamStartedAt || nowMs
  };

  if (!stream) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'no_stream',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
  if (tracks.length === 0) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'no_video_track',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  const liveTracks = tracks.filter((t) => t?.readyState === 'live');
  if (liveTracks.length === 0) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'track_ended',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  if (liveTracks.every((t) => t.enabled === false)) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'track_disabled',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  const allMuted = liveTracks.every((t) => Boolean(t.muted));
  if (allMuted && mutedSince > 0 && nowMs - mutedSince >= mutedGraceMs) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'track_muted_stalled',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  if (!videoEl) {
    return {
      healthy: false,
      action: 'none',
      reason: 'no_video_element',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  if ('srcObject' in videoEl && videoEl.srcObject !== stream) {
    return {
      healthy: false,
      action: 'reattach',
      reason: 'src_detached',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  if (videoEl.ended) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'video_ended',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  if (videoEl.paused) {
    return {
      healthy: false,
      action: 'play',
      reason: 'video_paused',
      frameAdvanced: false,
      nextSample: baseSample
    };
  }

  const readyState = Number(videoEl.readyState || 0);
  const inStartupGrace = streamStartedAt > 0 && nowMs - streamStartedAt < startupGraceMs;

  const frameAdvanced = prevSample
    ? baseSample.rvfcFrameCount > prevSample.rvfcFrameCount ||
      baseSample.totalFrames > prevSample.totalFrames ||
      Math.abs(baseSample.currentTime - prevSample.currentTime) > 0.001
    : baseSample.rvfcFrameCount > 0 || baseSample.totalFrames > 0 || baseSample.currentTime > 0;

  const nextSample = {
    ...baseSample,
    lastProgressAt: frameAdvanced ? nowMs : baseSample.lastProgressAt
  };

  if (readyState < 2 || baseSample.videoWidth <= 0 || baseSample.videoHeight <= 0) {
    if (inStartupGrace) {
      return {
        healthy: true,
        action: 'none',
        reason: 'starting',
        frameAdvanced,
        nextSample
      };
    }
    return {
      healthy: false,
      action: 'restart',
      reason: 'video_not_ready',
      frameAdvanced,
      nextSample
    };
  }

  if (!inStartupGrace && nowMs - nextSample.lastProgressAt >= stallThresholdMs) {
    return {
      healthy: false,
      action: 'restart',
      reason: 'frame_frozen',
      frameAdvanced: false,
      nextSample
    };
  }

  return {
    healthy: true,
    action: 'none',
    reason: 'ok',
    frameAdvanced,
    nextSample
  };
}
