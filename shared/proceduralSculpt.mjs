import { AREA_HALF_SPAN_METERS, VOXEL_STEP } from './constants.mjs';

const SUPPORTED_PREFABS = new Set(['plinth', 'arch', 'totem', 'pyramid', 'beacon']);

function snap(val) {
  return Math.round(Math.round(val / VOXEL_STEP) * VOXEL_STEP * 1000) / 1000;
}

function clampColor(hex, fallback = '#00f5d4') {
  return /^#[0-9a-fA-F]{6}$/.test(String(hex || '')) ? String(hex) : fallback;
}

function clampMaterial(mat, fallback = 'matte') {
  return mat === 'neon' || mat === 'glass' || mat === 'matte' ? mat : fallback;
}

/**
 * Generates deterministic, sanitized 3D voxel prefabs and optional suggested plinth slots
 * for autonomous agents and quick-sculpt stage building.
 */
export function generateVoxelPrefab({
  prefab = 'plinth',
  primaryColor = '#1c243b',
  accentColor = '#00f5d4',
  material = 'matte',
  accentMaterial = 'neon',
  widthBlocks = 5,
  heightBlocks = 5,
  offset = { dx: 0, dy: 0, dz: 0 },
  label = 'Visitor Plinth'
} = {}) {
  const kind = String(prefab || 'plinth').toLowerCase();
  if (!SUPPORTED_PREFABS.has(kind)) {
    throw new Error(
      `Unsupported prefab "${prefab}". Supported prefabs: ${Array.from(SUPPORTED_PREFABS).join(', ')}.`
    );
  }

  const baseColor = clampColor(primaryColor, '#1c243b');
  const trimColor = clampColor(accentColor, '#00f5d4');
  const baseMat = clampMaterial(material, 'matte');
  const trimMat = clampMaterial(accentMaterial, 'neon');
  const w = Math.max(3, Math.min(11, Math.round(Number(widthBlocks || 5))));
  const h = Math.max(3, Math.min(12, Math.round(Number(heightBlocks || 5))));
  const ox = Number(offset?.dx || 0);
  const oy = Number(offset?.dy || 0);
  const oz = Number(offset?.dz || 0);

  const voxelMap = new Map();
  const put = (bx, by, bz, color = baseColor, mat = baseMat) => {
    const x = snap(ox + bx * VOXEL_STEP);
    const y = snap(oy + by * VOXEL_STEP);
    const z = snap(oz + bz * VOXEL_STEP);
    if (
      Math.abs(x) > AREA_HALF_SPAN_METERS ||
      Math.abs(y) > AREA_HALF_SPAN_METERS ||
      Math.abs(z) > AREA_HALF_SPAN_METERS
    ) {
      return;
    }
    voxelMap.set(`${x}:${y}:${z}`, { x, y, z, color, material: mat, scale: 1 });
  };

  const half = Math.floor(w / 2);
  let plinthSlot = {
    id: `plinth-${kind}-1`,
    label: String(label || 'Visitor Plinth').slice(0, 48),
    dx: snap(ox),
    dy: snap(oy + h * VOXEL_STEP),
    dz: snap(oz),
    yaw: 0
  };

  if (kind === 'plinth') {
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        const edge = Math.abs(x) === half || Math.abs(z) === half;
        put(x, 0, z, edge ? trimColor : baseColor, edge ? trimMat : baseMat);
      }
    }
    const shaft = Math.max(1, half - 1);
    for (let y = 1; y < h - 1; y++) {
      for (let x = -shaft; x <= shaft; x++) {
        for (let z = -shaft; z <= shaft; z++) {
          put(x, y, z, baseColor, baseMat);
        }
      }
    }
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        const edge = Math.abs(x) === half || Math.abs(z) === half;
        put(x, h - 1, z, edge ? trimColor : baseColor, edge ? trimMat : baseMat);
      }
    }
    plinthSlot.dy = snap(oy + h * VOXEL_STEP);
  } else if (kind === 'arch') {
    for (let y = 0; y < h; y++) {
      put(-half, y, 0, baseColor, baseMat);
      put(half, y, 0, baseColor, baseMat);
      if (y === 0 || y === h - 1) {
        put(-half, y, -1, trimColor, trimMat);
        put(-half, y, 1, trimColor, trimMat);
        put(half, y, -1, trimColor, trimMat);
        put(half, y, 1, trimColor, trimMat);
      }
    }
    for (let x = -half; x <= half; x++) {
      put(x, h, 0, trimColor, trimMat);
    }
    plinthSlot.dy = snap(oy + VOXEL_STEP);
  } else if (kind === 'totem') {
    for (let y = 0; y < h; y++) {
      const isCrown = y === h - 1 || y % 3 === 1;
      for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
          if (y > 1 && Math.abs(x) === 1 && Math.abs(z) === 1) continue;
          put(x, y, z, isCrown ? trimColor : baseColor, isCrown ? trimMat : baseMat);
        }
      }
    }
    plinthSlot = {
      id: 'plinth-totem-front',
      label: String(label || 'Totem Base Slot').slice(0, 48),
      dx: snap(ox),
      dy: snap(oy),
      dz: snap(oz + (half + 2) * VOXEL_STEP),
      yaw: 0
    };
  } else if (kind === 'pyramid') {
    const levels = Math.min(half + 1, h);
    for (let y = 0; y < levels; y++) {
      const span = half - y;
      for (let x = -span; x <= span; x++) {
        for (let z = -span; z <= span; z++) {
          const apex = span === 0;
          put(x, y, z, apex ? trimColor : baseColor, apex ? trimMat : baseMat);
        }
      }
    }
    plinthSlot.dy = snap(oy + (levels - 1) * VOXEL_STEP);
  } else if (kind === 'beacon') {
    put(0, 0, 0, trimColor, trimMat);
    for (let x = -1; x <= 1; x++) {
      put(x, 0, 0, baseColor, baseMat);
      put(0, 0, x, baseColor, baseMat);
    }
    for (let y = 2; y < h; y++) {
      put(0, y, 0, trimColor, 'neon');
      if (y === Math.floor(h / 2) + 1) {
        put(-1, y, 0, trimColor, 'glass');
        put(1, y, 0, trimColor, 'glass');
        put(0, y, -1, trimColor, 'glass');
        put(0, y, 1, trimColor, 'glass');
      }
    }
    plinthSlot.dy = snap(oy + VOXEL_STEP);
  }

  return {
    prefab: kind,
    voxels: Array.from(voxelMap.values()),
    suggestedPlinthSlot: plinthSlot
  };
}

/**
 * Validates optional target lat/lng against the claimed Virtual Land geohash cell boundary (+25m grace).
 */
export function validateSceneWithinParcel({ lat, lng, parcelBounds }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !parcelBounds?.sw || !parcelBounds?.ne) {
    return { valid: true };
  }
  const padDeg = 0.00025; // ~27m border margin around 38m parcel cell
  const inLat = lat >= parcelBounds.sw[0] - padDeg && lat <= parcelBounds.ne[0] + padDeg;
  const inLng = lng >= parcelBounds.sw[1] - padDeg && lng <= parcelBounds.ne[1] + padDeg;
  if (!inLat || !inLng) {
    return {
      valid: false,
      error: `Coordinates (${lat}, ${lng}) lie outside claimed parcel boundary.`
    };
  }
  return { valid: true };
}
