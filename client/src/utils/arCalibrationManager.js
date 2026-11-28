import { haversineMeters } from '../../../shared/chatPolicy.mjs';

export const CALIBRATION_MIN_SECTORS = 7;
export const CALIBRATION_WEBXR_MIN_SECTORS = 4;
export const CALIBRATION_FALLBACK_SECTORS = 9;
export const CALIBRATION_MIN_ORB_KEYFRAMES = 2;
export const CALIBRATION_MIN_CAMERA_FRAMES = 4;
export const CALIBRATION_RELOCK_GRACE_MS = 2400;
export const CALIBRATION_RELOCATE_MIN_METERS = 15;
export const CALIBRATION_RELOCATE_MAX_METERS = 35;
export const CALIBRATION_SINGLE_HIGH_ACC_RELOCATE_METERS = 28;
export const CALIBRATION_RELOCATE_CONFIRMED_FIXES = 2;
export const CALIBRATION_CAMERA_LOST_MS = 2500;
export const CALIBRATION_OCCLUDED_LOST_MS = 2800;
export const CALIBRATION_SENSOR_STALL_MS = 3200;
export const CALIBRATION_MAG_INTERFERENCE_MS = 4500;
export const CALIBRATION_ORB_FALLBACK_WAIT_MS = 8500;
export const CALIBRATION_ORB_RELOCK_MIN_INLIERS = 6;
export const CALIBRATION_ORB_RELOCK_MAX_REPROJ_PX = 12;

