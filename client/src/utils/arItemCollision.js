import * as THREE from 'three';
import { VOXEL_STEP } from '../../../shared/constants.mjs';

const _tmpMat4 = new THREE.Matrix4();
const _tmpWorldMat4 = new THREE.Matrix4();
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();
const _candMin = new THREE.Vector3();
const _candMax = new THREE.Vector3();
const _candBox = new THREE.Box3();
const _rayOrigin = new THREE.Vector3();
const _rayTarget = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();

function isArtworkColliderMesh(obj) {
  if (!obj || !obj.isMesh || obj.visible === false) return false;
  if (
    obj.userData?.isHitProxy ||
    obj.userData?.clickableBase ||
    obj.userData?.isArLandHit ||
    obj.userData?.isParcelPerimeter
  ) {
    return false;
  }
  const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
  if (mats.length > 0 && mats.every((m) => m?.isShadowMaterial || m?.visible === false)) {
    return false;
  }
  return true;
}

/**
 * Collects exact 3D collision volumes & raycastable artwork meshes from all placed
 * sculptures currently rendered in `nearbyGroup` (ignoring land perimeter glass walls,
 * oversized tap hit proxies, shadow catchers, and any sculpture currently being edited).
 * Works identically whether placed items are solid or faded out during drawing!
 *
 * @param {THREE.Object3D | null | undefined} nearbyGroup
 * @param {{ excludeSculptureId?: string, voxelStep?: number }} [options]
 */
export function collectPlacedItemColliders(
  nearbyGroup,
  { excludeSculptureId = '', voxelStep = VOXEL_STEP } = {}
) {
  if (!nearbyGroup || !Array.isArray(nearbyGroup.children) || nearbyGroup.children.length === 0) {
    return [];
  }

  const excludeId = String(excludeSculptureId || '').trim();
  nearbyGroup.updateMatrixWorld(true);
  const colliders = [];

  for (const sub of nearbyGroup.children) {
    if (!sub || sub.visible === false) continue;
    const ud = sub.userData || {};
    if (ud.isParcelPerimeter || !ud.sculptureId) continue;
    const scId = String(ud.sculptureId);
    if (excludeId && scId === excludeId) continue;

    const broadBox = new THREE.Box3();
    const meshes = [];
    const voxelCells = [];
    const subBoxes = [];

    sub.traverse((obj) => {
      if (!isArtworkColliderMesh(obj)) return;
      meshes.push(obj);

      if (obj.isInstancedMesh && obj.count > 0) {
        const baseHalf = voxelStep * 0.96 * 0.5;
        for (let i = 0; i < obj.count; i += 1) {
          obj.getMatrixAt(i, _tmpMat4);
          _tmpWorldMat4.multiplyMatrices(obj.matrixWorld, _tmpMat4);
          _tmpWorldMat4.decompose(_tmpPos, _tmpQuat, _tmpScale);
          const maxAxis = Math.max(
            Math.abs(_tmpScale.x),
            Math.abs(_tmpScale.y),
            Math.abs(_tmpScale.z)
          );
          const half = Math.max(0.012, baseHalf * maxAxis);
          voxelCells.push({
            x: _tmpPos.x,
            y: _tmpPos.y,
            z: _tmpPos.z,
            half
          });
          _candMin.set(_tmpPos.x - half, _tmpPos.y - half, _tmpPos.z - half);
          _candMax.set(_tmpPos.x + half, _tmpPos.y + half, _tmpPos.z + half);
          broadBox.expandByPoint(_candMin);
          broadBox.expandByPoint(_candMax);
        }
      } else {
        const meshBox = new THREE.Box3().setFromObject(obj);
        if (!meshBox.isEmpty()) {
          subBoxes.push(meshBox);
          broadBox.union(meshBox);
        }
      }
    });

    if (meshes.length === 0 || broadBox.isEmpty()) continue;

    colliders.push({
      sculptureId: scId,
      parcelId: String(ud.parcelId || ud.sculpture?.parcelId || ''),
      title: String(ud.sculpture?.title || 'existing art'),
      broadBox,
      meshes,
      voxelCells,
      subBoxes
    });
  }

  return colliders;
}

