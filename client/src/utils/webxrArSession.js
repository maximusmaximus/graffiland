import * as THREE from 'three';

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const _xrPos = new THREE.Vector3();
const _xrAnchorOrigin = new THREE.Vector3();
const _xrQuat = new THREE.Quaternion();
const _xrFwd = new THREE.Vector3();
const _rotY = new THREE.Quaternion();

/**
 * Pure helper mapping a WebXR 6-DoF viewer pose (`position`, `orientation`) relative to
 * the session's initial anchor into our True-North ENU world coordinate frame
 * (`+X = East, +Y = Up, -Z = True North`), plus the exact parent rig transform
 * (`rigPosition`, `rigQuaternion`) so Three.js's `WebXRManager` renders the XR camera at
 * the exact same world coordinates as our raycasting/drawing `camera`.
 *
 * When the session starts, `seedTrueHeadingDeg` aligns the initial WebXR horizontal
 * forward direction to the phone's fused True-North compass heading so all GPS-anchored
 * lands & sculptures align immediately and then track with centimeter-level 6-DoF ARCore stability!
 *
 * @param {{
 *   xrPos: { x: number, y: number, z: number },
 *   xrQuat: { x: number, y: number, z: number, w: number },
 *   anchorYawOffsetRad: number,
 *   anchorOriginXrPos: { x: number, y: number, z: number },
 *   baseCameraPos?: { x: number, y: number, z: number }
 * }} params
 */
export function mapWebXrPoseToTrueNorthWorld({
  xrPos,
  xrQuat,
  anchorYawOffsetRad = 0,
  anchorOriginXrPos = { x: 0, y: 0, z: 0 },
  baseCameraPos = { x: 0, y: 0.4, z: 2.2 }
}) {
  _rotY.setFromAxisAngle(UP_AXIS, anchorYawOffsetRad);

  const bx = Number(baseCameraPos?.x) || 0;
  const by = Number(baseCameraPos?.y) || 0.4;
  const bz = Number(baseCameraPos?.z) || 2.2;

  _xrAnchorOrigin
    .set(
      Number(anchorOriginXrPos?.x) || 0,
      Number(anchorOriginXrPos?.y) || 0,
      Number(anchorOriginXrPos?.z) || 0
    )
    .applyQuaternion(_rotY);

  const rigPosition = new THREE.Vector3(
    bx - _xrAnchorOrigin.x,
    by - _xrAnchorOrigin.y,
    bz - _xrAnchorOrigin.z
  );
  const rigQuaternion = _rotY.clone();

  _xrPos.set(
    (Number(xrPos?.x) || 0) - (Number(anchorOriginXrPos?.x) || 0),
    (Number(xrPos?.y) || 0) - (Number(anchorOriginXrPos?.y) || 0),
    (Number(xrPos?.z) || 0) - (Number(anchorOriginXrPos?.z) || 0)
  );
  _xrPos.applyQuaternion(_rotY);

  _xrQuat.set(
    Number(xrQuat?.x) || 0,
    Number(xrQuat?.y) || 0,
    Number(xrQuat?.z) || 0,
    Number(xrQuat?.w) || 1
  ).normalize();
  _xrQuat.premultiply(_rotY).normalize();

  return {
    position: new THREE.Vector3(bx + _xrPos.x, by + _xrPos.y, bz + _xrPos.z),
    quaternion: _xrQuat.clone(),
    rigPosition,
    rigQuaternion
  };
}

/**
 * Computes the constant Earth-vertical yaw offset (`anchorYawOffsetRad`) that rotates
 * the initial WebXR local-space viewer heading onto `seedTrueHeadingDeg` (clockwise from True North).
 */
export function computeWebXrInitialYawAlignmentRad(initialXrQuat, seedTrueHeadingDeg = 0) {
  _xrQuat.set(
    Number(initialXrQuat?.x) || 0,
    Number(initialXrQuat?.y) || 0,
    Number(initialXrQuat?.z) || 0,
    Number(initialXrQuat?.w) || 1
  ).normalize();
  _xrFwd.set(0, 0, -1).applyQuaternion(_xrQuat);
  const xrHeadingRad = Math.atan2(_xrFwd.x, -_xrFwd.z); // clockwise from XR -Z
  const trueHeadingRad = ((Number(seedTrueHeadingDeg) || 0) * Math.PI) / 180;
  // Rotating around +Y by deltaYaw changes clockwise heading by -deltaYaw
  return xrHeadingRad - trueHeadingRad;
}

