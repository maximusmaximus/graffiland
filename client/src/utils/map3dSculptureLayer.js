import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { extractSculptureScale, yawToRadians } from '../../../shared/sculpturePlacement.mjs';
import { buildVoxelGroup, disposeObject3D } from '../components/VoxelEngine3D.js';
import {
  enforceCrispTexturesAndShading,
  loadCustomModelObject
} from './customModelLoader.js';

const ROTATION_X_90 = new THREE.Matrix4().makeRotationAxis(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2
);

function readVec3(vec, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: Number.isFinite(Number(vec?.x)) ? Number(vec.x) : fallback.x,
    y: Number.isFinite(Number(vec?.y)) ? Number(vec.y) : fallback.y,
    z: Number.isFinite(Number(vec?.z)) ? Number(vec.z) : fallback.z
  };
}

/**
 * Computes exact geographic anchor, altitude, uniform scale, and local grounding offset
 * so both voxel sculptures and custom 3D models (`.glb`, `.gltf`, `.obj`, `.stl`, `.ply`)
 * render cleanly inside their parcel's 10%-padded 3D volume across all 3D maps & previews.
 */
export function computeSculptureMapTransform(sc, parcelVolume = null, modelBounds = null) {
  const hasVol = Boolean(
    parcelVolume &&
      Number.isFinite(Number(parcelVolume.widthMeters)) &&
      Number.isFinite(Number(parcelVolume.depthMeters)) &&
      Number.isFinite(Number(parcelVolume.heightMeters)) &&
      Number(parcelVolume.widthMeters) > 0 &&
      Number(parcelVolume.depthMeters) > 0 &&
      Number(parcelVolume.heightMeters) > 0
  );

  const rawLat = Number(sc?.lat);
  const rawLng = Number(sc?.lng);
  const lat = Number.isFinite(rawLat)
    ? rawLat
    : hasVol && Number.isFinite(Number(parcelVolume.centerLat))
    ? Number(parcelVolume.centerLat)
    : null;
  const lng = Number.isFinite(rawLng)
    ? rawLng
    : hasVol && Number.isFinite(Number(parcelVolume.centerLng))
    ? Number(parcelVolume.centerLng)
    : null;

  if (lat === null || lng === null) return null;

  let min = { x: -0.5, y: 0, z: -0.5 };
  let max = { x: 0.5, y: 1.4, z: 0.5 };
  let size = { x: 1, y: 1.4, z: 1 };
  let center = { x: 0, y: 0.7, z: 0 };

  if (modelBounds) {
    if (typeof modelBounds.getSize === 'function' && typeof modelBounds.getCenter === 'function') {
      const sVec = new THREE.Vector3();
      const cVec = new THREE.Vector3();
      modelBounds.getSize(sVec);
      modelBounds.getCenter(cVec);
      min = readVec3(modelBounds.min, min);
      max = readVec3(modelBounds.max, max);
      size = readVec3(sVec, size);
      center = readVec3(cVec, center);
    } else {
      min = readVec3(modelBounds.min, min);
      max = readVec3(modelBounds.max, max);
      size = modelBounds.size
        ? readVec3(modelBounds.size, size)
        : {
            x: Math.max(0.05, max.x - min.x),
            y: Math.max(0.05, max.y - min.y),
            z: Math.max(0.05, max.z - min.z)
          };
      center = modelBounds.center
        ? readVec3(modelBounds.center, center)
        : {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2,
            z: (min.z + max.z) / 2
          };
    }
  }

  const safeSizeX = Math.max(0.05, size.x);
  const safeSizeY = Math.max(0.05, size.y);
  const safeSizeZ = Math.max(0.05, size.z);
  const maxObjDim = Math.max(safeSizeX, safeSizeY, safeSizeZ, 0.1);

  const off = sc?.anchorOffset || {};
  const anchorDx = Number.isFinite(Number(off.dx)) ? Number(off.dx) : 0;
  const anchorDy = Number.isFinite(Number(off.dy)) ? Math.max(0, Number(off.dy)) : 0;
  const anchorDz = Number.isFinite(Number(off.dz)) ? Number(off.dz) : 0;
  const yawRad = yawToRadians(off.yaw || 0);
  const userScale = extractSculptureScale(sc);

  const baseAlt = hasVol ? Math.max(0, Number(parcelVolume.baseAltitudeM || 0)) : 0;

  let scale = Math.max(0.05, Math.max(1, 7.2 / maxObjDim) * userScale);
  let altitudeMeters = baseAlt + anchorDy;

  if (hasVol) {
    const volW = Number(parcelVolume.widthMeters);
    const volD = Number(parcelVolume.depthMeters);
    const volH = Number(parcelVolume.heightMeters);
    const innerW = volW / 1.2;
    const innerD = volD / 1.2;
    const innerH = volH / 1.2;

    const innerMaxFitScale = Math.min(innerW / safeSizeX, innerD / safeSizeZ, innerH / safeSizeY);
    const fullVolMaxFitScale = Math.min(volW / safeSizeX, volD / safeSizeZ, volH / safeSizeY);
    const targetSpan = Math.min(Math.max(7.2, Math.min(innerW, innerD) * 0.62), 24);
    const baselineScale =
      Number.isFinite(innerMaxFitScale) && innerMaxFitScale > 0
        ? Math.min(targetSpan / maxObjDim, innerMaxFitScale)
        : targetSpan / maxObjDim;

    if (Math.abs(userScale - 1) <= 1e-4) {
      scale = baselineScale;
    } else {
      const scaled = baselineScale * userScale;
      scale =
        Number.isFinite(fullVolMaxFitScale) && fullVolMaxFitScale > 0
          ? Math.min(scaled, fullVolMaxFitScale)
          : scaled;
    }

    const renderedH = safeSizeY * scale;
    const isObjectFittedParcel = Math.abs(userScale - 1) <= 1e-4 && anchorDy === 0 && volH <= renderedH * 1.45;
    if (isObjectFittedParcel) {
      altitudeMeters = baseAlt + Math.max(0, (volH - renderedH) / 2);
    } else {
      altitudeMeters = baseAlt + Math.min(anchorDy, Math.max(0, volH - renderedH));
    }
  }

  scale = Math.max(0.05, Number(scale.toFixed(5)));

  return {
    lat,
    lng,
    altitudeMeters: Number(altitudeMeters.toFixed(4)),
    scale,
    anchorDx,
    anchorDz,
    yawRad,
    centerOffset: {
      x: -center.x,
      y: -min.y,
      z: -center.z
    },
    renderedSize: {
      x: Number((safeSizeX * scale).toFixed(4)),
      y: Number((safeSizeY * scale).toFixed(4)),
      z: Number((safeSizeZ * scale).toFixed(4))
    }
  };
}