function finiteNum(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Maps a scan-relative yaw angle (`relYawDeg` relative to initial `anchorYawDeg`)
 * into one of three horizontal ORB keyframe buckets so multi-angle visual anchors
 * capture reliably regardless of which compass direction (N/E/S/W) the user faces.
 */
export function resolveRelativeOrbBucket(relYawDeg = 0) {
  const rel = finiteNum(relYawDeg) ?? 0;
  if (rel <= -14) return 'left';
  if (rel >= 14) return 'right';
  return 'center';
}

/**
 * Computes an accuracy-aware physical relocation threshold (meters) so indoor/urban
 * multipath GPS jitter never causes false calibration drops.
 */
export function computeRelocationThresholdMeters(accA = 10, accB = 10) {
  const a = Math.max(3, finiteNum(accA) ?? 10);
  const b = Math.max(3, finiteNum(accB) ?? 10);
  const worst = Math.max(a, b);
  return Math.max(
    CALIBRATION_RELOCATE_MIN_METERS,
    Math.min(CALIBRATION_RELOCATE_MAX_METERS, Math.round(worst * 2.0 * 10) / 10)
  );
}

/**
 * Evaluates whether a local session ORB match is strong enough to silently relock
 * tracking without interrupting the user.
 */
export function isSessionOrbRelockMatch(orbResult) {
  if (!orbResult) return false;
  const inliers = finiteNum(orbResult.inlierCount) ?? 0;
  const reproj = finiteNum(orbResult.reprojectionErrorPx) ?? 999;
  return (
    inliers >= CALIBRATION_ORB_RELOCK_MIN_INLIERS &&
    reproj <= CALIBRATION_ORB_RELOCK_MAX_REPROJ_PX
  );
}

/**
 * Returns concise, actionable copy for the front-and-center calibration card when
 * calibration is lost.
 */
export function buildCalibrationLossDetails(code, meta = {}) {
  const distM = finiteNum(meta.distanceMeters);
  switch (code) {
    case 'relocated':
      return {
        code: 'relocated',
        movedSubstantially: true,
        canStartFresh: true,
        title: 'Location Changed',
        summary:
          distM !== null
            ? `You moved ~${Math.round(distM)}m — look around slowly to line up this new spot.`
            : 'You moved to a new spot — look around slowly to line things up.',
        actionHint: 'Move your phone slowly around this spot to recalibrate.'
      };
    case 'camera_lost':
      return {
        code: 'camera_lost',
        movedSubstantially: false,
        canStartFresh: false,
        title: 'Camera Paused',
        summary: 'Your camera paused — tap Resume Camera to jump back in.',
        actionHint: 'Allow camera access or tap Resume Camera.'
      };
    case 'camera_occluded':
      return {
        code: 'camera_occluded',
        movedSubstantially: false,
        canStartFresh: false,
        title: 'Camera View Blocked',
        summary: 'Uncover the back camera and point it at a lit area.',
        actionHint: 'Point your back camera toward a lit surface.'
      };
    case 'sensor_stalled':
      return {
        code: 'sensor_stalled',
        movedSubstantially: false,
        canStartFresh: false,
        title: 'Tracking Paused',
        summary: 'Phone movement paused — look slowly left and right to reconnect.',
        actionHint: 'Hold your phone upright and move it smoothly left & right.'
      };
    case 'magnetic_interference':
      return {
        code: 'magnetic_interference',
        movedSubstantially: false,
        canStartFresh: false,
        title: 'Compass Interference',
        summary: 'Nearby metal is affecting your compass — wave your phone in a figure-8.',
        actionHint: 'Step slightly away from metal and wave your phone in a figure-8.'
      };
    case 'webxr_lost':
      return {
        code: 'webxr_lost',
        movedSubstantially: false,
        canStartFresh: false,
        title: 'Tracking Reset',
        summary: 'Your view reset — do a quick look around to line things back up.',
        actionHint: 'Look slowly around the area to finish lining up.'
      };
    default:
      return {
        code: String(code || 'manual'),
        movedSubstantially: false,
        canStartFresh: false,
        title: 'Line Up Your Space',
        summary: 'Move your phone slowly around you to line up your view.',
        actionHint: 'Look left, right, and slightly up or down.'
      };
  }
}

/**
 * Evaluates Balanced Smart Calibration readiness (Visual + Motion lock to unlock
 * drawing; GPS refines asynchronously and is enforced at Publish time).
 *
 * Works consistently across iOS Safari, Android Chrome, Samsung Internet, Firefox Mobile,
 * and WebXR-capable Android devices.
 */
export function evaluateCalibrationReadiness({
  cameraReady = false,
  cameraFrames = 0,
  sceneContrast = 0,
  horizonLuminance = 128,
  needsGyroTap = false,
  orientationInitialized = false,
  gyroSamples = 0,
  gyroFallbackActive = false,
  webxrActive = false,
  scannedCount = 0,
  orbKeyframes = 0,
  orbWorkerSupported = true,
  elapsedScanningMs = 0,
  gpsAccuracyM = null,
  hasLocation = false,
  magneticInterference = false,
  sweepHint = 'Pan phone slowly around your space'
} = {}) {
  const frames = Math.max(0, finiteNum(cameraFrames) ?? 0);
  const contrast = Math.max(0, finiteNum(sceneContrast) ?? 0);
  const luma = Math.max(0, finiteNum(horizonLuminance) ?? 128);
  const sectors = Math.max(0, finiteNum(scannedCount) ?? 0);
  const orbCount = Math.max(0, finiteNum(orbKeyframes) ?? 0);
  const elapsedMs = Math.max(0, finiteNum(elapsedScanningMs) ?? 0);

  const lensOccluded = Boolean(cameraReady && frames >= 2 && contrast < 0.45 && luma < 10);
  const cameraOk = Boolean(
    cameraReady && frames >= CALIBRATION_MIN_CAMERA_FRAMES && !lensOccluded
  );

  // On iOS, tapping Enable Motion is mandatory. On devices with sensors, wait for first reading.
  // On sensorless desktops/tablets (gyroFallbackActive after probe), allow sweep once sectors advance.
  const motionOk = Boolean(
    !needsGyroTap &&
      (webxrActive ||
        orientationInitialized ||
        gyroSamples > 0 ||
        (gyroFallbackActive && sectors >= 2))
  );

  const sweepTarget = webxrActive ? CALIBRATION_WEBXR_MIN_SECTORS : CALIBRATION_MIN_SECTORS;
  const orbTarget = webxrActive ? 1 : CALIBRATION_MIN_ORB_KEYFRAMES;

  // Prevent soft-locks on completely blank walls or environments without Web Workers (e.g. legacy WebViews/jsdom)
  const orbFallbackEligible = Boolean(
    !orbWorkerSupported || elapsedMs >= CALIBRATION_ORB_FALLBACK_WAIT_MS
  );
  const orbOk = Boolean(
    orbCount >= orbTarget ||
      (orbFallbackEligible &&
        sectors >= CALIBRATION_FALLBACK_SECTORS &&
        frames >= CALIBRATION_MIN_CAMERA_FRAMES)
  );
  const sweepOk = sectors >= sweepTarget;

  const sufficient = Boolean(cameraOk && motionOk && sweepOk && orbOk);

  // Weighted progress bar (0..100%) so the user always sees smooth forward feedback
  const camWeight = cameraReady ? (lensOccluded ? 0.05 : 0.15) : 0;
  const motionWeight = motionOk ? 0.15 : 0;
  const sweepFrac = Math.min(1, sectors / Math.max(1, sweepTarget));
  const orbFrac = orbOk ? 1 : Math.min(1, orbCount / Math.max(1, orbTarget));
  const rawPct = Math.round(
    (camWeight + motionWeight + sweepFrac * 0.52 + orbFrac * 0.18) * 100
  );
  const progressPct = sufficient ? 100 : Math.max(0, Math.min(99, rawPct));

  let blockingStep = 'ready';
  let headline = 'Ready to Spray!';
  let subHint = 'Your space is lined up — start drawing in 3D!';

  if (!cameraReady) {
    blockingStep = 'camera';
    headline = 'Camera Needed';
    subHint = 'Allow camera access so we can line up your surroundings.';
  } else if (lensOccluded) {
    blockingStep = 'occluded';
    headline = 'Camera View Too Dark';
    subHint = 'Uncover the back camera and point it at a lit area.';
  } else if (needsGyroTap) {
    blockingStep = 'motion';
    headline = 'Allow Motion Access';
    subHint = 'Tap the button below so your phone can follow how you aim.';
  } else if (!motionOk) {
    blockingStep = 'motion';
    headline = 'Waking Up Tracking…';
    subHint = 'Hold your phone upright and gently tilt it side to side.';
  } else if (!sweepOk) {
    blockingStep = 'sweep';
    headline = 'Look Around to Set Up';
    subHint = sweepHint || 'Move your phone slowly left, right, and up/down to reveal the logo.';
  } else if (!orbOk) {
    blockingStep = 'orb';
    headline = 'Almost Ready';
    subHint = 'Hold steady and aim at something with detail (like a wall, sign, or floor).';
  }

  return {
    sufficient,
    progressPct,
    blockingStep,
    headline,
    subHint,
    sweepTarget,
    orbTarget,
    lensOccluded,
    checks: {
      camera: cameraOk,
      motion: motionOk,
      sweep: sweepOk,
      orb: orbOk,
      gps: Boolean(hasLocation),
      gpsAccuracyM: finiteNum(gpsAccuracyM),
      magneticInterference: Boolean(magneticInterference)
    }
  };
}

export function createCalibrationHealthState() {
  return {
    cameraDownSinceMs: 0,
    occludedSinceMs: 0,
    sensorStallSinceMs: 0,
    magInterferenceSinceMs: 0,
    relocatedStreak: 0,
    lastGpsFixTs: 0,
    relocalizingSinceMs: 0,
    relocalizingReason: '',
    relocalizingMeta: null
  };
}

/**
 * Continuous hysteresis monitor evaluated while `calibrationState` is `'calibrated'` or `'relocalizing'`.
 *
 * Crucially:
 * - Turning/tilting the phone in place NEVER loses calibration.
 * - Opening/closing overlays (Map, Publish, Chat, Profile) NEVER loses calibration by itself.
 * - Single GPS multipath jumps or brief <4.5s magnetic blips NEVER lose calibration.
 * - When a possible disruption occurs and session ORB keyframes exist, enters `'relocalizing'`
 *   first so off-thread visual matching can silently relock within ~2.4s before interrupting the user.
 */
export function stepCalibrationHealthMonitor(
  healthState,
  {
    nowMs = Date.now(),
    isVisible = true,
    cameraReady = true,
    cameraRecovering = false,
    sceneContrast = 12,
    horizonLuminance = 120,
    hasOrientationHardware = true,
    lastOrientationEventTs = 0,
    webxrActive = false,
    magneticInterference = false,
    anchorLocation = null,
    currentLocation = null,
    currentLocationTs = 0,
    hasSessionOrbKeyframes = false,
    orbRelockMatched = false,
    backgroundWalkCalibration = false
  } = {}
) {
  const st = healthState || createCalibrationHealthState();

  // If currently in silent relocalization window and ORB matched -> instantly heal!
  if (st.relocalizingSinceMs > 0 && orbRelockMatched) {
    st.relocalizingSinceMs = 0;
    st.relocalizingReason = '';
    st.relocalizingMeta = null;
    st.relocatedStreak = 0;
    st.magInterferenceSinceMs = 0;
    return { status: 'calibrated', silentRelocked: true, loss: null };
  }

  if (!isVisible) {
    return {
      status: st.relocalizingSinceMs > 0 ? 'relocalizing' : 'calibrated',
      silentRelocked: false,
      loss: null
    };
  }

  // 1) Camera stream dead (sustained beyond auto-recovery grace)
  if (!cameraReady && !cameraRecovering) {
    if (!st.cameraDownSinceMs) st.cameraDownSinceMs = nowMs;
    if (nowMs - st.cameraDownSinceMs >= CALIBRATION_CAMERA_LOST_MS) {
      return {
        status: 'lost',
        silentRelocked: false,
        loss: buildCalibrationLossDetails('camera_lost')
      };
    }
  } else {
    st.cameraDownSinceMs = 0;
  }

  // 2) Lens covered / pitch black for sustained period
  if (cameraReady && sceneContrast < 0.45 && horizonLuminance < 10) {
    if (!st.occludedSinceMs) st.occludedSinceMs = nowMs;
    if (nowMs - st.occludedSinceMs >= CALIBRATION_OCCLUDED_LOST_MS) {
      return {
        status: 'lost',
        silentRelocked: false,
        loss: buildCalibrationLossDetails('camera_occluded')
      };
    }
  } else {
    st.occludedSinceMs = 0;
  }

  // 3) Motion/orientation stream stalled on a gyro-capable device
  if (
    hasOrientationHardware &&
    !webxrActive &&
    lastOrientationEventTs > 0 &&
    nowMs - lastOrientationEventTs >= CALIBRATION_SENSOR_STALL_MS
  ) {
    if (!st.sensorStallSinceMs) st.sensorStallSinceMs = nowMs;
    if (nowMs - st.sensorStallSinceMs >= 600) {
      return {
        status: 'lost',
        silentRelocked: false,
        loss: buildCalibrationLossDetails('sensor_stalled')
      };
    }
  } else {
    st.sensorStallSinceMs = 0;
  }

  // 4) Sustained magnetic interference (ignore brief spikes < 4.5s)
  if (!webxrActive && magneticInterference) {
    if (!st.magInterferenceSinceMs) st.magInterferenceSinceMs = nowMs;
    if (nowMs - st.magInterferenceSinceMs >= CALIBRATION_MAG_INTERFERENCE_MS) {
      if (hasSessionOrbKeyframes && !st.relocalizingSinceMs) {
        st.relocalizingSinceMs = nowMs;
        st.relocalizingReason = 'magnetic_interference';
        st.relocalizingMeta = {};
        return { status: 'relocalizing', silentRelocked: false, loss: null };
      }
      if (!st.relocalizingSinceMs || nowMs - st.relocalizingSinceMs >= CALIBRATION_RELOCK_GRACE_MS) {
        return {
          status: 'lost',
          silentRelocked: false,
          loss: buildCalibrationLossDetails('magnetic_interference')
        };
      }
    }
  } else {
    st.magInterferenceSinceMs = 0;
  }

  // 5) Confirmed physical GPS relocation (accuracy-aware + multi-fix hysteresis)
  const aLat = finiteNum(anchorLocation?.lat);
  const aLng = finiteNum(anchorLocation?.lng);
  const cLat = finiteNum(currentLocation?.lat);
  const cLng = finiteNum(currentLocation?.lng);
  if (aLat !== null && aLng !== null && cLat !== null && cLng !== null) {
    const distM = haversineMeters(aLat, aLng, cLat, cLng);
    const curAcc = finiteNum(currentLocation?.accuracy) ?? 12;
    const ancAcc = finiteNum(anchorLocation?.accuracy) ?? 12;
    const thresholdM = computeRelocationThresholdMeters(ancAcc, curAcc);

    const isFreshFix = currentLocationTs <= 0 || currentLocationTs !== st.lastGpsFixTs;
    if (isFreshFix) {
      st.lastGpsFixTs = currentLocationTs || nowMs;
      const singleHighAccMove =
        curAcc <= 10 && distM >= CALIBRATION_SINGLE_HIGH_ACC_RELOCATE_METERS;
      if (singleHighAccMove) {
        st.relocatedStreak = CALIBRATION_RELOCATE_CONFIRMED_FIXES;
      } else if (distM >= thresholdM) {
        st.relocatedStreak += 1;
      } else {
        st.relocatedStreak = 0;
      }
    }

    if (st.relocatedStreak >= CALIBRATION_RELOCATE_CONFIRMED_FIXES) {
      // While actively walking toward a land with the camera open (and no locked unsaved draft),
      // seamlessly re-anchor & refresh calibration behind the scenes instead of interrupting with a blocking modal.
      if (backgroundWalkCalibration) {
        st.relocatedStreak = 0;
        st.relocalizingSinceMs = 0;
        st.relocalizingReason = '';
        st.relocalizingMeta = null;
        return {
          status: 'calibrated',
          silentRelocked: false,
          backgroundWalkRefresh: true,
          distanceMeters: distM,
          loss: null
        };
      }
      if (hasSessionOrbKeyframes && !st.relocalizingSinceMs) {
        st.relocalizingSinceMs = nowMs;
        st.relocalizingReason = 'relocated';
        st.relocalizingMeta = { distanceMeters: distM };
        return { status: 'relocalizing', silentRelocked: false, loss: null };
      }
      if (!st.relocalizingSinceMs || nowMs - st.relocalizingSinceMs >= CALIBRATION_RELOCK_GRACE_MS) {
        return {
          status: 'lost',
          silentRelocked: false,
          loss: buildCalibrationLossDetails('relocated', { distanceMeters: distM })
        };
      }
    }
  }

  // 6) Active silent relocalization grace timer expiration
  if (st.relocalizingSinceMs > 0) {
    if (nowMs - st.relocalizingSinceMs >= CALIBRATION_RELOCK_GRACE_MS) {
      const code = st.relocalizingReason || 'relocated';
      const meta = st.relocalizingMeta || {};
      st.relocalizingSinceMs = 0;
      st.relocalizingReason = '';
      st.relocalizingMeta = null;
      if (backgroundWalkCalibration && code === 'relocated') {
        st.relocatedStreak = 0;
        return {
          status: 'calibrated',
          silentRelocked: false,
          backgroundWalkRefresh: true,
          distanceMeters: finiteNum(meta.distanceMeters) ?? 0,
          loss: null
        };
      }
      return {
        status: 'lost',
        silentRelocked: false,
        loss: buildCalibrationLossDetails(code, meta)
      };
    }
    return { status: 'relocalizing', silentRelocked: false, loss: null };
  }

  return { status: 'calibrated', silentRelocked: false, loss: null };
}
