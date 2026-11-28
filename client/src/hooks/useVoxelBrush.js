import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import {
  AREA_HALF_SPAN_METERS,
  AREA_LIMIT_BLOCKS,
  HUMAN_MAX_DRAW_SPAN_FEET,
  HUMAN_MAX_DRAW_SPAN_METERS,
  STALE_DRAW_ERASE_DISTANCE_FEET,
  STALE_DRAW_ERASE_IDLE_MINUTES,
  STALE_DRAW_ERASE_IDLE_MS
} from '../../../shared/constants.mjs';
import {
  computeAdjacentCandidateSlots,
  computeMaxHumanDrawScale,
  findBestAdjacentVoxelSlot,
  getVoxelCellStep,
  measureVoxelHorizontalFootprint,
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
import {
  collectPlacedItemColliders,
  computeCandidateDraftWorldBox,
  testBoundingBoxAgainstPlacedItems,
  testTransformedVoxelsAgainstPlacedItems,
  testVoxelAgainstPlacedItems
} from '../utils/arItemCollision.js';
import {
  captureTwoFingerFrame,
  computeOneFingerDragStep,
  computeTwoFingerTransformStep
} from '../utils/arTransformGestures.js';
import { computeGizmoHandleDragStep } from '../utils/arTransformGizmo3D.js';
import {
  evaluateStaleDrawErase,
  normalizeDrawLocation,
  resolveInitialDrawActivity
} from '../utils/staleDrawGuard.js';
import {
  describeCameraNeededAction,
  describeLocationNeededAction
} from '../utils/permissionMessages.js';
import { markModalOpenedFromPointerUp } from '../utils/modalBackdropGuard.js';

export const KEY_TOOLS = [
  { id: 'brush', emoji: '🖌️', label: 'Brush', hint: 'Hold & sweep phone like a spray can' },
  { id: 'pencil', emoji: '✏️', label: 'Pencil', hint: 'Tap to place, stack, or replace blocks' },
  { id: 'erase', emoji: '🧽', label: 'Erase', hint: 'Tap or hold blocks to erase' },
  { id: 'transform', emoji: '✅', label: 'Lock & Scale', hint: '2-finger rotate, scale & position in 3D' },
  { id: 'stack', emoji: '🧱', label: 'Stack', hint: 'Hold to stack onto block faces' },
  { id: 'search', emoji: '🔍', label: 'Search 3D', hint: 'Search & place 3D models & emojis' },
  { id: 'undo', emoji: '↩️', label: 'Undo', hint: 'Tap to undo last block or restore clear' },
  { id: 'clear', emoji: '🗑️', label: 'Clear', hint: 'Tap to erase current canvas' },
  { id: 'recenter', emoji: '🧭', label: 'Recenter', hint: 'Tap to recenter 3D gyroscope aim' },
  { id: 'preview', emoji: '👁️', label: 'Preview', hint: 'AR preview & E2EE chat' },
  { id: 'drafts', emoji: '💾', label: 'Drafts', hint: 'Save & load sculpture drafts' },
  { id: 'publish', emoji: '🚀', label: 'Publish', hint: 'Review & mint on your phone' }
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
    Math.abs(tr.rotXDeg || 0) > 0.25 ||
    Math.abs(tr.rotYDeg || 0) > 0.25 ||
    Math.abs(tr.rotZDeg || 0) > 0.25 ||
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
  calibrationReady,
  calibrationBlockReason = '',
  onRequireCalibration = null,
  polRef,
  rawOrientationRef,
  webxrActiveRef = null,
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
  openCatalogSearchRef = null,
  openPairModalRef = null,
  openAgentHandoffRef,
  openPublishSheetRef,
  onFirstBrushUse = null,
  editingSculptureIdRef = null,
  refreshLocationNow = null,
  isPublishingRef = null,
  onAutoEraseStaleDrawing = null,
  onResetSpatialOrigin = null,
  hasPlacedCatalogItem = false,
  placedCatalogItemRef = null,
  placedCatalogPivotRef = null,
  onCommitCatalogTransform = null,
  onClearCatalogItem = null
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
  const clampReach = useCallback((rawVal) => {
    const n = Number(rawVal);
    if (!Number.isFinite(n)) return 1.8;
    return Math.max(0.5, Math.min(12, Math.round(n * 100) / 100));
  }, []);
  const [reachMeters, setReachMetersState] = useState(() => clampReach(initialDraft.reachMeters));
  const setReachMeters = useCallback(
    (nextVal) => {
      setReachMetersState((prev) =>
        clampReach(typeof nextVal === 'function' ? nextVal(prev) : nextVal)
      );
    },
    [clampReach]
  );
  const [voxels, setVoxels] = useState(() =>
    Array.isArray(initialDraft.voxels) ? initialDraft.voxels : []
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [occlusionEnabled, setOcclusionEnabled] = useState(false);
  const [painting, setPainting] = useState(false);
  const [toolHolding, setToolHolding] = useState(false);
  const [surfaceAnchor, setSurfaceAnchor] = useState(() => initialDraft.surfaceAnchor || null);
  const [artTransform, setArtTransformState] = useState({
    scale: 1,
    rotXDeg: 0,
    rotYDeg: 0,
    rotZDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0
  });
  const [transformPivot, setTransformPivot] = useState({ x: 0, y: 0, z: 0 });
  const [transformCollision, setTransformCollision] = useState(null);
  const [activeGizmoHandle, setActiveGizmoHandle] = useState('');
  const [activeKeyTool, setActiveKeyTool] = useState('brush');
  const [swipeDragPx, setSwipeDragPx] = useState(0);
  const [isDraggingKey, setIsDraggingKey] = useState(false);
  const [hasClearedBackup, setHasClearedBackup] = useState(false);
  const [originStatus, setOriginStatus] = useState({
    originBlocked: false,
    originVisible: true,
    reason: ''
  });
  const [drawActivity, setDrawActivity] = useState(() => resolveInitialDrawActivity(initialDraft));

  const draftMeshMapRef = useRef(new Map());
  const draftUnitGeoRef = useRef(null);
  const draftMatCacheRef = useRef(new Map());
  const surfaceAnchorRef = useRef(initialDraft.surfaceAnchor || null);
  const artTransformRef = useRef(artTransform);
  const transformPivotRef = useRef(transformPivot);
  const activeKeyToolRef = useRef('brush');
  const originStatusRef = useRef(originStatus);
  const voxelsRef = useRef(voxels);
  const userRef = useRef(user);
  userRef.current = user;
  const lastDrawAtRef = useRef(drawActivity.lastDrawAt);
  const drawLocationRef = useRef(drawActivity.drawLocation);
  const refreshLocationNowRef = useRef(refreshLocationNow);
  refreshLocationNowRef.current = refreshLocationNow;
  const onAutoEraseStaleDrawingRef = useRef(onAutoEraseStaleDrawing);
  onAutoEraseStaleDrawingRef.current = onAutoEraseStaleDrawing;
  const onResetSpatialOriginRef = useRef(onResetSpatialOrigin);
  onResetSpatialOriginRef.current = onResetSpatialOrigin;
  const modeRef = useRef(mode);
  const toolRef = useRef(tool);
  const blockSizeRef = useRef(blockSize);
  const colorRef = useRef(color);
  const materialRef = useRef(material);
  const reachRef = useRef(reachMeters);
  const occlusionEnabledRef = useRef(occlusionEnabled);
  const paintingRef = useRef(false);
  const strokeDeviceOriginRef = useRef(null);
  const lastPaintPosRef = useRef(null);
  const lastStackAtRef = useRef(0);
  const lastErasedKeyRef = useRef({ key: '', ts: 0 });
  const clearedBackupRef = useRef(null);
  const lastPrereqNotifyRef = useRef({ toolId: '', msg: '', ts: 0 });
  const lastItemBlockNotifyRef = useRef({ msg: '', ts: 0 });
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
  const activeGizmoHandleRef = useRef(null);

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

  const markDrawActivity = useCallback(
    ({ locationOverride = null, nowMs = Date.now(), preserveTimestamp = false, forceState = false } = {}) => {
      const nextTs =
        preserveTimestamp && lastDrawAtRef.current
          ? lastDrawAtRef.current
          : Number.isFinite(Number(nowMs))
            ? Number(nowMs)
            : Date.now();
      const nextLoc =
        normalizeDrawLocation(locationOverride || locationRef?.current) ||
        drawLocationRef.current ||
        null;
      lastDrawAtRef.current = nextTs;
      drawLocationRef.current = nextLoc;
      setDrawActivity((prev) => {
        const locChanged =
          Boolean(prev.drawLocation) !== Boolean(nextLoc) ||
          (prev.drawLocation &&
            nextLoc &&
            (Math.abs(prev.drawLocation.lat - nextLoc.lat) > 1e-6 ||
              Math.abs(prev.drawLocation.lng - nextLoc.lng) > 1e-6));
        const tsDelta = prev.lastDrawAt ? Math.abs(nextTs - prev.lastDrawAt) : Infinity;
        if (!forceState && !locChanged && tsDelta < 1000) {
          return prev;
        }
        return { lastDrawAt: nextTs, drawLocation: nextLoc };
      });
    },
    [locationRef]
  );

  const clearDrawActivity = useCallback(() => {
    lastDrawAtRef.current = null;
    drawLocationRef.current = null;
    setDrawActivity((prev) =>
      prev.lastDrawAt === null && prev.drawLocation === null
        ? prev
        : { lastDrawAt: null, drawLocation: null }
    );
  }, []);

  const effectiveCalibrationReady =
    typeof calibrationReady === 'boolean'
      ? calibrationReady
      : Boolean(sceneScan?.optimal ?? true);
  const calibrationReadyRef = useRef(effectiveCalibrationReady);
  calibrationReadyRef.current = effectiveCalibrationReady;
  const calibrationBlockReasonRef = useRef(calibrationBlockReason);
  calibrationBlockReasonRef.current =
    calibrationBlockReason || 'Finish calibrating AR space before adding art.';
  const onRequireCalibrationRef = useRef(onRequireCalibration);
  onRequireCalibrationRef.current = onRequireCalibration;

  const hasVoxels = voxels.length > 0;
  const hasDraftArt = hasVoxels || Boolean(hasPlacedCatalogItem);
  const hasPlacedCatalogRef = useRef(Boolean(hasPlacedCatalogItem));
  hasPlacedCatalogRef.current = Boolean(hasPlacedCatalogItem);
  const onCommitCatalogTransformRef = useRef(onCommitCatalogTransform);
  onCommitCatalogTransformRef.current = onCommitCatalogTransform;
  const onClearCatalogItemRef = useRef(onClearCatalogItem);
  onClearCatalogItemRef.current = onClearCatalogItem;

  const toolAvailability = useMemo(() => {
    const originBlocked = Boolean(originStatus.originBlocked);
    const originMsg =
      originStatus.reason ||
      'View blocked. Move object away from camera.';
    const calBlocked = !effectiveCalibrationReady;
    const calMsg =
      calibrationBlockReason || 'Finish calibrating AR space before adding art.';
    const hasLoc = Boolean(location);
    const needBlocksMsg = 'Draw at least 1 block or place a 3D item first.';
    const locationNeededMsg = describeLocationNeededAction();
    const cameraNeededMsg = describeCameraNeededAction();

    let publishReason = '';
    const publishNeedsAuth = hasDraftArt && !user;
    if (!hasDraftArt) {
      publishReason = needBlocksMsg;
    } else if (!user) {
      // Allow tapping/selecting Publish when drawn & logged out so Google Sign-In pops up immediately
      publishReason = '';
    } else if (!hasLoc) {
      publishReason = locationNeededMsg;
    } else if (!cameraReady) {
      publishReason = cameraNeededMsg;
    } else if (calBlocked || !sceneScan?.optimal) {
      publishReason = calBlocked
        ? calMsg
        : `Scan space to 100% (${sceneScan.scannedCount}/${sceneScan.targetCount}). Pan phone around.`;
    }

    return {
      brush: {
        usable: !calBlocked && !originBlocked,
        reason: calBlocked ? calMsg : originBlocked ? originMsg : '',
        needsCalibration: calBlocked
      },
      pencil: {
        usable: !calBlocked && !originBlocked,
        reason: calBlocked ? calMsg : originBlocked ? originMsg : '',
        needsCalibration: calBlocked
      },
      stack: {
        usable: !calBlocked && !originBlocked && hasVoxels,
        reason: calBlocked ? calMsg : originBlocked ? originMsg : !hasVoxels ? 'Draw at least 1 block first.' : '',
        needsCalibration: calBlocked
      },
      erase: {
        usable: true,
        reason: ''
      },
      clear: {
        usable: hasDraftArt,
        reason: !hasDraftArt ? 'Nothing to clear yet.' : ''
      },
      transform: {
        usable: hasDraftArt || mode === 'transform',
        reason: !hasDraftArt && mode !== 'transform' ? needBlocksMsg : ''
      },
      undo: {
        usable: hasVoxels || hasClearedBackup,
        reason: !hasVoxels && !hasClearedBackup ? 'Nothing to undo yet.' : ''
      },
      palette: {
        usable: mode === 'draw',
        reason: mode !== 'draw' ? 'Switch to Draw mode for colors.' : ''
      },
      occlusion: {
        usable: cameraReady,
        reason: !cameraReady ? cameraNeededMsg : ''
      },
      preview: {
        usable: hasLoc,
        reason: !hasLoc ? locationNeededMsg : ''
      },
      agent: {
        usable: hasLoc,
        reason: !hasLoc ? locationNeededMsg : ''
      },
      publish: {
        usable: !publishReason,
        reason: publishReason,
        needsAuth: publishNeedsAuth,
        needsCalibration: Boolean(hasDraftArt && user && hasLoc && cameraReady && calBlocked)
      },
      recenter: { usable: true, reason: '' },
      drafts: { usable: true, reason: '' },
      search: { usable: true, reason: '' },
      pair: { usable: true, reason: '' }
    };
  }, [
    effectiveCalibrationReady,
    calibrationBlockReason,
    originStatus.originBlocked,
    originStatus.reason,
    hasVoxels,
    hasDraftArt,
    hasClearedBackup,
    location,
    cameraReady,
    sceneScan?.optimal,
    sceneScan?.scannedCount,
    sceneScan?.targetCount,
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

  const getActivePlacedItemColliders = useCallback(() => {
    return collectPlacedItemColliders(nearbyGroupRef?.current, {
      excludeSculptureId: editingSculptureIdRef?.current || '',
      voxelStep: VOXEL_STEP
    });
  }, [editingSculptureIdRef, nearbyGroupRef]);

  const notifyBlockedByPlacedItem = useCallback(
    (hit) => {
      if (!hit) return;
      const itemLabel = String(hit.title || 'existing art').trim() || 'existing art';
      const msg =
        hit.reason === 'occluded' || hit.reason === 'pierce'
          ? `Can't draw through "${itemLabel}" — paint around existing art on this land.`
          : `Space occupied by "${itemLabel}" — paint beside existing art on this land.`;
      const now = Date.now();
      if (
        lastItemBlockNotifyRef.current.msg === msg &&
        now - lastItemBlockNotifyRef.current.ts < 1400
      ) {
        return;
      }
      lastItemBlockNotifyRef.current = { msg, ts: now };
      showTemporaryHint(msg);
    },
    [showTemporaryHint]
  );

  const reconcileAutoSurfaceAnchor = useCallback(
    (anchorPoint) => {
      if (surfaceAnchorRef.current || !anchorPoint) return;
      const ax = Number(anchorPoint.x);
      const ay = Number(anchorPoint.y);
      const az = Number(anchorPoint.z);
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return;
      const camPos = cameraRef?.current?.position;
      let nx = 0;
      let ny = 1;
      let nz = 0;
      let depthM = Number(reachRef.current) || 1.8;
      if (camPos && Number.isFinite(Number(camPos.x))) {
        const dx = camPos.x - ax;
        const dy = camPos.y - ay;
        const dz = camPos.z - az;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 0.05) {
          depthM = Number(Math.max(0.5, Math.min(12, dist)).toFixed(2));
          const horiz = Math.hypot(dx, dz);
          if (horiz > 0.1) {
            nx = dx / horiz;
            ny = 0;
            nz = dz / horiz;
          }
        }
      }
      const nextAnchor = {
        x: ax,
        y: ay,
        z: az,
        nx,
        ny,
        nz,
        depthM,
        label: 'Auto Surface',
        source: 'auto',
        sharpnessScore: 0.5,
        locked: false
      };
      surfaceAnchorRef.current = nextAnchor;
      setSurfaceAnchor(nextAnchor);
    },
    [cameraRef]
  );

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

      const guardAgainstPlacedItems = (candidate) => {
        if (!candidate || (candidate.action !== 'add' && candidate.action !== 'replace')) {
          return candidate;
        }
        const colliders = getActivePlacedItemColliders();
        if (colliders.length === 0) return candidate;
        const hit = testVoxelAgainstPlacedItems({
          point: candidate,
          voxelScale: candidate.scale ?? activeScale,
          voxelStep: VOXEL_STEP,
          rayOrigin: origin,
          colliders
        });
        if (hit.blocked) {
          return {
            ...candidate,
            action: 'blocked',
            blockedReason: hit.reason,
            blockedByTitle: hit.title
          };
        }
        return candidate;
      };

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
            return guardAgainstPlacedItems({
              action: 'replace',
              replaceExisting: true,
              replacedVoxel: hitVoxel,
              x: hitVoxel.x,
              y: hitVoxel.y,
              z: hitVoxel.z,
              scale: activeScale,
              nearbySlots
            });
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
          return guardAgainstPlacedItems({
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
          });
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
            return guardAgainstPlacedItems({
              action: 'add',
              x: adjSlot.x,
              y: adjSlot.y,
              z: adjSlot.z,
              scale: activeScale,
              adjacentTo: adjSlot.parentVoxel,
              adjacentFace: adjSlot.face,
              nearbySlots: adjSlot.nearbySlots || []
            });
          }
        }
      }

      const anchor = surfaceAnchorRef.current;
      if (anchor && anchor.locked) {
        const normal = new THREE.Vector3(anchor.nx, anchor.ny, anchor.nz).normalize();
        const denom = normal.dot(dir);
        if (Math.abs(denom) > 0.045) {
          const t =
            ((anchor.x - origin.x) * normal.x +
              (anchor.y - origin.y) * normal.y +
              (anchor.z - origin.z) * normal.z) /
            denom;
          if (t >= 0.35 && t <= 12.0) {
            const hitPt = origin
              .clone()
              .addScaledVector(dir, t)
              .addScaledVector(normal, cellStep * 0.5);
            return guardAgainstPlacedItems({
              action: 'add',
              x: snapToVoxelLattice(hitPt.x, VOXEL_STEP, activeScale),
              y: snapToVoxelLattice(hitPt.y, VOXEL_STEP, activeScale),
              z: snapToVoxelLattice(hitPt.z, VOXEL_STEP, activeScale),
              scale: activeScale,
              rawPoint: { x: hitPt.x, y: hitPt.y, z: hitPt.z }
            });
          }
        }
        const fallbackDepth = Math.min(
          12,
          Math.max(0.5, anchor.depthM || reachRef.current)
        );
        const fallbackPt = origin.clone().addScaledVector(dir, fallbackDepth);
        return guardAgainstPlacedItems({
          action: 'add',
          x: snapToVoxelLattice(fallbackPt.x, VOXEL_STEP, activeScale),
          y: snapToVoxelLattice(fallbackPt.y, VOXEL_STEP, activeScale),
          z: snapToVoxelLattice(fallbackPt.z, VOXEL_STEP, activeScale),
          scale: activeScale,
          rawPoint: { x: fallbackPt.x, y: fallbackPt.y, z: fallbackPt.z }
        });
      }

      const clampedReach = Math.min(12, Math.max(0.5, Number(reachRef.current) || 1.8));
      const pt = origin.clone().addScaledVector(dir, clampedReach);
      return guardAgainstPlacedItems({
        action: 'add',
        x: snapToVoxelLattice(pt.x, VOXEL_STEP, activeScale),
        y: snapToVoxelLattice(pt.y, VOXEL_STEP, activeScale),
        z: snapToVoxelLattice(pt.z, VOXEL_STEP, activeScale),
        scale: activeScale,
        rawPoint: { x: pt.x, y: pt.y, z: pt.z }
      });
    },
    [
      cameraRef,
      canvasHostRef,
      draftGroupRef,
      getActivePlacedItemColliders
    ]
  );

  const setArtTransform = useCallback(
    (updater) => {
      const maxHumanSpan =
        config?.policy?.humanMaxDrawSpanMeters || HUMAN_MAX_DRAW_SPAN_METERS;
      const prev = artTransformRef.current || {
        scale: 1,
        rotXDeg: 0,
        rotYDeg: 0,
        rotZDeg: 0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0
      };
      const rawNext = typeof updater === 'function' ? updater(prev) : updater;
      if (!rawNext) return;

      const evalTransformCollision = (candTr) => {
        const colliders = getActivePlacedItemColliders();
        if (!colliders || colliders.length === 0) {
          return { blocked: false, blockedBy: null, penetrationDepth: 0 };
        }
        const candBox = computeCandidateDraftWorldBox({
          draftGroup: draftGroupRef?.current || null,
          placedCatalogItem: placedCatalogItemRef?.current || null,
          voxels: voxelsRef.current || [],
          pivot: transformPivotRef.current,
          artTransform: candTr,
          voxelStep: VOXEL_STEP
        });
        return testBoundingBoxAgainstPlacedItems({
          box: candBox,
          colliders,
          marginMeters: 0.04
        });
      };

      const maxScaleBound = hasPlacedCatalogRef.current ? 2.5 : 2;
      let candidate = {
        scale: Math.max(0.25, Math.min(maxScaleBound, Number(rawNext.scale ?? 1))),
        rotXDeg: Number(rawNext.rotXDeg ?? prev.rotXDeg ?? 0),
        rotYDeg: Number(rawNext.rotYDeg ?? prev.rotYDeg ?? 0),
        rotZDeg: Number(rawNext.rotZDeg ?? prev.rotZDeg ?? 0),
        offsetX: Number(rawNext.offsetX ?? prev.offsetX ?? 0),
        offsetY: Number(rawNext.offsetY ?? prev.offsetY ?? 0),
        offsetZ: Number(rawNext.offsetZ ?? prev.offsetZ ?? 0)
      };

      let clampedForFootprint = false;
      const list = voxelsRef.current || [];
      if (list.length > 0) {
        const reqScale = Math.max(0.25, Math.min(2, candidate.scale));
        const maxAllowedScale = computeMaxHumanDrawScale(list, {
          step: VOXEL_STEP,
          rotYDeg: candidate.rotYDeg,
          rotZDeg: candidate.rotZDeg,
          pivot: transformPivotRef.current,
          maxSpanMeters: maxHumanSpan,
          minScale: 0.25,
          maxScale: 2
        });
        if (reqScale > maxAllowedScale + 1e-4) {
          clampedForFootprint = true;
          candidate = { ...candidate, scale: maxAllowedScale };
        } else {
          candidate = { ...candidate, scale: reqScale };
        }
      }

      let finalNext = candidate;
      let collisionHit = null;
      let collisionCleared = false;

      // Prevent placing, moving, rotating, or scaling sculptures inside other sculptures
      if (modeRef.current === 'transform' && (list.length > 0 || hasPlacedCatalogRef.current)) {
        const nextCol = evalTransformCollision(candidate);
        if (nextCol.blocked) {
          const prevCol = evalTransformCollision(prev);
          if (prevCol.blocked && nextCol.penetrationDepth < prevCol.penetrationDepth - 0.002) {
            // Already overlapping (e.g., async neighbor load): allow moving OUT of overlap
            collisionHit = nextCol.blockedBy;
            finalNext = candidate;
          } else {
            // Try smooth per-axis sliding so the sculpture glides alongside obstacles cleanly
            let slid = null;
            const axisCandidates = [
              { ...prev, offsetX: candidate.offsetX },
              { ...prev, offsetZ: candidate.offsetZ },
              { ...prev, offsetY: candidate.offsetY },
              { ...prev, offsetX: candidate.offsetX, offsetY: candidate.offsetY },
              { ...prev, offsetZ: candidate.offsetZ, offsetY: candidate.offsetY }
            ];
            for (const slide of axisCandidates) {
              const moved =
                Math.abs(slide.offsetX - prev.offsetX) > 1e-4 ||
                Math.abs(slide.offsetY - prev.offsetY) > 1e-4 ||
                Math.abs(slide.offsetZ - prev.offsetZ) > 1e-4;
              if (!moved) continue;
              if (!evalTransformCollision(slide).blocked) {
                slid = slide;
                break;
              }
            }
            collisionHit = nextCol.blockedBy;
            finalNext = slid || prev;
          }
        } else {
          collisionCleared = true;
        }
      }

      artTransformRef.current = finalNext;
      setArtTransformState(finalNext);

      if (collisionHit) {
        setTransformCollision({
          blocked: true,
          sculptureId: collisionHit.sculptureId || '',
          title: collisionHit.title || 'existing art'
        });
        const label = String(collisionHit.title || 'existing art').trim() || 'existing art';
        const msg = `Can't place inside "${label}" — move to an open spot.`;
        const now = Date.now();
        if (
          lastItemBlockNotifyRef.current.msg !== msg ||
          now - lastItemBlockNotifyRef.current.ts >= 1200
        ) {
          lastItemBlockNotifyRef.current = { msg, ts: now };
          showTemporaryHint(msg);
        }
      } else if (collisionCleared) {
        setTransformCollision(null);
      }

      if (clampedForFootprint) {
        showTemporaryHint(
          `Max drawing size is ${HUMAN_MAX_DRAW_SPAN_FEET}ft × ${HUMAN_MAX_DRAW_SPAN_FEET}ft`
        );
      }
    },
    [
      config?.policy?.humanMaxDrawSpanMeters,
      draftGroupRef,
      getActivePlacedItemColliders,
      placedCatalogItemRef,
      showTemporaryHint
    ]
  );

  const applyVoxelBatch = useCallback(
    (targets) => {
      if (!Array.isArray(targets) || targets.length === 0) return;
      if (!calibrationReadyRef.current) {
        onRequireCalibrationRef.current?.();
        showTemporaryHint(calibrationBlockReasonRef.current);
        return;
      }
      const halfSpan = config?.policy?.areaHalfSpanMeters || AREA_HALF_SPAN_METERS;
      const maxHumanSpan =
        config?.policy?.humanMaxDrawSpanMeters || HUMAN_MAX_DRAW_SPAN_METERS;
      const maxVoxels = config?.policy?.maxVoxels || 4096;

      const uniqueAdds = [];
      const seenBatch = new Set();
      let hadOutOfBounds = false;
      let blockedHit = null;
      const placedColliders = getActivePlacedItemColliders();
      const rayOrigin = cameraRef?.current?.position || null;

      for (const t of targets) {
        if (!t) continue;
        if (t.action === 'blocked') {
          if (!blockedHit) {
            blockedHit = {
              reason: t.blockedReason || 'overlap',
              title: t.blockedByTitle || 'existing art'
            };
          }
          continue;
        }
        if (t.action !== 'add' && t.action !== 'replace') continue;
        if (
          Math.abs(t.x) > halfSpan ||
          Math.abs(t.y) > halfSpan ||
          Math.abs(t.z) > halfSpan
        ) {
          hadOutOfBounds = true;
          continue;
        }
        const candScale = normalizeBlockScale(t.scale ?? blockSizeRef.current);
        if (placedColliders.length > 0) {
          const hit = testVoxelAgainstPlacedItems({
            point: t,
            voxelScale: candScale,
            voxelStep: VOXEL_STEP,
            rayOrigin,
            colliders: placedColliders
          });
          if (hit.blocked) {
            if (!blockedHit) blockedHit = hit;
            continue;
          }
        }
        const k = voxelKey(t.x, t.y, t.z);
        if (!seenBatch.has(k)) {
          seenBatch.add(k);
          uniqueAdds.push({
            x: t.x,
            y: t.y,
            z: t.z,
            scale: candScale,
            replaceExisting: Boolean(t.replaceExisting || t.action === 'replace'),
            key: k
          });
        }
      }

      if (blockedHit) {
        notifyBlockedByPlacedItem(blockedHit);
      }

      if (hadOutOfBounds && uniqueAdds.length === 0) {
        setSensorBanner(
          `Drawing size limit reached (${HUMAN_MAX_DRAW_SPAN_FEET}ft × ${HUMAN_MAX_DRAW_SPAN_FEET}ft max)`
        );
        return;
      }
      if (uniqueAdds.length === 0) return;
      if (!surfaceAnchorRef.current) {
        reconcileAutoSurfaceAnchor(uniqueAdds[0]);
      }
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
        let outerMinX = Infinity;
        let outerMaxX = -Infinity;
        let outerMinZ = Infinity;
        let outerMaxZ = -Infinity;

        for (let i = 0; i < prev.length; i += 1) {
          const v = prev[i];
          const vHalf = (VOXEL_STEP * normalizeBlockScale(v.scale ?? 1)) * 0.5;
          existingIndexByKey.set(voxelKey(v.x, v.y, v.z), i);
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
          if (v.z < minZ) minZ = v.z;
          if (v.z > maxZ) maxZ = v.z;
          if (v.x - vHalf < outerMinX) outerMinX = v.x - vHalf;
          if (v.x + vHalf > outerMaxX) outerMaxX = v.x + vHalf;
          if (v.z - vHalf < outerMinZ) outerMinZ = v.z - vHalf;
          if (v.z + vHalf > outerMaxZ) outerMaxZ = v.z + vHalf;
        }

        let nextList = null;
        const additions = [];
        for (const cand of uniqueAdds) {
          const candScale = normalizeBlockScale(cand.scale ?? blockSizeRef.current);
          const candHalf = (VOXEL_STEP * candScale) * 0.5;
          if (existingIndexByKey.has(cand.key)) {
            if (!cand.replaceExisting) continue;
            const idx = existingIndexByKey.get(cand.key);
            const cur = (nextList || prev)[idx];
            if (
              cur &&
              cur.color === colorRef.current &&
              (cur.material || 'matte') === materialRef.current &&
              normalizeBlockScale(cur.scale ?? 1) === candScale
            ) {
              continue;
            }
            const repMinX = Math.min(outerMinX, cand.x - candHalf);
            const repMaxX = Math.max(outerMaxX, cand.x + candHalf);
            const repMinZ = Math.min(outerMinZ, cand.z - candHalf);
            const repMaxZ = Math.max(outerMaxZ, cand.z + candHalf);
            if (
              repMaxX - repMinX > maxHumanSpan + 1e-4 ||
              repMaxZ - repMinZ > maxHumanSpan + 1e-4
            ) {
              limitNotice = `Drawing size limit reached (${HUMAN_MAX_DRAW_SPAN_FEET}ft × ${HUMAN_MAX_DRAW_SPAN_FEET}ft max)`;
              continue;
            }
            outerMinX = repMinX;
            outerMaxX = repMaxX;
            outerMinZ = repMinZ;
            outerMaxZ = repMaxZ;
            if (!nextList) nextList = [...prev];
            nextList[idx] = {
              x: cand.x,
              y: cand.y,
              z: cand.z,
              color: colorRef.current,
              material: materialRef.current,
              scale: candScale
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

          const nOuterMinX = Math.min(outerMinX, cand.x - candHalf);
          const nOuterMaxX = Math.max(outerMaxX, cand.x + candHalf);
          const nOuterMinZ = Math.min(outerMinZ, cand.z - candHalf);
          const nOuterMaxZ = Math.max(outerMaxZ, cand.z + candHalf);

          if (
            nOuterMaxX - nOuterMinX > maxHumanSpan + 1e-4 ||
            nOuterMaxZ - nOuterMinZ > maxHumanSpan + 1e-4
          ) {
            limitNotice = `Drawing size limit reached (${HUMAN_MAX_DRAW_SPAN_FEET}ft × ${HUMAN_MAX_DRAW_SPAN_FEET}ft max)`;
            continue;
          }

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
          outerMinX = nOuterMinX;
          outerMaxX = nOuterMaxX;
          outerMinZ = nOuterMinZ;
          outerMaxZ = nOuterMaxZ;
          existingIndexByKey.set(cand.key, prev.length + additions.length);
          additions.push({
            x: cand.x,
            y: cand.y,
            z: cand.z,
            color: colorRef.current,
            material: materialRef.current,
            scale: candScale
          });
        }

        if (nextList || additions.length > 0) {
          const drawnAt = Date.now();
          const drawnLoc = normalizeDrawLocation(locationRef?.current);
          lastDrawAtRef.current = drawnAt;
          if (drawnLoc) {
            drawLocationRef.current = drawnLoc;
          }
          queueMicrotask(() => {
            markDrawActivity({ nowMs: drawnAt, locationOverride: drawnLoc });
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
              `Drawing size limit reached (${HUMAN_MAX_DRAW_SPAN_FEET}ft × ${HUMAN_MAX_DRAW_SPAN_FEET}ft max)`
          );
        });
      }
    },
    [
      cameraRef,
      config?.policy?.areaHalfSpanMeters,
      config?.policy?.humanMaxDrawSpanMeters,
      config?.policy?.maxVoxels,
      getActivePlacedItemColliders,
      locationRef,
      markDrawActivity,
      notifyBlockedByPlacedItem,
      reconcileAutoSurfaceAnchor,
      setSensorBanner,
      showTemporaryHint
    ]
  );

  const eraseTargetVoxel = useCallback(
    (target) => {
      if (!target || target.action !== 'erase' || !target.voxel) return false;
      const killKey = voxelKey(target.voxel.x, target.voxel.y, target.voxel.z);
      const now = performance.now();
      if (lastErasedKeyRef.current.key === killKey && now - lastErasedKeyRef.current.ts < 85) {
        return false;
      }
      lastErasedKeyRef.current = { key: killKey, ts: now };
      setVoxels((prev) => {
        const next = prev.filter((v) => voxelKey(v.x, v.y, v.z) !== killKey);
        if (next.length !== prev.length && next.length > 0) {
          const editedAt = Date.now();
          const editedLoc = normalizeDrawLocation(locationRef?.current);
          lastDrawAtRef.current = editedAt;
          if (editedLoc) {
            drawLocationRef.current = editedLoc;
          }
          queueMicrotask(() => {
            markDrawActivity({ nowMs: editedAt, locationOverride: editedLoc });
          });
        }
        return next;
      });
      return true;
    },
    [locationRef, markDrawActivity]
  );

  const applyVoxelAction = useCallback(
    (target) => {
      if (!target) return;
      if (target.action === 'erase') {
        eraseTargetVoxel(target);
        return;
      }
      if (target.action === 'blocked') {
        notifyBlockedByPlacedItem({
          reason: target.blockedReason || 'overlap',
          title: target.blockedByTitle || 'existing art'
        });
        return;
      }
      if (target.action === 'add' || target.action === 'replace') {
        if (!calibrationReadyRef.current) {
          onRequireCalibrationRef.current?.();
          showTemporaryHint(calibrationBlockReasonRef.current);
          return;
        }
        applyVoxelBatch([target]);
      }
    },
    [
      applyVoxelBatch,
      eraseTargetVoxel,
      notifyBlockedByPlacedItem,
      showTemporaryHint
    ]
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
    const radX = THREE.MathUtils.degToRad(artTransform.rotXDeg || 0);
    const radY = THREE.MathUtils.degToRad(artTransform.rotYDeg || 0);
    const radZ = THREE.MathUtils.degToRad(artTransform.rotZDeg || 0);
    const pivotVec = new THREE.Vector3(transformPivot.x, transformPivot.y, transformPivot.z);
    const offsetVec = new THREE.Vector3(
      artTransform.offsetX,
      artTransform.offsetY,
      artTransform.offsetZ
    );
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(radX, radY, radZ, 'YXZ'));
    const transformedPivot = pivotVec.clone().multiplyScalar(s).applyQuaternion(quat);

    group.scale.setScalar(s);
    group.quaternion.copy(quat);
    group.position.copy(pivotVec).add(offsetVec).sub(transformedPivot);
    group.updateMatrixWorld(true);

    if (cage) {
      if (voxels.length > 0 || hasPlacedCatalogItem) {
        const nextBox = new THREE.Box3().setFromObject(group);
        if (cage.isObjectTransformGizmo && typeof cage.updateFromBox === 'function') {
          cage.updateFromBox(nextBox, {
            activeHandle: activeGizmoHandle,
            colliding: Boolean(transformCollision?.blocked)
          });
        } else {
          cage.box?.copy?.(nextBox);
          cage.visible = !nextBox.isEmpty();
          if (cage.material?.color?.setHex) {
            cage.material.color.setHex(transformCollision?.blocked ? 0xff3e7f : 0x00f5d4);
          }
        }
      } else {
        cage.visible = false;
      }
    }
  }, [
    mode,
    artTransform,
    transformPivot,
    transformCollision,
    activeGizmoHandle,
    voxels,
    hasPlacedCatalogItem,
    draftGroupRef,
    transformBoxRef
  ]);

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
    strokeDeviceOriginRef.current = null;
    setPainting(false);
    setToolHolding(false);
    lastPaintPosRef.current = null;
  }, []);

  const resetArtTransformState = useCallback(() => {
    const identity = {
      scale: 1,
      rotXDeg: 0,
      rotYDeg: 0,
      rotZDeg: 0,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0
    };
    artTransformRef.current = identity;
    setArtTransformState(identity);
    setTransformCollision(null);
    activeCanvasPointersRef.current.clear();
    transformPinchRef.current = null;
    activeGizmoHandleRef.current = null;
    setActiveGizmoHandle('');
    if (draftGroupRef.current) {
      draftGroupRef.current.position.set(0, 0, 0);
      draftGroupRef.current.rotation.set(0, 0, 0);
      draftGroupRef.current.scale.set(1, 1, 1);
    }
    if (transformBoxRef.current) {
      transformBoxRef.current.visible = false;
      if (transformBoxRef.current.material?.color?.setHex) {
        transformBoxRef.current.material.color.setHex(0x00f5d4);
      }
    }
  }, [draftGroupRef, transformBoxRef]);

  // Immediately pause active spraying if calibration drops mid-stroke (preserving placed blocks!)
  useEffect(() => {
    if (!effectiveCalibrationReady && (paintingRef.current || canvasSprayingRef.current)) {
      stopBrushPainting();
    }
  }, [effectiveCalibrationReady, stopBrushPainting]);

  const notifyToolUnavailable = useCallback(
    (toolId, reasonOverride = '') => {
      const info = toolAvailabilityRef.current?.[toolId];
      if (info?.needsCalibration) {
        onRequireCalibrationRef.current?.();
      }
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

  const enterTransformMode = useCallback(
    ({ pivotOverride = null, hintOverride = '' } = {}) => {
      stopBrushPainting();
      setPaletteOpen(false);
      occlusionRef.current?.reset?.();
      if (originStatusRef.current?.originBlocked) {
        const clearStatus = { originBlocked: false, originVisible: true, reason: '' };
        originStatusRef.current = clearStatus;
        setOriginStatus(clearStatus);
      }
      const pivot =
        pivotOverride ||
        (voxelsRef.current.length > 0
          ? computeVoxelCentroid(voxelsRef.current)
          : placedCatalogPivotRef?.current || { x: 0, y: 0, z: 0 });
      setTransformPivot(pivot);
      transformPivotRef.current = pivot;
      resetArtTransformState();
      setMode('transform');
      modeRef.current = 'transform';
      showTemporaryHint(
        hintOverride ||
          (voxelsRef.current.length || hasPlacedCatalogRef.current
            ? 'Art locked — drag 3D bars, 2-finger ↕ Z-pivot / ↔ rotate / pinch scale, or use sliders · tap ✅ to draw'
            : 'Transform locked — tap ✅ again to return to drawing mode')
      );
    },
    [placedCatalogPivotRef, resetArtTransformState, showTemporaryHint, stopBrushPainting]
  );

  const commitTransformAndExit = useCallback(
    (nextMode = 'draw', nextTool = null) => {
      const tr = artTransformRef.current;
      const pivot = transformPivotRef.current;
      const hadTransform = modeRef.current === 'transform' && hasNonIdentityTransform(tr);
      const placedColliders = getActivePlacedItemColliders();
      let blockedCommitTitle = '';

      if (hadTransform && hasPlacedCatalogRef.current) {
        const candBox = computeCandidateDraftWorldBox({
          draftGroup: draftGroupRef?.current || null,
          placedCatalogItem: placedCatalogItemRef?.current || null,
          voxels: voxelsRef.current || [],
          pivot,
          artTransform: tr,
          voxelStep: VOXEL_STEP
        });
        const catalogCol = testBoundingBoxAgainstPlacedItems({
          box: candBox,
          colliders: placedColliders,
          marginMeters: 0.04
        });
        if (catalogCol.blocked) {
          blockedCommitTitle = catalogCol.blockedBy?.title || 'existing art';
        } else {
          onCommitCatalogTransformRef.current?.(tr, pivot);
          markDrawActivity({ forceState: true });
        }
      }
      if (hadTransform && voxelsRef.current.length > 0) {
        const maxHumanSpan =
          config?.policy?.humanMaxDrawSpanMeters || HUMAN_MAX_DRAW_SPAN_METERS;
        const maxAllowedScale = computeMaxHumanDrawScale(voxelsRef.current, {
          step: VOXEL_STEP,
          rotYDeg: tr.rotYDeg,
          rotZDeg: tr.rotZDeg || 0,
          pivot,
          maxSpanMeters: maxHumanSpan,
          minScale: 0.25,
          maxScale: 2
        });
        const s = Math.min(tr.scale, maxAllowedScale);
        const quat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            THREE.MathUtils.degToRad(tr.rotXDeg || 0),
            THREE.MathUtils.degToRad(tr.rotYDeg || 0),
            THREE.MathUtils.degToRad(tr.rotZDeg || 0),
            'YXZ'
          )
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
        const footprint = measureVoxelHorizontalFootprint(baked, {
          step: VOXEL_STEP,
          maxSpanMeters: maxHumanSpan
        });
        const collisionCheck = testTransformedVoxelsAgainstPlacedItems({
          voxels: baked,
          voxelStep: VOXEL_STEP,
          colliders: placedColliders
        });
        resetArtTransformState();
        if (collisionCheck.blocked || blockedCommitTitle) {
          showTemporaryHint(
            `Can't move or scale into "${
              collisionCheck.blockedBy?.title || blockedCommitTitle || 'existing art'
            }" on this land`
          );
        } else if (!footprint.exceedsLimit) {
          setVoxels(baked);
          markDrawActivity({ forceState: true });
        } else {
          showTemporaryHint(
            `Max drawing size is ${HUMAN_MAX_DRAW_SPAN_FEET}ft × ${HUMAN_MAX_DRAW_SPAN_FEET}ft`
          );
        }
      } else {
        resetArtTransformState();
        if (blockedCommitTitle) {
          showTemporaryHint(
            `Can't place inside "${blockedCommitTitle}" — reverted to previous open spot.`
          );
        }
      }
      setMode(nextMode);
      modeRef.current = nextMode;
      if (nextTool) {
        setTool(nextTool);
        toolRef.current = nextTool;
      }
      if (nextMode === 'draw' && !blockedCommitTitle) {
        showTemporaryHint('Returned to drawing mode');
      }
    },
    [
      config?.policy?.areaHalfSpanMeters,
      config?.policy?.humanMaxDrawSpanMeters,
      draftGroupRef,
      getActivePlacedItemColliders,
      markDrawActivity,
      placedCatalogItemRef,
      resetArtTransformState,
      showTemporaryHint
    ]
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
    onResetSpatialOriginRef.current?.();
    onClearCatalogItemRef.current?.();
    surfaceAnchorRef.current = null;
    setSurfaceAnchor(null);
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
      markDrawActivity({ forceState: true });
      showTemporaryHint('Cleared canvas restored');
      return;
    }
    setVoxels((p) => p.slice(0, -1));
  }, [ensureToolUsable, markDrawActivity, showTemporaryHint]);

  const eraseStaleDrawingView = useCallback(
    (check) => {
      const hadVisibleContent =
        (voxelsRef.current?.length || 0) > 0 || Boolean(surfaceAnchorRef.current);
      stopBrushPainting();
      clearedBackupRef.current = null;
      setHasClearedBackup(false);
      lastErasedKeyRef.current = { key: '', ts: 0 };
      resetArtTransformState();
      voxelsRef.current = [];
      rebuildDraftMesh([]);
      setVoxels([]);
      surfaceAnchorRef.current = null;
      setSurfaceAnchor(null);
      onResetSpatialOriginRef.current?.();
      clearDrawActivity();
      if (toolRef.current === 'erase' || toolRef.current === 'stack') {
        setTool('brush');
        toolRef.current = 'brush';
      }
      if (modeRef.current === 'transform' || modeRef.current === 'publish') {
        setMode('draw');
        modeRef.current = 'draw';
      }
      onAutoEraseStaleDrawingRef.current?.(check);
      if (hadVisibleContent) {
        showTemporaryHint(
          `Moved over ${STALE_DRAW_ERASE_DISTANCE_FEET}ft with no drawing for ${STALE_DRAW_ERASE_IDLE_MINUTES} min — view cleared.`
        );
      }
    },
    [clearDrawActivity, rebuildDraftMesh, resetArtTransformState, showTemporaryHint, stopBrushPainting]
  );

  const checkStaleDrawErase = useCallback(
    ({ nowMs = Date.now(), locationOverride = null, nudgeGpsIfIdle = false } = {}) => {
      const hasDrawnContent = Boolean(
        (voxelsRef.current?.length || 0) > 0 ||
          surfaceAnchorRef.current ||
          clearedBackupRef.current?.length
      );
      const currentLoc = locationOverride || locationRef?.current || location;
      const check = evaluateStaleDrawErase({
        hasDrawnContent,
        isActivelyDrawing: Boolean(paintingRef.current),
        isPublishing: Boolean(isPublishingRef?.current || modeRef.current === 'publish'),
        lastDrawAt: lastDrawAtRef.current,
        drawLocation: drawLocationRef.current,
        currentLocation: currentLoc,
        nowMs
      });
      if (check.shouldErase) {
        eraseStaleDrawingView(check);
        return check;
      }
      if (
        nudgeGpsIfIdle &&
        hasDrawnContent &&
        !paintingRef.current &&
        !isPublishingRef?.current &&
        lastDrawAtRef.current &&
        nowMs - lastDrawAtRef.current >= STALE_DRAW_ERASE_IDLE_MS
      ) {
        refreshLocationNowRef.current?.({ notifyNearby: false });
      }
      return check;
    },
    [eraseStaleDrawingView, isPublishingRef, location, locationRef]
  );

  const hasAnyDrawnContent =
    voxels.length > 0 || Boolean(hasPlacedCatalogItem) || Boolean(surfaceAnchor) || hasClearedBackup;

  // Keep draw activity anchored to the first valid GPS fix and cleared when canvas is emptied
  useEffect(() => {
    if (!hasAnyDrawnContent) {
      clearDrawActivity();
      return;
    }
    const normLoc = normalizeDrawLocation(location);
    if (!lastDrawAtRef.current) {
      markDrawActivity({ locationOverride: normLoc, forceState: true });
      return;
    }
    if (!drawLocationRef.current && normLoc) {
      markDrawActivity({ locationOverride: normLoc, preserveTimestamp: true, forceState: true });
    }
  }, [clearDrawActivity, hasAnyDrawnContent, location, markDrawActivity]);

  // Evaluate immediately on GPS movement or draw-state changes
  useEffect(() => {
    if (!hasAnyDrawnContent) return;
    checkStaleDrawErase();
  }, [
    checkStaleDrawErase,
    drawActivity.drawLocation,
    drawActivity.lastDrawAt,
    hasAnyDrawnContent,
    location
  ]);

  // Schedule exact 5-minute idle check, periodic fallback, and foreground/resume re-checks
  useEffect(() => {
    if (!hasAnyDrawnContent) return undefined;
    let exactTimer = null;
    const scheduleExact = () => {
      const latestTs = lastDrawAtRef.current || drawActivity.lastDrawAt || Date.now();
      const remainingMs = Math.max(250, STALE_DRAW_ERASE_IDLE_MS - (Date.now() - latestTs) + 50);
      exactTimer = setTimeout(() => {
        const res = checkStaleDrawErase({ nudgeGpsIfIdle: true });
        if (!res?.shouldErase && lastDrawAtRef.current) {
          const left = STALE_DRAW_ERASE_IDLE_MS - (Date.now() - lastDrawAtRef.current);
          if (left > 0 && left <= 2000) {
            exactTimer = setTimeout(() => {
              checkStaleDrawErase({ nudgeGpsIfIdle: true });
            }, left + 50);
          }
        }
      }, remainingMs);
    };
    scheduleExact();

    const pollTimer = setInterval(() => {
      checkStaleDrawErase({ nudgeGpsIfIdle: true });
    }, 15000);

    const onResumeCheck = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      checkStaleDrawErase({ nudgeGpsIfIdle: true });
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onResumeCheck);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', onResumeCheck);
      window.addEventListener('focus', onResumeCheck);
    }

    return () => {
      clearTimeout(exactTimer);
      clearInterval(pollTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onResumeCheck);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', onResumeCheck);
        window.removeEventListener('focus', onResumeCheck);
      }
    };
  }, [checkStaleDrawErase, drawActivity.lastDrawAt, hasAnyDrawnContent]);

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
        'View blocked. Move object away from camera.';
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
      const camPos = cameraRef?.current?.position;
      strokeDeviceOriginRef.current =
        camPos && Number.isFinite(Number(camPos.x))
          ? { x: Number(camPos.x), y: Number(camPos.y), z: Number(camPos.z) }
          : null;
      setPainting(true);
      setToolHolding(true);
      if (holdTool === 'brush') {
        navigator.vibrate?.(6);
      }
      const t = computeTargetVoxel(true);
      if (holdTool === 'erase') {
        eraseTargetVoxel(t);
      } else if (t && t.action === 'blocked') {
        lastPaintPosRef.current = null;
        notifyBlockedByPlacedItem({
          reason: t.blockedReason || 'overlap',
          title: t.blockedByTitle || 'existing art'
        });
      } else if (t && (t.action === 'add' || t.action === 'replace')) {
        lastPaintPosRef.current = { x: t.x, y: t.y, z: t.z };
        lastStackAtRef.current = performance.now();
        applyVoxelBatch([t]);
      }
    },
    [
      applyVoxelBatch,
      assertOriginUnblockedForPaint,
      cameraRef,
      commitTransformAndExit,
      computeTargetVoxel,
      ensureToolUsable,
      enterFullscreen,
      eraseTargetVoxel,
      notifyBlockedByPlacedItem
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
        const prevTool = toolRef.current;
        if (modeRef.current === 'transform') {
          commitTransformAndExit('draw', toolId);
        } else {
          setMode('draw');
          setTool(toolId);
          toolRef.current = toolId;
        }
        if (!silent && toolId === 'brush' && prevTool !== 'brush') {
          onFirstBrushUseRef.current?.();
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
        toolId === 'search' ||
        toolId === 'occlusion' ||
        toolId === 'pair' ||
        toolId === 'agent' ||
        toolId === 'publish'
      ) {
        if (modeRef.current === 'transform') {
          commitTransformAndExit('draw');
        } else if (!(toolId === 'publish' && modeRef.current === 'publish')) {
          setMode('draw');
        }
        if (
          toolId === 'publish' &&
          !silent &&
          (voxelsRef.current.length > 0 || hasPlacedCatalogRef.current) &&
          !userRef.current
        ) {
          markModalOpenedFromPointerUp();
          openPublishSheetRef?.current?.();
        }
      }
    },
    [commitTransformAndExit, enterTransformMode, notifyToolUnavailable, openPublishSheetRef]
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
    const curTool = activeKeyToolRef.current;
    const isModalTool =
      curTool === 'publish' ||
      curTool === 'drafts' ||
      curTool === 'search' ||
      curTool === 'pair' ||
      curTool === 'agent';
    // Never request fullscreen right as a form modal opens (Android Chrome immediately exits
    // fullscreen on keyboard focus and causes viewport/backdrop glitches).
    if (!isModalTool) {
      enterFullscreen();
    }
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
    } else if (curTool === 'search') {
      openCatalogSearchRef?.current?.();
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
    openCatalogSearchRef,
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
      if (
        targetRel === 0 &&
        (curTool === 'brush' || curTool === 'stack' || curTool === 'pencil' || curTool === 'erase')
      ) {
        setToolHolding(true);
        if (curTool === 'brush' || curTool === 'stack' || curTool === 'erase') {
          const holdDelayMs = curTool === 'brush' ? 75 : 135;
          paintHoldTimerRef.current = setTimeout(() => {
            if (!keyGestureRef.current.active || keyGestureRef.current.swiped) return;
            keyGestureRef.current.holdStarted = true;
            startContinuousHoldTool(curTool);
          }, holdDelayMs);
        }
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

      if (!g.swiped && Math.abs(e.clientX - g.startX) >= 12) {
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
            const landedTool = activeKeyToolRef.current;
            const landedAvail = toolAvailabilityRef.current?.[landedTool];
            if (landedAvail && !landedAvail.usable) {
              notifyToolUnavailable(landedTool, landedAvail.reason);
            } else if (
              landedTool === 'publish' &&
              voxelsRef.current.length > 0 &&
              !userRef.current
            ) {
              e.preventDefault?.();
              markModalOpenedFromPointerUp();
              openPublishSheetRef?.current?.();
            }
          }
        } else if (movedPx < 16) {
          if (targetRel !== 0) {
            stepKeyTool(targetRel, { visibleTools });
          } else {
            const curTool = activeKeyToolRef.current;
            if (
              curTool === 'publish' ||
              curTool === 'drafts' ||
              curTool === 'search' ||
              curTool === 'pair' ||
              curTool === 'agent'
            ) {
              e.preventDefault?.();
              markModalOpenedFromPointerUp();
            }
            triggerActiveKeyTool();
          }
        }
      }
    },
    [notifyToolUnavailable, openPublishSheetRef, stepKeyTool, stopBrushPainting, triggerActiveKeyTool]
  );

  const handleKeyPointerCancel = useCallback(() => {
    keyGestureRef.current.active = false;
    keyGestureRef.current.swiped = false;
    keyGestureRef.current.holdStarted = false;
    setIsDraggingKey(false);
    setSwipeDragPx(0);
    stopBrushPainting();
  }, [stopBrushPainting]);

  const unlockSurfaceAnchor = useCallback(
    ({ silent = false } = {}) => {
      const hadLock = Boolean(surfaceAnchorRef.current?.locked);
      surfaceAnchorRef.current = null;
      setSurfaceAnchor(null);
      if (hadLock && !silent) {
        showTemporaryHint('Draw location unlocked — aim & hold circle to lock a new spot');
      }
      return hadLock;
    },
    [showTemporaryHint]
  );

  const selectSurfaceAtScreenPoint = useCallback(
    (clientX, clientY, { silent = false } = {}) => {
      if (!calibrationReadyRef.current) {
        onRequireCalibrationRef.current?.();
        showTemporaryHint(calibrationBlockReasonRef.current);
        return null;
      }
      const host = canvasHostRef.current;
      const cam = cameraRef.current;
      if (!host || !cam) return null;

      cam.updateMatrixWorld?.(true);
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
        const depthM = Math.max(0.45, Math.min(12, hit.distance));
        const anchorPt =
          hit.distance > 12
            ? origin.clone().addScaledVector(dir, depthM)
            : hit.point;
        const roundedDepth = Number(depthM.toFixed(2));
        const nextAnchor = {
          x: anchorPt.x,
          y: anchorPt.y,
          z: anchorPt.z,
          nx: worldNormal.x,
          ny: worldNormal.y,
          nz: worldNormal.z,
          depthM: roundedDepth,
          label: 'Sculpture Face',
          source: 'voxel',
          sharpnessScore: 1,
          locked: true
        };
        reachRef.current = roundedDepth;
        setReachMeters(roundedDepth);
        surfaceAnchorRef.current = nextAnchor;
        setSurfaceAnchor(nextAnchor);
        if (!lastDrawAtRef.current) {
          markDrawActivity({ preserveTimestamp: true, forceState: true });
        }
        if (!silent) {
          showTemporaryHint(`Locked to sculpture face (${depthM.toFixed(1)}m)`);
        }
        return nextAnchor;
      }

      const patch = polRef.current?.analyzeSurfacePatch?.(normX, normY);
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
        depthM = Math.max(0.75, Math.min(12, 1.25 / -dir.y));
      } else if (dir.y < -0.12) {
        label = 'Table / Ledge';
        nx = 0;
        ny = 1;
        nz = 0;
        depthM = Math.max(0.7, Math.min(12, 0.65 / -dir.y));
      } else if (sharpness >= 0.22) {
        label = 'Wall / Surface';
        const horizLen = Math.hypot(dir.x, dir.z);
        if (horizLen > 0.15) {
          nx = -dir.x / horizLen;
          ny = 0;
          nz = -dir.z / horizLen;
        }
        depthM = Math.max(0.85, Math.min(12, 2.2 - sharpness * 0.7));
      } else {
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        depthM = Math.max(0.5, Math.min(12, depthM));
      }

      const pt = origin.addScaledVector(dir, depthM);
      const roundedDepth = Number(depthM.toFixed(2));
      const nextAnchor = {
        x: pt.x,
        y: pt.y,
        z: pt.z,
        nx,
        ny,
        nz,
        depthM: roundedDepth,
        label,
        source: 'surface',
        sharpnessScore: Number(sharpness.toFixed(2)),
        locked: true
      };
      reachRef.current = roundedDepth;
      setReachMeters(roundedDepth);
      surfaceAnchorRef.current = nextAnchor;
      setSurfaceAnchor(nextAnchor);
      if (!lastDrawAtRef.current) {
        markDrawActivity({ preserveTimestamp: true, forceState: true });
      }
      if (!silent) {
        showTemporaryHint(`Locked at ${label} (${depthM.toFixed(1)}m)`);
      }
      return nextAnchor;
    },
    [
      cameraRef,
      canvasHostRef,
      draftGroupRef,
      markDrawActivity,
      polRef,
      setReachMeters,
      showTemporaryHint
    ]
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

  const drawAtCenter = useCallback(() => {
    const curTool = toolRef.current === 'pencil' ? 'pencil' : 'brush';
    if (!ensureToolUsable(curTool)) return false;
    if (!assertOriginUnblockedForPaint()) return false;
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw', curTool);
    } else if (modeRef.current !== 'draw') {
      setMode('draw');
      modeRef.current = 'draw';
    }
    const target = computeTargetVoxel(false, null);
    if (!target) return false;
    applyVoxelAction(target);
    return true;
  }, [
    applyVoxelAction,
    assertOriginUnblockedForPaint,
    commitTransformAndExit,
    computeTargetVoxel,
    ensureToolUsable
  ]);

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
          activeGizmoHandleRef.current = null;
          setActiveGizmoHandle('');
          const pts = Array.from(activeCanvasPointersRef.current.values());
          transformPinchRef.current = captureTwoFingerFrame(pts);
        } else {
          transformPinchRef.current = null;
          // Raycast against interactive Land-style 3D gizmo bars & corner orbs
          const gizmo = transformBoxRef.current;
          const host = canvasHostRef.current;
          const cam = cameraRef.current;
          const interactive = gizmo?.getInteractiveMeshes?.();
          if (gizmo?.visible && host && cam && Array.isArray(interactive) && interactive.length > 0) {
            const rect = host.getBoundingClientRect();
            const ndc = new THREE.Vector2(
              ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
              -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
            );
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(ndc, cam);
            const hits = raycaster.intersectObjects(interactive, false);
            const hit = hits.find((h) => h.object?.userData?.gizmoHandle && h.object?.userData?.gizmoAction);
            if (hit) {
              const handleKey = hit.object.userData.gizmoHandle;
              const handleAction = hit.object.userData.gizmoAction;
              activeGizmoHandleRef.current = { key: handleKey, action: handleAction };
              setActiveGizmoHandle(handleKey);
            } else {
              activeGizmoHandleRef.current = null;
              setActiveGizmoHandle('');
            }
          } else {
            activeGizmoHandleRef.current = null;
            setActiveGizmoHandle('');
          }
        }
        return;
      }
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      tapStartRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };

      // Spray-can feel: when calibrated & gyro is active in Brush mode, holding thumb anywhere on
      // the live camera screen starts fluid continuous spraying until finger lifts!
      if (
        calibrationReadyRef.current &&
        modeRef.current === 'draw' &&
        toolRef.current === 'brush' &&
        !isInteractingWithLandRef?.current &&
        (rawOrientationRef.current || webxrActiveRef?.current) &&
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
    [
      cameraRef,
      canvasHostRef,
      isInteractingWithLandRef,
      rawOrientationRef,
      webxrActiveRef,
      startContinuousHoldTool,
      transformBoxRef
    ]
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
        const cam = cameraRef.current;
        const camQuat = cam?.quaternion || new THREE.Quaternion();
        const camPos = cam?.position || new THREE.Vector3();
        if (pointers.size >= 2) {
          const pts = Array.from(pointers.values());
          if (!transformPinchRef.current) {
            transformPinchRef.current = captureTwoFingerFrame(pts);
            return;
          }
          const step = computeTwoFingerTransformStep({
            prevFrame: transformPinchRef.current,
            nextPointers: pts,
            cameraQuaternion: camQuat,
            cameraPosition: camPos,
            pivot: transformPivotRef.current,
            currentTransform: artTransformRef.current,
            minScale: 0.25,
            maxScale: hasPlacedCatalogRef.current ? 2.5 : 2
          });
          transformPinchRef.current = step.nextFrame;
          setArtTransform(step.nextTransform);
        } else if (pointers.size === 1) {
          if (!cam) return;
          const dx = e.clientX - prevPt.x;
          const dy = e.clientY - prevPt.y;
          const grabbedHandle = activeGizmoHandleRef.current;
          const next = grabbedHandle?.action
            ? computeGizmoHandleDragStep({
                handleAction: grabbedHandle.action,
                dx,
                dy,
                cameraQuaternion: camQuat,
                cameraPosition: camPos,
                pivot: transformPivotRef.current,
                currentTransform: artTransformRef.current,
                minScale: 0.25,
                maxScale: hasPlacedCatalogRef.current ? 2.5 : 2
              })
            : computeOneFingerDragStep({
                dx,
                dy,
                cameraQuaternion: camQuat,
                cameraPosition: camPos,
                pivot: transformPivotRef.current,
                currentTransform: artTransformRef.current
              });
          setArtTransform(next);
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
    [cameraRef, fallbackEulerRef, rawOrientationRef, setArtTransform]
  );

  const handleCanvasPointerCancel = useCallback(
    (e) => {
      activeCanvasPointersRef.current.delete(e.pointerId);
      if (activeCanvasPointersRef.current.size < 2) {
        transformPinchRef.current = null;
      }
      if (activeCanvasPointersRef.current.size === 0 && activeGizmoHandleRef.current) {
        activeGizmoHandleRef.current = null;
        setActiveGizmoHandle('');
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
      if (activeCanvasPointersRef.current.size === 0 && activeGizmoHandleRef.current) {
        activeGizmoHandleRef.current = null;
        setActiveGizmoHandle('');
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
          if (
            host &&
            cam &&
            nearbyGroup &&
            nearbyGroup.visible !== false &&
            nearbyGroup.children.length > 0 &&
            onTapArLand
          ) {
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
            if (tapTarget?.action === 'blocked') {
              notifyBlockedByPlacedItem({
                reason: tapTarget.blockedReason || 'overlap',
                title: tapTarget.blockedByTitle || 'existing art'
              });
            } else if (tapTarget && (tapTarget.action === 'add' || tapTarget.action === 'replace')) {
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
      if (!host || !cam || !nearbyGroup || nearbyGroup.visible === false) return;

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
      notifyBlockedByPlacedItem,
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
    toolHolding,
    paintingRef,
    strokeDeviceOriginRef,
    lastPaintPosRef,
    lastStackAtRef,
    surfaceAnchor,
    setSurfaceAnchor,
    surfaceAnchorRef,
    artTransform,
    setArtTransform,
    artTransformRef,
    transformPivot,
    transformCollision,
    activeGizmoHandle,
    activeKeyTool,
    swipeDragPx,
    isDraggingKey,
    hasClearedBackup,
    toolAvailability,
    rebuildDraftMesh,
    getActivePlacedItemColliders,
    notifyBlockedByPlacedItem,
    computeTargetVoxel,
    applyVoxelBatch,
    eraseTargetVoxel,
    applyVoxelAction,
    startContinuousHoldTool,
    stopBrushPainting,
    resetArtTransformState,
    notifyToolUnavailable,
    ensureToolUsable,
    enterTransformMode,
    commitTransformAndExit,
    toggleTransformLock,
    clearCanvas,
    handleUndo,
    drawActivity,
    markDrawActivity,
    checkStaleDrawErase,
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
    unlockSurfaceAnchor,
    seedVoxelAtAnchor,
    drawAtCenter,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerCancel,
    handleCanvasPointerUp
  };
}
