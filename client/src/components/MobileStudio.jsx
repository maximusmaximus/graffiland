import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { api } from '../utils/api.js';
import {
  loadBoolPreference,
  loadLocalDraft,
  QUICK_SCULPT_KEY,
  saveBoolPreference,
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
import LandManagementModal from './LandManagementModal.jsx';
import SculptureChatDrawer from './SculptureChatDrawer.jsx';
import SculptureModal from './SculptureModal.jsx';
import {
  AgentHandoffModal,
  PairDesktopMcpModal,
  SavedDraftsModal
} from './studio/AgentPairModals.jsx';
import ARViewportCanvas from './studio/ARViewportCanvas.jsx';
import FirstRunTutorialModal from './studio/FirstRunTutorialModal.jsx';
import MobileMapSheet from './studio/MobileMapSheet.jsx';
import PublishSculptureModal from './studio/PublishSculptureModal.jsx';
import SceneCoverageWidget from './studio/SceneCoverageWidget.jsx';
import StudioDockDrawer from './studio/StudioDockDrawer.jsx';
import StudioHudTopBar from './studio/StudioHudTopBar.jsx';
import ToolCarouselBar from './studio/ToolCarouselBar.jsx';
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
  const [loginOpen, setLoginOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(
    () => !loadBoolPreference(TUTORIAL_SEEN_KEY, false)
  );
  useEffect(() => {
    if (skipTutorialSignal > 0) {
      setTutorialOpen(false);
    }
  }, [skipTutorialSignal]);
  const [quickSculpt, setQuickSculpt] = useState(
    () => loadBoolPreference(QUICK_SCULPT_KEY, false)
  );
  const [arSelectHint, setArSelectHint] = useState('');
  const hintTimerRef = useRef(null);

  // Metadata & Publish Form State
  const [title, setTitle] = useState(initialDraft.title || '');
  const [description, setDescription] = useState(initialDraft.description || '');
  const [cluePrompt, setCluePrompt] = useState(initialDraft.cluePrompt || '');
  const [clueAnswer, setClueAnswer] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [publishing, setPublishing] = useState(false);
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
    return () => {
      cancelled = true;
    };
  }, [pol.location]);

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

  const showTemporaryHint = useCallback((msg) => {
    setArSelectHint(msg);
    clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setArSelectHint(''), 4200);
  }, []);

  const onLocationUpdateBridgeRef = useRef(null);

  const pol = useProofOfLocation({
    user,
    dirLightRef,
    onLocationUpdate: (loc, refined) => onLocationUpdateBridgeRef.current?.(loc, refined)
  });

  // Refs bridging actions between circularly-related hooks cleanly
  const openAgentHandoffRef = useRef(null);
  const openPublishSheetRef = useRef(null);
  const openCameraSelectedChatRef = useRef(null);
  const arPinPreviewRef = useRef(null);

  // Brush & Canvas hook (receives AR + Chat bridges via refs initialized right below)
  const openAgentCaller = useRef((...a) => openAgentHandoffRef.current?.(...a));
  const openPublishCaller = useRef((...a) => openPublishSheetRef.current?.(...a));
  const arTargetedIdRef = useRef('');
  const setArTargetedSculptureBridgeRef = useRef(null);

  const brush = useVoxelBrush({
    config,
    initialDraft,
    user,
    location: pol.location,
    locationRef: pol.locationRef,
    cameraReady: pol.cameraReady,
    sceneScan: pol.sceneScan,
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
    openAgentHandoffRef: openAgentCaller,
    openPublishSheetRef: openPublishCaller
  });

  const ar = useARPreview({
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
    showTemporaryHint
  });

  setArTargetedSculptureBridgeRef.current = ar.setArTargetedSculpture;
  arTargetedIdRef.current = ar.arTargetedIdRef.current;

  onLocationUpdateBridgeRef.current = async (loc, refined) => {
    const res = await api.listSculptures({
      lat: loc.lat,
      lng: loc.lng,
      radiusMeters: 300,
      includeVoxels: false
    });
    await ar.hydrateNearbyList(res.sculptures || [], refined);
  };

  // Support deep link ?sculpture=<id> directly on mobile too
  const { setMapSelectedSculpture } = ar;
  useEffect(() => {
    const deepId = new URLSearchParams(window.location.search).get('sculpture');
    if (!deepId) return;
    api
      .getSculpture(deepId)
      .then((res) => {
        if (res?.sculpture) setMapSelectedSculpture(res.sculpture);
      })
      .catch(() => {});
  }, [setMapSelectedSculpture]);

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
    showTemporaryHint
  });
  openAgentHandoffRef.current = drafts.openAgentHandoff;

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
    showTemporaryHint
  });

  const openPublishSheet = useCallback(
    ({ skipVoxelCheck = false } = {}) => {
      if (!skipVoxelCheck) {
        if (!brush.ensureToolUsable('publish')) return;
      } else {
        if (!pol.locationRef.current && !pol.location) {
          brush.notifyToolUnavailable(
            'publish',
            'Wait for a GPS location fix first before publishing on-chain.'
          );
          return;
        }
        if (!pol.cameraReadyRef.current) {
          brush.notifyToolUnavailable(
            'publish',
            'Enable live camera access first for Proof of Location before publishing.'
          );
          return;
        }
        const cov = pol.polRef.current.getSceneCoverage();
        if (!cov.optimal) {
          brush.notifyToolUnavailable(
            'publish',
            `Move your phone around to finish mapping this space (${cov.scannedCount}/${cov.targetCount} angles for 100% lock) before publishing.`
          );
          return;
        }
        if (!user) {
          brush.notifyToolUnavailable(
            'publish',
            'Sign in with Google first before publishing & minting on-chain.'
          );
          return;
        }
      }
      setPublishError('');
      setMintReceipt(null);
      if (brush.modeRef.current === 'transform') {
        brush.commitTransformAndExit('publish');
      } else {
        brush.setMode('publish');
      }
    },
    [brush, pol, user]
  );
  openPublishSheetRef.current = openPublishSheet;

  const handleDesktopCommand = useCallback(
    (msg) => {
      if (msg.action === 'set_color' && msg.color) brush.setColor(msg.color);
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
    [ar, brush, drafts, lands, pol]
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
    onDelegatedPublishExecuted: resetFormAfterPublish
  });

  const handlePublishSubmit = async (e) => {
    e.preventDefault();
    setPublishing(true);
    setPublishError('');
    try {
      const location = pol.location;
      if (!location) {
        throw new Error('Waiting for GPS location fix before publishing.');
      }
      const previewDataUrl = captureSculptureSnapshot();
      const polSnap = pol.polRef.current.getSnapshot();
      const refinedAnchor = pol.polRef.current.getRefinedLocation(location) || location;
      const tr = brush.artTransformRef.current;
      const anchorOffset = {
        dx: Number(tr.offsetX || 0),
        dy: Number(tr.offsetY || 0),
        dz: Number(tr.offsetZ || 0),
        yaw: THREE.MathUtils.degToRad(Number(tr.rotYDeg || 0))
      };
      const res = await api.publishSculpture({
        title,
        description,
        termsAccepted,
        voxels: brush.voxels,
        anchorOffset,
        previewDataUrl,
        questId: activeQuest?.id || '',
        plinthSlotId: selectedPlinthSlot?.id || '',
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

      if (res?.sculpture?.parcelId && pol.orbKeyframesRef.current.size > 0) {
        const kfs = Array.from(pol.orbKeyframesRef.current.values());
        const totalFeatures = kfs.reduce((sum, kf) => sum + (kf.features?.length || 0), 0);
        if (totalFeatures >= 12) {
          api
            .saveParcelLandmarkPack(res.sculpture.parcelId, {
              geohash: res.sculpture.geohash,
              keyframes: kfs,
              allowInitialClaim: true
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
    } catch (err) {
      setPublishError(err.message || 'Publish failed');
    } finally {
      setPublishing(false);
    }
  };

  const handleCopyAgentPublishPrompt = async () => {
    setPublishing(true);
    setPublishError('');
    try {
      const location = pol.location;
      if (!location) {
        throw new Error('Waiting for GPS location fix before creating agent publish request.');
      }
      const activePairingCode = pairing.mcpPairingsState.activePairing?.code;
      if (!activePairingCode) {
        throw new Error('Connect a robust MCP pairing code first before delegating signing.');
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

  const handleToggleQuickSculpt = useCallback(() => {
    setQuickSculpt((prev) => {
      const next = !prev;
      saveBoolPreference(QUICK_SCULPT_KEY, next);
      showTemporaryHint(
        next ? '⚡ Quick Sculpt ON (simplified tools)' : 'Pro Studio HUD restored'
      );
      return next;
    });
  }, [showTemporaryHint]);

  return (
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
        occlusionEnabledRef={brush.occlusionEnabledRef}
        rawOrientationRef={pol.rawOrientationRef}
        yawOffsetRef={pol.yawOffsetRef}
        fallbackEulerRef={pol.fallbackEulerRef}
        wsRef={pairing.wsRef}
        locationRef={pol.locationRef}
        arTargetedIdRef={ar.arTargetedIdRef}
        setArTargetedSculpture={ar.setArTargetedSculpture}
        mode={brush.mode}
        modeRef={brush.modeRef}
        toolRef={brush.toolRef}
        colorRef={brush.colorRef}
        voxelsRef={brush.voxelsRef}
        paintingRef={brush.paintingRef}
        lastPaintPosRef={brush.lastPaintPosRef}
        lastStackAtRef={brush.lastStackAtRef}
        surfaceAnchorRef={brush.surfaceAnchorRef}
        lastScanUiRef={pol.lastScanUiRef}
        lastUnmappedMaskRef={pol.lastUnmappedMaskRef}
        mappingCompletedNoticeShownRef={pol.mappingCompletedNoticeShownRef}
        setSceneScan={pol.setSceneScan}
        setUnmappedGrid={pol.setUnmappedGrid}
        setOrbStatus={pol.setOrbStatus}
        showTemporaryHint={showTemporaryHint}
        cameraReady={pol.cameraReady}
        sceneScanOptimal={pol.sceneScan.optimal}
        unmappedGrid={pol.unmappedGrid}
        computeTargetVoxel={brush.computeTargetVoxel}
        applyVoxelBatch={brush.applyVoxelBatch}
        applyVoxelAction={brush.applyVoxelAction}
        eraseTargetVoxel={brush.eraseTargetVoxel}
        rebuildDraftMesh={brush.rebuildDraftMesh}
        onCanvasPointerDown={brush.handleCanvasPointerDown}
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
          voxels={brush.voxels}
          quickSculpt={quickSculpt}
          onToggleQuickSculpt={handleToggleQuickSculpt}
          onOpenTutorial={() => setTutorialOpen(true)}
          onOpenInfo={() => setInfoOpen(true)}
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
          gyroFallbackActive={pol.gyroFallbackActive}
          cameraReady={pol.cameraReady}
          onEnableIosGyro={pol.enableIosGyro}
          onRetryCameraAccess={pol.retryCameraAccess}
          sensorBanner={pol.sensorBanner}
          arTargetedSculpture={ar.arTargetedSculpture}
          arPinPreview={chat.arPinPreview}
          passkeyBusy={pol.passkeyBusy}
          onEnrollPasskeyAndRetryPin={chat.enrollPasskeyAndRetryPinUnlock}
          onOpenCameraSelectedChat={chat.openCameraSelectedChat}
          arSelectHint={arSelectHint}
          originStatus={brush.originStatus}
          sceneScan={pol.sceneScan}
          onOpenLoginFromHint={() => {
            setArSelectHint('');
            setLoginOpen(true);
          }}
          pendingSignatures={pairing.pendingSignatures}
          pendingSigBusyId={pairing.pendingSigBusyId}
          onMobileSignPending={pairing.handleMobileSignPending}
          onMobileRejectPending={pairing.handleMobileRejectPending}
          mapOpen={ar.mapOpen}
          nearbyCount={ar.nearbySculptures.length}
          onOpenAreaMap={ar.openAreaMap}
          activeQuest={activeQuest}
          selectedPlinthSlot={selectedPlinthSlot}
          onSnapToPlinthSlot={handleSnapToPlinthSlot}
        />

        <ToolCarouselBar
          quickSculpt={quickSculpt}
          activeKeyTool={brush.activeKeyTool}
          toolAvailability={brush.toolAvailability}
          canTouch={canTouch}
          swipeDragPx={brush.swipeDragPx}
          isDraggingKey={brush.isDraggingKey}
          painting={brush.painting}
          mode={brush.mode}
          dockOpen={dockOpen}
          voxelsLength={brush.voxels.length}
          artTransform={brush.artTransform}
          onSetArtTransform={brush.setArtTransform}
          onToggleTransformLock={brush.toggleTransformLock}
          onStepKeyTool={brush.stepKeyTool}
          onKeyPointerDown={brush.handleKeyPointerDown}
          onKeyPointerMove={brush.handleKeyPointerMove}
          onKeyPointerUp={brush.handleKeyPointerUp}
          onKeyPointerCancel={brush.handleKeyPointerCancel}
        />

        <SceneCoverageWidget
          sceneScan={pol.sceneScan}
          orbStatus={pol.orbStatus}
          scanBoxCollapsed={pol.scanBoxCollapsed}
          onToggleCollapse={() => pol.setScanBoxCollapsed((v) => !v)}
          dockOpen={dockOpen}
          mode={brush.mode}
          onRefreshOrbRescan={ar.handleRefreshOrbRescan}
        />

        <StudioDockDrawer
          quickSculpt={quickSculpt}
          dockOpen={dockOpen}
          onToggleDock={() => setDockOpen((v) => !v)}
          paletteOpen={brush.paletteOpen}
          onTogglePalette={() => brush.setPaletteOpen((p) => !p)}
          mode={brush.mode}
          modeRef={brush.modeRef}
          tool={brush.tool}
          setMode={brush.setMode}
          setTool={brush.setTool}
          color={brush.color}
          setColor={brush.setColor}
          material={brush.material}
          setMaterial={brush.setMaterial}
          reachMeters={brush.reachMeters}
          setReachMeters={brush.setReachMeters}
          occlusionEnabled={brush.occlusionEnabled}
          setOcclusionEnabled={brush.setOcclusionEnabled}
          draftsOpen={drafts.draftsOpen}
          activeDraftId={drafts.activeDraftId}
          draftStatusText={drafts.draftStatusText}
          pairedCode={pairing.pairedCode}
          agentOpen={drafts.agentOpen}
          agentSessionCode={drafts.agentSession?.code}
          toolAvailability={brush.toolAvailability}
          ensureToolUsable={brush.ensureToolUsable}
          getDockHoldHandlers={brush.getDockHoldHandlers}
          commitTransformAndExit={brush.commitTransformAndExit}
          onClearCanvas={brush.clearCanvas}
          onToggleTransformLock={brush.toggleTransformLock}
          onUndo={brush.handleUndo}
          onRecenterAim={pol.recenterAim}
          onOpenDraftsSheet={drafts.openDraftsSheet}
          onOpenPairModal={() => pairing.setPairOpen(true)}
          onOpenAgentHandoff={drafts.openAgentHandoff}
          onOpenPublishSheet={openPublishSheet}
        />
      </div>

      {brush.mode === 'preview' && (
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

      {!isWelcomeOpen && tutorialOpen && (
        <FirstRunTutorialModal
          quickSculpt={quickSculpt}
          onToggleQuickSculpt={handleToggleQuickSculpt}
          onClose={(dontShow) => {
            if (dontShow) saveBoolPreference(TUTORIAL_SEEN_KEY, true);
            setTutorialOpen(false);
          }}
        />
      )}

      {pairing.pairOpen && (
        <PairDesktopMcpModal
          user={user}
          pairCodeInput={pairing.pairCodeInput}
          setPairCodeInput={pairing.setPairCodeInput}
          pairedCode={pairing.pairedCode}
          pairError={pairing.pairError}
          onConnectPairCode={pairing.connectPairCode}
          mcpPairingsState={pairing.mcpPairingsState}
          mcpPairBusy={pairing.mcpPairBusy}
          mcpPairNotice={pairing.mcpPairNotice}
          setMcpPairNotice={pairing.setMcpPairNotice}
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

      {brush.mode === 'publish' && (
        <PublishSculptureModal
          config={config}
          user={user}
          voxels={brush.voxels}
          polStats={pol.polStats}
          location={pol.location}
          orbStatus={pol.orbStatus}
          activeQuest={activeQuest}
          selectedPlinthSlot={selectedPlinthSlot}
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

      {ar.mapOpen && (
        <MobileMapSheet
          config={config}
          location={pol.location}
          areaFilterMode={ar.areaFilterMode}
          setAreaFilterMode={ar.setAreaFilterMode}
          mapLoading={ar.mapLoading}
          loadPublicMapData={ar.loadPublicMapData}
          displayedMapSculptures={ar.displayedMapSculptures}
          areaSculpturesSorted={ar.areaSculpturesSorted}
          mapParcels={ar.mapParcels}
          mapSelectedSculpture={ar.mapSelectedSculpture}
          onSelectSculpture={ar.setMapSelectedSculpture}
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
          onSculptureUpdated={(updated) => {
            ar.setMapSelectedSculpture(updated);
            ar.setMapSculptures((prev) =>
              prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
            );
            lands.refreshMyLands();
          }}
          onModifyInCanvas={lands.startCanvasModification}
          onOpenLandManagement={(pid) => {
            ar.setMapOpen(false);
            lands.setLandManageParcelId(pid || '');
            lands.setLandManageOpen(true);
          }}
          onClose={() => ar.setMapSelectedSculpture(null)}
        />
      )}

      {lands.landManageOpen && user && (
        <LandManagementModal
          user={user}
          initialParcelId={lands.landManageParcelId}
          onSelectSculpture={(sc) => ar.setMapSelectedSculpture(sc)}
          onWorkspaceChanged={async () => {
            await lands.refreshMyLands();
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

      {infoOpen && (
        <InfoTermsModal
          config={config}
          user={user}
          onUserUpdate={onUserUpdate}
          onLogout={() => {
            onLogout();
            setInfoOpen(false);
          }}
          onRequestLogin={() => {
            setInfoOpen(false);
            setLoginOpen(true);
          }}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {loginOpen && (
        <GoogleLoginGate
          config={config}
          onSuccess={(u) => {
            onUserUpdate(u);
            setLoginOpen(false);
          }}
          onClose={() => setLoginOpen(false)}
        />
      )}
    </div>
  );
}
