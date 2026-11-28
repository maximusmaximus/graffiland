import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { computeProximitySharpness } from './arLandGuidance.js';

export const WALKING_MIN_SPEED_MPS = 0.3;
export const WALKING_MIN_DISPLACEMENT_M = 0.55;
export const WALKING_HOLD_MS = 3200;
export const APPROACH_FULL_OPACITY_METERS = 12;
export const APPROACH_CLOSING_START_METERS = 85;
export const APPROACH_MIN_CLOSING_DELTA_M = 0.25;
export const APPROACH_WALK_AWAY_RESET_M = 2.5;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function distPointToSeg2D(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, pz - az);
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / lenSq, 0, 1);
  return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
}

function isPointInsideQuad2D(px, pz, pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const zi = pts[i].z;
    const xj = pts[j].x;
    const zj = pts[j].z;
    const intersects = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Computes exact live horizontal distance (meters) from the live AR camera position
 * to a land prism's nearest perimeter edge in world XZ space (returns `0` when inside).
 * Allows smooth 60fps approach opacity updates even between discrete GPS ticks.
 */
export function computeLiveLandEdgeDistanceMeters({
  cameraPos = null,
  nearbyGroupPos = null,
  cornersLocal = null,
  centerLocal = null,
  fallbackDistanceMeters = 0
} = {}) {
  const fallback = Number.isFinite(Number(fallbackDistanceMeters))
    ? Math.max(0, Number(fallbackDistanceMeters))
    : 0;
  if (!cameraPos || !Number.isFinite(Number(cameraPos.x)) || !Number.isFinite(Number(cameraPos.z))) {
    return fallback;
  }
  const ox = Number(nearbyGroupPos?.x || 0);
  const oz = Number(nearbyGroupPos?.z || 0);
  const cx = Number(cameraPos.x);
  const cz = Number(cameraPos.z);

  if (Array.isArray(cornersLocal) && cornersLocal.length >= 4) {
    const bottomWorld = cornersLocal.slice(0, 4).map((p) => ({
      x: ox + Number(p?.x || 0),
      z: oz + Number(p?.z || 0)
    }));
    if (isPointInsideQuad2D(cx, cz, bottomWorld)) {
      return 0;
    }
    let minD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bottomWorld.length; i += 1) {
      const a = bottomWorld[i];
      const b = bottomWorld[(i + 1) % bottomWorld.length];
      const d = distPointToSeg2D(cx, cz, a.x, a.z, b.x, b.z);
      if (d < minD) minD = d;
    }
    if (Number.isFinite(minD)) {
      return Number(minD.toFixed(2));
    }
  }

  if (centerLocal && Number.isFinite(Number(centerLocal.x)) && Number.isFinite(Number(centerLocal.z))) {
    const wx = ox + Number(centerLocal.x);
    const wz = oz + Number(centerLocal.z);
    return Number(Math.hypot(cx - wx, cz - wz).toFixed(2));
  }

  return fallback;
}

/**
 * Creates a reusable tracker that detects walking motion and tracks which AR lands the
 * user is actively walking toward across any camera-open mode.
 */
export function createWalkingApproachTracker() {
  return {
    lastWalkingDetectedAt: 0,
    walkingSpeedMps: 0,
    anchorGps: null,
    anchorGpsAt: 0,
    anchorCam: null,
    anchorCamAt: 0,
    byParcel: new Map()
  };
}

/**
 * Advances the walking-approach tracker for the current frame/GPS tick.
 * Detects walking from GPS speed, Kalman walking speed, GPS displacement, OR live 6-DoF
 * camera translation, and identifies every visible land whose distance is closing.
 */