/**
 * Tests whether placing a candidate voxel at world coordinates `point` either:
 * 1) Overlaps the 3D volume of any existing item placed on the land, OR
 * 2) Lies behind an existing placed item along the camera-to-target aim ray
 *    (preventing the user from drawing or painting through another item!).
 *
 * @param {{
 *   point: { x: number, y: number, z: number } | null,
 *   voxelScale?: number,
 *   voxelStep?: number,
 *   rayOrigin?: { x: number, y: number, z: number } | null,
 *   colliders?: any[]
 * }} params
 */
export function testVoxelAgainstPlacedItems({
  point,
  voxelScale = 1,
  voxelStep = VOXEL_STEP,
  rayOrigin = null,
  colliders = []
}) {
  if (!point || !Array.isArray(colliders) || colliders.length === 0) {
    return { blocked: false };
  }
  const px = Number(point.x);
  const py = Number(point.y);
  const pz = Number(point.z);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
    return { blocked: false };
  }

  // Slight 4% contact margin lets users paint cleanly adjacent to an item without entering it
  const half = Math.max(0.01, voxelStep * Math.max(0.25, Number(voxelScale) || 1) * 0.48);
  _candMin.set(px - half, py - half, pz - half);
  _candMax.set(px + half, py + half, pz + half);
  _candBox.set(_candMin, _candMax);

  // 1) Direct 3D volume overlap check (exact per-voxel cells or 3D model sub-mesh boxes)
  for (const col of colliders) {
    if (!col?.broadBox || !_candBox.intersectsBox(col.broadBox)) continue;

    if (col.voxelCells.length > 0) {
      for (let i = 0; i < col.voxelCells.length; i += 1) {
        const c = col.voxelCells[i];
        const sumHalf = half + c.half;
        if (
          Math.abs(px - c.x) < sumHalf &&
          Math.abs(py - c.y) < sumHalf &&
          Math.abs(pz - c.z) < sumHalf
        ) {
          return {
            blocked: true,
            reason: 'overlap',
            sculptureId: col.sculptureId,
            title: col.title
          };
        }
      }
    }

    for (let i = 0; i < col.subBoxes.length; i += 1) {
      if (_candBox.intersectsBox(col.subBoxes[i])) {
        return {
          blocked: true,
          reason: 'overlap',
          sculptureId: col.sculptureId,
          title: col.title
        };
      }
    }
  }

  // 2) Line-of-sight occlusion check: cannot aim/spray THROUGH an existing placed item
  if (
    rayOrigin &&
    Number.isFinite(Number(rayOrigin.x)) &&
    Number.isFinite(Number(rayOrigin.y)) &&
    Number.isFinite(Number(rayOrigin.z))
  ) {
    _rayOrigin.set(Number(rayOrigin.x), Number(rayOrigin.y), Number(rayOrigin.z));
    _rayTarget.set(px, py, pz);
    const dist = _rayOrigin.distanceTo(_rayTarget);
    const maxRayDist = dist - half * 0.85;
    if (maxRayDist > 0.05) {
      _rayDir.subVectors(_rayTarget, _rayOrigin).divideScalar(dist);
      _raycaster.set(_rayOrigin, _rayDir);
      _raycaster.near = 0.04;
      _raycaster.far = maxRayDist;

      let closestHit = null;
      for (const col of colliders) {
        if (!col?.broadBox || !_raycaster.ray.intersectsBox(col.broadBox)) continue;
        const hits = _raycaster.intersectObjects(col.meshes, false);
        if (hits.length > 0 && hits[0].distance < maxRayDist) {
          if (!closestHit || hits[0].distance < closestHit.hitDistance) {
            closestHit = {
              blocked: true,
              reason: 'occluded',
              sculptureId: col.sculptureId,
              title: col.title,
              hitDistance: hits[0].distance
            };
          }
        }
      }
      if (closestHit) return closestHit;
    }
  }

  return { blocked: false };
}

/**
 * Tests whether a 3D brush stroke segment between two consecutive points passes through
 * any placed item on the land (preventing fast sweeps from tunneling across an obstacle).
 */
