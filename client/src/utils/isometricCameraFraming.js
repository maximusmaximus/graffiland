/**
 * Pure isometric camera framing math for 3D sculpture previews and land bounds views.
 * Produces a consistent 3/4 isometric angle (45° azimuth, 35.264° classic isometric elevation)
 * tightly zoomed to fit the model's 3D bounding box without clipping corners across any aspect ratio.
 */

export const ISOMETRIC_AZIMUTH_DEG = 45;
export const ISOMETRIC_ELEVATION_DEG = 35.264;
export const ISOMETRIC_PREVIEW_FOV_DEG = 36;

function clampPositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Computes camera position, orbit target, clipping planes, and studio plinth sizing
 * for a zoomed-in, well-placed isometric 3/4 view of a 3D model.
 */
export function computeIsometricModelFraming({
  width = 1.4,
  height = 1.4,
  depth = 1.4,
  centerX = 0,
  centerY = null,
  centerZ = 0,
  minY = 0,
  fovDeg = ISOMETRIC_PREVIEW_FOV_DEG,
  aspect = 1.6,
  fillRatio = 0.74,
  azimuthDeg = ISOMETRIC_AZIMUTH_DEG,
  elevationDeg = ISOMETRIC_ELEVATION_DEG
} = {}) {
  const w = clampPositive(width, 1.4);
  const h = clampPositive(height, 1.4);
  const d = clampPositive(depth, 1.4);
  const safeAspect = Math.max(0.55, clampPositive(aspect, 1.6));
  const safeFov = Math.max(20, Math.min(75, clampPositive(fovDeg, ISOMETRIC_PREVIEW_FOV_DEG)));
  const safeFill = Math.max(0.45, Math.min(0.88, clampPositive(fillRatio, 0.74)));

  const cx = Number.isFinite(Number(centerX)) ? Number(centerX) : 0;
  const cz = Number.isFinite(Number(centerZ)) ? Number(centerZ) : 0;
  const baseMinY = Number.isFinite(Number(minY)) ? Number(minY) : 0;
  // Aim slightly below exact vertical center so the model sits grounded with comfortable headroom
  const cy =
    centerY !== null && centerY !== undefined && Number.isFinite(Number(centerY))
      ? Number(centerY)
      : baseMinY + h * 0.48;

  const az = (Number(azimuthDeg) * Math.PI) / 180;
  const el = (Number(elevationDeg) * Math.PI) / 180;
  const cosEl = Math.cos(el);
  const sinEl = Math.sin(el);
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);

  // Unit vectors for camera view (target -> camera), screen right, and screen up
  const vx = cosEl * sinAz;
  const vy = sinEl;
  const vz = cosEl * cosAz;

  const rx = cosAz;
  const rz = -sinAz;

  const ux = -sinEl * sinAz;
  const uy = cosEl;
  const uz = -sinEl * cosAz;

  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;

  // Exact projected half-extents of the bounding box onto camera screen X, screen Y, and view depth
  const projHalfW = hw * Math.abs(rx) + hd * Math.abs(rz);
  const projHalfH = hw * Math.abs(ux) + hh * Math.abs(uy) + hd * Math.abs(uz);
  const projHalfDepth = hw * Math.abs(vx) + hh * Math.abs(vy) + hd * Math.abs(vz);

  const vFovRad = (safeFov * Math.PI) / 180;
  const tanHalfV = Math.tan(vFovRad / 2);
  const tanHalfH = tanHalfV * safeAspect;

  const distV = projHalfH / (tanHalfV * safeFill);
  const distH = projHalfW / (tanHalfH * safeFill);
  const distance = Math.max(0.65, Math.max(distV, distH) + projHalfDepth * 0.92);

  const position = [cx + vx * distance, cy + vy * distance, cz + vz * distance];
  const target = [cx, cy, cz];

  const maxSpan = Math.max(w, h, d, 0.5);
  const footprintSpan = Math.max(w, d, 0.8);

  return {
    fov: safeFov,
    distance,
    position,
    target,
    azimuthDeg: Number(azimuthDeg),
    elevationDeg: Number(elevationDeg),
    near: Math.max(0.02, Math.min(0.5, distance * 0.01)),
    far: Math.max(400, distance * 22),
    groundY: baseMinY - 0.012,
    gridScale: Math.max(0.65, (footprintSpan * 2.2) / 6),
    shadowScale: Math.max(0.65, (footprintSpan * 2.6) / 8),
    lightSpan: Math.max(3.5, maxSpan * 1.9)
  };
}

/**
 * Computes a clean isometric camera framing for a full land parcel volume,
 * centered gracefully around the parcel (with gentle bias toward the placed sculpture).
 */
export function computeIsometricLandFraming({
  volW = 10,
  volH = 10,
  volD = 10,
  modelHeight = 1.4,
  fovDeg = 46,
  aspect = 1.6
} = {}) {
  const w = clampPositive(volW, 10);
  const h = clampPositive(volH, 10);
  const d = clampPositive(volD, 10);
  const mh = clampPositive(modelHeight, 1.4);
  const focusY = Math.min(h * 0.34, Math.max(1.0, mh * 0.72));

  return computeIsometricModelFraming({
    width: w,
    height: Math.max(h * 0.72, mh * 1.4),
    depth: d,
    centerX: 0,
    centerY: focusY,
    centerZ: 0,
    minY: 0,
    fovDeg,
    aspect,
    fillRatio: 0.72,
    azimuthDeg: ISOMETRIC_AZIMUTH_DEG,
    elevationDeg: 32
  });
}