export function stepWalkingApproachTracker(
  tracker,
  {
    nowMs = Date.now(),
    location = null,
    speedMps = 0,
    cameraPos = null,
    lands = []
  } = {}
) {
  const st = tracker || createWalkingApproachTracker();
  const safeSpeed = Number.isFinite(Number(speedMps)) ? Math.max(0, Number(speedMps)) : 0;
  let detectedSpeed = safeSpeed;
  let movedNow = safeSpeed >= WALKING_MIN_SPEED_MPS;

  // 1) GPS walking displacement check (covers devices where coords.speed is null)
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    if (!st.anchorGps || nowMs - st.anchorGpsAt > 5000) {
      st.anchorGps = { lat, lng };
      st.anchorGpsAt = nowMs;
    } else {
      const gpsDelta = haversineMeters(st.anchorGps.lat, st.anchorGps.lng, lat, lng);
      const dtSec = Math.max(0.25, (nowMs - st.anchorGpsAt) / 1000);
      // Guard against single noisy GPS jump (> 18 m/s sprint spike)
      const estSpeed = gpsDelta / dtSec;
      if (gpsDelta >= WALKING_MIN_DISPLACEMENT_M && estSpeed <= 8.5) {
        movedNow = true;
        detectedSpeed = Math.max(detectedSpeed, estSpeed);
        st.anchorGps = { lat, lng };
        st.anchorGpsAt = nowMs;
      }
    }
  }

  // 2) Live 6-DoF / visual-odometry / Kalman camera horizontal displacement
  const camX = Number(cameraPos?.x);
  const camZ = Number(cameraPos?.z);
  if (Number.isFinite(camX) && Number.isFinite(camZ)) {
    if (!st.anchorCam || nowMs - st.anchorCamAt > 4000) {
      st.anchorCam = { x: camX, z: camZ };
      st.anchorCamAt = nowMs;
    } else {
      const camDelta = Math.hypot(camX - st.anchorCam.x, camZ - st.anchorCam.z);
      const dtSec = Math.max(0.2, (nowMs - st.anchorCamAt) / 1000);
      const estSpeed = camDelta / dtSec;
      if (camDelta >= WALKING_MIN_DISPLACEMENT_M && estSpeed <= 8.5) {
        movedNow = true;
        detectedSpeed = Math.max(detectedSpeed, estSpeed);
        st.anchorCam = { x: camX, z: camZ };
        st.anchorCamAt = nowMs;
      }
    }
  }

  if (movedNow) {
    st.lastWalkingDetectedAt = nowMs;
    st.walkingSpeedMps = Number(detectedSpeed.toFixed(2));
  } else if (nowMs - st.lastWalkingDetectedAt > WALKING_HOLD_MS) {
    st.walkingSpeedMps = 0;
  }

  const isWalking = Boolean(
    st.lastWalkingDetectedAt > 0 && nowMs - st.lastWalkingDetectedAt <= WALKING_HOLD_MS
  );

  const activeIds = new Set();
  const byParcelId = new Map();
  let primaryApproachingParcelId = '';
  let bestApproachDist = Number.POSITIVE_INFINITY;

  for (const land of lands || []) {
    const pid = String(land?.parcelId || '').trim();
    if (!pid) continue;
    activeIds.add(pid);

    const dist = Number.isFinite(Number(land?.distanceMeters))
      ? Math.max(0, Number(land.distanceMeters))
      : Number.POSITIVE_INFINITY;
    const insideParcel = Boolean(land?.insideParcel || dist <= 1.5);

    let rec = st.byParcel.get(pid);
    if (!rec) {
      rec = {
        peakDistM: dist,
        minDistM: dist,
        lastDistM: dist,
        approachingUntilMs: 0
      };
      st.byParcel.set(pid, rec);
    } else {
      if (dist > rec.peakDistM) {
        rec.peakDistM = dist;
      }
      if (dist < rec.minDistM) {
        rec.minDistM = dist;
      }
      // If user clearly walked away from this land, reset approach baseline so haze returns naturally
      if (dist > rec.minDistM + APPROACH_WALK_AWAY_RESET_M) {
        rec.peakDistM = dist;
        rec.minDistM = dist;
        rec.approachingUntilMs = 0;
      }
      rec.lastDistM = dist;
    }

    const closingMeters = Number(Math.max(0, rec.peakDistM - dist).toFixed(2));
    const closingNow =
      isWalking &&
      (insideParcel ||
        dist <= APPROACH_FULL_OPACITY_METERS ||
        closingMeters >= APPROACH_MIN_CLOSING_DELTA_M);

    if (closingNow) {
      rec.approachingUntilMs = nowMs + WALKING_HOLD_MS;
    }

    const isApproaching = Boolean(
      isWalking && (closingNow || (rec.approachingUntilMs > nowMs && dist <= rec.minDistM + 1.2))
    );

    const info = {
      parcelId: pid,
      distanceMeters: dist,
      insideParcel,
      closingMeters,
      isWalking,
      isApproaching
    };
    byParcelId.set(pid, info);

    if (isApproaching && dist < bestApproachDist) {
      bestApproachDist = dist;
      primaryApproachingParcelId = pid;
    }
  }

  // Prune lands no longer in AR camera range
  for (const oldPid of st.byParcel.keys()) {
    if (!activeIds.has(oldPid)) {
      st.byParcel.delete(oldPid);
    }
  }

  return {
    isWalking,
    walkingSpeedMps: st.walkingSpeedMps,
    primaryApproachingParcelId,
    byParcelId
  };
}

/**
 * Computes the effective opacity and atmospheric-clarity profile for an AR land (both its
 * boundary wireframe and sculptures) when the user is walking toward it in ANY camera-open mode.
 *
 * - Strictly honors the `< 300 ft` visibility cutoff (`baseSharpness.inVisibleRange === false` -> 0).
 * - When stationary (`!isWalking`) or actively painting a stroke (`isPainting`), preserves exact
 *   existing `baseSharpness` and `baseFadeMultiplier` (e.g. 22% draw-tool ghosting).
 * - When walking toward a land in ANY camera-open mode (draw, transform, preview, inspect, view-in-AR),
 *   smoothly ramps both sculptures and land boundary edges up to **100% opacity (`1.0`)** and clears
 *   atmospheric haze to `0` as the user approaches.
 */