export function doesSegmentPiercePlacedItems({ fromPoint, toPoint, colliders = [] }) {
  if (!fromPoint || !toPoint || !Array.isArray(colliders) || colliders.length === 0) {
    return { blocked: false };
  }
  _rayOrigin.set(Number(fromPoint.x), Number(fromPoint.y), Number(fromPoint.z));
  _rayTarget.set(Number(toPoint.x), Number(toPoint.y), Number(toPoint.z));
  const segDist = _rayOrigin.distanceTo(_rayTarget);
  if (!Number.isFinite(segDist) || segDist <= 1e-4) {
    return { blocked: false };
  }

  _rayDir.subVectors(_rayTarget, _rayOrigin).divideScalar(segDist);
  _raycaster.set(_rayOrigin, _rayDir);
  _raycaster.near = 0.001;
  _raycaster.far = segDist;

  for (const col of colliders) {
    if (!col?.broadBox || !_raycaster.ray.intersectsBox(col.broadBox)) continue;
    const hits = _raycaster.intersectObjects(col.meshes, false);
    if (hits.length > 0 && hits[0].distance <= segDist) {
      return {
        blocked: true,
        reason: 'pierce',
        sculptureId: col.sculptureId,
        title: col.title,
        hitDistance: hits[0].distance
      };
    }
  }

  return { blocked: false };
}

/**
 * Filters a sequential 3D brush/stack stroke path against placed items on the land.
 * Stops cleanly right before the first blocked/piercing step so continuous spray strokes
 * NEVER tunnel across or paint inside existing artworks.
 */
export function filterStrokeAgainstPlacedItems({
  prevPoint = null,
  pathPoints = [],
  voxelStep = VOXEL_STEP,
  rayOrigin = null,
  colliders = []
}) {
  if (!Array.isArray(pathPoints) || pathPoints.length === 0) {
    return { allowed: [], blocked: false, blockedBy: null, lastAllowedPoint: prevPoint };
  }
  if (!Array.isArray(colliders) || colliders.length === 0) {
    const last = pathPoints[pathPoints.length - 1];
    return {
      allowed: pathPoints,
      blocked: false,
      blockedBy: null,
      lastAllowedPoint: { x: last.x, y: last.y, z: last.z }
    };
  }

  const allowed = [];
  let cursor = prevPoint;
  for (const pt of pathPoints) {
    if (cursor) {
      const pierce = doesSegmentPiercePlacedItems({
        fromPoint: cursor,
        toPoint: pt,
        colliders
      });
      if (pierce.blocked) {
        return {
          allowed,
          blocked: true,
          blockedBy: pierce,
          lastAllowedPoint: allowed.length > 0 ? allowed[allowed.length - 1] : null
        };
      }
    }

    const hit = testVoxelAgainstPlacedItems({
      point: pt,
      voxelScale: pt.scale ?? 1,
      voxelStep,
      rayOrigin,
      colliders
    });
    if (hit.blocked) {
      return {
        allowed,
        blocked: true,
        blockedBy: hit,
        lastAllowedPoint: allowed.length > 0 ? allowed[allowed.length - 1] : null
      };
    }

    allowed.push(pt);
    cursor = pt;
  }

  const last = allowed[allowed.length - 1];
  return {
    allowed,
    blocked: false,
    blockedBy: null,
    lastAllowedPoint: last ? { x: last.x, y: last.y, z: last.z } : prevPoint
  };
}

/**
 * Verifies that a transformed/moved voxel set (Lock & Scale) does not overlap
 * any existing items placed on the land.
 */
export function testTransformedVoxelsAgainstPlacedItems({
  voxels = [],
  voxelStep = VOXEL_STEP,
  colliders = []
}) {
  if (!Array.isArray(voxels) || voxels.length === 0 || !Array.isArray(colliders) || colliders.length === 0) {
    return { blocked: false, blockedBy: null };
  }
  for (const v of voxels) {
    const res = testVoxelAgainstPlacedItems({
      point: v,
      voxelScale: v.scale ?? 1,
      voxelStep,
      rayOrigin: null,
      colliders
    });
    if (res.blocked) {
      return { blocked: true, blockedBy: res };
    }
  }
  return { blocked: false, blockedBy: null };
}

/**
 * Computes positive 3D penetration depth (in meters) between two Box3 volumes,
 * returning 0 when they do not overlap.
 *
 * @param {THREE.Box3 | null | undefined} boxA
 * @param {THREE.Box3 | null | undefined} boxB
 * @returns {number}
 */
