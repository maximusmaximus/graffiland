import * as THREE from 'three';

const UNIT_Y = new THREE.Vector3(0, 1, 0);
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

const BAR_COLOR_BOTTOM = 0x00f5d4;
const BAR_COLOR_TOP = 0x38f8dc;
const BAR_COLOR_VERTICAL = 0xffd166;
const BAR_COLOR_ACTIVE = 0xffd166;
const BAR_COLOR_COLLIDING = 0xff3e7f;
const ORB_CORE_COLOR = 0xeafffc;

function positionCylinderBetween(mesh, a, b, radius) {
  _dir.subVectors(b, a);
  const len = Math.max(0.001, _dir.length());
  _mid.addVectors(a, b).multiplyScalar(0.5);
  mesh.position.copy(_mid);
  _dir.divideScalar(len);
  if (Math.abs(_dir.dot(UNIT_Y)) > 0.9999) {
    _quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), _dir.y < 0 ? Math.PI : 0);
  } else {
    _quat.setFromUnitVectors(UNIT_Y, _dir);
  }
  mesh.quaternion.copy(_quat);
  mesh.scale.set(radius, len, radius);
}

/**
 * Builds an interactive 3D wireframe bar & orb manipulator gizmo around a Three.js
 * object in Lock & Scale mode, matching SPRAY.LAND's 3D Land wireframe handles:
 * - 4 bottom cyan side bars (`move-xz`: drag to move horizontally)
 * - 4 vertical gold rotation bars (`rotate-y`: drag to rotate around Y)
 * - 4 bright cyan top rim bars (`height`: drag up/down to lift/lower)
 * - 8 glowing corner orbs (`scale`: drag to scale uniformly)
 * - 1 pronounced center top elevator stem & orb (`height`: drag up/down to lift/lower)
 *
 * Each handle includes an invisible touch-friendly hit collider so grabbing bars
 * on mobile touchscreens is accurate and effortless.
 */