/**
 * Checks whether the current browser supports WebXR `immersive-ar` sessions.
 * @returns {Promise<boolean>}
 */
export async function isWebXrArSupported() {
  if (typeof navigator === 'undefined' || !navigator.xr?.isSessionSupported) {
    return false;
  }
  try {
    return Boolean(await navigator.xr.isSessionSupported('immersive-ar'));
  } catch {
    return false;
  }
}

/**
 * Starts an optional WebXR `immersive-ar` 6-DoF session on ARCore-capable Android devices,
 * keeping the SPRAY.LAND HUD interactive via `dom-overlay`.
 *
 * @param {{
 *   renderer: THREE.WebGLRenderer,
 *   overlayRoot?: HTMLElement | null,
 *   seedTrueHeadingDeg?: number,
 *   onPose?: (worldPose: { position: THREE.Vector3, quaternion: THREE.Quaternion }) => void,
 *   onEnd?: () => void
 * }} params
 */
export async function startWebXrArSession({
  renderer,
  overlayRoot = null,
  seedTrueHeadingDeg = 0,
  onPose = null,
  onEnd = null
}) {
  if (!renderer || typeof navigator === 'undefined' || !navigator.xr?.requestSession) {
    throw new Error('WebXR immersive-ar is not supported on this browser.');
  }

  const optionalFeatures = ['local-floor'];
  const sessionInit = {
    requiredFeatures: ['local'],
    optionalFeatures
  };
  if (overlayRoot) {
    optionalFeatures.push('dom-overlay');
    sessionInit.domOverlay = { root: overlayRoot };
  }

  const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
  const gl = renderer.getContext?.();
  if (gl && typeof gl.makeXRCompatible === 'function') {
    await gl.makeXRCompatible().catch(() => {});
  }
  renderer.setClearColor?.(0x000000, 0);
  renderer.setClearAlpha?.(0);
  renderer.clear?.();
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);

  let refSpace = null;
  try {
    refSpace = await session.requestReferenceSpace('local');
  } catch {
    refSpace = null;
  }

  let anchored = false;
  let anchorYawOffsetRad = 0;
  let anchorOriginXrPos = { x: 0, y: 0, z: 0 };

  const handleEnd = () => {
    renderer.xr.enabled = false;
    onEnd?.();
  };
  session.addEventListener('end', handleEnd);

  return {
    session,
    processFrame(xrFrame, baseCameraPos = { x: 0, y: 0.4, z: 2.2 }) {
      if (!xrFrame || !refSpace) return null;
      const pose = xrFrame.getViewerPose(refSpace);
      if (!pose?.transform) return null;
      const { position, orientation } = pose.transform;
      if (!anchored) {
        anchored = true;
        anchorYawOffsetRad = computeWebXrInitialYawAlignmentRad(orientation, seedTrueHeadingDeg);
        anchorOriginXrPos = { x: position.x, y: position.y, z: position.z };
      }
      const worldPose = mapWebXrPoseToTrueNorthWorld({
        xrPos: position,
        xrQuat: orientation,
        anchorYawOffsetRad,
        anchorOriginXrPos,
        baseCameraPos
      });
      const primaryView = pose.views?.[0] || null;
      const projectionMatrix = primaryView?.projectionMatrix
        ? Array.from(primaryView.projectionMatrix)
        : null;
      const enrichedPose = {
        ...worldPose,
        projectionMatrix
      };
      onPose?.(enrichedPose);
      return enrichedPose;
    },
    async stop() {
      session.removeEventListener('end', handleEnd);
      try {
        await session.end();
      } catch {
        // ignore if already ended
      }
      renderer.xr.enabled = false;
      onEnd?.();
    }
  };
}