export function computeBoxPenetrationDepth(boxA, boxB) {
  if (!boxA || !boxB || boxA.isEmpty() || boxB.isEmpty()) return 0;
  const ox = Math.min(boxA.max.x, boxB.max.x) - Math.max(boxA.min.x, boxB.min.x);
  if (ox <= 0) return 0;
  const oy = Math.min(boxA.max.y, boxB.max.y) - Math.max(boxA.min.y, boxB.min.y);
  if (oy <= 0) return 0;
  const oz = Math.min(boxA.max.z, boxB.max.z) - Math.max(boxA.min.z, boxB.min.z);
  if (oz <= 0) return 0;
  return Math.min(ox, oy, oz);
}

/**
 * Tests whether a candidate 3D sculpture world bounding box overlaps any existing
 * placed sculpture on the land (voxel sculptures or custom 3D models), keeping a small
 * safety clearance margin so sculptures can never be placed inside other sculptures.
 *
 * @param {{
 *   box: THREE.Box3 | null | undefined,
 *   colliders?: any[],
 *   marginMeters?: number
 * }} params
 */
export function testBoundingBoxAgainstPlacedItems({
  box,
  colliders = [],
  marginMeters = 0.04
}) {
  if (!box || box.isEmpty() || !Array.isArray(colliders) || colliders.length === 0) {
    return { blocked: false, blockedBy: null, penetrationDepth: 0 };
  }

  const margin = Math.max(0, Number(marginMeters) || 0);
  const testBox = box.clone().expandByScalar(margin);
  let worstHit = null;
  let maxDepth = 0;

  for (const col of colliders) {
    if (!col?.broadBox || !testBox.intersectsBox(col.broadBox)) continue;

    if (col.voxelCells && col.voxelCells.length > 0) {
      for (let i = 0; i < col.voxelCells.length; i += 1) {
        const c = col.voxelCells[i];
        _candMin.set(c.x - c.half, c.y - c.half, c.z - c.half);
        _candMax.set(c.x + c.half, c.y + c.half, c.z + c.half);
        _candBox.set(_candMin, _candMax);
        const depth = computeBoxPenetrationDepth(testBox, _candBox);
        if (depth > 0 && depth > maxDepth) {
          maxDepth = depth;
          worstHit = {
            reason: 'overlap',
            sculptureId: col.sculptureId,
            title: col.title,
            colliderBox: col.broadBox.clone()
          };
        }
      }
      continue;
    }

    const subBoxes = col.subBoxes && col.subBoxes.length > 0 ? col.subBoxes : [col.broadBox];
    for (let i = 0; i < subBoxes.length; i += 1) {
      const depth = computeBoxPenetrationDepth(testBox, subBoxes[i]);
      if (depth > 0 && depth > maxDepth) {
        maxDepth = depth;
        worstHit = {
          reason: 'overlap',
          sculptureId: col.sculptureId,
          title: col.title,
          colliderBox: subBoxes[i].clone()
        };
      }
    }
  }

  if (worstHit) {
    return {
      blocked: true,
      blockedBy: worstHit,
      penetrationDepth: maxDepth
    };
  }
  return { blocked: false, blockedBy: null, penetrationDepth: 0 };
}

function buildWorldBoxFromLocalBoxAndMatrix(localBox, matrix) {
  if (!localBox || localBox.isEmpty()) return new THREE.Box3();
  const min = localBox.min;
  const max = localBox.max;
  const corners = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z)
  ];
  const worldBox = new THREE.Box3();
  for (const pt of corners) {
    pt.applyMatrix4(matrix);
    worldBox.expandByPoint(pt);
  }
  return worldBox;
}

/**
 * Computes the candidate world-space Box3 for the active draft (staged 3D catalog model
 * and/or drawn voxels) under a candidate `artTransform` around `pivot`, without mutating
 * the live Three.js scene graph.
 *
 * @param {{
 *   draftGroup?: THREE.Object3D | null,
 *   placedCatalogItem?: any | null,
 *   voxels?: any[],
 *   pivot?: { x: number, y: number, z: number } | null,
 *   artTransform?: {
 *     scale?: number,
 *     rotXDeg?: number,
 *     rotYDeg?: number,
 *     rotZDeg?: number,
 *     offsetX?: number,
 *     offsetY?: number,
 *     offsetZ?: number
 *   } | null,
 *   voxelStep?: number
 * }} params
 */
