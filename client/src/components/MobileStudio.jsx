import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  CHAT_SIGHT_CLIENT_DISTANCE_M,
  haversineMeters
} from '../../../shared/chatPolicy.mjs';
import { api } from '../utils/api.js';
import { AREA_HALF_SPAN_METERS, AREA_LIMIT_BLOCKS } from '../../../shared/constants.mjs';

const KEY_TOOLS = [
  { id: 'brush', emoji: '🖌️', label: 'Brush', hint: 'Hold to spray 4x voxels' },
  { id: 'stack', emoji: '🧱', label: 'Stack', hint: 'Aim face & tap to stack' },
  { id: 'erase', emoji: '🧽', label: 'Erase', hint: 'Hold to erase blocks continuously' },
  { id: 'transform', emoji: '✅', label: 'Lock & Scale', hint: 'Lock art to scale & transform' },
  { id: 'preview', emoji: '👁️', label: 'Preview', hint: 'AR preview & E2EE chat' },
  { id: 'agent', emoji: '📋', label: 'Agent Code', hint: 'Copy code for AI agent build' },
  { id: 'publish', emoji: '🚀', label: 'Publish', hint: 'Review & mint on your phone' }
];
import {
  computeRoomPossessionProof,
  generateRoomKeyB64,
  getOrCreateDeviceIdentity,
  loadLocalRoomKey,
  saveLocalRoomKey,
  wrapRoomKeyForRecipient,
  wrapRoomKeyWithClue
} from '../utils/chatCrypto.js';
import { getWsUrl } from '../utils/device.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import MapView from './MapView.jsx';
import SculptureChatDrawer from './SculptureChatDrawer.jsx';
import SculptureModal from './SculptureModal.jsx';
import { ForegroundOcclusionCompositor } from './ForegroundOcclusion.js';
import { ProofOfLocationTracker } from './ProofOfLocation.js';
import {
  buildVoxelGroup,
  computeSolarLightVector,
  createLiveEnvUpdater,
  createVoxelMaterial,
  deviceOrientationToQuaternion,
  GRAFFITI_PALETTE,
  latLngOffsetMeters,
  snapCoord,
  VOXEL_STEP,
  voxelKey
} from './VoxelEngine3D.js';
import XeroIcon from './XeroIcon.jsx';

const LOCAL_DRAFT_KEY = 'graffiland_studio_draft_v1';