export function createObjectTransformGizmo() {
  const group = new THREE.Group();
  group.name = 'object-transform-gizmo';
  group.visible = false;

  const box = new THREE.Box3();
  const unitCylGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
  const unitSphereGeo = new THREE.SphereGeometry(1, 14, 12);

  const hitMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false
  });

  const handleRecords = [];
  const interactiveMeshes = [];
  const materials = [hitMat];

  const makeBar = (key, action, baseColor) => {
    const mat = new THREE.MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: 0.94,
      depthTest: false
    });
    materials.push(mat);
    const vis = new THREE.Mesh(unitCylGeo, mat);
    vis.renderOrder = 22;
    vis.userData = { gizmoHandle: key, gizmoAction: action, isGizmoVisual: true };
    const hit = new THREE.Mesh(unitCylGeo, hitMat);
    hit.userData = { gizmoHandle: key, gizmoAction: action, isGizmoHit: true };
    group.add(vis);
    group.add(hit);
    interactiveMeshes.push(hit, vis);
    const rec = { key, action, baseColor, vis, hit, mat };
    handleRecords.push(rec);
    return rec;
  };

  const makeOrb = (key, action, baseColor, isCore = true) => {
    const outerMat = new THREE.MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: 0.92,
      depthTest: false
    });
    materials.push(outerMat);
    const vis = new THREE.Mesh(unitSphereGeo, outerMat);
    vis.renderOrder = 24;
    vis.userData = { gizmoHandle: key, gizmoAction: action, isGizmoVisual: true };
    let core = null;
    if (isCore) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: ORB_CORE_COLOR,
        transparent: true,
        opacity: 0.96,
        depthTest: false
      });
      materials.push(coreMat);
      core = new THREE.Mesh(unitSphereGeo, coreMat);
      core.scale.setScalar(0.55);
      core.renderOrder = 25;
      vis.add(core);
    }
    const hit = new THREE.Mesh(unitSphereGeo, hitMat);
    hit.userData = { gizmoHandle: key, gizmoAction: action, isGizmoHit: true };
    group.add(vis);
    group.add(hit);
    interactiveMeshes.push(hit, vis);
    const rec = { key, action, baseColor, vis, hit, mat: outerMat, core };
    handleRecords.push(rec);
    return rec;
  };

  const bottomBars = [0, 1, 2, 3].map((i) => makeBar(`bottom-bar-${i}`, 'move-xz', BAR_COLOR_BOTTOM));
  const topBars = [0, 1, 2, 3].map((i) => makeBar(`top-bar-${i}`, 'height', BAR_COLOR_TOP));
  const verticalBars = [0, 1, 2, 3].map((i) => makeBar(`vbar-${i}`, 'rotate-y', BAR_COLOR_VERTICAL));
  const cornerOrbs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    makeOrb(`corner-${i}`, 'scale', BAR_COLOR_BOTTOM, true)
  );
  const heightStem = makeBar('height-stem', 'height', BAR_COLOR_TOP);
  const heightOrb = makeOrb('height-orb', 'height', BAR_COLOR_TOP, true);

  // Subtle vertical center axis line through prism
  const axisGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0)
  ]);
  const axisMat = new THREE.LineBasicMaterial({
    color: BAR_COLOR_BOTTOM,
    transparent: true,
    opacity: 0.45,
    depthTest: false
  });
  materials.push(axisMat);
  const centerAxisLine = new THREE.Line(axisGeo, axisMat);
  centerAxisLine.renderOrder = 20;
  group.add(centerAxisLine);

  const updateFromBox = (nextBox, { activeHandle = '', colliding = false } = {}) => {
    if (!nextBox || nextBox.isEmpty()) {
      group.visible = false;
      return;
    }
    box.copy(nextBox);
    // Keep a small visual clearance pad so bars hug cleanly around the model
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxSpan = Math.max(0.25, size.x, size.y, size.z);
    const pad = Math.min(0.08, Math.max(0.015, maxSpan * 0.04));

    const minX = box.min.x - pad;
    const maxX = box.max.x + pad;
    const minY = box.min.y - pad;
    const maxY = box.max.y + pad;
    const minZ = box.min.z - pad;
    const maxZ = box.max.z + pad;

    const bPts = [
      new THREE.Vector3(minX, minY, minZ),
      new THREE.Vector3(maxX, minY, minZ),
      new THREE.Vector3(maxX, minY, maxZ),
      new THREE.Vector3(minX, minY, maxZ)
    ];
    const tPts = [
      new THREE.Vector3(minX, maxY, minZ),
      new THREE.Vector3(maxX, maxY, minZ),
      new THREE.Vector3(maxX, maxY, maxZ),
      new THREE.Vector3(minX, maxY, maxZ)
    ];

    const barR = Math.max(0.007, Math.min(0.022, maxSpan * 0.013));
    const hitBarR = Math.max(0.045, barR * 4.5);
    const orbR = Math.max(0.02, Math.min(0.055, maxSpan * 0.036));
    const hitOrbR = Math.max(0.075, orbR * 2.8);

    for (let i = 0; i < 4; i += 1) {
      const next = (i + 1) % 4;
      positionCylinderBetween(bottomBars[i].vis, bPts[i], bPts[next], barR);
      positionCylinderBetween(bottomBars[i].hit, bPts[i], bPts[next], hitBarR);

      positionCylinderBetween(topBars[i].vis, tPts[i], tPts[next], barR * 1.15);
      positionCylinderBetween(topBars[i].hit, tPts[i], tPts[next], hitBarR);

      positionCylinderBetween(verticalBars[i].vis, bPts[i], tPts[i], barR * 1.12);
      positionCylinderBetween(verticalBars[i].hit, bPts[i], tPts[i], hitBarR);
    }

    const allCorners = [...bPts, ...tPts];
    for (let i = 0; i < 8; i += 1) {
      cornerOrbs[i].vis.position.copy(allCorners[i]);
      cornerOrbs[i].vis.scale.setScalar(orbR);
      cornerOrbs[i].hit.position.copy(allCorners[i]);
      cornerOrbs[i].hit.scale.setScalar(hitOrbR);
    }

    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const stemLift = Math.max(0.14, Math.min(0.45, maxSpan * 0.28));
    const topCenter = new THREE.Vector3(cx, maxY, cz);
    const liftCenter = new THREE.Vector3(cx, maxY + stemLift, cz);

    positionCylinderBetween(heightStem.vis, topCenter, liftCenter, barR * 1.15);
    positionCylinderBetween(heightStem.hit, topCenter, liftCenter, hitBarR);
    heightOrb.vis.position.copy(liftCenter);
    heightOrb.vis.scale.setScalar(orbR * 1.35);
    heightOrb.hit.position.copy(liftCenter);
    heightOrb.hit.scale.setScalar(hitOrbR * 1.2);

    const posAttr = axisGeo.attributes.position;
    posAttr.setXYZ(0, cx, minY, cz);
    posAttr.setXYZ(1, cx, maxY, cz);
    posAttr.needsUpdate = true;
    axisMat.color.setHex(
      colliding ? BAR_COLOR_COLLIDING : activeHandle.startsWith('height') ? BAR_COLOR_ACTIVE : BAR_COLOR_BOTTOM
    );

    for (const rec of handleRecords) {
      const isAct = Boolean(
        activeHandle &&
          (rec.key === activeHandle ||
            (activeHandle === 'height-orb' && rec.key === 'height-stem') ||
            (activeHandle === 'height-stem' && rec.key === 'height-orb'))
      );
      rec.mat.color.setHex(colliding ? BAR_COLOR_COLLIDING : isAct ? BAR_COLOR_ACTIVE : rec.baseColor);
      if (isAct && rec.action === 'scale') {
        rec.vis.scale.setScalar(orbR * 1.32);
      } else if (isAct && rec.key === 'height-orb') {
        rec.vis.scale.setScalar(orbR * 1.6);
      }
    }

    group.visible = true;
    group.updateMatrixWorld(true);
  };

  const dispose = () => {
    unitCylGeo.dispose();
    unitSphereGeo.dispose();
    axisGeo.dispose();
    for (const m of materials) m.dispose();
  };

  const api = {
    isObjectTransformGizmo: true,
    group,
    box,
    get visible() {
      return group.visible;
    },
    set visible(v) {
      group.visible = Boolean(v);
    },
    getInteractiveMeshes: () => interactiveMeshes,
    getHandleCount: () => ({
      bottomBars: bottomBars.length,
      topBars: topBars.length,
      verticalBars: verticalBars.length,
      cornerOrbs: cornerOrbs.length,
      heightHandle: 1
    }),
    updateFromBox,
    dispose
  };

  return api;
}

