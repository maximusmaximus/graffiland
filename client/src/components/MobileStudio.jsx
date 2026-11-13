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
  { id: 'erase', emoji: '🗑️', label: 'Erase', hint: 'Aim block & tap to remove' },
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
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import SculptureChatDrawer from './SculptureChatDrawer.jsx';
import { ForegroundOcclusionCompositor } from './ForegroundOcclusion.js';
import { ProofOfLocationTracker } from './ProofOfLocation.js';
import {
  buildVoxelGroup,
  computeSolarLightVector,
  createLiveEnvUpdater,
  deviceOrientationToQuaternion,
  GRAFFITI_PALETTE,
  latLngOffsetMeters,
  snapCoord,
  VOXEL_STEP,
  voxelKey
} from './VoxelEngine3D.js';
import XeroIcon from './XeroIcon.jsx';

export default function MobileStudio({ config, user, onUserUpdate, onLogout }) {
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
  const dirLightRef = useRef(null);
  const hemiLightRef = useRef(null);
  const occlusionWallRef = useRef(null);
  const envUpdaterRef = useRef(null);
  const occlusionRef = useRef(new ForegroundOcclusionCompositor());
  const polRef = useRef(new ProofOfLocationTracker());
  const wsRef = useRef(null);

  // Studio states
  const [mode, setMode] = useState('draw'); // 'draw' | 'preview' | 'publish'
  const [tool, setTool] = useState('brush'); // 'brush' | 'stack' | 'erase'
  const [material, setMaterial] = useState('matte'); // 'matte' | 'neon' | 'glass'
  const [color, setColor] = useState(GRAFFITI_PALETTE[0]);
  const [reachMeters, setReachMeters] = useState(1.8);
  const [voxels, setVoxels] = useState([]);
  const [nearbySculptures, setNearbySculptures] = useState([]);

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
  const [painting, setPainting] = useState(false);
  const [activeKeyTool, setActiveKeyTool] = useState('brush');
  const [swipeDragPx, setSwipeDragPx] = useState(0);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentCopied, setAgentCopied] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [agentSession, setAgentSession] = useState(null);
  const keyGestureRef = useRef({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
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
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cluePrompt, setCluePrompt] = useState('');
  const [clueAnswer, setClueAnswer] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [mintReceipt, setMintReceipt] = useState(null);

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
            width: { ideal: 3840 },
            height: { ideal: 2160 }
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
        setLocation(loc);

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

  // Build & sync Three.js draft voxels
  const rebuildDraftMesh = useCallback((nextVoxels) => {
    const group = draftGroupRef.current;
    if (!group) return;
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
    }
    const built = buildVoxelGroup(nextVoxels);
    group.add(built);
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

  const computeTargetVoxel = useCallback(() => {
    const cam = cameraRef.current;
    const draftGroup = draftGroupRef.current;
    if (!cam) return null;

    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const origin = cam.position.clone();

    if (toolRef.current === 'stack' || toolRef.current === 'erase') {
      const raycaster = new THREE.Raycaster(origin, dir, 0.1, 14);
      const targets = [];
      draftGroup?.traverse((obj) => {
        if (obj.isMesh) targets.push(obj);
      });
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length > 0) {
        const hit = hits[0];
        if (toolRef.current === 'erase') {
          return { action: 'erase', voxel: hit.object.userData.voxel };
        }
        const normal = hit.face.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
          .normalize();
        const center = hit.object.position.clone().addScaledVector(normal, VOXEL_STEP);
        return {
          action: 'add',
          x: snapCoord(center.x),
          y: snapCoord(center.y),
          z: snapCoord(center.z)
        };
      }
      if (toolRef.current === 'erase') return null;
    }

    const pt = origin.addScaledVector(dir, reachRef.current);
    return {
      action: 'add',
      x: snapCoord(pt.x),
      y: snapCoord(pt.y),
      z: snapCoord(pt.z)
    };
  }, []);

  const applyVoxelAction = useCallback((target) => {
    if (!target) return;
    if (target.action === 'add') {
      const halfSpan = config?.policy?.areaHalfSpanMeters || AREA_HALF_SPAN_METERS;
      if (
        Math.abs(target.x) > halfSpan ||
        Math.abs(target.y) > halfSpan ||
        Math.abs(target.z) > halfSpan
      ) {
        setSensorBanner(
          `Area limit reached (${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} blocks max)`
        );
        return;
      }
    }
    setVoxels((prev) => {
      if (target.action === 'erase' && target.voxel) {
        const killKey = voxelKey(target.voxel.x, target.voxel.y, target.voxel.z);
        return prev.filter((v) => voxelKey(v.x, v.y, v.z) !== killKey);
      }
      if (target.action === 'add') {
        const maxVoxels = config?.policy?.maxVoxels || 4096;
        if (prev.length >= maxVoxels) {
          setSensorBanner(`Sculpture voxel limit (${maxVoxels}) reached`);
          return prev;
        }
        const k = voxelKey(target.x, target.y, target.z);
        if (prev.some((v) => voxelKey(v.x, v.y, v.z) === k)) return prev;

        if (prev.length > 0) {
          let minX = target.x;
          let maxX = target.x;
          let minY = target.y;
          let maxY = target.y;
          let minZ = target.z;
          let maxZ = target.z;
          for (const v of prev) {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
            if (v.z < minZ) minZ = v.z;
            if (v.z > maxZ) maxZ = v.z;
          }
          const spanX = Math.round((maxX - minX) / VOXEL_STEP) + 1;
          const spanY = Math.round((maxY - minY) / VOXEL_STEP) + 1;
          const spanZ = Math.round((maxZ - minZ) / VOXEL_STEP) + 1;
          if (spanX > AREA_LIMIT_BLOCKS || spanY > AREA_LIMIT_BLOCKS || spanZ > AREA_LIMIT_BLOCKS) {
            setSensorBanner(
              `Area span exceeds ${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS}x${AREA_LIMIT_BLOCKS} blocks`
            );
            return prev;
          }
        }

        return [
          ...prev,
          {
            x: target.x,
            y: target.y,
            z: target.z,
            color: colorRef.current,
            material: materialRef.current,
            scale: 1
          }
        ];
      }
      return prev;
    });
  }, [config?.policy?.areaHalfSpanMeters, config?.policy?.maxVoxels]);

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 4));
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
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
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
    grid.material.opacity = 0.2;
    scene.add(grid);

    const draftGroup = new THREE.Group();
    const nearbyGroup = new THREE.Group();
    scene.add(draftGroup);
    scene.add(nearbyGroup);

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

    const handleResize = () => {
      if (!host) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
      if (occlusionCanvasRef.current) {
        occlusionCanvasRef.current.width = host.clientWidth;
        occlusionCanvasRef.current.height = host.clientHeight;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    let rafId = 0;
    let lastWsPush = 0;
    let lastEnvPush = 0;
    let lastOcclusionPush = 0;
    let lastTargetCheck = 0;
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

      if (showCursor) {
        const target = computeTargetVoxel();
        if (target && target.action === 'add') {
          ghost.position.set(target.x, target.y, target.z);
          ghost.material.color.set(colorRef.current);

          if (paintingRef.current && toolRef.current === 'brush') {
            const prev = lastPaintPosRef.current;
            if (
              !prev ||
              Math.hypot(target.x - prev.x, target.y - prev.y, target.z - prev.z) >= VOXEL_STEP * 0.8
            ) {
              lastPaintPosRef.current = { x: target.x, y: target.y, z: target.z };
              applyVoxelAction(target);
            }
          }
        } else if (target && target.action === 'erase' && target.voxel) {
          ghost.position.set(target.voxel.x, target.voxel.y, target.voxel.z);
          ghost.material.color.set(0xff3e7f);
        }
      }

      const now = performance.now();
      if (now - lastEnvPush > 950 && videoRef.current && envUpdaterRef.current) {
        lastEnvPush = now;
        const envData = envUpdaterRef.current.update(videoRef.current);
        if (envData) {
          scene.environment = envData.envTexture;
          hemiLight.color.setHex(envData.skyColor);
          hemiLight.groundColor.setHex(envData.groundColor);
        }
      }

      if (now - lastOcclusionPush > 65 && occlusionCanvasRef.current) {
        lastOcclusionPush = now;
        occlusionRef.current.processFrame(
          videoRef.current,
          occlusionCanvasRef.current,
          rawOrientationRef.current,
          occlusionEnabledRef.current
        );
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
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      envUpdaterRef.current?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, [applyVoxelAction, computeTargetVoxel]);

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
            setMode('draw');
            setTool(msg.tool);
          }
          if (msg.action === 'set_mode' && msg.mode) {
            if (msg.mode === 'publish' && !userRef.current) {
              setLoginOpen(true);
            } else {
              setMode(msg.mode);
            }
          }
          if (msg.action === 'undo') setVoxels((p) => p.slice(0, -1));
          if (msg.action === 'clear') setVoxels([]);
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
    if (mode !== prev.mode) {
      if (mode === 'preview' || mode === 'publish') {
        setActiveKeyTool(mode);
      } else if (mode === 'draw') {
        setActiveKeyTool(tool);
      }
    } else if (tool !== prev.tool && mode === 'draw') {
      setActiveKeyTool(tool);
    }
    prevSyncStateRef.current = { mode, tool };
  }, [mode, tool]);

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

  function selectKeyTool(toolId) {
    setActiveKeyTool(toolId);
    if (toolId === 'brush' || toolId === 'stack' || toolId === 'erase') {
      setMode('draw');
      setTool(toolId);
    } else if (toolId === 'preview') {
      setMode('preview');
    } else if (toolId === 'agent' || toolId === 'publish') {
      setMode('draw');
    }
  }

  function stepKeyTool(delta) {
    const idx = KEY_TOOLS.findIndex((t) => t.id === activeKeyTool);
    const current = idx >= 0 ? idx : 0;
    const nextIdx = (current + delta + KEY_TOOLS.length) % KEY_TOOLS.length;
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
    if (activeKeyTool === 'brush' || activeKeyTool === 'stack' || activeKeyTool === 'erase') {
      setMode('draw');
      setTool(activeKeyTool);
      toolRef.current = activeKeyTool;
      applyVoxelAction(computeTargetVoxel());
    } else if (activeKeyTool === 'preview') {
      setMode((m) => (m === 'preview' ? 'draw' : 'preview'));
    } else if (activeKeyTool === 'agent') {
      openAgentHandoff();
    } else if (activeKeyTool === 'publish') {
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
    keyGestureRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      swiped: false,
      holdStarted: false
    };
    setSwipeDragPx(0);

    if (activeKeyTool === 'brush') {
      paintHoldTimerRef.current = setTimeout(() => {
        if (!keyGestureRef.current.active || keyGestureRef.current.swiped) return;
        enterFullscreen();
        keyGestureRef.current.holdStarted = true;
        setMode('draw');
        setTool('brush');
        toolRef.current = 'brush';
        paintingRef.current = true;
        setPainting(true);
        const t = computeTargetVoxel();
        if (t) {
          lastPaintPosRef.current = { x: t.x, y: t.y, z: t.z };
          applyVoxelAction(t);
        }
      }, 120);
    }
  }

  function handleKeyPointerMove(e) {
    const g = keyGestureRef.current;
    if (!g.active || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    if (!g.swiped && Math.abs(dx) >= 26) {
      g.swiped = true;
      stopBrushPainting();
      stepKeyTool(dx > 0 ? 1 : -1);
      setSwipeDragPx(0);
      return;
    }
    if (!g.swiped && Math.abs(dx) > 4) {
      setSwipeDragPx(Math.max(-34, Math.min(34, dx)));
    }
  }

  function handleKeyPointerUp(e) {
    const g = keyGestureRef.current;
    if (!g.active) return;
    const wasSwiped = g.swiped;
    const wasHold = g.holdStarted;
    keyGestureRef.current.active = false;
    keyGestureRef.current.swiped = false;
    keyGestureRef.current.holdStarted = false;
    setSwipeDragPx(0);
    stopBrushPainting();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (!wasSwiped && !wasHold) {
      triggerActiveKeyTool();
    }
  }

  function handleKeyPointerCancel() {
    keyGestureRef.current.active = false;
    keyGestureRef.current.swiped = false;
    keyGestureRef.current.holdStarted = false;
    setSwipeDragPx(0);
    stopBrushPainting();
  }

  function handlePaintStart() {
    enterFullscreen();
    if (mode !== 'draw') return;
    if (tool === 'brush') {
      paintingRef.current = true;
      setPainting(true);
      lastPaintPosRef.current = null;
      const target = computeTargetVoxel();
      applyVoxelAction(target);
    } else {
      const target = computeTargetVoxel();
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
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    tapStartRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  function handleCanvasPointerMove(e) {
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

  function handleCanvasPointerUp(e) {
    dragStartRef.current = null;
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (!start || modeRef.current !== 'preview') return;

    const moveDist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moveDist > 14) return;

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

  function openPublishSheet() {
    if (!user) {
      setLoginOpen(true);
      return;
    }
    setPublishError('');
    setMintReceipt(null);
    setMode('publish');
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
      const res = await api.publishSculpture({
        title,
        description,
        termsAccepted,
        voxels,
        previewDataUrl,
        location,
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

      setMintReceipt(res);
      setVoxels([]);
      setTitle('');
      setDescription('');
      setCluePrompt('');
      setClueAnswer('');
      setTermsAccepted(false);
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
      <div
        ref={canvasHostRef}
        className="webgl-overlay"
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
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
              top: 64,
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
              background: 'rgba(12, 18, 34, 0.86)',
              border: '1px solid rgba(0, 245, 212, 0.45)',
              fontSize: 12,
              color: 'var(--text)',
              zIndex: 28
            }}
          >
            <XeroIcon emoji="🔒" size={14} /> {arSelectHint}
          </div>
        )}

        {/* Centered Swipeable Key Button */}
        {(() => {
          const idx = KEY_TOOLS.findIndex((t) => t.id === activeKeyTool);
          const safeIdx = idx >= 0 ? idx : 0;
          const activeItem = KEY_TOOLS[safeIdx];
          const prevItem = KEY_TOOLS[(safeIdx - 1 + KEY_TOOLS.length) % KEY_TOOLS.length];
          const nextItem = KEY_TOOLS[(safeIdx + 1) % KEY_TOOLS.length];
          return (
            <div className="key-carousel hud-interactive">
              <div className="key-tool-caption">
                <XeroIcon emoji="🔑" size={12} />
                <span>{activeItem.label}</span>
                <span className="key-tool-hint">· Swipe ◀️ ▶️</span>
              </div>
              <div className="key-carousel-row">
                <button
                  type="button"
                  className="key-step-btn"
                  onClick={() => stepKeyTool(-1)}
                  aria-label="Previous tool"
                  title={`Previous: ${prevItem.label}`}
                >
                  <XeroIcon emoji={prevItem.emoji} size={16} />
                  <XeroIcon emoji="◀️" size={12} />
                </button>

                <button
                  type="button"
                  className={`key-action-btn ${painting ? 'painting' : ''} tool-${activeItem.id}`}
                  style={{ transform: `translateX(${swipeDragPx}px)` }}
                  onPointerDown={handleKeyPointerDown}
                  onPointerMove={handleKeyPointerMove}
                  onPointerUp={handleKeyPointerUp}
                  onPointerCancel={handleKeyPointerCancel}
                  aria-label={`${activeItem.label} key button (swipe left or right to switch tool)`}
                  title={activeItem.hint}
                >
                  <XeroIcon emoji={activeItem.emoji} size={30} />
                </button>

                <button
                  type="button"
                  className="key-step-btn"
                  onClick={() => stepKeyTool(1)}
                  aria-label="Next tool"
                  title={`Next: ${nextItem.label}`}
                >
                  <XeroIcon emoji="▶️" size={12} />
                  <XeroIcon emoji={nextItem.emoji} size={16} />
                </button>
              </div>
            </div>
          );
        })()}

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
                setMode('draw');
                setTool('brush');
              }}
              title="3D Brush"
            >
              <XeroIcon emoji="🖌️" size={19} />
            </button>
            <button
              className={`dock-btn ${mode === 'draw' && tool === 'stack' ? 'active' : ''}`}
              onClick={() => {
                setMode('draw');
                setTool('stack');
              }}
              title="Stack Voxels"
            >
              <XeroIcon emoji="🧱" size={19} />
            </button>
            <button
              className={`dock-btn pink ${mode === 'draw' && tool === 'erase' ? 'active' : ''}`}
              onClick={() => {
                setMode('draw');
                setTool('erase');
              }}
              title="Erase Voxel"
            >
              <XeroIcon emoji="🗑️" size={19} />
            </button>
            <button
              className={`dock-btn ${paletteOpen ? 'active' : ''}`}
              onClick={() => setPaletteOpen((p) => !p)}
              title="Colors & Finish"
            >
              <XeroIcon emoji="🎨" size={19} />
            </button>
            <button
              className="dock-btn"
              onClick={() => setVoxels((p) => p.slice(0, -1))}
              title="Undo"
            >
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
              onClick={() => setMode((m) => (m === 'preview' ? 'draw' : 'preview'))}
              title="AR Preview Nearby Sculptures"
            >
              <XeroIcon emoji="👁️" size={19} />
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

                <button
                  type="submit"
                  className="btn btn-pink"
                  disabled={publishing || voxels.length === 0}
                >
                  <XeroIcon emoji="🚀" size={16} />
                  {publishing ? 'Verifying PoL, Pinning IPFS & Minting...' : 'Publish & Mint NFT'}
                </button>
              </form>
            )}
          </div>
        </div>
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
