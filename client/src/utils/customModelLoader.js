import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { computeLegacyAutoFitCompensation } from '../../../shared/model3d.mjs';
import { extractSculptureScale } from '../../../shared/sculpturePlacement.mjs';
import { getStoredToken } from './api.js';

let sharedDracoLoader = null;
function getSharedDracoLoader() {
  if (!sharedDracoLoader) {
    sharedDracoLoader = new DRACOLoader();
    const baseUrl = import.meta.env?.BASE_URL || '/';
    sharedDracoLoader.setDecoderPath(
      `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}draco/gltf/`
    );
  }
  return sharedDracoLoader;
}

let sharedKtx2Loader = null;
let ktx2SupportDetected = false;
export function registerKtx2Renderer(renderer) {
  if (!renderer || ktx2SupportDetected) return;
  try {
    if (!sharedKtx2Loader) {
      sharedKtx2Loader = new KTX2Loader();
      sharedKtx2Loader.setTranscoderPath(
        'https://cdn.jsdelivr.net/gh/pmndrs/drei-assets@master/basis/'
      );
    }
    sharedKtx2Loader.detectSupport(renderer);
    ktx2SupportDetected = true;
  } catch {
    // KTX2 optional when WebGL context lacks extensions or in jsdom
  }
}

function getSharedKtx2Loader() {
  if (sharedKtx2Loader && ktx2SupportDetected) return sharedKtx2Loader;
  if (typeof document === 'undefined') return null;
  try {
    if (!sharedKtx2Loader) {
      sharedKtx2Loader = new KTX2Loader();
      sharedKtx2Loader.setTranscoderPath(
        'https://cdn.jsdelivr.net/gh/pmndrs/drei-assets@master/basis/'
      );
    }
    if (!ktx2SupportDetected) {
      const probeCanvas = document.createElement('canvas');
      const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
      if (gl) {
        const fakeRenderer = {
          capabilities: { isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext },
          extensions: {
            has: (ext) => Boolean(gl.getExtension(ext))
          }
        };
        sharedKtx2Loader.detectSupport(fakeRenderer);
        ktx2SupportDetected = true;
      }
    }
    return ktx2SupportDetected ? sharedKtx2Loader : null;
  } catch {
    return null;
  }
}

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'bumpMap',
  'specularMap',
  'alphaMap'
];

/**
 * Ensures every texture & geometry on a loaded 3D model uses smooth linear + anisotropic
 * filtering and valid vertex normals so models never appear pixelated on maps, previews, or AR.
 */
export function enforceCrispTexturesAndShading(root, maxAnisotropy = 8) {
  if (!root || typeof root.traverse !== 'function') return root;
  const aniso = Math.max(1, Math.min(16, Number(maxAnisotropy) || 8));

  root.traverse((obj) => {
    if (!obj?.isMesh && !obj?.isPoints && !obj?.isLine) return;
    if (
      obj.isMesh &&
      obj.geometry &&
      !obj.geometry.attributes?.normal &&
      typeof obj.geometry.computeVertexNormals === 'function'
    ) {
      obj.geometry.computeVertexNormals();
    }
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of TEXTURE_SLOTS) {
        const tex = mat[slot];
        if (!tex) continue;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter =
          tex.generateMipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        tex.anisotropy = Math.max(tex.anisotropy || 1, aniso);
        tex.needsUpdate = true;
      }
      mat.needsUpdate = true;
    }
  });
  return root;
}

function normalizeLoadedObject(
  root,
  customModel = {},
  { maxAnisotropy = 8, applyCustomScale = true, meshStats = null } = {}
) {
  const wrapper = new THREE.Group();
  wrapper.add(root);

  const initialBox = new THREE.Box3().setFromObject(wrapper);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  if (!initialBox.isEmpty()) {
    initialBox.getSize(size);
    initialBox.getCenter(center);
  } else {
    size.set(1, 1, 1);
    center.set(0, 0.5, 0);
  }

  // Compensate ONLY legacy pre-1:1 DB records calibrated under old 1.4m autoFit; new models stay strictly 1:1
  const legacyFactor = computeLegacyAutoFitCompensation(meshStats, size);
  const userScale =
    applyCustomScale && Number.isFinite(Number(customModel?.scale)) && Number(customModel.scale) > 0
      ? Number(customModel.scale)
      : 1;
  const finalScale = legacyFactor * userScale;

  root.scale.multiplyScalar(finalScale);
  const minY = Number.isFinite(initialBox.min.y) ? initialBox.min.y : 0;
  root.position.set(-center.x * finalScale, -minY * finalScale, -center.z * finalScale);

  if (Number.isFinite(Number(customModel?.rotationY)) && Number(customModel.rotationY) !== 0) {
    wrapper.rotation.y = Number(customModel.rotationY);
  }

  wrapper.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  enforceCrispTexturesAndShading(wrapper, maxAnisotropy);

  const bounds = new THREE.Box3().setFromObject(wrapper);
  const finalSize = new THREE.Vector3();
  if (!bounds.isEmpty()) {
    bounds.getSize(finalSize);
  } else {
    finalSize.copy(size).multiplyScalar(finalScale);
  }
  const invUserScale = userScale > 0 ? 1 / userScale : 1;
  const baseSize = {
    width: Math.max(0.01, Math.round(finalSize.x * invUserScale * 10000) / 10000),
    height: Math.max(0.01, Math.round(finalSize.y * invUserScale * 10000) / 10000),
    depth: Math.max(0.01, Math.round(finalSize.z * invUserScale * 10000) / 10000)
  };
  return { object3d: wrapper, bounds, baseSize };
}

