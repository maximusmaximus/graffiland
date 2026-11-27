import { VOXEL_STEP } from './constants.mjs';

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
 * Generates a glTF 2.0 binary (.glb) buffer directly from SPRAY.LAND voxels.
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
      generator: 'SPRAY.LAND-GLB-Exporter/1.0',
      ...(meta.copyright ? { copyright: String(meta.copyright) } : {})
    },
    scene: 0,
    scenes: [{ name: String(meta.title || 'SPRAY.LAND Sculpture'), nodes: [0] }],
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

/**
 * Generates a self-contained glTF 2.0 binary (.glb) for a 3D embossed Xero Emoji from PNG bytes.
 * Pure JS / TypedArray implementation compatible with Node.js, Cloudflare Workers, and Browsers.
 *
 * Geometry: 1.0m × 1.0m × 0.12m resting flush on y = 0 (y in [0, 1], x in [-0.5, 0.5], z in [-0.06, 0.06]),
 * built from bright front/back emoji artwork faces plus 6 shaded interior alpha-masked slices so the
 * silhouette reads with authentic 3D extruded depth from every angle.
 */
export function buildEmojiGlbFromPngBytes(pngBytes, meta = {}) {
  const imgBytes =
    pngBytes instanceof Uint8Array
      ? pngBytes
      : ArrayBuffer.isView(pngBytes)
      ? new Uint8Array(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength)
      : pngBytes instanceof ArrayBuffer
      ? new Uint8Array(pngBytes)
      : null;
  if (!imgBytes || imgBytes.byteLength < 8) {
    throw new Error('Valid PNG image bytes are required to build a 3D emoji GLB.');
  }

  const size = Number.isFinite(Number(meta.sizeMeters)) && Number(meta.sizeMeters) > 0
    ? Number(meta.sizeMeters)
    : 1.0;
  const thick = Number.isFinite(Number(meta.thicknessMeters)) && Number(meta.thicknessMeters) > 0
    ? Number(meta.thicknessMeters)
    : size * 0.12;
  const halfW = size / 2;
  const halfT = thick / 2;

  // Build front (+Z), back (-Z, U-flipped), and 6 interior depth-extrusion slices
  const buildQuadMeshData = (planes) => {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let vOff = 0;

    for (const p of planes) {
      const z = p.z;
      const flipU = Boolean(p.flipU);
      const uL = flipU ? 1 : 0;
      const uR = flipU ? 0 : 1;
      // glTF UV origin is top-left (v=0 top, v=1 bottom)
      if (p.normalZ >= 0) {
        positions.push(
          -halfW, 0, z,
          halfW, 0, z,
          halfW, size, z,
          -halfW, size, z
        );
        normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
        uvs.push(uL, 1, uR, 1, uR, 0, uL, 0);
      } else {
        positions.push(
          halfW, 0, z,
          -halfW, 0, z,
          -halfW, size, z,
          halfW, size, z
        );
        normals.push(0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1);
        uvs.push(uL, 1, uR, 1, uR, 0, uL, 0);
      }
      indices.push(vOff, vOff + 1, vOff + 2, vOff, vOff + 2, vOff + 3);
      vOff += 4;
    }

    return {
      pos: new Float32Array(positions),
      norm: new Float32Array(normals),
      uv: new Float32Array(uvs),
      idx: new Uint16Array(indices)
    };
  };

  const faceData = buildQuadMeshData([
    { z: halfT, normalZ: 1, flipU: false },
    { z: -halfT, normalZ: -1, flipU: false }
  ]);

  const sliceCount = 6;
  const slicePlanes = [];
  for (let i = 1; i <= sliceCount; i += 1) {
    const t = i / (sliceCount + 1);
    const z = -halfT + t * thick;
    slicePlanes.push({ z, normalZ: 1, flipU: false });
  }
  const sliceData = buildQuadMeshData(slicePlanes);

  const bufferViews = [];
  const accessors = [];
  const binChunks = [];
  let byteOffset = 0;

  const pushChunk = (u8, target = undefined) => {
    const start = byteOffset;
    const padded = align4(u8.byteLength);
    if (padded === u8.byteLength) {
      binChunks.push(u8);
    } else {
      const copy = new Uint8Array(padded);
      copy.set(u8);
      binChunks.push(copy);
    }
    byteOffset += padded;
    const bv = { buffer: 0, byteOffset: start, byteLength: u8.byteLength };
    if (target) bv.target = target;
    bufferViews.push(bv);
    return bufferViews.length - 1;
  };

  const pushPrimitive = (data, materialIndex) => {
    const posBv = pushChunk(
      new Uint8Array(data.pos.buffer, data.pos.byteOffset, data.pos.byteLength),
      34962
    );
    const normBv = pushChunk(
      new Uint8Array(data.norm.buffer, data.norm.byteOffset, data.norm.byteLength),
      34962
    );
    const uvBv = pushChunk(
      new Uint8Array(data.uv.buffer, data.uv.byteOffset, data.uv.byteLength),
      34962
    );
    const idxBv = pushChunk(
      new Uint8Array(data.idx.buffer, data.idx.byteOffset, data.idx.byteLength),
      34963
    );

    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < data.pos.length; i += 3) {
      if (data.pos[i] < minZ) minZ = data.pos[i];
      if (data.pos[i] > maxZ) maxZ = data.pos[i];
    }

    const posAcc = accessors.length;
    accessors.push({
      bufferView: posBv,
      componentType: 5126,
      count: data.pos.length / 3,
      type: 'VEC3',
      min: [-halfW, 0, minZ],
      max: [halfW, size, maxZ]
    });
    const normAcc = accessors.length;
    accessors.push({
      bufferView: normBv,
      componentType: 5126,
      count: data.norm.length / 3,
      type: 'VEC3'
    });
    const uvAcc = accessors.length;
    accessors.push({
      bufferView: uvBv,
      componentType: 5126,
      count: data.uv.length / 2,
      type: 'VEC2'
    });
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: idxBv,
      componentType: 5123,
      count: data.idx.length,
      type: 'SCALAR'
    });

    return {
      attributes: {
        POSITION: posAcc,
        NORMAL: normAcc,
        TEXCOORD_0: uvAcc
      },
      indices: idxAcc,
      material: materialIndex
    };
  };

  const primitives = [pushPrimitive(faceData, 0), pushPrimitive(sliceData, 1)];
  const imageBv = pushChunk(imgBytes);

  const label = String(meta.title || meta.name || meta.emojiId || 'Xero Emoji').slice(0, 64);
  const gltf = {
    asset: {
      version: '2.0',
      generator: 'SPRAY.LAND 3D Emoji GLB Exporter'
    },
    scene: 0,
    scenes: [{ name: label, nodes: [0] }],
    nodes: [
      {
        name: label,
        mesh: 0,
        extras: {
          schema: 'graffiland.xeroemoji.glb.v1',
          emojiId: meta.emojiId || null,
          source: 'maximusmaximus/xeroemoji-pile'
        }
      }
    ],
    meshes: [
      {
        name: 'XeroEmoji3D',
        primitives
      }
    ],
    samplers: [
      {
        magFilter: 9729,
        minFilter: 9987,
        wrapS: 33071,
        wrapT: 33071
      }
    ],
    images: [
      {
        bufferView: imageBv,
        mimeType: 'image/png'
      }
    ],
    textures: [{ sampler: 0, source: 0 }],
    materials: [
      {
        name: 'EmojiFaces',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0.08,
          roughnessFactor: 0.38
        },
        alphaMode: 'MASK',
        alphaCutoff: 0.25,
        doubleSided: false
      },
      {
        name: 'EmojiExtrudeCore',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: [0.76, 0.76, 0.82, 1],
          metallicFactor: 0.14,
          roughnessFactor: 0.45
        },
        alphaMode: 'MASK',
        alphaCutoff: 0.35,
        doubleSided: true
      }
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }]
  };

  const jsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPaddedLen = align4(jsonRaw.byteLength);
  const totalLen = 12 + 8 + jsonPaddedLen + 8 + byteOffset;

  const glb = new Uint8Array(totalLen);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);

  dv.setUint32(12, jsonPaddedLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonRaw, 20);
  for (let i = jsonRaw.byteLength; i < jsonPaddedLen; i += 1) {
    glb[20 + i] = 0x20;
  }

  const binHeaderOffset = 20 + jsonPaddedLen;
  dv.setUint32(binHeaderOffset, byteOffset, true);
  dv.setUint32(binHeaderOffset + 4, 0x004e4942, true);
  let writeCursor = binHeaderOffset + 8;
  for (const chunk of binChunks) {
    glb.set(chunk, writeCursor);
    writeCursor += chunk.byteLength;
  }
  return glb;
}
