import * as THREE from 'three';

function wrapDeg180(deg) {
  let wrapped = ((((Number(deg) || 0) + 180) % 360) + 360) % 360 - 180;
  if (wrapped === -180 && deg > 0) wrapped = 180;
  return Math.round(wrapped * 10) / 10;
}

/**
 * Extracts a snapshot of two active touch pointers: distance, twist angle, and midpoint.
 *
 * @param {Array<{ x: number, y: number }>} pts
 */
export function captureTwoFingerFrame(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const p0 = pts[0];
  const p1 = pts[1];
  return {
    dist: Math.max(12, Math.hypot(p1.x - p0.x, p1.y - p0.y)),
    angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
    midX: (p0.x + p1.x) * 0.5,
    midY: (p0.y + p1.y) * 0.5
  };
}

/**
 * Computes a single-finger drag step in AR transform mode:
 * moves the staged sculpture freely across the camera's horizontal (Right) and vertical (Up) plane.
 *
 * @param {{
 *   dx: number,
 *   dy: number,
 *   cameraQuaternion: THREE.Quaternion,
 *   cameraPosition: THREE.Vector3 | { x: number, y: number, z: number },
 *   pivot: { x: number, y: number, z: number },
 *   currentTransform: {
 *     scale: number,
 *     rotXDeg?: number,
 *     rotYDeg?: number,
 *     rotZDeg?: number,
 *     offsetX: number,
 *     offsetY: number,
 *     offsetZ: number
 *   }
 * }} params
 */
export function computeOneFingerDragStep({
  dx,
  dy,
  cameraQuaternion,
  cameraPosition,
  pivot,
  currentTransform
}) {
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraQuaternion).normalize();
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cameraQuaternion).normalize();
  const camPos = new THREE.Vector3(
    Number(cameraPosition?.x || 0),
    Number(cameraPosition?.y || 0),
    Number(cameraPosition?.z || 0)
  );
  const worldPos = new THREE.Vector3(
    Number(pivot?.x || 0) + Number(currentTransform?.offsetX || 0),
    Number(pivot?.y || 0) + Number(currentTransform?.offsetY || 0),
    Number(pivot?.z || 0) + Number(currentTransform?.offsetZ || 0)
  );
  const dist = Math.max(0.8, Math.min(6, camPos.distanceTo(worldPos)));
  const moveScale = dist * 0.0024;

  return {
    ...currentTransform,
    offsetX: Number(
      (Number(currentTransform.offsetX || 0) + (camRight.x * dx - camUp.x * dy) * moveScale).toFixed(4)
    ),
    offsetY: Number(
      (Number(currentTransform.offsetY || 0) + (camRight.y * dx - camUp.y * dy) * moveScale).toFixed(4)
    ),
    offsetZ: Number(
      (Number(currentTransform.offsetZ || 0) + (camRight.z * dx - camUp.z * dy) * moveScale).toFixed(4)
    )
  };
}

/**
 * Computes a multi-axis two-finger gesture step in AR transform mode:
 * - Pinch / spread: scales smoothly (`scale`)
 * - Two-finger twist: rotates smoothly around vertical Y-axis (`rotYDeg`, full 360° turntable spin)
 * - Two-finger drag (midpoint move): positions freely in 3D ground/depth space
 *   (horizontal slide = left/right along horizontal camera right; vertical slide up/down = push further / pull closer!)
 *
 * @param {{
 *   prevFrame: { dist: number, angle: number, midX: number, midY: number },
 *   nextPointers: Array<{ x: number, y: number }>,
 *   cameraQuaternion: THREE.Quaternion,
 *   cameraPosition: THREE.Vector3 | { x: number, y: number, z: number },
 *   pivot: { x: number, y: number, z: number },
 *   currentTransform: {
 *     scale: number,
 *     rotXDeg?: number,
 *     rotYDeg?: number,
 *     rotZDeg?: number,
 *     offsetX: number,
 *     offsetY: number,
 *     offsetZ: number
 *   },
 *   minScale?: number,
 *   maxScale?: number
 * }} params
 */
export function computeTwoFingerTransformStep({
  prevFrame,
  nextPointers,
  cameraQuaternion,
  cameraPosition,
  pivot,
  currentTransform,
  minScale = 0.25,
  maxScale = 2.5
}) {
  const nextFrame = captureTwoFingerFrame(nextPointers);
  if (!nextFrame) {
    return { nextTransform: currentTransform, nextFrame: prevFrame };
  }
  if (!prevFrame) {
    return { nextTransform: currentTransform, nextFrame };
  }

  const rawScaleFactor = nextFrame.dist / Math.max(12, prevFrame.dist);
  const scaleFactor = Math.abs(rawScaleFactor - 1) > 0.004 ? rawScaleFactor : 1;

  let dAngleDeg = ((nextFrame.angle - prevFrame.angle) * 180) / Math.PI;
  if (dAngleDeg > 180) dAngleDeg -= 360;
  if (dAngleDeg < -180) dAngleDeg += 360;
  const effectiveTwistDeg = Math.abs(dAngleDeg) > 0.25 ? dAngleDeg : 0;

  const dMidX = nextFrame.midX - prevFrame.midX;
  const dMidY = nextFrame.midY - prevFrame.midY;

  // Build camera-relative horizontal basis for intuitive 2-finger ground & depth placement
  const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuaternion);
  camForward.y = 0;
  if (camForward.lengthSq() < 1e-4) {
    camForward.set(0, 0, -1);
  } else {
    camForward.normalize();
  }
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraQuaternion);
  camRight.y = 0;
  if (camRight.lengthSq() < 1e-4) {
    camRight.set(1, 0, 0);
  } else {
    camRight.normalize();
  }

  const camPos = new THREE.Vector3(
    Number(cameraPosition?.x || 0),
    Number(cameraPosition?.y || 0),
    Number(cameraPosition?.z || 0)
  );
  const worldPos = new THREE.Vector3(
    Number(pivot?.x || 0) + Number(currentTransform?.offsetX || 0),
    Number(pivot?.y || 0) + Number(currentTransform?.offsetY || 0),
    Number(pivot?.z || 0) + Number(currentTransform?.offsetZ || 0)
  );
  const dist = Math.max(0.8, Math.min(6, camPos.distanceTo(worldPos)));
  const panScale = dist * 0.0028;

  // Dragging two fingers UP (dMidY < 0) pushes model further into scene (+camForward);
  // dragging DOWN (dMidY > 0) pulls model closer (-camForward); dragging LEFT/RIGHT shifts laterally!
  const lateralMove = Math.abs(dMidX) > 0.6 ? dMidX * panScale : 0;
  const depthMove = Math.abs(dMidY) > 0.6 ? -dMidY * panScale * 1.15 : 0;

  const nextScale = Math.max(
    minScale,
    Math.min(maxScale, Number((Number(currentTransform.scale || 1) * scaleFactor).toFixed(3)))
  );
  const nextRotY = wrapDeg180(Number(currentTransform.rotYDeg || 0) - effectiveTwistDeg * 1.15);

  const nextTransform = {
    ...currentTransform,
    scale: nextScale,
    rotYDeg: nextRotY,
    offsetX: Number(
      (
        Number(currentTransform.offsetX || 0) +
        camRight.x * lateralMove +
        camForward.x * depthMove
      ).toFixed(4)
    ),
    offsetY: Number(Number(currentTransform.offsetY || 0).toFixed(4)),
    offsetZ: Number(
      (
        Number(currentTransform.offsetZ || 0) +
        camRight.z * lateralMove +
        camForward.z * depthMove
      ).toFixed(4)
    )
  };

  return { nextTransform, nextFrame };
}
