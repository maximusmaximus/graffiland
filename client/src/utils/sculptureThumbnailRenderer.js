import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildVoxelGroup, disposeObject3D } from '../components/VoxelEngine3D.js';
import { resolveApiUrl } from './api.js';
import {
  enforceCrispTexturesAndShading,
  loadCustomModelObject
} from './customModelLoader.js';

const THUMB_WIDTH = 240;
const THUMB_HEIGHT = 180;
const MAX_CACHE_ENTRIES = 120;

const thumbCache = new Map();
const inflightBySig = new Map();
let renderChain = Promise.resolve();
let sharedCtx = null;
let webglUnavailable = false;

export function resolveDirectPreviewUrl(sc) {
  const raw = String(sc?.previewDataUrl || '').trim();
  if (!raw) return '';
  if (
    raw.startsWith('data:image/') ||
    raw.startsWith('https://') ||
    raw.startsWith('http://') ||
    raw.startsWith('/')
  ) {
    return raw;
  }
  return '';
}

export function getSculptureThumbnailSignature(sc) {
  if (!sc) return '';
  const cm = sc.customModel || {};
  const voxels = Array.isArray(sc.voxels) ? sc.voxels : [];
  const firstV = voxels[0];
  const lastV = voxels[voxels.length - 1];
  const voxelKey =
    voxels.length > 0
      ? `${voxels.length}:${firstV?.x ?? 0},${firstV?.y ?? 0},${firstV?.color ?? ''}:${lastV?.x ?? 0},${lastV?.y ?? 0},${lastV?.color ?? ''}`
      : '0';
  return [
    sc.id || '',
    sc.currentRev || 1,
    sc.modelType || 'voxel',
    cm.format || '',
    cm.downloadUrl || cm.proxyUrl || sc.modelGlbUrl || '',
    cm.ipfsCid || '',
    voxelKey
  ].join('|');
}

export function getCachedSculptureThumbnail(sc) {
  const direct = resolveDirectPreviewUrl(sc);
  if (direct) return direct;
  const sig = getSculptureThumbnailSignature(sc);
  return sig ? thumbCache.get(sig) || '' : '';
}

function setCachedThumbnail(sig, dataUrl) {
  if (!sig || !dataUrl) return;
  if (thumbCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = thumbCache.keys().next().value;
    if (oldestKey) thumbCache.delete(oldestKey);
  }
  thumbCache.set(sig, dataUrl);
}

function shadeHexColor(hexStr, factor = 1) {
  const raw = String(hexStr || '#00f5d4').trim().replace(/^#/, '');
  let r = 0;
  let g = 245;
  let b = 212;
  if (/^[0-9a-f]{6}$/i.test(raw)) {
    r = parseInt(raw.slice(0, 2), 16);
    g = parseInt(raw.slice(2, 4), 16);
    b = parseInt(raw.slice(4, 6), 16);
  } else if (/^[0-9a-f]{3}$/i.test(raw)) {
    r = parseInt(raw[0] + raw[0], 16);
    g = parseInt(raw[1] + raw[1], 16);
    b = parseInt(raw[2] + raw[2], 16);
  }
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n * factor)));
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

/**
 * Pure 2D isometric projection of voxel blocks so every voxel sculpture has an immediate,
 * color-accurate thumbnail even before WebGL renders or in non-WebGL environments.
 */
