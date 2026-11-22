import { VOXEL_STEP } from '../../../shared/constants.mjs';

const METERS_PER_DEG_LAT = 111320;
const MAX_COLUMNS_PER_SCULPTURE = 180;

function metersPerDegLngAtLat(lat) {
  return METERS_PER_DEG_LAT * Math.max(0.08, Math.cos((Number(lat) * Math.PI) / 180));
}

function makeRotatedRectRing({ centerLat, centerLng, eastM, northM, halfW, halfD, yawRad }) {
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  const mPerDegLng = metersPerDegLngAtLat(centerLat);

  const localPts = [
    [eastM - halfW, northM + halfD],
    [eastM + halfW, northM + halfD],
    [eastM + halfW, northM - halfD],
    [eastM - halfW, northM - halfD]
  ];

  const coords = localPts.map(([x, y]) => {
    const rx = x * cosY + y * sinY;
    const ry = -x * sinY + y * cosY;
    return [
      Number((centerLng + rx / mPerDegLng).toFixed(7)),
      Number((centerLat + ry / METERS_PER_DEG_LAT).toFixed(7))
    ];
  });
  coords.push(coords[0]);
  return coords;
}

function buildCustomModelMonolithFeatures(sc, isSelected, parcelVolume = null) {
  const lat = Number(sc.lat);
  const lng = Number(sc.lng);
  const scale = Math.max(0.5, Math.min(2.5, Number(sc.customModel?.scale || 1)));
  const off = sc.anchorOffset || {};
  const dx = Number(off.dx || 0);
  const dy = Math.max(0, Number(off.dy || 0));
  const dz = Number(off.dz || 0);
  const yawRad = -Number(off.yaw || 0) - Number(sc.customModel?.rotationY || 0);

  // Respect parcel inner 10%-padded dimensions when a parcel volume is present
  const hasVol =
    parcelVolume &&
    Number.isFinite(Number(parcelVolume.widthMeters)) &&
    Number.isFinite(Number(parcelVolume.depthMeters)) &&
    Number.isFinite(Number(parcelVolume.heightMeters));

  const baseAlt = hasVol ? Math.max(0, Number(parcelVolume.baseAltitudeM || 0)) : 0;
  let maxHalfW = 2.2 * scale;
  let maxHalfD = 2.2 * scale;
  let totalH = 6.8 * scale;
  let baseLift = baseAlt + dy;

  if (hasVol) {
    const innerW = Number(parcelVolume.widthMeters) / 1.2;
    const innerD = Number(parcelVolume.depthMeters) / 1.2;
    const innerH = Number(parcelVolume.heightMeters) / 1.2;
    maxHalfW = Math.min(maxHalfW, Math.max(0.2, innerW / 2));
    maxHalfD = Math.min(maxHalfD, Math.max(0.2, innerD / 2));
    totalH = Math.min(totalH, Math.max(0.4, innerH));
    if (Number(parcelVolume.heightMeters) <= totalH * 1.45) {
      baseLift = baseAlt + Math.max(0, (Number(parcelVolume.heightMeters) - totalH) / 2);
    }
  }

  const tiers = [
    {
      halfW: maxHalfW,
      halfD: maxHalfD,
      base: baseLift,
      height: baseLift + totalH * 0.14,
      color: isSelected ? '#ffd166' : '#2b3a55'
    },
    {
      halfW: maxHalfW * 0.72,
      halfD: maxHalfD * 0.72,
      base: baseLift + totalH * 0.14,
      height: baseLift + totalH * 0.72,
      color: isSelected ? '#ffea80' : '#00f5d4'
    },
    {
      halfW: maxHalfW * 0.45,
      halfD: maxHalfD * 0.45,
      base: baseLift + totalH * 0.72,
      height: baseLift + totalH,
      color: isSelected ? '#ffffff' : '#ff3e7f'
    }
  ];

  return tiers.map((t, idx) => ({
    type: 'Feature',
    properties: {
      sculptureId: sc.id,
      title: sc.title || '3D Model',
      parcelId: sc.parcelId || '',
      color: t.color,
      baseMeters: Number(t.base.toFixed(2)),
      heightMeters: Number(t.height.toFixed(2)),
      isSelected: isSelected ? 1 : 0,
      part: idx
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        makeRotatedRectRing({
          centerLat: lat,
          centerLng: lng,
          eastM: dx,
          northM: -dz,
          halfW: t.halfW,
          halfD: t.halfD,
          yawRad
        })
      ]
    }
  }));
}