function toArrayBuffer(bytesOrBuf) {
  if (bytesOrBuf instanceof ArrayBuffer) return bytesOrBuf;
  if (ArrayBuffer.isView(bytesOrBuf)) {
    return bytesOrBuf.buffer.slice(
      bytesOrBuf.byteOffset,
      bytesOrBuf.byteOffset + bytesOrBuf.byteLength
    );
  }
  throw new Error('Invalid 3D model binary buffer.');
}

function isDefaultUntexturedObjMat(mat) {
  if (!mat) return true;
  const hasMap = Boolean(mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap);
  if (hasMap) return false;
  // OBJLoader creates a plain unnamed white MeshPhongMaterial when no MTL is present
  return mat.isMeshPhongMaterial && (!mat.name || mat.name === '');
}

/**
 * Pure format parser supporting ALL 5 SPRAY.LAND 3D formats:
 * - `.glb` (Binary glTF 2.0, including Draco & Meshopt)
 * - `.gltf` (Self-contained JSON glTF 2.0)
 * - `.obj` (Wavefront OBJ — supports vertex colors, upgrades default Phong to PBR, double-sided)
 * - `.stl` (ASCII & Binary STL — honors binary per-facet RGB colors, double-sided)
 * - `.ply` (ASCII & Binary PLY — supports BOTH triangle meshes AND vertex-only point clouds)
 */
export async function parseCustomModelBytes(
  bytesOrBuf,
  formatRaw,
  customModel = {},
  { maxAnisotropy = 8, applyCustomScale = true, basePath = '', meshStats = null } = {}
) {
  const format = String(formatRaw || customModel?.format || '').trim().toLowerCase();
  const arrayBuffer = toArrayBuffer(bytesOrBuf);
  const byteView = new Uint8Array(arrayBuffer);
  if (byteView.length === 0) {
    throw new Error(`Empty .${format || '3d'} model payload.`);
  }

  let root;
  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader();
    try {
      loader.setDRACOLoader(getSharedDracoLoader());
    } catch {
      // Draco optional in non-browser unit environments
    }
    try {
      const ktx2 = getSharedKtx2Loader();
      if (ktx2) loader.setKTX2Loader(ktx2);
    } catch {
      // KTX2 optional
    }
    loader.setMeshoptDecoder(MeshoptDecoder);

    const isGlbMagic =
      byteView.length >= 4 &&
      byteView[0] === 0x67 &&
      byteView[1] === 0x6c &&
      byteView[2] === 0x54 &&
      byteView[3] === 0x46;

    const payload =
      format === 'glb' || isGlbMagic
        ? arrayBuffer
        : new TextDecoder('utf-8').decode(byteView);
    const gltf = await loader.parseAsync(payload, basePath);
    root = gltf.scene || (gltf.scenes && gltf.scenes[0]) || new THREE.Group();
  } else if (format === 'obj') {
    const text = new TextDecoder('utf-8').decode(byteView);
    const loader = new OBJLoader();
    root = loader.parse(text);
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.geometry && !obj.geometry.attributes?.normal) {
        obj.geometry.computeVertexNormals();
      }
      const hasVertexColors = Boolean(obj.geometry?.attributes?.color);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const upgraded = mats.map((m) =>
        isDefaultUntexturedObjMat(m)
          ? new THREE.MeshStandardMaterial({
              color: hasVertexColors ? 0xffffff : 0x56f5e0,
              vertexColors: hasVertexColors,
              roughness: 0.34,
              metalness: 0.22,
              side: THREE.DoubleSide
            })
          : m
      );
      obj.material = upgraded.length === 1 ? upgraded[0] : upgraded;
    });
  } else if (format === 'stl') {
    const loader = new STLLoader();
    const geo = loader.parse(arrayBuffer);
    geo.computeVertexNormals();
    const hasVertexColors = Boolean(geo.attributes?.color);
    const mat = new THREE.MeshStandardMaterial({
      color: hasVertexColors ? 0xffffff : 0x70f8ff,
      vertexColors: hasVertexColors,
      roughness: 0.28,
      metalness: 0.32,
      side: THREE.DoubleSide
    });
    root = new THREE.Mesh(geo, mat);
  } else if (format === 'ply') {
    const loader = new PLYLoader();
    const geo = loader.parse(arrayBuffer);
    const hasVertexColors = Boolean(geo.attributes?.color);
    const hasIndexedFaces = Boolean(geo.index && geo.index.count >= 3);
    // Check header for face element to distinguish non-indexed triangle meshes from vertex-only point clouds
    const headerHead = new TextDecoder('utf-8', { fatal: false }).decode(
      byteView.subarray(0, Math.min(byteView.length, 1024))
    );
    const declaredFaces = /element\s+face\s+[1-9]\d*/i.test(headerHead);

    if (hasIndexedFaces || declaredFaces) {
      if (!geo.attributes?.normal) geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: hasVertexColors ? 0xffffff : 0xffd166,
        vertexColors: hasVertexColors,
        roughness: 0.34,
        metalness: 0.22,
        side: THREE.DoubleSide
      });
      root = new THREE.Mesh(geo, mat);
    } else {
      // Vertex-only PLY point cloud: render as crisp sized points instead of an invisible 0-face Mesh
      geo.computeBoundingBox();
      const span = new THREE.Vector3();
      if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
        geo.boundingBox.getSize(span);
      }
      const maxSpan = Math.max(span.x, span.y, span.z, 0.5);
      const ptMat = new THREE.PointsMaterial({
        color: hasVertexColors ? 0xffffff : 0xffd166,
        vertexColors: hasVertexColors,
        size: Math.max(0.02, Math.min(0.08, maxSpan * 0.025)),
        sizeAttenuation: true
      });
      root = new THREE.Points(geo, ptMat);
    }
  } else {
    throw new Error(`Unsupported 3D model format: ${format}`);
  }

  return normalizeLoadedObject(root, customModel, { maxAnisotropy, applyCustomScale, meshStats });
}

