let cachedPromise = null;

/**
 * Checks whether the current browser runtime supports WebGL rendering
 * (returns false cleanly in jsdom / headless environments without WebGL).
 */
export function hasWebGLSupport() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return false;
  try {
    const canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function') return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return Boolean(gl);
  } catch {
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
