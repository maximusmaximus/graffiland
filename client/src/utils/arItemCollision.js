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