function buildSculptureSignature(sc, parcelVolume) {
  const cm = sc?.customModel || {};
  const off = sc?.anchorOffset || {};
  const voxels = Array.isArray(sc?.voxels) ? sc.voxels : [];
  const firstV = voxels[0];
  const lastV = voxels[voxels.length - 1];
  const voxelSig =
    voxels.length > 0
      ? `${voxels.length}:${firstV?.x ?? 0},${firstV?.y ?? 0},${firstV?.color ?? ''}:${lastV?.x ?? 0},${lastV?.y ?? 0},${lastV?.color ?? ''}`
      : '0';
  const volSig = parcelVolume
    ? `${parcelVolume.widthMeters}:${parcelVolume.depthMeters}:${parcelVolume.heightMeters}:${parcelVolume.baseAltitudeM || 0}`
    : 'none';
  return [
    sc?.id || '',
    sc?.currentRev || 1,
    sc?.modelType || 'voxel',
    cm.format || '',
    cm.downloadUrl || sc?.modelGlbUrl || '',
    cm.ipfsCid || '',
    extractSculptureScale(sc),
    cm.rotationY ?? 0,
    sc?.lat ?? '',
    sc?.lng ?? '',
    off.dx ?? 0,
    off.dy ?? 0,
    off.dz ?? 0,
    off.yaw ?? 0,
    voxelSig,
    volSig
  ].join('|');
}

