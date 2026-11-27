import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { api, resolveApiUrl } from '../utils/api.js';
import {
  AR_MAX_VISIBLE_DISTANCE_METERS,
  computeArLandPrismLocalGeometry,
  computeArSculptureVerticalY,
  computeParcelEdgeDistanceMeters,
  findNearbyCameraLands,
  isWithinArCameraVisibilityRange
} from '../utils/arLandHelpers.js';
import {
  applyProximitySharpnessToObject3D,
  blendHexWithAtmosphericHaze,
  computeProximitySharpness,
  DEFAULT_ATMOSPHERIC_HAZE_HEX
} from '../utils/arLandGuidance.js';
import {
  computeRotatedBoxDimensions,
  extractSculptureRotation,
  extractSculptureScale,
  parcelLocalMetersToWorldMeters,
  parcelLocalYawToWorldYawRad,
  tiltToRadians
} from '../../../shared/sculpturePlacement.mjs';
import { loadCustomModelObject } from '../utils/customModelLoader.js';
import { createDepthFadedThreePrismWireframe } from '../utils/prismDepthFade.js';
import {
  groupNearestLandsWithSculptures,
  isLandOwnedByUser
} from '../utils/landMapHelpers.js';
import { resolveParcelVolume } from '../utils/landPreviewHelpers.js';
import {
  buildVoxelGroup,
  disposeObject3D,
  latLngOffsetMeters
} from '../components/VoxelEngine3D.js';
import {
  ORB_DEFAULT_MAX_REPROJ_ERR_PX,
  meetsClientInitialCalibrationGate,
  unwrapOrbPackCacheEntry
} from '../utils/orbMatcher.js';

/**
 * Manages nearby AR sculptures & 3D holographic land volumes rendering (in BOTH draw and
 * preview camera modes), tap-to-inspect AR land interaction state, live ORB relocalization
 * with smooth heading yaw correction, and the mobile Public Area Map drawer.
 */