function loadLocalDraft() {
  try {
    const raw = localStorage.getItem(LOCAL_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveLocalDraft(draft) {
  try {
    localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // ignore storage quota errors on restricted modes
  }
}

function clearLocalDraft() {
  try {
    localStorage.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    // ignore
  }
}

export default function MobileStudio({ config, user, onUserUpdate, onLogout }) {
  const initialDraftRef = useRef(undefined);
  if (initialDraftRef.current === undefined) {
    initialDraftRef.current = loadLocalDraft() || {};
  }
  const initialDraft = initialDraftRef.current;
  const videoRef = useRef(null);
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
  const draftMeshMapRef = useRef(new Map());
  const draftUnitGeoRef = useRef(null);
  const draftMatCacheRef = useRef(new Map());
  const dirLightRef = useRef(null);
  const hemiLightRef = useRef(null);
  const occlusionWallRef = useRef(null);
  const envUpdaterRef = useRef(null);
  const occlusionRef = useRef(new ForegroundOcclusionCompositor());
  const polRef = useRef(new ProofOfLocationTracker());
  const wsRef = useRef(null);

  // Studio states
  const [mode, setMode] = useState('draw'); // 'draw' | 'transform' | 'preview' | 'publish'
  const [tool, setTool] = useState('brush'); // 'brush' | 'stack' | 'erase'
  const [material, setMaterial] = useState(
    initialDraft.material === 'neon' || initialDraft.material === 'glass'
      ? initialDraft.material
      : 'matte'
  ); // 'matte' | 'neon' | 'glass'
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
  const [nearbySculptures, setNearbySculptures] = useState([]);

  // Draft persistence states
  const [activeDraftId, setActiveDraftId] = useState(initialDraft.activeDraftId || '');
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [cloudDrafts, setCloudDrafts] = useState([]);
  const [draftsBusy, setDraftsBusy] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftStatusText, setDraftStatusText] = useState(() =>
    Array.isArray(initialDraft.voxels) && initialDraft.voxels.length > 0
      ? `Restored ${initialDraft.voxels.length} blocks`
      : ''
  );

  // Minimal HUD visibility: starts ultra-clean with "i" + compact trigger; expands tool dock on demand
  const [dockOpen, setDockOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [occlusionEnabled, setOcclusionEnabled] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [chatSelection, setChatSelection] = useState(null);
  const [arTargetedSculpture, setArTargetedSculpture] = useState(null);
  const [arSelectHint, setArSelectHint] = useState('');

  // Pairing
  const [pairCodeInput, setPairCodeInput] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('pair') || '';
    return p.toUpperCase();
  });
  const [pairedCode, setPairedCode] = useState('');
  const [pairError, setPairError] = useState('');

  // Sensors & PoL
  const [cameraReady, setCameraReady] = useState(false);
  const [sensorBanner, setSensorBanner] = useState('');
  const [needsGyroTap, setNeedsGyroTap] = useState(false);
  const [location, setLocation] = useState(null);
  const [polStats, setPolStats] = useState({ frames: 0, gyro: 0, flow: 0 });
  const [sceneScan, setSceneScan] = useState({
    coveragePct: 0,
    scannedCount: 0,
    targetCount: 9,
    sectors: Array(12).fill(false),
    cursorX: 0.5,
    cursorY: 0.5,
    optimal: false,
    precisionMeters: 2.4,
    hint: 'Move phone around scene'
  });
  const [scanBoxCollapsed, setScanBoxCollapsed] = useState(false);
  const [unmappedGrid, setUnmappedGrid] = useState(() => Array(48).fill(false));
  const [originStatus, setOriginStatus] = useState({
    originBlocked: false,
    originVisible: true,
    reason: ''
  });
  const originStatusRef = useRef({
    originBlocked: false,
    originVisible: true,
    reason: ''
  });
  const lastUnmappedMaskRef = useRef('');
  const mappingCompletedNoticeShownRef = useRef(false);
  const originBeaconMatRef = useRef(null);
  const lastScanUiRef = useRef({
    coveragePct: -1,
    scannedCount: -1,
    optimal: false,
    cursorX: -1,
    cursorY: -1,
    hint: ''
  });
  const [painting, setPainting] = useState(false);
  const [surfaceAnchor, setSurfaceAnchor] = useState(() => initialDraft.surfaceAnchor || null);
  const surfaceAnchorRef = useRef(initialDraft.surfaceAnchor || null);
  useEffect(() => {
    surfaceAnchorRef.current = surfaceAnchor;
  }, [surfaceAnchor]);
  const [artTransform, setArtTransform] = useState({
    scale: 1,
    rotYDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0
  });
  const [transformPivot, setTransformPivot] = useState({ x: 0, y: 0, z: 0 });
  const artTransformRef = useRef(artTransform);
  const transformPivotRef = useRef(transformPivot);
  useEffect(() => {
    artTransformRef.current = artTransform;
  }, [artTransform]);
  useEffect(() => {
    transformPivotRef.current = transformPivot;
  }, [transformPivot]);
  const [activeKeyTool, setActiveKeyTool] = useState('brush');
  const activeKeyToolRef = useRef('brush');
  const [swipeDragPx, setSwipeDragPx] = useState(0);
  const [isDraggingKey, setIsDraggingKey] = useState(false);
  const [canTouch, setCanTouch] = useState(() => {
    if (typeof window === 'undefined') return true;
    const coarse = window.matchMedia?.('(any-pointer: coarse), (pointer: coarse)')?.matches;
    return Boolean(coarse || navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
  });
  const [mapOpen, setMapOpen] = useState(false);
  const [areaFilterMode, setAreaFilterMode] = useState('nearby'); // 'nearby' | 'all'
  const [mapSculptures, setMapSculptures] = useState([]);
  const [mapParcels, setMapParcels] = useState([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSelectedSculpture, setMapSelectedSculpture] = useState(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentCopied, setAgentCopied] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [agentSession, setAgentSession] = useState(null);
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
  const lastAppliedAgentTsRef = useRef('');

  // Orientation & fallback pan
  const yawOffsetRef = useRef(0);
  const rawOrientationRef = useRef(null);
  const fallbackEulerRef = useRef({ yaw: 0, pitch: 0 });
  const dragStartRef = useRef(null);
  const tapStartRef = useRef(null);
  const activeCanvasPointersRef = useRef(new Map());
  const transformPinchRef = useRef(null);
  const clearedBackupRef = useRef(null);
  const lastErasedKeyRef = useRef({ key: '', ts: 0 });
  const hintTimerRef = useRef(null);
  const arTargetedIdRef = useRef('');
  const voxelsRef = useRef([]);
  const modeRef = useRef(mode);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const materialRef = useRef(material);
  const reachRef = useRef(reachMeters);
  const occlusionEnabledRef = useRef(occlusionEnabled);
  const cameraReadyRef = useRef(cameraReady);
  const userRef = useRef(user);
  const locationRef = useRef(location);
  const paintingRef = useRef(false);
  const lastPaintPosRef = useRef(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  useEffect(() => {
    occlusionEnabledRef.current = occlusionEnabled;
  }, [occlusionEnabled]);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // Background ECDH key-wrap loop for sculptures whose K_room is held locally on this phone
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    async function processPending() {
      try {
        const res = await api.listPendingChatGrants();
        const grants = res.grants || [];
        if (!grants.length || !active) return;
        const identity = await getOrCreateDeviceIdentity(user.id);
        for (const reqGrant of grants) {
          if (!active) break;
          if (reqGrant.sightDistanceM > 75 || reqGrant.sightScore < 45) continue;
          const roomKeyB64 = loadLocalRoomKey(user.id, reqGrant.sculptureId, reqGrant.keyEpoch);
          if (!roomKeyB64) continue;
          const { wrappedKeyJson, grantSig } = await wrapRoomKeyForRecipient({
            roomKeyB64,
            sculptureId: reqGrant.sculptureId,
            keyEpoch: reqGrant.keyEpoch,
            recipientEcdhPubJwk: reqGrant.requesterEcdhPubJwk,
            recipientPubFp: reqGrant.requesterPubFp,
            grantorIdentity: identity
          });
          await api.submitSculptureChatGrant(reqGrant.sculptureId, {
            targetGrantId: reqGrant.id,
            wrappedKeyJson,
            grantorEcdhPubJwk: identity.ecdhPublicJwk,
            grantorSignPubJwk: identity.signPublicJwk,
            grantSig
          });
        }
      } catch {
        // non-blocking background auto-grant
      }
    }
    const initTimer = setTimeout(processPending, 1800);
    const intervalId = setInterval(processPending, 15000);
    return () => {
      active = false;
      clearTimeout(initTimer);
      clearInterval(intervalId);
      clearTimeout(hintTimerRef.current);
    };
  }, [user?.id]);

  // Publish state
  const [title, setTitle] = useState(initialDraft.title || '');
  const [description, setDescription] = useState(initialDraft.description || '');
  const [cluePrompt, setCluePrompt] = useState(initialDraft.cluePrompt || '');
  const [clueAnswer, setClueAnswer] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [mintReceipt, setMintReceipt] = useState(null);
  const draftSnapshotRef = useRef(null);
  const lastCloudSyncSigRef = useRef('');
  const activeDraftIdRef = useRef(activeDraftId);
  useEffect(() => {
    activeDraftIdRef.current = activeDraftId;
  }, [activeDraftId]);

  useEffect(() => {
    voxelsRef.current = voxels;
    if (wsRef.current?.readyState === 1 && pairedCode) {
      wsRef.current.send(JSON.stringify({ type: 'voxels_sync', voxels }));
    }
  }, [voxels, pairedCode]);

  useEffect(() => {
    modeRef.current = mode;
    toolRef.current = tool;
    colorRef.current = color;
    materialRef.current = material;
    reachRef.current = reachMeters;
  }, [mode, tool, color, material, reachMeters]);

  const refreshCloudDrafts = useCallback(async () => {
    if (!userRef.current?.id) return [];
    try {
      const res = await api.listDrafts();
      const items = res.drafts || [];
      setCloudDrafts(items);
      return items;
    } catch {
      return [];
    }
  }, []);

  const persistCloudDraft = useCallback(
    async ({ source = 'auto', forceNew = false, previewDataUrl = '' } = {}) => {
      if (!userRef.current?.id) return null;
      const currentVoxels = voxelsRef.current || [];
      const currentTitle = title.trim();
      const currentDesc = description.trim();
      if (currentVoxels.length === 0 && !currentTitle && !currentDesc) return null;

      const payload = {
        ...(!forceNew && activeDraftIdRef.current ? { id: activeDraftIdRef.current } : {}),
        title: currentTitle,
        description: currentDesc,
        voxels: currentVoxels,
        location: locationRef.current,
        surfaceAnchor: surfaceAnchorRef.current,
        previewDataUrl,
        source
      };
      const res = await api.saveDraft(payload);
      if (res?.draft?.id) {
        setActiveDraftId(res.draft.id);
        activeDraftIdRef.current = res.draft.id;
        setDraftStatusText(
          `Saved to cloud (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        );
        setCloudDrafts((prev) => [res.draft, ...prev.filter((d) => d.id !== res.draft.id)]);
      }
      return res?.draft || null;
    },
    [description, title]
  );

  // Auto-save work locally to device storage + flush on background/close
  useEffect(() => {
    const hasContent =
      voxels.length > 0 ||
      Boolean(title.trim()) ||
      Boolean(description.trim()) ||
      Boolean(surfaceAnchor);

    if (!hasContent) {
      draftSnapshotRef.current = null;
      clearLocalDraft();
      setDraftStatusText(user?.id ? 'Cloud drafts ready' : '');
      return undefined;
    }

    const snap = {
      activeDraftId,
      title,
      description,
      cluePrompt,
      color,
      material,
      reachMeters,
      surfaceAnchor,
      voxels,
      updatedAt: new Date().toISOString()
    };
    draftSnapshotRef.current = snap;

    const timer = setTimeout(() => {
      saveLocalDraft(snap);
      if (!user?.id) {
        setDraftStatusText(`Auto-saved on device (${voxels.length} blocks)`);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [
    activeDraftId,
    cluePrompt,
    color,
    description,
    material,
    reachMeters,
    surfaceAnchor,
    title,
    user?.id,
    voxels
  ]);

  useEffect(() => {
    const flushLocal = () => {
      if (draftSnapshotRef.current) {
        saveLocalDraft(draftSnapshotRef.current);
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') flushLocal();
    };
    window.addEventListener('beforeunload', flushLocal);
    window.addEventListener('pagehide', flushLocal);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.removeEventListener('beforeunload', flushLocal);
      window.removeEventListener('pagehide', flushLocal);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, []);

  // Cloud auto-save + load ?draft=<id> when authenticated
  useEffect(() => {
    if (!user?.id) {
      setCloudDrafts([]);
      lastCloudSyncSigRef.current = '';
      return undefined;
    }

    let cancelled = false;
    refreshCloudDrafts();

    const queryDraftId = new URLSearchParams(window.location.search).get('draft');
    if (queryDraftId && !activeDraftIdRef.current) {
      api
        .getDraft(queryDraftId)
        .then((res) => {
          if (cancelled || !res?.draft) return;
          const d = res.draft;
          setActiveDraftId(d.id);
          activeDraftIdRef.current = d.id;
          setVoxels(Array.isArray(d.voxels) ? d.voxels : []);
          setTitle(d.title || '');
          setDescription(d.description || '');
          setSurfaceAnchor(d.surfaceAnchor || null);
          setDraftStatusText(`Loaded cloud draft (${d.voxelCount} blocks)`);
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [refreshCloudDrafts, user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    const hasContent =
      voxels.length > 0 || Boolean(title.trim()) || Boolean(description.trim());
    if (!hasContent) return undefined;

    let hash = 0;
    for (let i = 0; i < voxels.length; i += 1) {
      const v = voxels[i];
      hash = (hash * 31 + Math.round(v.x * 1000) + Math.round(v.y * 1000) * 7 + Math.round(v.z * 1000) * 13 + Math.round((v.scale ?? 1) * 100)) | 0;
    }
    const anchorSig = surfaceAnchor
      ? `${surfaceAnchor.x}:${surfaceAnchor.y}:${surfaceAnchor.z}:${surfaceAnchor.locked}`
      : '';
    const sig = `${user.id}|${activeDraftId}|${title}|${description}|${voxels.length}|${hash}|${anchorSig}`;
    if (lastCloudSyncSigRef.current === sig) return undefined;

    const timer = setTimeout(() => {
      persistCloudDraft({ source: 'auto' })
        .then((saved) => {
          if (saved) lastCloudSyncSigRef.current = sig;
        })
        .catch(() => {});
    }, 2000);

    return () => clearTimeout(timer);
  }, [activeDraftId, description, persistCloudDraft, surfaceAnchor, title, user?.id, voxels]);

  // Request fullscreen softly on first interaction
  const enterFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  // Start rear camera + PoL frame sampler
  useEffect(() => {
    let stream = null;
    let samplerId = null;

    async function initCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setSensorBanner('Camera API requires HTTPS on mobile.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: false
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
          setCameraReady(true);
        }
      } catch (err) {
        setSensorBanner(`Camera access needed for 3D AR & Proof of Location (${err.message})`);
      }
    }

    initCamera();

    samplerId = setInterval(() => {
      if (videoRef.current && videoRef.current.readyState >= 2) {
        const snap = polRef.current.sampleCameraFrame(videoRef.current);
        if (snap) {
          setPolStats({
            frames: snap.cameraFrames,
            gyro: snap.gyroSamples,
            flow: Math.round(snap.opticalFlowCorrelation * 100)
          });
          const cov = polRef.current.getSceneCoverage();
          lastScanUiRef.current = {
            coveragePct: cov.coveragePct,
            scannedCount: cov.scannedCount,
            optimal: cov.optimal,
            cursorX: cov.cursorX,
            cursorY: cov.cursorY,
            hint: cov.hint
          };
          setSceneScan(cov);
        }
      }
    }, 450);

    return () => {
      clearInterval(samplerId);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Geolocation watcher + load nearby sculptures at this physical location
  useEffect(() => {
    if (!navigator.geolocation) {
      setSensorBanner('GPS Geolocation not supported on this browser.');
      return;
    }

    let lastFetchAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        polRef.current.recordGps(pos);
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
        const refined = polRef.current.getRefinedLocation(loc) || loc;
        setLocation(refined);

        // Align directional sunlight shadow vector to real-world solar azimuth & elevation
        if (dirLightRef.current) {
          const sun = computeSolarLightVector(loc.lat, loc.lng, new Date());
          dirLightRef.current.position.set(sun.x, sun.y, sun.z);
          dirLightRef.current.intensity = sun.isDaylight ? 1.55 : 0.95;
        }

        const now = Date.now();
        if (now - lastFetchAt > 12000) {
          lastFetchAt = now;
          try {
            const res = await api.listSculptures({
              lat: loc.lat,
              lng: loc.lng,
              radiusMeters: 300
            });
            setNearbySculptures(res.sculptures || []);
          } catch {
            // ignore offline fetch retry
          }
        }
      },
      (err) => {
        setSensorBanner(`GPS permission required for Virtual Land (${err.message})`);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // DeviceOrientation (Gyro) listener + iOS permission check
  const attachOrientation = useCallback(() => {
    const handler = (e) => {
      if (e.alpha === null && e.beta === null) return;
      rawOrientationRef.current = {
        alpha: e.alpha || 0,
        beta: e.beta || 0,
        gamma: e.gamma || 0
      };
      polRef.current.recordGyro(e.alpha, e.beta, e.gamma);
    };
    window.addEventListener('deviceorientation', handler, true);
    return () => window.removeEventListener('deviceorientation', handler, true);
  }, []);

  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      setNeedsGyroTap(true);
      return;
    }
    return attachOrientation();
  }, [attachOrientation]);

  async function enableIosGyro() {
    enterFullscreen();
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') {
        setNeedsGyroTap(false);
        attachOrientation();
      } else {
        setSensorBanner('Gyroscope permission denied; drag screen to aim brush.');
      }
    } catch {
      setNeedsGyroTap(false);
    }
  }

  // Incrementally sync Three.js draft voxel meshes (O(1) per block, zero rebuild stutter)
  const rebuildDraftMesh = useCallback((nextVoxels) => {
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
      if (meshMap.has(k)) {
        const existing = meshMap.get(k);
        existing.position.set(v.x, v.y, v.z);
        existing.scale.setScalar(v.scale ?? 1);
        existing.userData.voxel = v;
        continue;
      }
      const matKey = `${v.color}|${v.material || 'matte'}|1`;
      let mat = matCache.get(matKey);
      if (!mat) {
        mat = createVoxelMaterial(v.color, v.material || 'matte', 1);
        matCache.set(matKey, mat);
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
  }, []);

  useEffect(() => {
    rebuildDraftMesh(voxels);
  }, [voxels, rebuildDraftMesh]);

  // Build nearby sculptures in AR Preview mode (honoring horizontal GPS offset + vertical elevation)
  useEffect(() => {
    const group = nearbyGroupRef.current;
    if (!group) return;
    while (group.children.length > 0) group.remove(group.children[0]);

    if (mode !== 'preview' || !location) return;

    const viewerElev =
      location.altitude !== null && location.altitude !== undefined && Number.isFinite(location.altitude)
        ? location.altitude
        : null;

    for (const sc of nearbySculptures) {
      const offset = latLngOffsetMeters(location.lat, location.lng, sc.lat, sc.lng);
      const sub = buildVoxelGroup(sc.voxels || []);
      sub.traverse((obj) => {
        if (obj.isMesh) obj.userData.sculpture = sc;
      });

      // Invisible enlarged tap-target bounding box around voxels for reliable AR camera selection
      const bounds = new THREE.Box3().setFromObject(sub);
      const boxCenter = new THREE.Vector3();
      const boxSize = new THREE.Vector3();
      bounds.getCenter(boxCenter);
      bounds.getSize(boxSize);
      const hitProxy = new THREE.Mesh(
        new THREE.BoxGeometry(
          Math.max(1.0, boxSize.x + 0.55),
          Math.max(1.0, boxSize.y + 0.55),
          Math.max(1.0, boxSize.z + 0.55)
        ),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      hitProxy.position.copy(boxCenter);
      hitProxy.userData.sculpture = sc;
      sub.add(hitProxy);

      // Clamp super distant previews visually within 35m so distant same-block art remains visible
      const dist = Math.hypot(offset.east, offset.north);
      const clampFactor = dist > 35 ? 35 / dist : 1;

      // Vertical elevation placement: keep high-sky & upper-level pieces anchored at their real altitude
      const scElev =
        sc.elevation?.anchorAltitudeMeters ??
        (sc.altitude !== null && sc.altitude !== undefined ? sc.altitude : null);
      let deltaY = 0;
      if (viewerElev !== null && scElev !== null) {
        deltaY = Math.max(-35, Math.min(65, scElev - viewerElev));
      } else if (sc.elevation?.heightAboveGroundMeters) {
        deltaY = Math.max(-10, Math.min(65, sc.elevation.heightAboveGroundMeters));
      }

      // Grounded AR shadow catcher disc beneath each nearby sculpture
      const catcher = new THREE.Mesh(
        new THREE.CircleGeometry(1.6, 24),
        new THREE.ShadowMaterial({ opacity: 0.36 })
      );
      catcher.rotation.x = -Math.PI / 2;
      catcher.position.y = (sc.elevation?.sculptureVerticalMinM ?? 0) - 0.12;
      catcher.receiveShadow = true;
      sub.add(catcher);

      sub.position.set(offset.east * clampFactor, deltaY, -offset.north * clampFactor);
      group.add(sub);
    }
  }, [mode, location, nearbySculptures]);

  const computeTargetVoxel = useCallback((forContinuousHold = false) => {
    const cam = cameraRef.current;
    const draftGroup = draftGroupRef.current;
    if (!cam) return null;

    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const origin = cam.position.clone();

    if (toolRef.current === 'stack' || toolRef.current === 'erase') {
      const raycaster = new THREE.Raycaster(origin, dir, 0.1, 14);
      const targets = draftGroup ? draftGroup.children : [];
      let hits = targets.length ? raycaster.intersectObjects(targets, false) : [];
      if (hits.length === 0 && toolRef.current === 'erase' && forContinuousHold && targets.length) {
        const offsets = [
          [0.025, 0],
          [-0.025, 0],
          [0, 0.025],
          [0, -0.025]
        ];
        const sweepNdc = new THREE.Vector2();
        for (const [ox, oy] of offsets) {
          sweepNdc.set(ox, oy);
          raycaster.setFromCamera(sweepNdc, cam);
          hits = raycaster.intersectObjects(targets, false);
          if (hits.length > 0) break;
        }
      }
      if (hits.length > 0) {
        const hit = hits[0];
        if (toolRef.current === 'erase') {
          return { action: 'erase', voxel: hit.object.userData.voxel };
        }
        const normal = hit.face.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
          .normalize();
        const stepOut = VOXEL_STEP * (((hit.object.userData.voxel?.scale ?? 1) + 1) * 0.5);
        const center = hit.object.position.clone().addScaledVector(normal, stepOut);
        return {
          action: 'add',
          x: snapCoord(center.x),
          y: snapCoord(center.y),
          z: snapCoord(center.z)
        };
      }
      if (toolRef.current === 'erase') return null;
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
            .addScaledVector(normal, VOXEL_STEP * 0.5);
          return {
            action: 'add',
            x: snapCoord(hitPt.x),
            y: snapCoord(hitPt.y),
            z: snapCoord(hitPt.z)
          };
        }
      }
      const fallbackDepth = Math.min(4.5, Math.max(0.5, anchor.depthM || reachRef.current));
      const fallbackPt = origin.addScaledVector(dir, fallbackDepth);
      return {
        action: 'add',
        x: snapCoord(fallbackPt.x),
        y: snapCoord(fallbackPt.y),
        z: snapCoord(fallbackPt.z)
      };
    }

    const pt = origin.addScaledVector(dir, reachRef.current);
    return {
      action: 'add',
      x: snapCoord(pt.x),
      y: snapCoord(pt.y),
      z: snapCoord(pt.z)
    };
  }, []);

  const applyVoxelBatch = useCallback(
    (targets) => {
      if (!Array.isArray(targets) || targets.length === 0) return;
      const halfSpan = config?.policy?.areaHalfSpanMeters || AREA_HALF_SPAN_METERS;
      const maxVoxels = config?.policy?.maxVoxels || 4096;

      const uniqueAdds = [];
      const seenBatch = new Set();
      let hadOutOfBounds = false;

      for (const t of targets) {
        if (!t || t.action !== 'add') continue;
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
          uniqueAdds.push({ x: t.x, y: t.y, z: t.z, key: k });
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

      let limitNotice = '';
      setVoxels((prev) => {
        if (prev.length >= maxVoxels) {
          limitNotice = `Sculpture voxel limit (${maxVoxels}) reached`;
          return prev;
        }

        const existingKeys = new Set();
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;

        for (const v of prev) {
          existingKeys.add(voxelKey(v.x, v.y, v.z));
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
          if (v.z < minZ) minZ = v.z;
          if (v.z > maxZ) maxZ = v.z;
        }

        const additions = [];
        for (const cand of uniqueAdds) {
          if (prev.length + additions.length >= maxVoxels) {
            limitNotice = `Sculpture voxel limit (${maxVoxels}) reached`;
            break;
          }
          if (existingKeys.has(cand.key)) continue;

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
          existingKeys.add(cand.key);
          additions.push({
            x: cand.x,
            y: cand.y,
            z: cand.z,
            color: colorRef.current,
            material: materialRef.current,
            scale: 1
          });
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
    [config?.policy?.areaHalfSpanMeters, config?.policy?.maxVoxels]
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
      if (target.action === 'add') {
        applyVoxelBatch([target]);
      }
    },
    [applyVoxelBatch, eraseTargetVoxel]
  );

  // Initialize Three.js transparent AR WebGL scene
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(68, host.clientWidth / host.clientHeight, 0.05, 120);
    camera.position.set(0, 0.4, 2.2);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);

    const envUpdater = createLiveEnvUpdater(renderer);
    envUpdaterRef.current = envUpdater;

    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.85);
    scene.add(hemiLight);
    hemiLightRef.current = hemiLight;

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.45);
    dirLight.position.set(4, 8, 3);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 36;
    const shadowBound = 9;
    dirLight.shadow.camera.left = -shadowBound;
    dirLight.shadow.camera.right = shadowBound;
    dirLight.shadow.camera.top = shadowBound;
    dirLight.shadow.camera.bottom = -shadowBound;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
    dirLightRef.current = dirLight;

    // Invisible AR shadow catcher plane projecting real directional shadows onto the street/floor
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.ShadowMaterial({ opacity: 0.44 })
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.8;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);
    shadowPlaneRef.current = shadowCatcher;

    const grid = new THREE.GridHelper(6, 30, 0x00f5d4, 0x26324d);
    grid.position.y = -0.805;
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    scene.add(grid);
    gridHelperRef.current = grid;

    // Surface start-anchor marker (ring + center dot + normal tick + 5cm base voxel outline)
    const surfaceMarker = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.13, 0.165, 36);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.z = 0.004;
    surfaceMarker.add(ringMesh);

    const dotGeo = new THREE.CircleGeometry(0.026, 20);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95
    });
    const dotMesh = new THREE.Mesh(dotGeo, dotMat);
    dotMesh.position.z = 0.005;
    surfaceMarker.add(dotMesh);

    const footGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(VOXEL_STEP * 1.06, VOXEL_STEP * 1.06, VOXEL_STEP * 1.06)
    );
    const footMat = new THREE.LineBasicMaterial({
      color: 0x00f5d4,
      transparent: true,
      opacity: 0.85
    });
    const footWire = new THREE.LineSegments(footGeo, footMat);
    footWire.position.z = VOXEL_STEP * 0.53;
    surfaceMarker.add(footWire);

    const stemGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.09, 8);
    const stemMesh = new THREE.Mesh(stemGeo, ringMat);
    stemMesh.rotation.x = Math.PI / 2;
    stemMesh.position.z = 0.045;
    surfaceMarker.add(stemMesh);

    surfaceMarker.visible = false;
    scene.add(surfaceMarker);
    surfaceMarkerRef.current = surfaceMarker;
    originBeaconMatRef.current = { ringMat, dotMat, footMat };

    const draftGroup = new THREE.Group();
    const nearbyGroup = new THREE.Group();
    scene.add(draftGroup);
    scene.add(nearbyGroup);

    const transformBox = new THREE.Box3Helper(new THREE.Box3(), 0x00f5d4);
    transformBox.visible = false;
    scene.add(transformBox);
    transformBoxRef.current = transformBox;

    const ghostGeo = new THREE.BoxGeometry(VOXEL_STEP, VOXEL_STEP, VOXEL_STEP);
    const ghostMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      wireframe: true,
      transparent: true,
      opacity: 0.85
    });
    const ghost = new THREE.Mesh(ghostGeo, ghostMat);
    scene.add(ghost);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    draftGroupRef.current = draftGroup;
    nearbyGroupRef.current = nearbyGroup;
    ghostMeshRef.current = ghost;
    if (voxelsRef.current?.length) {
      rebuildDraftMesh(voxelsRef.current);
    }

    const handleResize = () => {
      if (!host) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
      if (occlusionCanvasRef.current) {
        const occW = Math.min(280, Math.max(96, host.clientWidth));
        const occH = Math.max(
          96,
          Math.round((occW * host.clientHeight) / Math.max(1, host.clientWidth))
        );
        occlusionCanvasRef.current.width = occW;
        occlusionCanvasRef.current.height = occH;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    let lastWsPush = 0;
    let lastEnvPush = 0;
    let lastOcclusionPush = 0;
    let lastTargetCheck = 0;
    let lastScanPosePush = 0;
    const scanFwdVec = new THREE.Vector3();
    const originProjVec = new THREE.Vector3();
    const targetRay = new THREE.Raycaster();
    const centerNdc = new THREE.Vector2(0, 0);

    const animate = () => {
      rafId = requestAnimationFrame(animate);

      if (rawOrientationRef.current) {
        const { alpha, beta, gamma } = rawOrientationRef.current;
        const screenAngle = window.screen?.orientation?.angle || 0;
        const q = deviceOrientationToQuaternion(
          alpha - yawOffsetRef.current,
          beta,
          gamma,
          screenAngle
        );
        camera.quaternion.slerp(q, 0.45);
      } else {
        const euler = new THREE.Euler(
          fallbackEulerRef.current.pitch,
          fallbackEulerRef.current.yaw,
          0,
          'YXZ'
        );
        camera.quaternion.setFromEuler(euler);
      }

      const showCursor = modeRef.current === 'draw';
      ghost.visible = showCursor;
      let latestTarget = null;

      if (showCursor) {
        const target = computeTargetVoxel(paintingRef.current);
        latestTarget = target;
        if (target && target.action === 'add') {
          ghost.position.set(target.x, target.y, target.z);
          ghost.material.color.set(
            originStatusRef.current.originBlocked ? 0xff3e7f : colorRef.current
          );

          if (paintingRef.current && toolRef.current === 'brush') {
            const prev = lastPaintPosRef.current;
            if (!prev) {
              lastPaintPosRef.current = { x: target.x, y: target.y, z: target.z };
              applyVoxelBatch([{ action: 'add', x: target.x, y: target.y, z: target.z }]);
            } else {
              const dx = target.x - prev.x;
              const dy = target.y - prev.y;
              const dz = target.z - prev.z;
              const dist = Math.hypot(dx, dy, dz);
              if (dist >= VOXEL_STEP * 0.75) {
                const steps = Math.min(28, Math.max(1, Math.ceil(dist / VOXEL_STEP)));
                const batch = [];
                for (let i = 1; i <= steps; i += 1) {
                  const t = i / steps;
                  batch.push({
                    action: 'add',
                    x: snapCoord(prev.x + dx * t),
                    y: snapCoord(prev.y + dy * t),
                    z: snapCoord(prev.z + dz * t)
                  });
                }
                lastPaintPosRef.current = { x: target.x, y: target.y, z: target.z };
                applyVoxelBatch(batch);
              }
            }
          }
        } else if (target && target.action === 'erase' && target.voxel) {
          ghost.position.set(target.voxel.x, target.voxel.y, target.voxel.z);
          ghost.material.color.set(0xff3e7f);
          if (paintingRef.current && toolRef.current === 'erase') {
            eraseTargetVoxel(target);
          }
        }
      }

      // Always keep visible 3D sculpture origin beacon positioned & tinted clearly
      const anchor = surfaceAnchorRef.current;
      const placedVoxels = voxelsRef.current || [];
      let originX = null;
      let originY = null;
      let originZ = null;
      let originRequired = false;

      if (anchor) {
        originX = anchor.x;
        originY = anchor.y;
        originZ = anchor.z;
        originRequired = Boolean(anchor.locked);
        surfaceMarker.visible = modeRef.current === 'draw';
      } else if (placedVoxels.length > 0) {
        originX = placedVoxels[0].x;
        originY = placedVoxels[0].y;
        originZ = placedVoxels[0].z;
        surfaceMarker.visible = modeRef.current === 'draw' || modeRef.current === 'transform';
        if (modeRef.current === 'draw') {
          surfaceMarker.position.set(originX, originY, originZ);
          surfaceMarker.rotation.set(-Math.PI / 2, 0, 0);
        }
      } else if (latestTarget && latestTarget.action === 'add') {
        originX = latestTarget.x;
        originY = latestTarget.y;
        originZ = latestTarget.z;
        originRequired = true;
        surfaceMarker.visible = modeRef.current === 'draw';
        surfaceMarker.position.set(originX, originY, originZ);
        surfaceMarker.rotation.set(-Math.PI / 2, 0, 0);
      } else {
        surfaceMarker.visible = false;
      }

      const beaconMats = originBeaconMatRef.current;
      if (beaconMats) {
        const isBlk = originStatusRef.current.originBlocked;
        beaconMats.ringMat.color.setHex(isBlk ? 0xff3e7f : 0x00f5d4);
        beaconMats.footMat.color.setHex(isBlk ? 0xff3e7f : 0x00f5d4);
        beaconMats.dotMat.color.setHex(isBlk ? 0xff3e7f : 0xffd166);
      }

      const now = performance.now();
      if (now - lastScanPosePush > 110) {
        lastScanPosePush = now;
        scanFwdVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
        const yawDeg = (Math.atan2(scanFwdVec.x, -scanFwdVec.z) * 180) / Math.PI;
        const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, scanFwdVec.y))) * 180) / Math.PI;
        const cov = polRef.current.recordViewPose({
          yawDeg,
          pitchDeg,
          hasCamera: Boolean(videoRef.current && videoRef.current.readyState >= 2)
        });
        const prev = lastScanUiRef.current;
        if (!prev.optimal && cov.optimal && !mappingCompletedNoticeShownRef.current) {
          mappingCompletedNoticeShownRef.current = true;
          showTemporaryHint('Mapping complete for this space — 100% precision lock active!');
        }
        if (
          cov.coveragePct !== prev.coveragePct ||
          cov.scannedCount !== prev.scannedCount ||
          cov.optimal !== prev.optimal ||
          cov.hint !== prev.hint ||
          Math.abs(cov.cursorX - prev.cursorX) >= 0.035 ||
          Math.abs(cov.cursorY - prev.cursorY) >= 0.035
        ) {
          lastScanUiRef.current = {
            coveragePct: cov.coveragePct,
            scannedCount: cov.scannedCount,
            optimal: cov.optimal,
            cursorX: cov.cursorX,
            cursorY: cov.cursorY,
            hint: cov.hint
          };
          setSceneScan(cov);
        }

        const vpGrid = polRef.current.getViewportUnmappedGrid(8, 6);
        const vpKey = vpGrid.map((b) => (b ? '1' : '0')).join('');
        if (lastUnmappedMaskRef.current !== vpKey) {
          lastUnmappedMaskRef.current = vpKey;
          setUnmappedGrid(vpGrid);
        }
      }

      const envRefreshMs = polRef.current.getSceneCoverage().optimal ? 2200 : 1100;
      if (!paintingRef.current && now - lastEnvPush > envRefreshMs && videoRef.current && envUpdaterRef.current) {
        lastEnvPush = now;
        const envData = envUpdaterRef.current.update(videoRef.current);
        if (envData) {
          scene.environment = envData.envTexture;
          hemiLight.color.setHex(envData.skyColor);
          hemiLight.groundColor.setHex(envData.groundColor);
        }
      }

      if (now - lastOcclusionPush > 110 && occlusionCanvasRef.current) {
        lastOcclusionPush = now;
        let originScreen = { x: 0.5, y: 0.5, onScreen: true, requiredVisible: false };
        if (originX !== null && originY !== null && originZ !== null) {
          originProjVec.set(originX, originY, originZ).project(camera);
          const sx = (originProjVec.x + 1) * 0.5;
          const sy = (1 - originProjVec.y) * 0.5;
          const onScreen =
            originProjVec.z >= -1 &&
            originProjVec.z <= 1 &&
            sx >= 0.04 &&
            sx <= 0.96 &&
            sy >= 0.04 &&
            sy <= 0.96;
          originScreen = {
            x: sx,
            y: sy,
            onScreen,
            requiredVisible: originRequired
          };
        }
        const occStatus = occlusionRef.current.processFrame(
          videoRef.current,
          occlusionCanvasRef.current,
          rawOrientationRef.current,
          occlusionEnabledRef.current,
          originScreen
        );
        if (
          occStatus &&
          (occStatus.originBlocked !== originStatusRef.current.originBlocked ||
            occStatus.reason !== originStatusRef.current.reason)
        ) {
          originStatusRef.current = occStatus;
          setOriginStatus(occStatus);
        }
      }

      if (now - lastTargetCheck > 180) {
        lastTargetCheck = now;
        if (modeRef.current === 'preview' && nearbyGroupRef.current?.children.length) {
          targetRay.setFromCamera(centerNdc, camera);
          const hits = targetRay.intersectObjects(nearbyGroupRef.current.children, true);
          const hitObj = hits.find((h) => h.object?.userData?.sculpture);
          const sc = hitObj?.object?.userData?.sculpture || null;
          if (sc) {
            const loc = locationRef.current;
            const d = loc ? haversineMeters(loc.lat, loc.lng, sc.lat, sc.lng) : hitObj.distance;
            if (arTargetedIdRef.current !== sc.id) {
              arTargetedIdRef.current = sc.id;
              setArTargetedSculpture({ sculpture: sc, distanceM: d });
            }
          } else if (arTargetedIdRef.current) {
            arTargetedIdRef.current = '';
            setArTargetedSculpture(null);
          }
        } else if (arTargetedIdRef.current) {
          arTargetedIdRef.current = '';
          setArTargetedSculpture(null);
        }
      }

      if (wsRef.current?.readyState === 1 && now - lastWsPush > 45) {
        lastWsPush = now;
        wsRef.current.send(
          JSON.stringify({
            type: 'brush_state',
            q: camera.quaternion.toArray(),
            cursor: [ghost.position.x, ghost.position.y, ghost.position.z],
            color: colorRef.current,
            tool: toolRef.current,
            mode: modeRef.current
          })
        );
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
    originBeaconMatRef.current = null;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      envUpdaterRef.current?.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      dotGeo.dispose();
      dotMat.dispose();
      footGeo.dispose();
      footMat.dispose();
      stemGeo.dispose();
      ghostGeo.dispose();
      ghostMat.dispose();
      transformBox.dispose?.();
      transformBoxRef.current = null;
      draftUnitGeoRef.current?.dispose();
      draftUnitGeoRef.current = null;
      for (const mat of draftMatCacheRef.current.values()) mat.dispose();
      draftMatCacheRef.current.clear();
      draftMeshMapRef.current.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [applyVoxelAction, applyVoxelBatch, computeTargetVoxel, eraseTargetVoxel, rebuildDraftMesh]);

  // Keep locked sculpture live transform & bounding cage in sync
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
  }, [mode, artTransform, transformPivot, voxels]);

  // Keep visible 3D surface anchor ring, shadow catcher plane, and ground grid aligned
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
  }, [surfaceAnchor, mode]);

  // WebSocket Pairing connection
  const connectPairCode = useCallback((codeToJoin) => {
    const clean = String(codeToJoin || '').trim().toUpperCase();
    if (!clean) return;
    setPairError('');
    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join_pair', code: clean }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pair_connected') {
          setPairedCode(msg.code);
          setPairOpen(false);
          ws.send(JSON.stringify({ type: 'voxels_sync', voxels: voxelsRef.current }));
        } else if (msg.type === 'pair_error') {
          setPairError(msg.error);
        } else if (msg.type === 'pair_ended') {
          setPairedCode('');
        } else if (msg.type === 'desktop_command') {
          if (msg.action === 'set_color' && msg.color) setColor(msg.color);
          if (msg.action === 'set_tool' && msg.tool) {
            if (modeRef.current === 'transform') {
              commitTransformAndExit('draw', msg.tool);
            } else {
              setMode('draw');
              setTool(msg.tool);
            }
          }
          if (msg.action === 'set_mode' && msg.mode) {
            if (msg.mode === 'publish' && !userRef.current) {
              setLoginOpen(true);
            } else if (modeRef.current === 'transform') {
              commitTransformAndExit(msg.mode);
            } else {
              setMode(msg.mode);
            }
          }
          if (msg.action === 'undo') handleUndo();
          if (msg.action === 'clear') clearCanvas();
          if (msg.action === 'recenter' && rawOrientationRef.current) {
            yawOffsetRef.current = rawOrientationRef.current.alpha;
          }
        }
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      setPairedCode('');
    };
  }, []);

  useEffect(() => {
    if (pairCodeInput && pairCodeInput.length === 6) {
      connectPairCode(pairCodeInput);
    }
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function recenterAim() {
    if (rawOrientationRef.current) {
      yawOffsetRef.current = rawOrientationRef.current.alpha;
    } else {
      fallbackEulerRef.current = { yaw: 0, pitch: 0 };
    }
  }

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
    };
  }, []);

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  const applyAgentSessionDraft = useCallback(
    (sess) => {
      if (!sess || !Array.isArray(sess.draftVoxels) || sess.draftVoxels.length === 0) return;
      if (sess.updatedAt && lastAppliedAgentTsRef.current === sess.updatedAt) return;
      lastAppliedAgentTsRef.current = sess.updatedAt || String(Date.now());
      setVoxels(sess.draftVoxels);
      if (sess.draftTitle) {
        setTitle((prev) => (prev.trim() ? prev : sess.draftTitle));
      }
      if (sess.draftDescription) {
        setDescription((prev) => (prev.trim() ? prev : sess.draftDescription));
      }
      setSensorBanner(
        `Agent staged ${sess.draftVoxels.length} voxels (${sess.agentName || 'AI Agent'}) — inspect in AR & publish on your phone.`
      );
    },
    []
  );

  async function openAgentHandoff() {
    setAgentOpen(true);
    setAgentError('');
    setAgentCopied(false);

    let activeLoc = locationRef.current || location;
    if (!activeLoc && navigator.geolocation?.getCurrentPosition) {
      activeLoc = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              altitude: pos.coords.altitude,
              accuracy: pos.coords.accuracy,
              heading: pos.coords.heading
            }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 4500 }
        );
      });
    }

    if (!activeLoc) {
      setAgentError('Enable GPS location permission first so the agent code locks onto your physical spot.');
      return;
    }

    setAgentBusy(true);
    try {
      const created = await api.createAgentSession({ location: activeLoc });
      setAgentSession(created);
      lastAppliedAgentTsRef.current = '';
      const ok = await copyToClipboard(created.clipboardText);
      setAgentCopied(ok);
      setSensorBanner(
        ok
          ? `Copied Agent Code ${created.code} — send it to your agent to stage blocks here.`
          : `Agent Code ${created.code} ready — tap Copy inside the sheet.`
      );
    } catch (err) {
      setAgentError(err.message);
    } finally {
      setAgentBusy(false);
    }
  }

  async function refreshAgentDraft() {
    if (!agentSession?.code) return;
    setAgentError('');
    try {
      const res = await api.getAgentSession(agentSession.code);
      if (res?.session) {
        setAgentSession((prev) => ({
          ...(prev || {}),
          ...res.session,
          spec: res.spec || prev?.spec
        }));
        if (res.session.status === 'ready' && res.session.draftVoxels?.length) {
          applyAgentSessionDraft(res.session);
        }
      }
    } catch (err) {
      setAgentError(err.message);
    }
  }

  useEffect(() => {
    const code = agentSession?.code;
    if (!code) return undefined;
    const poll = async () => {
      try {
        const res = await api.getAgentSession(code);
        if (res?.session) {
          setAgentSession((prev) => ({
            ...(prev || {}),
            ...res.session,
            spec: res.spec || prev?.spec
          }));
          if (res.session.status === 'ready' && res.session.draftVoxels?.length) {
            applyAgentSessionDraft(res.session);
          }
        }
      } catch {
        // retry on next tick
      }
    };
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
  }, [agentSession?.code, applyAgentSessionDraft]);

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

  function resetArtTransformState() {
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
  }

  function enterTransformMode() {
    stopBrushPainting();
    setPaletteOpen(false);
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
  }

  function commitTransformAndExit(nextMode = 'draw', nextTool = null) {
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
  }

  function toggleTransformLock() {
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw');
    } else {
      enterTransformMode();
    }
  }

  function clearCanvas() {
    stopBrushPainting();
    if (voxelsRef.current.length > 0) {
      clearedBackupRef.current = voxelsRef.current;
    }
    lastErasedKeyRef.current = { key: '', ts: 0 };
    resetArtTransformState();
    setVoxels([]);
    if (modeRef.current === 'transform') {
      setMode('draw');
      modeRef.current = 'draw';
    }
    showTemporaryHint('Canvas cleared (tap Undo ↩️ to restore)');
  }

  function handleUndo() {
    if (voxelsRef.current.length === 0 && clearedBackupRef.current?.length) {
      const restored = clearedBackupRef.current;
      clearedBackupRef.current = null;
      setVoxels(restored);
      showTemporaryHint('Cleared canvas restored');
      return;
    }
    setVoxels((p) => p.slice(0, -1));
  }

  function assertOriginUnblockedForPaint() {
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
  }

  function startContinuousHoldTool(holdTool) {
    enterFullscreen();
    if (holdTool === 'brush' && !assertOriginUnblockedForPaint()) {
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
    const t = computeTargetVoxel(true);
    if (holdTool === 'erase') {
      eraseTargetVoxel(t);
    } else if (t && t.action === 'add') {
      lastPaintPosRef.current = { x: t.x, y: t.y, z: t.z };
      applyVoxelBatch([t]);
    }
  }

  const KEY_CAROUSEL_SLOT_PX = 54;

  function selectKeyTool(toolId) {
    activeKeyToolRef.current = toolId;
    setActiveKeyTool(toolId);
    if (toolId === 'transform') {
      enterTransformMode();
      return;
    }
    if (toolId === 'brush' || toolId === 'stack' || toolId === 'erase') {
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
        setMode('preview');
      }
    } else if (toolId === 'agent' || toolId === 'publish') {
      if (modeRef.current === 'transform') {
        commitTransformAndExit('draw');
      } else {
        setMode('draw');
      }
    }
  }

  function stepKeyTool(delta) {
    const idx = KEY_TOOLS.findIndex((t) => t.id === activeKeyToolRef.current);
    const current = idx >= 0 ? idx : 0;
    const nextIdx = (((current + delta) % KEY_TOOLS.length) + KEY_TOOLS.length) % KEY_TOOLS.length;
    selectKeyTool(KEY_TOOLS[nextIdx].id);
  }

  function stopBrushPainting() {
    if (paintHoldTimerRef.current) {
      clearTimeout(paintHoldTimerRef.current);
      paintHoldTimerRef.current = null;
    }
    paintingRef.current = false;
    setPainting(false);
    lastPaintPosRef.current = null;
  }

  function triggerActiveKeyTool() {
    enterFullscreen();
    const curTool = activeKeyToolRef.current;
    if (curTool === 'transform') {
      toggleTransformLock();
    } else if (curTool === 'brush' || curTool === 'stack' || curTool === 'erase') {
      if ((curTool === 'brush' || curTool === 'stack') && !assertOriginUnblockedForPaint()) {
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
    } else if (curTool === 'preview') {
      const next = modeRef.current === 'preview' ? 'draw' : 'preview';
      if (modeRef.current === 'transform') {
        commitTransformAndExit(next);
      } else {
        setMode(next);
      }
    } else if (curTool === 'agent') {
      openAgentHandoff();
    } else if (curTool === 'publish') {
      openPublishSheet();
    }
  }

  function handleKeyPointerDown(e) {
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
    if (targetRel === 0 && (curTool === 'brush' || curTool === 'erase')) {
      paintHoldTimerRef.current = setTimeout(() => {
        if (!keyGestureRef.current.active || keyGestureRef.current.swiped) return;
        keyGestureRef.current.holdStarted = true;
        startContinuousHoldTool(curTool);
      }, 145);
    }
  }

  function handleKeyPointerMove(e) {
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
      stepKeyTool(-1);
      g.anchorX += KEY_CAROUSEL_SLOT_PX;
      dx -= KEY_CAROUSEL_SLOT_PX;
      navigator.vibrate?.(8);
    }
    while (dx <= -KEY_CAROUSEL_SLOT_PX * 0.58) {
      stepKeyTool(1);
      g.anchorX -= KEY_CAROUSEL_SLOT_PX;
      dx += KEY_CAROUSEL_SLOT_PX;
      navigator.vibrate?.(8);
    }
    setSwipeDragPx(Math.max(-KEY_CAROUSEL_SLOT_PX, Math.min(KEY_CAROUSEL_SLOT_PX, dx)));
  }

  function handleKeyPointerUp(e) {
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
          stepKeyTool(flickVx < 0 ? 1 : -1);
          navigator.vibrate?.(8);
        } else if (Math.abs(residualDx) >= KEY_CAROUSEL_SLOT_PX * 0.38) {
          stepKeyTool(residualDx < 0 ? 1 : -1);
          navigator.vibrate?.(8);
        }
      } else if (movedPx < 8) {
        if (targetRel !== 0) {
          stepKeyTool(targetRel);
        } else {
          triggerActiveKeyTool();
        }
      }
    }
  }

  function handleKeyPointerCancel() {
    keyGestureRef.current.active = false;
    keyGestureRef.current.swiped = false;
    keyGestureRef.current.holdStarted = false;
    setIsDraggingKey(false);
    setSwipeDragPx(0);
    stopBrushPainting();
  }

  async function loadPublicMapData() {
    setMapLoading(true);
    try {
      const [sRes, pRes] = await Promise.all([api.listSculptures(), api.listParcels()]);
      setMapSculptures(sRes.sculptures || []);
      setMapParcels(pRes.parcels || []);
    } catch {
      // keep existing items
    } finally {
      setMapLoading(false);
    }
  }

  function openAreaMap() {
    stopBrushPainting();
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw');
    }
    setMapOpen(true);
    loadPublicMapData();
  }

  const areaSculpturesSorted = useMemo(() => {
    const withDist = (mapSculptures || []).map((sc) => {
      const distanceMeters =
        location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
          ? Math.round(haversineMeters(location.lat, location.lng, sc.lat, sc.lng))
          : null;
      return { ...sc, distanceMeters };
    });
    if (location) {
      withDist.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
    }
    return withDist;
  }, [mapSculptures, location]);

  const displayedMapSculptures = useMemo(() => {
    if (areaFilterMode !== 'nearby' || !location) return areaSculpturesSorted;
    return areaSculpturesSorted.filter(
      (s) => s.distanceMeters === null || s.distanceMeters <= 5000
    );
  }, [areaFilterMode, areaSculpturesSorted, location]);

  function handlePaintStart() {
    enterFullscreen();
    if (mode !== 'draw') return;
    if ((tool === 'brush' || tool === 'stack') && !assertOriginUnblockedForPaint()) {
      return;
    }
    const target = computeTargetVoxel();
    if (tool === 'brush') {
      paintingRef.current = true;
      setPainting(true);
      lastPaintPosRef.current =
        target && target.action === 'add' ? { x: target.x, y: target.y, z: target.z } : null;
      applyVoxelAction(target);
    } else {
      applyVoxelAction(target);
    }
  }

  function handlePaintEnd() {
    paintingRef.current = false;
    setPainting(false);
    lastPaintPosRef.current = null;
  }

  function showTemporaryHint(msg) {
    setArSelectHint(msg);
    clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setArSelectHint(''), 4200);
  }

  function openCameraSelectedChat(sc, rayHitDistanceM = null) {
    if (!sc) return;
    const loc = locationRef.current;
    if (!cameraReadyRef.current) {
      showTemporaryHint('Live mobile camera stream must be active to enter sculpture chat.');
      return;
    }
    if (!loc) {
      showTemporaryHint('Waiting for GPS fix before unlocking location chat.');
      return;
    }
    const distM = haversineMeters(loc.lat, loc.lng, sc.lat, sc.lng);
    if (distM > CHAT_SIGHT_CLIENT_DISTANCE_M) {
      showTemporaryHint(
        `"${sc.title}" is ${Math.round(distM)}m away — walk within ${CHAT_SIGHT_CLIENT_DISTANCE_M}m in person to unlock.`
      );
      return;
    }
    const polSnap = polRef.current.getSnapshot();
    if ((polSnap.cameraFrames || 0) < 2) {
      showTemporaryHint('Hold live camera steady for a moment to verify Proof of Sight.');
      return;
    }
    setArSelectHint('');
    setChatSelection({
      sculpture: sc,
      sightProof: {
        selectionMethod: 'ar-camera-raycast',
        rayHit: true,
        inFrustum: true,
        cameraReady: true,
        cameraFrames: polSnap.cameraFrames,
        opticalFlowCorrelation: polSnap.opticalFlowCorrelation,
        visualDHash: polSnap.visualDHash,
        lat: loc.lat,
        lng: loc.lng,
        altitude: loc.altitude ?? null,
        rayHitDistanceM: Number.isFinite(rayHitDistanceM) ? Math.round(rayHitDistanceM * 100) / 100 : null,
        selectedAt: new Date().toISOString()
      }
    });
  }

  function handleCanvasPointerDown(e) {
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
  }

  function handleCanvasPointerMove(e) {
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
  }

  function handleCanvasPointerCancel(e) {
    activeCanvasPointersRef.current.delete(e.pointerId);
    if (activeCanvasPointersRef.current.size < 2) {
      transformPinchRef.current = null;
    }
    dragStartRef.current = null;
    tapStartRef.current = null;
  }

  function selectSurfaceAtScreenPoint(clientX, clientY) {
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
  }

  function seedVoxelAtAnchor() {
    if (!surfaceAnchor) return;
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
  }

  function handleCanvasPointerUp(e) {
    activeCanvasPointersRef.current.delete(e.pointerId);
    if (activeCanvasPointersRef.current.size < 2) {
      transformPinchRef.current = null;
    }
    dragStartRef.current = null;
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (!start || modeRef.current === 'transform') return;

    const moveDist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moveDist > 14) return;

    if (modeRef.current === 'draw') {
      if (!paintingRef.current && !keyGestureRef.current.active) {
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
      openCameraSelectedChat(hitWithSculpture.object.userData.sculpture, hitWithSculpture.distance);
    }
  }

  async function openDraftsSheet() {
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw');
    }
    setDraftError('');
    setDraftsOpen(true);
    if (userRef.current?.id) {
      setDraftsBusy(true);
      try {
        await refreshCloudDrafts();
      } finally {
        setDraftsBusy(false);
      }
    }
  }

  async function handleManualSaveDraft({ forceNew = false, closePublish = false } = {}) {
    setDraftError('');
    const currentVoxels = voxelsRef.current || [];
    if (currentVoxels.length === 0 && !title.trim() && !description.trim()) {
      setDraftError('Draw at least 1 block or add a title before saving a draft.');
      return;
    }

    if (!userRef.current?.id) {
      saveLocalDraft({
        activeDraftId,
        title,
        description,
        cluePrompt,
        color,
        material,
        reachMeters,
        surfaceAnchor,
        voxels: currentVoxels,
        updatedAt: new Date().toISOString()
      });
      setDraftStatusText(`Saved on device (${currentVoxels.length} blocks)`);
      showTemporaryHint('Draft saved on device (sign in to sync to cloud)');
      if (closePublish) setMode('draw');
      return;
    }

    setDraftsBusy(true);
    try {
      const previewDataUrl = captureSculptureSnapshot();
      await persistCloudDraft({ source: 'manual', forceNew, previewDataUrl });
      showTemporaryHint(forceNew ? 'Saved as new cloud draft!' : 'Draft saved to your account!');
      if (closePublish) setMode('draw');
    } catch (err) {
      setDraftError(err.message || 'Failed to save draft');
    } finally {
      setDraftsBusy(false);
    }
  }

  async function handleLoadDraft(draft) {
    if (!draft) return;
    setDraftError('');
    let full = draft;
    if (!Array.isArray(draft.voxels) && userRef.current?.id) {
      setDraftsBusy(true);
      try {
        const res = await api.getDraft(draft.id);
        if (res?.draft) full = res.draft;
      } catch (err) {
        setDraftError(err.message || 'Failed to load draft');
        setDraftsBusy(false);
        return;
      } finally {
        setDraftsBusy(false);
      }
    }
    stopBrushPainting();
    resetArtTransformState();
    setActiveDraftId(full.id || '');
    activeDraftIdRef.current = full.id || '';
    setVoxels(Array.isArray(full.voxels) ? full.voxels : []);
    setTitle(full.title || '');
    setDescription(full.description || '');
    setCluePrompt('');
    setClueAnswer('');
    setSurfaceAnchor(full.surfaceAnchor || null);
    setMode('draw');
    modeRef.current = 'draw';
    setDraftsOpen(false);
    setDraftStatusText(`Loaded (${(full.voxels || []).length} blocks)`);
    showTemporaryHint(`Resumed draft: ${full.title || 'Untitled'}`);
  }

  async function handleDeleteCloudDraft(draftId) {
    if (!draftId) return;
    setDraftError('');
    setDraftsBusy(true);
    try {
      await api.deleteDraft(draftId);
      setCloudDrafts((prev) => prev.filter((d) => d.id !== draftId));
      if (activeDraftIdRef.current === draftId) {
        setActiveDraftId('');
        activeDraftIdRef.current = '';
      }
    } catch (err) {
      setDraftError(err.message || 'Failed to delete draft');
    } finally {
      setDraftsBusy(false);
    }
  }

  function handleStartNewDraft() {
    stopBrushPainting();
    resetArtTransformState();
    clearLocalDraft();
    setActiveDraftId('');
    activeDraftIdRef.current = '';
    lastCloudSyncSigRef.current = '';
    setVoxels([]);
    setTitle('');
    setDescription('');
    setCluePrompt('');
    setClueAnswer('');
    setSurfaceAnchor(null);
    setDraftStatusText('');
    setDraftsOpen(false);
    setMode('draw');
    modeRef.current = 'draw';
    showTemporaryHint('Started fresh blank draft');
  }

  function openPublishSheet() {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    setPublishError('');
    setMintReceipt(null);
    if (modeRef.current === 'transform') {
      commitTransformAndExit('publish');
    } else {
      setMode('publish');
    }
  }

  function captureSculptureSnapshot() {
    try {
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        if (ghostMeshRef.current) ghostMeshRef.current.visible = false;
        rendererRef.current.render(sceneRef.current, cameraRef.current);
        const url = rendererRef.current.domElement.toDataURL('image/png');
        if (ghostMeshRef.current && modeRef.current === 'draw') ghostMeshRef.current.visible = true;
        return url;
      }
    } catch {
      // ignore
    }
    return '';
  }

  const wordCount = useMemo(
    () => (description.trim() ? description.trim().split(/\s+/).filter(Boolean).length : 0),
    [description]
  );

  async function handlePublishSubmit(e) {
    e.preventDefault();
    setPublishing(true);
    setPublishError('');
    try {
      if (!location) {
        throw new Error('Waiting for GPS location fix before publishing.');
      }
      const previewDataUrl = captureSculptureSnapshot();
      const polSnap = polRef.current.getSnapshot();
      const refinedAnchor = polRef.current.getRefinedLocation(location) || location;
      const res = await api.publishSculpture({
        title,
        description,
        termsAccepted,
        voxels,
        previewDataUrl,
        draftId: activeDraftId || undefined,
        location: refinedAnchor,
        proofOfLocation: polSnap,
        deviceProfile: {
          isMobile: true,
          screenWidth: window.innerWidth,
          screenHeight: window.innerHeight,
          hasCamera: cameraReady
        }
      });

      // Initialize the sculpture's client-side E2EE chat board (server never sees K_room or clue answer)
      if (user?.id && res?.sculpture?.id) {
        try {
          const idObj = await getOrCreateDeviceIdentity(user.id);
          const roomKeyB64 = generateRoomKeyB64();
          saveLocalRoomKey(user.id, res.sculpture.id, 1, roomKeyB64);
          const { roomKeyCommit } = await computeRoomPossessionProof(roomKeyB64, res.sculpture.id, 1);
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
          // Non-blocking: chat board can still be initialized later on first AR tap
        }
      }

      const publishedDraftId = activeDraftIdRef.current;
      clearLocalDraft();
      setActiveDraftId('');
      activeDraftIdRef.current = '';
      lastCloudSyncSigRef.current = '';
      if (publishedDraftId) {
        setCloudDrafts((prev) => prev.filter((d) => d.id !== publishedDraftId));
      }

      setMintReceipt(res);
      setVoxels([]);
      setTitle('');
      setDescription('');
      setCluePrompt('');
      setClueAnswer('');
      setTermsAccepted(false);
      setDraftStatusText('');
      // Refresh nearby AR sculptures
      const nearbyRes = await api.listSculptures({
        lat: location.lat,
        lng: location.lng,
        radiusMeters: 300
      });
      setNearbySculptures(nearbyRes.sculptures || []);
    } catch (err) {
      setPublishError(err.message || 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  const policy = config?.policy;

  return (
    <div className="mobile-fullscreen">
      <video ref={videoRef} className="camera-feed" playsInline muted autoPlay />
      {cameraReady && !sceneScan.optimal && (
        <div className="mapping-grayscale-grid" aria-hidden="true">
          {unmappedGrid.map((isUnmapped, i) => (
            <div
              key={i}
              className={`mapping-grayscale-cell ${isUnmapped ? 'unmapped' : 'mapped'}`}
            />
          ))}
        </div>
      )}
      <div
        ref={canvasHostRef}
        className="webgl-overlay"
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerCancel}
      />
      <canvas ref={occlusionCanvasRef} className="occlusion-overlay" />

      {mode === 'draw' && <div className="reticle" />}

      <div className="hud-layer">
        {/* Minimal "i" info button ALWAYS present */}
        <button
          className="info-fab"
          onClick={() => setInfoOpen(true)}
          aria-label="Info and Terms"
          title="Info & Terms"
        >
          <XeroIcon emoji="ℹ️" size={24} label="Info" />
        </button>

        {/* Minimal Proof-of-Location / Mode indicator when dock is expanded */}
        {dockOpen && (
          <div className="pol-pill">
            <XeroIcon emoji={location ? '📍' : '⏳'} size={14} />
            <span>
              {location
                ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
                : 'Acquiring GPS'}
            </span>
            {location?.altitude != null && (
              <>
                <span>|</span>
                <XeroIcon emoji="⛰️" size={14} />
                <span>{Math.round(location.altitude)}m</span>
              </>
            )}
            <span>|</span>
            <XeroIcon emoji="🧱" size={14} />
            <span>{voxels.length}</span>
            {pairedCode && (
              <>
                <span>|</span>
                <XeroIcon emoji="🔗" size={14} />
                <span>{pairedCode}</span>
              </>
            )}
          </div>
        )}

        {mode === 'draw' && (
          <div className={`surface-pill hud-interactive ${dockOpen ? 'under-pol' : ''}`}>
            {surfaceAnchor ? (
              <>
                <XeroIcon emoji="📌" size={13} />
                <span className="surface-pill-label">
                  {surfaceAnchor.label} · {surfaceAnchor.depthM.toFixed(1)}m
                </span>
                <button
                  type="button"
                  className={`surface-pill-btn ${surfaceAnchor.locked ? 'active' : ''}`}
                  onClick={() =>
                    setSurfaceAnchor((prev) => (prev ? { ...prev, locked: !prev.locked } : prev))
                  }
                  title="Toggle start surface plane lock vs Free 3D air drawing"
                >
                  <XeroIcon emoji={surfaceAnchor.locked ? '🔒' : '🌐'} size={12} />
                  <span>{surfaceAnchor.locked ? 'Locked' : 'Free 3D'}</span>
                </button>
                <button
                  type="button"
                  className="surface-pill-btn"
                  onClick={seedVoxelAtAnchor}
                  title="Place first block flush on the selected surface"
                >
                  + Seed
                </button>
                <button
                  type="button"
                  className="surface-pill-btn clear"
                  onClick={() => setSurfaceAnchor(null)}
                  aria-label="Clear start surface"
                  title="Clear start surface"
                >
                  <XeroIcon emoji="✖️" size={11} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="surface-pill-prompt"
                onClick={() => selectSurfaceAtScreenPoint()}
              >
                <XeroIcon emoji="👆" size={13} />
                <span>Tap scene to set start surface</span>
              </button>
            )}
          </div>
        )}

        {needsGyroTap && (
          <button
            className="btn btn-primary"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 40
            }}
            onClick={enableIosGyro}
          >
            <XeroIcon emoji="🧭" size={18} /> Enable Gyroscope 3D Brush
          </button>
        )}

        {sensorBanner && dockOpen && (
          <div
            style={{
              position: 'absolute',
              top: mode === 'draw' ? 98 : 64,
              left: 14,
              right: 70,
              padding: '7px 10px',
              borderRadius: 10,
              background: 'rgba(255, 77, 109, 0.25)',
              border: '1px solid rgba(255, 77, 109, 0.5)',
              fontSize: 11,
              color: '#ffd6de'
            }}
          >
            <XeroIcon emoji="⚠️" size={14} /> {sensorBanner}
          </div>
        )}

        {mode === 'preview' && arTargetedSculpture && (
          <button
            className="btn btn-primary"
            onClick={() => openCameraSelectedChat(arTargetedSculpture.sculpture, arTargetedSculpture.distanceM)}
            style={{
              position: 'absolute',
              bottom: 'max(86px, calc(env(safe-area-inset-bottom) + 70px))',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 24,
              whiteSpace: 'nowrap',
              boxShadow: '0 10px 26px rgba(0, 0, 0, 0.55)'
            }}
          >
            <XeroIcon emoji="💬" size={16} />
            <span>
              {arTargetedSculpture.sculpture.title} ({Math.round(arTargetedSculpture.distanceM)}m) · Enter E2EE Chat
            </span>
          </button>
        )}

        {arSelectHint && (
          <div
            style={{
              position: 'absolute',
              top: 64,
              left: 14,
              right: 70,
              padding: '8px 10px',
              borderRadius: 10,
              background: originStatus.originBlocked
                ? 'rgba(130, 18, 46, 0.92)'
                : sceneScan.optimal && arSelectHint.includes('Mapping complete')
                ? 'rgba(8, 48, 42, 0.92)'
                : 'rgba(12, 18, 34, 0.86)',
              border: originStatus.originBlocked
                ? '1px solid rgba(255, 62, 127, 0.72)'
                : '1px solid rgba(0, 245, 212, 0.45)',
              fontSize: 12,
              color: 'var(--text)',
              zIndex: 28
            }}
          >
            <XeroIcon
              emoji={originStatus.originBlocked ? '⚠️' : sceneScan.optimal ? '✅' : '🔒'}
              size={14}
            />{' '}
            {arSelectHint}
          </div>
        )}

        {mode === 'draw' && originStatus.originBlocked && !arSelectHint && (
          <div className="origin-blocked-banner">
            <XeroIcon emoji="⚠️" size={14} />
            <span>{originStatus.reason || 'Origin is blocked — clear obstruction to paint'}</span>
          </div>
        )}

        {/* Bottom-Left Public Area Map Button */}
        <button
          type="button"
          className={`floating-map-btn hud-interactive ${mapOpen ? 'active' : ''}`}
          onClick={openAreaMap}
          aria-label="Open Public Area Map"
          title="Public Area Sculpture Map & Directions"
        >
          <XeroIcon emoji="🗺️" size={22} />
          {nearbySculptures.length > 0 && (
            <span className="floating-map-badge">{nearbySculptures.length}</span>
          )}
        </button>

        {/* Centered Fluid Swipe Tool Carousel */}
        {(() => {
          const idx = KEY_TOOLS.findIndex((t) => t.id === activeKeyTool);
          const safeIdx = idx >= 0 ? idx : 0;
          const activeItem = KEY_TOOLS[safeIdx];
          const slots = [-2, -1, 0, 1, 2];
          return (
            <div className="key-carousel hud-interactive">
              <div className="key-tool-caption">
                <XeroIcon emoji="🔑" size={12} />
                <span>{activeItem.label}</span>
                <span className="key-tool-hint">
                  {canTouch ? '· Swipe' : '· Arrows / Swipe'}
                </span>
              </div>
              <div className="key-carousel-row">
                {!canTouch && (
                  <button
                    type="button"
                    className="key-arrow-btn"
                    onClick={() => stepKeyTool(-1)}
                    aria-label="Previous tool"
                    title="Previous tool"
                  >
                    <XeroIcon emoji="◀️" size={13} />
                  </button>
                )}

                <div
                  className={`key-carousel-track ${isDraggingKey ? 'dragging' : ''}`}
                  onPointerDown={handleKeyPointerDown}
                  onPointerMove={handleKeyPointerMove}
                  onPointerUp={handleKeyPointerUp}
                  onPointerCancel={handleKeyPointerCancel}
                  onContextMenu={(e) => e.preventDefault()}
                  role="group"
                  aria-label="Fluid bottom tool switcher (swipe left or right)"
                >
                  {slots.map((rel) => {
                    const toolIdx =
                      (((safeIdx + rel) % KEY_TOOLS.length) + KEY_TOOLS.length) % KEY_TOOLS.length;
                    const item = KEY_TOOLS[toolIdx];
                    const offsetPx = rel * KEY_CAROUSEL_SLOT_PX + swipeDragPx;
                    const distNorm = Math.min(2, Math.abs(offsetPx) / KEY_CAROUSEL_SLOT_PX);
                    const scale = Math.max(0.46, 1 - distNorm * 0.34);
                    const opacity = Math.max(0.16, 1 - distNorm * 0.44);
                    const isCenterSlot = rel === 0;
                    return (
                      <button
                        key={`${rel}-${item.id}`}
                        type="button"
                        data-tool-rel={rel}
                        className={`key-slot-btn ${isCenterSlot ? `is-center tool-${item.id} ${painting ? 'painting' : ''}` : 'is-neighbor'}`}
                        style={{
                          transform: `translate(-50%, -50%) translateX(${offsetPx}px) scale(${scale})`,
                          opacity,
                          zIndex: isCenterSlot ? 4 : 3 - Math.abs(rel),
                          transition: isDraggingKey
                            ? 'none'
                            : 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease'
                        }}
                        aria-label={
                          isCenterSlot
                            ? `${item.label} tool button (${item.hint})`
                            : `Switch to ${item.label}`
                        }
                        title={item.hint}
                      >
                        <XeroIcon emoji={item.emoji} size={28} />
                      </button>
                    );
                  })}
                </div>

                {!canTouch && (
                  <button
                    type="button"
                    className="key-arrow-btn"
                    onClick={() => stepKeyTool(1)}
                    aria-label="Next tool"
                    title="Next tool"
                  >
                    <XeroIcon emoji="▶️" size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* Scale & Transform Control Bar when art is locked */}
        {mode === 'transform' && (
          <div
            className={`transform-bar hud-interactive ${dockOpen ? 'with-dock' : ''}`}
            role="region"
            aria-label="Scale and transform art piece"
          >
            <div className="transform-bar-top">
              <span className="transform-bar-title">
                <XeroIcon emoji="📐" size={14} />
                <span>Lock &amp; Transform ({voxels.length})</span>
              </span>
              <div className="transform-nudge-row">
                <button
                  type="button"
                  className="transform-chip-btn"
                  onClick={() =>
                    setArtTransform((p) => ({ ...p, offsetY: Number((p.offsetY - 0.1).toFixed(2)) }))
                  }
                  title="Lower art (-10cm)"
                >
                  -Y
                </button>
                <button
                  type="button"
                  className="transform-chip-btn"
                  onClick={() =>
                    setArtTransform((p) => ({ ...p, offsetY: Number((p.offsetY + 0.1).toFixed(2)) }))
                  }
                  title="Raise art (+10cm)"
                >
                  +Y
                </button>
                <button
                  type="button"
                  className="transform-chip-btn"
                  onClick={() =>
                    setArtTransform((p) => ({ ...p, offsetZ: Number((p.offsetZ + 0.15).toFixed(2)) }))
                  }
                  title="Bring closer"
                >
                  Near
                </button>
                <button
                  type="button"
                  className="transform-chip-btn"
                  onClick={() =>
                    setArtTransform((p) => ({ ...p, offsetZ: Number((p.offsetZ - 0.15).toFixed(2)) }))
                  }
                  title="Push further"
                >
                  Far
                </button>
                <button
                  type="button"
                  className="transform-chip-btn"
                  onClick={() =>
                    setArtTransform({ scale: 1, rotYDeg: 0, offsetX: 0, offsetY: 0, offsetZ: 0 })
                  }
                  title="Reset transform"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="transform-sliders">
              <label className="transform-slider-field">
                <span>
                  <XeroIcon emoji="🔍" size={12} /> {artTransform.scale.toFixed(2)}x
                </span>
                <input
                  type="range"
                  min={0.25}
                  max={2}
                  step={0.05}
                  value={artTransform.scale}
                  onChange={(e) =>
                    setArtTransform((p) => ({ ...p, scale: Number(e.target.value) }))
                  }
                  aria-label="Scale sculpture"
                />
              </label>

              <label className="transform-slider-field">
                <span>
                  <XeroIcon emoji="🔄" size={12} /> {artTransform.rotYDeg}°
                </span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={2}
                  value={artTransform.rotYDeg}
                  onChange={(e) =>
                    setArtTransform((p) => ({ ...p, rotYDeg: Number(e.target.value) }))
                  }
                  aria-label="Rotate sculpture"
                />
              </label>

              <button
                type="button"
                className="transform-done-btn"
                onClick={toggleTransformLock}
                title="Confirm transform & return to drawing mode"
              >
                <XeroIcon emoji="✅" size={14} />
                <span>Draw</span>
              </button>
            </div>
          </div>
        )}

        {/* Bottom-Right Scene Analysis Coverage Window */}
        <div
          className={`scene-scan-box hud-interactive ${sceneScan.optimal ? 'optimal' : 'scanning'} ${scanBoxCollapsed ? 'collapsed' : ''} ${dockOpen || mode === 'transform' ? 'hide-on-dock-mobile' : ''}`}
          role="region"
          aria-label="Scene analysis coverage window"
        >
          <div className="scene-scan-header">
            <div className="scene-scan-title">
              <XeroIcon emoji={sceneScan.optimal ? '✅' : '📡'} size={12} />
              <span className="mono">{sceneScan.coveragePct}%</span>
              <span className="scene-scan-tag">
                {sceneScan.optimal ? 'LOCKED' : `${sceneScan.scannedCount}/${sceneScan.targetCount}`}
              </span>
            </div>
            <button
              type="button"
              className="scene-scan-collapse"
              onClick={() => setScanBoxCollapsed((v) => !v)}
              aria-label={scanBoxCollapsed ? 'Expand scene coverage window' : 'Collapse scene coverage window'}
              title={scanBoxCollapsed ? 'Show scene scan window' : 'Minimize'}
            >
              <XeroIcon emoji={scanBoxCollapsed ? '🔍' : '➖'} size={11} />
            </button>
          </div>

          {!scanBoxCollapsed && (
            <>
              <div className="scene-scan-window" aria-hidden="true">
                <div className="scene-scan-grid">
                  {sceneScan.sectors.map((lit, i) => (
                    <span
                      key={i}
                      className={`scene-scan-cell ${lit ? 'scanned' : ''}`}
                    />
                  ))}
                </div>
                <span
                  className="scene-scan-dot"
                  style={{
                    left: `${sceneScan.cursorX * 100}%`,
                    top: `${sceneScan.cursorY * 100}%`
                  }}
                />
              </div>

              <div className="scene-scan-bar">
                <div
                  className="scene-scan-bar-fill"
                  style={{ width: `${sceneScan.coveragePct}%` }}
                />
              </div>

              <div className="scene-scan-hint">{sceneScan.hint}</div>
              <div className="scene-scan-precision mono">
                ±{sceneScan.precisionMeters.toFixed(2)}m placement
              </div>
            </>
          )}
        </div>

        {/* Floating Toggle for Ultra-Minimal vs Active Dock */}
        <button
          className="floating-tools-toggle"
          onClick={() => setDockOpen((v) => !v)}
          aria-label="Toggle tools"
          title="Tools"
        >
          <XeroIcon emoji={dockOpen ? '➖' : '🎨'} size={22} />
        </button>

        {dockOpen && paletteOpen && mode === 'draw' && (
          <div className="palette-strip hud-interactive">
            {GRAFFITI_PALETTE.map((hex) => (
              <button
                key={hex}
                className={`swatch ${color === hex ? 'active' : ''}`}
                style={{ backgroundColor: hex }}
                onClick={() => setColor(hex)}
                aria-label={`Color ${hex}`}
              />
            ))}
            <button
              className="dock-btn"
              style={{ width: 28, height: 28 }}
              onClick={() =>
                setMaterial((m) => (m === 'matte' ? 'neon' : m === 'neon' ? 'glass' : 'matte'))
              }
              title={`Material: ${material}`}
            >
              <XeroIcon emoji={material === 'neon' ? '✨' : material === 'glass' ? '🧊' : '🎨'} size={15} />
            </button>
            <button
              className="dock-btn"
              style={{ width: 28, height: 28 }}
              onClick={() => setReachMeters((r) => (r >= 2.8 ? 1.2 : Number((r + 0.6).toFixed(1))))}
              title={`Reach ${reachMeters}m`}
            >
              <XeroIcon emoji="🎯" size={15} />
            </button>
          </div>
        )}

        {dockOpen && (
          <div className="floating-dock hud-interactive">
            <button
              className={`dock-btn ${mode === 'draw' && tool === 'brush' ? 'active' : ''}`}
              onClick={() => {
                if (modeRef.current === 'transform') {
                  commitTransformAndExit('draw', 'brush');
                } else {
                  setMode('draw');
                  setTool('brush');
                }
              }}
              title="3D Brush"
            >
              <XeroIcon emoji="🖌️" size={19} />
            </button>
            <button
              className={`dock-btn ${mode === 'draw' && tool === 'stack' ? 'active' : ''}`}
              onClick={() => {
                if (modeRef.current === 'transform') {
                  commitTransformAndExit('draw', 'stack');
                } else {
                  setMode('draw');
                  setTool('stack');
                }
              }}
              title="Stack Voxels"
            >
              <XeroIcon emoji="🧱" size={19} />
            </button>
            <button
              className={`dock-btn pink ${mode === 'draw' && tool === 'erase' ? 'active' : ''}`}
              onPointerDown={(e) => {
                if (e.button && e.button !== 0) return;
                e.preventDefault();
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                startContinuousHoldTool('erase');
              }}
              onPointerUp={(e) => {
                stopBrushPainting();
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
              }}
              onPointerCancel={() => stopBrushPainting()}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => {
                if (modeRef.current === 'transform') {
                  commitTransformAndExit('draw', 'erase');
                } else {
                  setMode('draw');
                  setTool('erase');
                }
              }}
              aria-label="Eraser (Hold to Erase)"
              title="Eraser — Tap to select, hold down to continuously erase"
            >
              <XeroIcon emoji="🧽" size={19} />
            </button>
            <button
              className="dock-btn pink"
              onClick={clearCanvas}
              aria-label="Trash Bin — Erase Current Canvas"
              title="Trash Bin — Erase Current Canvas"
            >
              <XeroIcon emoji="🗑️" size={19} />
            </button>
            <button
              className={`dock-btn check-btn ${mode === 'transform' ? 'active' : ''}`}
              onClick={toggleTransformLock}
              aria-label={
                mode === 'transform'
                  ? 'Confirm Transform & Back to Draw'
                  : 'Lock Art to Scale & Transform'
              }
              title={
                mode === 'transform'
                  ? 'Check — Return to Drawing Mode'
                  : 'Check — Lock Art, Scale & Transform'
              }
            >
              <XeroIcon emoji="✅" size={19} />
            </button>
            <button
              className={`dock-btn ${paletteOpen ? 'active' : ''}`}
              onClick={() => setPaletteOpen((p) => !p)}
              title="Colors & Finish"
            >
              <XeroIcon emoji="🎨" size={19} />
            </button>
            <button className="dock-btn" onClick={handleUndo} title="Undo / Restore Clear">
              <XeroIcon emoji="↩️" size={18} />
            </button>
            <button className="dock-btn" onClick={recenterAim} title="Recenter Aim">
              <XeroIcon emoji="🧭" size={19} />
            </button>
            <button
              className={`dock-btn ${occlusionEnabled ? 'active' : ''}`}
              onClick={() => setOcclusionEnabled((v) => !v)}
              title="Toggle Foreground Occlusion"
              aria-label="Toggle Foreground Occlusion"
            >
              <XeroIcon emoji="🪞" size={19} />
            </button>
            <button
              className={`dock-btn ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => {
                if (modeRef.current === 'transform') {
                  commitTransformAndExit('preview');
                } else {
                  setMode((m) => (m === 'preview' ? 'draw' : 'preview'));
                }
              }}
              title="AR Preview Nearby Sculptures"
            >
              <XeroIcon emoji="👁️" size={19} />
            </button>
            <button
              className={`dock-btn ${draftsOpen || activeDraftId ? 'active' : ''}`}
              onClick={openDraftsSheet}
              title={draftStatusText ? `Saved Drafts · ${draftStatusText}` : 'Saved Drafts'}
              aria-label="Saved Drafts"
            >
              <XeroIcon emoji="💾" size={19} />
            </button>
            <button
              className={`dock-btn ${pairedCode ? 'active' : ''}`}
              onClick={() => setPairOpen(true)}
              title="Pair Desktop"
            >
              <XeroIcon emoji="🔗" size={19} />
            </button>
            <button
              className={`dock-btn ${agentOpen || agentSession?.code ? 'active' : ''}`}
              onClick={openAgentHandoff}
              title="Copy Agent Code"
              aria-label="Copy Agent Code"
            >
              <XeroIcon emoji="📋" size={19} />
            </button>
            <button
              className={`dock-btn ${mode === 'publish' ? 'active' : ''}`}
              onClick={openPublishSheet}
              title="Publish & Mint"
            >
              <XeroIcon emoji="🚀" size={19} />
            </button>
          </div>
        )}
      </div>

      {/* AR Preview Mode subtle badge */}
      {mode === 'preview' && (
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
            gap: 6
          }}
        >
          <XeroIcon emoji="👁️" size={15} />
          <span>AR Preview: {nearbySculptures.length} nearby sculptures + your draft</span>
        </div>
      )}

      {/* Pair Desktop Modal */}
      {pairOpen && (
        <div className="modal-backdrop" onClick={() => setPairOpen(false)}>
          <div className="modal-card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <XeroIcon emoji="🔗" size={22} /> Pair Desktop 3D View
              </h3>
              <button className="btn" onClick={() => setPairOpen(false)}>
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
              Open GRAFFILAND on your desktop and copy the 6-character Pair Code so you can view
              your full sculpture live in 3D while sculpting with your phone.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input mono"
                value={pairCodeInput}
                onChange={(e) => setPairCodeInput(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
              />
              <button
                className="btn btn-primary"
                onClick={() => connectPairCode(pairCodeInput)}
              >
                <XeroIcon emoji="🔗" size={16} /> Connect
              </button>
            </div>
            {pairedCode && (
              <div className="badge teal" style={{ marginTop: 10 }}>
                <XeroIcon emoji="✅" size={14} /> Paired to {pairedCode}
              </div>
            )}
            {pairError && (
              <div style={{ marginTop: 10, color: 'var(--danger)', fontSize: 12 }}>{pairError}</div>
            )}
          </div>
        </div>
      )}

      {/* Agent Location Handoff Modal */}
      {agentOpen && (
        <div className="modal-backdrop" onClick={() => setAgentOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <XeroIcon emoji="🤖" size={22} /> Agent Sculpture Code
              </h3>
              <button className="btn" onClick={() => setAgentOpen(false)}>
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>

            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
              Give this location-locked code to your AI agent so it can read our 4x voxel tools,
              12 colors, and 3 block types to build a 3D sculpture here. You must inspect and tap{' '}
              <strong>Publish</strong> on your phone to mint.
            </p>

            {agentBusy && (
              <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
                Generating location code...
              </div>
            )}

            {agentError && (
              <div style={{ color: '#ffb3c1', fontSize: 12, marginBottom: 8 }}>
                <XeroIcon emoji="⚠️" size={14} /> {agentError}
              </div>
            )}

            {agentSession?.code && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.06em' }}>
                      {agentSession.code}
                    </span>
                    <span className={`badge ${agentSession.status === 'ready' ? 'teal' : 'gold'}`}>
                      {agentSession.status === 'ready'
                        ? `Loaded ${agentSession.voxelCount || agentSession.draftVoxels?.length || 0} voxels`
                        : 'Waiting for agent build...'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Parcel <span className="mono">{agentSession.parcelId}</span> · 4x (0.05m/block) · 10000×10000×10000 limit
                  </div>
                  {agentSession.endpoints?.spec && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>
                      Spec: <span className="mono">{agentSession.endpoints.spec}</span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      const ok = await copyToClipboard(agentSession.clipboardText);
                      setAgentCopied(ok);
                    }}
                  >
                    <XeroIcon emoji="📋" size={15} />{' '}
                    {agentCopied ? 'Copied Prompt & Code!' : 'Copy Agent Prompt & Code'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const ok = await copyToClipboard(agentSession.code);
                      setAgentCopied(ok);
                    }}
                  >
                    Copy Code Only
                  </button>
                  <button type="button" className="btn" onClick={refreshAgentDraft}>
                    <XeroIcon emoji="🔄" size={15} /> Check Draft
                  </button>
                </div>

                {agentSession.status === 'ready' && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        applyAgentSessionDraft(agentSession);
                        setAgentOpen(false);
                        setMode('draw');
                      }}
                    >
                      <XeroIcon emoji="👁️" size={15} /> Inspect in AR
                    </button>
                    <button
                      type="button"
                      className="btn btn-pink"
                      onClick={() => {
                        applyAgentSessionDraft(agentSession);
                        setAgentOpen(false);
                        openPublishSheet();
                      }}
                    >
                      <XeroIcon emoji="🚀" size={15} /> Publish on Phone
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Publish Mode Sheet */}
      {mode === 'publish' && (
        <div className="modal-backdrop" onClick={() => setMode('draw')}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <XeroIcon emoji="🚀" size={22} /> Publish to IPFS &amp; Robinhood Chain
              </h3>
              <button className="btn" onClick={() => setMode('draw')}>
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>

            {mintReceipt ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
                  <XeroIcon emoji="✅" size={15} /> Minted directly to your wallet!
                </div>
                <div className="card" style={{ fontSize: 12 }}>
                  <div><strong>Title:</strong> {mintReceipt.sculpture.title}</div>
                  <div><strong>Virtual Land:</strong> <span className="mono">{mintReceipt.sculpture.parcelId}</span></div>
                  <div><strong>Token ID:</strong> <span className="mono">#{mintReceipt.mint.tokenId}</span></div>
                  <div><strong>Resale Fee:</strong> 5% (ERC-2981)</div>
                  <div style={{ wordBreak: 'break-all' }}>
                    <strong>IPFS CID:</strong> <span className="mono">{mintReceipt.ipfs.metadataCid}</span>
                  </div>
                  <div style={{ wordBreak: 'break-all' }}>
                    <strong>Tx Hash:</strong> <span className="mono">{mintReceipt.mint.txHash}</span>
                  </div>
                </div>
                <button className="btn btn-primary" onClick={() => setMode('preview')}>
                  <XeroIcon emoji="👁️" size={16} /> View in AR Preview
                </button>
              </div>
            ) : (
              <form onSubmit={handlePublishSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge teal">
                    <XeroIcon emoji="🧱" size={13} /> {voxels.length} voxels
                  </span>
                  <span className="badge gold">
                    <XeroIcon emoji="📷" size={13} /> {polStats.frames} frames / {polStats.flow}% flow
                  </span>
                  {location?.altitude != null && (
                    <span className="badge teal">
                      <XeroIcon emoji="⛰️" size={13} /> {Math.round(location.altitude)}m alt
                    </span>
                  )}
                  <span className="badge">
                    <XeroIcon emoji="🪙" size={13} /> Gas Free · 5% Resale Fee
                  </span>
                </div>

                <div>
                  <div className="field-label">
                    <span>Title</span>
                    <span className="mono">{title.length}/{policy?.titleMax || 48}</span>
                  </div>
                  <input
                    className="input"
                    required
                    maxLength={policy?.titleMax || 48}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Name your 3D street sculpture"
                  />
                </div>

                <div>
                  <div className="field-label">
                    <span>Description (Limited Terms)</span>
                    <span className="mono">
                      {description.length}/{policy?.descriptionMax || 240} chars · {wordCount}/{policy?.descriptionMaxWords || 45} words
                    </span>
                  </div>
                  <textarea
                    className="textarea"
                    rows={3}
                    required
                    maxLength={policy?.descriptionMax || 240}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Short story or inspiration for this Virtual Land piece..."
                  />
                </div>

                <div>
                  <div className="field-label">
                    <span>Optional On-Site Chat Clue (24/7 Solo Unlock)</span>
                    <span className="mono">E2EE · PBKDF2</span>
                  </div>
                  <input
                    className="input"
                    maxLength={140}
                    value={cluePrompt}
                    onChange={(e) => setCluePrompt(e.target.value)}
                    placeholder="Question visible at this spot (leave blank for peer-only)"
                  />
                  {cluePrompt.trim() && (
                    <input
                      className="input"
                      style={{ marginTop: 6 }}
                      value={clueAnswer}
                      onChange={(e) => setClueAnswer(e.target.value)}
                      placeholder="Answer visible in person (never sent to server)"
                      required
                    />
                  )}
                </div>

                {user && (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Minted NFT Recipient ({user.email}):
                    <div className="mono" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
                      {user.activeMintRecipient}
                    </div>
                  </div>
                )}

                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                  />
                  <span>
                    I accept the{' '}
                    <button
                      type="button"
                      onClick={() => setInfoOpen(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--accent)',
                        padding: 0,
                        textDecoration: 'underline',
                        cursor: 'pointer'
                      }}
                    >
                      GRAFFILAND Terms &amp; Virtual Land Policy
                    </button>
                    , confirm real physical presence, and acknowledge the 5% Robinhood resale royalty.
                  </span>
                </label>

                {publishError && (
                  <div style={{ color: '#ffb3c1', fontSize: 12 }}>
                    <XeroIcon emoji="⚠️" size={14} /> {publishError}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="submit"
                    className="btn btn-pink"
                    style={{ flex: 1 }}
                    disabled={publishing || voxels.length === 0}
                  >
                    <XeroIcon emoji="🚀" size={16} />
                    {publishing ? 'Verifying PoL, Pinning IPFS & Minting...' : 'Publish & Mint NFT'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={publishing || draftsBusy || (voxels.length === 0 && !title.trim() && !description.trim())}
                    onClick={() => handleManualSaveDraft({ closePublish: true })}
                  >
                    <XeroIcon emoji="💾" size={15} />
                    <span>{draftsBusy ? 'Saving...' : 'Save Draft'}</span>
                  </button>
                </div>
                {draftStatusText && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                    <XeroIcon emoji="💾" size={12} /> Auto-draft: {draftStatusText}
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      )}

      {/* Saved Drafts Modal */}
      {draftsOpen && (
        <div className="modal-backdrop" onClick={() => setDraftsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <XeroIcon emoji="💾" size={22} /> Saved Drafts
              </h3>
              <button className="btn" onClick={() => setDraftsOpen(false)}>
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>

            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
              Your canvas auto-saves on this device as you work, and syncs to your account when
              signed in so you never lose unfinished sculptures before publishing.
            </p>

            <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <strong style={{ fontSize: 13 }}>
                    {title.trim() || 'Current Workspace Draft'}
                  </strong>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>
                    {voxels.length} blocks · {draftStatusText || 'Ready'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={draftsBusy || (voxels.length === 0 && !title.trim() && !description.trim())}
                    onClick={() => handleManualSaveDraft({ forceNew: false })}
                  >
                    <XeroIcon emoji="💾" size={14} /> Save Draft
                  </button>
                  {user && activeDraftId && (
                    <button
                      type="button"
                      className="btn"
                      disabled={draftsBusy || (voxels.length === 0 && !title.trim() && !description.trim())}
                      onClick={() => handleManualSaveDraft({ forceNew: true })}
                    >
                      <XeroIcon emoji="📄" size={14} /> Save Copy
                    </button>
                  )}
                  <button type="button" className="btn" onClick={handleStartNewDraft}>
                    <XeroIcon emoji="📝" size={14} /> New Blank
                  </button>
                </div>
              </div>
              {!user && (
                <button
                  type="button"
                  className="btn"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    setDraftsOpen(false);
                    setLoginOpen(true);
                  }}
                >
                  <XeroIcon emoji="🔐" size={14} /> Sign in with Google to Sync Cloud Drafts
                </button>
              )}
            </div>

            {draftError && (
              <div style={{ color: '#ffb3c1', fontSize: 12, marginBottom: 10 }}>
                <XeroIcon emoji="⚠️" size={14} /> {draftError}
              </div>
            )}

            {user && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 13 }}>Cloud Saved Drafts ({cloudDrafts.length})</strong>
                  <button
                    type="button"
                    className="btn"
                    disabled={draftsBusy}
                    onClick={refreshCloudDrafts}
                  >
                    <XeroIcon emoji="🔄" size={13} /> Refresh
                  </button>
                </div>

                {cloudDrafts.length === 0 ? (
                  <div className="card" style={{ padding: 14, fontSize: 12, color: 'var(--muted)' }}>
                    {draftsBusy
                      ? 'Loading cloud drafts...'
                      : 'No cloud drafts yet. Start sculpting or tap Save Draft to back up your work.'}
                  </div>
                ) : (
                  cloudDrafts.map((d) => (
                    <div
                      key={d.id}
                      className="card"
                      style={{
                        padding: 10,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        borderColor: d.id === activeDraftId ? 'var(--accent)' : undefined
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.title || 'Untitled Draft'}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          <span className="badge teal">
                            <XeroIcon emoji="🧱" size={11} /> {d.voxelCount} blocks
                          </span>
                          {d.parcelId && (
                            <span className="badge">
                              <XeroIcon emoji="📍" size={11} /> {d.parcelId}
                            </span>
                          )}
                          <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', alignSelf: 'center' }}>
                            {d.updatedAt ? new Date(d.updatedAt).toLocaleString() : ''}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={draftsBusy}
                          onClick={() => handleLoadDraft(d)}
                        >
                          <XeroIcon emoji="📂" size={13} /> Load
                        </button>
                        <button
                          type="button"
                          className="btn btn-pink"
                          disabled={draftsBusy}
                          onClick={() => handleDeleteCloudDraft(d.id)}
                          aria-label={`Delete draft ${d.title || d.id}`}
                        >
                          <XeroIcon emoji="🗑️" size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Public Area Map View + 3D Review + Google Maps Directions */}
      {mapOpen && (
        <div className="mobile-map-overlay" role="dialog" aria-label="Public Area Sculpture Map">
          <div className="mobile-map-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <XeroIcon emoji="🗺️" size={22} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Public Area Map</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Tap any pin or card to inspect 3D &amp; navigate
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                className={`btn ${areaFilterMode === 'nearby' ? 'btn-primary' : ''}`}
                onClick={() => setAreaFilterMode('nearby')}
              >
                Area (5km)
              </button>
              <button
                type="button"
                className={`btn ${areaFilterMode === 'all' ? 'btn-primary' : ''}`}
                onClick={() => setAreaFilterMode('all')}
              >
                All ({areaSculpturesSorted.length})
              </button>
              <button
                type="button"
                className="btn"
                disabled={mapLoading}
                onClick={loadPublicMapData}
                aria-label="Refresh public map"
              >
                <XeroIcon emoji="🔄" size={14} />
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setMapOpen(false)}
                aria-label="Close map"
              >
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>
          </div>

          <div className="mobile-map-canvas">
            <MapView
              sculptures={displayedMapSculptures}
              parcels={mapParcels}
              userLocation={location}
              focusArea={areaFilterMode === 'nearby'}
              areaRadiusMeters={5000}
              selectedSculptureId={mapSelectedSculpture?.id || ''}
              config={config}
              compact
              onSelectSculpture={(sc) => setMapSelectedSculpture(sc)}
            />
          </div>

          <div className="mobile-map-list">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>
                Sculptures {areaFilterMode === 'nearby' && location ? 'in Your Area' : 'Worldwide'} ({displayedMapSculptures.length})
              </strong>
              {areaFilterMode === 'nearby' &&
                displayedMapSculptures.length === 0 &&
                areaSculpturesSorted.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setAreaFilterMode('all')}
                  >
                    Show All Public ({areaSculpturesSorted.length})
                  </button>
                )}
            </div>

            {mapLoading && displayedMapSculptures.length === 0 ? (
              <div className="card" style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>
                Loading nearby sculptures...
              </div>
            ) : displayedMapSculptures.length === 0 ? (
              <div className="card" style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>
                No public sculptures in this area yet. Be the first to paint &amp; mint here!
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {displayedMapSculptures.map((sc) => {
                  const chainLinks = getSculptureChainLinks(sc, config);
                  const txShort = sc.chain?.txHash ? `${sc.chain.txHash.slice(0, 10)}...` : '';
                  const distText =
                    sc.distanceMeters == null
                      ? ''
                      : sc.distanceMeters >= 1000
                      ? `${(sc.distanceMeters / 1000).toFixed(1)} km`
                      : `${sc.distanceMeters} m`;
                  return (
                    <div
                      key={sc.id}
                      className="card mobile-map-item"
                      onClick={() => setMapSelectedSculpture(sc)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setMapSelectedSculpture(sc);
                        }
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{sc.title}</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          {distText && (
                            <span className="badge teal">
                              <XeroIcon emoji="📍" size={11} /> {distText}
                            </span>
                          )}
                          <span className="badge gold">
                            <XeroIcon emoji="🗺️" size={11} /> Land {sc.parcelId}
                          </span>
                          <span className="badge">
                            <XeroIcon emoji="🧱" size={11} /> {sc.voxelCount} blocks
                          </span>
                          {chainLinks.txUrl ? (
                            <a
                              className="badge teal"
                              href={chainLinks.txUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="View mint transaction on chain"
                            >
                              <XeroIcon emoji="⛓️" size={11} /> Tx {txShort}
                            </a>
                          ) : txShort ? (
                            <span className="badge">
                              <XeroIcon emoji="⛓️" size={11} />{' '}
                              {chainLinks.isSimulated ? 'Pre-chain' : 'Tx'} {txShort}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMapSelectedSculpture(sc);
                        }}
                      >
                        <XeroIcon emoji="🧊" size={14} /> Review 3D
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {mapSelectedSculpture && (
        <SculptureModal
          sculpture={mapSelectedSculpture}
          user={user}
          config={config}
          userLocation={location}
          onSculptureUpdated={(updated) => {
            setMapSelectedSculpture(updated);
            setMapSculptures((prev) =>
              prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
            );
          }}
          onClose={() => setMapSelectedSculpture(null)}
        />
      )}

      {chatSelection && (
        <SculptureChatDrawer
          sculpture={chatSelection.sculpture}
          user={user}
          location={location}
          polTracker={polRef.current}
          cameraReady={cameraReady}
          initialSightProof={chatSelection.sightProof}
          onRequestLogin={() => setLoginOpen(true)}
          onClose={() => setChatSelection(null)}
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