function decodeBase64ToArrayBuffer(rawBase64) {
  const clean = String(rawBase64 || '')
    .trim()
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');
  if (!clean) return null;
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  if (typeof globalThis.Buffer === 'function') {
    const buf = globalThis.Buffer.from(clean, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  return null;
}

// Bounded session ArrayBuffer cache + in-flight deduplication so switching between
// 3D maps, plot showcase, detail viewer, and Mobile AR never re-downloads the same GLB.
const MODEL_BUFFER_CACHE_MAX_ENTRIES = 16;
const MODEL_BUFFER_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const modelBufferCache = new Map();
const modelBufferInFlight = new Map();
let modelBufferCacheBytes = 0;

function readCachedModelBuffer(cacheKey) {
  const hit = modelBufferCache.get(cacheKey);
  if (!hit) return null;
  // Refresh LRU order
  modelBufferCache.delete(cacheKey);
  modelBufferCache.set(cacheKey, hit);
  // Return a fresh copy so GLTF/Draco worker transfers cannot detach the cached buffer
  return {
    arrayBuffer: hit.arrayBuffer.slice(0),
    resolvedUrl: hit.resolvedUrl
  };
}

function writeCachedModelBuffer(cacheKey, arrayBuffer, resolvedUrl) {
  if (!cacheKey || !arrayBuffer || arrayBuffer.byteLength <= 0) return;
  if (arrayBuffer.byteLength > MODEL_BUFFER_CACHE_MAX_BYTES / 2) return;
  if (modelBufferCache.has(cacheKey)) {
    modelBufferCacheBytes -= modelBufferCache.get(cacheKey).arrayBuffer.byteLength;
    modelBufferCache.delete(cacheKey);
  }
  while (
    modelBufferCache.size >= MODEL_BUFFER_CACHE_MAX_ENTRIES ||
    modelBufferCacheBytes + arrayBuffer.byteLength > MODEL_BUFFER_CACHE_MAX_BYTES
  ) {
    const oldestKey = modelBufferCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = modelBufferCache.get(oldestKey);
    modelBufferCacheBytes = Math.max(0, modelBufferCacheBytes - (oldest?.arrayBuffer?.byteLength || 0));
    modelBufferCache.delete(oldestKey);
  }
  const stored = arrayBuffer.slice(0);
  modelBufferCache.set(cacheKey, { arrayBuffer: stored, resolvedUrl });
  modelBufferCacheBytes += stored.byteLength;
}

export function clearCustomModelBufferCache() {
  modelBufferCache.clear();
  modelBufferInFlight.clear();
  modelBufferCacheBytes = 0;
}

async function fetchModelArrayBufferWithFallback(sculpture, resolveUrlFn) {
  const cm = sculpture?.customModel || {};

  // Fast path for inline pending preview models (modelBase64 / modelData) — zero network latency
  if (cm.inlineBase64) {
    const buf = decodeBase64ToArrayBuffer(cm.inlineBase64);
    if (buf && buf.byteLength > 0) {
      return { arrayBuffer: buf, resolvedUrl: '' };
    }
  }
  if (cm.inlineText && String(cm.inlineText).trim()) {
    const encoded = new TextEncoder().encode(String(cm.inlineText));
    if (encoded.byteLength > 0) {
      return { arrayBuffer: encoded.buffer, resolvedUrl: '' };
    }
  }

  const primaryRaw = cm.downloadUrl || sculpture?.modelGlbUrl || '';
  const primaryUrl = primaryRaw ? resolveUrlFn(primaryRaw) : '';
  const proxyRaw = cm.proxyUrl || '';
  const proxyUrl = proxyRaw ? resolveUrlFn(proxyRaw) : '';

  const candidates = [];
  if (primaryUrl) candidates.push({ url: primaryUrl, auth: false });
  if (proxyUrl) candidates.push({ url: proxyUrl, auth: true });
  const cid = String(cm.ipfsCid || sculpture?.ipfs?.modelCid || '').trim();
  if (cid && /^[a-zA-Z0-9_-]{16,128}$/.test(cid)) {
    candidates.push({ url: `https://gateway.pinata.cloud/ipfs/${cid}`, auth: false });
    candidates.push({ url: `https://ipfs.filebase.io/ipfs/${cid}`, auth: false });
    candidates.push({ url: `https://dweb.link/ipfs/${cid}`, auth: false });
  }

  const cacheKey = [
    sculpture?.id || '',
    sculpture?.currentRev || 1,
    cid,
    primaryUrl || proxyUrl
  ].join('|');

  if (cacheKey) {
    const cached = readCachedModelBuffer(cacheKey);
    if (cached) return cached;
    const pending = modelBufferInFlight.get(cacheKey);
    if (pending) {
      const resolved = await pending;
      return {
        arrayBuffer: resolved.arrayBuffer.slice(0),
        resolvedUrl: resolved.resolvedUrl
      };
    }
  }

  const runFetch = (async () => {
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const headers = {};
        if (candidate.auth) {
          const token = getStoredToken();
          if (token) headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch(candidate.url, {
          mode: 'cors',
          ...(Object.keys(headers).length > 0 ? { headers } : {})
        });
        if (!res.ok) {
          lastErr = new Error(`Model fetch failed (${res.status}) for ${candidate.url}`);
          continue;
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) {
          lastErr = new Error(`Empty model response from ${candidate.url}`);
          continue;
        }
        if (cacheKey) {
          writeCachedModelBuffer(cacheKey, buf, candidate.url);
        }
        return { arrayBuffer: buf, resolvedUrl: candidate.url };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('Could not download 3D model asset.');
  })();

  if (cacheKey) {
    modelBufferInFlight.set(cacheKey, runFetch);
  }
  try {
    const out = await runFetch;
    return {
      arrayBuffer: out.arrayBuffer.slice(0),
      resolvedUrl: out.resolvedUrl
    };
  } finally {
    if (cacheKey) {
      modelBufferInFlight.delete(cacheKey);
    }
  }
}

export async function loadCustomModelObject(
  sculpture,
  resolveUrlFn = (u) => u,
  { maxAnisotropy = 8, applyCustomScale = true, meshStats = undefined } = {}
) {
  const cm = sculpture?.customModel;
  if (!cm?.format) return null;

  const format = String(cm.format || '').toLowerCase();
  const { arrayBuffer, resolvedUrl } = await fetchModelArrayBufferWithFallback(
    sculpture,
    resolveUrlFn
  );
  const basePath = resolvedUrl.includes('/')
    ? resolvedUrl.slice(0, resolvedUrl.lastIndexOf('/') + 1)
    : '';

  const effectiveScale = extractSculptureScale(sculpture);
  const effectiveCustomModel = {
    ...cm,
    scale: effectiveScale
  };
  const normalized = await parseCustomModelBytes(arrayBuffer, format, effectiveCustomModel, {
    maxAnisotropy,
    applyCustomScale,
    basePath,
    meshStats: meshStats !== undefined ? meshStats : sculpture?.meshStats || null
  });

  normalized.object3d.traverse((obj) => {
    if (obj.isMesh || obj.isPoints || obj.isLine) {
      obj.userData.sculpture = sculpture;
    }
  });
  return normalized;
}
