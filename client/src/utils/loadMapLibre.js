let cachedPromise = null;
let cachedWebGLSupport = null;

/**
 * Resets cached WebGL capability probe (intended for test harnesses).
 */
export function resetWebGLSupportCache() {
  cachedWebGLSupport = null;
}

/**
 * Checks whether the current browser runtime supports WebGL rendering
 * (returns false cleanly in jsdom / headless environments without WebGL).
 * Caches the result and immediately releases the probe context via WEBGL_lose_context
 * so mobile browsers never exhaust their active WebGL context cap.
 */
export function hasWebGLSupport() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return false;
  if (cachedWebGLSupport !== null) return cachedWebGLSupport;
  try {
    const canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function') {
      cachedWebGLSupport = false;
      return false;
    }
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const supported = Boolean(gl);
    if (gl && typeof gl.getExtension === 'function') {
      try {
        gl.getExtension('WEBGL_lose_context')?.loseContext?.();
      } catch {
        // ignore if extension is unavailable
      }
    }
    cachedWebGLSupport = supported;
    return supported;
  } catch {
    cachedWebGLSupport = false;
    return false;
  }
}

/**
 * Dynamically loads MapLibre GL JS, its stylesheet, and Vite-emitted worker URL.
 */
export async function loadMapLibre() {
  if (!cachedPromise) {
    cachedPromise = Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl.css'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?url')
    ]).then(([mlMod, , workerMod]) => {
      const maplibregl = mlMod?.default && typeof mlMod.default.Map === 'function' ? mlMod.default : mlMod;
      const workerUrl = workerMod?.default || '';
      if (typeof maplibregl?.setWorkerUrl === 'function' && workerUrl) {
        maplibregl.setWorkerUrl(workerUrl);
      }
      return maplibregl;
    });
  }
  return cachedPromise;
}
