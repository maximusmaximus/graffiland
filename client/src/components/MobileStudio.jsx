import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  parseParcelParamFromLocation,
  resolveLandDisplayName
} from '../../../shared/landVolume.mjs';
import { parseProfileParamFromLocation } from '../../../shared/profileRules.mjs';
import { api } from '../utils/api.js';
import { useInAppBackHistory } from '../utils/inAppHistory.js';
import { setLastKnownUnitLocation } from '../utils/measurementUnits.js';
import {
  describeApiErrorForMobile,
  describeCameraNeededAction,
  describeLocationNeededAction
} from '../utils/permissionMessages.js';
import { buildPendingPreviewSculpture } from '../utils/pendingApprovalPreview.js';
import {
  countUnseenMapItems,
  loadSeenLands,
  markLandSeenInMap,
  normalizeSeenLandKey,
  saveSeenLands
} from '../utils/seenLands.js';
import { recordLastViewedItem, recordUserAction } from '../utils/userHistory.js';
import {
  loadBoolPreference,
  loadLocalDraft,
  saveBoolPreference,
  SPRAY_BRUSH_GUIDE_SEEN_KEY,
  TUTORIAL_SEEN_KEY
} from '../utils/clipboard.js';
import { useARPreview } from '../hooks/useARPreview.js';
import { useChat } from '../hooks/useChat.js';
import { useDrafts } from '../hooks/useDrafts.js';
import { useLandManagement } from '../hooks/useLandManagement.js';
import { usePairing } from '../hooks/usePairing.js';
import { useProofOfLocation } from '../hooks/useProofOfLocation.js';
import { useVoxelBrush } from '../hooks/useVoxelBrush.js';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import LandArchiveModal from './LandArchiveModal.jsx';
import LandManagementModal from './LandManagementModal.jsx';
import { NotificationProvider } from './NotificationCenter.jsx';
import ProfileModal from './ProfileModal.jsx';
import SculptureChatDrawer from './SculptureChatDrawer.jsx';
import SculptureModal from './SculptureModal.jsx';
import {
  AgentHandoffModal,
  PairDesktopMcpModal,
  SavedDraftsModal
} from './studio/AgentPairModals.jsx';
import ARLandGuidanceOverlay from './studio/ARLandGuidanceOverlay.jsx';
import ARLandInspectorPanel, {
  evaluateArLandActionProximity
} from './studio/ARLandInspectorPanel.jsx';
import ARViewportCanvas from './studio/ARViewportCanvas.jsx';
import DrawVolumeMeter from './studio/DrawVolumeMeter.jsx';
import FirstRunTutorialModal from './studio/FirstRunTutorialModal.jsx';
import MobileCatalogSearchModal from './studio/MobileCatalogSearchModal.jsx';
import MobileMapSheet from './studio/MobileMapSheet.jsx';
import MobileParcelVisitView from './studio/MobileParcelVisitView.jsx';
import PublishSculptureModal from './studio/PublishSculptureModal.jsx';
import SceneCoverageWidget from './studio/SceneCoverageWidget.jsx';
import SprayBrushIntroModal from './studio/SprayBrushIntroModal.jsx';
import StudioDockDrawer from './studio/StudioDockDrawer.jsx';
import StudioHudTopBar from './studio/StudioHudTopBar.jsx';
import ToolCarouselBar from './studio/ToolCarouselBar.jsx';
import { loadCustomModelObject } from '../utils/customModelLoader.js';
import { disposeObject3D } from './VoxelEngine3D.js';
import {
  computeRoomPossessionProof,
  generateRoomKeyB64,
  getOrCreateDeviceIdentity,
  saveLocalRoomKey,
  wrapRoomKeyForRecipient,
  wrapRoomKeyWithClue
} from '../utils/chatCrypto.js';

