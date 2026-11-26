import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const _tmpDeltaQ = new THREE.Quaternion();
const _tmpScreenQ = new THREE.Quaternion();
const _tmpVec = new THREE.Vector3();

/**
 * Computes the median of a numeric array without mutating the input.
 * @param {number[]} values
 * @returns {number}
 */
export function medianOf(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

/**
 * Decomposes a small inter-frame camera rotation delta (`deltaQuat = prevQuat^-1 * curQuat`)
 * into local camera-frame axis-angle deltas `{ dPitch, dYaw, dRoll }` in radians
 * (+X right -> pitch up, +Y up -> yaw left, +Z back -> roll CCW).
 *
 * @param {THREE.Quaternion} prevQuat
 * @param {THREE.Quaternion} curQuat
 */
export function computeLocalCameraRotationDelta(prevQuat, curQuat) {
  if (!prevQuat || !curQuat) {
    return { dPitch: 0, dYaw: 0, dRoll: 0, totalRad: 0 };
  }
  _tmpDeltaQ.copy(prevQuat).invert().multiply(curQuat).normalize();
  if (_tmpDeltaQ.w < 0) {
    _tmpDeltaQ.set(-_tmpDeltaQ.x, -_tmpDeltaQ.y, -_tmpDeltaQ.z, -_tmpDeltaQ.w);
  }
  const w = Math.max(-1, Math.min(1, _tmpDeltaQ.w));
  const angle = 2 * Math.acos(w);
  if (!Number.isFinite(angle) || angle < 1e-6) {
    return { dPitch: 0, dYaw: 0, dRoll: 0, totalRad: 0 };
  }
  const sinHalf = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const scale = angle / sinHalf;
  return {
    dPitch: _tmpDeltaQ.x * scale,
    dYaw: _tmpDeltaQ.y * scale,
    dRoll: _tmpDeltaQ.z * scale,
    totalRad: angle
  };
}

/**
 * Pure, deterministic gyro-compensated monocular visual odometry estimator.
 *
 * Given two consecutive low-res grayscale camera buffers and the exact inter-frame
 * camera rotation (`prevQuat -> curQuat`), measures multi-patch optical flow across
 * a 4x3 interior grid, subtracts the exact rotational flow caused by turning/tilting
 * the phone, and extracts the pure 3D camera-space translation `{ tx, ty, tz }` in meters:
 *  - `+tx`: phone moved RIGHT  (world features shift LEFT on screen)
 *  - `+ty`: phone moved UP     (world features shift DOWN on screen)
 *  - `-tz`: phone moved FORWARD toward scene (world features diverge radially outward)
 *
 * Taking the median across 12 independent patches rejects moving pedestrians/cars
 * and keeps stationary cameras drift-free.
 *
 * @param {Uint8Array} prevGray
 * @param {Uint8Array} curGray
 * @param {number} width
 * @param {number} height
 * @param {{
 *   prevQuat?: THREE.Quaternion | null,
 *   curQuat?: THREE.Quaternion | null,
 *   vFovDeg?: number,
 *   aspect?: number,
 *   depthMeters?: number,
 *   searchRadius?: number
 * }} [opts]
 */
export function estimateGyroCompensatedVisualTranslation(
  prevGray,
  curGray,
  width,
  height,
  {
    prevQuat = null,
    curQuat = null,
    vFovDeg = 64,
    aspect = 0,
    depthMeters = 2.0,
    searchRadius = 5
  } = {}
) {
  const empty = {
    valid: false,
    trackedPatches: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    medResDx: 0,
    medResDy: 0,
    medDiv: 0,
    rotRad: 0
  };
  if (
    !prevGray ||
    !curGray ||
    width < 24 ||
    height < 24 ||
    prevGray.length < width * height ||
    curGray.length < width * height
  ) {
    return empty;
  }

  const rot = computeLocalCameraRotationDelta(prevQuat, curQuat);
  // Skip frames with extreme blur-inducing whip rotation (> ~18 deg in a single 33ms frame)
  if (rot.totalRad > 0.32) {
    return { ...empty, rotRad: rot.totalRad };
  }

  const safeFov = Math.max(32, Math.min(82, Number(vFovDeg) || 64));
  const halfTanV = Math.tan((safeFov * DEG2RAD) * 0.5);
  const safeAspect = Number(aspect) > 0.25 ? Number(aspect) : width / height;
  const fy = (height * 0.5) / halfTanV;
  const fx = (width * 0.5) / (halfTanV * safeAspect);
  const safeDepth = Math.max(0.65, Math.min(8.0, Number(depthMeters) || 2.0));

  const patchHalf = 3; // 7x7 patch (sampled at stride 2 -> 16 pixels per candidate)
  const radius = Math.max(3, Math.min(7, Math.round(searchRadius)));
  const marginX = patchHalf + radius + 2;
  const marginY = patchHalf + radius + 2;
  const cols = 4;
  const rows = 3;
  const spanX = Math.max(1, width - marginX * 2);
  const spanY = Math.max(1, height - marginY * 2);

  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const samples = [];

  for (let r = 0; r < rows; r += 1) {
    const cy = Math.round(marginY + ((r + 0.5) / rows) * spanY);
    for (let c = 0; c < cols; c += 1) {
      const cx = Math.round(marginX + ((c + 0.5) / cols) * spanX);

      // Compute patch texture variance so flat walls/sky never emit bogus matches
      let sum = 0;
      let sumSq = 0;
      let cnt = 0;
      for (let py = -patchHalf; py <= patchHalf; py += 2) {
        const rowOff = (cy + py) * width + cx;
        for (let px = -patchHalf; px <= patchHalf; px += 2) {
          const val = prevGray[rowOff + px];
          sum += val;
          sumSq += val * val;
          cnt += 1;
        }
      }
      const mean = sum / cnt;
      const variance = sumSq / cnt - mean * mean;
      if (variance < 36) continue;

      // Expected rotational pixel shift at this patch center
      const rotDx = rot.dYaw * fx - rot.dRoll * (cy - halfH);
      const rotDy = rot.dPitch * fy + rot.dRoll * (cx - halfW);
      const predOx = Math.max(-radius, Math.min(radius, Math.round(rotDx)));
      const predOy = Math.max(-radius, Math.min(radius, Math.round(rotDy)));

      const evalSad = (ox, oy) => {
        let sad = 0;
        for (let py = -patchHalf; py <= patchHalf; py += 2) {
          const prevRow = (cy + py) * width + cx;
          const curRow = (cy + py + oy) * width + (cx + ox);
          for (let px = -patchHalf; px <= patchHalf; px += 2) {
            sad += Math.abs(prevGray[prevRow + px] - curGray[curRow + px]);
          }
        }
        return sad;
      };

      // Coarse-to-fine block matching centered around rotational prediction
      let bestOx = predOx;
      let bestOy = predOy;
      let bestSad = Infinity;
      const minOx = Math.max(-radius, predOx - 4);
      const maxOx = Math.min(radius, predOx + 4);
      const minOy = Math.max(-radius, predOy - 4);
      const maxOy = Math.min(radius, predOy + 4);

      for (let oy = minOy; oy <= maxOy; oy += 2) {
        for (let ox = minOx; ox <= maxOx; ox += 2) {
          const sad = evalSad(ox, oy);
          if (sad < bestSad) {
            bestSad = sad;
            bestOx = ox;
            bestOy = oy;
          }
        }
      }

      const refOx = bestOx;
      const refOy = bestOy;
      for (let oy = Math.max(-radius, refOy - 1); oy <= Math.min(radius, refOy + 1); oy += 1) {
        for (let ox = Math.max(-radius, refOx - 1); ox <= Math.min(radius, refOx + 1); ox += 1) {
          const sad = evalSad(ox, oy);
          if (sad < bestSad) {
            bestSad = sad;
            bestOx = ox;
            bestOy = oy;
          }
        }
      }

      // Reject poor/occluded matches (average pixel error > 30 luma levels)
      if (bestSad / cnt > 30) continue;

      // Parabolic sub-pixel refinement along X and Y
      let subOx = bestOx;
      let subOy = bestOy;
      if (bestOx > -radius && bestOx < radius) {
        const sL = evalSad(bestOx - 1, bestOy);
        const sR = evalSad(bestOx + 1, bestOy);
        const denom = sL - 2 * bestSad + sR;
        if (denom > 1) {
          subOx += Math.max(-0.5, Math.min(0.5, (0.5 * (sL - sR)) / denom));
        }
      }
      if (bestOy > -radius && bestOy < radius) {
        const sU = evalSad(bestOx, bestOy - 1);
        const sD = evalSad(bestOx, bestOy + 1);
        const denom = sU - 2 * bestSad + sD;
        if (denom > 1) {
          subOy += Math.max(-0.5, Math.min(0.5, (0.5 * (sU - sD)) / denom));
        }
      }

      samples.push({
        rx: cx - halfW,
        ry: cy - halfH,
        resDx: subOx - rotDx,
        resDy: subOy - rotDy
      });
    }
  }

  if (samples.length < 4) {
    return { ...empty, trackedPatches: samples.length, rotRad: rot.totalRad };
  }

  const medResDx = medianOf(samples.map((s) => s.resDx));
  const medResDy = medianOf(samples.map((s) => s.resDy));

  // Estimate radial divergence (forward/backward depth motion) from off-center patches
  const divEstimates = [];
  for (const s of samples) {
    const r2 = s.rx * s.rx + s.ry * s.ry;
    if (r2 < 36) continue;
    const ddx = s.resDx - medResDx;
    const ddy = s.resDy - medResDy;
    divEstimates.push((ddx * s.rx + ddy * s.ry) / r2);
  }
  const medDiv = divEstimates.length >= 4 ? medianOf(divEstimates) : 0;

  // Sub-pixel noise deadzone so stationary scenes stay 100% locked
  const cleanDx = Math.abs(medResDx) < 0.14 ? 0 : medResDx;
  const cleanDy = Math.abs(medResDy) < 0.14 ? 0 : medResDy;
  const cleanDiv = Math.abs(medDiv) < 0.008 ? 0 : medDiv;

  // Convert pixel residuals to camera-frame meters (+X right, +Y up, +Z back)
  const tx = Math.max(-0.32, Math.min(0.32, -(cleanDx * safeDepth) / fx));
  const ty = Math.max(-0.32, Math.min(0.32, (cleanDy * safeDepth) / fy));
  const forwardM = Math.max(-0.26, Math.min(0.26, cleanDiv * safeDepth));
  const tz = -forwardM;

  return {
    valid: true,
    trackedPatches: samples.length,
    tx,
    ty,
    tz,
    medResDx: cleanDx,
    medResDy: cleanDy,
    medDiv: cleanDiv,
    rotRad: rot.totalRad
  };
}

/**
 * 6-DoF World-Anchored Spatial Draw Tracker for Mobile AR.
 *
 * Fuses three complementary signals so moving the phone physically through space
 * moves the **camera** through 3D world space while placed artwork stays anchored
 * in real space (instead of moving with the phone):
 *   1. Gyro-compensated monocular visual odometry from the live camera feed (~30Hz)
 *   2. ZUPT-gated gravity-free linear acceleration from `DeviceMotionEvent` (~60Hz)
 *   3. Macro East/North walking displacement from `ArPositionKalmanFilter` (GPS + IMU steps)
 */
export class ArSpatialDrawTracker {
  constructor({
    sampleWidth = 64,
    sampleHeight = 48,
    maxLocalRadiusM = 18,
    maxWalkRadiusM = 36
  } = {}) {
    this.sampleWidth = sampleWidth;
    this.sampleHeight = sampleHeight;
    this.maxLocalRadiusM = maxLocalRadiusM;
    this.maxWalkRadiusM = maxWalkRadiusM;

    // Short-term 3D VIO + IMU translation (meters in True-North Three.js world)
    this.localOffset = { x: 0, y: 0, z: 0 };
    // Macro horizontal walking displacement relative to walkOriginEnu
    this.walkOffset = { x: 0, y: 0, z: 0 };
    this.walkOriginEnu = null;

    // 3D IMU world velocity + running accelerometer bias estimate
    this.imuVel = { x: 0, y: 0, z: 0 };
    this.accelBias = { x: 0, y: 0, z: 0 };
    this.lastMotionTs = 0;
    this.stillSinceTs = 0;

    // Visual odometry frame state (zero-alloc double buffer)
    this.prevGray = null;
    this.curGray = new Uint8Array(sampleWidth * sampleHeight);
    this.prevQuat = new THREE.Quaternion();
    this.hasPrevFrame = false;
    this.lastFrameTs = 0;
    this.lastVoTs = 0;
    this.lastVoSpeedMps = 0;
    this.lastTrackedPatches = 0;
    this.scratchCanvas = null;
    this.scratchCtx = null;
    this.active = false;
  }

  /**
   * Re-anchors the spatial drawing origin to the user's current position (used when
   * starting a brand-new piece after Clear / Publish / Stale Erase).
   */
  resetOrigin({ currentEnu = null } = {}) {
    this.localOffset.x = 0;
    this.localOffset.y = 0;
    this.localOffset.z = 0;
    this.walkOffset.x = 0;
    this.walkOffset.y = 0;
    this.walkOffset.z = 0;
    this.imuVel.x = 0;
    this.imuVel.y = 0;
    this.imuVel.z = 0;
    this.stillSinceTs = 0;
    this.hasPrevFrame = false;
    if (
      currentEnu &&
      Number.isFinite(Number(currentEnu.east)) &&
      Number.isFinite(Number(currentEnu.north))
    ) {
      this.walkOriginEnu = {
        east: Number(currentEnu.east),
        north: Number(currentEnu.north)
      };
    } else {
      this.walkOriginEnu = null;
    }
  }

  _clampLocalOffset() {
    const horiz = Math.hypot(this.localOffset.x, this.localOffset.z);
    if (horiz > this.maxLocalRadiusM) {
      const s = this.maxLocalRadiusM / horiz;
      this.localOffset.x *= s;
      this.localOffset.z *= s;
    }
    this.localOffset.y = Math.max(-2.6, Math.min(3.4, this.localOffset.y));
  }

  /**
   * Ingests a live `DeviceMotionEvent` gravity-free linear acceleration sample at ~60Hz
   * with deadzone gating and Zero-Velocity Updates (ZUPT) for crisp hand/arm translation.
   */
  updateFromDeviceMotion({
    acceleration = null,
    cameraQuat = null,
    screenOrientDeg = 0,
    nowMs = Date.now()
  } = {}) {
    if (!acceleration || !cameraQuat) return false;
    const rawX = Number(acceleration.x);
    const rawY = Number(acceleration.y);
    const rawZ = Number(acceleration.z);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawZ)) {
      return false;
    }

    const dtSec =
      this.lastMotionTs > 0
        ? Math.min(0.08, Math.max(0.004, (nowMs - this.lastMotionTs) / 1000))
        : 0;
    this.lastMotionTs = nowMs;
    if (dtSec <= 0) return false;

    this.active = true;

    // Track very slow resting bias whenever device is nearly still
    const rawMag = Math.hypot(rawX, rawY, rawZ);
    if (rawMag < 0.45) {
      this.accelBias.x = this.accelBias.x * 0.96 + rawX * 0.04;
      this.accelBias.y = this.accelBias.y * 0.96 + rawY * 0.04;
      this.accelBias.z = this.accelBias.z * 0.96 + rawZ * 0.04;
    }

    const ax = rawX - this.accelBias.x;
    const ay = rawY - this.accelBias.y;
    const az = rawZ - this.accelBias.z;
    const mag = Math.hypot(ax, ay, az);

    // ZUPT (Zero-Velocity Update): rapidly zero velocity when phone stops accelerating
    if (mag < 0.34) {
      if (!this.stillSinceTs) this.stillSinceTs = nowMs;
      const stillMs = nowMs - this.stillSinceTs;
      const tau = stillMs > 90 ? 0.055 : 0.14;
      const damp = Math.exp(-dtSec / tau);
      this.imuVel.x *= damp;
      this.imuVel.y *= damp;
      this.imuVel.z *= damp;
      if (Math.hypot(this.imuVel.x, this.imuVel.y, this.imuVel.z) < 0.015) {
        this.imuVel.x = 0;
        this.imuVel.y = 0;
        this.imuVel.z = 0;
      }
      return false;
    }

    this.stillSinceTs = 0;

    // Ignore absurd shock spikes (> 18 m/s^2 = bump/drop)
    if (mag > 18) return false;

    // Soft deadzone subtraction preserves smooth acceleration ramp without jitter
    const effScale = Math.max(0, (mag - 0.24) / mag);
    _tmpVec.set(ax * effScale, ay * effScale, az * effScale);
    if (screenOrientDeg) {
      _tmpScreenQ.setFromAxisAngle(Z_AXIS, (Number(screenOrientDeg) || 0) * DEG2RAD);
      _tmpVec.applyQuaternion(_tmpScreenQ);
    }
    _tmpVec.applyQuaternion(cameraQuat);

    // When visual odometry is actively tracking, keep IMU as a responsive high-frequency
    // filler (lower gain so VIO dictates true metric scale and cancels drift).
    const voFresh = this.lastVoTs > 0 && nowMs - this.lastVoTs < 240 && this.lastTrackedPatches >= 4;
    const gain = voFresh ? 0.26 : 0.52;

    this.imuVel.x += _tmpVec.x * dtSec * gain;
    this.imuVel.y += _tmpVec.y * dtSec * gain * 0.85;
    this.imuVel.z += _tmpVec.z * dtSec * gain;

    const speed = Math.hypot(this.imuVel.x, this.imuVel.y, this.imuVel.z);
    if (speed > 2.2) {
      const cap = 2.2 / speed;
      this.imuVel.x *= cap;
      this.imuVel.y *= cap;
      this.imuVel.z *= cap;
    }

    // Apply smooth per-frame damping to prevent unbounded double-integration drift
    const driftDamp = Math.exp(-dtSec / 0.45);
    this.imuVel.x *= driftDamp;
    this.imuVel.y *= driftDamp;
    this.imuVel.z *= driftDamp;

    this.localOffset.x += this.imuVel.x * dtSec;
    this.localOffset.y += this.imuVel.y * dtSec;
    this.localOffset.z += this.imuVel.z * dtSec;
    this._clampLocalOffset();
    return true;
  }

  /**
   * Ingests a grayscale camera buffer directly (used by both live video sampling and unit tests)
   * and applies gyro-compensated visual translation in True-North Three.js world space.
   */
  ingestGrayscaleFrame(
    grayBuffer,
    {
      cameraQuat = null,
      vFovDeg = 64,
      aspect = 0,
      depthMeters = 2.0,
      nowMs = Date.now()
    } = {}
  ) {
    if (!grayBuffer || !cameraQuat) return null;
    if (!this.hasPrevFrame || !this.prevGray) {
      this.prevGray = new Uint8Array(grayBuffer);
      this.prevQuat.copy(cameraQuat);
      this.hasPrevFrame = true;
      this.lastFrameTs = nowMs;
      return null;
    }

    const dtSec = Math.max(0.012, Math.min(0.25, (nowMs - this.lastFrameTs) / 1000));
    const est = estimateGyroCompensatedVisualTranslation(
      this.prevGray,
      grayBuffer,
      this.sampleWidth,
      this.sampleHeight,
      {
        prevQuat: this.prevQuat,
        curQuat: cameraQuat,
        vFovDeg,
        aspect,
        depthMeters
      }
    );

    // Swap buffers without re-allocating
    this.prevGray.set(grayBuffer);
    this.prevQuat.copy(cameraQuat);
    this.lastFrameTs = nowMs;

    if (!est.valid) {
      this.lastTrackedPatches = est.trackedPatches;
      return est;
    }

    this.active = true;
    this.lastVoTs = nowMs;
    this.lastTrackedPatches = est.trackedPatches;

    _tmpVec.set(est.tx, est.ty, est.tz).applyQuaternion(cameraQuat);
    const stepDist = _tmpVec.length();
    this.lastVoSpeedMps = stepDist / dtSec;

    if (stepDist > 1e-4) {
      this.localOffset.x += _tmpVec.x;
      this.localOffset.y += _tmpVec.y;
      this.localOffset.z += _tmpVec.z;
      this._clampLocalOffset();

      // Continuously pull IMU velocity toward true visual velocity (kills accelerometer drift!)
      this.imuVel.x = this.imuVel.x * 0.35 + (_tmpVec.x / dtSec) * 0.65;
      this.imuVel.y = this.imuVel.y * 0.35 + (_tmpVec.y / dtSec) * 0.65;
      this.imuVel.z = this.imuVel.z * 0.35 + (_tmpVec.z / dtSec) * 0.65;
    } else {
      // Visual scene is stationary -> enforce tight ZUPT damping
      this.imuVel.x *= 0.4;
      this.imuVel.y *= 0.4;
      this.imuVel.z *= 0.4;
    }

    return {
      ...est,
      worldDelta: { x: _tmpVec.x, y: _tmpVec.y, z: _tmpVec.z }
    };
  }

  /**
   * Samples the live `<video>` feed at ~30Hz into a tiny 64x48 grayscale scratch buffer
   * and advances gyro-compensated visual odometry.
   */
  updateFromVideoElement({
    videoEl,
    cameraQuat,
    vFovDeg = 64,
    aspect = 0,
    depthMeters = 2.0,
    nowMs = Date.now()
  } = {}) {
    if (
      !videoEl ||
      !cameraQuat ||
      videoEl.readyState < 2 ||
      videoEl.paused ||
      !(videoEl.videoWidth > 0) ||
      !(videoEl.videoHeight > 0)
    ) {
      return null;
    }
    if (this.lastFrameTs > 0 && nowMs - this.lastFrameTs < 30) {
      return null;
    }
    if (!this.scratchCanvas && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = this.sampleWidth;
      c.height = this.sampleHeight;
      this.scratchCanvas = c;
      this.scratchCtx = c.getContext?.('2d', { willReadFrequently: true }) || null;
    }
    if (!this.scratchCtx) return null;

    try {
      this.scratchCtx.drawImage(videoEl, 0, 0, this.sampleWidth, this.sampleHeight);
      const img = this.scratchCtx.getImageData(0, 0, this.sampleWidth, this.sampleHeight);
      const data = img.data;
      const gray = this.curGray;
      for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
        gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      }
      return this.ingestGrayscaleFrame(gray, {
        cameraQuat,
        vFovDeg,
        aspect: aspect || videoEl.videoWidth / Math.max(1, videoEl.videoHeight),
        depthMeters,
        nowMs
      });
    } catch {
      return null;
    }
  }

  /**
   * Fuses macro walking displacement from `ArPositionKalmanFilter` (GPS + IMU steps)
   * so walking 2m–36m extends artwork lines seamlessly through real-world space without
   * double-counting visual odometry or snapping on stationary GPS noise.
   */
  updateFromKalmanWalk({ east, north, speedMps = 0, dtSec = 0.016 } = {}) {
    const e = Number(east);
    const n = Number(north);
    if (!Number.isFinite(e) || !Number.isFinite(n)) return;

    if (!this.walkOriginEnu) {
      this.walkOriginEnu = { east: e, north: n };
      return;
    }

    // Three.js True-North world: +X = East, -Z = North
    const rawWalkX = e - this.walkOriginEnu.east;
    const rawWalkZ = -(n - this.walkOriginEnu.north);
    const rawDist = Math.hypot(rawWalkX, rawWalkZ);
    const clampScale = rawDist > this.maxWalkRadiusM ? this.maxWalkRadiusM / rawDist : 1;
    const targetX = rawWalkX * clampScale;
    const targetZ = rawWalkZ * clampScale;

    const deltaX = targetX - this.walkOffset.x;
    const deltaZ = targetZ - this.walkOffset.z;
    const deltaDist = Math.hypot(deltaX, deltaZ);
    const walking = Number(speedMps) >= 0.35 || deltaDist >= 0.95;

    if (!walking) return;

    const safeDt = Math.max(0.004, Math.min(0.25, Number(dtSec) || 0.016));
    const alpha = 1 - Math.exp(-safeDt / 0.45);
    const stepX = deltaX * alpha;
    const stepZ = deltaZ * alpha;

    this.walkOffset.x += stepX;
    this.walkOffset.z += stepZ;

    // Complementary high-pass bleed on horizontal localOffset while walking so
    // GPS macro walking and VIO short-term steps never double-count total distance
    const bleed = Math.exp(-safeDt / 2.2);
    this.localOffset.x *= bleed;
    this.localOffset.z *= bleed;
  }

  /**
   * Writes the fused 6-DoF world camera position (`baseCameraPos + walkOffset + localOffset`).
   */
  getWorldCameraPosition(
    baseCameraPos = { x: 0, y: 0.4, z: 2.2 },
    outVec = new THREE.Vector3()
  ) {
    outVec.set(
      (Number(baseCameraPos?.x) || 0) + this.walkOffset.x + this.localOffset.x,
      (Number(baseCameraPos?.y) || 0.4) + this.walkOffset.y + this.localOffset.y,
      (Number(baseCameraPos?.z) || 2.2) + this.walkOffset.z + this.localOffset.z
    );
    return outVec;
  }

  /**
   * Computes the exact world position for `nearbyGroup` (existing AR lands & sculptures)
   * so moving the phone produces consistent 3D parallax against BOTH the user's draft
   * drawing AND existing nearby lands/sculptures.
   */
  getNearbyGroupPosition(
    baseCameraPos = { x: 0, y: 0.4, z: 2.2 },
    subDelta = { east: 0, north: 0 }
  ) {
    return {
      x: (Number(baseCameraPos?.x) || 0) + this.walkOffset.x - (Number(subDelta?.east) || 0),
      y: 0,
      z: (Number(baseCameraPos?.z) || 2.2) + this.walkOffset.z + (Number(subDelta?.north) || 0)
    };
  }

  getDisplacementSummary() {
    const totalX = this.walkOffset.x + this.localOffset.x;
    const totalY = this.walkOffset.y + this.localOffset.y;
    const totalZ = this.walkOffset.z + this.localOffset.z;
    return {
      active: this.active,
      trackedPatches: this.lastTrackedPatches,
      distanceMeters: Number(Math.hypot(totalX, totalY, totalZ).toFixed(2)),
      localOffset: { ...this.localOffset },
      walkOffset: { ...this.walkOffset }
    };
  }
}
