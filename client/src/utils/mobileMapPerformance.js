export const MOBILE_3D_MAP_MAX_PIXEL_RATIO = 1.5;
export const DESKTOP_3D_MAP_MAX_PIXEL_RATIO = 2;
export const MOBILE_3D_MAP_MAX_MODELS_COMPACT = 4;
export const MOBILE_3D_MAP_MAX_MODELS_FULLSCREEN = 6;
export const MOBILE_3D_MAP_MAX_CONCURRENT_LOADS = 2;
export const DESKTOP_3D_MAP_MAX_CONCURRENT_LOADS = 6;
export const MOBILE_3D_MAP_MAX_ANISOTROPY = 4;
export const DESKTOP_3D_MAP_MAX_ANISOTROPY = 16;

/**
 * Resolves a safe MapLibre WebGL pixelRatio that avoids mobile GPU framebuffer OOM
 * during compact <-> full-screen transitions while keeping visuals crisp.
 */
export function resolveMapLibrePixelRatio({
  isDesktop = false,
  devicePixelRatio = 1,
  lowPowerFallback = false
} = {}) {
  if (lowPowerFallback) return 1;
  const raw = Number(devicePixelRatio);
  const safeDpr = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const cap = isDesktop ? DESKTOP_3D_MAP_MAX_PIXEL_RATIO : MOBILE_3D_MAP_MAX_PIXEL_RATIO;
  return Math.max(1, Math.min(safeDpr, cap));
}

function approxDistSq(a, b) {
  const latA = Number(a?.lat);
  const lngA = Number(a?.lng);
  const latB = Number(b?.lat);
  const lngB = Number(b?.lng);
  if (
    !Number.isFinite(latA) ||
    !Number.isFinite(lngA) ||
    !Number.isFinite(latB) ||
    !Number.isFinite(lngB)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const dLat = latA - latB;
  const dLng = (lngA - lngB) * Math.cos((latB * Math.PI) / 180);
  return dLat * dLat + dLng * dLng;
}

/**
 * Selects which sculptures should mount full Three.js GLB/voxel meshes inside MapLibre's
 * custom WebGL layer. Desktop mounts all visible sculptures; mobile caps simultaneous heavy
 * Three.js models (prioritizing selected sculpture, focused parcel, then closest sculptures)
 * so expanding to Full Screen with 30+ lands never triggers mobile WebGL OOM context loss.
 * Distant sculptures beyond the mobile cap still render via MapLibre's native GPU extrusions.
 */
export function selectPrioritizedThreeLayerSculptures(
  sculptures = [],
  {
    isDesktop = false,
    isFullExpanded = false,
    focusedParcelId = '',
    selectedSculptureId = '',
    focusCoords = null,
    maxMobileModels = null
  } = {}
) {
  const visible = (Array.isArray(sculptures) ? sculptures : []).filter(
    (sc) => sc && sc.id && !sc.hidden
  );
  if (isDesktop) return visible;

  const cap =
    Number.isFinite(Number(maxMobileModels)) && Number(maxMobileModels) > 0
      ? Math.floor(Number(maxMobileModels))
      : isFullExpanded
      ? MOBILE_3D_MAP_MAX_MODELS_FULLSCREEN
      : MOBILE_3D_MAP_MAX_MODELS_COMPACT;

  if (visible.length <= cap) return visible;

  const focusedPid = String(focusedParcelId || '').toUpperCase();
  const selId = String(selectedSculptureId || '');

  const ranked = visible.map((sc, idx) => {
    const isSelected = Boolean(selId && String(sc.id) === selId);
    const isFocusedParcel = Boolean(
      focusedPid && String(sc.parcelId || '').toUpperCase() === focusedPid
    );
    const tier = isSelected ? 0 : isFocusedParcel ? 1 : 2;
    const distSq = focusCoords ? approxDistSq(sc, focusCoords) : idx;
    return { sc, tier, distSq, idx };
  });

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.distSq !== b.distSq) return a.distSq - b.distSq;
    return a.idx - b.idx;
  });

  return ranked.slice(0, cap).map((r) => r.sc);
}