export function useARPreview({
  user = null,
  ownedParcelIds = [],
  mode,
  location,
  locationRef,
  cameraReady,
  videoRef,
  orbTrackerRef,
  orbKeyframesRef,
  orbPackCacheRef,
  latestOrbProofRef,
  setOrbStatus,
  nearbyGroupRef,
  modeRef,
  commitTransformAndExit,
  stopBrushPainting,
  showTemporaryHint,
  focusedLandId = '',
  isArViewOnly = false,
  editingSculptureId = '',
  fadeOtherItems = false,
  atmosphericTintRef = null,
  orientationFusionRef = null
}) {
  const hydratedSculptureMapRef = useRef(new Map());
  const arSculptureEntriesRef = useRef(new Map());
  const arPrismNodesRef = useRef([]);
  const arSelectedLandIdRef = useRef('');
  const arTargetedIdRef = useRef('');
  const orbHeadingCorrectionRadRef = useRef(0);
  const autoCalAttemptedRef = useRef(new Set());
  const autoCalBuffersRef = useRef(new Map());
  const [arModelLoadedTick, setArModelLoadedTick] = useState(0);
  const [visibleOtherItemsCount, setVisibleOtherItemsCount] = useState(0);

  const [nearbySculptures, setNearbySculptures] = useState([]);
  const [nearbyParcels, setNearbyParcels] = useState([]);
  const [arTargetedSculpture, setArTargetedSculpture] = useState(null);
  const [arSelectedLandId, setArSelectedLandIdState] = useState('');
  const [selectedLandSnapshot, setSelectedLandSnapshot] = useState(null);
  const [arLandGuidance, setArLandGuidance] = useState(null);
  const [selectedLandLoadState, setSelectedLandLoadState] = useState({
    parcelId: '',
    status: 'idle',
    loadedCount: 0,
    totalCount: 0
  });
  const selectedLandApiDoneRef = useRef({ parcelId: '', done: true });

  const [mapOpen, setMapOpen] = useState(false);
  const [mapInitialDimensionMode, setMapInitialDimensionMode] = useState('3d');
  const [areaFilterMode, setAreaFilterMode] = useState('nearby');
  const [mapSculptures, setMapSculptures] = useState([]);
  const [mapParcels, setMapParcels] = useState([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSelectedSculpture, setMapSelectedSculpture] = useState(null);
  const [mapSelectedParcelId, setMapSelectedParcelId] = useState('');
  const [mapFocusParcelTick, setMapFocusParcelTick] = useState(0);

  const setArSelectedLandId = useCallback((nextId) => {
    const clean = String(nextId || '').trim();
    arSelectedLandIdRef.current = clean;
    setArSelectedLandIdState(clean);
    if (!clean) {
      setSelectedLandSnapshot(null);
      setArLandGuidance(null);
      setSelectedLandLoadState({ parcelId: '', status: 'idle', loadedCount: 0, totalCount: 0 });
    }
  }, []);

  const selectArLand = useCallback((parcel, sculptures = []) => {
    const clean = String(parcel?.parcelId || '').trim();
    arSelectedLandIdRef.current = clean;
    setArSelectedLandIdState(clean);
    if (!clean) {
      setSelectedLandSnapshot(null);
      setArLandGuidance(null);
      setSelectedLandLoadState({ parcelId: '', status: 'idle', loadedCount: 0, totalCount: 0 });
      return;
    }
    setSelectedLandSnapshot({
      parcel,
      sculptures: Array.isArray(sculptures) ? sculptures : []
    });
  }, []);

  const hydrateNearbyList = useCallback(async (lightList, curLoc) => {
    const mergedInitial = (lightList || []).map((sc) => {
      const cached = hydratedSculptureMapRef.current.get(sc.id);
      if (cached && Number(cached.currentRev || 1) === Number(sc.currentRev || 1)) {
        return { ...sc, ...cached };
      }
      return sc;
    });
    setNearbySculptures(mergedInitial);

    if (!curLoc) return;
    const toFetch = mergedInitial
      .filter((sc) => {
        const d =
          sc.distanceMeters ?? haversineMeters(curLoc.lat, curLoc.lng, sc.lat, sc.lng);
        const cached = hydratedSculptureMapRef.current.get(sc.id);
        const alreadyHydrated =
          cached &&
          Number(cached.currentRev || 1) === Number(sc.currentRev || 1) &&
          (cached.modelType === 'custom-3d' || (cached.voxels && cached.voxels.length > 0));
        return isWithinArCameraVisibilityRange(d) && !alreadyHydrated;
      })
      .slice(0, 16);

    if (toFetch.length === 0) return;

    const fetched = await Promise.all(
      toFetch.map((sc) =>
        api
          .getSculpture(sc.id)
          .then((r) => r?.sculpture || null)
          .catch(() => null)
      )
    );
    let updated = false;
    for (const full of fetched) {
      if (full?.id) {
        hydratedSculptureMapRef.current.set(full.id, full);
        updated = true;
      }
    }
    if (updated) {
      setNearbySculptures((prev) =>
        prev.map((sc) => {
          const cached = hydratedSculptureMapRef.current.get(sc.id);
          return cached ? { ...sc, ...cached } : sc;
        })
      );
    }
  }, []);

  // Merge nearbyParcels with mapParcels (+ selected snapshot) so live camera AR always sees fresh parcel metadata & volumes
  const mergedCameraParcels = useMemo(() => {
    const byId = new Map();
    for (const p of mapParcels || []) {
      if (p?.parcelId) byId.set(p.parcelId, p);
    }
    for (const p of nearbyParcels || []) {
      if (p?.parcelId) byId.set(p.parcelId, { ...(byId.get(p.parcelId) || {}), ...p });
    }
    if (selectedLandSnapshot?.parcel?.parcelId) {
      const pid = selectedLandSnapshot.parcel.parcelId;
      byId.set(pid, { ...(byId.get(pid) || {}), ...selectedLandSnapshot.parcel });
    }
    return Array.from(byId.values());
  }, [mapParcels, nearbyParcels, selectedLandSnapshot]);

  const cameraLands = useMemo(
    () =>
      findNearbyCameraLands({
        parcels: mergedCameraParcels,
        sculptures: nearbySculptures,
        location,
        user,
        ownedParcelIds,
        maxDistanceMeters: AR_MAX_VISIBLE_DISTANCE_METERS,
        nearThresholdMeters: 45
      }),
    [location, mergedCameraParcels, nearbySculptures, ownedParcelIds, user]
  );

  // Strict < 300 ft (91.44 m) visibility cutoff: never render lands >= 300 ft away in AR camera view
  const renderedCameraLands = cameraLands.visibleLands;

  const activeArLand = useMemo(() => {
    if (!arSelectedLandId) return null;
    const matched = renderedCameraLands.find((l) => l.parcelId === arSelectedLandId);
    if (matched) return { ...matched, outOfArRange: false };
    const rawFallback =
      mergedCameraParcels.find((p) => p?.parcelId === arSelectedLandId) ||
      (selectedLandSnapshot?.parcel?.parcelId === arSelectedLandId
        ? selectedLandSnapshot.parcel
        : null);
    if (!rawFallback) return null;
    const fallbackSculptures =
      selectedLandSnapshot?.parcel?.parcelId === arSelectedLandId &&
      Array.isArray(selectedLandSnapshot.sculptures) &&
      selectedLandSnapshot.sculptures.length > 0
        ? selectedLandSnapshot.sculptures
        : (nearbySculptures || []).filter((sc) => sc?.parcelId === arSelectedLandId);
    const grouped = groupNearestLandsWithSculptures({
      parcels: [rawFallback],
      sculptures: fallbackSculptures,
      location: location || null,
      filterMode: 'all'
    }).allLands[0];
    if (!grouped) return null;
    const resolvedVol = resolveParcelVolume(grouped) || grouped.volume || null;
    const exactEdgeDist =
      location && resolvedVol
        ? computeParcelEdgeDistanceMeters(location.lat, location.lng, resolvedVol)
        : Number.isFinite(Number(grouped.distanceMeters))
        ? Number(grouped.distanceMeters)
        : Number.POSITIVE_INFINITY;
    const outOfArRange = Boolean(location) && !isWithinArCameraVisibilityRange(exactEdgeDist);
    return {
      ...grouped,
      volume: resolvedVol,
      edgeDistanceMeters: Number.isFinite(exactEdgeDist) ? Math.round(exactEdgeDist) : grouped.distanceMeters,
      edgeDistanceMetersExact: Number.isFinite(exactEdgeDist) ? exactEdgeDist : null,
      outOfArRange,
      isOwned: isLandOwnedByUser(grouped, { user, ownedParcelIds })
    };
  }, [
    arSelectedLandId,
    location,
    mergedCameraParcels,
    nearbySculptures,
    ownedParcelIds,
    renderedCameraLands,
    selectedLandSnapshot,
    user
  ]);

  // Eagerly fetch full land metadata + every sculpture's full voxel/3D payload whenever
  // the user selects a nearby land so when they turn their camera to see it, it renders
  // immediately and crisply (never blank or missing artworks beyond 65m).
  useEffect(() => {
    if (!arSelectedLandId) {
      selectedLandApiDoneRef.current = { parcelId: '', done: true };
      return undefined;
    }
    let cancelled = false;
    selectedLandApiDoneRef.current = { parcelId: arSelectedLandId, done: false };
    setSelectedLandLoadState({
      parcelId: arSelectedLandId,
      status: 'loading',
      loadedCount: 0,
      totalCount: 0
    });

    (async () => {
      try {
        const detail = await api.getLandDetail(arSelectedLandId).catch(() => null);
        if (cancelled) return;
        const freshParcel = detail?.parcel || null;
        if (freshParcel?.parcelId) {
          setNearbyParcels((prev) => {
            const list = Array.isArray(prev) ? prev : [];
            const idx = list.findIndex((p) => p?.parcelId === freshParcel.parcelId);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = { ...next[idx], ...freshParcel };
              return next;
            }
            return [...list, freshParcel];
          });
        }

        const parcelSculptures = Array.isArray(detail?.sculptures) ? detail.sculptures : [];
        const total = parcelSculptures.length;
        let readyCount = 0;

        const hydratedResults = await Promise.all(
          parcelSculptures.map(async (sc) => {
            if (!sc?.id) return null;
            const cached = hydratedSculptureMapRef.current.get(sc.id);
            const isAlreadyFull =
              cached &&
              Number(cached.currentRev || 1) === Number(sc.currentRev || 1) &&
              (cached.modelType === 'custom-3d' || (Array.isArray(cached.voxels) && cached.voxels.length > 0));
            if (isAlreadyFull) {
              readyCount += 1;
              return { ...sc, ...cached };
            }
            const hasFullInline =
              sc.modelType === 'custom-3d' ||
              (Array.isArray(sc.voxels) && sc.voxels.length > 0);
            if (hasFullInline) {
              hydratedSculptureMapRef.current.set(sc.id, sc);
              readyCount += 1;
              return sc;
            }
            const fetched = await api
              .getSculpture(sc.id)
              .then((r) => r?.sculpture || null)
              .catch(() => null);
            const resolved = fetched ? { ...sc, ...fetched } : sc;
            if (resolved?.id) {
              hydratedSculptureMapRef.current.set(resolved.id, resolved);
            }
            readyCount += 1;
            return resolved;
          })
        );

        if (cancelled) return;
        const validFull = hydratedResults.filter((item) => item?.id);
        if (validFull.length > 0) {
          setNearbySculptures((prev) => {
            const byId = new Map();
            for (const item of prev || []) {
              if (item?.id) byId.set(item.id, item);
            }
            for (const full of validFull) {
              byId.set(full.id, { ...(byId.get(full.id) || {}), ...full });
            }
            return Array.from(byId.values());
          });
        }

        selectedLandApiDoneRef.current = { parcelId: arSelectedLandId, done: true };
        const hasPendingCustom3d = validFull.some(
          (sc) => sc.modelType === 'custom-3d' && sc.customModel?.format
        );
        setSelectedLandLoadState((prev) => {
          if (prev.parcelId !== arSelectedLandId) return prev;
          return {
            parcelId: arSelectedLandId,
            status: hasPendingCustom3d && prev.status === 'loading' ? 'loading' : 'ready',
            loadedCount: readyCount,
            totalCount: total
          };
        });
      } catch {
        if (!cancelled) {
          selectedLandApiDoneRef.current = { parcelId: arSelectedLandId, done: true };
          setSelectedLandLoadState((prev) =>
            prev.parcelId === arSelectedLandId ? { ...prev, status: 'ready' } : prev
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [arSelectedLandId]);

  // Clean up cached AR sculpture meshes & land prisms strictly on hook unmount
  useEffect(() => {
    const entries = arSculptureEntriesRef.current;
    const prisms = arPrismNodesRef;
    return () => {
      for (const entry of entries.values()) {
        entry.cancelled = true;
        if (entry.sub) {
          entry.sub.parent?.remove?.(entry.sub);
          disposeObject3D(entry.sub);
        }
      }
      entries.clear();
      for (const node of prisms.current) {
        node.parent?.remove?.(node);
        disposeObject3D(node);
      }
      prisms.current = [];
    };
  }, []);

  // Build nearby sculptures + glowing interactive 3D land volume prisms in BOTH draw and preview modes.
  // Sculptures are cached & repositioned in place across GPS ticks so custom 3D GLB downloads are
  // NEVER cancelled or re-fetched every time watchPosition fires!
  useEffect(() => {
    const group = nearbyGroupRef.current;
    if (!group) return undefined;
    const entries = arSculptureEntriesRef.current;

    const clearAllPrisms = () => {
      for (const node of arPrismNodesRef.current) {
        if (node.parent) node.parent.remove(node);
        disposeObject3D(node);
      }
      arPrismNodesRef.current = [];
    };

    const clearAllEntries = () => {
      for (const entry of entries.values()) {
        entry.cancelled = true;
        if (entry.sub?.parent) entry.sub.parent.remove(entry.sub);
        if (entry.sub) disposeObject3D(entry.sub);
      }
      entries.clear();
    };

    if ((mode !== 'draw' && mode !== 'preview') || !location) {
      clearAllPrisms();
      clearAllEntries();
      setVisibleOtherItemsCount((prev) => (prev === 0 ? prev : 0));
      while (group.children.length > 0) {
        const stray = group.children[0];
        group.remove(stray);
        disposeObject3D(stray);
      }
      return undefined;
    }

    // Always refresh lightweight land prism wireframes cheaply for the latest GPS position
    clearAllPrisms();

    const viewerElev =
      location.altitude !== null && location.altitude !== undefined && Number.isFinite(location.altitude)
        ? location.altitude
        : null;

    const cleanFocusedLandId = String(focusedLandId || '').trim();
    const landsToRender = cleanFocusedLandId
      ? renderedCameraLands.filter((land) => land?.parcelId === cleanFocusedLandId)
      : renderedCameraLands;
    const landByParcelId = new Map();
    for (const land of landsToRender) {
      if (land?.parcelId) landByParcelId.set(land.parcelId, land);
    }

    const focusedSnapshotIds = new Set(
      cleanFocusedLandId && selectedLandSnapshot?.parcel?.parcelId === cleanFocusedLandId
        ? (selectedLandSnapshot.sculptures || []).map((s) => s?.id).filter(Boolean)
        : []
    );
    const sculpturesPool = (() => {
      if (!cleanFocusedLandId) return nearbySculptures;
      const byId = new Map();
      if (selectedLandSnapshot?.parcel?.parcelId === cleanFocusedLandId) {
        for (const sc of selectedLandSnapshot.sculptures || []) {
          if (sc?.id) byId.set(sc.id, sc);
        }
      }
      for (const sc of nearbySculptures || []) {
        if (!sc?.id) continue;
        if (sc.parcelId === cleanFocusedLandId || focusedSnapshotIds.has(sc.id)) {
          byId.set(sc.id, { ...(byId.get(sc.id) || {}), ...sc });
        }
      }
      return Array.from(byId.values());
    })();

    const parcelRenderedBoxes = new Map();
    const nextSculptureIds = new Set();
    let selectedCustomPending = 0;
    const cleanEditingId = String(editingSculptureId || '').trim();
    const activeFadeMultiplier = mode === 'draw' && fadeOtherItems ? 0.22 : 1;
    const hazeTintHex = Number.isFinite(Number(atmosphericTintRef?.current))
      ? Number(atmosphericTintRef.current)
      : DEFAULT_ATMOSPHERIC_HAZE_HEX;

    for (const sc of sculpturesPool) {
      if (!sc?.id) continue;
      const scId = String(sc.id);
      if (cleanEditingId && scId === cleanEditingId) continue;

      const parentLand = sc?.parcelId ? landByParcelId.get(sc.parcelId) || null : null;
      const isOnSelectedLand = Boolean(arSelectedLandId && sc?.parcelId === arSelectedLandId);
      const offset = latLngOffsetMeters(location.lat, location.lng, sc.lat, sc.lng);
      const ax = Number(sc.anchorOffset?.dx || 0);
      const az = Number(sc.anchorOffset?.dz || 0);
      const parentRotDeg = Number(parentLand?.volume?.rotationDeg || 0);
      const worldOff = parcelLocalMetersToWorldMeters(ax, az, parentRotDeg);
      const worldX = offset.east + worldOff.east;
      const worldZ = -offset.north + worldOff.south;
      const dist = Math.hypot(worldX, worldZ);

      // Strict < 300 ft (91.44 m) AR camera visibility cutoff: never render distant sculptures
      if (!isWithinArCameraVisibilityRange(dist)) {
        continue;
      }

      nextSculptureIds.add(scId);
      const sharpness = computeProximitySharpness(dist, { hazeTintHex });
      const isCustom3d = Boolean(sc.modelType === 'custom-3d' && sc.customModel?.format);
      const useCoarseLod =
        !isCustom3d &&
        !isOnSelectedLand &&
        Array.isArray(sc.voxels) &&
        sc.voxels.length > 350 &&
        sharpness.simplifyVoxelLod;

      const scRot = extractSculptureRotation(sc);
      const scScale = extractSculptureScale(sc);
      const cm = sc.customModel || {};
      const voxels = Array.isArray(sc.voxels) ? sc.voxels : [];
      const sig = [
        scId,
        sc.currentRev || 1,
        isCustom3d ? 'custom-3d' : 'voxel',
        cm.format || '',
        cm.downloadUrl || cm.proxyUrl || sc.modelGlbUrl || '',
        cm.ipfsCid || '',
        scScale,
        cm.rotationY ?? 0,
        scRot.pitch,
        scRot.roll,
        voxels.length,
        voxels[0]?.color || '',
        useCoarseLod ? 'coarse' : 'full',
        mode === 'draw' ? 'draw' : 'preview'
      ].join('|');

      let entry = entries.get(scId);
      if (entry && entry.sig !== sig) {
        entry.cancelled = true;
        if (entry.sub?.parent) entry.sub.parent.remove(entry.sub);
        if (entry.sub) disposeObject3D(entry.sub);
        entries.delete(scId);
        entry = null;
      }

      if (!entry) {
        const sub = new THREE.Group();
        const pitchRad = tiltToRadians(scRot.pitch);
        const rollRad = tiltToRadians(scRot.roll);

        if (!isCustom3d) {
          const voxelMeshGroup = buildVoxelGroup(voxels, { simplifyLod: useCoarseLod });
          // Horizontally center voxel clouds on their own anchor (matching 3D Map, GeoJSON, and 3D Viewer)
          // so legacy off-origin AR sculptures ALWAYS render dead-center inside their land volume!
          const rawVoxelBounds = new THREE.Box3().setFromObject(voxelMeshGroup);
          if (!rawVoxelBounds.isEmpty()) {
            const rawCenter = new THREE.Vector3();
            const rawSize = new THREE.Vector3();
            rawVoxelBounds.getCenter(rawCenter);
            rawVoxelBounds.getSize(rawSize);
            if (pitchRad !== 0 || rollRad !== 0) {
              const tiltWrap = new THREE.Group();
              tiltWrap.rotation.order = 'YXZ';
              voxelMeshGroup.position.set(-rawCenter.x, -rawCenter.y, -rawCenter.z);
              tiltWrap.add(voxelMeshGroup);
              tiltWrap.rotation.set(pitchRad, 0, rollRad);
              const rotDims = computeRotatedBoxDimensions({
                width: rawSize.x,
                height: rawSize.y,
                depth: rawSize.z,
                yaw: 0,
                pitch: scRot.pitch,
                roll: scRot.roll,
                scale: 1
              });
              tiltWrap.position.y = rawVoxelBounds.min.y + rotDims.effH / 2;
              sub.add(tiltWrap);
            } else {
              voxelMeshGroup.position.set(-rawCenter.x, 0, -rawCenter.z);
              sub.add(voxelMeshGroup);
            }
          } else {
            sub.add(voxelMeshGroup);
          }
        }

        const bounds = new THREE.Box3().setFromObject(sub);
        const boxCenter = new THREE.Vector3();
        const boxSize = new THREE.Vector3();
        if (!bounds.isEmpty()) {
          bounds.getCenter(boxCenter);
          bounds.getSize(boxSize);
        } else {
          boxCenter.set(0, 0.75, 0);
          boxSize.set(1.4, 1.5, 1.4);
        }
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
        hitProxy.userData.isHitProxy = true;
        if (parentLand) hitProxy.userData.parcel = parentLand;
        sub.add(hitProxy);

        const baseY = isCustom3d ? -0.02 : (sc.elevation?.sculptureVerticalMinM ?? 0) - 0.12;
        const catcher = new THREE.Mesh(
          new THREE.CircleGeometry(1.6, 24),
          new THREE.ShadowMaterial({ opacity: 0.36 })
        );
        catcher.rotation.x = -Math.PI / 2;
        catcher.position.y = baseY;
        catcher.receiveShadow = sharpness.enableShadows;
        sub.add(catcher);

        const baseGlowRingMat = new THREE.MeshBasicMaterial({
          color: 0x00f5d4,
          transparent: true,
          opacity: mode === 'draw' ? 0.42 : 0.65,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        });
        const baseGlowRing = new THREE.Mesh(
          new THREE.RingGeometry(0.95, 1.32, 48),
          baseGlowRingMat
        );
        baseGlowRing.rotation.x = -Math.PI / 2;
        baseGlowRing.position.y = baseY + 0.018;
        baseGlowRing.userData = { sculpture: sc, parcel: parentLand, clickableBase: true };
        sub.add(baseGlowRing);

        const baseHaloMat = new THREE.MeshBasicMaterial({
          color: 0x00f5d4,
          transparent: true,
          opacity: mode === 'draw' ? 0.12 : 0.18,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        });
        const baseGlowHalo = new THREE.Mesh(
          new THREE.CircleGeometry(1.12, 36),
          baseHaloMat
        );
        baseGlowHalo.rotation.x = -Math.PI / 2;
        baseGlowHalo.position.y = baseY + 0.01;
        baseGlowHalo.userData = { sculpture: sc, parcel: parentLand, clickableBase: true };
        sub.add(baseGlowHalo);

        if (!isCustom3d && scScale !== 1) {
          sub.scale.setScalar(scScale);
        }

        sub.userData = {
          sculptureId: scId,
          parcelId: sc.parcelId || '',
          sculpture: sc,
          parcel: parentLand,
          distanceMeters: dist,
          _lastSharpness: -1,
          _lastFadeMul: -1,
          _lastHazeHex: -1,
          baseRingMat: baseGlowRingMat,
          baseHaloMat,
          baseGlowRing
        };

        entry = {
          id: scId,
          sig,
          isCustom3d,
          sub,
          hitProxy,
          loaded: !isCustom3d,
          cancelled: false
        };
        entries.set(scId, entry);

        if (isCustom3d) {
          const capturedEntry = entry;
          loadCustomModelObject(sc, resolveApiUrl)
            .then((loaded) => {
              if (capturedEntry.cancelled || !loaded) {
                if (loaded?.object3d) disposeObject3D(loaded.object3d);
                return;
              }
              const latestParcel = capturedEntry.sub.userData?.parcel || parentLand;
              const latestSc = capturedEntry.sub.userData?.sculpture || sc;
              loaded.object3d.traverse((obj) => {
                if (obj.isMesh || obj.isPoints || obj.isLine) {
                  obj.userData.sculpture = latestSc;
                  if (latestParcel) obj.userData.parcel = latestParcel;
                }
              });
              const loadedCenter = new THREE.Vector3();
              const loadedSize = new THREE.Vector3();
              loaded.bounds.getCenter(loadedCenter);
              loaded.bounds.getSize(loadedSize);
              if (pitchRad !== 0 || rollRad !== 0) {
                const tiltWrap = new THREE.Group();
                tiltWrap.rotation.order = 'YXZ';
                loaded.object3d.position.set(-loadedCenter.x, -loadedCenter.y, -loadedCenter.z);
                tiltWrap.add(loaded.object3d);
                tiltWrap.rotation.set(pitchRad, 0, rollRad);
                const rotDims = computeRotatedBoxDimensions({
                  width: loadedSize.x,
                  height: loadedSize.y,
                  depth: loadedSize.z,
                  yaw: 0,
                  pitch: scRot.pitch,
                  roll: scRot.roll,
                  scale: 1
                });
                tiltWrap.position.y = loaded.bounds.min.y + rotDims.effH / 2;
                capturedEntry.sub.add(tiltWrap);
                capturedEntry.hitProxy.geometry.dispose();
                capturedEntry.hitProxy.geometry = new THREE.BoxGeometry(
                  Math.max(1.0, rotDims.effW + 0.55),
                  Math.max(1.0, rotDims.effH + 0.55),
                  Math.max(1.0, rotDims.effD + 0.55)
                );
                capturedEntry.hitProxy.position.set(0, loaded.bounds.min.y + rotDims.effH / 2, 0);
              } else {
                capturedEntry.sub.add(loaded.object3d);
                capturedEntry.hitProxy.geometry.dispose();
                capturedEntry.hitProxy.geometry = new THREE.BoxGeometry(
                  Math.max(1.0, loadedSize.x + 0.55),
                  Math.max(1.0, loadedSize.y + 0.55),
                  Math.max(1.0, loadedSize.z + 0.55)
                );
                capturedEntry.hitProxy.position.copy(loadedCenter);
              }
              capturedEntry.loaded = true;
              const latestDist = capturedEntry.sub.userData?.distanceMeters ?? dist;
              const latestFade = Number.isFinite(Number(capturedEntry.sub.userData?._lastFadeMul))
                ? Number(capturedEntry.sub.userData._lastFadeMul)
                : activeFadeMultiplier;
              const latestHaze = Number.isFinite(Number(atmosphericTintRef?.current))
                ? Number(atmosphericTintRef.current)
                : DEFAULT_ATMOSPHERIC_HAZE_HEX;
              applyProximitySharpnessToObject3D(
                capturedEntry.sub,
                computeProximitySharpness(latestDist, { hazeTintHex: latestHaze }),
                8,
                { fadeMultiplier: latestFade, hazeTintHex: latestHaze }
              );
              setArModelLoadedTick((n) => n + 1);
            })
            .catch(() => {
              if (!capturedEntry.cancelled) {
                capturedEntry.loaded = true;
                setArModelLoadedTick((n) => n + 1);
              }
            });
        }
      }

      const sub = entry.sub;
      if (isCustom3d && !entry.loaded && isOnSelectedLand) {
        selectedCustomPending += 1;
      }

      // Keep metadata, orientation, and GPS-relative world position synced in place (zero mesh teardown!)
      sub.userData.sculpture = sc;
      sub.userData.parcel = parentLand;
      sub.userData.parcelId = sc.parcelId || '';
      sub.userData.distanceMeters = dist;
      sub.traverse((obj) => {
        if (obj.isMesh || obj.isPoints || obj.isLine) {
          obj.userData.sculpture = sc;
          if (parentLand) obj.userData.parcel = parentLand;
        }
      });

      const worldYawRad = parcelLocalYawToWorldYawRad(sc.anchorOffset?.yaw || 0, parentRotDeg);
      sub.rotation.y = Number.isFinite(worldYawRad) ? worldYawRad : 0;

      const verticalY = computeArSculptureVerticalY({
        sculpture: sc,
        viewerAltitude: viewerElev,
        parentLand,
        groundY: -1.15
      });

      // Exact true 1:1 world-meter perspective (no artificial clamping within the < 300 ft cutoff)
      sub.position.set(worldX, verticalY, worldZ);

      if (
        Math.abs(sharpness.sharpness - (sub.userData._lastSharpness ?? -1)) >= 0.02 ||
        Math.abs(activeFadeMultiplier - (sub.userData._lastFadeMul ?? -1)) >= 0.02 ||
        sub.userData._lastHazeHex !== hazeTintHex
      ) {
        sub.userData._lastSharpness = sharpness.sharpness;
        sub.userData._lastFadeMul = activeFadeMultiplier;
        sub.userData._lastHazeHex = hazeTintHex;
        applyProximitySharpnessToObject3D(sub, sharpness, 8, {
          fadeMultiplier: activeFadeMultiplier,
          hazeTintHex
        });
      }

      if (sub.parent !== group) {
        group.add(sub);
      }

      // Record rendered local 3D bounds per parcel (artwork meshes only, excluding shadow/halo rings)
      // so AR land prisms always wrap symmetrically around the actual rendered sculpture in X, Y, and Z.
      if (sc.parcelId) {
        sub.updateMatrixWorld(true);
        const scBox = new THREE.Box3();
        sub.traverse((obj) => {
          if (
            obj.isMesh &&
            !obj.userData?.clickableBase &&
            !obj.userData?.isHitProxy &&
            !(obj.material && obj.material.isShadowMaterial)
          ) {
            scBox.expandByObject(obj);
          }
        });
        if (!scBox.isEmpty()) {
          const prevBox = parcelRenderedBoxes.get(sc.parcelId);
          if (prevBox) {
            prevBox.minX = Math.min(prevBox.minX, scBox.min.x);
            prevBox.maxX = Math.max(prevBox.maxX, scBox.max.x);
            prevBox.minY = Math.min(prevBox.minY, scBox.min.y);
            prevBox.maxY = Math.max(prevBox.maxY, scBox.max.y);
            prevBox.minZ = Math.min(prevBox.minZ, scBox.min.z);
            prevBox.maxZ = Math.max(prevBox.maxZ, scBox.max.z);
          } else {
            parcelRenderedBoxes.set(sc.parcelId, {
              minX: scBox.min.x,
              maxX: scBox.max.x,
              minY: scBox.min.y,
              maxY: scBox.max.y,
              minZ: scBox.min.z,
              maxZ: scBox.max.z
            });
          }
        }
      }
    }

    // Dispose any cached sculptures that left the active nearby/focused pool
    for (const [cachedId, cachedEntry] of entries.entries()) {
      if (!nextSculptureIds.has(cachedId)) {
        cachedEntry.cancelled = true;
        if (cachedEntry.sub?.parent) cachedEntry.sub.parent.remove(cachedEntry.sub);
        if (cachedEntry.sub) disposeObject3D(cachedEntry.sub);
        entries.delete(cachedId);
      }
    }

    const nextVisibleItemCount = nextSculptureIds.size;
    setVisibleOtherItemsCount((prev) => (prev === nextVisibleItemCount ? prev : nextVisibleItemCount));

    if (
      arSelectedLandId &&
      selectedCustomPending === 0 &&
      selectedLandApiDoneRef.current.parcelId === arSelectedLandId &&
      selectedLandApiDoneRef.current.done
    ) {
      setSelectedLandLoadState((prev) =>
        prev.parcelId === arSelectedLandId && prev.status !== 'ready'
          ? { ...prev, status: 'ready' }
          : prev
      );
    }

    // Render interactive 3D Holographic Virtual Land Volume Prisms strictly < 300 ft in exact 1:1 perspective
    const nextPrisms = [];
    for (const land of landsToRender) {
      const landDistMeters = land.edgeDistanceMetersExact ?? land.edgeDistanceMeters ?? land.distanceMeters ?? 0;
      if (!isWithinArCameraVisibilityRange(landDistMeters)) {
        continue;
      }
      const prism = computeArLandPrismLocalGeometry({
        location,
        volume: land.volume,
        baseY: -1.15,
        enclosingLocalBox: parcelRenderedBoxes.get(land.parcelId) || null,
        paddingFraction: 0.1
      });
      if (!prism) continue;

      const isSelected = Boolean(arSelectedLandId && arSelectedLandId === land.parcelId);
      const isDormant = String(land.stewardStatus || '').toLowerCase() === 'dormant';
      const baseHex = isSelected || land.isInside
        ? 0xff00aa
        : land.isFrozen
        ? 0x7dd3fc
        : isDormant
        ? 0xff4da6
        : 0xff1f8f;

      const landSharpness = computeProximitySharpness(landDistMeters, { hazeTintHex });
      const atmosphericHex = blendHexWithAtmosphericHaze(
        baseHex,
        landSharpness.atmosphericHaze * 0.72,
        hazeTintHex
      );

      const landGroup = new THREE.Group();
      const bPts = prism.bottomCorners.map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const tPts = prism.topCorners.map((p) => new THREE.Vector3(p.x, p.y, p.z));

      // 1) Depth-faded + atmospherically tinted 3D boundary wireframe (sharpens as user approaches)
      const wireSegments = createDepthFadedThreePrismWireframe(bPts, tPts, atmosphericHex, {
        nearOpacity: 0.98,
        farOpacity: 0.38,
        opacityScale: (isSelected ? 0.98 : land.isInside ? 0.88 : 0.68) * landSharpness.prismOpacityScale
      });
      wireSegments.userData = {
        ...wireSegments.userData,
        parcel: land,
        isArLandHit: true
      };
      landGroup.add(wireSegments);

      // 3) Subtle translucent holographic ground pad + 4 interactive glass boundary walls
      const wallPositions = [];
      // Floor quad (2 triangles)
      wallPositions.push(
        bPts[0].x, bPts[0].y + 0.01, bPts[0].z,
        bPts[1].x, bPts[1].y + 0.01, bPts[1].z,
        bPts[2].x, bPts[2].y + 0.01, bPts[2].z,
        bPts[0].x, bPts[0].y + 0.01, bPts[0].z,
        bPts[2].x, bPts[2].y + 0.01, bPts[2].z,
        bPts[3].x, bPts[3].y + 0.01, bPts[3].z
      );
      // 4 side walls
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        const a = bPts[i];
        const b = bPts[next];
        const c = tPts[next];
        const d = tPts[i];
        wallPositions.push(
          a.x, a.y, a.z,
          b.x, b.y, b.z,
          c.x, c.y, c.z,
          a.x, a.y, a.z,
          c.x, c.y, c.z,
          d.x, d.y, d.z
        );
      }
      const wallGeo = new THREE.BufferGeometry();
      wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
      wallGeo.computeVertexNormals();
      const wallMat = new THREE.MeshBasicMaterial({
        color: atmosphericHex,
        transparent: true,
        opacity: (isSelected ? 0.16 : land.isInside ? 0.08 : 0.055) * landSharpness.prismOpacityScale,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const wallMesh = new THREE.Mesh(wallGeo, wallMat);
      wallMesh.userData = { parcel: land, isArLandHit: true };
      landGroup.add(wallMesh);

      const scBoxForAim = parcelRenderedBoxes.get(land.parcelId) || null;
      const aimX = scBoxForAim
        ? (scBoxForAim.minX + scBoxForAim.maxX) * 0.5
        : prism.centerLocal.x;
      const aimY = scBoxForAim
        ? (scBoxForAim.minY + scBoxForAim.maxY) * 0.5
        : Math.min(prism.topY - 0.3, Math.max(prism.baseY + 0.85, 0.55));
      const aimZ = scBoxForAim
        ? (scBoxForAim.minZ + scBoxForAim.maxZ) * 0.5
        : prism.centerLocal.z;

      landGroup.userData = {
        isParcelPerimeter: true,
        insideParcel: land.isInside,
        parcelId: land.parcelId,
        displayName: land.displayName || 'Nearby Land',
        distanceMeters: landDistMeters,
        baseHex,
        centerLocal: new THREE.Vector3(aimX, aimY, aimZ),
        cornersLocal: [...bPts, ...tPts],
        parcel: land,
        wireMat: wireSegments.material,
        wallMat
      };
      group.add(landGroup);
      nextPrisms.push(landGroup);
    }
    arPrismNodesRef.current = nextPrisms;

    return undefined;
  }, [
    mode,
    location,
    nearbySculptures,
    renderedCameraLands,
    arSelectedLandId,
    focusedLandId,
    selectedLandSnapshot,
    nearbyGroupRef,
    arModelLoadedTick,
    editingSculptureId,
    fadeOtherItems,
    atmosphericTintRef
  ]);

  // Live off-thread ORB visual landmark relocalization loop (runs inside orbWorker.js
  // during preview AND land visits to lock visual yaw within ~1-2° without UI frame lag).
  useEffect(() => {
    const shouldRelocalize = Boolean(
      (mode === 'preview' || isArViewOnly || arSelectedLandId || focusedLandId) &&
        location &&
        cameraReady
    );
    if (!shouldRelocalize) {
      return undefined;
    }
    let cancelled = false;
    let busy = false;

    async function tickOrbMatch() {
      if (cancelled || busy || !videoRef.current || videoRef.current.readyState < 2) return;
      const loc = locationRef.current;
      if (!loc) return;
      const activeParcelId =
        arSelectedLandId ||
        focusedLandId ||
        arTargetedSculpture?.sculpture?.parcelId ||
        nearbySculptures.find((sc) => haversineMeters(loc.lat, loc.lng, sc.lat, sc.lng) <= 65)?.parcelId ||
        '';
      if (!activeParcelId) return;

      busy = true;
      try {
        let rawEntry = orbPackCacheRef.current.get(activeParcelId);
        if (rawEntry === undefined) {
          const fetched = await api
            .fetchParcelLandmarkPack(activeParcelId, {
              lat: loc.lat,
              lng: loc.lng,
              deviceProfile: { isMobile: true }
            })
            .catch(() => null);
          rawEntry = fetched
            ? {
                available: Boolean(fetched.available && fetched.anchorPack),
                anchorPack: fetched.available ? fetched.anchorPack : null,
                effectivePolicy: fetched.effectivePolicy || null,
                orbStatus: fetched.orbStatus || (fetched.available ? 'optional' : 'no_pack'),
                upgradePath: fetched.upgradePath || (fetched.available ? '' : 'first_mobile_scan'),
                lightingSlots: Array.isArray(fetched.lightingSlots) ? fetched.lightingSlots : [],
                desiredLightingSlot: fetched.desiredLightingSlot || '',
                missingLightingSlots: Array.isArray(fetched.missingLightingSlots)
                  ? fetched.missingLightingSlots
                  : []
              }
            : null;
          orbPackCacheRef.current.set(activeParcelId, rawEntry);
        }
        if (cancelled) return;

        const entry = unwrapOrbPackCacheEntry(rawEntry);
        setOrbStatus((prev) => {
          const nextPackStatus = entry.orbStatus || (entry.available ? 'optional' : 'no_pack');
          const nextEnvTier = entry.effectivePolicy?.envTier || prev.envTier || '';
          const nextMaxErr = entry.effectivePolicy?.maxReprojErrPx ?? prev.effectiveMaxReprojErrPx ?? null;
          const nextMinInliers = entry.effectivePolicy?.minOrbInliers ?? prev.effectiveMinInliers ?? null;
          if (
            prev.packStatus === nextPackStatus &&
            prev.envTier === nextEnvTier &&
            prev.effectiveMaxReprojErrPx === nextMaxErr &&
            prev.effectiveMinInliers === nextMinInliers
          ) {
            return prev;
          }
          return {
            ...prev,
            packStatus: nextPackStatus,
            envTier: nextEnvTier,
            isAuto: entry.effectivePolicy?.isAuto ?? prev.isAuto ?? true,
            lightingSlots: entry.lightingSlots,
            effectiveMinInliers: nextMinInliers,
            effectiveMaxReprojErrPx: nextMaxErr
          };
        });

        // Automatic background calibration for packless Browser/Agent lands OR missing complementary lighting slot
        const targetCalSlot =
          !entry.available
            ? entry.desiredLightingSlot || 'daylight'
            : entry.missingLightingSlots[0] || '';
        const attemptKey = targetCalSlot ? `${activeParcelId}:${targetCalSlot}` : '';
        if (
          user?.id &&
          targetCalSlot &&
          attemptKey &&
          !autoCalAttemptedRef.current.has(attemptKey)
        ) {
          let buf = autoCalBuffersRef.current.get(attemptKey);
          if (!buf) {
            buf = new Map();
            autoCalBuffersRef.current.set(attemptKey, buf);
          }
          // Seed from live scene-scan keyframes if already captured in matching slot
          if (orbKeyframesRef.current?.size > 0 && buf.size < 3) {
            for (const [k, kf] of orbKeyframesRef.current.entries()) {
              if (!buf.has(k) && (!entry.available || kf?.lightingTag === targetCalSlot)) {
                buf.set(k, kf);
              }
            }
          }
          if (buf.size < 3) {
            const headingDeg = Number(orientationFusionRef?.current?.getHeadingDeg?.() ?? 0);
            const yawNorm = (((headingDeg + 180) % 360) + 360) % 360 - 180;
            const slotBucket =
              !buf.has('center') && Math.abs(yawNorm) <= 18
                ? 'center'
                : !buf.has('left') && yawNorm < -18
                  ? 'left'
                  : !buf.has('right') && yawNorm > 18
                    ? 'right'
                    : `view-${buf.size}`;
            const kf = await orbTrackerRef.current
              ?.extractKeyframeFeatures(videoRef.current, {
                yawDeg: yawNorm,
                pitchDeg: 0,
                solarRegime: entry.effectivePolicy?.solarRegime || ''
              })
              .catch(() => null);
            if (!cancelled && kf?.features?.length >= 6) {
              if (!entry.available || kf.lightingTag === targetCalSlot) {
                buf.set(slotBucket, kf);
              }
            }
          }

          const candidateKfs = Array.from(buf.values()).slice(0, 3);
          const gate = meetsClientInitialCalibrationGate(candidateKfs);
          if (gate.ok && !cancelled) {
            autoCalAttemptedRef.current.add(attemptKey);
            api
              .saveParcelLandmarkPack(activeParcelId, {
                lat: loc.lat,
                lng: loc.lng,
                keyframes: candidateKfs,
                allowInitialClaim: true,
                deviceProfile: { isMobile: true }
              })
              .then((saved) => {
                if (saved?.ok && !cancelled) {
                  autoCalBuffersRef.current.delete(attemptKey);
                  orbPackCacheRef.current.delete(activeParcelId);
                  setOrbStatus((prev) => ({
                    ...prev,
                    packStatus: 'optional',
                    lightingSlots: saved.lightingSlots || prev.lightingSlots || []
                  }));
                }
              })
              .catch(() => {
                // Non-blocking: server may reject if another visitor already calibrated this slot
              });
          }
        }

        if (!entry.anchorPack || cancelled) return;

        const effectiveMaxErr = Number(
          entry.effectivePolicy?.maxReprojErrPx || ORB_DEFAULT_MAX_REPROJ_ERR_PX
        );
        const match = await orbTrackerRef.current?.matchLiveFrame(
          videoRef.current,
          entry.anchorPack,
          { maxReprojErr: effectiveMaxErr }
        );
        if (!match || cancelled) return;
        if (match.inlierCount >= 4) {
          latestOrbProofRef.current = {
            descriptorDigest: match.descriptorDigest,
            inlierCount: match.inlierCount,
            reprojectionErrorPx: match.reprojectionErrorPx,
            poseCorrectionYawRad: match.poseCorrectionYawRad || 0,
            matchedDescriptors: Array.isArray(match.matchedDescriptors)
              ? match.matchedDescriptors
              : []
          };
          if (Number.isFinite(match.poseCorrectionYawRad) && Math.abs(match.poseCorrectionYawRad) <= 0.65) {
            orbHeadingCorrectionRadRef.current =
              orbHeadingCorrectionRadRef.current * 0.72 + match.poseCorrectionYawRad * 0.28;
            if (orientationFusionRef?.current) {
              orientationFusionRef.current.setOrbYawCorrectionRad(orbHeadingCorrectionRadRef.current);
            } else if (nearbyGroupRef.current) {
              nearbyGroupRef.current.rotation.y = orbHeadingCorrectionRadRef.current;
            }
          }
        }
        setOrbStatus((prev) => ({
          ...prev,
          relocalizedInliers: match.inlierCount || 0,
          reprojErrPx: match.inlierCount > 0 ? match.reprojectionErrorPx : null,
          matchedLightingSlot: match.matchedLightingSlot || prev.matchedLightingSlot || ''
        }));
      } catch {
        // non-blocking relocalization tick
      } finally {
        busy = false;
      }
    }

    const timer = setInterval(tickOrbMatch, isArViewOnly || arSelectedLandId ? 750 : 480);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    arSelectedLandId,
    arTargetedSculpture?.sculpture,
    cameraReady,
    focusedLandId,
    isArViewOnly,
    latestOrbProofRef,
    location,
    locationRef,
    mode,
    nearbyGroupRef,
    nearbySculptures,
    orbKeyframesRef,
    orbPackCacheRef,
    orbTrackerRef,
    orientationFusionRef,
    setOrbStatus,
    user?.id,
    videoRef
  ]);

  const handleRefreshOrbRescan = useCallback(async () => {
    const targetParcelId =
      arSelectedLandId || arTargetedSculpture?.sculpture?.parcelId || nearbySculptures[0]?.parcelId;
    if (targetParcelId) {
      orbPackCacheRef.current.delete(targetParcelId);
      for (const k of Array.from(autoCalAttemptedRef.current)) {
        if (k.startsWith(`${targetParcelId}:`)) autoCalAttemptedRef.current.delete(k);
      }
      for (const k of Array.from(autoCalBuffersRef.current.keys())) {
        if (k.startsWith(`${targetParcelId}:`)) autoCalBuffersRef.current.delete(k);
      }
    }
    orbKeyframesRef.current.clear();
    orbHeadingCorrectionRadRef.current = 0;
    if (orientationFusionRef?.current) {
      orientationFusionRef.current.setOrbYawCorrectionRad(0);
    }
    if (nearbyGroupRef.current) nearbyGroupRef.current.rotation.y = 0;
    if (videoRef.current?.readyState >= 2) {
      const kf = await orbTrackerRef.current?.extractKeyframeFeatures(videoRef.current, {
        yawDeg: 0,
        pitchDeg: 0
      });
      if (kf?.features?.length) {
        orbKeyframesRef.current.set('center', kf);
        setOrbStatus((prev) => ({
          ...prev,
          keyframes: 1,
          features: kf.features.length
        }));
      }
    }
    showTemporaryHint('ORB landmark scan refreshed — pan slowly across nearby buildings.');
  }, [
    arSelectedLandId,
    arTargetedSculpture?.sculpture,
    nearbyGroupRef,
    nearbySculptures,
    orbKeyframesRef,
    orbPackCacheRef,
    orbTrackerRef,
    orientationFusionRef,
    setOrbStatus,
    showTemporaryHint,
    videoRef
  ]);

  const loadPublicMapData = useCallback(async () => {
    setMapLoading(true);
    try {
      const [sRes, pRes] = await Promise.all([
        api.listSculptures({ includeVoxels: false }),
        api.listParcels()
      ]);
      setMapSculptures(sRes.sculptures || []);
      setMapParcels(pRes.parcels || []);
      setNearbyParcels(pRes.parcels || []);
    } catch {
      // keep existing items
    } finally {
      setMapLoading(false);
    }
  }, []);

  const openAreaMap = useCallback(
    (opts = {}) => {
      const initialMode = opts?.initialDimensionMode === '2d' ? '2d' : '3d';
      const targetParcelId = String(opts?.focusParcelId || '').trim();
      stopBrushPainting();
      if (modeRef.current === 'transform') {
        commitTransformAndExit('draw');
      }
      setMapInitialDimensionMode(initialMode);
      if (targetParcelId) {
        setMapSelectedParcelId(targetParcelId);
        setMapFocusParcelTick((n) => n + 1);
      }
      setAreaFilterMode('nearby');
      setMapOpen(true);
      loadPublicMapData();
    },
    [commitTransformAndExit, loadPublicMapData, modeRef, stopBrushPainting]
  );

  const focusMapParcel = useCallback((parcelId) => {
    const pid = String(parcelId || '');
    setMapSelectedParcelId(pid);
    if (pid) {
      setMapFocusParcelTick((n) => n + 1);
    }
  }, []);

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

  const landGroups = useMemo(
    () =>
      groupNearestLandsWithSculptures({
        parcels: mapParcels,
        sculptures: mapSculptures,
        location,
        filterMode: areaFilterMode,
        radiusMeters: 5000
      }),
    [mapParcels, mapSculptures, location, areaFilterMode]
  );

  const displayedMapSculptures = useMemo(() => {
    if (areaFilterMode !== 'nearby' || !location) return areaSculpturesSorted;
    const within = areaSculpturesSorted.filter(
      (s) => s.distanceMeters === null || s.distanceMeters <= 5000
    );
    return within.length > 0 ? within : landGroups.displayedSculptures;
  }, [areaFilterMode, areaSculpturesSorted, location, landGroups.displayedSculptures]);

  return {
    nearbySculptures,
    setNearbySculptures,
    nearbyParcels,
    setNearbyParcels,
    hydratedSculptureMapRef,
    hydrateNearbyList,
    visibleCameraLands: renderedCameraLands,
    visibleOtherItemsCount,
    immediateCameraLands: cameraLands.immediateLands,
    primaryCameraLand: cameraLands.primaryLand,
    arSelectedLandId,
    arSelectedLandIdRef,
    setArSelectedLandId,
    selectArLand,
    activeArLand,
    arLandGuidance,
    setArLandGuidance,
    selectedLandLoadState,
    arTargetedSculpture,
    setArTargetedSculpture,
    arTargetedIdRef,
    mapOpen,
    setMapOpen,
    mapInitialDimensionMode,
    areaFilterMode,
    setAreaFilterMode,
    mapSculptures,
    setMapSculptures,
    mapParcels,
    setMapParcels,
    mapLoading,
    mapSelectedSculpture,
    setMapSelectedSculpture,
    mapSelectedParcelId,
    setMapSelectedParcelId,
    mapFocusParcelTick,
    focusMapParcel,
    loadPublicMapData,
    openAreaMap,
    areaSculpturesSorted,
    displayedMapSculptures,
    allLandsSorted: landGroups.allLands,
    nearbyLandsSorted: landGroups.nearbyLands,
    displayedMapLands: landGroups.displayedLands,
    landsAutoFallback: landGroups.autoFallbackToAll,
    handleRefreshOrbRescan
  };
}