export function computeCandidateDraftWorldBox({
  draftGroup = null,
  placedCatalogItem = null,
  voxels = [],
  pivot = { x: 0, y: 0, z: 0 },
  artTransform = null,
  voxelStep = VOXEL_STEP
}) {
  const localBox = new THREE.Box3();

  // 1) Measure actual Three.js local bounds of draftGroup children (in draftGroup local space)
  if (draftGroup && Array.isArray(draftGroup.children) && draftGroup.children.length > 0) {
    const savedPos = draftGroup.position.clone();
    const savedQuat = draftGroup.quaternion.clone();
    const savedScale = draftGroup.scale.clone();
    draftGroup.position.set(0, 0, 0);
    draftGroup.quaternion.identity();
    draftGroup.scale.set(1, 1, 1);
    draftGroup.updateMatrixWorld(true);
    const childBox = new THREE.Box3();
    for (const child of draftGroup.children) {
      if (!child || child.visible === false) continue;
      childBox.setFromObject(child);
      if (!childBox.isEmpty()) localBox.union(childBox);
    }
    draftGroup.position.copy(savedPos);
    draftGroup.quaternion.copy(savedQuat);
    draftGroup.scale.copy(savedScale);
    draftGroup.updateMatrixWorld(true);
  }

  // 2) Deterministic fallback from placedCatalogItem metadata (headless / before mesh attach)
  if (localBox.isEmpty() && placedCatalogItem && placedCatalogItem.pos) {
    const sc = Math.max(0.05, Number(placedCatalogItem.scale || 1));
    const bw = Math.max(0.1, Number(placedCatalogItem.baseSize?.width || 0.75)) * sc;
    const bh = Math.max(0.1, Number(placedCatalogItem.baseSize?.height || 0.75)) * sc;
    const bd = Math.max(0.1, Number(placedCatalogItem.baseSize?.depth || 0.75)) * sc;
    const itemLocal = new THREE.Box3(
      new THREE.Vector3(-bw * 0.5, 0, -bd * 0.5),
      new THREE.Vector3(bw * 0.5, bh, bd * 0.5)
    );
    const itemQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(Number(placedCatalogItem.rotXDeg || 0)),
        THREE.MathUtils.degToRad(Number(placedCatalogItem.rotYDeg || 0)),
        THREE.MathUtils.degToRad(Number(placedCatalogItem.rotZDeg || 0)),
        'YXZ'
      )
    );
    const itemMat = new THREE.Matrix4().compose(
      new THREE.Vector3(
        Number(placedCatalogItem.pos.x || 0),
        Number(placedCatalogItem.pos.y || 0),
        Number(placedCatalogItem.pos.z || 0)
      ),
      itemQuat,
      new THREE.Vector3(1, 1, 1)
    );
    localBox.union(buildWorldBoxFromLocalBoxAndMatrix(itemLocal, itemMat));
  }

  // 3) Deterministic fallback for voxels when draftGroup isn't mounted
  if (localBox.isEmpty() && Array.isArray(voxels) && voxels.length > 0) {
    for (const v of voxels) {
      const half = Math.max(0.01, voxelStep * Math.max(0.25, Number(v.scale ?? 1)) * 0.48);
      _candMin.set(v.x - half, v.y - half, v.z - half);
      _candMax.set(v.x + half, v.y + half, v.z + half);
      localBox.expandByPoint(_candMin);
      localBox.expandByPoint(_candMax);
    }
  }

  if (localBox.isEmpty()) return localBox;
  if (!artTransform) return localBox;

  const s = Math.max(0.05, Number(artTransform.scale ?? 1));
  const radX = THREE.MathUtils.degToRad(Number(artTransform.rotXDeg || 0));
  const radY = THREE.MathUtils.degToRad(Number(artTransform.rotYDeg || 0));
  const radZ = THREE.MathUtils.degToRad(Number(artTransform.rotZDeg || 0));
  const pv = new THREE.Vector3(
    Number(pivot?.x || 0),
    Number(pivot?.y || 0),
    Number(pivot?.z || 0)
  );
  const offset = new THREE.Vector3(
    Number(artTransform.offsetX || 0),
    Number(artTransform.offsetY || 0),
    Number(artTransform.offsetZ || 0)
  );
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(radX, radY, radZ, 'YXZ'));
  const transformedPivot = pv.clone().multiplyScalar(s).applyQuaternion(quat);
  const groupPos = pv.clone().add(offset).sub(transformedPivot);
  const mat = new THREE.Matrix4().compose(groupPos, quat, new THREE.Vector3(s, s, s));
  return buildWorldBoxFromLocalBoxAndMatrix(localBox, mat);
}

