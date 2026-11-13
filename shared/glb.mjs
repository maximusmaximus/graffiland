const VOXEL_STEP = 0.2;
const BASE_HALF = (VOXEL_STEP * 0.96) / 2;

// 6 faces of a cube, CCW outer winding, 4 vertices each -> 24 vertices, 36 indices
const CUBE_FACES = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] }
];

function srgbChannelToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToLinearRgb(hex = '#00f5d4') {
  const clean = String(hex || '#00f5d4').trim().replace(/^#/, '');
  const expanded =
    clean.length === 3
      ? `${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`
      : clean.padEnd(6, '0').slice(0, 6);
  const num = Number.parseInt(expanded, 16);
  const r = Number.isFinite(num) ? ((num >> 16) & 0xff) / 255 : 0;
  const g = Number.isFinite(num) ? ((num >> 8) & 0xff) / 255 : 0.96;
  const b = Number.isFinite(num) ? (num & 0xff) / 255 : 0.83;
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}

function createMaterialSpec(colorHex, materialKind) {
  const [r, g, b] = hexToLinearRgb(colorHex);
  if (materialKind === 'neon') {
    return {
      name: `neon_${colorHex}`,
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: 0.35,
        roughnessFactor: 0.16
      },
      emissiveFactor: [r * 0.85, g * 0.85, b * 0.85]
    };
  }
  if (materialKind === 'glass') {
    return {
      name: `glass_${colorHex}`,
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 0.72],
        metallicFactor: 0.1,
        roughnessFactor: 0.06
      },
      alphaMode: 'BLEND',
      doubleSided: false
    };
  }
  return {
    name: `matte_${colorHex}`,
    pbrMetallicRoughness: {
      baseColorFactor: [r, g, b, 1],
      metallicFactor: 0.24,
      roughnessFactor: 0.35
    }
  };
}

function align4(n) {
  return (n + 3) & ~3;
}

/**
 * Generates a glTF 2.0 binary (.glb) buffer directly from GRAFFILAND voxels.
 * Pure JS / TypedArray implementation compatible with both Node.js and Cloudflare Workers.
 */