function buildVoxelSculptureFeatures(sc, isSelected, parcelVolume = null) {
  const lat = Number(sc.lat);
  const lng = Number(sc.lng);
  const rawVoxels = Array.isArray(sc.voxels) ? sc.voxels : [];
  if (rawVoxels.length === 0) return buildCustomModelMonolithFeatures(sc, isSelected, parcelVolume);

  const off = sc.anchorOffset || {};
  const dx = Number(off.dx || 0);
  const dy = Math.max(0, Number(off.dy || 0));
  const dz = Number(off.dz || 0);
  const yawRad = -Number(off.yaw || 0);

  const step = VOXEL_STEP || 0.05;
  let minGx = Infinity;
  let maxGx = -Infinity;
  let minGy = Infinity;
  let maxGy = -Infinity;
  let minGz = Infinity;
  let maxGz = -Infinity;

  const pts = [];
  for (const v of rawVoxels) {
    const gx = Math.round(Number(v?.x || 0) / step);
    const gy = Math.round(Number(v?.y || 0) / step);
    const gz = Math.round(Number(v?.z || 0) / step);
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) continue;
    if (gx < minGx) minGx = gx;
    if (gx > maxGx) maxGx = gx;
    if (gy < minGy) minGy = gy;
    if (gy > maxGy) maxGy = gy;
    if (gz < minGz) minGz = gz;
    if (gz > maxGz) maxGz = gz;
    pts.push({
      gx,
      gy,
      gz,
      color: typeof v?.color === 'string' && v.color ? v.color : '#00f5d4'
    });
  }

  if (pts.length === 0) return buildCustomModelMonolithFeatures(sc, isSelected, parcelVolume);

  const spanX = Math.max(1, maxGx - minGx + 1);
  const spanY = Math.max(1, maxGy - minGy + 1);
  const spanZ = Math.max(1, maxGz - minGz + 1);
  const centerGx = (minGx + maxGx) / 2;
  const centerGz = (minGz + maxGz) / 2;

  // Architectural display scale, strictly bounded inside the parcel's inner 10%-padded volume
  let stride = 1;
  let unitMeters = Math.max(0.45, Math.min(1.5, 7.2 / Math.max(spanX, spanZ, 4)));

  const hasVol =
    parcelVolume &&
    Number.isFinite(Number(parcelVolume.widthMeters)) &&
    Number.isFinite(Number(parcelVolume.depthMeters)) &&
    Number.isFinite(Number(parcelVolume.heightMeters));

  const baseAlt = hasVol ? Math.max(0, Number(parcelVolume.baseAltitudeM || 0)) : 0;
  let innerW = Infinity;
  let innerD = Infinity;
  let innerH = Infinity;

  if (hasVol) {
    innerW = Number(parcelVolume.widthMeters) / 1.2;
    innerD = Number(parcelVolume.depthMeters) / 1.2;
    innerH = Number(parcelVolume.heightMeters) / 1.2;
    const maxFitUnit = Math.min(innerW / spanX, innerD / spanZ, innerH / spanY);
    if (Number.isFinite(maxFitUnit) && maxFitUnit > 0) {
      unitMeters = Math.min(unitMeters, maxFitUnit);
    }
  }

  const groupColumns = (gridStride) => {
    const colMap = new Map();
    for (const p of pts) {
      const cx = Math.floor((p.gx - minGx) / gridStride) * gridStride + minGx;
      const cz = Math.floor((p.gz - minGz) / gridStride) * gridStride + minGz;
      const cy = Math.floor((p.gy - minGy) / gridStride) * gridStride;
      const key = `${cx},${cz}`;
      let list = colMap.get(key);
      if (!list) {
        list = new Map();
        colMap.set(key, list);
      }
      list.set(cy, p.color);
    }
    return colMap;
  };

  let colMap = groupColumns(1);
  if (colMap.size > MAX_COLUMNS_PER_SCULPTURE) {
    stride = Math.ceil(Math.sqrt(colMap.size / MAX_COLUMNS_PER_SCULPTURE));
    colMap = groupColumns(stride);
  }

  const blockW = unitMeters * stride;
  const blockH = unitMeters * stride;
  const half = blockW * 0.48;
  const features = [];

  const renderedW = spanX * unitMeters;
  const renderedD = spanZ * unitMeters;
  const renderedH = spanY * unitMeters;

  // Vertical placement: for object-fitted parcels, center vertically inside the 10%-padded height;
  // for large manually-claimed parcels, rest cleanly on a thin pedestal at ground level.
  const isObjectFittedParcel =
    hasVol && Number(parcelVolume.heightMeters) <= renderedH * 1.45;
  const pedestalH = isObjectFittedParcel
    ? Math.min(0.05, Math.max(0.02, ((Number(parcelVolume.heightMeters) - renderedH) / 2) * 0.35))
    : Math.min(0.35, hasVol ? Number(parcelVolume.heightMeters) * 0.04 : 0.35);
  const voxelBaseElevation = isObjectFittedParcel
    ? baseAlt + Math.max(pedestalH, (Number(parcelVolume.heightMeters) - renderedH) / 2)
    : baseAlt + dy + pedestalH;

  // Subtle base pad strictly within the parcel's inner 10%-padded footprint
  const pedestalHalfW = Math.min(
    hasVol ? Math.max(0.15, innerW / 2) : 6.2,
    Math.max(0.25, renderedW / 2 + (isObjectFittedParcel ? 0 : 0.4))
  );
  const pedestalHalfD = Math.min(
    hasVol ? Math.max(0.15, innerD / 2) : 6.2,
    Math.max(0.25, renderedD / 2 + (isObjectFittedParcel ? 0 : 0.4))
  );

  features.push({
    type: 'Feature',
    properties: {
      sculptureId: sc.id,
      title: sc.title || '3D Sculpture',
      parcelId: sc.parcelId || '',
      color: isSelected ? '#ffd166' : '#19263d',
      baseMeters: Number((baseAlt + (isObjectFittedParcel ? 0 : dy)).toFixed(3)),
      heightMeters: Number((baseAlt + (isObjectFittedParcel ? 0 : dy) + pedestalH).toFixed(3)),
      isSelected: isSelected ? 1 : 0,
      part: 'pedestal'
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        makeRotatedRectRing({
          centerLat: lat,
          centerLng: lng,
          eastM: dx,
          northM: -dz,
          halfW: pedestalHalfW,
          halfD: pedestalHalfD,
          yawRad
        })
      ]
    }
  });

  for (const [key, yMap] of colMap.entries()) {
    const [cxStr, czStr] = key.split(',');
    const cx = Number(cxStr);
    const cz = Number(czStr);
    const ys = Array.from(yMap.keys()).sort((a, b) => a - b);

    // Merge contiguous vertical blocks of identical color into single extrusions
    let runStart = ys[0];
    let runEnd = ys[0];
    let runColor = yMap.get(ys[0]);

    const flushRun = () => {
      const eastM = dx + (cx - centerGx) * unitMeters;
      const northM = -dz - (cz - centerGz) * unitMeters;
      const baseM = voxelBaseElevation + (runStart / stride) * blockH;
      const topM = voxelBaseElevation + (runEnd / stride + 1) * blockH;
      features.push({
        type: 'Feature',
        properties: {
          sculptureId: sc.id,
          title: sc.title || '3D Sculpture',
          parcelId: sc.parcelId || '',
          color: runColor,
          baseMeters: Number(baseM.toFixed(3)),
          heightMeters: Number(topM.toFixed(3)),
          isSelected: isSelected ? 1 : 0,
          part: 'voxel'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            makeRotatedRectRing({
              centerLat: lat,
              centerLng: lng,
              eastM,
              northM,
              halfW: half,
              halfD: half,
              yawRad
            })
          ]
        }
      });
    };

    for (let i = 1; i < ys.length; i += 1) {
      const y = ys[i];
      const col = yMap.get(y);
      if (y === runEnd + stride && col === runColor) {
        runEnd = y;
      } else {
        flushRun();
        runStart = y;
        runEnd = y;
        runColor = col;
      }
    }
    flushRun();
  }

  return features;
}