export function projectVoxelsToIsoCubes(
  voxels,
  { width = 160, height = 120, maxCubes = 160 } = {}
) {
  if (!Array.isArray(voxels) || voxels.length === 0) return [];
  const step = voxels.length > maxCubes ? Math.ceil(voxels.length / maxCubes) : 1;
  const sampled = [];
  for (let i = 0; i < voxels.length; i += step) {
    const v = voxels[i];
    if (!v) continue;
    const x = Number(v.x);
    const y = Number(v.y);
    const z = Number(v.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    sampled.push({ x, y, z, color: v.color || '#00f5d4' });
  }
  if (sampled.length === 0) return [];

  // Normalize to unit lattice spacing
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const v of sampled) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  // Estimate block spacing from smallest non-zero coordinate difference
  let gridStep = Infinity;
  for (let i = 0; i < Math.min(sampled.length, 48); i++) {
    for (let j = i + 1; j < Math.min(sampled.length, 48); j++) {
      const dx = Math.abs(sampled[i].x - sampled[j].x);
      const dy = Math.abs(sampled[i].y - sampled[j].y);
      const dz = Math.abs(sampled[i].z - sampled[j].z);
      for (const d of [dx, dy, dz]) {
        if (d > 1e-4 && d < gridStep) gridStep = d;
      }
    }
  }
  if (!Number.isFinite(gridStep) || gridStep <= 0) {
    gridStep = Math.max(0.1, Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 3 || 0.2);
  }

  const normalized = sampled.map((v) => ({
    gx: (v.x - cx) / gridStep,
    gy: (v.y - cy) / gridStep,
    gz: (v.z - cz) / gridStep,
    color: v.color
  }));

  // Back-to-front painter's sort along isometric view direction (+x, +y, +z closest)
  normalized.sort((a, b) => a.gx + a.gz + a.gy * 0.5 - (b.gx + b.gz + b.gy * 0.5));

  // Project bounds first to scale cleanly inside viewport with padding
  const COS30 = 0.866;
  const SIN30 = 0.5;
  let pMinX = Infinity;
  let pMaxX = -Infinity;
  let pMinY = Infinity;
  let pMaxY = -Infinity;
  for (const v of normalized) {
    const px = (v.gx - v.gz) * COS30;
    const py = (v.gx + v.gz) * SIN30 - v.gy;
    if (px - COS30 < pMinX) pMinX = px - COS30;
    if (px + COS30 > pMaxX) pMaxX = px + COS30;
    if (py - 1.15 < pMinY) pMinY = py - 1.15;
    if (py + 1.15 > pMaxY) pMaxY = py + 1.15;
  }

  const spanX = Math.max(1.8, pMaxX - pMinX);
  const spanY = Math.max(1.8, pMaxY - pMinY);
  const padX = width * 0.14;
  const padY = height * 0.14;
  const unitPx = Math.min((width - padX * 2) / spanX, (height - padY * 2) / spanY, 26);
  const offsetX = width / 2 - ((pMinX + pMaxX) / 2) * unitPx;
  const offsetY = height / 2 - ((pMinY + pMaxY) / 2) * unitPx;

  const halfW = COS30 * 0.52 * unitPx;
  const halfH = SIN30 * 0.52 * unitPx;
  const blockH = 0.54 * unitPx;

  return normalized.map((v) => {
    const sx = offsetX + (v.gx - v.gz) * COS30 * unitPx;
    const sy = offsetY + ((v.gx + v.gz) * SIN30 - v.gy) * unitPx;
    const topPts = [
      [sx, sy - blockH - halfH],
      [sx + halfW, sy - blockH],
      [sx, sy - blockH + halfH],
      [sx - halfW, sy - blockH]
    ];
    const leftPts = [
      [sx - halfW, sy - blockH],
      [sx, sy - blockH + halfH],
      [sx, sy + halfH],
      [sx - halfW, sy]
    ];
    const rightPts = [
      [sx + halfW, sy - blockH],
      [sx, sy - blockH + halfH],
      [sx, sy + halfH],
      [sx + halfW, sy]
    ];
    const fmt = (pts) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return {
      top: fmt(topPts),
      left: fmt(leftPts),
      right: fmt(rightPts),
      topFill: shadeHexColor(v.color, 1.12),
      leftFill: shadeHexColor(v.color, 0.82),
      rightFill: shadeHexColor(v.color, 0.64)
    };
  });
}