export function computeApproachedLandOpacityProfile({
  distanceMeters = 0,
  baseSharpness = null,
  baseFadeMultiplier = 1,
  baseWireOpacity = 0.7,
  baseWallOpacity = 0.08,
  isWalking = false,
  isApproaching = false,
  closingMeters = 0,
  insideParcel = false,
  isPainting = false
} = {}) {
  const dist = Number.isFinite(Number(distanceMeters)) ? Math.max(0, Number(distanceMeters)) : 0;
  const sharp = baseSharpness || computeProximitySharpness(dist);

  if (!sharp.inVisibleRange) {
    return {
      isApproachedWhileWalking: false,
      approachProgress: 0,
      fadeMultiplier: baseFadeMultiplier,
      sculptureOpacity: 0,
      prismWireOpacity: 0,
      prismWallOpacity: 0,
      sharpnessProfile: sharp
    };
  }

  const safeBaseFade = clamp(Number.isFinite(Number(baseFadeMultiplier)) ? Number(baseFadeMultiplier) : 1, 0.08, 1);
  const safeBaseWire = clamp(Number.isFinite(Number(baseWireOpacity)) ? Number(baseWireOpacity) : 0.7, 0, 1);
  const safeBaseWall = clamp(Number.isFinite(Number(baseWallOpacity)) ? Number(baseWallOpacity) : 0.08, 0, 0.35);

  const activeApproach = Boolean(isWalking && isApproaching && !isPainting);
  if (!activeApproach) {
    return {
      isApproachedWhileWalking: false,
      approachProgress: 0,
      fadeMultiplier: safeBaseFade,
      sculptureOpacity: Number(clamp(sharp.sculptureOpacity * safeBaseFade, 0, 1).toFixed(3)),
      prismWireOpacity: Number(clamp(safeBaseWire * sharp.prismOpacityScale, 0, 1).toFixed(3)),
      prismWallOpacity: Number(clamp(safeBaseWall * sharp.prismOpacityScale, 0, 0.35).toFixed(3)),
      sharpnessProfile: sharp
    };
  }

  let approachProgress = 1;
  if (!insideParcel && dist > APPROACH_FULL_OPACITY_METERS) {
    const span = Math.max(1, APPROACH_CLOSING_START_METERS - APPROACH_FULL_OPACITY_METERS);
    const proximityRatio = clamp(1 - (dist - APPROACH_FULL_OPACITY_METERS) / span, 0, 1);
    const closingRatio = clamp(Math.max(0, Number(closingMeters) || 0) / 8, 0, 1);
    approachProgress = clamp(
      Math.max(proximityRatio, closingRatio * 0.55 + proximityRatio * 0.45),
      0.15,
      1
    );
  }
  approachProgress = Number(approachProgress.toFixed(3));

  const fadeMultiplier = Number(lerp(safeBaseFade, 1, approachProgress).toFixed(3));
  const boostedSculptureOpacity = Number(lerp(sharp.sculptureOpacity, 1, approachProgress).toFixed(3));
  const boostedPrismScale = Number(lerp(sharp.prismOpacityScale, 1, approachProgress).toFixed(3));
  const boostedHaze = Number((sharp.atmosphericHaze * (1 - approachProgress)).toFixed(3));
  const boostedSat = Number(lerp(sharp.saturationScale, 1, approachProgress).toFixed(3));
  const boostedEmissive = Number(lerp(sharp.emissiveScale, 1, approachProgress).toFixed(3));
  const boostedRoughSoft = Number((sharp.roughnessSoftening * (1 - approachProgress)).toFixed(3));
  const boostedAniso = Number(lerp(sharp.anisotropyRatio ?? 1, 1, approachProgress).toFixed(3));
  const boostedBlurPx = Number(((sharp.canvasBlurPx ?? 0) * (1 - approachProgress)).toFixed(2));
  const boostedDprScale = Number(lerp(sharp.pixelRatioScale ?? 1, 1, approachProgress).toFixed(3));

  const prismWireOpacity = Number(
    lerp(safeBaseWire * sharp.prismOpacityScale, 1, approachProgress).toFixed(3)
  );
  const prismWallOpacity = Number(
    lerp(safeBaseWall * sharp.prismOpacityScale, Math.max(safeBaseWall, 0.16), approachProgress).toFixed(3)
  );

  const sharpnessProfile = {
    ...sharp,
    sharpness: Number(lerp(sharp.sharpness, 1, approachProgress).toFixed(3)),
    sharpnessPct: Math.round(lerp(sharp.sharpnessPct ?? 100, 100, approachProgress)),
    canvasBlurPx: boostedBlurPx,
    pixelRatioScale: boostedDprScale,
    atmosphericHaze: boostedHaze,
    saturationScale: boostedSat,
    emissiveScale: boostedEmissive,
    roughnessSoftening: boostedRoughSoft,
    anisotropyRatio: boostedAniso,
    sculptureOpacity: boostedSculptureOpacity,
    prismOpacityScale: boostedPrismScale,
    enableShadows: sharp.enableShadows || approachProgress >= 0.85
  };

  return {
    isApproachedWhileWalking: true,
    approachProgress,
    fadeMultiplier,
    sculptureOpacity: Number(clamp(boostedSculptureOpacity * fadeMultiplier, 0, 1).toFixed(3)),
    prismWireOpacity,
    prismWallOpacity,
    sharpnessProfile
  };
}
