import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { api, resolveApiUrl } from '../utils/api.js';
import {
  computeArLandPrismLocalGeometry,
  findNearbyCameraLands
} from '../utils/arLandHelpers.js';
import { extractSculptureScale, yawToRadians } from '../../../shared/sculpturePlacement.mjs';
import { loadCustomModelObject } from '../utils/customModelLoader.js';
import { createDepthFadedThreePrismWireframe } from '../utils/prismDepthFade.js';
import { groupNearestLandsWithSculptures } from '../utils/landMapHelpers.js';
import {
  buildVoxelGroup,
  disposeObject3D,
  latLngOffsetMeters
} from '../components/VoxelEngine3D.js';

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
  showTemporaryHint
}) {
  const hydratedSculptureMapRef = useRef(new Map());
  const arTargetedIdRef = useRef('');
  const arSelectedLandIdRef = useRef('');
  const orbHeadingCorrectionRadRef = useRef(0);

  const [nearbySculptures, setNearbySculptures] = useState([]);
  const [nearbyParcels, setNearbyParcels] = useState([]);
  const [arTargetedSculpture, setArTargetedSculpture] = useState(null);
  const [arSelectedLandId, setArSelectedLandIdState] = useState('');

  const [mapOpen, setMapOpen] = useState(false);
  const [mapInitialDimensionMode, setMapInitialDimensionMode] = useState('2d');
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
        return d <= 65 && !alreadyHydrated;
      })
      .slice(0, 8);

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

  // Merge nearbyParcels with mapParcels so live camera AR always sees fresh parcel metadata & volumes
  const mergedCameraParcels = useMemo(() => {
    const byId = new Map();
    for (const p of mapParcels || []) {
      if (p?.parcelId) byId.set(p.parcelId, p);
    }
    for (const p of nearbyParcels || []) {
      if (p?.parcelId) byId.set(p.parcelId, { ...(byId.get(p.parcelId) || {}), ...p });
    }
    return Array.from(byId.values());
  }, [mapParcels, nearbyParcels]);

  const cameraLands = useMemo(
    () =>
      findNearbyCameraLands({
        parcels: mergedCameraParcels,
        sculptures: nearbySculptures,
        location,
        user,
        ownedParcelIds,
        maxDistanceMeters: 120,
        nearThresholdMeters: 45
      }),
    [location, mergedCameraParcels, nearbySculptures, ownedParcelIds, user]
  );

  const activeArLand = useMemo(() => {
    if (!arSelectedLandId) return null;
    return (
      cameraLands.visibleLands.find((l) => l.parcelId === arSelectedLandId) ||
      null
    );
  }, [arSelectedLandId, cameraLands.visibleLands]);

  // Build nearby sculptures + glowing interactive 3D land volume prisms in BOTH draw and preview modes
  useEffect(() => {
    const group = nearbyGroupRef.current;
    if (!group) return undefined;
    disposeObject3D(group);
    while (group.children.length > 0) group.remove(group.children[0]);

    if ((mode !== 'draw' && mode !== 'preview') || !location) return undefined;

    const viewerElev =
      location.altitude !== null && location.altitude !== undefined && Number.isFinite(location.altitude)
        ? location.altitude
        : null;
    let cancelled = false;

    const landByParcelId = new Map();
    for (const land of cameraLands.visibleLands) {
      if (land?.parcelId) landByParcelId.set(land.parcelId, land);
    }
    const parcelRenderedBoxes = new Map();

    for (const sc of nearbySculptures) {
      const parentLand = sc?.parcelId ? landByParcelId.get(sc.parcelId) || null : null;
      const offset = latLngOffsetMeters(location.lat, location.lng, sc.lat, sc.lng);
      const dist = Math.hypot(offset.east, offset.north);
      const isCustom3d = sc.modelType === 'custom-3d' && sc.customModel?.format;
      const sub = new THREE.Group();
      if (!isCustom3d) {
        const voxelMeshGroup = buildVoxelGroup(sc.voxels || [], { simplifyLod: false });
        // Horizontally center voxel clouds on their own anchor (matching 3D Map, GeoJSON, and 3D Viewer)
        // so legacy off-origin AR sculptures ALWAYS render dead-center inside their land volume!
        const rawVoxelBounds = new THREE.Box3().setFromObject(voxelMeshGroup);
        if (!rawVoxelBounds.isEmpty()) {
          const rawCenter = new THREE.Vector3();
          rawVoxelBounds.getCenter(rawCenter);
          voxelMeshGroup.position.set(-rawCenter.x, 0, -rawCenter.z);
        }
        sub.add(voxelMeshGroup);
      }
      sub.traverse((obj) => {
        if (obj.isMesh) {
          obj.userData.sculpture = sc;
          if (parentLand) obj.userData.parcel = parentLand;
        }
      });

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

      if (isCustom3d) {
        loadCustomModelObject(sc, resolveApiUrl)
          .then((loaded) => {
            if (cancelled || !loaded) return;
            loaded.object3d.traverse((obj) => {
              if (obj.isMesh || obj.isPoints || obj.isLine) {
                obj.userData.sculpture = sc;
                if (parentLand) obj.userData.parcel = parentLand;
              }
            });
            sub.add(loaded.object3d);
            const loadedCenter = new THREE.Vector3();
            const loadedSize = new THREE.Vector3();
            loaded.bounds.getCenter(loadedCenter);
            loaded.bounds.getSize(loadedSize);
            hitProxy.geometry.dispose();
            hitProxy.geometry = new THREE.BoxGeometry(
              Math.max(1.0, loadedSize.x + 0.55),
              Math.max(1.0, loadedSize.y + 0.55),
              Math.max(1.0, loadedSize.z + 0.55)
            );
            hitProxy.position.copy(loadedCenter);
          })
          .catch(() => {});
      }

      const clampFactor = dist > 35 ? 35 / dist : 1;

      const scElev =
        sc.elevation?.anchorAltitudeMeters ??
        (sc.altitude !== null && sc.altitude !== undefined ? sc.altitude : null);
      let deltaY = 0;
      if (viewerElev !== null && scElev !== null) {
        deltaY = Math.max(-35, Math.min(65, scElev - viewerElev));
      } else if (sc.elevation?.heightAboveGroundMeters) {
        deltaY = Math.max(-10, Math.min(65, sc.elevation.heightAboveGroundMeters));
      }

      const baseY = (sc.elevation?.sculptureVerticalMinM ?? 0) - 0.12;
      const catcher = new THREE.Mesh(
        new THREE.CircleGeometry(1.6, 24),
        new THREE.ShadowMaterial({ opacity: 0.36 })
      );
      catcher.rotation.x = -Math.PI / 2;
      catcher.position.y = baseY;
      catcher.receiveShadow = dist <= 25;
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

      sub.userData = {
        sculptureId: sc.id,
        sculpture: sc,
        parcel: parentLand,
        baseRingMat: baseGlowRingMat,
        baseHaloMat,
        baseGlowRing
      };

      const ax = Number(sc.anchorOffset?.dx || 0);
      const ay = Number(sc.anchorOffset?.dy || 0);
      const az = Number(sc.anchorOffset?.dz || 0);
      const ayaw = yawToRadians(sc.anchorOffset?.yaw || 0);
      if (Number.isFinite(ayaw) && ayaw !== 0) {
        sub.rotation.y = ayaw;
      }
      if (sc.modelType !== 'custom-3d') {
        const scScale = extractSculptureScale(sc);
        if (scScale !== 1) {
          sub.scale.setScalar(scScale);
        }
      }
      sub.position.set(
        offset.east * clampFactor + ax,
        deltaY + ay,
        -offset.north * clampFactor + az
      );
      group.add(sub);

      // Record rendered local 3D bounds per parcel (artwork meshes only, excluding shadow/halo rings)
      // so AR land prisms always wrap symmetrically around the actual rendered sculpture voxels in X, Y, and Z.
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

    // Render interactive 3D Holographic Virtual Land Volume Prisms for every visible nearby land
    for (const land of cameraLands.visibleLands) {
      const prism = computeArLandPrismLocalGeometry({
        location,
        volume: land.volume,
        baseY: -1.15,
        maxClampDistM: 55,
        enclosingLocalBox: parcelRenderedBoxes.get(land.parcelId) || null,
        paddingFraction: 0.1
      });
      if (!prism) continue;

      const isSelected = Boolean(arSelectedLandId && arSelectedLandId === land.parcelId);
      const isDormant = String(land.stewardStatus || '').toLowerCase() === 'dormant';
      const baseHex = isSelected || land.isInside
        ? 0xffd166
        : land.isFrozen
        ? 0x7dd3fc
        : isDormant
        ? 0xff6b35
        : 0x00f5d4;

      const landGroup = new THREE.Group();
      const bPts = prism.bottomCorners.map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const tPts = prism.topCorners.map((p) => new THREE.Vector3(p.x, p.y, p.z));

      // 1) Depth-faded 3D boundary wireframe (lines closest to user stay crisp; far-side lines fade >=25%)
      const wireSegments = createDepthFadedThreePrismWireframe(bPts, tPts, baseHex, {
        nearOpacity: 0.98,
        farOpacity: 0.38,
        opacityScale: isSelected ? 0.96 : land.isInside ? 0.85 : 0.62
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
        color: baseHex,
        transparent: true,
        opacity: isSelected ? 0.16 : land.isInside ? 0.08 : 0.055,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const wallMesh = new THREE.Mesh(wallGeo, wallMat);
      wallMesh.userData = { parcel: land, isArLandHit: true };
      landGroup.add(wallMesh);

      landGroup.userData = {
        isParcelPerimeter: true,
        insideParcel: land.isInside,
        parcelId: land.parcelId,
        parcel: land,
        wireMat: wireSegments.material,
        wallMat
      };
      group.add(landGroup);
    }

    return () => {
      cancelled = true;
    };
  }, [mode, location, nearbySculptures, cameraLands.visibleLands, arSelectedLandId, nearbyGroupRef]);

  // Live ORB visual landmark relocalization loop in AR Preview
  useEffect(() => {
    if (mode !== 'preview' || !location || !cameraReady) return undefined;
    let cancelled = false;
    let busy = false;

    async function tickOrbMatch() {
      if (cancelled || busy || !videoRef.current || videoRef.current.readyState < 2) return;
      const loc = locationRef.current;
      if (!loc) return;
      const targetSc =
        arTargetedSculpture?.sculpture ||
        nearbySculptures.find((sc) => haversineMeters(loc.lat, loc.lng, sc.lat, sc.lng) <= 65);
      if (!targetSc?.parcelId) return;

      busy = true;
      try {
        let packEntry = orbPackCacheRef.current.get(targetSc.parcelId);
        if (packEntry === undefined) {
          const fetched = await api
            .fetchParcelLandmarkPack(targetSc.parcelId, {
              lat: loc.lat,
              lng: loc.lng,
              deviceProfile: { isMobile: true }
            })
            .catch(() => null);
          packEntry = fetched?.available ? fetched.anchorPack : null;
          orbPackCacheRef.current.set(targetSc.parcelId, packEntry);
        }
        if (!packEntry || cancelled) return;

        const match = await orbTrackerRef.current?.matchLiveFrame(videoRef.current, packEntry);
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
            if (nearbyGroupRef.current) {
              nearbyGroupRef.current.rotation.y = orbHeadingCorrectionRadRef.current;
            }
          }
        }
        setOrbStatus((prev) => ({
          ...prev,
          relocalizedInliers: match.inlierCount || 0,
          reprojErrPx: match.inlierCount > 0 ? match.reprojectionErrorPx : null
        }));
      } catch {
        // non-blocking relocalization tick
      } finally {
        busy = false;
      }
    }

    const timer = setInterval(tickOrbMatch, 480);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    arTargetedSculpture?.sculpture,
    cameraReady,
    latestOrbProofRef,
    location,
    locationRef,
    mode,
    nearbyGroupRef,
    nearbySculptures,
    orbPackCacheRef,
    orbTrackerRef,
    setOrbStatus,
    videoRef
  ]);

  const handleRefreshOrbRescan = useCallback(async () => {
    const targetSc = arTargetedSculpture?.sculpture || nearbySculptures[0];
    if (targetSc?.parcelId) {
      orbPackCacheRef.current.delete(targetSc.parcelId);
    }
    orbKeyframesRef.current.clear();
    orbHeadingCorrectionRadRef.current = 0;
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
    arTargetedSculpture?.sculpture,
    nearbyGroupRef,
    nearbySculptures,
    orbKeyframesRef,
    orbPackCacheRef,
    orbTrackerRef,
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
      const initialMode = opts?.initialDimensionMode === '3d' ? '3d' : '2d';
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
    visibleCameraLands: cameraLands.visibleLands,
    immediateCameraLands: cameraLands.immediateLands,
    primaryCameraLand: cameraLands.primaryLand,
    arSelectedLandId,
    arSelectedLandIdRef,
    setArSelectedLandId,
    activeArLand,
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
