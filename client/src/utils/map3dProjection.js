/**
 * Resolves MapLibre's active Mercator->clip projection matrix across both
 * MapLibre GL v6 (`map._camera.projectedCamera.mercatorMatrix`) and v5 (`map.transform.mercatorMatrix`).
 */
function resolveMercatorMatrix(map) {
  const projectedCamera = map?._camera?.projectedCamera || null;
  return (
    projectedCamera?.mercatorMatrix ||
    projectedCamera?.mercator?.mercatorMatrix ||
    map?.transform?.mercatorMatrix ||
    null
  );
}

/**
 * Projects a 3D [lng, lat, altitudeMeters] coordinate onto screen CSS pixel coordinates
 * matching MapLibre GL's current camera transform, strictly culling points behind the camera.
 */
export function projectLngLatAltToScreen(map, maplibregl, lng, lat, altitudeMeters = 0) {
  if (!map || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
    return { x: 0, y: 0, depth: 0, visible: false };
  }
  const alt = Number(altitudeMeters || 0);
  const canvas = map.getCanvas?.();
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;

  const projectedCamera = map._camera?.projectedCamera || null;
  const matrix = resolveMercatorMatrix(map);
  const MC = maplibregl?.MercatorCoordinate;

  if (matrix && MC && typeof MC.fromLngLat === 'function' && width > 0 && height > 0) {
    let mc = null;
    try {
      mc = MC.fromLngLat([Number(lng), Number(lat)], alt);
    } catch {
      mc = null;
    }
    if (mc) {
      const x = mc.x;
      const y = mc.y;
      const z = mc.z || 0;
      const cx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      const cy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      const cw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      // Strictly cull coordinates behind the camera (never fall back to 2D map.project!)
      if (!Number.isFinite(cw) || cw <= 0.0001) {
        return { x: 0, y: 0, depth: Number.isFinite(cw) ? cw : 0, visible: false };
      }
      const ndcX = cx / cw;
      const ndcY = cy / cw;
      // Guard against extreme near-plane singularity explosions
      if (
        !Number.isFinite(ndcX) ||
        !Number.isFinite(ndcY) ||
        Math.abs(ndcX) > 12 ||
        Math.abs(ndcY) > 12
      ) {
        return { x: 0, y: 0, depth: cw, visible: false };
      }
      return {
        x: (ndcX + 1) * 0.5 * width,
        y: (1 - ndcY) * 0.5 * height,
        depth: cw,
        visible: true
      };
    }
  }

  // Secondary 3D projection via MapLibre v6 pixelMatrix3D when available without mercatorMatrix
  const pixelMatrix3D =
    projectedCamera?.pixelMatrix3D || projectedCamera?.mercator?.pixelMatrix3D || null;
  const worldSize = Number(projectedCamera?.worldSize || projectedCamera?.mercator?.worldSize || 0);
  if (
    pixelMatrix3D &&
    worldSize > 0 &&
    MC &&
    typeof MC.fromLngLat === 'function' &&
    width > 0 &&
    height > 0
  ) {
    try {
      const mc = MC.fromLngLat([Number(lng), Number(lat)], 0);
      const px = mc.x * worldSize;
      const py = mc.y * worldSize;
      const ox = pixelMatrix3D[0] * px + pixelMatrix3D[4] * py + pixelMatrix3D[8] * alt + pixelMatrix3D[12];
      const oy = pixelMatrix3D[1] * px + pixelMatrix3D[5] * py + pixelMatrix3D[9] * alt + pixelMatrix3D[13];
      const ow = pixelMatrix3D[3] * px + pixelMatrix3D[7] * py + pixelMatrix3D[11] * alt + pixelMatrix3D[15];
      if (!Number.isFinite(ow) || ow <= 0.0001) {
        return { x: 0, y: 0, depth: Number.isFinite(ow) ? ow : 0, visible: false };
      }
      const sx = ox / ow;
      const sy = oy / ow;
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        Math.abs(sx) > width * 10 ||
        Math.abs(sy) > height * 10
      ) {
        return { x: 0, y: 0, depth: ow, visible: false };
      }
      return { x: sx, y: sy, depth: ow, visible: true };
    } catch {
      return { x: 0, y: 0, depth: 0, visible: false };
    }
  }

  try {
    const pt = map.project([Number(lng), Number(lat)]);
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      return { x: 0, y: 0, depth: 0, visible: false };
    }
    if (
      width > 0 &&
      height > 0 &&
      (pt.x < -width * 1.1 || pt.x > width * 2.1 || pt.y < -height * 1.1 || pt.y > height * 2.1)
    ) {
      return { x: 0, y: 0, depth: 0, visible: false };
    }
    const pitchDeg = Number(map.getPitch?.() || 0);
    const fallbackDepth = pitchDeg > 1 ? -pt.y : 0;
    if (alt === 0) {
      return { x: pt.x, y: pt.y, depth: fallbackDepth, visible: true };
    }
    const pitchRad = (pitchDeg * Math.PI) / 180;
    const zoom = map.getZoom?.() || 14;
    const cosLat = Math.max(0.1, Math.cos((Number(lat) * Math.PI) / 180));
    const metersPerPixel = (40075016.686 * cosLat) / (512 * Math.pow(2, zoom));
    const pxLift = (alt / Math.max(0.01, metersPerPixel)) * Math.sin(pitchRad);
    return { x: pt.x, y: pt.y - pxLift, depth: fallbackDepth, visible: true };
  } catch {
    return { x: 0, y: 0, depth: 0, visible: false };
  }
}

/**
 * Projects a 3D land prism's bottom 4 corners, top 4 corners, and top center to 2D canvas points.
 * Returns null if any corner is behind the camera or if the entire prism lies off-screen.
 */
export function computePrismScreenGeometry(map, maplibregl, volume) {
  if (!volume || !Array.isArray(volume.corners) || volume.corners.length < 4) return null;
  const baseAlt = Number(volume.baseAltitudeM || 0);
  const topAlt = baseAlt + Number(volume.heightMeters || 18);

  const bottom = volume.corners.slice(0, 4).map(([lng, lat]) =>
    projectLngLatAltToScreen(map, maplibregl, lng, lat, baseAlt)
  );
  const top = volume.corners.slice(0, 4).map(([lng, lat]) =>
    projectLngLatAltToScreen(map, maplibregl, lng, lat, topAlt)
  );
  const topCenter = projectLngLatAltToScreen(
    map,
    maplibregl,
    volume.centerLng,
    volume.centerLat,
    topAlt
  );

  if (bottom.some((p) => !p.visible) || top.some((p) => !p.visible) || !topCenter.visible) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let depthSum = 0;
  const allPts = [...bottom, ...top];
  for (const p of allPts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    depthSum += Number(p.depth || 0);
  }

  const canvas = map?.getCanvas?.();
  const w = canvas?.clientWidth || canvas?.width || 0;
  const h = canvas?.clientHeight || canvas?.height || 0;
  if (w > 0 && h > 0) {
    const padX = w * 0.45;
    const padY = h * 0.45;
    if (maxX < -padX || minX > w + padX || maxY < -padY || minY > h + padY) {
      return null;
    }
  }

  return {
    bottom,
    top,
    topCenter,
    avgDepth: depthSum / allPts.length,
    screenBounds: { minX, minY, maxX, maxY }
  };
}

/**
 * Ray-casting point-in-polygon check on 2D screen coordinates for selecting 3D prisms.
 */
export function pointInPolygon2D(px, py, pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
