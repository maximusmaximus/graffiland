import * as THREE from 'three';
import { deviceOrientationToQuaternion } from '../components/VoxelEngine3D.js';
import { estimateMagneticDeclinationDeg } from './geomagneticDeclination.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const METERS_PER_DEG_LAT = 111320;

// Basis transform from W3C Earth ENU (+X East, +Y North, +Z Up) to Three.js World (+X East, +Y Up, -Z North):
// Rotation of -90 degrees around +X maps (x, y, z) -> (x, z, -y).
const Q_W3C_EARTH_TO_THREE = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const _tmpQ1 = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _tmpQ3 = new THREE.Quaternion();
const _tmpFwd = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _tmpGravLocal = new THREE.Vector3();
const _tmpGravWorld = new THREE.Vector3();
const _tmpAxis = new THREE.Vector3();

export function normalizeDeg360(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return ((n % 360) + 360) % 360;
}

export function shortestSignedAngleDeg(targetDeg, currentDeg) {
  const a = Number(targetDeg);
  const b = Number(currentDeg);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Converts a W3C `AbsoluteOrientationSensor.quaternion` (`[qx, qy, qz, qw]`) into
 * a Three.js True-North world camera Quaternion (`+X = East, +Y = Up, -Z = True North`),
 * accounting for screen rotation and local WMM magnetic declination.
 *
 * @param {number[] | Float32Array} sensorQuatArray
 * @param {number} [screenOrientDeg]
 * @param {number} [declinationDeg] Positive East, negative West
 * @param {THREE.Quaternion} [outQuat]
 * @returns {THREE.Quaternion}
 */
export function absoluteSensorQuatToThreeCameraQuat(
  sensorQuatArray,
  screenOrientDeg = 0,
  declinationDeg = 0,
  outQuat = new THREE.Quaternion()
) {
  if (!sensorQuatArray || sensorQuatArray.length < 4) {
    return outQuat.identity();
  }
  const [qx, qy, qz, qw] = sensorQuatArray;
  if (![qx, qy, qz, qw].every(Number.isFinite)) {
    return outQuat.identity();
  }

  _tmpQ1.set(qx, qy, qz, qw).normalize();
  // Positive East declination means Magnetic North lies +decl clockwise from True North,
  // which is -decl rotation around Three.js +Y (Up).
  _tmpQ2.setFromAxisAngle(UP_AXIS, -(Number(declinationDeg) || 0) * DEG2RAD);
  _tmpQ3.setFromAxisAngle(Z_AXIS, -(Number(screenOrientDeg) || 0) * DEG2RAD);

  outQuat.copy(_tmpQ2).multiply(Q_W3C_EARTH_TO_THREE).multiply(_tmpQ1).multiply(_tmpQ3).normalize();
  return outQuat;
}

/**
 * Extracts clockwise compass heading (0° = True North, 90° = East, 180° = South, 270° = West)
 * from a Three.js camera Quaternion in our True-North ENU world frame.
 * @param {THREE.Quaternion} quat
 * @returns {number}
 */
export function extractCameraHeadingDegFromQuat(quat) {
  if (!quat) return 0;
  _tmpFwd.set(0, 0, -1).applyQuaternion(quat);
  const horiz = Math.hypot(_tmpFwd.x, _tmpFwd.z);
  if (horiz > 0.12) {
    return normalizeDeg360(Math.atan2(_tmpFwd.x, -_tmpFwd.z) * RAD2DEG);
  }
  // Phone pointed nearly straight up or down: fall back to screen-up vector projected on ground
  _tmpUp.set(0, 1, 0).applyQuaternion(quat);
  const sign = _tmpFwd.y >= 0 ? -1 : 1;
  return normalizeDeg360(Math.atan2(_tmpUp.x * sign, -_tmpUp.z * sign) * RAD2DEG);
}

/**
 * Estimates a realistic Three.js PerspectiveCamera vertical FOV (degrees) matching
 * the live rear camera video stream & viewport aspect ratio (accounting for optical/digital zoom).
 *
 * @param {{
 *   videoTrack?: MediaStreamTrack | null,
 *   videoWidth?: number,
 *   videoHeight?: number,
 *   viewportWidth?: number,
 *   viewportHeight?: number
 * }} [options]
 * @returns {number}
 */
export function estimateCameraVerticalFovDeg({
  videoTrack = null,
  videoWidth = 0,
  videoHeight = 0,
  viewportWidth = 390,
  viewportHeight = 844
} = {}) {
  const settings =
    videoTrack && typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() || {} : {};
  const zoom = Number.isFinite(Number(settings.zoom)) && Number(settings.zoom) > 0.4
    ? Number(settings.zoom)
    : 1;

  const vpW = Math.max(1, Number(viewportWidth) || 390);
  const vpH = Math.max(1, Number(viewportHeight) || 844);
  const isPortrait = vpH >= vpW;

  // Typical rear wide smartphone camera (~26mm equiv): ~64-67° vertical FOV in portrait, ~50-54° in landscape.
  // If cover-cropping a 16:9 sensor in portrait, adjust slightly by viewport/sensor ratio.
  let baseFovDeg = isPortrait ? 65 : 53;
  const vW = Number(settings.width || videoWidth || 0);
  const vH = Number(settings.height || videoHeight || 0);
  if (vW > 0 && vH > 0) {
    const vpAspect = vpW / vpH;
    const vidAspect = vW / vH;
    if (isPortrait && vidAspect > vpAspect * 1.15) {
      // Sensor is wider than viewport: cover-crop retains full vertical sensor height
      baseFovDeg = 65;
    } else if (!isPortrait && vpAspect > vidAspect * 1.15) {
      // Viewport wider than sensor: vertical FOV narrows proportionally
      const cropScale = vidAspect / vpAspect;
      baseFovDeg = 2 * Math.atan(Math.tan((54 * DEG2RAD) / 2) * cropScale) * RAD2DEG;
    }
  }

  const zoomedFov = 2 * Math.atan(Math.tan((baseFovDeg * DEG2RAD) / 2) / zoom) * RAD2DEG;
  return Number(Math.max(34, Math.min(78, zoomedFov)).toFixed(1));
}

/**
 * Multi-sensor True-North AR orientation fusion engine:
 * - Android: W3C `AbsoluteOrientationSensor` (60Hz hardware quaternion) or `deviceorientationabsolute`,
 *   converted from Magnetic North to True North using WMM-2025 declination.
 * - iOS Safari: Complementary quaternion filter fusing 60Hz `devicemotion.rotationRate` +
 *   gravity (`accelerationIncludingGravity`) + True-North `webkitCompassHeading` weighted by
 *   `webkitCompassAccuracy` with automatic magnetic-spike anomaly rejection.
 * - Cross-checks persistent magnetometer bias against walking GPS course-over-ground.
 * - Applies ORB visual yaw correction and user manual compass nudge cleanly without disturbing gyro.
 */
export class ArOrientationFusion {
  constructor() {
    this.quat = new THREE.Quaternion();
    this.initialized = false;
    this.source = 'none'; // 'absolute-sensor' | 'ios-compass-fused' | 'absolute-euler' | 'relative-gyro' | 'none'
    this.trueNorthLocked = false;
    this.declinationDeg = 0;
    this.headingAccuracyDeg = null;
    this.magneticInterference = false;
    this.interferenceUntilMs = 0;
    this.manualYawNudgeDeg = 0;
    this.orbYawCorrectionRad = 0;
    this.courseBiasDeg = 0;

    this.lastAbsSensorTs = 0;
    this.lastMotionTs = 0;
    this.lastGyroRateDegPerSec = 0;
    this.lastCompassHeadingDeg = null;
    this.lastCompassTs = 0;
    this.prevRelQuat = null;
    this.lastHeadingDeg = 0;
  }

  setLocation(lat, lng, date = new Date()) {
    const nextDecl = estimateMagneticDeclinationDeg(lat, lng, date);
    if (Number.isFinite(nextDecl)) {
      this.declinationDeg = nextDecl;
    }
    return this.declinationDeg;
  }

  setManualYawNudgeDeg(deg) {
    const n = Number(deg);
    this.manualYawNudgeDeg = Number.isFinite(n)
      ? Math.max(-45, Math.min(45, Math.round(n * 10) / 10))
      : 0;
    return this.manualYawNudgeDeg;
  }

  adjustManualYawNudgeDeg(deltaDeg) {
    return this.setManualYawNudgeDeg(this.manualYawNudgeDeg + (Number(deltaDeg) || 0));
  }

  setOrbYawCorrectionRad(rad) {
    if (Number.isFinite(rad)) {
      this.orbYawCorrectionRad = Math.max(-0.7, Math.min(0.7, rad));
    }
  }

  /**
   * Ingests a W3C `AbsoluteOrientationSensor` quaternion `[qx, qy, qz, qw]`.
   */
  updateFromAbsoluteSensor(sensorQuatArray, screenOrientDeg = 0, nowMs = Date.now()) {
    const targetQ = absoluteSensorQuatToThreeCameraQuat(
      sensorQuatArray,
      screenOrientDeg,
      this.declinationDeg,
      new THREE.Quaternion()
    );
    this.lastAbsSensorTs = nowMs;

    const targetHeading = extractCameraHeadingDegFromQuat(targetQ);
    if (!this.initialized) {
      this.quat.copy(targetQ);
      this.initialized = true;
      this.source = 'absolute-sensor';
      this.trueNorthLocked = true;
      this.headingAccuracyDeg = 6;
      this.lastHeadingDeg = targetHeading;
      this.lastCompassHeadingDeg = targetHeading;
      this.lastCompassTs = nowMs;
      return this.quat;
    }

    const curHeading = extractCameraHeadingDegFromQuat(this.quat);
    const yawJump = Math.abs(shortestSignedAngleDeg(targetHeading, curHeading));
    const dtSec = Math.max(0.01, (nowMs - (this.lastCompassTs || nowMs - 16)) / 1000);
    const maxExpectedGyroYaw = Math.max(12, this.lastGyroRateDegPerSec * dtSec * 2.2 + 8);
    const isMagneticSpike =
      this.lastMotionTs > 0 &&
      nowMs - this.lastMotionTs < 400 &&
      yawJump > 22 &&
      yawJump > maxExpectedGyroYaw;

    if (isMagneticSpike) {
      this.magneticInterference = true;
      this.interferenceUntilMs = nowMs + 4500;
      this.quat.slerp(targetQ, 0.08);
    } else {
      if (nowMs > this.interferenceUntilMs) {
        this.magneticInterference = false;
      }
      this.quat.slerp(targetQ, 0.55);
    }

    this.source = 'absolute-sensor';
    this.trueNorthLocked = true;
    this.headingAccuracyDeg = this.magneticInterference ? 28 : 6;
    this.lastHeadingDeg = extractCameraHeadingDegFromQuat(this.quat);
    this.lastCompassHeadingDeg = targetHeading;
    this.lastCompassTs = nowMs;
    return this.quat;
  }

  /**
   * Ingests `deviceorientation` or `deviceorientationabsolute` events (iOS & Android).
   */
  updateFromDeviceOrientation(event, screenOrientDeg = 0, nowMs = Date.now()) {
    if (!event) return this.quat;
    if (event.alpha === null && event.beta === null && event.gamma === null) return this.quat;

    // Prefer native 60Hz AbsoluteOrientationSensor quaternion when actively streaming
    if (this.source === 'absolute-sensor' && nowMs - this.lastAbsSensorTs < 650) {
      return this.quat;
    }

    const alpha = Number(event.alpha) || 0;
    const beta = Number(event.beta) || 0;
    const gamma = Number(event.gamma) || 0;

    // 1) iOS Safari True-North compass (`webkitCompassHeading` clockwise from True North)
    const hasIosCompass =
      typeof event.webkitCompassHeading === 'number' &&
      Number.isFinite(event.webkitCompassHeading) &&
      event.webkitCompassHeading >= 0;

    if (hasIosCompass) {
      const trueHeadingDeg = normalizeDeg360(event.webkitCompassHeading + (Number(screenOrientDeg) || 0));
      const rawAcc = Number(event.webkitCompassAccuracy);
      const compassAcc = Number.isFinite(rawAcc) ? (rawAcc < 0 ? 90 : rawAcc) : 15;
      const trueAlphaDeg = normalizeDeg360(360 - trueHeadingDeg);
      const compassQuat = deviceOrientationToQuaternion(trueAlphaDeg, beta, gamma, screenOrientDeg);

      // Compute smooth relative gyro delta from iOS relative (alpha, beta, gamma)
      const curRelQuat = deviceOrientationToQuaternion(alpha, beta, gamma, screenOrientDeg);

      if (!this.initialized || this.source === 'relative-gyro') {
        this.quat.copy(compassQuat);
        this.prevRelQuat = curRelQuat.clone();
        this.initialized = true;
        this.source = 'ios-compass-fused';
        this.trueNorthLocked = true;
        this.headingAccuracyDeg = Math.round(compassAcc);
        this.lastCompassHeadingDeg = trueHeadingDeg;
        this.lastCompassTs = nowMs;
        this.lastHeadingDeg = trueHeadingDeg;
        return this.quat;
      }

      // Predict step using ultra-smooth gyro delta from relative orientation
      let gyroYawStepDeg = 0;
      if (this.prevRelQuat) {
        const prevHeading = extractCameraHeadingDegFromQuat(this.prevRelQuat);
        const curRelHeading = extractCameraHeadingDegFromQuat(curRelQuat);
        gyroYawStepDeg = Math.abs(shortestSignedAngleDeg(curRelHeading, prevHeading));

        _tmpQ1.copy(this.prevRelQuat).invert().multiply(curRelQuat);
        this.quat.multiply(_tmpQ1).normalize();
      }
      this.prevRelQuat = curRelQuat.clone();

      // Complementary True-North yaw pull with magnetic-spike anomaly rejection
      const predictedHeading = extractCameraHeadingDegFromQuat(this.quat);
      const yawErrDeg = shortestSignedAngleDeg(trueHeadingDeg, predictedHeading);
      const compassJumpDeg =
        this.lastCompassHeadingDeg !== null
          ? Math.abs(shortestSignedAngleDeg(trueHeadingDeg, this.lastCompassHeadingDeg))
          : 0;
      const isMagneticSpike =
        compassJumpDeg > 20 && gyroYawStepDeg < 4.5 && Math.abs(yawErrDeg) > 18;

      let yawGain = 0.14;
      if (isMagneticSpike) {
        this.magneticInterference = true;
        this.interferenceUntilMs = nowMs + 4500;
        yawGain = 0.015;
      } else {
        if (nowMs > this.interferenceUntilMs) {
          this.magneticInterference = false;
        }
        if (compassAcc > 30) yawGain = 0.025;
        else if (compassAcc > 18) yawGain = 0.07;
        else yawGain = 0.16;
      }

      // Apply pure Earth-vertical (+Y) yaw correction without disturbing pitch/roll smoothness
      _tmpQ2.setFromAxisAngle(UP_AXIS, -yawErrDeg * yawGain * DEG2RAD);
      this.quat.premultiply(_tmpQ2).normalize();

      this.source = 'ios-compass-fused';
      this.trueNorthLocked = true;
      this.headingAccuracyDeg = Math.round(
        this.magneticInterference ? Math.max(30, compassAcc) : compassAcc
      );
      this.lastCompassHeadingDeg = trueHeadingDeg;
      this.lastCompassTs = nowMs;
      this.lastHeadingDeg = extractCameraHeadingDegFromQuat(this.quat);
      return this.quat;
    }

    // 2) Android/Firefox Earth-referenced `deviceorientationabsolute` (Magnetic North + WMM declination)
    if (event.absolute === true) {
      // W3C alpha is CCW from Magnetic North; subtracting positive East declination yields CCW from True North
      const trueAlphaDeg = normalizeDeg360(alpha - this.declinationDeg);
      const absQuat = deviceOrientationToQuaternion(trueAlphaDeg, beta, gamma, screenOrientDeg);
      const targetHeading = extractCameraHeadingDegFromQuat(absQuat);

      if (!this.initialized || this.source === 'relative-gyro') {
        this.quat.copy(absQuat);
        this.initialized = true;
      } else {
        const curHeading = extractCameraHeadingDegFromQuat(this.quat);
        const jump = Math.abs(shortestSignedAngleDeg(targetHeading, curHeading));
        const isSpike =
          this.lastMotionTs > 0 &&
          nowMs - this.lastMotionTs < 400 &&
          jump > 24 &&
          this.lastGyroRateDegPerSec < 12;
        if (isSpike) {
          this.magneticInterference = true;
          this.interferenceUntilMs = nowMs + 4500;
          this.quat.slerp(absQuat, 0.06);
        } else {
          if (nowMs > this.interferenceUntilMs) this.magneticInterference = false;
          this.quat.slerp(absQuat, 0.45);
        }
      }

      this.source = 'absolute-euler';
      this.trueNorthLocked = true;
      this.headingAccuracyDeg = this.magneticInterference ? 28 : 10;
      this.lastCompassHeadingDeg = targetHeading;
      this.lastCompassTs = nowMs;
      this.lastHeadingDeg = extractCameraHeadingDegFromQuat(this.quat);
      return this.quat;
    }

    // 3) Fallback: relative gyro-only `deviceorientation` (only if no absolute/compass source locked yet)
    if (!this.trueNorthLocked) {
      const relQuat = deviceOrientationToQuaternion(alpha, beta, gamma, screenOrientDeg);
      if (!this.initialized) {
        this.quat.copy(relQuat);
        this.initialized = true;
      } else {
        this.quat.slerp(relQuat, 0.5);
      }
      this.source = 'relative-gyro';
      this.headingAccuracyDeg = null;
      this.lastHeadingDeg = extractCameraHeadingDegFromQuat(this.quat);
    }
    return this.quat;
  }

  /**
   * Ingests `devicemotion` (`rotationRate` + `accelerationIncludingGravity`) to track
   * angular speed for magnetic spike rejection and apply gentle gravity-horizon stabilization
   * (preventing vertical pitch/roll drift and Euler gimbal-lock flips).
   */
  updateFromDeviceMotion(event, screenOrientDeg = 0, nowMs = Date.now()) {
    if (!event) return;
    const dtSec = this.lastMotionTs > 0 ? Math.min(0.1, Math.max(0.004, (nowMs - this.lastMotionTs) / 1000)) : 0;
    this.lastMotionTs = nowMs;

    const rr = event.rotationRate;
    if (rr && Number.isFinite(rr.alpha) && Number.isFinite(rr.beta) && Number.isFinite(rr.gamma)) {
      this.lastGyroRateDegPerSec = Math.hypot(rr.alpha, rr.beta, rr.gamma);
    }

    // Gravity-vector horizon stabilization when holding phone steadily (magnitude near 1g = 9.81 m/s^2)
    const ag = event.accelerationIncludingGravity;
    if (
      this.initialized &&
      dtSec > 0 &&
      ag &&
      Number.isFinite(ag.x) &&
      Number.isFinite(ag.y) &&
      Number.isFinite(ag.z)
    ) {
      const mag = Math.hypot(ag.x, ag.y, ag.z);
      if (mag >= 8.7 && mag <= 10.9) {
        // In Web DeviceMotion, accelerationIncludingGravity points UP (+g along sky) when stationary
        // (or opposite on some older iOS quirks — detect sign cleanly by comparing with current world +Y!).
        _tmpGravLocal.set(ag.x / mag, ag.y / mag, ag.z / mag);
        if (screenOrientDeg) {
          _tmpQ3.setFromAxisAngle(Z_AXIS, (Number(screenOrientDeg) || 0) * DEG2RAD);
          _tmpGravLocal.applyQuaternion(_tmpQ3);
        }
        _tmpGravWorld.copy(_tmpGravLocal).applyQuaternion(this.quat).normalize();
        // Handle iOS vs Android gravity sign convention automatically
        if (_tmpGravWorld.y < 0) {
          _tmpGravWorld.negate();
        }
        const dotUp = Math.max(-1, Math.min(1, _tmpGravWorld.y));
        const tiltErrRad = Math.acos(dotUp);
        if (tiltErrRad > 0.004 && tiltErrRad < 0.35) {
          _tmpAxis.crossVectors(_tmpGravWorld, UP_AXIS);
          const axisLen = _tmpAxis.length();
          if (axisLen > 1e-4) {
            _tmpAxis.divideScalar(axisLen);
            // Gentle 3.5% gravity-horizon tilt correction (preserves yaw, stabilizes pitch/roll!)
            _tmpQ2.setFromAxisAngle(_tmpAxis, tiltErrRad * 0.035);
            this.quat.premultiply(_tmpQ2).normalize();
          }
        }
      }
    }
  }

  /**
   * Cross-checks persistent magnetometer bias against GPS course-over-ground while
   * the user is walking steadily outdoors (`speed >= 0.9 m/s`, good GPS fix).
   */
  updateFromGpsCourse({ headingDeg, speedMps, accuracyM } = {}) {
    if (!this.initialized || !this.trueNorthLocked) return;
    const h = Number(headingDeg);
    const spd = Number(speedMps);
    const acc = Number(accuracyM);
    if (!Number.isFinite(h) || !Number.isFinite(spd) || spd < 0.9) return;
    if (Number.isFinite(acc) && acc > 18) return;
    if (this.lastGyroRateDegPerSec > 18) return;

    const currentHeading = this.getTrueHeadingDeg();
    const diff = shortestSignedAngleDeg(h, currentHeading);
    // Only adjust if phone appears aimed roughly in the direction of walking (<= 35° off)
    if (Math.abs(diff) <= 35) {
      this.courseBiasDeg = Math.max(
        -25,
        Math.min(25, this.courseBiasDeg + diff * 0.05)
      );
    }
  }

  /**
   * Writes the final True-North world camera Quaternion (including ORB visual lock,
   * learned course bias, and user manual compass nudge) into `outQuat`.
   */
  getCameraQuaternion(outQuat = new THREE.Quaternion()) {
    const totalExtraYawRad =
      -(this.courseBiasDeg + this.manualYawNudgeDeg) * DEG2RAD + this.orbYawCorrectionRad;
    if (Math.abs(totalExtraYawRad) < 1e-5) {
      return outQuat.copy(this.quat);
    }
    _tmpQ2.setFromAxisAngle(UP_AXIS, totalExtraYawRad);
    return outQuat.copy(_tmpQ2).multiply(this.quat).normalize();
  }

  getTrueHeadingDeg() {
    const q = this.getCameraQuaternion(_tmpQ1);
    return Number(extractCameraHeadingDegFromQuat(q).toFixed(1));
  }

  getSensorQuality({ gpsAccuracyM = null, webxrActive = false } = {}) {
    const acc = this.headingAccuracyDeg;
    const needsCompassCalibration = Boolean(
      !webxrActive &&
        (this.magneticInterference ||
          (this.trueNorthLocked && acc !== null && acc > 25) ||
          this.source === 'relative-gyro')
    );

    let confidenceLabel = 'Relative';
    if (webxrActive) {
      confidenceLabel = '6-DoF XR';
    } else if (this.trueNorthLocked) {
      if (needsCompassCalibration) confidenceLabel = 'Calibrate';
      else if (acc !== null && acc <= 12) confidenceLabel = 'High';
      else confidenceLabel = 'Medium';
    }

    return {
      source: webxrActive ? 'webxr' : this.source,
      trueNorthLocked: webxrActive || this.trueNorthLocked,
      headingDeg: this.initialized ? this.getTrueHeadingDeg() : null,
      headingAccuracyDeg: webxrActive ? 1 : acc,
      gpsAccuracyM: Number.isFinite(Number(gpsAccuracyM)) ? Math.round(Number(gpsAccuracyM)) : null,
      magneticInterference: this.magneticInterference,
      needsCompassCalibration,
      declinationDeg: this.declinationDeg,
      manualYawNudgeDeg: this.manualYawNudgeDeg,
      orbYawDeg: Math.round(this.orbYawCorrectionRad * RAD2DEG * 10) / 10,
      confidenceLabel
    };
  }
}

/**
 * 2D ENU Position–Velocity Kalman Filter + IMU Step/Motion Dead-Reckoning.
 * Smooths noisy multipath GPS jumps and glides user position continuously at 60Hz
 * between 1Hz GPS updates so AR lands & sculptures stay rock-steady while walking.
 */
export class ArPositionKalmanFilter {
  constructor() {
    this.initialized = false;
    this.originLat = 0;
    this.originLng = 0;
    this.cosLat = 1;

    // Local ENU meters relative to (originLat, originLng): x = East, z = North
    this.east = 0;
    this.north = 0;
    this.vEast = 0;
    this.vNorth = 0;

    // Decoupled 2x2 covariance (position variance pPP, pos-vel pPV, vel variance pVV)
    this.pPP = 25;
    this.pPV = 0;
    this.pVV = 2;

    this.lastGpsEast = 0;
    this.lastGpsNorth = 0;
    this.lastGpsTs = 0;
    this.lastPredictTs = 0;
    this.sampleCount = 0;
    this.bestAccuracyM = 15;
    this.lastAltitude = null;
    this.lastAltitudeAccuracy = null;
    this.lastHeading = null;
    this.lastSpeed = 0;

    // Pending jump confirmation (prevents single multipath GPS spike from teleporting scene)
    this.pendingJump = null;

    // IMU step detector state
    this.lastStepTs = 0;
    this.gravityMagEma = 9.81;
  }

  _latLngToEnu(lat, lng) {
    return {
      east: (lng - this.originLng) * METERS_PER_DEG_LAT * this.cosLat,
      north: (lat - this.originLat) * METERS_PER_DEG_LAT
    };
  }

  _enuToLatLng(east, north) {
    return {
      lat: this.originLat + north / METERS_PER_DEG_LAT,
      lng: this.originLng + east / (METERS_PER_DEG_LAT * this.cosLat)
    };
  }

  /**
   * Advances state forward in time (`dt` seconds) with smooth velocity damping.
   */
  predict(nowMs = Date.now()) {
    if (!this.initialized) return;
    if (!this.lastPredictTs) {
      this.lastPredictTs = nowMs;
      return;
    }
    const dt = Math.max(0, Math.min(2.5, (nowMs - this.lastPredictTs) / 1000));
    this.lastPredictTs = nowMs;
    if (dt <= 1e-4) return;

    this.east += this.vEast * dt;
    this.north += this.vNorth * dt;

    // Gentle exponential damping so velocity returns cleanly to 0 when user stops walking
    const damp = Math.exp(-dt / 1.15);
    this.vEast *= damp;
    this.vNorth *= damp;
    if (Math.hypot(this.vEast, this.vNorth) < 0.04) {
      this.vEast = 0;
      this.vNorth = 0;
    }

    // Clamp dead-reckoning drift to at most 3.5m from the last trusted GPS measurement
    const driftE = this.east - this.lastGpsEast;
    const driftN = this.north - this.lastGpsNorth;
    const drift = Math.hypot(driftE, driftN);
    if (drift > 3.5) {
      const s = 3.5 / drift;
      this.east = this.lastGpsEast + driftE * s;
      this.north = this.lastGpsNorth + driftN * s;
      this.vEast *= 0.4;
      this.vNorth *= 0.4;
    }

    // Covariance prediction (process noise qAcc ~ 0.85 m/s^2)
    const q = 0.85;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    this.pPP = this.pPP + 2 * this.pPV * dt + this.pVV * dt2 + 0.25 * dt4 * q;
    this.pPV = this.pPV + this.pVV * dt + 0.5 * dt3 * q;
    this.pVV = Math.min(9, this.pVV + dt2 * q);
  }

  /**
   * Ingests a Geolocation position fix with multipath spike gating + Kalman update.
   */
  updateGps(pos, nowMs = Date.now()) {
    const coords = pos?.coords || pos;
    if (!coords) return null;
    const lat = Number(coords.latitude ?? coords.lat);
    const lng = Number(coords.longitude ?? coords.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const rawAcc = Number(coords.accuracy);
    const accuracy = Number.isFinite(rawAcc) && rawAcc > 0 ? rawAcc : 15;
    const speed = Number.isFinite(Number(coords.speed)) && Number(coords.speed) >= 0 ? Number(coords.speed) : null;
    const heading = Number.isFinite(Number(coords.heading)) ? Number(coords.heading) : null;
    const altitude = Number.isFinite(Number(coords.altitude)) ? Number(coords.altitude) : null;

    if (!this.initialized) {
      this.initialized = true;
      this.originLat = lat;
      this.originLng = lng;
      this.cosLat = Math.max(0.08, Math.cos(lat * DEG2RAD));
      this.east = 0;
      this.north = 0;
      this.vEast = 0;
      this.vNorth = 0;
      this.pPP = Math.max(4, Math.min(100, accuracy * accuracy * 0.45));
      this.pPV = 0;
      this.pVV = 1.5;
      this.lastGpsEast = 0;
      this.lastGpsNorth = 0;
      this.lastGpsTs = nowMs;
      this.lastPredictTs = nowMs;
      this.sampleCount = 1;
      this.bestAccuracyM = accuracy;
      this.lastAltitude = altitude;
      this.lastAltitudeAccuracy = Number.isFinite(Number(coords.altitudeAccuracy))
        ? Number(coords.altitudeAccuracy)
        : null;
      this.lastHeading = heading;
      this.lastSpeed = speed ?? 0;
      return this.getFilteredLocation();
    }

    this.predict(nowMs);
    const meas = this._latLngToEnu(lat, lng);
    const innovE = meas.east - this.east;
    const innovN = meas.north - this.north;
    const innovDist = Math.hypot(innovE, innovN);
    const dtGpsSec = Math.max(0.25, (nowMs - this.lastGpsTs) / 1000);
    const impliedSpeed = innovDist / dtGpsSec;

    // Multipath spike rejection: reject huge low-accuracy glitches when already tightly locked
    const currentSigma = Math.sqrt(Math.max(1, this.pPP));
    if (this.sampleCount >= 2 && accuracy > 35 && currentSigma < 10 && innovDist > 12) {
      return this.getFilteredLocation();
    }

    // Impossible single-fix teleport gating (require 2 consecutive nearby fixes to confirm large jump)
    let relocated = false;
    if (this.sampleCount >= 2 && innovDist > 20 && impliedSpeed > 14 && dtGpsSec < 8) {
      if (
        this.pendingJump &&
        nowMs - this.pendingJump.t < 6000 &&
        Math.hypot(meas.east - this.pendingJump.east, meas.north - this.pendingJump.north) <= 15
      ) {
        // Confirmed real relocation — reset filter cleanly to new spot without double-applying innovation
        this.east = meas.east;
        this.north = meas.north;
        this.vEast = 0;
        this.vNorth = 0;
        this.pPP = Math.max(4, accuracy * accuracy * 0.45);
        this.pPV = 0;
        this.pVV = 1.5;
        this.pendingJump = null;
        relocated = true;
      } else {
        this.pendingJump = { east: meas.east, north: meas.north, t: nowMs };
        return this.getFilteredLocation();
      }
    } else {
      this.pendingJump = null;
    }

    if (!relocated) {
      // Kalman measurement update
      const measSigma = Math.max(2.0, accuracy * 0.65);
      const R = measSigma * measSigma;
      const S = this.pPP + R;
      const kP = this.pPP / S;
      const kV = this.pPV / S;

      this.east += kP * innovE;
      this.north += kP * innovN;
      this.vEast += kV * innovE;
      this.vNorth += kV * innovN;

      const nextPP = (1 - kP) * this.pPP;
      const nextPV = (1 - kP) * this.pPV;
      const nextVV = Math.max(0.05, this.pVV - kV * this.pPV);
      this.pPP = nextPP;
      this.pPV = nextPV;
      this.pVV = nextVV;
    }

    // Fuse explicit GPS velocity vector when walking steadily
    if (speed !== null && speed >= 0.6 && speed <= 8 && heading !== null) {
      const hRad = heading * DEG2RAD;
      const gpsVE = speed * Math.sin(hRad);
      const gpsVN = speed * Math.cos(hRad);
      this.vEast = this.vEast * 0.45 + gpsVE * 0.55;
      this.vNorth = this.vNorth * 0.45 + gpsVN * 0.55;
    }

    this.lastGpsEast = meas.east;
    this.lastGpsNorth = meas.north;
    this.lastGpsTs = nowMs;
    this.sampleCount += 1;
    this.bestAccuracyM = Math.min(this.bestAccuracyM, accuracy);
    if (altitude !== null) {
      this.lastAltitude =
        this.lastAltitude === null ? altitude : this.lastAltitude * 0.7 + altitude * 0.3;
    }
    if (Number.isFinite(Number(coords.altitudeAccuracy))) {
      this.lastAltitudeAccuracy = Number(coords.altitudeAccuracy);
    }
    this.lastHeading = heading;
    this.lastSpeed = speed ?? Math.hypot(this.vEast, this.vNorth);

    return this.getFilteredLocation();
  }

  /**
   * Ingests `devicemotion` acceleration to detect walking steps and advance smooth
   * local ENU dead-reckoning between 1Hz GPS ticks (stays 0 when standing still).
   */
  updateImuMotion({ accelWithGravity, headingDeg, nowMs = Date.now() } = {}) {
    if (!this.initialized || !accelWithGravity) return false;
    const ax = Number(accelWithGravity.x);
    const ay = Number(accelWithGravity.y);
    const az = Number(accelWithGravity.z);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return false;

    const mag = Math.hypot(ax, ay, az);
    this.gravityMagEma = this.gravityMagEma * 0.94 + mag * 0.06;
    const dynamicPeak = mag - this.gravityMagEma;

    // Real human walking footstep impulse: 1.35..6.5 m/s^2 peak with >= 340ms cadence spacing
    if (
      dynamicPeak >= 1.35 &&
      dynamicPeak <= 6.5 &&
      nowMs - this.lastStepTs >= 340 &&
      Number.isFinite(Number(headingDeg))
    ) {
      this.predict(nowMs);
      this.lastStepTs = nowMs;
      const hRad = Number(headingDeg) * DEG2RAD;
      const stepVel = 1.15; // smooth ~1.15 m/s walking pace (~0.65m step after damping)
      this.vEast = this.vEast * 0.35 + Math.sin(hRad) * stepVel * 0.65;
      this.vNorth = this.vNorth * 0.35 + Math.cos(hRad) * stepVel * 0.65;
      return true;
    }
    return false;
  }

  getFilteredLocation() {
    if (!this.initialized) return null;
    const { lat, lng } = this._enuToLatLng(this.east, this.north);
    const estAcc = Math.round(Math.max(1.5, Math.sqrt(Math.max(1, this.pPP))) * 10) / 10;
    return {
      lat,
      lng,
      accuracy: estAcc,
      altitude: this.lastAltitude,
      altitudeAccuracy: this.lastAltitudeAccuracy,
      heading: this.lastHeading,
      speed: Number(Math.hypot(this.vEast, this.vNorth).toFixed(2))
    };
  }

  /**
   * Computes real-time 60Hz sub-meter ENU displacement relative to a reference React `location`
   * so `nearbyGroup` glides smoothly as the user walks without triggering React re-renders.
   */
  getLiveSubmeterDeltaMeters(referenceLoc, nowMs = Date.now()) {
    if (!this.initialized || !referenceLoc) return { east: 0, north: 0 };
    const refLat = Number(referenceLoc.lat);
    const refLng = Number(referenceLoc.lng);
    if (!Number.isFinite(refLat) || !Number.isFinite(refLng)) return { east: 0, north: 0 };
    this.predict(nowMs);
    const refEnu = this._latLngToEnu(refLat, refLng);
    return {
      east: this.east - refEnu.east,
      north: this.north - refEnu.north
    };
  }
}
