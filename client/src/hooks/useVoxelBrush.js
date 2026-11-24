import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { AREA_HALF_SPAN_METERS, AREA_LIMIT_BLOCKS } from '../../../shared/constants.mjs';
import {
  computeAdjacentCandidateSlots,
  findBestAdjacentVoxelSlot,
  getVoxelCellStep,
  normalizeBlockScale,
  snapToVoxelLattice
} from '../../../shared/voxelStroke.mjs';
import {
  createVoxelMaterial,
  GRAFFITI_PALETTE,
  snapCoord,
  VOXEL_STEP,
  voxelKey
} from '../components/VoxelEngine3D.js';
import { ForegroundOcclusionCompositor } from '../components/ForegroundOcclusion.js';

export const KEY_TOOLS = [
  { id: 'brush', emoji: '🖌️', label: 'Brush', hint: 'Hold & sweep phone like a spray can', quick: true },
  { id: 'pencil', emoji: '✏️', label: 'Pencil', hint: 'Tap to place, stack, or replace blocks', quick: true },
  { id: 'stack', emoji: '🧱', label: 'Stack', hint: 'Hold to stack onto block faces', quick: true },
  { id: 'erase', emoji: '🧽', label: 'Erase', hint: 'Tap or hold blocks to erase', quick: true },
  { id: 'undo', emoji: '↩️', label: 'Undo', hint: 'Tap to undo last block or restore clear', quick: true },
  { id: 'clear', emoji: '🗑️', label: 'Clear', hint: 'Tap to erase current canvas', quick: true },
  { id: 'transform', emoji: '✅', label: 'Lock & Scale', hint: 'Lock art to scale & transform', quick: false },
  { id: 'recenter', emoji: '🧭', label: 'Recenter', hint: 'Tap to recenter 3D gyroscope aim', quick: true },
  { id: 'preview', emoji: '👁️', label: 'Preview', hint: 'AR preview & E2EE chat', quick: true },
  { id: 'drafts', emoji: '💾', label: 'Drafts', hint: 'Save & load sculpture drafts', quick: true },
  { id: 'occlusion', emoji: '🪞', label: 'Occlusion', hint: 'Toggle foreground occlusion', quick: false },
  { id: 'pair', emoji: '🔗', label: 'Pair', hint: 'Pair desktop live 3D view', quick: false },
  { id: 'agent', emoji: '📋', label: 'Agent Code', hint: 'Copy code for AI agent build', quick: false },
  { id: 'publish', emoji: '🚀', label: 'Publish', hint: 'Review & mint on your phone', quick: true }
];

export const KEY_CAROUSEL_SLOT_PX = 54;

function computeVoxelCentroid(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const v of list) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
  }
  return {
    x: (minX + maxX) * 0.5,
    y: (minY + maxY) * 0.5,
    z: (minZ + maxZ) * 0.5
  };
}

function hasNonIdentityTransform(tr) {
  if (!tr) return false;
  return (
    Math.abs(tr.scale - 1) > 0.005 ||
    Math.abs(tr.rotYDeg) > 0.25 ||
    Math.abs(tr.offsetX) > 0.002 ||
    Math.abs(tr.offsetY) > 0.002 ||
    Math.abs(tr.offsetZ) > 0.002
  );
}

/**
 * Manages the 3D voxel canvas state: brush/stack/erase tools, incremental Three.js
 * draft mesh syncing, surface anchor locking, transform scaling/baking, bottom
 * swipe tool carousel, and canvas pointer gestures.
 */
