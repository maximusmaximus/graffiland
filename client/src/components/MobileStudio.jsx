import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { api } from '../utils/api.js';
import { getWsUrl } from '../utils/device.js';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
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

  // Orientation & fallback pan
  const yawOffsetRef = useRef(0);
  const rawOrientationRef = useRef(null);
  const fallbackEulerRef = useRef({ yaw: 0, pitch: 0 });
  const dragStartRef = useRef(null);
  const voxelsRef = useRef([]);
  const modeRef = useRef(mode);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const materialRef = useRef(material);
  const reachRef = useRef(reachMeters);
  const occlusionEnabledRef = useRef(occlusionEnabled);
  const userRef = useRef(user);
  const locationRef = useRef(location);
  const paintingRef = useRef(false);
  const lastPaintPosRef = useRef(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    occlusionEnabledRef.current = occlusionEnabled;
  }, [occlusionEnabled]);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // Publish state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
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
            width: { ideal: 1280 },
            height: { ideal: 720 }
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
    setVoxels((prev) => {
      if (target.action === 'erase' && target.voxel) {
        const killKey = voxelKey(target.voxel.x, target.voxel.y, target.voxel.z);
        return prev.filter((v) => voxelKey(v.x, v.y, v.z) !== killKey);
      }
      if (target.action === 'add') {
        if (prev.length >= (config?.policy?.maxVoxels || 512)) return prev;
        const k = voxelKey(target.x, target.y, target.z);
        if (prev.some((v) => voxelKey(v.x, v.y, v.z) === k)) return prev;
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
  }, [config?.policy?.maxVoxels]);

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

  function handleCanvasPointerDown(e) {
    dragStartRef.current = { x: e.clientX, y: e.clientY };
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

  function handleCanvasPointerUp() {
    dragStartRef.current = null;
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
      setMintReceipt(res);
      setVoxels([]);
      setTitle('');
      setDescription('');
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

        {/* Paint / Stack Trigger Button */}
        {mode === 'draw' && (
          <button
            className={`paint-action-pill ${painting ? 'painting' : ''}`}
            onPointerDown={handlePaintStart}
            onPointerUp={handlePaintEnd}
            onPointerCancel={handlePaintEnd}
            onPointerLeave={handlePaintEnd}
            aria-label="Draw or stack voxel"
          >
            <XeroIcon
              emoji={tool === 'stack' ? '🧱' : tool === 'erase' ? '🗑️' : '🖌️'}
              size={28}
            />
          </button>
        )}

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