function wrapDeg180(deg) {
  let wrapped = ((((Number(deg) || 0) + 180) % 360) + 360) % 360 - 180;
  if (wrapped === -180 && deg > 0) wrapped = 180;
  return Math.round(wrapped * 10) / 10;
}

/**
 * Computes the next transform state when dragging one of the Land-style 3D gizmo
 * manipulator handles on an object in Lock & Scale mode.
 *
 * @param {{
 *   handleAction: 'scale' | 'rotate-y' | 'height' | 'move-xz',
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
 *   },
 *   minScale?: number,
 *   maxScale?: number
 * }} params
 */
export function computeGizmoHandleDragStep({
  handleAction,
  dx,
  dy,
  cameraQuaternion,
  cameraPosition,
  pivot,
  currentTransform,
  minScale = 0.25,
  maxScale = 2.5
}) {
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
  const moveScale = dist * 0.0028;

  if (handleAction === 'scale') {
    const factor = 1 + (dx - dy) * 0.0055;
    const nextScale = Math.max(
      minScale,
      Math.min(maxScale, Number((Number(currentTransform.scale || 1) * factor).toFixed(3)))
    );
    return { ...currentTransform, scale: nextScale };
  }

  if (handleAction === 'rotate-y') {
    const nextRotY = wrapDeg180(Number(currentTransform.rotYDeg || 0) + dx * 0.72);
    return { ...currentTransform, rotYDeg: nextRotY };
  }

  if (handleAction === 'height') {
    const nextY = Number((Number(currentTransform.offsetY || 0) - dy * moveScale).toFixed(4));
    return { ...currentTransform, offsetY: nextY };
  }

  if (handleAction === 'move-xz') {
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraQuaternion);
    camRight.y = 0;
    if (camRight.lengthSq() < 1e-4) camRight.set(1, 0, 0);
    else camRight.normalize();

    const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuaternion);
    camForward.y = 0;
    if (camForward.lengthSq() < 1e-4) camForward.set(0, 0, -1);
    else camForward.normalize();

    return {
      ...currentTransform,
      offsetX: Number(
        (
          Number(currentTransform.offsetX || 0) +
          (camRight.x * dx - camForward.x * dy) * moveScale
        ).toFixed(4)
      ),
      offsetZ: Number(
        (
          Number(currentTransform.offsetZ || 0) +
          (camRight.z * dx - camForward.z * dy) * moveScale
        ).toFixed(4)
      )
    };
  }

  return currentTransform;
}