export function useVoxelBrush({
  config,
  initialDraft,
  user,
  location,
  locationRef,
  cameraReady,
  sceneScan,
  polRef,
  rawOrientationRef,
  fallbackEulerRef,
  enterFullscreen,
  setSensorBanner,
  showTemporaryHint,
  canvasHostRef,
  cameraRef,
  draftGroupRef,
  transformBoxRef,
  surfaceMarkerRef,
  shadowPlaneRef,
  gridHelperRef,
  nearbyGroupRef,
  arTargetedIdRef,
  setArTargetedSculpture,
  arPinPreview,
  openCameraSelectedChat,
  onTapArLand = null,
  isInteractingWithLandRef = null,
  recenterAimRef = null,
  openDraftsSheetRef = null,
  openPairModalRef = null,
  openAgentHandoffRef,
  openPublishSheetRef,
  onFirstBrushUse = null
}) {
  const occlusionRef = useRef(new ForegroundOcclusionCompositor());

  const [mode, setMode] = useState('draw');
  const [tool, setTool] = useState('brush');
  const [blockSize, setBlockSizeState] = useState(() =>
    normalizeBlockScale(initialDraft.blockSize ?? 1)
  );
  const setBlockSize = useCallback((nextVal) => {
    setBlockSizeState((prev) =>
      normalizeBlockScale(typeof nextVal === 'function' ? nextVal(prev) : nextVal)
    );
  }, []);
  const [material, setMaterial] = useState(
    initialDraft.material === 'neon' || initialDraft.material === 'glass'
      ? initialDraft.material
      : 'matte'
  );
  const [color, setColor] = useState(
    typeof initialDraft.color === 'string' && initialDraft.color
      ? initialDraft.color
      : GRAFFITI_PALETTE[0]
  );
  const [reachMeters, setReachMeters] = useState(
    Number.isFinite(Number(initialDraft.reachMeters)) ? Number(initialDraft.reachMeters) : 1.8
  );
  const [voxels, setVoxels] = useState(() =>
    Array.isArray(initialDraft.voxels) ? initialDraft.voxels : []
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [occlusionEnabled, setOcclusionEnabled] = useState(false);
  const [painting, setPainting] = useState(false);
  const [surfaceAnchor, setSurfaceAnchor] = useState(() => initialDraft.surfaceAnchor || null);
  const [artTransform, setArtTransform] = useState({
    scale: 1,
    rotYDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0
  });
  const [transformPivot, setTransformPivot] = useState({ x: 0, y: 0, z: 0 });
  const [activeKeyTool, setActiveKeyTool] = useState('brush');
  const [swipeDragPx, setSwipeDragPx] = useState(0);
  const [isDraggingKey, setIsDraggingKey] = useState(false);
  const [hasClearedBackup, setHasClearedBackup] = useState(false);
  const [originStatus, setOriginStatus] = useState({
    originBlocked: false,
    originVisible: true,
    reason: ''
  });

  const draftMeshMapRef = useRef(new Map());
  const draftUnitGeoRef = useRef(null);
  const draftMatCacheRef = useRef(new Map());
  const surfaceAnchorRef = useRef(initialDraft.surfaceAnchor || null);
  const artTransformRef = useRef(artTransform);
  const transformPivotRef = useRef(transformPivot);
  const activeKeyToolRef = useRef('brush');
  const originStatusRef = useRef(originStatus);
  const voxelsRef = useRef(voxels);
  const modeRef = useRef(mode);
  const toolRef = useRef(tool);
  const blockSizeRef = useRef(blockSize);
  const colorRef = useRef(color);
  const materialRef = useRef(material);
  const reachRef = useRef(reachMeters);
  const occlusionEnabledRef = useRef(occlusionEnabled);
  const paintingRef = useRef(false);
  const lastPaintPosRef = useRef(null);
  const lastStackAtRef = useRef(0);
  const lastErasedKeyRef = useRef({ key: '', ts: 0 });
  const clearedBackupRef = useRef(null);
  const lastPrereqNotifyRef = useRef({ toolId: '', msg: '', ts: 0 });
  const toolAvailabilityRef = useRef({});
  const keyGestureRef = useRef({
    active: false,
    pointerId: null,
    targetRel: 0,
    startX: 0,
    anchorX: 0,
    lastX: 0,
    lastT: 0,
    velocityX: 0,
    movedPx: 0,
    swiped: false,
    holdStarted: false
  });
  const paintHoldTimerRef = useRef(null);
  const canvasSprayTimerRef = useRef(null);
  const canvasSprayingRef = useRef(false);
  const onFirstBrushUseRef = useRef(onFirstBrushUse);
  onFirstBrushUseRef.current = onFirstBrushUse;
  const dragStartRef = useRef(null);
  const tapStartRef = useRef(null);
  const activeCanvasPointersRef = useRef(new Map());
  const transformPinchRef = useRef(null);

  useEffect(() => {
    surfaceAnchorRef.current = surfaceAnchor;
  }, [surfaceAnchor]);

  useEffect(() => {
    artTransformRef.current = artTransform;
  }, [artTransform]);

  useEffect(() => {
    transformPivotRef.current = transformPivot;
  }, [transformPivot]);

  useEffect(() => {
    voxelsRef.current = voxels;
  }, [voxels]);

  useEffect(() => {
    modeRef.current = mode;
    toolRef.current = tool;
    blockSizeRef.current = blockSize;
    colorRef.current = color;
    materialRef.current = material;
    reachRef.current = reachMeters;
  }, [mode, tool, blockSize, color, material, reachMeters]);

  useEffect(() => {
    occlusionEnabledRef.current = occlusionEnabled;
  }, [occlusionEnabled]);

  const hasVoxels = voxels.length > 0;
  const toolAvailability = useMemo(() => {
    const originBlocked = Boolean(originStatus.originBlocked);
    const originMsg =
      originStatus.reason ||
      'Origin is blocked — clear whatever is in front of the drawing origin first.';
    const hasLoc = Boolean(location);
    const needBlocksFor = (verb) =>
      `Place at least 1 block with Brush (🖌️) or + Seed first before ${verb}.`;

    let publishReason = '';
    if (!hasVoxels) {
      publishReason = needBlocksFor('publishing your 3D sculpture');
    } else if (!hasLoc) {
      publishReason = 'Wait for a GPS location fix first before publishing on-chain.';
    } else if (!cameraReady) {
      publishReason = 'Enable live camera access first for Proof of Location before publishing.';
    } else if (!sceneScan.optimal) {
      publishReason = `Move your phone around to finish mapping this space (${sceneScan.scannedCount}/${sceneScan.targetCount} angles for 100% lock) before publishing.`;
    } else if (!user) {
      publishReason = 'Sign in with Google first before publishing & minting on-chain.';
    }

    return {
      brush: { usable: !originBlocked, reason: originBlocked ? originMsg : '' },
      pencil: { usable: !originBlocked, reason: originBlocked ? originMsg : '' },
      stack: {
        usable: !originBlocked && hasVoxels,
        reason: originBlocked ? originMsg : !hasVoxels ? needBlocksFor('stacking onto block faces') : ''
      },
      erase: {
        usable: true,
        reason: ''
      },
      clear: {
        usable: hasVoxels,
        reason: !hasVoxels ? 'Canvas is already empty — draw blocks first before clearing.' : ''
      },
      transform: {
        usable: hasVoxels || mode === 'transform',
        reason: !hasVoxels && mode !== 'transform' ? needBlocksFor('locking and scaling your art piece') : ''
      },
      undo: {
        usable: hasVoxels || hasClearedBackup,
        reason: !hasVoxels && !hasClearedBackup ? 'Nothing to undo yet — place or clear blocks first.' : ''
      },
      palette: {
        usable: mode === 'draw',
        reason: mode !== 'draw' ? 'Return to drawing mode (🖌️) first to pick colors and block finishes.' : ''
      },
      occlusion: {
        usable: cameraReady,
        reason: !cameraReady ? 'Enable live camera access first to toggle live foreground occlusion.' : ''
      },
      preview: {
        usable: hasLoc,
        reason: !hasLoc ? 'Wait for a GPS location fix first to view nearby AR sculptures.' : ''
      },
      agent: {
        usable: hasLoc,
        reason: !hasLoc ? 'Enable GPS location permission first so the Agent Code locks onto your spot.' : ''
      },
      publish: {
        usable: !publishReason,
        reason: publishReason
      },
      recenter: { usable: true, reason: '' },
      drafts: { usable: true, reason: '' },
      pair: { usable: true, reason: '' }
    };
  }, [
    originStatus.originBlocked,
    originStatus.reason,
    hasVoxels,
    hasClearedBackup,
    location,
    cameraReady,
    sceneScan.optimal,
    sceneScan.scannedCount,
    sceneScan.targetCount,
    user,
    mode
  ]);
  toolAvailabilityRef.current = toolAvailability;

  const rebuildDraftMesh = useCallback(
    (nextVoxels) => {
      const group = draftGroupRef.current;
      if (!group) return;
      if (!draftUnitGeoRef.current) {
        draftUnitGeoRef.current = new THREE.BoxGeometry(
          VOXEL_STEP * 0.96,
          VOXEL_STEP * 0.96,
          VOXEL_STEP * 0.96
        );
      }
      const unitGeo = draftUnitGeoRef.current;
      const matCache = draftMatCacheRef.current;
      const meshMap = draftMeshMapRef.current;

      const wanted = new Map();
      for (const v of nextVoxels) {
        wanted.set(voxelKey(v.x, v.y, v.z), v);
      }

      for (const [k, mesh] of meshMap.entries()) {
        if (!wanted.has(k)) {
          group.remove(mesh);
          meshMap.delete(k);
        }
      }

      for (const [k, v] of wanted.entries()) {
        const matKey = `${v.color}|${v.material || 'matte'}|1`;
        let mat = matCache.get(matKey);
        if (!mat) {
          mat = createVoxelMaterial(v.color, v.material || 'matte', 1);
          matCache.set(matKey, mat);
        }
        if (meshMap.has(k)) {
          const existing = meshMap.get(k);
          existing.position.set(v.x, v.y, v.z);
          existing.scale.setScalar(v.scale ?? 1);
          if (existing.material !== mat) {
            existing.material = mat;
          }
          existing.userData.voxel = v;
          continue;
        }
        const mesh = new THREE.Mesh(unitGeo, mat);
        mesh.position.set(v.x, v.y, v.z);
        mesh.scale.setScalar(v.scale ?? 1);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.voxel = v;
        group.add(mesh);
        meshMap.set(k, mesh);
      }
    },
    [draftGroupRef]
  );

  useEffect(() => {
    rebuildDraftMesh(voxels);
  }, [voxels, rebuildDraftMesh]);

  const computeTargetVoxel = useCallback(
    (forContinuousHold = false, screenPoint = null) => {
      const cam = cameraRef.current;
      const draftGroup = draftGroupRef.current;
      if (!cam) return null;

      const activeScale = normalizeBlockScale(blockSizeRef.current);
      const cellStep = getVoxelCellStep(VOXEL_STEP, activeScale);

      let origin = cam.position.clone();
      let dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      let baseNdcX = 0;
      let baseNdcY = 0;
      if (
        screenPoint &&
        Number.isFinite(Number(screenPoint.clientX)) &&
        Number.isFinite(Number(screenPoint.clientY)) &&
        canvasHostRef.current
      ) {
        const rect = canvasHostRef.current.getBoundingClientRect();
        baseNdcX = ((Number(screenPoint.clientX) - rect.left) / Math.max(1, rect.width)) * 2 - 1;
        baseNdcY = -((Number(screenPoint.clientY) - rect.top) / Math.max(1, rect.height)) * 2 + 1;
        const ndc = new THREE.Vector2(baseNdcX, baseNdcY);
        const tapRay = new THREE.Raycaster();
        tapRay.setFromCamera(ndc, cam);
        origin = tapRay.ray.origin.clone();
        dir = tapRay.ray.direction.clone().normalize();
      }

      if (
        toolRef.current === 'stack' ||
        toolRef.current === 'erase' ||
        toolRef.current === 'pencil'
      ) {
        const raycaster = new THREE.Raycaster(origin, dir, 0.1, 14);
        const targets = draftGroup ? draftGroup.children : [];
        let hits = targets.length ? raycaster.intersectObjects(targets, false) : [];
        if (
          hits.length === 0 &&
          toolRef.current === 'erase' &&
          (forContinuousHold || screenPoint) &&
          targets.length
        ) {
          const offsets = [
            [0.025, 0],
            [-0.025, 0],
            [0, 0.025],
            [0, -0.025]
          ];
          const sweepNdc = new THREE.Vector2();
          for (const [ox, oy] of offsets) {
            sweepNdc.set(baseNdcX + ox, baseNdcY + oy);
            raycaster.setFromCamera(sweepNdc, cam);
            hits = raycaster.intersectObjects(targets, false);
            if (hits.length > 0) break;
          }
        }
        if (hits.length > 0) {
          const hit = hits[0];
          const hitVoxel = hit.object.userData.voxel;
          if (toolRef.current === 'erase') {
            return { action: 'erase', voxel: hitVoxel };
          }
          if (toolRef.current === 'pencil' && hitVoxel) {
            const nearbySlots = computeAdjacentCandidateSlots(voxelsRef.current || [], {
              step: VOXEL_STEP,
              blockScale: activeScale,
              aroundVoxel: hitVoxel
            });
            return {
              action: 'replace',
              replaceExisting: true,
              replacedVoxel: hitVoxel,
              x: hitVoxel.x,
              y: hitVoxel.y,
              z: hitVoxel.z,
              scale: activeScale,
              nearbySlots
            };
          }
          const normal = hit.face.normal
            .clone()
            .transformDirection(hit.object.matrixWorld)
            .normalize();
          const stepOut = VOXEL_STEP * (((hitVoxel?.scale ?? 1) + activeScale) * 0.5);
          const center = hit.object.position.clone().addScaledVector(normal, stepOut);
          const nearbySlots = hitVoxel
            ? computeAdjacentCandidateSlots(voxelsRef.current || [], {
                step: VOXEL_STEP,
                blockScale: activeScale,
                aroundVoxel: hitVoxel
              })
            : [];
          return {
            action: 'add',
            x: snapToVoxelLattice(center.x, VOXEL_STEP, activeScale),
            y: snapToVoxelLattice(center.y, VOXEL_STEP, activeScale),
            z: snapToVoxelLattice(center.z, VOXEL_STEP, activeScale),
            scale: activeScale,
            stackedFrom: {
              x: snapCoord(hit.object.position.x),
              y: snapCoord(hit.object.position.y),
              z: snapCoord(hit.object.position.z)
            },
            nearbySlots
          };
        }
        if (toolRef.current === 'erase') return null;

        // When moving phone up or sideways around existing blocks, magnetically select
        // the closest open face-adjacent space so drawing & stacking around blocks is effortless.
        if (
          (toolRef.current === 'pencil' || toolRef.current === 'stack') &&
          (voxelsRef.current?.length || 0) > 0
        ) {
          const adjSlot = findBestAdjacentVoxelSlot({
            rayOrigin: origin,
            rayDir: dir,
            voxels: voxelsRef.current,
            step: VOXEL_STEP,
            blockScale: activeScale,
            maxDistance: 12
          });
          if (adjSlot) {
            return {
              action: 'add',
              x: adjSlot.x,
              y: adjSlot.y,
              z: adjSlot.z,
              scale: activeScale,
              adjacentTo: adjSlot.parentVoxel,
              adjacentFace: adjSlot.face,
              nearbySlots: adjSlot.nearbySlots || []
            };
          }
        }
      }

      const anchor = surfaceAnchorRef.current;
      if (anchor && anchor.locked) {
        const normal = new THREE.Vector3(anchor.nx, anchor.ny, anchor.nz).normalize();
        const denom = normal.dot(dir);
        if (Math.abs(denom) > 0.08) {
          const t =
            ((anchor.x - origin.x) * normal.x +
              (anchor.y - origin.y) * normal.y +
              (anchor.z - origin.z) * normal.z) /
            denom;
          if (t >= 0.4 && t <= 6.5) {
            const hitPt = origin
              .clone()
              .addScaledVector(dir, t)
              .addScaledVector(normal, cellStep * 0.5);
            return {
              action: 'add',
              x: snapToVoxelLattice(hitPt.x, VOXEL_STEP, activeScale),
              y: snapToVoxelLattice(hitPt.y, VOXEL_STEP, activeScale),
              z: snapToVoxelLattice(hitPt.z, VOXEL_STEP, activeScale),
              scale: activeScale,
              rawPoint: { x: hitPt.x, y: hitPt.y, z: hitPt.z }
            };
          }
        }
        const fallbackDepth = Math.min(4.5, Math.max(0.5, anchor.depthM || reachRef.current));
        const fallbackPt = origin.clone().addScaledVector(dir, fallbackDepth);
        return {
          action: 'add',
          x: snapToVoxelLattice(fallbackPt.x, VOXEL_STEP, activeScale),
          y: snapToVoxelLattice(fallbackPt.y, VOXEL_STEP, activeScale),
          z: snapToVoxelLattice(fallbackPt.z, VOXEL_STEP, activeScale),
          scale: activeScale,
          rawPoint: { x: fallbackPt.x, y: fallbackPt.y, z: fallbackPt.z }
        };
      }

      const pt = origin.clone().addScaledVector(dir, reachRef.current);
      return {
        action: 'add',
        x: snapToVoxelLattice(pt.x, VOXEL_STEP, activeScale),
        y: snapToVoxelLattice(pt.y, VOXEL_STEP, activeScale),
        z: snapToVoxelLattice(pt.z, VOXEL_STEP, activeScale),
        scale: activeScale,
        rawPoint: { x: pt.x, y: pt.y, z: pt.z }
      };
    },
    [cameraRef, canvasHostRef, draftGroupRef]
  );

  const applyVoxelBatch = useCallback(
    (targets) => {
      if (!Array.isArray(targets) || targets.length === 0) return;
      const halfSpan = config?.policy?.areaHalfSpanMeters || AREA_HALF_SPAN_METERS;
      const maxVoxels = config?.policy?.maxVoxels || 4096;

      const uniqueAdds = [];
      const seenBatch = new Set();
      let hadOutOfBounds = false;

      for (const t of targets) {
        if (!t || (t.action !== 'add' && t.action !== 'replace')) continue;
        if (
          Math.abs(t.x) > halfSpan ||
          Math.abs(t.y) > halfSpan ||
          Math.abs(t.z) > halfSpan
        ) {
          hadOutOfBounds = true;
          continue;
        }
        const k = voxelKey(t.x, t.y, t.z);
        if (!seenBatch.has(k)) {
          seenBatch.add(k);
          uniqueAdds.push({
            x: t.x,
            y: t.y,
            z: t.z,
            scale: normalizeBlockScale(t.scale ?? blockSizeRef.current),
            replaceExisting: Boolean(t.replaceExisting || t.action === 'replace'),
            key: k
          });
        }
      }

      if (hadOutOfBounds && uniqueAdds.length === 0) {
        setSensorBanner(
          `Area limit reached (${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} blocks max)`
        );
        return;
      }
      if (uniqueAdds.length === 0) return;
      clearedBackupRef.current = null;
      setHasClearedBackup(false);

      let limitNotice = '';
      setVoxels((prev) => {
        if (prev.length >= maxVoxels) {
          limitNotice = `Sculpture voxel limit (${maxVoxels}) reached`;
          return prev;
        }

        const existingIndexByKey = new Map();
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;

        for (let i = 0; i < prev.length; i += 1) {
          const v = prev[i];
          existingIndexByKey.set(voxelKey(v.x, v.y, v.z), i);
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
          if (v.z < minZ) minZ = v.z;
          if (v.z > maxZ) maxZ = v.z;
        }

        let nextList = null;
        const additions = [];
        for (const cand of uniqueAdds) {
          if (existingIndexByKey.has(cand.key)) {
            if (!cand.replaceExisting) continue;
            const idx = existingIndexByKey.get(cand.key);
            const cur = (nextList || prev)[idx];
            const nextScale = normalizeBlockScale(cand.scale ?? blockSizeRef.current);
            if (
              cur &&
              cur.color === colorRef.current &&
              (cur.material || 'matte') === materialRef.current &&
              normalizeBlockScale(cur.scale ?? 1) === nextScale
            ) {
              continue;
            }
            if (!nextList) nextList = [...prev];
            nextList[idx] = {
              x: cand.x,
              y: cand.y,
              z: cand.z,
              color: colorRef.current,
              material: materialRef.current,
              scale: nextScale
            };
            continue;
          }
          if (prev.length + additions.length >= maxVoxels) {
            limitNotice = `Sculpture voxel limit (${maxVoxels}) reached`;
            break;
          }

          const nMinX = Math.min(minX, cand.x);
          const nMaxX = Math.max(maxX, cand.x);
          const nMinY = Math.min(minY, cand.y);
          const nMaxY = Math.max(maxY, cand.y);
          const nMinZ = Math.min(minZ, cand.z);
          const nMaxZ = Math.max(maxZ, cand.z);

          const spanX = Math.round((nMaxX - nMinX) / VOXEL_STEP) + 1;
          const spanY = Math.round((nMaxY - nMinY) / VOXEL_STEP) + 1;
          const spanZ = Math.round((nMaxZ - nMinZ) / VOXEL_STEP) + 1;
          if (spanX > AREA_LIMIT_BLOCKS || spanY > AREA_LIMIT_BLOCKS || spanZ > AREA_LIMIT_BLOCKS) {
            limitNotice = `Area span exceeds ${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} blocks`;
            continue;
          }

          minX = nMinX;
          maxX = nMaxX;
          minY = nMinY;
          maxY = nMaxY;
          minZ = nMinZ;
          maxZ = nMaxZ;
          existingIndexByKey.set(cand.key, prev.length + additions.length);
          additions.push({
            x: cand.x,
            y: cand.y,
            z: cand.z,
            color: colorRef.current,
            material: materialRef.current,
            scale: normalizeBlockScale(cand.scale ?? blockSizeRef.current)
          });
        }

        if (nextList) {
          return additions.length > 0 ? [...nextList, ...additions] : nextList;
        }
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });

      if (limitNotice || hadOutOfBounds) {
        queueMicrotask(() => {
          setSensorBanner(
            limitNotice ||
              `Area limit reached (${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} blocks max)`
          );
        });
      }
    },
    [config?.policy?.areaHalfSpanMeters, config?.policy?.maxVoxels, setSensorBanner]
  );

  const eraseTargetVoxel = useCallback((target) => {
    if (!target || target.action !== 'erase' || !target.voxel) return false;
    const killKey = voxelKey(target.voxel.x, target.voxel.y, target.voxel.z);
    const now = performance.now();
    if (lastErasedKeyRef.current.key === killKey && now - lastErasedKeyRef.current.ts < 85) {
      return false;
    }
    lastErasedKeyRef.current = { key: killKey, ts: now };
    setVoxels((prev) => prev.filter((v) => voxelKey(v.x, v.y, v.z) !== killKey));
    return true;
  }, []);

  const applyVoxelAction = useCallback(
    (target) => {
      if (!target) return;
      if (target.action === 'erase') {
        eraseTargetVoxel(target);
        return;
      }
      if (target.action === 'add' || target.action === 'replace') {
        applyVoxelBatch([target]);
      }
    },
    [applyVoxelBatch, eraseTargetVoxel]
  );

  // Keep transform mesh + bounding box + surface anchor synchronized
  useEffect(() => {
    const group = draftGroupRef.current;
    const cage = transformBoxRef.current;
    if (!group) return;

    if (mode !== 'transform') {
      group.position.set(0, 0, 0);
      group.rotation.set(0, 0, 0);
      group.scale.set(1, 1, 1);
      if (cage) cage.visible = false;
      return;
    }

    const s = artTransform.scale;
    const rad = THREE.MathUtils.degToRad(artTransform.rotYDeg);
    const pivotVec = new THREE.Vector3(transformPivot.x, transformPivot.y, transformPivot.z);
    const offsetVec = new THREE.Vector3(
      artTransform.offsetX,
      artTransform.offsetY,
      artTransform.offsetZ
    );
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad);
    const transformedPivot = pivotVec.clone().multiplyScalar(s).applyQuaternion(quat);

    group.scale.setScalar(s);
    group.quaternion.copy(quat);
    group.position.copy(pivotVec).add(offsetVec).sub(transformedPivot);
    group.updateMatrixWorld(true);

    if (cage) {
      if (voxels.length > 0) {
        cage.box.setFromObject(group);
        cage.visible = true;
      } else {
        cage.visible = false;
      }
    }
  }, [mode, artTransform, transformPivot, voxels, draftGroupRef, transformBoxRef]);

  useEffect(() => {
    const marker = surfaceMarkerRef.current;
    const shadowPlane = shadowPlaneRef.current;
    const grid = gridHelperRef.current;
    if (!marker || !shadowPlane || !grid) return;

    if (!surfaceAnchor) {
      shadowPlane.position.set(0, -0.8, 0);
      shadowPlane.rotation.set(-Math.PI / 2, 0, 0);
      grid.position.set(0, -0.805, 0);
      grid.rotation.set(0, 0, 0);
      return;
    }

    const pos = new THREE.Vector3(surfaceAnchor.x, surfaceAnchor.y, surfaceAnchor.z);
    const normal = new THREE.Vector3(surfaceAnchor.nx, surfaceAnchor.ny, surfaceAnchor.nz).normalize();

    marker.visible = mode === 'draw';
    marker.position.copy(pos);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    shadowPlane.position.copy(pos).addScaledVector(normal, -0.002);
    shadowPlane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    grid.position.copy(pos).addScaledVector(normal, -0.004);
    grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  }, [surfaceAnchor, mode, surfaceMarkerRef, shadowPlaneRef, gridHelperRef]);

  const prevSyncStateRef = useRef({ mode: 'draw', tool: 'brush' });
  useEffect(() => {
    const prev = prevSyncStateRef.current;
    let syncedTool = null;
    if (mode !== prev.mode) {
      if (mode === 'transform' || mode === 'preview' || mode === 'publish') {
        syncedTool = mode;
      } else if (mode === 'draw') {
        syncedTool = tool;
      }
    } else if (tool !== prev.tool && mode === 'draw') {
      syncedTool = tool;
    }
    if (syncedTool) {
      activeKeyToolRef.current = syncedTool;
      setActiveKeyTool(syncedTool);
    }
    prevSyncStateRef.current = { mode, tool };
  }, [mode, tool]);

  const stopBrushPainting = useCallback(() => {
    if (paintHoldTimerRef.current) {
      clearTimeout(paintHoldTimerRef.current);
      paintHoldTimerRef.current = null;
    }
    if (canvasSprayTimerRef.current) {
      clearTimeout(canvasSprayTimerRef.current);
      canvasSprayTimerRef.current = null;
    }
    canvasSprayingRef.current = false;
    paintingRef.current = false;
    setPainting(false);
    lastPaintPosRef.current = null;
  }, []);

  const resetArtTransformState = useCallback(() => {
    setArtTransform({ scale: 1, rotYDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 });
    activeCanvasPointersRef.current.clear();
    transformPinchRef.current = null;
    if (draftGroupRef.current) {
      draftGroupRef.current.position.set(0, 0, 0);
      draftGroupRef.current.rotation.set(0, 0, 0);
      draftGroupRef.current.scale.set(1, 1, 1);
    }
    if (transformBoxRef.current) {
      transformBoxRef.current.visible = false;
    }
  }, [draftGroupRef, transformBoxRef]);

  const notifyToolUnavailable = useCallback(
    (toolId, reasonOverride = '') => {
      const info = toolAvailabilityRef.current?.[toolId];
      const msg =
        reasonOverride ||
        info?.reason ||
        'Complete the required step first before using this tool.';
      const now = Date.now();
      const last = lastPrereqNotifyRef.current;
      if (last.toolId === toolId && last.msg === msg && now - last.ts < 220) {
        return;
      }
      lastPrereqNotifyRef.current = { toolId, msg, ts: now };
      showTemporaryHint(msg);
    },
    [showTemporaryHint]
  );

  const ensureToolUsable = useCallback(
    (toolId) => {
      const info = toolAvailabilityRef.current?.[toolId];
      if (info && !info.usable) {
        notifyToolUnavailable(toolId, info.reason);
        return false;
      }
      return true;
    },
    [notifyToolUnavailable]
  );

  const enterTransformMode = useCallback(() => {
    stopBrushPainting();
    setPaletteOpen(false);
    occlusionRef.current?.reset?.();
    if (originStatusRef.current?.originBlocked) {
      const clearStatus = { originBlocked: false, originVisible: true, reason: '' };
      originStatusRef.current = clearStatus;
      setOriginStatus(clearStatus);
    }
    const pivot = computeVoxelCentroid(voxelsRef.current);
    setTransformPivot(pivot);
    transformPivotRef.current = pivot;
    resetArtTransformState();
    setMode('transform');
    modeRef.current = 'transform';
    showTemporaryHint(
      voxelsRef.current.length
        ? 'Art locked — pinch/drag or use sliders to scale & transform, tap ✅ to draw'
        : 'Transform locked — tap ✅ again to return to drawing mode'
    );
  }, [resetArtTransformState, showTemporaryHint, stopBrushPainting]);

  const commitTransformAndExit = useCallback(
    (nextMode = 'draw', nextTool = null) => {
      const tr = artTransformRef.current;
      const pivot = transformPivotRef.current;
      if (
        modeRef.current === 'transform' &&
        voxelsRef.current.length > 0 &&
        hasNonIdentityTransform(tr)
      ) {
        const s = tr.scale;
        const quat = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          THREE.MathUtils.degToRad(tr.rotYDeg)
        );
        const safeLimit = (config?.policy?.areaHalfSpanMeters || AREA_HALF_SPAN_METERS) - VOXEL_STEP;
        const vec = new THREE.Vector3();
        const baked = voxelsRef.current.map((v) => {
          vec
            .set(v.x - pivot.x, v.y - pivot.y, v.z - pivot.z)
            .multiplyScalar(s)
            .applyQuaternion(quat);
          return {
            ...v,
            x: Math.max(-safeLimit, Math.min(safeLimit, Math.round((pivot.x + tr.offsetX + vec.x) * 1000) / 1000)),
            y: Math.max(-safeLimit, Math.min(safeLimit, Math.round((pivot.y + tr.offsetY + vec.y) * 1000) / 1000)),
            z: Math.max(-safeLimit, Math.min(safeLimit, Math.round((pivot.z + tr.offsetZ + vec.z) * 1000) / 1000)),
            scale: Math.min(2, Math.max(0.25, Math.round(((v.scale ?? 1) * s) * 100) / 100))
          };
        });
        resetArtTransformState();
        setVoxels(baked);
      } else {
        resetArtTransformState();
      }
      setMode(nextMode);
      modeRef.current = nextMode;
      if (nextTool) {
        setTool(nextTool);
        toolRef.current = nextTool;
      }
      if (nextMode === 'draw') {
        showTemporaryHint('Returned to drawing mode');
      }
    },
    [config?.policy?.areaHalfSpanMeters, resetArtTransformState, showTemporaryHint]
  );

  const toggleTransformLock = useCallback(() => {
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw');
    } else {
      if (!ensureToolUsable('transform')) return;
      enterTransformMode();
    }
  }, [commitTransformAndExit, ensureToolUsable, enterTransformMode]);

  const clearCanvas = useCallback(() => {
    if (!ensureToolUsable('clear')) return;
    stopBrushPainting();
    if (voxelsRef.current.length > 0) {
      clearedBackupRef.current = voxelsRef.current;
      setHasClearedBackup(true);
    }
    lastErasedKeyRef.current = { key: '', ts: 0 };
    resetArtTransformState();
    setVoxels([]);
    if (toolRef.current === 'erase' || toolRef.current === 'stack') {
      setTool('brush');
      toolRef.current = 'brush';
    }
    if (modeRef.current === 'transform') {
      setMode('draw');
      modeRef.current = 'draw';
    }
    showTemporaryHint('Canvas cleared (tap Undo ↩️ to restore)');
  }, [ensureToolUsable, resetArtTransformState, showTemporaryHint, stopBrushPainting]);

  const handleUndo = useCallback(() => {
    if (!ensureToolUsable('undo')) return;
    if (voxelsRef.current.length === 0 && clearedBackupRef.current?.length) {
      const restored = clearedBackupRef.current;
      clearedBackupRef.current = null;
      setHasClearedBackup(false);
      setVoxels(restored);
      showTemporaryHint('Cleared canvas restored');
      return;
    }
    setVoxels((p) => p.slice(0, -1));
  }, [ensureToolUsable, showTemporaryHint]);

  const assertOriginUnblockedForPaint = useCallback(() => {
    if (!occlusionEnabledRef.current) {
      return true;
    }
    const cam = cameraRef.current;
    if (cam && occlusionRef.current) {
      const anchor = surfaceAnchorRef.current;
      const vList = voxelsRef.current || [];
      let ox = 0;
      let oy = 0;
      let oz = 0;
      let hasOrigin = false;
      let requiredVisible = false;
      if (anchor) {
        ox = anchor.x;
        oy = anchor.y;
        oz = anchor.z;
        hasOrigin = true;
        requiredVisible = Boolean(anchor.locked);
      } else if (vList.length > 0) {
        ox = vList[0].x;
        oy = vList[0].y;
        oz = vList[0].z;
        hasOrigin = true;
        requiredVisible = false;
      } else {
        const t = computeTargetVoxel();
        if (t && t.action === 'add') {
          ox = t.x;
          oy = t.y;
          oz = t.z;
          hasOrigin = true;
          requiredVisible = true;
        }
      }
      if (hasOrigin) {
        const proj = new THREE.Vector3(ox, oy, oz).project(cam);
        const sx = (proj.x + 1) * 0.5;
        const sy = (1 - proj.y) * 0.5;
        const onScreen =
          proj.z >= -1 && proj.z <= 1 && sx >= 0.04 && sx <= 0.96 && sy >= 0.04 && sy <= 0.96;
        const status = occlusionRef.current.evaluateOriginVisibility({
          x: sx,
          y: sy,
          onScreen,
          requiredVisible
        });
        originStatusRef.current = status;
        setOriginStatus(status);
      }
    }

    if (originStatusRef.current?.originBlocked) {
      const msg =
        originStatusRef.current.reason ||
        'Origin is blocked — clear whatever is in front of the drawing origin to start painting.';
      showTemporaryHint(msg);
      setSensorBanner(msg);
      return false;
    }
    return true;
  }, [cameraRef, computeTargetVoxel, setSensorBanner, showTemporaryHint]);

  const startContinuousHoldTool = useCallback(
    (holdTool) => {
      enterFullscreen();
      if (!ensureToolUsable(holdTool)) return;
      if (holdTool === 'brush' && onFirstBrushUseRef.current?.()) {
        return;
      }
      if ((holdTool === 'brush' || holdTool === 'stack') && !assertOriginUnblockedForPaint()) {
        return;
      }
      if (modeRef.current === 'transform') {
        commitTransformAndExit('draw', holdTool);
      } else {
        setMode('draw');
        modeRef.current = 'draw';
        setTool(holdTool);
        toolRef.current = holdTool;
      }
      paintingRef.current = true;
      setPainting(true);
      if (holdTool === 'brush') {
        navigator.vibrate?.(6);
      }
      const t = computeTargetVoxel(true);
      if (holdTool === 'erase') {
        eraseTargetVoxel(t);
      } else if (t && (t.action === 'add' || t.action === 'replace')) {
        lastPaintPosRef.current = { x: t.x, y: t.y, z: t.z };
        lastStackAtRef.current = performance.now();
        applyVoxelBatch([t]);
      }
    },
    [
      applyVoxelBatch,
      assertOriginUnblockedForPaint,
      commitTransformAndExit,
      computeTargetVoxel,
      ensureToolUsable,
      enterFullscreen,
      eraseTargetVoxel
    ]
  );

  const getDockHoldHandlers = useCallback(
    (holdTool) => ({
      onPointerDown: (e) => {
        if (e.button && e.button !== 0) return;
        e.preventDefault();
        if (!ensureToolUsable(holdTool)) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        startContinuousHoldTool(holdTool);
      },
      onPointerUp: (e) => {
        stopBrushPainting();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      },
      onPointerCancel: () => stopBrushPainting(),
      onContextMenu: (e) => e.preventDefault()
    }),
    [ensureToolUsable, startContinuousHoldTool, stopBrushPainting]
  );

  const selectKeyTool = useCallback(
    (toolId, { silent = false } = {}) => {
      activeKeyToolRef.current = toolId;
      setActiveKeyTool(toolId);
      const avail = toolAvailabilityRef.current?.[toolId];
      if (avail && !avail.usable) {
        if (!silent) {
          notifyToolUnavailable(toolId, avail.reason);
        }
        return;
      }
      if (toolId === 'transform') {
        enterTransformMode();
        return;
      }
      if (toolId === 'brush' || toolId === 'pencil' || toolId === 'stack' || toolId === 'erase') {
        if (modeRef.current === 'transform') {
          commitTransformAndExit('draw', toolId);
        } else {
          setMode('draw');
          setTool(toolId);
        }
      } else if (toolId === 'preview') {
        if (modeRef.current === 'transform') {
          commitTransformAndExit('preview');
        } else {
          setPaletteOpen(false);
          setMode('preview');
        }
      } else if (
        toolId === 'undo' ||
        toolId === 'clear' ||
        toolId === 'recenter' ||
        toolId === 'drafts' ||
        toolId === 'occlusion' ||
        toolId === 'pair' ||
        toolId === 'agent' ||
        toolId === 'publish'
      ) {
        if (modeRef.current === 'transform') {
          commitTransformAndExit('draw');
        } else {
          setMode('draw');
        }
      }
    },
    [commitTransformAndExit, enterTransformMode, notifyToolUnavailable]
  );

  const stepKeyTool = useCallback(
    (delta, opts = {}) => {
      const list = opts.visibleTools || KEY_TOOLS;
      const idx = list.findIndex((t) => t.id === activeKeyToolRef.current);
      const current = idx >= 0 ? idx : 0;
      const nextIdx = (((current + delta) % list.length) + list.length) % list.length;
      selectKeyTool(list[nextIdx].id, opts);
    },
    [selectKeyTool]
  );

  const triggerActiveKeyTool = useCallback(() => {
    enterFullscreen();
    const curTool = activeKeyToolRef.current;
    if (!ensureToolUsable(curTool)) {
      return;
    }
    if (curTool === 'transform') {
      toggleTransformLock();
    } else if (
      curTool === 'brush' ||
      curTool === 'pencil' ||
      curTool === 'stack' ||
      curTool === 'erase'
    ) {
      if (curTool === 'brush' && onFirstBrushUseRef.current?.()) {
        return;
      }
      if (
        (curTool === 'brush' || curTool === 'pencil' || curTool === 'stack') &&
        !assertOriginUnblockedForPaint()
      ) {
        return;
      }
      if (modeRef.current === 'transform') {
        commitTransformAndExit('draw', curTool);
      } else {
        setMode('draw');
        setTool(curTool);
        toolRef.current = curTool;
      }
      applyVoxelAction(computeTargetVoxel());
    } else if (curTool === 'undo') {
      handleUndo();
    } else if (curTool === 'clear') {
      clearCanvas();
    } else if (curTool === 'recenter') {
      recenterAimRef?.current?.();
      showTemporaryHint('3D aim recentered');
    } else if (curTool === 'drafts') {
      openDraftsSheetRef?.current?.();
    } else if (curTool === 'occlusion') {
      setOcclusionEnabled((prev) => {
        const next = !prev;
        occlusionEnabledRef.current = next;
        if (!next) {
          occlusionRef.current?.reset?.();
          const clearStatus = { originBlocked: false, originVisible: true, reason: '' };
          originStatusRef.current = clearStatus;
          setOriginStatus(clearStatus);
        }
        showTemporaryHint(next ? 'Foreground Occlusion ON' : 'Foreground Occlusion OFF');
        return next;
      });
    } else if (curTool === 'pair') {
      openPairModalRef?.current?.();
    } else if (curTool === 'preview') {
      const next = modeRef.current === 'preview' ? 'draw' : 'preview';
      if (modeRef.current === 'transform') {
        commitTransformAndExit(next);
      } else {
        setPaletteOpen(false);
        setMode(next);
      }
    } else if (curTool === 'agent') {
      openAgentHandoffRef.current?.();
    } else if (curTool === 'publish') {
      openPublishSheetRef.current?.();
    }
  }, [
    applyVoxelAction,
    assertOriginUnblockedForPaint,
    clearCanvas,
    commitTransformAndExit,
    computeTargetVoxel,
    ensureToolUsable,
    enterFullscreen,
    handleUndo,
    openAgentHandoffRef,
    openDraftsSheetRef,
    openPairModalRef,
    openPublishSheetRef,
    recenterAimRef,
    showTemporaryHint,
    toggleTransformLock
  ]);

  const handleKeyPointerDown = useCallback(
    (e) => {
      if (e.button && e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore if synthetic pointer
      }
      stopBrushPainting();
      const relAttr = e.target?.closest?.('[data-tool-rel]')?.getAttribute?.('data-tool-rel');
      const targetRel = relAttr != null ? Number(relAttr) : 0;
      const now = performance.now();
      keyGestureRef.current = {
        active: true,
        pointerId: e.pointerId,
        targetRel: Number.isFinite(targetRel) ? targetRel : 0,
        startX: e.clientX,
        anchorX: e.clientX,
        lastX: e.clientX,
        lastT: now,
        velocityX: 0,
        movedPx: 0,
        swiped: false,
        holdStarted: false
      };
      setSwipeDragPx(0);
      setIsDraggingKey(true);

      const curTool = activeKeyToolRef.current;
      if (targetRel === 0 && (curTool === 'brush' || curTool === 'stack' || curTool === 'erase')) {
        const holdDelayMs = curTool === 'brush' ? 75 : 135;
        paintHoldTimerRef.current = setTimeout(() => {
          if (!keyGestureRef.current.active || keyGestureRef.current.swiped) return;
          keyGestureRef.current.holdStarted = true;
          startContinuousHoldTool(curTool);
        }, holdDelayMs);
      }
    },
    [startContinuousHoldTool, stopBrushPainting]
  );

  const handleKeyPointerMove = useCallback(
    (e, visibleTools) => {
      const g = keyGestureRef.current;
      if (!g.active || g.pointerId !== e.pointerId) return;
      const now = performance.now();
      const dt = Math.max(4, now - g.lastT);
      const stepVx = (e.clientX - g.lastX) / dt;
      g.velocityX = g.velocityX * 0.45 + stepVx * 0.55;
      g.movedPx += Math.abs(e.clientX - g.lastX);
      g.lastX = e.clientX;
      g.lastT = now;

      if (!g.swiped && Math.abs(e.clientX - g.startX) >= 7) {
        g.swiped = true;
        stopBrushPainting();
      }

      let dx = e.clientX - g.anchorX;
      while (dx >= KEY_CAROUSEL_SLOT_PX * 0.58) {
        stepKeyTool(-1, { silent: true, visibleTools });
        g.anchorX += KEY_CAROUSEL_SLOT_PX;
        dx -= KEY_CAROUSEL_SLOT_PX;
        navigator.vibrate?.(8);
      }
      while (dx <= -KEY_CAROUSEL_SLOT_PX * 0.58) {
        stepKeyTool(1, { silent: true, visibleTools });
        g.anchorX -= KEY_CAROUSEL_SLOT_PX;
        dx += KEY_CAROUSEL_SLOT_PX;
        navigator.vibrate?.(8);
      }
      setSwipeDragPx(Math.max(-KEY_CAROUSEL_SLOT_PX, Math.min(KEY_CAROUSEL_SLOT_PX, dx)));
    },
    [stepKeyTool, stopBrushPainting]
  );

  const handleKeyPointerUp = useCallback(
    (e, visibleTools) => {
      const g = keyGestureRef.current;
      if (!g.active) return;
      const wasSwiped = g.swiped;
      const wasHold = g.holdStarted;
      const movedPx = g.movedPx;
      const targetRel = g.targetRel;
      const flickVx = g.velocityX;
      const residualDx = e.clientX - g.anchorX;

      keyGestureRef.current.active = false;
      keyGestureRef.current.swiped = false;
      keyGestureRef.current.holdStarted = false;
      setIsDraggingKey(false);
      setSwipeDragPx(0);
      stopBrushPainting();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (!wasHold) {
        if (wasSwiped) {
          if (Math.abs(residualDx) >= 10 && Math.abs(flickVx) > 0.35) {
            stepKeyTool(flickVx < 0 ? 1 : -1, { visibleTools });
            navigator.vibrate?.(8);
          } else if (Math.abs(residualDx) >= KEY_CAROUSEL_SLOT_PX * 0.38) {
            stepKeyTool(residualDx < 0 ? 1 : -1, { visibleTools });
            navigator.vibrate?.(8);
          } else {
            const landedAvail = toolAvailabilityRef.current?.[activeKeyToolRef.current];
            if (landedAvail && !landedAvail.usable) {
              notifyToolUnavailable(activeKeyToolRef.current, landedAvail.reason);
            }
          }
        } else if (movedPx < 8) {
          if (targetRel !== 0) {
            stepKeyTool(targetRel, { visibleTools });
          } else {
            triggerActiveKeyTool();
          }
        }
      }
    },
    [notifyToolUnavailable, stepKeyTool, stopBrushPainting, triggerActiveKeyTool]
  );

  const handleKeyPointerCancel = useCallback(() => {
    keyGestureRef.current.active = false;
    keyGestureRef.current.swiped = false;
    keyGestureRef.current.holdStarted = false;
    setIsDraggingKey(false);
    setSwipeDragPx(0);
    stopBrushPainting();
  }, [stopBrushPainting]);

  const selectSurfaceAtScreenPoint = useCallback(
    (clientX, clientY) => {
      const host = canvasHostRef.current;
      const cam = cameraRef.current;
      if (!host || !cam) return;

      const rect = host.getBoundingClientRect();
      const px = clientX ?? rect.left + rect.width * 0.5;
      const py = clientY ?? rect.top + rect.height * 0.5;
      const normX = Math.max(0.05, Math.min(0.95, (px - rect.left) / Math.max(1, rect.width)));
      const normY = Math.max(0.05, Math.min(0.95, (py - rect.top) / Math.max(1, rect.height)));
      const ndc = new THREE.Vector2(normX * 2 - 1, -(normY * 2 - 1));

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, cam);
      const dir = raycaster.ray.direction.clone().normalize();
      const origin = raycaster.ray.origin.clone();

      const draftTargets = draftGroupRef.current ? draftGroupRef.current.children : [];
      const voxelHits = draftTargets.length ? raycaster.intersectObjects(draftTargets, false) : [];
      if (voxelHits.length > 0) {
        const hit = voxelHits[0];
        const worldNormal = hit.face.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
          .normalize();
        const depthM = Math.max(0.45, Math.min(4.5, hit.distance));
        setReachMeters(Number(depthM.toFixed(2)));
        setSurfaceAnchor({
          x: hit.point.x,
          y: hit.point.y,
          z: hit.point.z,
          nx: worldNormal.x,
          ny: worldNormal.y,
          nz: worldNormal.z,
          depthM: Number(depthM.toFixed(2)),
          label: 'Sculpture Face',
          source: 'voxel',
          sharpnessScore: 1,
          locked: true
        });
        showTemporaryHint(`Start locked to sculpture face (${depthM.toFixed(1)}m)`);
        return;
      }

      const patch = polRef.current.analyzeSurfacePatch(normX, normY);
      const sharpness = patch ? patch.sharpnessScore : 0.35;
      let label = 'Mid-Air Spot';
      let depthM = reachRef.current;
      let nx = -dir.x;
      let ny = -dir.y;
      let nz = -dir.z;

      if (dir.y < -0.36) {
        label = 'Floor';
        nx = 0;
        ny = 1;
        nz = 0;
        depthM = Math.max(0.75, Math.min(4.0, 1.25 / -dir.y));
      } else if (dir.y < -0.12) {
        label = 'Table / Ledge';
        nx = 0;
        ny = 1;
        nz = 0;
        depthM = Math.max(0.7, Math.min(3.2, 0.65 / -dir.y));
      } else if (sharpness >= 0.22) {
        label = 'Wall / Surface';
        const horizLen = Math.hypot(dir.x, dir.z);
        if (horizLen > 0.15) {
          nx = -dir.x / horizLen;
          ny = 0;
          nz = -dir.z / horizLen;
        }
        depthM = Math.max(0.85, Math.min(3.2, 2.2 - sharpness * 0.7));
      } else {
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
      }

      const pt = origin.addScaledVector(dir, depthM);
      setReachMeters(Number(depthM.toFixed(2)));
      setSurfaceAnchor({
        x: pt.x,
        y: pt.y,
        z: pt.z,
        nx,
        ny,
        nz,
        depthM: Number(depthM.toFixed(2)),
        label,
        source: 'surface',
        sharpnessScore: Number(sharpness.toFixed(2)),
        locked: true
      });
      showTemporaryHint(`Start surface set: ${label} (${depthM.toFixed(1)}m)`);
    },
    [cameraRef, canvasHostRef, draftGroupRef, polRef, showTemporaryHint]
  );

  const seedVoxelAtAnchor = useCallback(() => {
    if (!surfaceAnchor) return;
    if (!ensureToolUsable('brush')) return;
    if (!assertOriginUnblockedForPaint()) return;
    const normal = new THREE.Vector3(surfaceAnchor.nx, surfaceAnchor.ny, surfaceAnchor.nz).normalize();
    const p = new THREE.Vector3(surfaceAnchor.x, surfaceAnchor.y, surfaceAnchor.z).addScaledVector(
      normal,
      VOXEL_STEP * 0.5
    );
    applyVoxelBatch([
      {
        action: 'add',
        x: snapCoord(p.x),
        y: snapCoord(p.y),
        z: snapCoord(p.z)
      }
    ]);
  }, [applyVoxelBatch, assertOriginUnblockedForPaint, ensureToolUsable, surfaceAnchor]);

  const handleCanvasPointerDown = useCallback(
    (e) => {
      activeCanvasPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (modeRef.current === 'transform') {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        if (activeCanvasPointersRef.current.size >= 2) {
          const pts = Array.from(activeCanvasPointersRef.current.values());
          transformPinchRef.current = {
            dist: Math.max(12, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
            angle: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x)
          };
        } else {
          transformPinchRef.current = null;
        }
        return;
      }
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      tapStartRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };

      // Spray-can feel: when gyro is active in Brush mode, holding thumb anywhere on the
      // live camera screen starts fluid continuous spraying until finger lifts!
      if (
        modeRef.current === 'draw' &&
        toolRef.current === 'brush' &&
        !isInteractingWithLandRef?.current &&
        rawOrientationRef.current &&
        activeCanvasPointersRef.current.size === 1
      ) {
        if (canvasSprayTimerRef.current) clearTimeout(canvasSprayTimerRef.current);
        canvasSprayTimerRef.current = setTimeout(() => {
          canvasSprayTimerRef.current = null;
          if (!tapStartRef.current || activeCanvasPointersRef.current.size !== 1) return;
          canvasSprayingRef.current = true;
          startContinuousHoldTool('brush');
        }, 115);
      }
    },
    [isInteractingWithLandRef, rawOrientationRef, startContinuousHoldTool]
  );

  const handleCanvasPointerMove = useCallback(
    (e) => {
      const pointers = activeCanvasPointersRef.current;
      const prevPt = pointers.get(e.pointerId);
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (modeRef.current === 'transform') {
        if (!prevPt || !pointers.size) return;
        if (pointers.size >= 2) {
          const pts = Array.from(pointers.values());
          const dist = Math.max(12, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
          const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
          if (!transformPinchRef.current) {
            transformPinchRef.current = { dist, angle };
            return;
          }
          const scaleFactor = dist / Math.max(12, transformPinchRef.current.dist);
          let dAngleDeg = ((angle - transformPinchRef.current.angle) * 180) / Math.PI;
          if (dAngleDeg > 180) dAngleDeg -= 360;
          if (dAngleDeg < -180) dAngleDeg += 360;
          transformPinchRef.current = { dist, angle };
          setArtTransform((prev) => ({
            ...prev,
            scale: Math.max(0.25, Math.min(2, Number((prev.scale * scaleFactor).toFixed(3)))),
            rotYDeg: Math.round(((prev.rotYDeg - dAngleDeg + 540) % 360) - 180)
          }));
        } else if (pointers.size === 1) {
          const dx = e.clientX - prevPt.x;
          const dy = e.clientY - prevPt.y;
          const cam = cameraRef.current;
          if (!cam) return;
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
          const pivot = transformPivotRef.current;
          const tr = artTransformRef.current;
          const worldPos = new THREE.Vector3(
            pivot.x + tr.offsetX,
            pivot.y + tr.offsetY,
            pivot.z + tr.offsetZ
          );
          const dist = Math.max(0.8, Math.min(5, cam.position.distanceTo(worldPos)));
          const moveScale = dist * 0.0022;
          setArtTransform((prev) => ({
            ...prev,
            offsetX: prev.offsetX + (camRight.x * dx - camUp.x * dy) * moveScale,
            offsetY: prev.offsetY + (camRight.y * dx - camUp.y * dy) * moveScale,
            offsetZ: prev.offsetZ + (camRight.z * dx - camUp.z * dy) * moveScale
          }));
        }
        return;
      }

      if (!dragStartRef.current || rawOrientationRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      fallbackEulerRef.current.yaw -= dx * 0.004;
      fallbackEulerRef.current.pitch = Math.max(
        -1.2,
        Math.min(1.2, fallbackEulerRef.current.pitch - dy * 0.004)
      );
    },
    [cameraRef, fallbackEulerRef, rawOrientationRef]
  );

  const handleCanvasPointerCancel = useCallback(
    (e) => {
      activeCanvasPointersRef.current.delete(e.pointerId);
      if (activeCanvasPointersRef.current.size < 2) {
        transformPinchRef.current = null;
      }
      if (canvasSprayTimerRef.current) {
        clearTimeout(canvasSprayTimerRef.current);
        canvasSprayTimerRef.current = null;
      }
      if (canvasSprayingRef.current) {
        stopBrushPainting();
      }
      dragStartRef.current = null;
      tapStartRef.current = null;
    },
    [stopBrushPainting]
  );

  const handleCanvasPointerUp = useCallback(
    (e) => {
      activeCanvasPointersRef.current.delete(e.pointerId);
      if (activeCanvasPointersRef.current.size < 2) {
        transformPinchRef.current = null;
      }
      if (canvasSprayTimerRef.current) {
        clearTimeout(canvasSprayTimerRef.current);
        canvasSprayTimerRef.current = null;
      }
      const wasCanvasSpray = canvasSprayingRef.current;
      if (wasCanvasSpray) {
        stopBrushPainting();
      }
      dragStartRef.current = null;
      const start = tapStartRef.current;
      tapStartRef.current = null;
      if (wasCanvasSpray || !start || modeRef.current === 'transform') return;

      const moveDist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moveDist > 14) return;

      if (modeRef.current === 'draw') {
        if (!paintingRef.current && !keyGestureRef.current.active) {
          // Check if the user tapped a visible nearby 3D land volume or its sculpture first
          const host = canvasHostRef.current;
          const cam = cameraRef.current;
          const nearbyGroup = nearbyGroupRef.current;
          if (host && cam && nearbyGroup && nearbyGroup.children.length > 0 && onTapArLand) {
            const rect = host.getBoundingClientRect();
            const ndc = new THREE.Vector2(
              ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
              -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
            );
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(ndc, cam);
            const hits = raycaster.intersectObjects(nearbyGroup.children, true);
            const hitLandObj = hits.find(
              (h) => h.object?.userData?.parcel || h.object?.userData?.isArLandHit
            );
            if (hitLandObj?.object?.userData?.parcel) {
              onTapArLand(
                hitLandObj.object.userData.parcel,
                hitLandObj.object.userData.sculpture || null
              );
              return;
            }
          }
          // If already interacting with a land and user taps empty sky, exit interaction smoothly
          if (isInteractingWithLandRef?.current && onTapArLand) {
            onTapArLand(null, null);
            return;
          }
          // Pencil mode: tap a block to replace it, or tap adjacent/open space to place/stack!
          if (toolRef.current === 'pencil') {
            if (!ensureToolUsable('pencil') || !assertOriginUnblockedForPaint()) return;
            const tapTarget = computeTargetVoxel(false, { clientX: e.clientX, clientY: e.clientY });
            if (tapTarget && (tapTarget.action === 'add' || tapTarget.action === 'replace')) {
              applyVoxelBatch([tapTarget]);
            }
            return;
          }
          // Eraser mode: tapping a placed block directly erases it cleanly
          if (toolRef.current === 'erase') {
            const tapTarget = computeTargetVoxel(true, { clientX: e.clientX, clientY: e.clientY });
            if (tapTarget && tapTarget.action === 'erase') {
              eraseTargetVoxel(tapTarget);
            }
            return;
          }
          selectSurfaceAtScreenPoint(e.clientX, e.clientY);
        }
        return;
      }

      if (modeRef.current !== 'preview') return;

      const host = canvasHostRef.current;
      const cam = cameraRef.current;
      const nearbyGroup = nearbyGroupRef.current;
      if (!host || !cam || !nearbyGroup) return;

      const rect = host.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, cam);
      const hits = raycaster.intersectObjects(nearbyGroup.children, true);
      const hitWithSculpture = hits.find((h) => h.object?.userData?.sculpture);
      if (hitWithSculpture) {
        const hitSc = hitWithSculpture.object.userData.sculpture;
        arTargetedIdRef.current = hitSc.id;
        const loc = locationRef.current;
        const d = loc ? haversineMeters(loc.lat, loc.lng, hitSc.lat, hitSc.lng) : hitWithSculpture.distance;
        setArTargetedSculpture({ sculpture: hitSc, distanceM: d });
        openCameraSelectedChat(hitSc, hitWithSculpture.distance, arPinPreview);
        return;
      }
      const hitLandOnly = hits.find(
        (h) => h.object?.userData?.parcel || h.object?.userData?.isArLandHit
      );
      if (hitLandOnly?.object?.userData?.parcel && onTapArLand) {
        onTapArLand(hitLandOnly.object.userData.parcel, null);
      } else if (isInteractingWithLandRef?.current && onTapArLand) {
        onTapArLand(null, null);
      }
    },
    [
      applyVoxelBatch,
      arPinPreview,
      arTargetedIdRef,
      assertOriginUnblockedForPaint,
      cameraRef,
      canvasHostRef,
      computeTargetVoxel,
      ensureToolUsable,
      eraseTargetVoxel,
      isInteractingWithLandRef,
      locationRef,
      nearbyGroupRef,
      onTapArLand,
      openCameraSelectedChat,
      selectSurfaceAtScreenPoint,
      setArTargetedSculpture,
      stopBrushPainting
    ]
  );

  return {
    occlusionRef,
    draftMeshMapRef,
    draftUnitGeoRef,
    draftMatCacheRef,
    originStatus,
    setOriginStatus,
    originStatusRef,
    mode,
    setMode,
    modeRef,
    tool,
    setTool,
    toolRef,
    blockSize,
    setBlockSize,
    blockSizeRef,
    color,
    setColor,
    colorRef,
    material,
    setMaterial,
    materialRef,
    reachMeters,
    setReachMeters,
    reachRef,
    voxels,
    setVoxels,
    voxelsRef,
    paletteOpen,
    setPaletteOpen,
    occlusionEnabled,
    setOcclusionEnabled,
    occlusionEnabledRef,
    painting,
    paintingRef,
    lastPaintPosRef,
    lastStackAtRef,
    surfaceAnchor,
    setSurfaceAnchor,
    surfaceAnchorRef,
    artTransform,
    setArtTransform,
    artTransformRef,
    transformPivot,
    activeKeyTool,
    swipeDragPx,
    isDraggingKey,
    hasClearedBackup,
    toolAvailability,
    rebuildDraftMesh,
    computeTargetVoxel,
    applyVoxelBatch,
    eraseTargetVoxel,
    applyVoxelAction,
    stopBrushPainting,
    resetArtTransformState,
    notifyToolUnavailable,
    ensureToolUsable,
    enterTransformMode,
    commitTransformAndExit,
    toggleTransformLock,
    clearCanvas,
    handleUndo,
    assertOriginUnblockedForPaint,
    getDockHoldHandlers,
    selectKeyTool,
    stepKeyTool,
    triggerActiveKeyTool,
    handleKeyPointerDown,
    handleKeyPointerMove,
    handleKeyPointerUp,
    handleKeyPointerCancel,
    selectSurfaceAtScreenPoint,
    seedVoxelAtAnchor,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerCancel,
    handleCanvasPointerUp
  };
}
