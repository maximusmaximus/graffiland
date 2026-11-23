/**
 * Projects a 3D [lng, lat, altitudeMeters] coordinate onto screen CSS pixel coordinates
 * matching MapLibre GL's current camera transform.
 */
export function projectLngLatAltToScreen(map, maplibregl, lng, lat, altitudeMeters = 0) {
  if (!map || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
    return { x: 0, y: 0, visible: false };
  }
  const alt = Number(altitudeMeters || 0);
  const canvas = map.getCanvas?.();
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;

  const matrix = map.transform?.mercatorMatrix;
  const MC = maplibregl?.MercatorCoordinate;

  if (matrix && MC && typeof MC.fromLngLat === 'function' && width > 0 && height > 0) {
    try {
      const mc = MC.fromLngLat([Number(lng), Number(lat)], alt);
      const x = mc.x;
      const y = mc.y;
      const z = mc.z || 0;
      const cx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      const cy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      const cw = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      if (cw > 0.0001) {
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        return {
          x: (ndcX + 1) * 0.5 * width,
          y: (1 - ndcY) * 0.5 * height,
          depth: cw,
          visible: true
        };
      }
    } catch {
      // fall through to pitch-aware map.project fallback
    }
  }

  try {
    const pt = map.project([Number(lng), Number(lat)]);
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

  if (bottom.some((p) => !p.visible) || top.some((p) => !p.visible)) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of [...bottom, ...top]) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    bottom,
    top,
    topCenter,
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