export default function MobileStudio({
  config,
  user,
  onUserUpdate,
  onLogout,
  isWelcomeOpen = false,
  skipTutorialSignal = 0
}) {
  const initialDraftRef = useRef(undefined);
  if (initialDraftRef.current === undefined) {
    initialDraftRef.current = loadLocalDraft() || {};
  }
  const initialDraft = initialDraftRef.current;

  // Shared Scene & DOM Refs
  const occlusionCanvasRef = useRef(null);
  const canvasHostRef = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const draftGroupRef = useRef(null);
  const nearbyGroupRef = useRef(null);
  const ghostMeshRef = useRef(null);
  const shadowPlaneRef = useRef(null);
  const gridHelperRef = useRef(null);
  const surfaceMarkerRef = useRef(null);
  const transformBoxRef = useRef(null);
  const originBeaconMatRef = useRef(null);
  const dirLightRef = useRef(null);
  const hemiLightRef = useRef(null);
  const envUpdaterRef = useRef(null);

  // Studio shell & UI state
  const [dockOpen, setDockOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoInitialTab, setInfoInitialTab] = useState('guide');
  const [archiveOpen, setArchiveOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const p = new URLSearchParams(window.location.search).get('archive');
      return Boolean(p && p !== '0' && p !== 'false');
    } catch {
      return false;
    }
  });
  const [archiveInitialId, setArchiveInitialId] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      const p = new URLSearchParams(window.location.search).get('archive') || '';
      return p && p !== '1' && p !== 'true' ? p : '';
    } catch {
      return '';
    }
  });
  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingPublishAfterLogin, setPendingPublishAfterLogin] = useState(false);
  const pendingPublishAfterLoginRef = useRef(null);
  const [profileHandle, setProfileHandle] = useState(() =>
    parseProfileParamFromLocation(typeof window !== 'undefined' ? window.location.search : '')
  );
  const [tutorialOpen, setTutorialOpen] = useState(
    () => !loadBoolPreference(TUTORIAL_SEEN_KEY, false)
  );
  const [handledSkipSignal, setHandledSkipSignal] = useState(skipTutorialSignal);
  if (skipTutorialSignal !== handledSkipSignal) {
    setHandledSkipSignal(skipTutorialSignal);
    if (skipTutorialSignal > 0 && tutorialOpen) {
      setTutorialOpen(false);
    }
  }
  const [arSelectHint, setArSelectHint] = useState('');
  const [preferredDrawLandId, setPreferredDrawLandId] = useState('');
  const [parcelVisit, setParcelVisit] = useState(null); // { loading, parcel, sculptures, error }
  const [arViewSession, setArViewSession] = useState(null); // { source: 'plot' | 'map', parcel, sculptures }
  const [arInspectorExpanded, setArInspectorExpanded] = useState(false);
  const [sprayBrushGuideOpen, setSprayBrushGuideOpen] = useState(false);
  const [ownedParcelIdsState, setOwnedParcelIdsState] = useState([]);
  const [editingSculptureIdState, setEditingSculptureIdState] = useState('');
  const [fadeOtherItems, setFadeOtherItems] = useState(false);
  const [seenLandsMap, setSeenLandsMap] = useState(() => loadSeenLands());
  const [openPairHubSignal, setOpenPairHubSignal] = useState(null);
  const [notifRefreshBump, setNotifRefreshBump] = useState(0);
  const [catalogSearchOpen, setCatalogSearchOpen] = useState(false);
  const [catalogPlaceBusy, setCatalogPlaceBusy] = useState(false);
  const [placedCatalogItem, setPlacedCatalogItem] = useState(null);
  const placedCatalogItemRef = useRef(null);
  placedCatalogItemRef.current = placedCatalogItem;
  const placedCatalogPivotRef = useRef(null);
  const placedCatalogMeshRef = useRef(null);
  const hintTimerRef = useRef(null);
  const sprayBrushGuideSeenRef = useRef(loadBoolPreference(SPRAY_BRUSH_GUIDE_SEEN_KEY, false));
  const arViewSessionRef = useRef(null);
  arViewSessionRef.current = arViewSession;
  const drawReturnSessionRef = useRef(null);
  const isArViewOnlyRef = useRef(false);
  const mappingPausedRef = useRef(false);
  const editingSculptureIdRef = useRef('');
  const fadeOtherItemsRef = useRef(false);
  fadeOtherItemsRef.current = fadeOtherItems;
  const atmosphericTintRef = useRef(0x9dbcd8);
  const webxrControllerRef = useRef(null);

  const maybeShowSprayBrushGuide = useCallback(() => {
    if (sprayBrushGuideSeenRef.current) return false;
    sprayBrushGuideSeenRef.current = true;
    saveBoolPreference(SPRAY_BRUSH_GUIDE_SEEN_KEY, true);
    setSprayBrushGuideOpen(true);
    return true;
  }, []);

  // Metadata & Publish Form State
  const [title, setTitle] = useState(initialDraft.title || '');
  const [description, setDescription] = useState(initialDraft.description || '');
  const [cluePrompt, setCluePrompt] = useState(initialDraft.cluePrompt || '');
  const [clueAnswer, setClueAnswer] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const isPublishingRef = useRef(false);
  isPublishingRef.current = publishing;
  const [publishError, setPublishError] = useState('');
  const [mintReceipt, setMintReceipt] = useState(null);
  const [activeQuest, setActiveQuest] = useState(null);
  const [selectedPlinthSlot, setSelectedPlinthSlot] = useState(null);

  const [canTouch, setCanTouch] = useState(() => {
    if (typeof window === 'undefined') return true;
    const coarse = window.matchMedia?.('(any-pointer: coarse), (pointer: coarse)')?.matches;
    return Boolean(coarse || navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
  });

  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    const syncTouch = () => {
      const hasTouch = Boolean(
        mq?.matches || ('ontouchstart' in window && navigator.maxTouchPoints > 0)
      );
      setCanTouch(hasTouch);
    };
    const onTouchStart = () => setCanTouch(true);
    syncTouch();
    mq?.addEventListener?.('change', syncTouch);
    window.addEventListener('touchstart', onTouchStart, { passive: true, once: true });
    return () => {
      mq?.removeEventListener?.('change', syncTouch);
      window.removeEventListener('touchstart', onTouchStart);
      clearTimeout(hintTimerRef.current);
    };
  }, []);

  const showTemporaryHint = useCallback((msg) => {
    setArSelectHint(msg);
    clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setArSelectHint(''), 4200);
  }, []);

  const onLocationUpdateBridgeRef = useRef(null);
  const onCameraRefreshedBridgeRef = useRef(null);
  const onNetworkReconnectBridgeRef = useRef(null);

  const pol = useProofOfLocation({
    user,
    dirLightRef,
    onLocationUpdate: (loc, refined) => onLocationUpdateBridgeRef.current?.(loc, refined),
    onCameraRefreshed: (meta) => onCameraRefreshedBridgeRef.current?.(meta),
    onNetworkReconnect: () => onNetworkReconnectBridgeRef.current?.(),
    mappingPausedRef
  });

  useEffect(() => {
    if (pol.location) {
      setLastKnownUnitLocation(pol.location);
    }
  }, [pol.location]);

  // Refs bridging actions between circularly-related hooks cleanly
  const recenterAimRef = useRef(null);
  const openDraftsSheetRef = useRef(null);
  const openCatalogSearchRef = useRef(null);
  const openPairModalRef = useRef(null);
  const openAgentHandoffRef = useRef(null);
  const openPublishSheetRef = useRef(null);
  const openCameraSelectedChatRef = useRef(null);
  const arPinPreviewRef = useRef(null);

  // Brush & Canvas hook (receives AR + Chat bridges via refs initialized right below)
  const recenterAimCaller = useRef((...a) => recenterAimRef.current?.(...a));
  const openDraftsCaller = useRef((...a) => openDraftsSheetRef.current?.(...a));
  const openCatalogSearchCaller = useRef((...a) => openCatalogSearchRef.current?.(...a));
  const openPairCaller = useRef((...a) => openPairModalRef.current?.(...a));
  const openAgentCaller = useRef((...a) => openAgentHandoffRef.current?.(...a));
  const openPublishCaller = useRef((...a) => openPublishSheetRef.current?.(...a));
  recenterAimRef.current = pol.recenterAim;
  openCatalogSearchRef.current = () => {
    setDockOpen(false);
    setCatalogSearchOpen(true);
  };
  const arTargetedIdRef = useRef('');
  const setArTargetedSculptureBridgeRef = useRef(null);
  const onTapArLandBridgeRef = useRef(null);
  const onAutoEraseStaleDrawingBridgeRef = useRef(null);
  const isInteractingWithLandRef = useRef(false);

  const clearPlacedCatalogItem = useCallback(() => {
    const mesh = placedCatalogMeshRef.current;
    if (mesh) {
      if (mesh.parent) mesh.parent.remove(mesh);
      disposeObject3D(mesh);
      placedCatalogMeshRef.current = null;
    }
    placedCatalogPivotRef.current = null;
    placedCatalogItemRef.current = null;
    setPlacedCatalogItem(null);
  }, []);

  const syncPlacedCatalogMesh = useCallback((nextItem) => {
    const mesh = placedCatalogMeshRef.current;
    if (!mesh || !nextItem) return;
    mesh.position.set(nextItem.pos.x, nextItem.pos.y, nextItem.pos.z);
    mesh.rotation.set(
      0,
      THREE.MathUtils.degToRad(nextItem.rotYDeg || 0),
      THREE.MathUtils.degToRad(nextItem.rotZDeg || 0),
      'YXZ'
    );
    mesh.scale.setScalar(nextItem.scale || 1);
    mesh.updateMatrixWorld(true);
    placedCatalogPivotRef.current = { ...nextItem.pos };
  }, []);

  const handleCommitCatalogTransform = useCallback(
    (tr, pivot) => {
      const cur = placedCatalogItemRef.current;
      if (!cur) return;
      const s = Math.min(20, Math.max(0.1, Number((cur.scale || 1) * (tr.scale || 1))));
      const nextRotY = Number(((cur.rotYDeg || 0) + (tr.rotYDeg || 0)) % 360);
      const nextRotZ = Math.max(-180, Math.min(180, Number((cur.rotZDeg || 0) + (tr.rotZDeg || 0))));
      const pv = pivot || cur.pos || { x: 0, y: 0, z: 0 };
      const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          0,
          THREE.MathUtils.degToRad(tr.rotYDeg || 0),
          THREE.MathUtils.degToRad(tr.rotZDeg || 0),
          'YXZ'
        )
      );
      const delta = new THREE.Vector3(
        cur.pos.x - pv.x,
        cur.pos.y - pv.y,
        cur.pos.z - pv.z
      )
        .multiplyScalar(tr.scale || 1)
        .applyQuaternion(quat);
      const nextPos = {
        x: Number((pv.x + (tr.offsetX || 0) + delta.x).toFixed(3)),
        y: Number((pv.y + (tr.offsetY || 0) + delta.y).toFixed(3)),
        z: Number((pv.z + (tr.offsetZ || 0) + delta.z).toFixed(3))
      };
      const updated = {
        ...cur,
        scale: Number(s.toFixed(3)),
        rotYDeg: Number(nextRotY.toFixed(1)),
        rotZDeg: Number(nextRotZ.toFixed(1)),
        pos: nextPos
      };
      placedCatalogItemRef.current = updated;
      setPlacedCatalogItem(updated);
      syncPlacedCatalogMesh(updated);
    },
    [syncPlacedCatalogMesh]
  );

  useEffect(() => {
    return () => {
      clearPlacedCatalogItem();
    };
  }, [clearPlacedCatalogItem]);

  const brush = useVoxelBrush({
    config,
    initialDraft,
    user,
    location: pol.location,
    locationRef: pol.locationRef,
    cameraReady: pol.cameraReady,
    sceneScan: pol.sceneScan,
    calibrationReady: pol.calibrationReady,
    calibrationBlockReason:
      pol.calibrationLoss?.summary ||
      pol.calibrationReadiness?.subHint ||
      'Calibrate AR space before adding art.',
    onRequireCalibration: () => pol.setScanBoxCollapsed(false),
    polRef: pol.polRef,
    rawOrientationRef: pol.rawOrientationRef,
    fallbackEulerRef: pol.fallbackEulerRef,
    enterFullscreen: pol.enterFullscreen,
    setSensorBanner: pol.setSensorBanner,
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
    setArTargetedSculpture: (v) => setArTargetedSculptureBridgeRef.current?.(v),
    arPinPreview: arPinPreviewRef.current,
    openCameraSelectedChat: (...args) => openCameraSelectedChatRef.current?.(...args),
    onTapArLand: (...args) => onTapArLandBridgeRef.current?.(...args),
    isInteractingWithLandRef,
    recenterAimRef: recenterAimCaller,
    openDraftsSheetRef: openDraftsCaller,
    openCatalogSearchRef: openCatalogSearchCaller,
    openPairModalRef: openPairCaller,
    openAgentHandoffRef: openAgentCaller,
    openPublishSheetRef: openPublishCaller,
    onFirstBrushUse: maybeShowSprayBrushGuide,
    editingSculptureIdRef,
    refreshLocationNow: pol.refreshLocationNow,
    isPublishingRef,
    onAutoEraseStaleDrawing: (info) => onAutoEraseStaleDrawingBridgeRef.current?.(info),
    onResetSpatialOrigin: pol.resetSpatialDrawOrigin,
    hasPlacedCatalogItem: Boolean(placedCatalogItem),
    placedCatalogPivotRef,
    onCommitCatalogTransform: handleCommitCatalogTransform,
    onClearCatalogItem: clearPlacedCatalogItem
  });

  const handlePlaceMobileCatalogItem = useCallback(
    async (item) => {
      if (!item) return;
      if (!pol.calibrationReady) {
        pol.setScanBoxCollapsed(false);
        showTemporaryHint(
          pol.calibrationLoss?.summary ||
            pol.calibrationReadiness?.subHint ||
            'Finish calibrating AR space before placing 3D items.'
        );
        return;
      }
      setCatalogPlaceBusy(true);
      try {
        // Compute natural world placement point in front of camera (or on locked surface anchor)
        let targetPos = { x: 0, y: 0, z: -(brush.reachRef?.current || 1.8) };
        const anchor = brush.surfaceAnchorRef?.current;
        if (anchor && Number.isFinite(Number(anchor.x))) {
          targetPos = {
            x: Number(anchor.x),
            y: Number(anchor.y),
            z: Number(anchor.z)
          };
        } else if (cameraRef.current) {
          const cam = cameraRef.current;
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
          const reach = Number(brush.reachRef?.current || 1.8);
          const pt = cam.position.clone().addScaledVector(forward, reach);
          targetPos = {
            x: Number(pt.x.toFixed(3)),
            y: Number((pt.y - 0.25).toFixed(3)),
            z: Number(pt.z.toFixed(3))
          };
        }

        // Replace any previously staged catalog mesh cleanly (one at a time)
        clearPlacedCatalogItem();

        let loadedObj = null;
        let baseSize = { width: 1, height: 1, depth: 1 };
        try {
          const res = await loadCustomModelObject(
            {
              id: item.id,
              customModel: {
                format: item.modelFormat || 'glb',
                modelUrl: item.modelUrl,
                scale: 1
              }
            },
            { applyCustomScale: false }
          );
          if (res?.object3d) {
            loadedObj = res.object3d;
            if (res.baseSize) baseSize = res.baseSize;
          }
        } catch {
          // Graceful fallback visual marker if headless/offline environment cannot decode GLB
          const fallbackGeo = new THREE.BoxGeometry(0.65, 0.65, 0.65);
          const fallbackMat = new THREE.MeshStandardMaterial({
            color: 0x00f5d4,
            roughness: 0.35,
            metalness: 0.2
          });
          loadedObj = new THREE.Mesh(fallbackGeo, fallbackMat);
          loadedObj.position.y = 0.325;
        }

        // Normalize initial AR placement scale to comfortable ~0.75m size in front of user
        const maxDim = Math.max(0.1, baseSize.width || 1, baseSize.height || 1, baseSize.depth || 1);
        const initialScale = Number(Math.max(0.15, Math.min(2.0, 0.75 / maxDim)).toFixed(3));

        const nextPlaced = {
          id: item.id,
          rawId: item.rawId,
          source: item.source,
          sourceName: item.sourceName,
          title: item.title,
          modelFormat: item.modelFormat || 'glb',
          modelUrl: item.modelUrl,
          previewImageUrl: item.previewImageUrl || null,
          scale: initialScale,
          rotYDeg: 0,
          rotZDeg: 0,
          pos: targetPos,
          baseSize
        };

        if (loadedObj && draftGroupRef.current) {
          const holder = new THREE.Group();
          holder.name = `catalog-placed-${item.id}`;
          holder.add(loadedObj);
          draftGroupRef.current.add(holder);
          placedCatalogMeshRef.current = holder;
        }

        placedCatalogItemRef.current = nextPlaced;
        placedCatalogPivotRef.current = { ...targetPos };
        setPlacedCatalogItem(nextPlaced);
        syncPlacedCatalogMesh(nextPlaced);
        brush.markDrawActivity?.({ forceState: true });

        if (!title.trim() && item.title) {
          setTitle(String(item.title).slice(0, 48));
        }

        setCatalogSearchOpen(false);
        // Automatically switch to Lock & Scale tooling so user can resize/position immediately,
        // then tap ✅ Draw to keep painting or 🚀 Publish to mint!
        brush.enterTransformMode({
          pivotOverride: targetPos,
          hintOverride: `Placed "${item.title}" — scale, rotate or move it, then tap ✅ Draw to paint more or 🚀 Publish!`
        });
      } finally {
        setCatalogPlaceBusy(false);
      }
    },
    [
      brush,
      clearPlacedCatalogItem,
      pol,
      showTemporaryHint,
      syncPlacedCatalogMesh,
      title
    ]
  );

  const focusedArLandId = arViewSession?.parcel?.parcelId || '';

  const ar = useARPreview({
    user,
    ownedParcelIds: ownedParcelIdsState,
    mode: brush.mode,
    location: pol.location,
    locationRef: pol.locationRef,
    cameraReady: pol.cameraReady,
    videoRef: pol.videoRef,
    orbTrackerRef: pol.orbTrackerRef,
    orbKeyframesRef: pol.orbKeyframesRef,
    orbPackCacheRef: pol.orbPackCacheRef,
    latestOrbProofRef: pol.latestOrbProofRef,
    setOrbStatus: pol.setOrbStatus,
    nearbyGroupRef,
    modeRef: brush.modeRef,
    commitTransformAndExit: brush.commitTransformAndExit,
    stopBrushPainting: brush.stopBrushPainting,
    showTemporaryHint,
    focusedLandId: focusedArLandId,
    isArViewOnly: Boolean(arViewSession || brush.mode === 'preview'),
    editingSculptureId: editingSculptureIdState,
    fadeOtherItems,
    atmosphericTintRef,
    orientationFusionRef: pol.orientationFusionRef
  });

  const isInteractingWithLand = Boolean(ar.activeArLand || focusedArLandId);
  const isTransformMode = brush.mode === 'transform';
  const isArViewOnly = Boolean(
    arViewSession || isInteractingWithLand || brush.mode === 'preview'
  );
  isInteractingWithLandRef.current = isInteractingWithLand;
  isArViewOnlyRef.current = isArViewOnly;

  const arExitLabel =
    arViewSession?.source === 'plot'
      ? 'Back'
      : arViewSession?.source === 'map'
      ? 'Back to Map'
      : 'Back to Draw';

  setArTargetedSculptureBridgeRef.current = ar.setArTargetedSculpture;
  arTargetedIdRef.current = ar.arTargetedIdRef.current;

  const markSeenLand = useCallback(
    (parcelId, artCountOverride = null) => {
      const cleanKey = normalizeSeenLandKey(parcelId);
      if (!cleanKey) return;
      let resolvedCount = artCountOverride;
      if (resolvedCount === null || resolvedCount === undefined) {
        const nearbyCount = (ar.nearbySculptures || []).filter(
          (sc) => normalizeSeenLandKey(sc?.parcelId || sc?.parcel_id) === cleanKey
        ).length;
        const mapCount = (ar.mapSculptures || []).filter(
          (sc) => normalizeSeenLandKey(sc?.parcelId || sc?.parcel_id) === cleanKey
        ).length;
        resolvedCount = Math.max(nearbyCount, mapCount);
      }
      setSeenLandsMap((prev) => {
        const next = markLandSeenInMap(prev, cleanKey, { artCount: resolvedCount });
        saveSeenLands(next);
        return next;
      });
    },
    [ar.mapSculptures, ar.nearbySculptures]
  );

  useEffect(() => {
    if (parcelVisit?.parcel?.parcelId) {
      markSeenLand(
        parcelVisit.parcel.parcelId,
        Array.isArray(parcelVisit.sculptures) ? parcelVisit.sculptures.length : null
      );
    }
  }, [markSeenLand, parcelVisit?.parcel?.parcelId, parcelVisit?.sculptures]);

  useEffect(() => {
    if (arViewSession?.parcel?.parcelId) {
      markSeenLand(
        arViewSession.parcel.parcelId,
        Array.isArray(arViewSession.sculptures) ? arViewSession.sculptures.length : null
      );
    }
  }, [arViewSession?.parcel?.parcelId, arViewSession?.sculptures, markSeenLand]);

  useEffect(() => {
    const sc = ar.mapSelectedSculpture;
    if (!sc) return;
    if (sc.parcelId) {
      markSeenLand(sc.parcelId);
    } else if (sc.id) {
      markSeenLand(`SC:${sc.id}`, 1);
    }
  }, [ar.mapSelectedSculpture, markSeenLand]);

  const unseenNearbyMapCount = useMemo(
    () =>
      countUnseenMapItems({
        sculptures: ar.nearbySculptures,
        parcels: ar.nearbyParcels,
        location: pol.location,
        radiusMeters: 300,
        seenMap: seenLandsMap
      }),
    [ar.nearbyParcels, ar.nearbySculptures, pol.location, seenLandsMap]
  );

  const handleInspectArLand = useCallback(
    (land, { expandDetails = false } = {}) => {
      if (!land?.parcelId) {
        ar.setArSelectedLandId('');
        setArInspectorExpanded(false);
        return;
      }
      markSeenLand(land.parcelId, Array.isArray(land.sculptures) ? land.sculptures.length : null);
      brush.stopBrushPainting();
      setDockOpen(false);
      setArInspectorExpanded(Boolean(expandDetails));
      ar.selectArLand(land, land.sculptures || []);
    },
    [ar, brush, markSeenLand]
  );

  const handleExitArLand = useCallback(() => {
    const session = arViewSessionRef.current;
    setArViewSession(null);
    setArInspectorExpanded(false);
    ar.setArSelectedLandId('');
    if (session?.source === 'plot' && session.parcel) {
      setParcelVisit({
        loading: false,
        parcel: session.parcel,
        sculptures: Array.isArray(session.sculptures) ? session.sculptures : [],
        error: ''
      });
    } else if (session?.source === 'map') {
      ar.setMapOpen(true);
    }
  }, [ar]);

  onTapArLandBridgeRef.current = (tappedLand) => {
    if (!tappedLand?.parcelId) {
      // In dedicated View in AR / Find in AR sessions, tapping empty sky must not drop the
      // visitor out of AR land view into the mapping/drawing studio.
      if (arViewSessionRef.current) return;
      ar.setArSelectedLandId('');
      return;
    }
    handleInspectArLand(tappedLand);
  };

  useEffect(() => {
    if (!isInteractingWithLand) return undefined;
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        handleExitArLand();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExitArLand, isInteractingWithLand]);

  onLocationUpdateBridgeRef.current = async (loc, refined) => {
    const [res, pRes] = await Promise.all([
      api.listSculptures({
        lat: loc.lat,
        lng: loc.lng,
        radiusMeters: 300,
        includeVoxels: false
      }),
      api.listParcels().catch(() => ({ parcels: [] }))
    ]);
    if (Array.isArray(pRes?.parcels)) {
      ar.setNearbyParcels(pRes.parcels);
    }
    await ar.hydrateNearbyList(res.sculptures || [], refined);
  };

  onCameraRefreshedBridgeRef.current = () => {
    brush.occlusionRef.current?.reset?.();
    brush.setOriginStatus((prev) =>
      prev?.originBlocked
        ? { ...prev, originBlocked: false, originVisible: true, reason: '' }
        : prev
    );
  };

  onNetworkReconnectBridgeRef.current = () => {
    const loc = pol.locationRef.current;
    if (loc) {
      onLocationUpdateBridgeRef.current?.(loc, loc).catch?.(() => {});
    }
  };

  const parcelsLoadedOnceRef = useRef(false);
  useEffect(() => {
    const loc = pol.location;
    if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) return;
    let cancelled = false;
    api
      .getNearbyQuests({ lat: loc.lat, lng: loc.lng, radiusMeters: 150, status: 'open' })
      .then((res) => {
        if (cancelled) return;
        const firstQuest = res?.quests?.[0] || null;
        setActiveQuest(firstQuest);
      })
      .catch(() => {});
    if (!parcelsLoadedOnceRef.current) {
      parcelsLoadedOnceRef.current = true;
      api
        .listParcels()
        .then((pRes) => {
          if (!cancelled && Array.isArray(pRes?.parcels)) {
            ar.setNearbyParcels(pRes.parcels);
          }
        })
        .catch(() => {
          parcelsLoadedOnceRef.current = false;
        });
    }
    return () => {
      cancelled = true;
    };
  }, [ar, pol.location]);

  const handleSnapToPlinthSlot = useCallback(
    (slot) => {
      if (!slot) return;
      setSelectedPlinthSlot(slot);
      brush.setArtTransform((prev) => ({
        ...prev,
        offsetX: Number(slot.dx || 0),
        offsetY: Number(slot.dy || 0),
        offsetZ: Number(slot.dz || 0),
        rotYDeg: Math.round(((Number(slot.yaw || 0) * 180) / Math.PI) * 10) / 10
      }));
      brush.setSurfaceAnchor({
        label: slot.label || 'AI Plinth',
        depthM: 1.5,
        point: new THREE.Vector3(Number(slot.dx || 0), Number(slot.dy || 0), Number(slot.dz || 0)),
        normal: new THREE.Vector3(0, 1, 0),
        locked: true,
        autoDetected: false
      });
      showTemporaryHint(`Snapped canvas onto plinth "${slot.label}"! Draw & publish 3+ voxels.`);
    },
    [brush, showTemporaryHint]
  );

  // Support deep link ?sculpture=<id> and ?parcel=<GLAND-...>&slug=<slug> directly on mobile
  const { setMapSelectedSculpture } = ar;

  // Record viewed sculptures & visited lands into Profile Last Viewed & Action History
  useEffect(() => {
    const sc = ar.mapSelectedSculpture;
    if (!sc?.id) return;
    const landLabel = resolveLandDisplayName(
      { customName: sc.parcelName || sc.landDisplayName || '', firstSculptureTitle: sc.title || '' },
      { defaultName: 'Virtual Land' }
    );
    recordLastViewedItem(user?.id, {
      kind: 'sculpture',
      id: sc.id,
      sculptureId: sc.id,
      parcelId: sc.parcelId || '',
      title: sc.title || 'Sculpture',
      subtitle: landLabel,
      snapshot: sc
    });
    recordUserAction(user?.id, {
      type: 'view_sculpture',
      icon: '🧊',
      title: `Viewed "${sc.title || 'Sculpture'}"`,
      detail: landLabel,
      sculptureId: sc.id,
      parcelId: sc.parcelId || '',
      linkLabel: 'View'
    });
  }, [ar.mapSelectedSculpture, user?.id]);

  useEffect(() => {
    const parcel = parcelVisit?.parcel;
    if (!parcel?.parcelId) return;
    const title = resolveLandDisplayName(parcel, { defaultName: 'Virtual Land' });
    recordLastViewedItem(user?.id, {
      kind: 'land',
      id: parcel.parcelId,
      parcelId: parcel.parcelId,
      title,
      subtitle: '',
      snapshot: parcel
    });
    recordUserAction(user?.id, {
      type: 'view_land',
      icon: '🗺️',
      title: `Visited land "${title}"`,
      detail: 'Mobile land showcase',
      parcelId: parcel.parcelId,
      linkLabel: 'Land'
    });
  }, [parcelVisit?.parcel, user?.id]);

  useEffect(() => {
    const deepId = new URLSearchParams(window.location.search).get('sculpture');
    if (deepId) {
      api
        .getSculpture(deepId)
        .then((res) => {
          if (res?.sculpture) setMapSelectedSculpture(res.sculpture);
        })
        .catch(() => {});
    }
    const parsedParcel = parseParcelParamFromLocation(
      window.location.search,
      window.location.pathname
    );
    const targetToken = parsedParcel.parcelId || parsedParcel.slug;
    if (targetToken) {
      setParcelVisit({ loading: true, parcel: null, sculptures: [], error: '' });
      api
        .getLandDetail(targetToken)
        .then((res) => {
          setParcelVisit({
            loading: false,
            parcel: res?.parcel || null,
            sculptures: res?.sculptures || [],
            error: res?.parcel ? '' : 'Virtual Land parcel not found.'
          });
        })
        .catch((err) => {
          setParcelVisit({
            loading: false,
            parcel: null,
            sculptures: [],
            error: err?.message || 'Could not load shared Virtual Land parcel.'
          });
        });
    }
  }, [setMapSelectedSculpture]);

  // Refresh open plot showcase details when auth state changes (reveals owner/contributor permissions & hidden artworks)
  const activeVisitParcelId = parcelVisit?.parcel?.parcelId || '';
  useEffect(() => {
    if (!activeVisitParcelId) return undefined;
    let cancelled = false;
    api
      .getLandDetail(activeVisitParcelId)
      .then((res) => {
        if (cancelled || !res?.parcel) return;
        setParcelVisit((prev) =>
          prev?.parcel?.parcelId === activeVisitParcelId
            ? {
                ...prev,
                loading: false,
                parcel: res.parcel,
                sculptures: res.sculptures || [],
                error: ''
              }
            : prev
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeVisitParcelId, user?.id]);

  const chat = useChat({
    user,
    mode: brush.mode,
    arTargetedSculpture: ar.arTargetedSculpture,
    locationRef: pol.locationRef,
    cameraReadyRef: pol.cameraReadyRef,
    polRef: pol.polRef,
    videoRef: pol.videoRef,
    orbPackCacheRef: pol.orbPackCacheRef,
    orbTrackerRef: pol.orbTrackerRef,
    latestOrbProofRef: pol.latestOrbProofRef,
    handleEnrollPasskey: pol.handleEnrollPasskey,
    setArSelectHint,
    showTemporaryHint
  });
  arPinPreviewRef.current = chat.arPinPreview;
  openCameraSelectedChatRef.current = chat.openCameraSelectedChat;

  const captureSculptureSnapshot = useCallback(() => {
    try {
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        if (ghostMeshRef.current) ghostMeshRef.current.visible = false;
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        const url = rendererRef.current.domElement.toDataURL('image/png');
        if (ghostMeshRef.current && brush.modeRef.current === 'draw') {
          ghostMeshRef.current.visible = true;
        }
        return url;
      }
    } catch {
      // ignore snapshot capture error
    }
    return '';
  }, [brush.modeRef]);

  const drafts = useDrafts({
    initialDraft,
    user,
    location: pol.location,
    locationRef: pol.locationRef,
    voxels: brush.voxels,
    voxelsRef: brush.voxelsRef,
    setVoxels: brush.setVoxels,
    title,
    setTitle,
    description,
    setDescription,
    cluePrompt,
    setCluePrompt,
    setClueAnswer,
    color: brush.color,
    material: brush.material,
    reachMeters: brush.reachMeters,
    surfaceAnchor: brush.surfaceAnchor,
    setSurfaceAnchor: brush.setSurfaceAnchor,
    surfaceAnchorRef: brush.surfaceAnchorRef,
    modeRef: brush.modeRef,
    setMode: brush.setMode,
    commitTransformAndExit: brush.commitTransformAndExit,
    stopBrushPainting: brush.stopBrushPainting,
    resetArtTransformState: brush.resetArtTransformState,
    ensureToolUsable: brush.ensureToolUsable,
    captureSculptureSnapshot,
    setSensorBanner: pol.setSensorBanner,
    showTemporaryHint,
    drawActivity: brush.drawActivity,
    markDrawActivity: brush.markDrawActivity
  });
  openAgentHandoffRef.current = drafts.openAgentHandoff;
  openDraftsSheetRef.current = drafts.openDraftsSheet;

  const lands = useLandManagement({
    user,
    mintReceipt,
    voxels: brush.voxels,
    setVoxels: brush.setVoxels,
    setMapOpen: ar.setMapOpen,
    setMapSelectedSculpture: ar.setMapSelectedSculpture,
    setNearbySculptures: ar.setNearbySculptures,
    setMapSculptures: ar.setMapSculptures,
    setMode: brush.setMode,
    setTool: brush.setTool,
    captureSculptureSnapshot,
    showTemporaryHint,
    markDrawActivity: brush.markDrawActivity
  });

  onAutoEraseStaleDrawingBridgeRef.current = () => {
    drafts.discardActiveCanvasDraft();
    clearPlacedCatalogItem();
    setTitle('');
    setDescription('');
    setCluePrompt('');
    setClueAnswer('');
    setSelectedPlinthSlot(null);
    lands.setEditingSculpture(null);
  };

  useEffect(() => {
    const ids = (lands.myLands?.parcels || []).map((p) => p.parcelId).filter(Boolean);
    setOwnedParcelIdsState(ids);
  }, [lands.myLands]);

  useEffect(() => {
    const editId = lands.editingSculpture?.id || '';
    editingSculptureIdRef.current = editId;
    setEditingSculptureIdState(editId);
  }, [lands.editingSculpture?.id]);

  const handleToggleFadeOtherItems = useCallback(() => {
    setFadeOtherItems((prev) => {
      const next = !prev;
      fadeOtherItemsRef.current = next;
      showTemporaryHint(
        next
          ? 'Other art faded — solid collision protection stays active so you never draw through it.'
          : 'Other land art restored to full visibility.'
      );
      return next;
    });
  }, [showTemporaryHint]);

  const handleToggleWebxr = useCallback(async () => {
    const ctrl = webxrControllerRef.current;
    if (!ctrl) {
      showTemporaryHint('6-DoF WebXR is not available on this device.');
      return;
    }
    try {
      if (pol.webxrActiveRef?.current) {
        await ctrl.stop();
        showTemporaryHint('Switched back to True-North multi-sensor AR.');
      } else {
        await ctrl.start();
        showTemporaryHint('✨ 6-DoF ARCore WebXR tracking active!');
      }
    } catch (err) {
      showTemporaryHint(err?.message || 'Could not start 6-DoF WebXR session on this browser.');
    }
  }, [pol.webxrActiveRef, showTemporaryHint]);

  const handleRenameLandSynced = useCallback(
    async (land, nextCustomName) => {
      const res = await api.updateLandParcel(land.parcelId, {
        customName: nextCustomName
      });
      const savedName =
        res?.parcel?.customName !== undefined ? res.parcel.customName : nextCustomName;
      const patch = (prev) =>
        (prev || []).map((p) =>
          p.parcelId === land.parcelId
            ? { ...p, customName: savedName, slug: res?.parcel?.slug || p.slug }
            : p
        );
      ar.setMapParcels(patch);
      ar.setNearbyParcels(patch);
      lands.refreshMyLands();
      ar.loadPublicMapData();
    },
    [ar, lands]
  );

  const activeInsideLand = useMemo(() => {
    const insideLands = (ar.immediateCameraLands || []).filter((l) => l?.isInside);
    if (preferredDrawLandId) {
      const preferred = insideLands.find((l) => l.parcelId === preferredDrawLandId);
      if (preferred) return preferred;
    }
    if (ar.primaryCameraLand?.isInside) return ar.primaryCameraLand;
    return insideLands[0] || null;
  }, [ar.immediateCameraLands, ar.primaryCameraLand, preferredDrawLandId]);

  const openPublishSheet = useCallback(
    ({ skipVoxelCheck = false, userOverride = null } = {}) => {
      const hasAnyArt = Boolean(
        (brush.voxelsRef.current && brush.voxelsRef.current.length > 0) ||
          placedCatalogItemRef.current
      );
      if (!skipVoxelCheck && !hasAnyArt) {
        brush.notifyToolUnavailable('publish', 'Draw at least 1 block or place a 3D item first.');
        return;
      }
      if (activeInsideLand?.isFrozen) {
        brush.notifyToolUnavailable(
          'publish',
          `"${activeInsideLand.displayName || 'This land'}" is frozen by its owner — new art cannot be added here.`
        );
        return;
      }
      const activeUser = userOverride || user;
      if (!activeUser) {
        pendingPublishAfterLoginRef.current = { skipVoxelCheck };
        setPendingPublishAfterLogin(true);
        setLoginOpen(true);
        return;
      }
      if (!pol.locationRef.current && !pol.location) {
        brush.notifyToolUnavailable('publish', describeLocationNeededAction());
        return;
      }
      if (!pol.cameraReadyRef.current) {
        brush.notifyToolUnavailable('publish', describeCameraNeededAction());
        return;
      }
      const cov = pol.polRef.current.getSceneCoverage();
      if (!cov.optimal) {
        brush.notifyToolUnavailable(
          'publish',
          `Scan space to 100% (${cov.scannedCount}/${cov.targetCount}). Pan phone around.`
        );
        return;
      }
      setPublishError('');
      setMintReceipt(null);
      if (brush.modeRef.current === 'transform') {
        brush.commitTransformAndExit('publish');
      } else {
        brush.setMode('publish');
      }
    },
    [activeInsideLand, brush, pol, user]
  );
  openPublishSheetRef.current = openPublishSheet;

  const handleDesktopCommand = useCallback(
    (msg) => {
      if (msg.action === 'set_color' && msg.color) brush.setColor(msg.color);
      if (msg.action === 'set_block_size' && msg.blockSize != null) {
        brush.setBlockSize(Number(msg.blockSize));
      }
      if (msg.action === 'set_tool' && msg.tool) {
        if (!brush.ensureToolUsable(msg.tool)) return;
        if (brush.modeRef.current === 'transform') {
          brush.commitTransformAndExit('draw', msg.tool);
        } else {
          brush.setMode('draw');
          brush.setTool(msg.tool);
        }
      }
      if (msg.action === 'set_mode' && msg.mode) {
        if (msg.mode === 'publish') {
          openPublishSheet();
        } else if (msg.mode === 'preview' && !brush.ensureToolUsable('preview')) {
          return;
        } else if (brush.modeRef.current === 'transform') {
          brush.commitTransformAndExit(msg.mode);
        } else {
          brush.setMode(msg.mode);
        }
      }
      if (msg.action === 'undo') brush.handleUndo();
      if (msg.action === 'clear') brush.clearCanvas();
    },
    [brush, openPublishSheet]
  );

  const resetFormAfterPublish = useCallback(
    (resultPayload) => {
      drafts.markDraftPublished(drafts.activeDraftIdRef.current);
      setMintReceipt(resultPayload);
      brush.setVoxels([]);
      clearPlacedCatalogItem();
      pol.resetSpatialDrawOrigin();
      setTitle('');
      setDescription('');
      setCluePrompt('');
      setClueAnswer('');
      setTermsAccepted(false);
      lands.refreshMyLands();
      const loc = pol.locationRef.current || pol.location;
      if (loc) {
        api
          .listSculptures({ lat: loc.lat, lng: loc.lng, radiusMeters: 300, includeVoxels: false })
          .then((nRes) => ar.hydrateNearbyList(nRes.sculptures || [], loc))
          .catch(() => {});
      }
    },
    [ar, brush, clearPlacedCatalogItem, drafts, lands, pol]
  );

  const {
    refreshCamera: refreshArCamera,
    ensureCameraLive: ensureArCameraLive,
    notifyMappingViewLeft,
    notifyMappingViewReturned,
    restartSceneMapping
  } = pol;

  const handlePairingConnectionChange = useCallback(
    ({ kind, status }) => {
      if (status === 'reconnected' || (kind === 'desktop' && status === 'connected')) {
        refreshArCamera({ reason: `${kind}_${status}`, force: true });
      } else if (status === 'disconnected' || status === 'ended') {
        ensureArCameraLive({ reason: `${kind}_${status}` });
      }
    },
    [ensureArCameraLive, refreshArCamera]
  );

  const navigateToLandById = useCallback(
    async (parcelId) => {
      const cleanId = String(parcelId || '').trim();
      if (!cleanId) return;
      const localMatch =
        (ar.mapParcels || []).find(
          (p) => String(p?.parcelId || '').toUpperCase() === cleanId.toUpperCase()
        ) ||
        (ar.nearbyParcels || []).find(
          (p) => String(p?.parcelId || '').toUpperCase() === cleanId.toUpperCase()
        ) ||
        (lands.myLands?.parcels || []).find(
          (p) => String(p?.parcelId || '').toUpperCase() === cleanId.toUpperCase()
        ) ||
        null;
      setParcelVisit({
        loading: !localMatch,
        parcel: localMatch,
        sculptures: Array.isArray(localMatch?.sculptures) ? localMatch.sculptures : [],
        error: ''
      });
      try {
        const res = await api.getLandDetail(cleanId);
        setParcelVisit({
          loading: false,
          parcel: res?.parcel || localMatch,
          sculptures: res?.sculptures || [],
          error: res?.parcel || localMatch ? '' : 'Virtual Land parcel not found.'
        });
      } catch (err) {
        if (!localMatch) {
          setParcelVisit({
            loading: false,
            parcel: null,
            sculptures: [],
            error: err?.message || 'Could not load Virtual Land parcel.'
          });
        }
      }
    },
    [ar.mapParcels, ar.nearbyParcels, lands.myLands?.parcels]
  );

  const sigExecDebounceRef = useRef(null);
  useEffect(() => {
    return () => {
      if (sigExecDebounceRef.current) clearTimeout(sigExecDebounceRef.current);
    };
  }, []);

  const handleSignatureExecuted = useCallback(
    (_res, reqItem) => {
      const targetParcelId = String(reqItem?.parcelId || '').trim().toUpperCase();
      if (sigExecDebounceRef.current) clearTimeout(sigExecDebounceRef.current);
      // Coalesce back-to-back approvals so we don't stack overlapping full-catalog reloads in one 10s window
      sigExecDebounceRef.current = setTimeout(() => {
        sigExecDebounceRef.current = null;
        lands.refreshMyLands();
        ar.loadPublicMapData();
        setNotifRefreshBump((n) => n + 1);
        const loc = pol.locationRef.current || pol.location;
        if (loc) {
          api
            .listSculptures({ lat: loc.lat, lng: loc.lng, radiusMeters: 300, includeVoxels: false })
            .then((nRes) => ar.hydrateNearbyList(nRes.sculptures || [], loc))
            .catch(() => {});
        }
        if (targetParcelId) {
          setParcelVisit((prev) => {
            if (!prev?.parcel?.parcelId || prev.parcel.parcelId.toUpperCase() !== targetParcelId) {
              return prev;
            }
            api
              .getLandDetail(prev.parcel.parcelId)
              .then((fresh) => {
                if (fresh?.parcel) {
                  setParcelVisit((cur) =>
                    cur?.parcel?.parcelId?.toUpperCase() === targetParcelId
                      ? { ...cur, parcel: fresh.parcel, sculptures: fresh.sculptures || [] }
                      : cur
                  );
                }
              })
              .catch(() => {});
            return prev;
          });
        }
      }, 350);
    },
    [ar, lands, pol]
  );

  const pairing = usePairing({
    user,
    voxels: brush.voxels,
    voxelsRef: brush.voxelsRef,
    rawOrientationRef: pol.rawOrientationRef,
    yawOffsetRef: pol.yawOffsetRef,
    showTemporaryHint,
    onOpenLogin: () => setLoginOpen(true),
    onDesktopCommand: handleDesktopCommand,
    onDelegatedPublishExecuted: resetFormAfterPublish,
    onSignatureExecuted: handleSignatureExecuted,
    onConnectionStateChange: handlePairingConnectionChange,
    onNavigateToLand: navigateToLandById
  });
  openPairModalRef.current = () => pairing.setPairOpen(true);

  const hasFullscreenOverlay = Boolean(
    ar.mapOpen ||
      parcelVisit ||
      ar.mapSelectedSculpture ||
      lands.landManageOpen ||
      catalogSearchOpen ||
      pairing.pairOpen ||
      drafts.agentOpen ||
      drafts.draftsOpen ||
      brush.mode === 'publish' ||
      chat.chatSelection ||
      profileHandle ||
      infoOpen ||
      archiveOpen ||
      loginOpen
  );
  const isAwayFromMappingView = Boolean(
    hasFullscreenOverlay || isArViewOnly || isTransformMode
  );
  mappingPausedRef.current = Boolean(isAwayFromMappingView || pol.mappingRestartPrompt);

  const mobileActiveViewKey = loginOpen
    ? 'login'
    : ar.mapSelectedSculpture
    ? `sculpture:${ar.mapSelectedSculpture.id || 'item'}`
    : chat.chatSelection
    ? `chat:${chat.chatSelection?.sculpture?.id || 'room'}`
    : brush.mode === 'publish'
    ? 'publish'
    : lands.landManageOpen
    ? `land-manage:${lands.landManageParcelId || 'all'}`
    : catalogSearchOpen
    ? 'catalog-search'
    : profileHandle
    ? `profile:${profileHandle}`
    : drafts.draftsOpen
    ? 'drafts'
    : pairing.pairOpen
    ? 'pair'
    : drafts.agentOpen
    ? 'agent'
    : infoOpen
    ? `info:${infoInitialTab}`
    : archiveOpen
    ? `archive:${archiveInitialId || 'all'}`
    : sprayBrushGuideOpen
    ? 'spray-guide'
    : tutorialOpen && !isWelcomeOpen && !parcelVisit
    ? 'tutorial'
    : dockOpen
    ? 'dock'
    : isInteractingWithLand
    ? `ar-land:${ar.activeArLand?.parcelId || ar.arSelectedLandId || 'active'}`
    : parcelVisit
    ? `plot:${parcelVisit.parcel?.parcelId || 'visit'}`
    : ar.mapOpen
    ? 'map'
    : `camera:${brush.mode}`;

  useInAppBackHistory({
    activeViewKey: mobileActiveViewKey,
    onBackStep: () => {
      if (loginOpen) {
        pendingPublishAfterLoginRef.current = null;
        setPendingPublishAfterLogin(false);
        setLoginOpen(false);
        return true;
      }
      if (ar.mapSelectedSculpture) {
        ar.setMapSelectedSculpture(null);
        return true;
      }
      if (chat.chatSelection) {
        chat.setChatSelection(null);
        return true;
      }
      if (brush.mode === 'publish') {
        brush.setMode('draw');
        return true;
      }
      if (lands.landManageOpen) {
        lands.setLandManageOpen(false);
        return true;
      }
      if (catalogSearchOpen) {
        setCatalogSearchOpen(false);
        return true;
      }
      if (profileHandle) {
        setProfileHandle('');
        return true;
      }
      if (drafts.draftsOpen) {
        drafts.setDraftsOpen(false);
        return true;
      }
      if (pairing.pairOpen) {
        pairing.setPairOpen(false);
        return true;
      }
      if (drafts.agentOpen) {
        drafts.setAgentOpen(false);
        return true;
      }
      if (infoOpen) {
        setInfoOpen(false);
        setInfoInitialTab('guide');
        return true;
      }
      if (archiveOpen) {
        setArchiveOpen(false);
        setArchiveInitialId('');
        return true;
      }
      if (sprayBrushGuideOpen) {
        setSprayBrushGuideOpen(false);
        return true;
      }
      if (tutorialOpen) {
        setTutorialOpen(false);
        return true;
      }
      if (dockOpen) {
        setDockOpen(false);
        return true;
      }
      if (isInteractingWithLand) {
        handleExitArLand();
        return true;
      }
      if (parcelVisit) {
        setParcelVisit(null);
        return true;
      }
      if (ar.mapOpen) {
        ar.setMapOpen(false);
        return true;
      }
      if (brush.mode === 'transform') {
        brush.commitTransformAndExit('draw');
        return true;
      }
      if (brush.mode === 'preview') {
        brush.setMode('draw');
        return true;
      }
      const prevDrawOrigin = drawReturnSessionRef.current;
      if (prevDrawOrigin) {
        drawReturnSessionRef.current = null;
        if (prevDrawOrigin.type === 'ar-land' && prevDrawOrigin.land) {
          setArViewSession(prevDrawOrigin.arViewSession || null);
          setArInspectorExpanded(false);
          brush.setMode('preview');
          ar.selectArLand(prevDrawOrigin.land, prevDrawOrigin.land.sculptures || []);
          return true;
        }
        if (prevDrawOrigin.type === 'plot' && prevDrawOrigin.parcel) {
          setParcelVisit({
            loading: false,
            parcel: prevDrawOrigin.parcel,
            sculptures: prevDrawOrigin.sculptures || [],
            error: ''
          });
          return true;
        }
      }
      return false;
    }
  });

  const prevFullscreenOverlayRef = useRef(hasFullscreenOverlay);
  useEffect(() => {
    if (prevFullscreenOverlayRef.current && !hasFullscreenOverlay) {
      ensureArCameraLive({ reason: 'overlay_closed' });
    }
    prevFullscreenOverlayRef.current = hasFullscreenOverlay;
  }, [ensureArCameraLive, hasFullscreenOverlay]);

  useEffect(() => {
    if (isTransformMode) {
      setDockOpen(false);
    }
  }, [isTransformMode]);

  const prevMappingAwayRef = useRef(isAwayFromMappingView);
  useEffect(() => {
    if (!prevMappingAwayRef.current && isAwayFromMappingView) {
      notifyMappingViewLeft();
    } else if (prevMappingAwayRef.current && !isAwayFromMappingView) {
      notifyMappingViewReturned();
    }
    prevMappingAwayRef.current = isAwayFromMappingView;
  }, [isAwayFromMappingView, notifyMappingViewLeft, notifyMappingViewReturned]);

  const prevRestartPromptRef = useRef(pol.mappingRestartPrompt);
  useEffect(() => {
    if (!prevRestartPromptRef.current && pol.mappingRestartPrompt) {
      showTemporaryHint(
        pol.mappingRestartPrompt.summary ||
          'Moved spots — tap 🔄 to rescan.'
      );
    }
    prevRestartPromptRef.current = pol.mappingRestartPrompt;
  }, [pol.mappingRestartPrompt, showTemporaryHint]);

  const handleRestartSceneMapping = useCallback(
    async (reason = 'manual') => {
      await restartSceneMapping({ reason, refreshCameraFeed: true });
      showTemporaryHint('Scan reset — pan phone slowly around.');
    },
    [restartSceneMapping, showTemporaryHint]
  );

  const handlePublishSubmit = async (e) => {
    e.preventDefault();
    if (!user) {
      pendingPublishAfterLoginRef.current = { skipVoxelCheck: true };
      setPendingPublishAfterLogin(true);
      setLoginOpen(true);
      return;
    }
    setPublishing(true);
    setPublishError('');
    try {
      const location = pol.location;
      if (!location) {
        throw new Error(describeLocationNeededAction());
      }
      if (activeInsideLand?.isFrozen) {
        throw new Error(
          `"${activeInsideLand.displayName || 'This land'}" is frozen by its owner — new art cannot be added here.`
        );
      }
      const previewDataUrl = captureSculptureSnapshot();
      const polSnap = pol.polRef.current.getSnapshot();
      const refinedAnchor = pol.polRef.current.getRefinedLocation(location) || location;
      const tr = brush.artTransformRef.current;
      // Preserve creator's True-North world orientation + forward placement offset so
      // visitors see published art in the exact real-world direction & spot it was painted.
      const draftYawRad = Number(pol.draftYawOffsetRef?.current || 0);
      const localTransformYawRad = THREE.MathUtils.degToRad(Number(tr.rotYDeg || 0));
      const trueHeadingDeg = pol.orientationFusionRef?.current?.initialized
        ? pol.orientationFusionRef.current.getTrueHeadingDeg()
        : null;
      const forwardReachM =
        trueHeadingDeg !== null && brush.surfaceAnchorRef?.current?.depthM
          ? Math.min(3.5, Math.max(0.5, Number(brush.surfaceAnchorRef.current.depthM)))
          : trueHeadingDeg !== null
          ? Math.min(3.0, Math.max(0.5, Number(brush.reachRef?.current || 1.8)))
          : 0;
      const headingRad = trueHeadingDeg !== null ? THREE.MathUtils.degToRad(trueHeadingDeg) : 0;
      const placedCat = placedCatalogItemRef.current;
      const placedCatYawRad = THREE.MathUtils.degToRad(Number(placedCat?.rotYDeg || 0));
      const anchorOffset = {
        dx: Number(
          (
            Number(tr.offsetX || 0) +
            Number(placedCat?.pos?.x || 0) +
            Math.sin(headingRad) * forwardReachM
          ).toFixed(3)
        ),
        dy: Number((Number(tr.offsetY || 0) + Number(placedCat?.pos?.y || 0)).toFixed(3)),
        dz: Number(
          (
            Number(tr.offsetZ || 0) +
            Number(placedCat?.pos?.z || 0) -
            Math.cos(headingRad) * forwardReachM
          ).toFixed(3)
        ),
        yaw: Number((draftYawRad + localTransformYawRad + placedCatYawRad).toFixed(4)),
        ...(placedCat?.rotZDeg ? { roll: Number(placedCat.rotZDeg) } : {})
      };
      const enrichedPolSnap = {
        ...polSnap,
        sensorFusion: pol.sensorStatus || null
      };
      const res = await api.publishSculpture({
        title,
        description,
        termsAccepted,
        voxels: brush.voxels,
        ...(placedCat
          ? {
              catalogItemId: placedCat.id,
              modelFormat: placedCat.modelFormat || 'glb',
              modelUrl: placedCat.modelUrl,
              modelScale: Number(((placedCat.scale || 1) * (tr.scale || 1)).toFixed(3)),
              modelRotationY: Number(THREE.MathUtils.degToRad(placedCat.rotYDeg || 0).toFixed(4))
            }
          : {}),
        anchorOffset,
        previewDataUrl,
        targetParcelId: activeInsideLand?.parcelId || '',
        questId: activeQuest?.id || '',
        plinthSlotId: selectedPlinthSlot?.id || '',
        draftId: drafts.activeDraftId || undefined,
        location: refinedAnchor,
        proofOfLocation: enrichedPolSnap,
        deviceProfile: {
          isMobile: true,
          screenWidth: window.innerWidth,
          screenHeight: window.innerHeight,
          hasCamera: pol.cameraReady
        }
      });

      if (res?.sculpture?.parcelId && pol.orbKeyframesRef.current.size > 0) {
        const kfs = Array.from(pol.orbKeyframesRef.current.values());
        const totalFeatures = kfs.reduce((sum, kf) => sum + (kf.features?.length || 0), 0);
        if (totalFeatures >= 12) {
          api
            .saveParcelLandmarkPack(res.sculpture.parcelId, {
              geohash: res.sculpture.geohash,
              lat: refinedAnchor.lat,
              lng: refinedAnchor.lng,
              keyframes: kfs,
              allowInitialClaim: !res?.addedToExistingLand,
              deviceProfile: { isMobile: true }
            })
            .catch(() => {});
          pol.resetOrbKeyframes();
        }
      }

      if (user?.id && res?.sculpture?.id) {
        try {
          const idObj = await getOrCreateDeviceIdentity(user.id);
          const roomKeyB64 = generateRoomKeyB64();
          saveLocalRoomKey(user.id, res.sculpture.id, 1, roomKeyB64);
          const { roomKeyCommit } = await computeRoomPossessionProof(
            roomKeyB64,
            res.sculpture.id,
            1
          );
          const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
            roomKeyB64,
            sculptureId: res.sculpture.id,
            keyEpoch: 1,
            recipientEcdhPubJwk: idObj.ecdhPublicJwk,
            recipientPubFp: idObj.pubFingerprint,
            grantorIdentity: idObj
          });
          let clueWrappedJson = '';
          if (cluePrompt.trim() && clueAnswer.trim()) {
            clueWrappedJson = await wrapRoomKeyWithClue({
              roomKeyB64,
              sculptureId: res.sculpture.id,
              keyEpoch: 1,
              clueAnswer
            });
          }
          await api.initSculptureChat(res.sculpture.id, {
            ownerEcdhPubJwk: idObj.ecdhPublicJwk,
            ownerSignPubJwk: idObj.signPublicJwk,
            ownerPubFp: idObj.pubFingerprint,
            selfGrantEnvelope: wrappedKeyJson,
            selfGrantSig: grantSig,
            roomKeyCommit,
            cluePrompt: cluePrompt.trim(),
            clueWrappedJson,
            deviceProfile: { isMobile: true }
          });
        } catch {
          // Non-blocking
        }
      }

      resetFormAfterPublish(res);
      api
        .listParcels()
        .then((pRes) => {
          if (Array.isArray(pRes?.parcels)) ar.setNearbyParcels(pRes.parcels);
        })
        .catch(() => {});
    } catch (err) {
      setPublishError(describeApiErrorForMobile(err));
    } finally {
      setPublishing(false);
    }
  };

  const handleCopyAgentPublishPrompt = async () => {
    if (!user) {
      pendingPublishAfterLoginRef.current = { skipVoxelCheck: true };
      setPendingPublishAfterLogin(true);
      setLoginOpen(true);
      return;
    }
    setPublishing(true);
    setPublishError('');
    try {
      const location = pol.location;
      if (!location) {
        throw new Error(describeLocationNeededAction());
      }
      const activePairingCode = pairing.mcpPairingsState.activePairing?.code;
      if (!activePairingCode) {
        throw new Error('Connect a Pair code first.');
      }
      if (activeInsideLand?.isFrozen) {
        throw new Error(
          `"${activeInsideLand.displayName || 'This land'}" is frozen by its owner — new art cannot be added here.`
        );
      }
      const previewDataUrl = captureSculptureSnapshot();
      const polSnap = pol.polRef.current.getSnapshot();
      const refinedAnchor = pol.polRef.current.getRefinedLocation(location) || location;
      const out = await api.createPublishSignatureRequest({
        pairingCode: activePairingCode,
        title,
        description,
        termsAccepted,
        voxels: brush.voxels,
        previewDataUrl,
        targetParcelId: activeInsideLand?.parcelId || '',
        draftId: drafts.activeDraftId || undefined,
        location: refinedAnchor,
        proofOfLocation: polSnap,
        deviceProfile: {
          isMobile: true,
          screenWidth: window.innerWidth,
          screenHeight: window.innerHeight,
          hasCamera: pol.cameraReady
        }
      });
      const { copyToClipboard } = await import('../utils/clipboard.js');
      const copied = await copyToClipboard(out.promptText);
      pairing.setAgentPublishPrompt({
        requestId: out.request?.id,
        pairingCode: activePairingCode,
        promptText: out.promptText,
        copied
      });
    } catch (err) {
      setPublishError(err.message || 'Could not create agent publish prompt');
    } finally {
      setPublishing(false);
    }
  };

  const arRecordedInPersonViewsRef = useRef(new Set());
  const activeArLandForViews = ar.activeArLand;
  const setArNearbyParcelsForViews = ar.setNearbyParcels;
  const setArMapParcelsForViews = ar.setMapParcels;
  useEffect(() => {
    const pid = activeArLandForViews?.parcelId;
    if (!pid || activeArLandForViews?.outOfArRange) return;
    const uLat = Number(pol.location?.lat);
    const uLng = Number(pol.location?.lng);
    if (!Number.isFinite(uLat) || !Number.isFinite(uLng)) return;
    if (arRecordedInPersonViewsRef.current.has(pid)) return;
    arRecordedInPersonViewsRef.current.add(pid);
    api
      .recordLandView(pid, { viewType: 'in_person', lat: uLat, lng: uLng })
      .then((res) => {
        if (!res?.ok) return;
        const patch = (list) =>
          (list || []).map((p) =>
            p?.parcelId === pid
              ? { ...p, pageViews: res.pageViews, inPersonViews: res.inPersonViews }
              : p
          );
        setArNearbyParcelsForViews?.(patch);
        setArMapParcelsForViews?.(patch);
      })
      .catch(() => {});
  }, [
    activeArLandForViews?.outOfArRange,
    activeArLandForViews?.parcelId,
    pol.location?.lat,
    pol.location?.lng,
    setArMapParcelsForViews,
    setArNearbyParcelsForViews
  ]);

  const handleMobileApprovalResolved = ({ requestId = '' } = {}) => {
    if (
      requestId &&
      ar.mapSelectedSculpture?.isPendingPreview &&
      ar.mapSelectedSculpture.pendingRequestId === requestId
    ) {
      ar.setMapSelectedSculpture(null);
    }
    pairing.refreshPendingSignatures?.();
    ar.loadPublicMapData();
    lands.refreshMyLands();
    setNotifRefreshBump((n) => n + 1);
    if (parcelVisit?.parcel?.parcelId) {
      api
        .getLandDetail(parcelVisit.parcel.parcelId)
        .then((res) => {
          if (res?.parcel) {
            setParcelVisit({
              loading: false,
              parcel: res.parcel,
              sculptures: res.sculptures || [],
              error: ''
            });
          }
        })
        .catch(() => {});
    }
  };

  const dismissMobileOverlaysForNotification = ({
    keepParcelVisit = false,
    keepSelectedSculpture = false
  } = {}) => {
    chat.setChatSelection(null);
    ar.setMapOpen(false);
    drafts.setDraftsOpen(false);
    drafts.setAgentOpen(false);
    pairing.setPairOpen(false);
    lands.setLandManageOpen(false);
    setCatalogSearchOpen(false);
    setProfileHandle('');
    setInfoOpen(false);
    setArchiveOpen(false);
    setArViewSession(null);
    ar.setArSelectedLandId('');
    setDockOpen(false);
    if (brush.mode === 'publish') brush.setMode('draw');
    if (!keepSelectedSculpture) ar.setMapSelectedSculpture(null);
    if (!keepParcelVisit) setParcelVisit(null);
  };

  const handleMobileNotificationAction = async (item) => {
    if (!item) return;
    if (item.actionType === 'open_pair_mobile') {
      dismissMobileOverlaysForNotification();
      setOpenPairHubSignal({ tab: 'pair', ts: Date.now() });
      return;
    }
    if (item.actionType === 'preview_pending_sculpture') {
      dismissMobileOverlaysForNotification({ keepParcelVisit: true });
      const reqId = item.pendingRequest?.id || item.meta?.requestId || '';
      const allKnownParcels = [
        ...(ar.mapParcels || []),
        ...(ar.nearbyParcels || []),
        ...(lands.myLands?.parcels || [])
      ];
      const allKnownSculptures = [
        ...(ar.mapSculptures || []),
        ...(ar.nearbySculptures || [])
      ];
      const reqObj =
        item.pendingRequest ||
        (pairing.pendingSignatures || []).find((r) => r.id === reqId) ||
        null;
      let previewSc = reqObj
        ? buildPendingPreviewSculpture(reqObj, {
            parcels: allKnownParcels,
            existingSculptures: allKnownSculptures,
            allowFallbackCoords: true
          })
        : null;
      if (!previewSc && reqId && typeof api.getSignatureRequest === 'function') {
        try {
          const sigRes = await api.getSignatureRequest(reqId);
          const fullReq = sigRes?.request || sigRes;
          if (fullReq?.id) {
            previewSc = buildPendingPreviewSculpture(fullReq, {
              parcels: allKnownParcels,
              existingSculptures: allKnownSculptures,
              allowFallbackCoords: true
            });
          }
        } catch {
          // Fall back to opening the land if hydration fails
        }
      }
      if (previewSc) {
        ar.setMapSelectedSculpture(previewSc);
        return;
      }
      if (item.parcelId) {
        await navigateToLandById(item.parcelId);
        return;
      }
    }
    if (item.actionType === 'open_land_approval' && item.parcelId) {
      dismissMobileOverlaysForNotification();
      await navigateToLandById(item.parcelId);
      return;
    }
    if (item.actionType === 'open_mint') {
      dismissMobileOverlaysForNotification();
      setInfoInitialTab('mint');
      setInfoOpen(true);
    } else if (item.actionType === 'open_archive') {
      dismissMobileOverlaysForNotification();
      setArchiveInitialId(String(item.meta?.archiveId || ''));
      setArchiveOpen(true);
    } else if (
      (item.actionType === 'open_sculpture' ||
        (item.sculptureId && item.actionType !== 'open_land')) &&
      item.sculptureId
    ) {
      dismissMobileOverlaysForNotification({ keepParcelVisit: true });
      const localMatch =
        (ar.mapSculptures || []).find((s) => s.id === item.sculptureId) ||
        (ar.nearbySculptures || []).find((s) => s.id === item.sculptureId);
      if (localMatch) {
        ar.setMapSelectedSculpture(localMatch);
        return;
      }
      try {
        const res = await api.getSculpture(item.sculptureId);
        if (res?.sculpture) {
          ar.setMapSelectedSculpture(res.sculpture);
          return;
        }
      } catch {
        // Fall back to opening the land if sculpture lookup fails
      }
      if (item.parcelId) {
        await navigateToLandById(item.parcelId);
      }
    } else if (item.actionType === 'open_land' && item.parcelId) {
      dismissMobileOverlaysForNotification();
      await navigateToLandById(item.parcelId);
    }
  };

  return (
    <NotificationProvider
      user={user}
      variant="mobile"
      refreshSignal={lands.ownedLandCount + notifRefreshBump}
      pendingApprovals={pairing.pendingSignatures}
      pendingApprovalsLoaded={pairing.pendingSignaturesLoaded}
      onRequestPendingRefresh={() => pairing.refreshPendingSignatures({ includeHistory: false })}
      onApprovalResolved={handleMobileApprovalResolved}
      onAction={handleMobileNotificationAction}
    >
    <div className="mobile-fullscreen">
      <ARViewportCanvas
        videoRef={pol.videoRef}
        occlusionCanvasRef={occlusionCanvasRef}
        canvasHostRef={canvasHostRef}
        rendererRef={rendererRef}
        sceneRef={sceneRef}
        cameraRef={cameraRef}
        draftGroupRef={draftGroupRef}
        nearbyGroupRef={nearbyGroupRef}
        ghostMeshRef={ghostMeshRef}
        shadowPlaneRef={shadowPlaneRef}
        gridHelperRef={gridHelperRef}
        surfaceMarkerRef={surfaceMarkerRef}
        transformBoxRef={transformBoxRef}
        originBeaconMatRef={originBeaconMatRef}
        dirLightRef={dirLightRef}
        hemiLightRef={hemiLightRef}
        envUpdaterRef={envUpdaterRef}
        draftUnitGeoRef={brush.draftUnitGeoRef}
        draftMatCacheRef={brush.draftMatCacheRef}
        draftMeshMapRef={brush.draftMeshMapRef}
        polRef={pol.polRef}
        orbTrackerRef={pol.orbTrackerRef}
        orbKeyframesRef={pol.orbKeyframesRef}
        occlusionRef={brush.occlusionRef}
        originStatusRef={brush.originStatusRef}
        setOriginStatus={brush.setOriginStatus}
        occlusionEnabled={brush.occlusionEnabled}
        occlusionEnabledRef={brush.occlusionEnabledRef}
        rawOrientationRef={pol.rawOrientationRef}
        yawOffsetRef={pol.yawOffsetRef}
        draftYawOffsetRef={pol.draftYawOffsetRef}
        orientationFusionRef={pol.orientationFusionRef}
        positionFilterRef={pol.positionFilterRef}
        spatialDrawTrackerRef={pol.spatialDrawTrackerRef}
        reachRef={brush.reachRef}
        webxrControllerRef={webxrControllerRef}
        onWebxrStateChange={pol.setWebxrState}
        fallbackEulerRef={pol.fallbackEulerRef}
        wsRef={pairing.wsRef}
        locationRef={pol.locationRef}
        arTargetedIdRef={ar.arTargetedIdRef}
        setArTargetedSculpture={ar.setArTargetedSculpture}
        arSelectedLandIdRef={ar.arSelectedLandIdRef}
        isInteractingWithLand={isInteractingWithLand}
        isInteractingWithLandRef={isInteractingWithLandRef}
        isArViewOnly={isArViewOnly}
        isArViewOnlyRef={isArViewOnlyRef}
        renderPaused={Boolean(
          ar.mapOpen || parcelVisit || lands.landManageOpen || ar.mapSelectedSculpture
        )}
        mode={brush.mode}
        modeRef={brush.modeRef}
        toolRef={brush.toolRef}
        blockSizeRef={brush.blockSizeRef}
        colorRef={brush.colorRef}
        voxelsRef={brush.voxelsRef}
        paintingRef={brush.paintingRef}
        strokeDeviceOriginRef={brush.strokeDeviceOriginRef}
        lastPaintPosRef={brush.lastPaintPosRef}
        lastStackAtRef={brush.lastStackAtRef}
        surfaceAnchorRef={brush.surfaceAnchorRef}
        lastScanUiRef={pol.lastScanUiRef}
        lastUnmappedMaskRef={pol.lastUnmappedMaskRef}
        mappingCompletedNoticeShownRef={pol.mappingCompletedNoticeShownRef}
        mappingPausedRef={mappingPausedRef}
        mappingRestartRequired={Boolean(pol.mappingRestartPrompt)}
        setSceneScan={pol.setSceneScan}
        setUnmappedGrid={pol.setUnmappedGrid}
        setOrbStatus={pol.setOrbStatus}
        showTemporaryHint={showTemporaryHint}
        cameraReady={pol.cameraReady}
        sceneScanOptimal={pol.sceneScan.optimal}
        calibrationReady={pol.calibrationReady}
        unmappedGrid={pol.unmappedGrid}
        onVideoMounted={pol.reattachVideoStream}
        onCameraRefreshNeeded={pol.refreshCamera}
        onArLandGuidance={ar.setArLandGuidance}
        fadeOtherItemsRef={fadeOtherItemsRef}
        atmosphericTintRef={atmosphericTintRef}
        getActivePlacedItemColliders={brush.getActivePlacedItemColliders}
        notifyBlockedByPlacedItem={brush.notifyBlockedByPlacedItem}
        notifyOutOfDrawRange={brush.notifyOutOfDrawRange}
        computeTargetVoxel={brush.computeTargetVoxel}
        applyVoxelBatch={brush.applyVoxelBatch}
        applyVoxelAction={brush.applyVoxelAction}
        eraseTargetVoxel={brush.eraseTargetVoxel}
        rebuildDraftMesh={brush.rebuildDraftMesh}
        onCanvasPointerDown={(e) => {
          if (dockOpen) {
            setDockOpen(false);
            return;
          }
          brush.handleCanvasPointerDown(e);
        }}
        onCanvasPointerMove={brush.handleCanvasPointerMove}
        onCanvasPointerUp={brush.handleCanvasPointerUp}
        onCanvasPointerCancel={brush.handleCanvasPointerCancel}
      />

      <div className="hud-layer">
        <StudioHudTopBar
          user={user}
          mode={brush.mode}
          dockOpen={dockOpen}
          location={pol.location}
          pairedCode={pairing.pairedCode}
          videoRef={pol.videoRef}
          pairCodeInput={pairing.pairCodeInput}
          setPairCodeInput={pairing.setPairCodeInput}
          pairError={pairing.pairError}
          onConnectPairCode={pairing.connectPairCode}
          onDisconnectDesktopPair={pairing.disconnectDesktopPair}
          mcpPairingsState={pairing.mcpPairingsState}
          mcpPairBusy={pairing.mcpPairBusy}
          mcpPairNotice={pairing.mcpPairNotice}
          setMcpPairNotice={pairing.setMcpPairNotice}
          repairNotice={pairing.repairNotice}
          onDismissRepairNotice={pairing.dismissRepairNotice}
          openPairHubSignal={openPairHubSignal}
          onCreateMcpPairing={pairing.handleCreateMcpPairing}
          onDisconnectMcpPairing={pairing.handleDisconnectMcpPairing}
          onOpenAgentHandoff={drafts.openAgentHandoff}
          onOpenLogin={() => setLoginOpen(true)}
          voxels={brush.voxels}
          onOpenTutorial={() => setTutorialOpen(true)}
          onOpenInfo={() => {
            setInfoInitialTab('guide');
            setInfoOpen(true);
          }}
          onOpenProfile={() => user && setProfileHandle(user.username || user.id)}
          onOpenCatalogSearch={() => setCatalogSearchOpen(true)}
          hasPlacedCatalogItem={Boolean(placedCatalogItem)}
          hasOwnedLand={lands.hasOwnedLand}
          ownedLandCount={lands.ownedLandCount}
          onOpenLandManage={() => {
            lands.setLandManageParcelId('');
            lands.setLandManageOpen(true);
          }}
          editingSculpture={lands.editingSculpture}
          savingCanvasEdit={lands.savingCanvasEdit}
          onSaveCanvasModification={lands.handleSaveCanvasModification}
          onCancelCanvasModification={() => {
            lands.setEditingSculpture(null);
            brush.setVoxels([]);
          }}
          surfaceAnchor={brush.surfaceAnchor}
          onToggleSurfaceLock={() =>
            brush.setSurfaceAnchor((prev) => (prev ? { ...prev, locked: !prev.locked } : prev))
          }
          brushUsable={brush.toolAvailability.brush.usable}
          brushUnavailableReason={brush.toolAvailability.brush.reason}
          onSeedVoxelAtAnchor={brush.seedVoxelAtAnchor}
          onClearSurfaceAnchor={() => brush.setSurfaceAnchor(null)}
          onSelectSurfaceCenter={() => brush.selectSurfaceAtScreenPoint()}
          needsGyroTap={pol.needsGyroTap}
          calibrationOverlayVisible={
            !isArViewOnly &&
            !isTransformMode &&
            (pol.calibrationState === 'calibrating' ||
              pol.calibrationState === 'lost' ||
              Boolean(pol.mappingRestartPrompt))
          }
          gyroFallbackActive={pol.gyroFallbackActive}
          cameraReady={pol.cameraReady}
          cameraRecovering={pol.cameraRecovering}
          onEnableIosGyro={pol.enableIosGyro}
          onRetryCameraAccess={pol.retryCameraAccess}
          onRetryLocation={() => pol.refreshLocationNow({ notifyNearby: true, force: true })}
          onCameraRefreshNeeded={pol.refreshCamera}
          sensorBanner={pol.sensorBanner}
          onDismissSensorBanner={() => pol.setSensorBanner('')}
          arTargetedSculpture={ar.arTargetedSculpture}
          arPinPreview={chat.arPinPreview}
          passkeyBusy={pol.passkeyBusy}
          onEnrollPasskeyAndRetryPin={chat.enrollPasskeyAndRetryPinUnlock}
          onOpenCameraSelectedChat={chat.openCameraSelectedChat}
          arSelectHint={arSelectHint}
          onDismissHint={() => setArSelectHint('')}
          originStatus={brush.originStatus}
          sceneScan={pol.sceneScan}
          onOpenLoginFromHint={() => {
            setArSelectHint('');
            setLoginOpen(true);
          }}
          pendingSignatures={pairing.pendingSignatures}
          signatureHistory={pairing.signatureHistory}
          pendingSigBusyId={pairing.pendingSigBusyId}
          pendingSigErrors={pairing.pendingSigErrors}
          onMobileSignPending={pairing.handleMobileSignPending}
          onMobileRejectPending={pairing.handleMobileRejectPending}
          onRefreshSignatures={pairing.refreshPendingSignatures}
          mapOpen={ar.mapOpen}
          nearbyCount={unseenNearbyMapCount}
          onOpenAreaMap={ar.openAreaMap}
          activeQuest={activeQuest}
          selectedPlinthSlot={selectedPlinthSlot}
          onSnapToPlinthSlot={handleSnapToPlinthSlot}
          isInteractingWithLand={isInteractingWithLand}
          nearbyCameraLand={activeInsideLand || ar.primaryCameraLand}
          nearbyCameraLandCount={ar.immediateCameraLands.length}
          nearbyOtherItemsCount={ar.visibleOtherItemsCount}
          fadeOtherItems={fadeOtherItems}
          onToggleFadeOtherItems={handleToggleFadeOtherItems}
          sensorStatus={pol.sensorStatus}
          webxrSupported={pol.webxrSupported}
          webxrActive={pol.webxrActive}
          onToggleWebxr={handleToggleWebxr}
          onInspectArLand={(land) => handleInspectArLand(land, { expandDetails: true })}
          onExitArLand={handleExitArLand}
          arExitLabel={arExitLabel}
          notifRefreshSignal={lands.ownedLandCount + notifRefreshBump}
          onNavigateToLand={navigateToLandById}
          onApprovalResolved={handleMobileApprovalResolved}
          onPreviewPending={(reqItem) => {
            if (!reqItem) return;
            const previewSc = buildPendingPreviewSculpture(reqItem, {
              parcels: [
                ...(ar.mapParcels || []),
                ...(ar.nearbyParcels || []),
                ...(lands.myLands?.parcels || [])
              ],
              existingSculptures: [...(ar.mapSculptures || []), ...(ar.nearbySculptures || [])],
              allowFallbackCoords: true
            });
            if (previewSc) {
              ar.setMapSelectedSculpture(previewSc);
              return;
            }
            if (reqItem.parcelId) {
              ar.openAreaMap({ focusParcelId: reqItem.parcelId });
            }
          }}
          onNotificationAction={handleMobileNotificationAction}
        />

        {!isInteractingWithLand && !isArViewOnly && brush.mode === 'draw' && (
          <DrawVolumeMeter
            active={brush.toolHolding}
            painting={brush.painting}
            usedVoxels={brush.voxels.length}
            maxVoxels={config?.policy?.maxVoxels || 4096}
            brushColor={brush.color}
            tool={brush.tool}
          />
        )}

        {!isInteractingWithLand && (
          <ToolCarouselBar
            activeKeyTool={brush.activeKeyTool}
            toolAvailability={brush.toolAvailability}
            canTouch={canTouch}
            swipeDragPx={brush.swipeDragPx}
            isDraggingKey={brush.isDraggingKey}
            painting={brush.painting}
            mode={brush.mode}
            dockOpen={dockOpen}
            voxelsLength={brush.voxels.length}
            placedCatalogItem={placedCatalogItem}
            artTransform={brush.artTransform}
            onSetArtTransform={brush.setArtTransform}
            onToggleTransformLock={brush.toggleTransformLock}
            onStepKeyTool={brush.stepKeyTool}
            onKeyPointerDown={brush.handleKeyPointerDown}
            onKeyPointerMove={brush.handleKeyPointerMove}
            onKeyPointerUp={brush.handleKeyPointerUp}
            onKeyPointerCancel={brush.handleKeyPointerCancel}
          />
        )}

        {!isArViewOnly && !isTransformMode && (
          <SceneCoverageWidget
            sceneScan={pol.sceneScan}
            orbStatus={pol.orbStatus}
            scanBoxCollapsed={pol.scanBoxCollapsed}
            onToggleCollapse={() => pol.setScanBoxCollapsed((v) => !v)}
            dockOpen={dockOpen}
            mode={brush.mode}
            mappingRestartPrompt={pol.mappingRestartPrompt}
            calibrationState={pol.calibrationState}
            calibrationReadiness={pol.calibrationReadiness}
            calibrationLoss={pol.calibrationLoss}
            calibrationJustLocked={pol.calibrationJustLocked}
            cameraReady={pol.cameraReady}
            needsGyroTap={pol.needsGyroTap}
            onEnableIosGyro={pol.enableIosGyro}
            onRetryCameraAccess={pol.retryCameraAccess}
            sensorStatus={pol.sensorStatus}
            voxelCount={brush.voxels.length}
            onRestartMapping={handleRestartSceneMapping}
            onStartFresh={() => {
              brush.clearCanvas();
              handleRestartSceneMapping('start_fresh');
            }}
            onRefreshOrbRescan={async () => {
              await ensureArCameraLive({ reason: 'orb_rescan' });
              return ar.handleRefreshOrbRescan();
            }}
          />
        )}

        {!isInteractingWithLand && (
          <StudioDockDrawer
            dockOpen={dockOpen}
            onToggleDock={() => setDockOpen((v) => !v)}
            onCloseDock={() => setDockOpen(false)}
            tool={brush.tool}
            onOpenBrushGuide={() => setSprayBrushGuideOpen(true)}
            blockSize={brush.blockSize}
            setBlockSize={brush.setBlockSize}
            color={brush.color}
            setColor={brush.setColor}
            material={brush.material}
            setMaterial={brush.setMaterial}
            reachMeters={brush.reachMeters}
            setReachMeters={brush.setReachMeters}
            nearbyOtherItemsCount={ar.visibleOtherItemsCount}
            fadeOtherItems={fadeOtherItems}
            onToggleFadeOtherItems={handleToggleFadeOtherItems}
          />
        )}

        {isInteractingWithLand && (
          <ARLandGuidanceOverlay
            land={ar.activeArLand}
            guidance={ar.arLandGuidance}
            loadState={ar.selectedLandLoadState}
            hasBottomInspector={arInspectorExpanded}
          />
        )}

        {isInteractingWithLand && (
          <ARLandInspectorPanel
            land={ar.activeArLand}
            expanded={arInspectorExpanded}
            onToggleExpanded={(next) => setArInspectorExpanded(Boolean(next))}
            nearbyLands={
              focusedArLandId
                ? ar.activeArLand
                  ? [ar.activeArLand]
                  : []
                : ar.immediateCameraLands.length > 0
                ? ar.immediateCameraLands
                : ar.visibleCameraLands
            }
            onSelectNearbyLand={(nextLand) => {
              if (nextLand?.parcelId) ar.selectArLand(nextLand, nextLand.sculptures || []);
            }}
            onDrawHere={(targetLand) => {
              const gate = evaluateArLandActionProximity(targetLand);
              if (!gate.canDrawAtLand) {
                showTemporaryHint(
                  `Visit ${targetLand?.displayName || 'this land'} in person to draw on it.`
                );
                return;
              }
              drawReturnSessionRef.current = {
                type: 'ar-land',
                land: targetLand,
                arViewSession: arViewSessionRef.current || null
              };
              setArViewSession(null);
              ar.setArSelectedLandId('');
              setPreferredDrawLandId(targetLand?.parcelId || '');
              brush.setMode('draw');
              maybeShowSprayBrushGuide();
              showTemporaryHint(
                `Adding art to ${targetLand.displayName} — hold Brush to spray in 3D AR!`
              );
            }}
            onCheckInLand={async (targetLand) => {
              const gate = evaluateArLandActionProximity(targetLand);
              if (!gate.canCheckInAtLand) {
                showTemporaryHint(
                  `Visit ${targetLand?.displayName || 'this land'} in person to check in IRL.`
                );
                return false;
              }
              if (!user) {
                setLoginOpen(true);
                showTemporaryHint('Sign in to verify your in-person visit on this land.');
                return false;
              }
              const loc = pol.location;
              if (!loc) {
                showTemporaryHint(describeLocationNeededAction());
                return false;
              }
              try {
                const polSnap = pol.polRef.current?.getSnapshot?.() || {};
                const res = await api.checkInToLand(targetLand.parcelId, {
                  location: { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy },
                  proofOfLocation: polSnap,
                  deviceProfile: {
                    isMobile: true,
                    hasCamera: Boolean(pol.cameraReady),
                    screenWidth: window.innerWidth,
                    screenHeight: window.innerHeight
                  }
                });
                showTemporaryHint(
                  res?.awakenedNow
                    ? `✨ In-person visit verified! "${targetLand.displayName}" awakened — draw art here in AR anytime to make it permanent (no timer).`
                    : `✅ In-person visit verified for "${targetLand.displayName}" — draw art here in AR to permanently own it with no timer.`
                );
                return true;
              } catch (err) {
                showTemporaryHint(err?.message || 'Could not verify in-person check-in.');
                return false;
              }
            }}
            onOpen3DMap={
              arViewSession?.source === 'map'
                ? null
                : (targetLand) => {
                    setArViewSession(null);
                    ar.setArSelectedLandId('');
                    ar.openAreaMap({
                      initialDimensionMode: '3d',
                      focusParcelId: targetLand.parcelId
                    });
                  }
            }
            onManageLand={(pid) => {
              setArViewSession(null);
              ar.setArSelectedLandId('');
              lands.setLandManageParcelId(pid || '');
              lands.setLandManageOpen(true);
            }}
            onRenameLand={handleRenameLandSynced}
            onOpenProfile={(handle) => {
              if (handle) setProfileHandle(handle);
            }}
            onInspectSculpture={(sc) => {
              ar.setMapSelectedSculpture(sc);
            }}
            onOpenLandChat={(targetLand, canonicalTarget) => {
              const gate = evaluateArLandActionProximity(targetLand);
              if (!gate.canChatAtLand) {
                showTemporaryHint(
                  `Visit ${targetLand?.displayName || 'this land'} in person to join Land Chat.`
                );
                return;
              }
              chat.openCameraSelectedChat(
                canonicalTarget,
                targetLand?.distanceMeters ?? 0,
                chat.arPinPreview
              );
            }}
            onShowHint={showTemporaryHint}
            sensorStatus={pol.sensorStatus}
            onAdjustCompassNudge={pol.adjustCompassNudge}
            onResetCompassNudge={pol.resetCompassNudge}
            webxrSupported={pol.webxrSupported}
            webxrActive={pol.webxrActive}
            onToggleWebxr={handleToggleWebxr}
            onClose={handleExitArLand}
          />
        )}
      </div>

      {brush.mode === 'preview' && !isInteractingWithLand && (
        <div
          style={{
            position: 'fixed',
            bottom: 84,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            padding: '6px 12px',
            borderRadius: 999,
            background: 'rgba(8, 11, 20, 0.78)',
            border: '1px solid rgba(0, 245, 212, 0.4)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <span>AR Preview: {ar.nearbySculptures.length} nearby sculptures + your draft</span>
        </div>
      )}

      {!isWelcomeOpen && !parcelVisit && tutorialOpen && (
        <FirstRunTutorialModal
          onClose={(dontShow) => {
            if (dontShow) saveBoolPreference(TUTORIAL_SEEN_KEY, true);
            setTutorialOpen(false);
          }}
        />
      )}

      {sprayBrushGuideOpen && !isWelcomeOpen && !parcelVisit && !tutorialOpen && (
        <SprayBrushIntroModal onClose={() => setSprayBrushGuideOpen(false)} />
      )}

      {pairing.pairOpen && (
        <PairDesktopMcpModal
          user={user}
          videoRef={pol.videoRef}
          onCameraRefreshNeeded={pol.refreshCamera}
          pairCodeInput={pairing.pairCodeInput}
          setPairCodeInput={pairing.setPairCodeInput}
          pairedCode={pairing.pairedCode}
          pairError={pairing.pairError}
          onConnectPairCode={pairing.connectPairCode}
          onDisconnectDesktopPair={pairing.disconnectDesktopPair}
          mcpPairingsState={pairing.mcpPairingsState}
          mcpPairBusy={pairing.mcpPairBusy}
          mcpPairNotice={pairing.mcpPairNotice}
          setMcpPairNotice={pairing.setMcpPairNotice}
          repairNotice={pairing.repairNotice}
          onDismissRepairNotice={pairing.dismissRepairNotice}
          openPairHubSignal={openPairHubSignal}
          onCreateMcpPairing={pairing.handleCreateMcpPairing}
          onDisconnectMcpPairing={pairing.handleDisconnectMcpPairing}
          onClose={() => pairing.setPairOpen(false)}
        />
      )}

      {drafts.agentOpen && (
        <AgentHandoffModal
          agentBusy={drafts.agentBusy}
          agentError={drafts.agentError}
          agentSession={drafts.agentSession}
          agentCopied={drafts.agentCopied}
          setAgentCopied={drafts.setAgentCopied}
          onRefreshAgentDraft={drafts.refreshAgentDraft}
          onInspectInAR={() => {
            drafts.applyAgentSessionDraft(drafts.agentSession);
            drafts.setAgentOpen(false);
            brush.setMode('draw');
          }}
          onPublishOnPhone={() => {
            drafts.applyAgentSessionDraft(drafts.agentSession);
            drafts.setAgentOpen(false);
            openPublishSheet({ skipVoxelCheck: true });
          }}
          onClose={() => drafts.setAgentOpen(false)}
        />
      )}

      {catalogSearchOpen && (
        <MobileCatalogSearchModal
          busy={catalogPlaceBusy}
          disabled={!pol.calibrationReady}
          disabledReason={
            pol.calibrationLoss?.summary ||
            pol.calibrationReadiness?.subHint ||
            'Finish calibrating AR space before placing 3D items.'
          }
          placedItem={placedCatalogItem}
          onPlaceItem={handlePlaceMobileCatalogItem}
          onRemovePlacedItem={() => {
            clearPlacedCatalogItem();
            if (brush.mode === 'transform' && brush.voxels.length === 0) {
              brush.setMode('draw');
            }
            showTemporaryHint('Removed placed 3D item');
          }}
          onClose={() => setCatalogSearchOpen(false)}
        />
      )}

      {brush.mode === 'publish' && (
        <PublishSculptureModal
          config={config}
          user={user}
          voxels={brush.voxels}
          placedCatalogItem={placedCatalogItem}
          polStats={pol.polStats}
          location={pol.location}
          orbStatus={pol.orbStatus}
          activeQuest={activeQuest}
          selectedPlinthSlot={selectedPlinthSlot}
          activeTargetLand={activeInsideLand}
          passkeyCount={pol.passkeyCount}
          passkeyBusy={pol.passkeyBusy}
          onEnrollPasskey={pol.handleEnrollPasskey}
          title={title}
          setTitle={setTitle}
          description={description}
          setDescription={setDescription}
          cluePrompt={cluePrompt}
          setCluePrompt={setCluePrompt}
          clueAnswer={clueAnswer}
          setClueAnswer={setClueAnswer}
          termsAccepted={termsAccepted}
          setTermsAccepted={setTermsAccepted}
          publishing={publishing}
          publishError={publishError}
          setPublishError={setPublishError}
          mintReceipt={mintReceipt}
          mcpPairingsState={pairing.mcpPairingsState}
          agentPublishPrompt={pairing.agentPublishPrompt}
          draftsBusy={drafts.draftsBusy}
          draftStatusText={drafts.draftStatusText}
          onSubmitPublish={handlePublishSubmit}
          onCopyAgentPublishPrompt={handleCopyAgentPublishPrompt}
          onManualSaveDraft={drafts.handleManualSaveDraft}
          onOpenInfo={() => setInfoOpen(true)}
          onOpenPair={() => {
            brush.setMode('draw');
            pairing.setPairOpen(true);
          }}
          onOpenManageLand={(parcelId) => {
            brush.setMode('draw');
            lands.setLandManageParcelId(parcelId);
            lands.setLandManageOpen(true);
          }}
          onViewInARPreview={() => brush.setMode('preview')}
          onRequestLogin={() => {
            pendingPublishAfterLoginRef.current = { skipVoxelCheck: true };
            setPendingPublishAfterLogin(true);
            setLoginOpen(true);
          }}
          onShowHint={showTemporaryHint}
          onClose={() => brush.setMode('draw')}
        />
      )}

      {drafts.draftsOpen && (
        <SavedDraftsModal
          user={user}
          title={title}
          description={description}
          voxelsLength={brush.voxels.length}
          activeDraftId={drafts.activeDraftId}
          draftStatusText={drafts.draftStatusText}
          draftsBusy={drafts.draftsBusy}
          draftError={drafts.draftError}
          cloudDrafts={drafts.cloudDrafts}
          onManualSaveDraft={drafts.handleManualSaveDraft}
          onStartNewDraft={drafts.handleStartNewDraft}
          onRefreshCloudDrafts={drafts.refreshCloudDrafts}
          onLoadDraft={drafts.handleLoadDraft}
          onDeleteCloudDraft={drafts.handleDeleteCloudDraft}
          onOpenLogin={() => {
            drafts.setDraftsOpen(false);
            setLoginOpen(true);
          }}
          onClose={() => drafts.setDraftsOpen(false)}
        />
      )}

      {parcelVisit && (
        <MobileParcelVisitView
          parcel={parcelVisit.parcel}
          sculptures={parcelVisit.sculptures}
          allParcels={ar.mapParcels?.length > 0 ? ar.mapParcels : ar.nearbyParcels || []}
          user={user}
          ownedParcelIds={(lands.myLands?.parcels || []).map((p) => p.parcelId).filter(Boolean)}
          config={config}
          userLocation={pol.location}
          loading={parcelVisit.loading}
          error={parcelVisit.error}
          onSelectNeighborParcel={async (neighborParcel) => {
            if (!neighborParcel?.parcelId) return;
            setParcelVisit({
              loading: true,
              parcel: neighborParcel,
              sculptures: [],
              error: ''
            });
            try {
              const res = await api.getLandDetail(neighborParcel.parcelId);
              if (res?.parcel) {
                setParcelVisit({
                  loading: false,
                  parcel: res.parcel,
                  sculptures: res.sculptures || [],
                  error: ''
                });
              }
            } catch {
              setParcelVisit((prev) =>
                prev ? { ...prev, loading: false, error: 'Could not load neighboring land.' } : null
              );
            }
          }}
          onRefreshLocation={() => {
            navigator.geolocation?.getCurrentPosition?.(
              (pos) => {
                const nextLoc = {
                  lat: pos.coords.latitude,
                  lng: pos.coords.longitude,
                  accuracy: pos.coords.accuracy,
                  altitude: pos.coords.altitude
                };
                pol.setLocation(nextLoc);
                pol.locationRef.current = nextLoc;
              },
              () => {},
              { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
            );
          }}
          onViewInAR={(visitedParcel, visitedSculptures) => {
            const list = Array.isArray(visitedSculptures) ? visitedSculptures : [];
            if (pol.needsGyroTap) {
              pol.enableIosGyro();
            }
            brush.stopBrushPainting();
            setDockOpen(false);
            setTutorialOpen(false);
            setArSelectHint('');
            setArViewSession({
              source: 'plot',
              parcel: visitedParcel || null,
              sculptures: list
            });
            setArInspectorExpanded(false);
            brush.setMode('preview');
            if (visitedParcel?.parcelId) {
              ar.setNearbyParcels((prev) => {
                const existing = Array.isArray(prev) ? prev : [];
                const idx = existing.findIndex((p) => p?.parcelId === visitedParcel.parcelId);
                if (idx >= 0) {
                  const next = [...existing];
                  next[idx] = { ...next[idx], ...visitedParcel };
                  return next;
                }
                return [...existing, visitedParcel];
              });
              ar.selectArLand(visitedParcel, list);
            }
            setParcelVisit(null);
            ensureArCameraLive({ reason: 'view_in_ar' }).catch(() => {});
            if (list.length > 0) {
              ar.hydrateNearbyList(list, pol.locationRef.current || pol.location).catch(() => {});
            }
          }}
          onMakeArt={(visitedParcel) => {
            drawReturnSessionRef.current = {
              type: 'plot',
              parcel: visitedParcel,
              sculptures: parcelVisit?.sculptures || []
            };
            setParcelVisit(null);
            setTutorialOpen(false);
            setPreferredDrawLandId(visitedParcel?.parcelId || '');
            brush.setMode('draw');
            maybeShowSprayBrushGuide();
            showTemporaryHint(
              `Adding art to ${resolveLandDisplayName(visitedParcel, { defaultName: 'Virtual Land' })}!`
            );
          }}
          onSelectSculpture={(sc) => ar.setMapSelectedSculpture(sc)}
          onOpenManageLand={(pid) => {
            lands.setLandManageParcelId(pid || '');
            lands.setLandManageOpen(true);
          }}
          onOpenPair={() => {
            setParcelVisit(null);
            setOpenPairHubSignal({ tab: 'pair', ts: Date.now() });
          }}
          onOpenProfile={(handle) => {
            if (handle) setProfileHandle(handle);
          }}
          onModifyInCanvas={lands.startCanvasModification}
          onRequestLogin={() => setLoginOpen(true)}
          onPlotUpdated={({ parcel: nextParcel, sculptures: nextSculptures }) => {
            setParcelVisit((prev) =>
              prev
                ? {
                    ...prev,
                    parcel: nextParcel || prev.parcel,
                    sculptures: Array.isArray(nextSculptures) ? nextSculptures : prev.sculptures
                  }
                : prev
            );
            ar.loadPublicMapData();
            lands.refreshMyLands();
          }}
          onClose={() => setParcelVisit(null)}
        />
      )}

      {ar.mapOpen && (
        <MobileMapSheet
          user={user}
          ownedParcelIds={(lands.myLands?.parcels || []).map((p) => p.parcelId).filter(Boolean)}
          config={config}
          location={pol.location}
          areaFilterMode={ar.areaFilterMode}
          setAreaFilterMode={ar.setAreaFilterMode}
          mapLoading={ar.mapLoading}
          loadPublicMapData={ar.loadPublicMapData}
          displayedMapSculptures={ar.displayedMapSculptures}
          areaSculpturesSorted={ar.areaSculpturesSorted}
          mapParcels={ar.mapParcels}
          pendingSignatures={pairing.pendingSignatures}
          mapSelectedSculpture={ar.mapSelectedSculpture}
          selectedParcelId={ar.mapSelectedParcelId}
          focusParcelTick={ar.mapFocusParcelTick}
          initialDimensionMode={ar.mapInitialDimensionMode}
          onSelectParcel={ar.focusMapParcel}
          onSelectSculpture={ar.setMapSelectedSculpture}
          onMarkLandSeen={markSeenLand}
          onFindLandInAR={(land) => {
            if (!land?.parcelId) return;
            markSeenLand(
              land.parcelId,
              Array.isArray(land.sculptures) ? land.sculptures.length : null
            );
            if (pol.needsGyroTap) {
              pol.enableIosGyro();
            }
            brush.stopBrushPainting();
            setDockOpen(false);
            setArSelectHint('');
            setArViewSession({
              source: 'map',
              parcel: land,
              sculptures: Array.isArray(land.sculptures) ? land.sculptures : []
            });
            setArInspectorExpanded(false);
            ar.setMapOpen(false);
            brush.setMode('preview');
            ar.selectArLand(land, land.sculptures || []);
            ensureArCameraLive({ reason: 'find_in_ar' }).catch(() => {});
          }}
          onOpenProfile={(handle) => {
            if (handle) setProfileHandle(handle);
          }}
          onManageLand={(pid) => {
            ar.setMapOpen(false);
            lands.setLandManageParcelId(pid || '');
            lands.setLandManageOpen(true);
          }}
          onRenameLand={handleRenameLandSynced}
          onShowHint={showTemporaryHint}
          onClose={() => ar.setMapOpen(false)}
        />
      )}

      {ar.mapSelectedSculpture && (
        <SculptureModal
          sculpture={ar.mapSelectedSculpture}
          user={user}
          config={config}
          userLocation={pol.location}
          allParcels={ar.mapParcels}
          allSculptures={ar.mapSculptures}
          onSelectParcel={(parcelObj) => {
            if (parcelObj?.parcelId) {
              navigateToLandById(parcelObj.parcelId);
            }
          }}
          onSelectSculpture={(sc) => ar.setMapSelectedSculpture(sc)}
          onRequestLogin={() => setLoginOpen(true)}
          onSculptureUpdated={(updated, extra = {}) => {
            if (!extra?.keepActiveSelection) {
              ar.setMapSelectedSculpture(updated);
            }
            const pushedMap = new Map(
              (Array.isArray(extra?.pushedSiblings) ? extra.pushedSiblings : []).map((p) => [
                p.id,
                p
              ])
            );
            const applyRowUpdate = (item) => {
              if (item.id === updated.id) return { ...item, ...updated };
              const pushed = pushedMap.get(item.id);
              if (!pushed) return item;
              return {
                ...item,
                anchorOffset: {
                  ...(item.anchorOffset || {}),
                  dx: pushed.dx,
                  dy: pushed.dy,
                  dz: pushed.dz
                }
              };
            };
            ar.setMapSculptures((prev) => prev.map(applyRowUpdate));
            setParcelVisit((prev) =>
              prev
                ? {
                    ...prev,
                    sculptures: (prev.sculptures || []).map(applyRowUpdate)
                  }
                : prev
            );
            ar.loadPublicMapData();
            lands.refreshMyLands();
          }}
          onSculptureDeleted={(deletedId) => {
            ar.setMapSculptures((prev) => prev.filter((item) => item.id !== deletedId));
            setParcelVisit((prev) =>
              prev
                ? {
                    ...prev,
                    sculptures: (prev.sculptures || []).filter((item) => item.id !== deletedId)
                  }
                : prev
            );
            ar.loadPublicMapData();
            lands.refreshMyLands();
          }}
          onModifyInCanvas={lands.startCanvasModification}
          onOpenLandManagement={(pid) => {
            ar.setMapOpen(false);
            lands.setLandManageParcelId(pid || '');
            lands.setLandManageOpen(true);
          }}
          onApprovePending={async (reqItem, options = {}) => {
            if (!reqItem?.id) return;
            const res = await pairing.handleMobileSignPending(reqItem, options);
            if (res) {
              ar.setMapSelectedSculpture(null);
              setNotifRefreshBump((n) => n + 1);
            }
          }}
          onRejectPending={async (reqItem) => {
            if (!reqItem?.id) return;
            await pairing.handleMobileRejectPending(reqItem.id);
            ar.setMapSelectedSculpture(null);
            setNotifRefreshBump((n) => n + 1);
          }}
          pendingApprovalBusy={Boolean(
            ar.mapSelectedSculpture?.pendingRequestId &&
              pairing.pendingSigBusyId === ar.mapSelectedSculpture.pendingRequestId
          )}
          pendingApprovalError={
            ar.mapSelectedSculpture?.pendingRequestId
              ? pairing.pendingSigErrors?.[ar.mapSelectedSculpture.pendingRequestId] || null
              : null
          }
          onClose={() => ar.setMapSelectedSculpture(null)}
        />
      )}

      {lands.landManageOpen && user && (
        <LandManagementModal
          user={user}
          initialParcelId={lands.landManageParcelId}
          userLocation={pol.location}
          onSelectSculpture={(sc) => ar.setMapSelectedSculpture(sc)}
          onFocusParcel={() => {
            lands.setLandManageOpen(false);
            ar.setMapOpen(true);
          }}
          onWorkspaceChanged={async () => {
            await lands.refreshMyLands();
            ar.loadPublicMapData();
            if (pol.location) {
              api
                .listSculptures({ lat: pol.location.lat, lng: pol.location.lng, radiusMeters: 300 })
                .then((res) => ar.setNearbySculptures(res.sculptures || []))
                .catch(() => {});
            }
          }}
          onClose={() => lands.setLandManageOpen(false)}
        />
      )}

      {chat.chatSelection && (
        <SculptureChatDrawer
          sculpture={chat.chatSelection.sculpture}
          user={user}
          location={pol.location}
          polTracker={pol.polRef.current}
          cameraReady={pol.cameraReady}
          initialSightProof={chat.chatSelection.sightProof}
          initialPinData={chat.chatSelection.pinData}
          onRequestLogin={() => setLoginOpen(true)}
          onClose={() => chat.setChatSelection(null)}
        />
      )}

      {profileHandle && (
        <ProfileModal
          handle={profileHandle}
          user={user}
          config={config}
          onUserUpdate={(nextUser) => {
            if (
              profileHandle &&
              user?.username &&
              profileHandle.toLowerCase() === user.username.toLowerCase() &&
              nextUser?.username
            ) {
              setProfileHandle(nextUser.username);
            }
            onUserUpdate(nextUser);
          }}
          onSelectSculpture={(sc) => ar.setMapSelectedSculpture(sc)}
          onOpenMintGuide={() => {
            setInfoInitialTab('mint');
            setInfoOpen(true);
          }}
          onOpenLand={(land) => {
            if (!land?.parcelId) return;
            setProfileHandle('');
            setParcelVisit({ loading: true, parcel: null, sculptures: [], error: '' });
            api
              .getLandDetail(land.parcelId)
              .then((res) => {
                setParcelVisit({
                  loading: false,
                  parcel: res?.parcel || null,
                  sculptures: res?.sculptures || [],
                  error: res?.parcel ? '' : 'Land parcel not found.'
                });
              })
              .catch((err) => {
                setParcelVisit({
                  loading: false,
                  parcel: null,
                  sculptures: [],
                  error: err?.message || 'Could not load parcel.'
                });
              });
          }}
          onOpenWalletSettings={() => {
            setInfoInitialTab('account');
            setInfoOpen(true);
          }}
          onLogout={() => {
            onLogout();
            setProfileHandle('');
          }}
          onShowHint={showTemporaryHint}
          onClose={() => setProfileHandle('')}
        />
      )}

      {infoOpen && (
        <InfoTermsModal
          config={config}
          user={user}
          initialTab={infoInitialTab}
          onUserUpdate={onUserUpdate}
          onOpenProfile={() => user && setProfileHandle(user.username || user.id)}
          onOpenArchive={(archId = '') => {
            setArchiveInitialId(archId || '');
            setArchiveOpen(true);
          }}
          onStartMobileDraw={() => {
            setInfoOpen(false);
            setInfoInitialTab('guide');
          }}
          onOpenMobileMap={() => {
            setInfoOpen(false);
            setInfoInitialTab('guide');
            ar.openAreaMap();
          }}
          onLogout={() => {
            onLogout();
            setInfoOpen(false);
          }}
          onRequestLogin={() => {
            setInfoOpen(false);
            setLoginOpen(true);
          }}
          onClose={() => {
            setInfoOpen(false);
            setInfoInitialTab('guide');
          }}
        />
      )}

      {archiveOpen && (
        <LandArchiveModal
          initialArchiveId={archiveInitialId}
          onClose={() => {
            setArchiveOpen(false);
            setArchiveInitialId('');
          }}
        />
      )}

      {loginOpen && (
        <GoogleLoginGate
          config={config}
          subtitle={
            pendingPublishAfterLogin
              ? 'Sign in with Google to publish your 3D art.'
              : ''
          }
          onSuccess={(u) => {
            onUserUpdate(u);
            setLoginOpen(false);
            const pending = pendingPublishAfterLoginRef.current;
            pendingPublishAfterLoginRef.current = null;
            setPendingPublishAfterLogin(false);
            if (pending) {
              openPublishSheet({
                skipVoxelCheck: Boolean(pending.skipVoxelCheck),
                userOverride: u
              });
            }
          }}
          onClose={() => {
            pendingPublishAfterLoginRef.current = null;
            setPendingPublishAfterLogin(false);
            setLoginOpen(false);
          }}
        />
      )}
    </div>
    </NotificationProvider>
  );
}