/**
 * Finds the nearest collision-free 3D world position for spawning a searched 3D model
 * so a newly placed sculpture never spawns inside another sculpture in the scene.
 *
 * @param {{
 *   initialPos: { x: number, y: number, z: number },
 *   baseSize?: { width?: number, height?: number, depth?: number },
 *   scale?: number,
 *   colliders?: any[],
 *   cameraPosition?: { x: number, y: number, z: number } | null,
 *   marginMeters?: number,
 *   maxSearchRadius?: number
 * }} params
 */
export function findNonCollidingPlacementPosition({
  initialPos,
  baseSize = { width: 0.75, height: 0.75, depth: 0.75 },
  scale = 1,
  colliders = [],
  cameraPosition = null,
  marginMeters = 0.06,
  maxSearchRadius = 2.8
}) {
  const safeInit = {
    x: Number(initialPos?.x || 0),
    y: Number(initialPos?.y || 0),
    z: Number(initialPos?.z || -1.8)
  };
  if (!Array.isArray(colliders) || colliders.length === 0) {
    return { pos: safeInit, shifted: false, avoidedTitle: '', blocked: false };
  }

  const sc = Math.max(0.05, Number(scale) || 1);
  const halfW = Math.max(0.08, Number(baseSize?.width || 0.75) * sc * 0.5);
  const height = Math.max(0.12, Number(baseSize?.height || 0.75) * sc);
  const halfD = Math.max(0.08, Number(baseSize?.depth || 0.75) * sc * 0.5);

  const testAt = (pt) => {
    const box = new THREE.Box3(
      new THREE.Vector3(pt.x - halfW, pt.y, pt.z - halfD),
      new THREE.Vector3(pt.x + halfW, pt.y + height, pt.z + halfD)
    );
    return testBoundingBoxAgainstPlacedItems({ box, colliders, marginMeters });
  };

  const initialHit = testAt(safeInit);
  if (!initialHit.blocked) {
    return { pos: safeInit, shifted: false, avoidedTitle: '', blocked: false };
  }

  // Build camera-oriented horizontal basis (right, towardCamera) so shifts stay right in view
  const toCam = new THREE.Vector3(
    Number(cameraPosition?.x ?? 0) - safeInit.x,
    0,
    Number(cameraPosition?.z ?? 0) - safeInit.z
  );
  if (toCam.lengthSq() < 1e-4) toCam.set(0, 0, 1);
  toCam.normalize();
  const right = new THREE.Vector3(-toCam.z, 0, toCam.x).normalize();

  const step = Math.max(0.28, Math.min(0.55, Math.max(halfW, halfD) * 0.9));
  const directions = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0.707, 0, 0.707],
    [-0.707, 0, 0.707],
    [0, 0, -1],
    [0.707, 0, -0.707],
    [-0.707, 0, -0.707],
    [0, 1, 0]
  ];

  for (let r = step; r <= maxSearchRadius + 1e-4; r += step) {
    for (const [dr, dy, dtc] of directions) {
      const cand = {
        x: Number((safeInit.x + right.x * dr * r + toCam.x * dtc * r).toFixed(3)),
        y: Number((safeInit.y + dy * r).toFixed(3)),
        z: Number((safeInit.z + right.z * dr * r + toCam.z * dtc * r).toFixed(3))
      };
      if (!testAt(cand).blocked) {
        return {
          pos: cand,
          shifted: true,
          avoidedTitle: initialHit.blockedBy?.title || 'existing art',
          blocked: false
        };
      }
    }
  }

  return {
    pos: safeInit,
    shifted: false,
    avoidedTitle: initialHit.blockedBy?.title || 'existing art',
    blocked: true
  };
}