function getSharedOffscreenContext() {
  if (webglUnavailable || typeof document === 'undefined') return null;
  if (sharedCtx) return sharedCtx;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(1);
    renderer.setSize(THUMB_WIDTH, THUMB_HEIGHT, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1222');

    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envRT = pmrem.fromScene(roomEnv, 0.04);
    roomEnv.dispose();
    pmrem.dispose();
    scene.environment = envRT.texture;

    scene.add(new THREE.HemisphereLight(0xdff6ff, 0x1b2338, 0.95));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(5, 8, 6);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x00f5d4, 0.55);
    rimLight.position.set(-6, 4, -5);
    scene.add(rimLight);

    const camera = new THREE.PerspectiveCamera(40, THUMB_WIDTH / THUMB_HEIGHT, 0.02, 500);
    const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() || 4;

    sharedCtx = { renderer, scene, camera, maxAnisotropy };
    return sharedCtx;
  } catch {
    webglUnavailable = true;
    return null;
  }
}

async function renderOneThumbnail(sc) {
  const ctx = getSharedOffscreenContext();
  if (!ctx) return '';

  const isCustom3d = Boolean(
    (sc.modelType === 'custom-3d' || sc.customModel?.format) && sc.customModel?.format
  );
  const hasVoxels = Array.isArray(sc.voxels) && sc.voxels.length > 0;
  if (!isCustom3d && !hasVoxels) return '';

  let root = null;
  try {
    if (isCustom3d) {
      const loaded = await loadCustomModelObject(sc, resolveApiUrl, {
        maxAnisotropy: ctx.maxAnisotropy,
        applyCustomScale: false
      });
      if (!loaded?.object3d) return '';
      enforceCrispTexturesAndShading(loaded.object3d, ctx.maxAnisotropy);
      root = loaded.object3d;
    } else {
      root = buildVoxelGroup(sc.voxels, { simplifyLod: false });
    }

    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return '';

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // Center object cleanly at origin and fit camera tightly to bounding sphere
    root.position.sub(center);
    ctx.scene.add(root);

    const radius = Math.max(0.25, size.length() * 0.5);
    const fovRad = (ctx.camera.fov * Math.PI) / 180;
    const aspect = THUMB_WIDTH / THUMB_HEIGHT;
    const vDist = radius / Math.sin(fovRad / 2);
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
    const hDist = radius / Math.sin(hFov / 2);
    const dist = Math.max(vDist, hDist) * 1.12;

    const dir = new THREE.Vector3(1.0, 0.68, 1.12).normalize();
    ctx.camera.position.copy(dir.multiplyScalar(dist));
    ctx.camera.near = Math.max(0.01, dist * 0.02);
    ctx.camera.far = Math.max(100, dist * 10);
    ctx.camera.lookAt(0, 0, 0);
    ctx.camera.updateProjectionMatrix();

    ctx.renderer.render(ctx.scene, ctx.camera);
    const dataUrl = ctx.renderer.domElement.toDataURL('image/png');
    return dataUrl && dataUrl.startsWith('data:image/') ? dataUrl : '';
  } catch {
    return '';
  } finally {
    if (root) {
      ctx.scene.remove(root);
      disposeObject3D(root);
    }
  }
}

/**
 * Renders (and caches) a crisp 3D thumbnail image for any SPRAY.LAND sculpture using one shared
 * offscreen WebGL context queued sequentially so scrolling large galleries never exhausts GPU contexts.
 */
export function renderSculptureThumbnail(sc) {
  const direct = resolveDirectPreviewUrl(sc);
  if (direct) return Promise.resolve(direct);

  const sig = getSculptureThumbnailSignature(sc);
  if (!sig) return Promise.resolve('');

  const cached = thumbCache.get(sig);
  if (cached) return Promise.resolve(cached);

  if (inflightBySig.has(sig)) return inflightBySig.get(sig);

  const promise = renderChain
    .then(() => renderOneThumbnail(sc))
    .then((dataUrl) => {
      if (dataUrl) setCachedThumbnail(sig, dataUrl);
      return dataUrl;
    })
    .catch(() => '')
    .finally(() => {
      inflightBySig.delete(sig);
    });

  renderChain = promise.then(
    () => {},
    () => {}
  );
  inflightBySig.set(sig, promise);
  return promise;
}