function extractMapMatrixArray(options) {
  if (!options) return null;
  if (options.defaultProjectionData?.mainMatrix) {
    return options.defaultProjectionData.mainMatrix;
  }
  if (options.modelViewProjectionMatrix) {
    return options.modelViewProjectionMatrix;
  }
  if (ArrayLikeMatrix(options)) {
    return options;
  }
  return null;
}

function ArrayLikeMatrix(val) {
  return (
    val &&
    typeof val.length === 'number' &&
    val.length === 16 &&
    Number.isFinite(Number(val[0]))
  );
}

/**
 * Shared MapLibre GL 3D Custom Layer powered by Three.js.
 * Renders real, full-resolution, un-pixelated 3D models (`.glb`/`.gltf`/`.obj`/`.stl`/`.ply`
 * and crisp PBR voxel sculptures) directly inside MapLibre maps & isometric previews using
 * the exact same model pipeline as SculptureViewer3D and live Mobile AR.
 */
export function createSculptureThreeLayer({
  id = 'sculptures-three-3d',
  maplibregl,
  resolveUrlFn = (u) => u,
  onStatsChange = null
} = {}) {
  let mapInstance = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let envRT = null;
  let pmremGenerator = null;
  let maxAnisotropy = 8;
  let disposed = false;

  /** @type {Map<string, any>} */
  const entries = new Map();
  let pendingInput = { sculptures: [], parcels: [], selectedSculptureId: '' };
  let selectedId = '';

  const mapMatrix = new THREE.Matrix4();
  const modelMatrix = new THREE.Matrix4();
  const scaleVec = new THREE.Vector3();

  function emitStats() {
    if (typeof onStatsChange !== 'function') return;
    let loadedCount = 0;
    let customModelCount = 0;
    let voxelModelCount = 0;
    for (const entry of entries.values()) {
      if (entry.loaded) {
        loadedCount += 1;
        if (entry.kind === 'custom-3d') customModelCount += 1;
        else voxelModelCount += 1;
      }
    }
    onStatsChange({
      total: entries.size,
      loadedCount,
      customModelCount,
      voxelModelCount
    });
  }

  function removeEntry(scId) {
    const existing = entries.get(scId);
    if (!existing) return;
    existing.cancelled = true;
    if (existing.container && scene) {
      scene.remove(existing.container);
    }
    if (existing.container) {
      disposeObject3D(existing.container);
    }
    entries.delete(scId);
  }

  function createSelectionRing(radiusM) {
    const r = Math.max(0.65, radiusM);
    const geo = new THREE.RingGeometry(r * 0.88, r * 1.05, 64);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    return ring;
  }

  function mountModelIntoEntry(entry, object3d, bounds, sc, parcelVolume) {
    if (disposed || entry.cancelled || !scene) {
      disposeObject3D(object3d);
      return;
    }
    const transform = computeSculptureMapTransform(sc, parcelVolume, bounds);
    if (!transform) {
      disposeObject3D(object3d);
      return;
    }

    const container = new THREE.Group();
    const pivot = new THREE.Group();

    object3d.position.set(
      transform.centerOffset.x,
      transform.centerOffset.y,
      transform.centerOffset.z
    );
    pivot.add(object3d);
    pivot.scale.setScalar(transform.scale);
    if (transform.yawRad !== 0) {
      pivot.rotation.y = transform.yawRad;
    }
    pivot.position.set(transform.anchorDx, 0, transform.anchorDz);
    container.add(pivot);

    const ringRadius = Math.max(transform.renderedSize.x, transform.renderedSize.z) * 0.62;
    const selectionRing = createSelectionRing(ringRadius);
    selectionRing.position.set(transform.anchorDx, 0.04, transform.anchorDz);
    selectionRing.visible = selectedId === entry.id;
    container.add(selectionRing);

    container.visible = false;
    scene.add(container);

    entry.container = container;
    entry.selectionRing = selectionRing;
    entry.transform = transform;
    entry.loaded = true;

    emitStats();
    if (mapInstance && typeof mapInstance.triggerRepaint === 'function') {
      mapInstance.triggerRepaint();
    }
  }

  function syncData(input = {}) {
    pendingInput = {
      sculptures: Array.isArray(input.sculptures) ? input.sculptures : [],
      parcels: Array.isArray(input.parcels) ? input.parcels : [],
      selectedSculptureId: String(input.selectedSculptureId || '')
    };
    selectedId = pendingInput.selectedSculptureId;

    if (!scene || disposed) return;

    const volumeByParcelId = new Map();
    for (const p of pendingInput.parcels) {
      if (p?.parcelId && p?.volume) {
        volumeByParcelId.set(String(p.parcelId).toUpperCase(), p.volume);
      }
    }

    const nextIds = new Set();

    for (const sc of pendingInput.sculptures) {
      if (!sc || sc.hidden || !sc.id) continue;
      const scId = String(sc.id);
      const isCustom3d = Boolean(
        (sc.modelType === 'custom-3d' || sc.customModel?.format) && sc.customModel?.format
      );
      const hasVoxels = Array.isArray(sc.voxels) && sc.voxels.length > 0;
      if (!isCustom3d && !hasVoxels) {
        // Wait for voxel hydration rather than substituting a blocky placeholder
        continue;
      }

      const pid = String(sc.parcelId || '').toUpperCase();
      const parcelVolume = pid ? volumeByParcelId.get(pid) || null : null;
      const sig = buildSculptureSignature(sc, parcelVolume);

      nextIds.add(scId);
      const existing = entries.get(scId);
      if (existing && existing.sig === sig) {
        if (existing.selectionRing) {
          existing.selectionRing.visible = selectedId === scId;
        }
        continue;
      }

      if (existing) {
        removeEntry(scId);
      }

      const entry = {
        id: scId,
        sig,
        kind: isCustom3d ? 'custom-3d' : 'voxel',
        container: null,
        selectionRing: null,
        transform: null,
        loaded: false,
        cancelled: false
      };
      entries.set(scId, entry);

      if (isCustom3d) {
        loadCustomModelObject(sc, resolveUrlFn, { maxAnisotropy, applyCustomScale: false })
          .then((loaded) => {
            if (!loaded || disposed || entry.cancelled) {
              if (loaded?.object3d) disposeObject3D(loaded.object3d);
              return;
            }
            enforceCrispTexturesAndShading(loaded.object3d, maxAnisotropy);
            mountModelIntoEntry(entry, loaded.object3d, loaded.bounds, sc, parcelVolume);
          })
          .catch(() => {
            // Leave cleanly unloaded if asset is unreachable
          });
      } else {
        const voxelGroup = buildVoxelGroup(sc.voxels, { simplifyLod: false });
        const bounds = new THREE.Box3().setFromObject(voxelGroup);
        if (bounds.isEmpty()) {
          disposeObject3D(voxelGroup);
          entries.delete(scId);
          continue;
        }
        mountModelIntoEntry(entry, voxelGroup, bounds, sc, parcelVolume);
      }
    }

    for (const existingId of Array.from(entries.keys())) {
      if (!nextIds.has(existingId)) {
        removeEntry(existingId);
      }
    }

    emitStats();
    if (mapInstance && typeof mapInstance.triggerRepaint === 'function') {
      mapInstance.triggerRepaint();
    }
  }

  return {
    id,
    type: 'custom',
    renderingMode: '3d',

    setData(input) {
      syncData(input);
    },

    getStats() {
      let loadedCount = 0;
      for (const e of entries.values()) {
        if (e.loaded) loadedCount += 1;
      }
      return { total: entries.size, loadedCount };
    },

    onAdd(map, gl) {
      mapInstance = map;
      disposed = false;

      scene = new THREE.Scene();
      camera = new THREE.Camera();

      // Studio lighting matching SculptureViewer3D so models look identical across map, preview & viewer
      scene.add(new THREE.HemisphereLight(0xe4f3ff, 0x1e293b, 1.05));

      const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
      keyLight.position.set(6, 12, 8);
      scene.add(keyLight);

      const fillLight = new THREE.DirectionalLight(0xa5b4fc, 0.65);
      fillLight.position.set(-7, 6, -5);
      scene.add(fillLight);

      const rimLight = new THREE.DirectionalLight(0x00f5d4, 0.55);
      rimLight.position.set(-5, 4, 8);
      scene.add(rimLight);

      try {
        renderer = new THREE.WebGLRenderer({
          canvas: map.getCanvas(),
          context: gl,
          antialias: true
        });
        renderer.autoClear = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.08;
        maxAnisotropy = Math.min(16, Math.max(1, renderer.capabilities?.getMaxAnisotropy?.() || 8));

        // Build crisp PBR environment map while strictly restoring MapLibre's GL FBO & viewport state
        try {
          const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          const prevViewport = gl.getParameter(gl.VIEWPORT);
          pmremGenerator = new THREE.PMREMGenerator(renderer);
          const roomEnv = new RoomEnvironment();
          envRT = pmremGenerator.fromScene(roomEnv, 0.04);
          roomEnv.dispose();
          scene.environment = envRT.texture;
          renderer.setRenderTarget(null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
          if (prevViewport && prevViewport.length === 4) {
            gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
          }
          renderer.resetState();
        } catch {
          // Multi-directional studio lights remain active if PMREM is unavailable
        }
      } catch {
        renderer = null;
      }

      if (pendingInput.sculptures.length > 0) {
        syncData(pendingInput);
      }
    },

    render(_gl, options) {
      if (disposed || !renderer || !scene || !camera || !maplibregl?.MercatorCoordinate) return;
      if (entries.size === 0) return;

      const rawMatrix = extractMapMatrixArray(options);
      if (!rawMatrix) return;

      mapMatrix.fromArray(rawMatrix);
      renderer.resetState();

      for (const entry of entries.values()) {
        if (!entry.loaded || !entry.container || !entry.transform) continue;
        const t = entry.transform;
        const merc = maplibregl.MercatorCoordinate.fromLngLat(
          [t.lng, t.lat],
          t.altitudeMeters
        );
        const meterScale = merc.meterInMercatorCoordinateUnits();
        if (!Number.isFinite(meterScale) || meterScale <= 0) continue;

        scaleVec.set(meterScale, -meterScale, meterScale);
        modelMatrix
          .makeTranslation(merc.x, merc.y, merc.z)
          .scale(scaleVec)
          .multiply(ROTATION_X_90);

        camera.projectionMatrix.copy(mapMatrix).multiply(modelMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

        entry.container.visible = true;
        renderer.render(scene, camera);
        entry.container.visible = false;
      }
    },

    onRemove() {
      disposed = true;
      for (const scId of Array.from(entries.keys())) {
        removeEntry(scId);
      }
      if (envRT) {
        envRT.dispose();
        envRT = null;
      }
      if (pmremGenerator) {
        pmremGenerator.dispose();
        pmremGenerator = null;
      }
      if (renderer) {
        // Do NOT force-lose MapLibre's shared WebGL context; dispose Three.js caches only
        renderer.dispose();
        renderer = null;
      }
      scene = null;
      camera = null;
      mapInstance = null;
    }
  };
}
