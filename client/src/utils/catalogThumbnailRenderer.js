import * as THREE from 'three';
import { disposeObject3D } from '../components/VoxelEngine3D.js';
import { parseCustomModelBytes, registerKtx2Renderer } from './customModelLoader.js';

const THUMB_SIZE = 144;
const MAX_CACHE = 96;
const thumbCache = new Map();
const inFlight = new Map();
const queue = [];
let pumping = false;

let sharedRenderer = null;
let sharedScene = null;
let sharedCamera = null;
let webglUnavailable = false;

function resetThumbRig() {
  const prev = sharedRenderer;
  sharedRenderer = null;
  sharedScene = null;
  sharedCamera = null;
  if (prev) {
    try {
      prev.dispose();
    } catch {
      // ignore disposal error on lost context
    }
  }
}

function ensureThumbRig() {
  if (webglUnavailable || typeof document === 'undefined') return null;
  if (sharedRenderer && sharedScene && sharedCamera) {
    const gl = sharedRenderer.getContext?.();
    if (typeof gl?.isContextLost === 'function' && gl.isContextLost()) {
      resetThumbRig();
    } else {
      return { renderer: sharedRenderer, scene: sharedScene, camera: sharedCamera };
    }
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power'
    });
    canvas.addEventListener(
      'webglcontextlost',
      (ev) => {
        ev.preventDefault();
        if (sharedRenderer === renderer) {
          resetThumbRig();
        }
      },
      false
    );
    renderer.setPixelRatio(1);
    renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    registerKtx2Renderer(renderer);

    const scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xf0f9ff, 0x1e293b, 1.35);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 4.0, 3.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x00f5d4, 0.75);
    rim.position.set(-3.0, 1.8, -2.5);
    scene.add(rim);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
    sharedRenderer = renderer;
    sharedScene = scene;
    sharedCamera = camera;
    return { renderer, scene, camera };
  } catch {
    webglUnavailable = true;
    return null;
  }
}

function cacheSet(key, val) {
  if (thumbCache.has(key)) thumbCache.delete(key);
  thumbCache.set(key, val);
  while (thumbCache.size > MAX_CACHE) {
    const oldest = thumbCache.keys().next().value;
    thumbCache.delete(oldest);
  }
}

async function renderSingleGlbThumb(url) {
  const rig = ensureThumbRig();
  if (!rig) return null;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 9000) : null;
  let bytes;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller?.signal });
    if (!res.ok) return null;
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!bytes || bytes.length === 0) return null;

  let loaded = null;
  try {
    loaded = await parseCustomModelBytes(bytes, 'glb', { format: 'glb', scale: 1 }, {
      maxAnisotropy: 4,
      applyCustomScale: false
    });
    const obj = loaded?.object3d;
    if (!obj) return null;

    const { renderer, scene, camera } = rig;
    scene.add(obj);
    try {
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const maxDim = Math.max(0.05, size.x, size.y, size.z);
      const dist = (maxDim * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.18;
      camera.near = Math.max(0.005, dist * 0.02);
      camera.far = Math.max(20, dist * 12);
      camera.position.set(
        center.x + dist * 0.72,
        center.y + dist * 0.44,
        center.z + dist * 0.78
      );
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    } finally {
      scene.remove(obj);
      disposeObject3D(obj);
    }
  } catch {
    return null;
  }
}

async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;
      if (job.aborted) {
        job.resolve(null);
        continue;
      }
      const dataUrl = await renderSingleGlbThumb(job.url);
      if (dataUrl) cacheSet(job.url, dataUrl);
      job.resolve(dataUrl);
      if (queue.length > 0) {
        // Yield briefly to keep mobile touch scrolling & search typing responsive
        await new Promise((r) => setTimeout(r, 16));
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Renders a crisp 144×144 studio-lit 3D PNG preview thumbnail for a `.glb` URL using
 * one shared offscreen WebGLRenderer (safe against WebGL context limits).
 */
export function requestGlbThumbnail(url) {
  const key = String(url || '').trim();
  if (!key || webglUnavailable || typeof document === 'undefined') {
    return { promise: Promise.resolve(null), cancel: () => {} };
  }
  if (thumbCache.has(key)) {
    return { promise: Promise.resolve(thumbCache.get(key)), cancel: () => {} };
  }
  if (inFlight.has(key)) {
    return { promise: inFlight.get(key), cancel: () => {} };
  }
  let job = null;
  const promise = new Promise((resolve) => {
    job = { url: key, aborted: false, resolve };
    queue.push(job);
    pumpQueue();
  }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return {
    promise,
    cancel: () => {
      if (job) job.aborted = true;
    }
  };
}
