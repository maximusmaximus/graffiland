import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { api, resolveApiUrl } from '../utils/api.js';
import { loadCustomModelObject } from '../utils/customModelLoader.js';
import { groupNearestLandsWithSculptures } from '../utils/landMapHelpers.js';
import {
  buildVoxelGroup,
  disposeObject3D,
  latLngOffsetMeters
} from '../components/VoxelEngine3D.js';

/**
 * Manages nearby AR sculptures rendering (InstancedMesh + distance LOD + custom 3D models +
 * parcel perimeters), live ORB relocalization with smooth heading yaw correction,
 * and the mobile Public Area Map drawer.
 */
export function useARPreview({
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
  const orbHeadingCorrectionRadRef = useRef(0);

  const [nearbySculptures, setNearbySculptures] = useState([]);
  const [arTargetedSculpture, setArTargetedSculpture] = useState(null);

  const [mapOpen, setMapOpen] = useState(false);
  const [areaFilterMode, setAreaFilterMode] = useState('nearby');
  const [mapSculptures, setMapSculptures] = useState([]);
  const [mapParcels, setMapParcels] = useState([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSelectedSculpture, setMapSelectedSculpture] = useState(null);
  const [mapSelectedParcelId, setMapSelectedParcelId] = useState('');
  const [mapFocusParcelTick, setMapFocusParcelTick] = useState(0);

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

  // Build nearby sculptures + parcel borders with InstancedMesh & distance LOD (>25m)
  useEffect(() => {
    const group = nearbyGroupRef.current;
    if (!group) return undefined;
    disposeObject3D(group);
    while (group.children.length > 0) group.remove(group.children[0]);

    if (mode !== 'preview' || !location) return undefined;

    const viewerElev =
      location.altitude !== null && location.altitude !== undefined && Number.isFinite(location.altitude)
        ? location.altitude
        : null;
    let cancelled = false;

    for (const sc of nearbySculptures) {
      const offset = latLngOffsetMeters(location.lat, location.lng, sc.lat, sc.lng);
      const dist = Math.hypot(offset.east, offset.north);
      const isCustom3d = sc.modelType === 'custom-3d' && sc.customModel?.format;
      const sub = isCustom3d
        ? new THREE.Group()
        : buildVoxelGroup(sc.voxels || [], { simplifyLod: dist > 25 });
      sub.traverse((obj) => {
        if (obj.isMesh) obj.userData.sculpture = sc;
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
      sub.add(hitProxy);

      if (isCustom3d) {
        loadCustomModelObject(sc, resolveApiUrl)
          .then((loaded) => {
            if (cancelled || !loaded) return;
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
        opacity: 0.65,
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
      baseGlowRing.userData = { sculpture: sc, clickableBase: true };
      sub.add(baseGlowRing);

      const baseHaloMat = new THREE.MeshBasicMaterial({
        color: 0x00f5d4,
        transparent: true,
        opacity: 0.18,
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
      baseGlowHalo.userData = { sculpture: sc, clickableBase: true };
      sub.add(baseGlowHalo);

      sub.userData = {
        sculptureId: sc.id,
        sculpture: sc,
        baseRingMat: baseGlowRingMat,
        baseHaloMat,
        baseGlowRing
      };

      const ax = Number(sc.anchorOffset?.dx || 0);
      const ay = Number(sc.anchorOffset?.dy || 0);
      const az = Number(sc.anchorOffset?.dz || 0);
      const ayaw = Number(sc.anchorOffset?.yaw || 0);
      if (Number.isFinite(ayaw) && ayaw !== 0) {
        sub.rotation.y = ayaw;
      }
      sub.position.set(
        offset.east * clampFactor + ax,
        deltaY + ay,
        -offset.north * clampFactor + az
      );
      group.add(sub);
    }

    const renderedParcels = new Set();
    for (const sc of nearbySculptures) {
      if (!sc.parcelId || renderedParcels.has(sc.parcelId) || !sc.parcelBounds?.sw || !sc.parcelBounds?.ne) {
        continue;
      }
      renderedParcels.add(sc.parcelId);
      const [swLat, swLng] = sc.parcelBounds.sw;
      const [neLat, neLng] = sc.parcelBounds.ne;
      const insideParcel =
        location.lat >= swLat && location.lat <= neLat && location.lng >= swLng && location.lng <= neLng;
      const baseY = (sc.elevation?.sculptureVerticalMinM ?? 0) - 0.11;
      const corners = [
        [swLat, swLng],
        [swLat, neLng],
        [neLat, neLng],
        [neLat, swLng]
      ].map(([cLat, cLng]) => {
        const off = latLngOffsetMeters(location.lat, location.lng, cLat, cLng);
        const cd = Math.hypot(off.east, off.north);
        const cf = cd > 55 ? 55 / cd : 1;
        return new THREE.Vector3(off.east * cf, baseY, -off.north * cf);
      });
      const borderGeo = new THREE.BufferGeometry().setFromPoints(corners);
      const borderMat = new THREE.LineBasicMaterial({
        color: insideParcel ? 0xffd166 : 0x00f5d4,
        transparent: true,
        opacity: insideParcel ? 0.92 : 0.56
      });
      const perimeterLoop = new THREE.LineLoop(borderGeo, borderMat);
      perimeterLoop.userData = {
        isParcelPerimeter: true,
        insideParcel,
        parcelId: sc.parcelId,
        perimeterMat: borderMat
      };
      group.add(perimeterLoop);
    }

    return () => {
      cancelled = true;
    };
  }, [mode, location, nearbySculptures, nearbyGroupRef]);

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
    } catch {
      // keep existing items
    } finally {
      setMapLoading(false);
    }
  }, []);

  const openAreaMap = useCallback(() => {
    stopBrushPainting();
    if (modeRef.current === 'transform') {
      commitTransformAndExit('draw');
    }
    setAreaFilterMode('nearby');
    setMapOpen(true);
    loadPublicMapData();
  }, [commitTransformAndExit, loadPublicMapData, modeRef, stopBrushPainting]);

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
    hydratedSculptureMapRef,
    hydrateNearbyList,
    arTargetedSculpture,
    setArTargetedSculpture,
    arTargetedIdRef,
    mapOpen,
    setMapOpen,
    areaFilterMode,
    setAreaFilterMode,
    mapSculptures,
    setMapSculptures,
    mapParcels,
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