/**
 * Converts GRAFFILAND sculptures (3D voxels and custom .glb/.gltf/.obj/.stl/.ply models)
 * into a MapLibre GeoJSON FeatureCollection for native depth-buffered 3D rendering on Desktop & Mobile 3D maps.
 */
export function buildSculptures3DGeoJson(sculptures = [], selectedSculptureId = '', parcels = []) {
  const features = [];
  let renderedCount = 0;

  const parcelVolumeById = new Map();
  for (const p of parcels || []) {
    if (p?.parcelId && p?.volume) {
      parcelVolumeById.set(String(p.parcelId).toUpperCase(), p.volume);
    }
  }

  for (const sc of sculptures || []) {
    if (!sc || sc.hidden) continue;
    const lat = Number(sc.lat);
    const lng = Number(sc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const isSelected = Boolean(selectedSculptureId && sc.id === selectedSculptureId);
    const parcelVolume = sc.parcelId
      ? parcelVolumeById.get(String(sc.parcelId).toUpperCase()) || null
      : null;
    const scFeatures =
      sc.modelType === 'custom-3d' || !Array.isArray(sc.voxels) || sc.voxels.length === 0
        ? buildCustomModelMonolithFeatures(sc, isSelected, parcelVolume)
        : buildVoxelSculptureFeatures(sc, isSelected, parcelVolume);
    if (scFeatures.length > 0) {
      renderedCount += 1;
      for (const f of scFeatures) features.push(f);
    }
  }

  return {
    renderedCount,
    geojson: {
      type: 'FeatureCollection',
      features
    }
  };
}