export function buildSculptureGlb(voxels = [], meta = {}) {
  const list = Array.isArray(voxels) && voxels.length > 0
    ? voxels
    : [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte', scale: 1 }];

  // Center the mesh bounds around (0, 0, 0) so marketplace viewers frame it cleanly
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const v of list) {
    const x = Number(v.x || 0);
    const y = Number(v.y || 0);
    const z = Number(v.z || 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  // Group voxels by material + color to minimize draw calls / primitives
  const groups = new Map();
  for (const v of list) {
    const color = String(v.color || '#00f5d4').toLowerCase();
    const material = v.material === 'neon' || v.material === 'glass' ? v.material : 'matte';
    const key = `${color}|${material}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { color, material, items: [] };
      groups.set(key, entry);
    }
    entry.items.push(v);
  }

  const materials = [];
  const primitives = [];
  const accessors = [];
  const bufferViews = [];
  const binChunks = [];
  let byteOffset = 0;

  const pushBinChunk = (typedArray) => {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const viewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength
    });
    binChunks.push(bytes);
    const padded = align4(bytes.byteLength);
    if (padded > bytes.byteLength) {
      binChunks.push(new Uint8Array(padded - bytes.byteLength));
    }
    byteOffset += padded;
    return viewIndex;
  };

  for (const group of groups.values()) {
    const matIndex = materials.length;
    materials.push(createMaterialSpec(group.color, group.material));

    const vCount = group.items.length * 24;
    const iCount = group.items.length * 36;
    const positions = new Float32Array(vCount * 3);
    const normals = new Float32Array(vCount * 3);
    const useUint32 = vCount > 65535;
    const indices = useUint32 ? new Uint32Array(iCount) : new Uint16Array(iCount);

    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMinZ = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;
    let pMaxZ = -Infinity;

    let vCursor = 0;
    let iCursor = 0;

    for (const v of group.items) {
      const vx = Number(v.x || 0) - cx;
      const vy = Number(v.y || 0) - cy;
      const vz = Number(v.z || 0) - cz;
      const half = BASE_HALF * Math.max(0.25, Math.min(3, Number(v.scale ?? 1)));

      for (const face of CUBE_FACES) {
        const baseVertex = vCursor;
        for (const [ox, oy, oz] of face.corners) {
          const px = vx + ox * half;
          const py = vy + oy * half;
          const pz = vz + oz * half;
          positions[vCursor * 3] = px;
          positions[vCursor * 3 + 1] = py;
          positions[vCursor * 3 + 2] = pz;
          normals[vCursor * 3] = face.normal[0];
          normals[vCursor * 3 + 1] = face.normal[1];
          normals[vCursor * 3 + 2] = face.normal[2];
          if (px < pMinX) pMinX = px;
          if (py < pMinY) pMinY = py;
          if (pz < pMinZ) pMinZ = pz;
          if (px > pMaxX) pMaxX = px;
          if (py > pMaxY) pMaxY = py;
          if (pz > pMaxZ) pMaxZ = pz;
          vCursor++;
        }
        indices[iCursor++] = baseVertex;
        indices[iCursor++] = baseVertex + 1;
        indices[iCursor++] = baseVertex + 2;
        indices[iCursor++] = baseVertex;
        indices[iCursor++] = baseVertex + 2;
        indices[iCursor++] = baseVertex + 3;
      }
    }

    const posView = pushBinChunk(positions);
    bufferViews[posView].target = 34962; // ARRAY_BUFFER
    const normView = pushBinChunk(normals);
    bufferViews[normView].target = 34962;
    const idxView = pushBinChunk(indices);
    bufferViews[idxView].target = 34963; // ELEMENT_ARRAY_BUFFER

    const posAcc = accessors.length;
    accessors.push({
      bufferView: posView,
      componentType: 5126, // FLOAT
      count: vCount,
      type: 'VEC3',
      min: [pMinX, pMinY, pMinZ],
      max: [pMaxX, pMaxY, pMaxZ]
    });

    const normAcc = accessors.length;
    accessors.push({
      bufferView: normView,
      componentType: 5126, // FLOAT
      count: vCount,
      type: 'VEC3'
    });

    const idxAcc = accessors.length;
    accessors.push({
      bufferView: idxView,
      componentType: useUint32 ? 5125 : 5123, // UNSIGNED_INT : UNSIGNED_SHORT
      count: iCount,
      type: 'SCALAR'
    });

    primitives.push({
      attributes: {
        POSITION: posAcc,
        NORMAL: normAcc
      },
      indices: idxAcc,
      material: matIndex
    });
  }

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'GRAFFILAND-GLB-Exporter/1.0',
      ...(meta.copyright ? { copyright: String(meta.copyright) } : {})
    },
    scene: 0,
    scenes: [{ name: String(meta.title || 'GRAFFILAND Sculpture'), nodes: [0] }],
    nodes: [
      {
        name: String(meta.title || 'SculptureRoot'),
        mesh: 0,
        extras: {
          schema: 'graffiland.glb.v1',
          sculptureId: meta.id || null,
          parcelId: meta.parcelId || null,
          geohash: meta.geohash || null,
          voxelCount: list.length
        }
      }
    ],
    meshes: [
      {
        name: 'VoxelSculpture',
        primitives
      }
    ],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }]
  };

  const jsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPaddedLen = align4(jsonRaw.byteLength);
  const totalLen = 12 + 8 + jsonPaddedLen + 8 + byteOffset;

  const glb = new Uint8Array(totalLen);
  const dv = new DataView(glb.buffer);

  // Header
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true); // version 2
  dv.setUint32(8, totalLen, true);

  // Chunk 0: JSON
  dv.setUint32(12, jsonPaddedLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonRaw, 20);
  for (let i = jsonRaw.byteLength; i < jsonPaddedLen; i++) {
    glb[20 + i] = 0x20;
  }

  // Chunk 1: BIN
  const binHeaderOffset = 20 + jsonPaddedLen;
  dv.setUint32(binHeaderOffset, byteOffset, true);
  dv.setUint32(binHeaderOffset + 4, 0x004e4942, true); // 'BIN\0'
  let writeCursor = binHeaderOffset + 8;
  for (const chunk of binChunks) {
    glb.set(chunk, writeCursor);
    writeCursor += chunk.byteLength;
  }

  return glb;
}
