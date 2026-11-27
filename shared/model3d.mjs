import {
  buildCatalogEmojiGlb,
  extractCatalogEmojiId,
  resolveCatalogItemReference
} from './catalogSearchService.mjs';

export const CUSTOM_MODEL_MAX_BYTES = 4 * 1024 * 1024;
export const INLINE_MODEL_DB_MAX_BYTES = 180 * 1024;
export const MAX_CUSTOM_MODEL_TRIANGLES = 150000;
export const MAX_CUSTOM_MODEL_TEXTURES = 8;

export const SUPPORTED_3D_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'ply'];

export const FORMAT_MIME_TYPES = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
  ply: 'application/x-ply'
};

export function modelBytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToModelBytes(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function inferFormatFromHint(rawFormat = '', urlOrName = '', mime = '') {
  const f = String(rawFormat || '').trim().toLowerCase().replace(/^\./, '');
  if (SUPPORTED_3D_FORMATS.includes(f)) return f;

  const m = String(mime || '').toLowerCase();
  if (m.includes('gltf-binary')) return 'glb';
  if (m.includes('gltf+json')) return 'gltf';
  if (m.includes('obj')) return 'obj';
  if (m.includes('stl')) return 'stl';
  if (m.includes('ply')) return 'ply';

  const cleanUrl = String(urlOrName || '').split('?')[0].split('#')[0].toLowerCase();
  for (const ext of SUPPORTED_3D_FORMATS) {
    if (cleanUrl.endsWith(`.${ext}`)) return ext;
  }
  return '';
}

export function validateModelBytesByFormat(format, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return '3D model payload is empty.';
  }
  if (bytes.length > CUSTOM_MODEL_MAX_BYTES) {
    return `3D model exceeds ${Math.round(CUSTOM_MODEL_MAX_BYTES / (1024 * 1024))} MB maximum size.`;
  }

  if (format === 'glb') {
    if (bytes.length < 20) return 'Invalid GLB binary header.';
    // 'glTF' magic in little-endian: 0x46546C67 -> bytes [0x67, 0x6C, 0x54, 0x46]
    if (bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) {
      return 'Invalid GLB file: missing glTF binary magic header.';
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(4, true);
    if (version !== 2) return `Unsupported GLB version ${version}; expected glTF 2.0.`;
    return null;
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  if (format === 'gltf') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 'Invalid glTF JSON structure.';
    }
    if (!parsed?.asset?.version || (!parsed.meshes && !parsed.scenes && !parsed.nodes)) {
      return 'Invalid glTF JSON: asset.version and scene/mesh geometry are required.';
    }
    return null;
  }

  if (format === 'obj') {
    const vertexMatches = text.match(/^\s*v\s+[-+\d.eE]+\s+[-+\d.eE]+\s+[-+\d.eE]+/gm);
    if (!vertexMatches || vertexMatches.length < 3) {
      return 'Invalid Wavefront OBJ: at least 3 vertex (`v x y z`) lines are required.';
    }
    return null;
  }

  if (format === 'stl') {
    const trimmed = text.trimStart().toLowerCase();
    if (trimmed.startsWith('solid') && /facet\s+normal/i.test(text) && /vertex\s+/i.test(text)) {
      return null;
    }
    if (bytes.length >= 134) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const triCount = view.getUint32(80, true);
      const expectedLen = 84 + triCount * 50;
      if (triCount >= 1 && bytes.length >= expectedLen && bytes.length <= expectedLen + 64) {
        return null;
      }
    }
    return 'Invalid STL file: expected ASCII or binary STL triangles.';
  }

  if (format === 'ply') {
    if (!/^ply[\r\n]/i.test(text) || !/element\s+vertex\s+\d+/i.test(text) || !/end_header/i.test(text)) {
      return 'Invalid PLY file: missing ply header, element vertex, or end_header.';
    }
    return null;
  }

  return `Unsupported 3D model format "${format}". Supported formats: ${SUPPORTED_3D_FORMATS.join(', ')}.`;
}

function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

function mat4FromTRS(translation, rotation, scale) {
  const tx = Array.isArray(translation) && Number.isFinite(Number(translation[0])) ? Number(translation[0]) : 0;
  const ty = Array.isArray(translation) && Number.isFinite(Number(translation[1])) ? Number(translation[1]) : 0;
  const tz = Array.isArray(translation) && Number.isFinite(Number(translation[2])) ? Number(translation[2]) : 0;
  const sx = Array.isArray(scale) && Number.isFinite(Number(scale[0])) ? Number(scale[0]) : 1;
  const sy = Array.isArray(scale) && Number.isFinite(Number(scale[1])) ? Number(scale[1]) : 1;
  const sz = Array.isArray(scale) && Number.isFinite(Number(scale[2])) ? Number(scale[2]) : 1;
  let qx = Array.isArray(rotation) && Number.isFinite(Number(rotation[0])) ? Number(rotation[0]) : 0;
  let qy = Array.isArray(rotation) && Number.isFinite(Number(rotation[1])) ? Number(rotation[1]) : 0;
  let qz = Array.isArray(rotation) && Number.isFinite(Number(rotation[2])) ? Number(rotation[2]) : 0;
  let qw = Array.isArray(rotation) && Number.isFinite(Number(rotation[3])) ? Number(rotation[3]) : 1;
  const qLen = Math.hypot(qx, qy, qz, qw);
  if (qLen > 0) {
    qx /= qLen;
    qy /= qLen;
    qz /= qLen;
    qw /= qLen;
  }
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1
  ];
}

function finalizeBbox(minX, minY, minZ, maxX, maxY, maxZ) {
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
  const rawW = Math.max(0.01, maxX - minX);
  const rawH = Math.max(0.01, maxY - minY);
  const rawD = Math.max(0.01, maxZ - minZ);
  return {
    width: Math.round(rawW * 10000) / 10000,
    height: Math.round(rawH * 10000) / 10000,
    depth: Math.round(rawD * 10000) / 10000
  };
}

function inspectGltfJsonStats(parsed) {
  const accessors = Array.isArray(parsed?.accessors) ? parsed.accessors : [];
  const meshes = Array.isArray(parsed?.meshes) ? parsed.meshes : [];
  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  const scenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
  const textures = Array.isArray(parsed?.textures) ? parsed.textures : [];
  const images = Array.isArray(parsed?.images) ? parsed.images : [];
  const extensionsUsed = Array.isArray(parsed?.extensionsUsed) ? parsed.extensionsUsed : [];
  let triangleCount = 0;

  // Collect per-mesh local primitive AABBs so node transforms (scale/rotation/matrix) apply accurately
  const meshBoxes = meshes.map((mesh) => {
    const boxes = [];
    for (const prim of mesh?.primitives || []) {
      const mode = prim?.mode ?? 4;
      if (prim?.indices !== undefined && accessors[prim.indices]) {
        const count = Number(accessors[prim.indices].count || 0);
        triangleCount += mode === 4 ? Math.ceil(count / 3) : Math.max(0, count - 2);
      } else if (prim?.attributes?.POSITION !== undefined && accessors[prim.attributes.POSITION]) {
        const count = Number(accessors[prim.attributes.POSITION].count || 0);
        triangleCount += mode === 4 ? Math.ceil(count / 3) : Math.max(0, count - 2);
      }
      const posAcc =
        prim?.attributes?.POSITION !== undefined ? accessors[prim.attributes.POSITION] : null;
      if (
        Array.isArray(posAcc?.min) &&
        Array.isArray(posAcc?.max) &&
        posAcc.min.length >= 3 &&
        posAcc.max.length >= 3
      ) {
        // Honor glTF 2.0 / KHR_mesh_quantization normalized integer accessors (e.g., Pixel Art Atlas & ABO GLBs)
        let normDivisor = 1;
        if (posAcc.normalized === true) {
          const ct = Number(posAcc.componentType || 0);
          if (ct === 5120) normDivisor = 127; // BYTE
          else if (ct === 5121) normDivisor = 255; // UNSIGNED_BYTE
          else if (ct === 5122) normDivisor = 32767; // SHORT
          else if (ct === 5123) normDivisor = 65535; // UNSIGNED_SHORT
        }
        const normVal = (v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return NaN;
          if (normDivisor === 1) return n;
          const scaled = n / normDivisor;
          return posAcc.componentType === 5120 || posAcc.componentType === 5122
            ? Math.max(-1, Math.min(1, scaled))
            : Math.max(0, Math.min(1, scaled));
        };
        const [x0, y0, z0] = posAcc.min.slice(0, 3).map(normVal);
        const [x1, y1, z1] = posAcc.max.slice(0, 3).map(normVal);
        if ([x0, y0, z0, x1, y1, z1].every(Number.isFinite)) {
          boxes.push({ x0, y0, z0, x1, y1, z1 });
        }
      }
    }
    return boxes;
  });

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let visitedMeshViaNodes = false;

  const expandTransformedBox = (m, b) => {
    const xs = [b.x0, b.x1];
    const ys = [b.y0, b.y1];
    const zs = [b.z0, b.z1];
    for (let ix = 0; ix < 2; ix += 1) {
      for (let iy = 0; iy < 2; iy += 1) {
        for (let iz = 0; iz < 2; iz += 1) {
          const x = xs[ix];
          const y = ys[iy];
          const z = zs[iz];
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) continue;
          if (wx < minX) minX = wx;
          if (wy < minY) minY = wy;
          if (wz < minZ) minZ = wz;
          if (wx > maxX) maxX = wx;
          if (wy > maxY) maxY = wy;
          if (wz > maxZ) maxZ = wz;
        }
      }
    }
  };

  if (nodes.length > 0) {
    let rootNodes = [];
    if (scenes.length > 0) {
      const activeScene = scenes[Number.isInteger(parsed?.scene) ? parsed.scene : 0] || scenes[0];
      if (Array.isArray(activeScene?.nodes) && activeScene.nodes.length > 0) {
        rootNodes = activeScene.nodes;
      } else {
        for (const sc of scenes) {
          if (Array.isArray(sc?.nodes)) rootNodes.push(...sc.nodes);
        }
      }
    }
    if (rootNodes.length === 0) {
      const childSet = new Set();
      for (const n of nodes) {
        for (const ch of n?.children || []) childSet.add(ch);
      }
      for (let i = 0; i < nodes.length; i += 1) {
        if (!childSet.has(i)) rootNodes.push(i);
      }
    }

    const walk = (nodeIdx, parentMat, pathSet) => {
      if (!Number.isInteger(nodeIdx) || nodeIdx < 0 || nodeIdx >= nodes.length) return;
      if (pathSet.has(nodeIdx)) return;
      const node = nodes[nodeIdx];
      if (!node || typeof node !== 'object') return;
      pathSet.add(nodeIdx);

      const localMat =
        Array.isArray(node.matrix) &&
        node.matrix.length === 16 &&
        node.matrix.every((v) => Number.isFinite(Number(v)))
          ? node.matrix.map(Number)
          : mat4FromTRS(node.translation, node.rotation, node.scale);
      const worldMat = mat4Multiply(parentMat, localMat);

      if (Number.isInteger(node.mesh) && meshBoxes[node.mesh]) {
        for (const b of meshBoxes[node.mesh]) {
          visitedMeshViaNodes = true;
          expandTransformedBox(worldMat, b);
        }
      }

      for (const ch of node.children || []) {
        walk(ch, worldMat, pathSet);
      }
      pathSet.delete(nodeIdx);
    };

    const ident = mat4Identity();
    for (const rootIdx of rootNodes) {
      walk(rootIdx, ident, new Set());
    }
  }

  // Fallback for minimal mesh-only glTF JSON lacking scene/nodes references
  if (!visitedMeshViaNodes) {
    const ident = mat4Identity();
    for (const boxes of meshBoxes) {
      for (const b of boxes) {
        expandTransformedBox(ident, b);
      }
    }
  }

  const bbox = finalizeBbox(minX, minY, minZ, maxX, maxY, maxZ);

  return {
    triangleCount,
    textureCount: Math.max(textures.length, images.length),
    hasDraco: extensionsUsed.includes('KHR_draco_mesh_compression'),
    hasMeshopt: extensionsUsed.includes('EXT_meshopt_compression'),
    ...(bbox ? { bbox, bboxUnits: 'native-meters' } : {})
  };
}

function inspectObjStats(text) {
  let triangleCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line[0] === '#') continue;
    if (line[0] === 'v' && (line[1] === ' ' || line[1] === '\t')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }
    } else if (line[0] === 'f' && (line[1] === ' ' || line[1] === '\t')) {
      triangleCount += 1;
    }
  }

  const bbox = finalizeBbox(minX, minY, minZ, maxX, maxY, maxZ);
  return {
    triangleCount,
    ...(bbox ? { bbox, bboxUnits: 'native-meters' } : {})
  };
}

function inspectStlStats(bytes) {
  let triangleCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const headText = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, Math.min(512, bytes.length))
  );
  let isBinary = false;
  if (bytes.length >= 134) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const binTriCount = view.getUint32(80, true);
    const expectedLen = 84 + binTriCount * 50;
    const looksAscii =
      headText.trimStart().toLowerCase().startsWith('solid') &&
      /facet\s+normal/i.test(headText) &&
      /vertex\s+/i.test(headText);
    if (!looksAscii && binTriCount >= 1 && bytes.length >= expectedLen && bytes.length <= expectedLen + 64) {
      isBinary = true;
      triangleCount = binTriCount;
      const limit = Math.min(binTriCount, MAX_CUSTOM_MODEL_TRIANGLES + 1);
      for (let i = 0; i < limit; i += 1) {
        const base = 84 + i * 50;
        for (let v = 0; v < 3; v += 1) {
          const off = base + 12 + v * 12;
          const x = view.getFloat32(off, true);
          const y = view.getFloat32(off + 4, true);
          const z = view.getFloat32(off + 8, true);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
          }
        }
      }
    }
  }

  if (!isBinary) {
    const fullText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    triangleCount = (fullText.match(/facet\s+normal/gi) || []).length;
    const vertRe = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/gi;
    let m;
    while ((m = vertRe.exec(fullText)) !== null) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      const z = Number(m[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
  }

  const bbox = finalizeBbox(minX, minY, minZ, maxX, maxY, maxZ);
  return {
    triangleCount,
    ...(bbox ? { bbox, bboxUnits: 'native-meters' } : {})
  };
}

const PLY_TYPE_SIZE = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8
};

function readPlyScalar(view, offset, type, littleEndian) {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset);
    case 'short':
    case 'int16':
      return view.getInt16(offset, littleEndian);
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, littleEndian);
    case 'int':
    case 'int32':
      return view.getInt32(offset, littleEndian);
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, littleEndian);
    case 'double':
    case 'float64':
      return view.getFloat64(offset, littleEndian);
    case 'float':
    case 'float32':
    default:
      return view.getFloat32(offset, littleEndian);
  }
}

function inspectPlyStats(bytes) {
  const headerScanLen = Math.min(bytes.length, 65536);
  const headerSlice = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, headerScanLen)
  );
  const endMatch = /end_header\r?\n/i.exec(headerSlice);
  if (!endMatch) {
    return { triangleCount: 0 };
  }
  const headerText = headerSlice.slice(0, endMatch.index);
  const dataOffset = new TextEncoder().encode(headerSlice.slice(0, endMatch.index + endMatch[0].length)).length;

  let format = 'ascii';
  let vertexCount = 0;
  let triangleCount = 0;
  let currentElement = '';
  const vertexProps = [];

  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('comment')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'format' && parts[1]) {
      format = parts[1].toLowerCase();
    } else if (parts[0] === 'element' && parts[1]) {
      currentElement = parts[1].toLowerCase();
      if (currentElement === 'vertex') vertexCount = Number(parts[2] || 0);
      if (currentElement === 'face') triangleCount = Number(parts[2] || 0);
    } else if (parts[0] === 'property' && currentElement === 'vertex' && parts[1] !== 'list') {
      const type = String(parts[1] || '').toLowerCase();
      const name = String(parts[2] || '').toLowerCase();
      vertexProps.push({ type, name, size: PLY_TYPE_SIZE[type] || 0 });
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const xIdx = vertexProps.findIndex((p) => p.name === 'x');
  const yIdx = vertexProps.findIndex((p) => p.name === 'y');
  const zIdx = vertexProps.findIndex((p) => p.name === 'z');

  if (vertexCount > 0 && xIdx >= 0 && yIdx >= 0 && zIdx >= 0) {
    const safeVertCount = Math.min(vertexCount, 500000);
    if (format === 'ascii') {
      const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(dataOffset));
      const lines = bodyText.split(/\r?\n/);
      let parsedVerts = 0;
      for (let i = 0; i < lines.length && parsedVerts < safeVertCount; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(/\s+/);
        if (cols.length <= Math.max(xIdx, yIdx, zIdx)) continue;
        const x = Number(cols[xIdx]);
        const y = Number(cols[yIdx]);
        const z = Number(cols[zIdx]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
        parsedVerts += 1;
      }
    } else if (
      (format === 'binary_little_endian' || format === 'binary_big_endian') &&
      vertexProps.every((p) => p.size > 0)
    ) {
      const littleEndian = format === 'binary_little_endian';
      let stride = 0;
      const offsets = [];
      for (const p of vertexProps) {
        offsets.push(stride);
        stride += p.size;
      }
      if (stride > 0 && dataOffset + stride <= bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const maxPossible = Math.min(safeVertCount, Math.floor((bytes.length - dataOffset) / stride));
        for (let i = 0; i < maxPossible; i += 1) {
          const base = dataOffset + i * stride;
          const x = readPlyScalar(view, base + offsets[xIdx], vertexProps[xIdx].type, littleEndian);
          const y = readPlyScalar(view, base + offsets[yIdx], vertexProps[yIdx].type, littleEndian);
          const z = readPlyScalar(view, base + offsets[zIdx], vertexProps[zIdx].type, littleEndian);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
          }
        }
      }
    }
  }

  const bbox = finalizeBbox(minX, minY, minZ, maxX, maxY, maxZ);
  return {
    triangleCount,
    ...(bbox ? { bbox, bboxUnits: 'native-meters' } : {})
  };
}

/**
 * Compensates legacy custom-3D DB records whose persisted `scale` was calibrated under the
 * pre-1:1 `autoFit` rule (which shrank models > 3.2m or < 0.28m to 1.4m before applying scale).
 * Newly placed models carry `bboxUnits: 'native-meters'` and ALWAYS return 1 (zero autoscaling).
 */
export function computeLegacyAutoFitCompensation(meshStats, nativeSize) {
  if (!meshStats || !nativeSize || meshStats.bboxUnits === 'native-meters') return 1;
  const nw = Number(nativeSize.x ?? nativeSize.width);
  const nh = Number(nativeSize.y ?? nativeSize.height);
  const nd = Number(nativeSize.z ?? nativeSize.depth);
  if (![nw, nh, nd].every((v) => Number.isFinite(v) && v > 0)) return 1;

  const nativeMax = Math.max(nw, nh, nd);
  if (!(nativeMax > 3.2 || nativeMax < 0.28)) return 1;

  const stored = meshStats.bbox;
  if (!stored || typeof stored !== 'object') return 1;
  const sw = Number(stored.width);
  const sh = Number(stored.height);
  const sd = Number(stored.depth);
  if (![sw, sh, sd].every((v) => Number.isFinite(v) && v > 0)) return 1;

  const storedMax = Math.max(sw, sh, sd);
  if (Math.abs(storedMax - 1.4) > 0.03 || Math.abs(nativeMax - storedMax) <= 0.1) return 1;

  // Confirm aspect ratios match so only genuine legacy 1.4/maxDim autoFit records are compensated
  const tol = 0.06;
  if (
    Math.abs(sw / storedMax - nw / nativeMax) > tol ||
    Math.abs(sh / storedMax - nh / nativeMax) > tol ||
    Math.abs(sd / storedMax - nd / nativeMax) > tol
  ) {
    return 1;
  }
  return 1.4 / nativeMax;
}

export function inspectCustomModelStats(format, bytes) {
  const stats = {
    triangleCount: 0,
    textureCount: 0,
    hasDraco: false,
    hasMeshopt: false,
    byteLength: bytes?.length || 0
  };
  if (!bytes || bytes.length === 0) return { stats, error: null };

  if (format === 'glb') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 20) {
      const chunkLen = view.getUint32(12, true);
      const chunkType = view.getUint32(16, true);
      // 0x4E4F534A == 'JSON'
      if (chunkType === 0x4e4f534a && 20 + chunkLen <= bytes.length) {
        try {
          const jsonStr = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLen));
          const parsed = JSON.parse(jsonStr);
          Object.assign(stats, inspectGltfJsonStats(parsed));
        } catch {
          return { stats, error: 'Corrupt glTF JSON chunk inside GLB binary.' };
        }
      }
    }
  } else if (format === 'gltf') {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      Object.assign(stats, inspectGltfJsonStats(parsed));
    } catch {
      return { stats, error: 'Invalid glTF JSON structure.' };
    }
  } else if (format === 'obj') {
    const text = new TextDecoder().decode(bytes);
    Object.assign(stats, inspectObjStats(text));
  } else if (format === 'stl') {
    Object.assign(stats, inspectStlStats(bytes));
  } else if (format === 'ply') {
    Object.assign(stats, inspectPlyStats(bytes));
  }

  if (stats.triangleCount > MAX_CUSTOM_MODEL_TRIANGLES) {
    return {
      stats,
      error: `3D model exceeds mobile WebGL triangle budget (${stats.triangleCount.toLocaleString()} > ${MAX_CUSTOM_MODEL_TRIANGLES.toLocaleString()} max). Compress or decimate the mesh (Draco/Meshopt recommended).`
    };
  }
  if (stats.textureCount > MAX_CUSTOM_MODEL_TEXTURES) {
    return {
      stats,
      error: `3D model embeds ${stats.textureCount} textures (max ${MAX_CUSTOM_MODEL_TEXTURES} allowed for mobile AR memory).`
    };
  }
  return { stats, error: null };
}

export function validateAnchorOffset(raw = {}, { parcelVolume = null } = {}) {
  const src = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {});
  const dx = Number(src.dx ?? 0);
  const dy = Number(src.dy ?? 0);
  const dz = Number(src.dz ?? 0);
  const yaw = Number(src.yaw ?? 0);
  const hasPitch = src.pitch !== undefined && src.pitch !== null && src.pitch !== '';
  const hasRoll = src.roll !== undefined && src.roll !== null && src.roll !== '';
  const rawPitch = hasPitch ? Number(src.pitch) : 0;
  const rawRoll = hasRoll ? Number(src.roll) : 0;
  const hasScale = src.scale !== undefined && src.scale !== null && src.scale !== '';
  const scale = hasScale ? Number(src.scale) : null;
  if (![dx, dy, dz, yaw, rawPitch, rawRoll].every(Number.isFinite)) {
    return {
      error: 'anchorOffset coordinates (dx, dy, dz, yaw, pitch, roll) must be finite numbers.',
      offset: null
    };
  }
  if (Math.abs(rawPitch) > 360 || Math.abs(rawRoll) > 360) {
    return {
      error: 'anchorOffset tilt angles (pitch, roll) must be between -360° and 360°.',
      offset: null
    };
  }
  if (hasScale && (!Number.isFinite(scale) || scale < 0.001 || scale > 60)) {
    return {
      error: 'Artwork scale must be a finite number between 0.001 and 60.',
      offset: null
    };
  }
  const normalizeDeg = (deg) => {
    let wrapped = (((deg + 180) % 360) + 360) % 360 - 180;
    if (wrapped === -180 && deg > 0) wrapped = 180;
    return Math.round(wrapped * 100) / 100;
  };
  const maxHoriz = parcelVolume
    ? Math.max(
        20,
        Number(parcelVolume.widthMeters || 0) / 2 + 2,
        Number(parcelVolume.depthMeters || 0) / 2 + 2
      )
    : 20;
  const maxVert = parcelVolume
    ? Math.max(30, Number(parcelVolume.heightMeters || 0) + 2)
    : 30;
  if (Math.abs(dx) > maxHoriz || Math.abs(dz) > maxHoriz || dy < -5 || dy > maxVert) {
    return {
      error: `anchorOffset out of parcel landmark bounds (|dx|,|dz| <= ${Math.round(
        maxHoriz
      )}m, -5m <= dy <= ${Math.round(maxVert)}m).`,
      offset: null
    };
  }
  return {
    error: null,
    offset: {
      dx: Math.round(dx * 1000) / 1000,
      dy: Math.round(dy * 1000) / 1000,
      dz: Math.round(dz * 1000) / 1000,
      yaw: Math.round(yaw * 10000) / 10000,
      ...(hasPitch ? { pitch: normalizeDeg(rawPitch) } : {}),
      ...(hasRoll ? { roll: normalizeDeg(rawRoll) } : {}),
      ...(hasScale ? { scale: Math.round(scale * 10000) / 10000 } : {})
    }
  };
}

/**
 * Extracts, validates, and normalizes a non-voxel 3D model payload passed via MCP or HTTP API.
 * Returns null if no custom model fields are present.
 */
export function extractCustomModelInput(input = {}) {
  const modelObj =
    input?.model && typeof input.model === 'object' && !Array.isArray(input.model)
      ? input.model
      : null;

  const catalogItemId = String(modelObj?.catalogItemId ?? input?.catalogItemId ?? '').trim();
  const catalogResolved = catalogItemId ? resolveCatalogItemReference({ catalogItemId }) : null;
  if (catalogItemId && !catalogResolved) {
    return {
      provided: true,
      error: `Invalid catalogItemId "${catalogItemId}". Expected simready:<id>, pixels:<id>, or xeroemoji:<id>.`,
      customModel: null
    };
  }

  const rawFormat = modelObj?.format ?? input?.modelFormat ?? (catalogResolved ? catalogResolved.modelFormat : '');
  const rawBase64 = modelObj?.dataBase64 ?? modelObj?.base64 ?? input?.modelBase64 ?? '';
  const rawData = modelObj?.dataText ?? modelObj?.data ?? input?.modelData ?? '';
  const rawUrl = String(
    modelObj?.url ?? input?.modelUrl ?? (catalogResolved ? catalogResolved.modelUrl : '')
  ).trim();
  const rawScale = Number(modelObj?.scale ?? input?.modelScale ?? 1);
  const rawRotY = Number(modelObj?.rotationY ?? input?.modelRotationY ?? 0);

  if (!rawFormat && !rawBase64 && !rawData && !rawUrl) {
    return { provided: false, error: null, customModel: null };
  }

  let dataMime = '';
  let decodedBytes = null;

  const candidateDataStr = typeof rawBase64 === 'string' && rawBase64.trim()
    ? rawBase64.trim()
    : typeof rawData === 'string' && rawData.trim().startsWith('data:')
      ? rawData.trim()
      : '';

  if (candidateDataStr) {
    if (candidateDataStr.startsWith('data:')) {
      const comma = candidateDataStr.indexOf(',');
      if (comma === -1) {
        return { provided: true, error: 'Malformed 3D model data URI.', customModel: null };
      }
      const header = candidateDataStr.slice(5, comma);
      dataMime = header.split(';')[0] || '';
      const payloadPart = candidateDataStr.slice(comma + 1);
      try {
        decodedBytes = header.includes(';base64')
          ? b64ToModelBytes(payloadPart)
          : new TextEncoder().encode(decodeURIComponent(payloadPart));
      } catch {
        return { provided: true, error: 'Failed to decode base64 3D model data.', customModel: null };
      }
    } else {
      try {
        decodedBytes = b64ToModelBytes(candidateDataStr);
      } catch {
        return { provided: true, error: 'Invalid base64 3D model payload.', customModel: null };
      }
    }
  } else if (rawData) {
    if (typeof rawData === 'object') {
      decodedBytes = new TextEncoder().encode(JSON.stringify(rawData));
      if (!rawFormat) dataMime = FORMAT_MIME_TYPES.gltf;
    } else {
      decodedBytes = new TextEncoder().encode(String(rawData));
    }
  }

  const format = inferFormatFromHint(rawFormat, rawUrl, dataMime);
  if (!format && !(rawUrl && !decodedBytes)) {
    return {
      provided: true,
      error: `Unsupported or missing 3D model format. Supported: ${SUPPORTED_3D_FORMATS.join(', ')}.`,
      customModel: null
    };
  }
  const effectiveFormat = format || 'auto';

  let stats = { triangleCount: 0, textureCount: 0, hasDraco: false, hasMeshopt: false };
  if (decodedBytes) {
    const err = validateModelBytesByFormat(effectiveFormat, decodedBytes);
    if (err) {
      return { provided: true, error: err, customModel: null };
    }
    const inspected = inspectCustomModelStats(effectiveFormat, decodedBytes);
    if (inspected.error) {
      return { provided: true, error: inspected.error, customModel: null };
    }
    stats = inspected.stats;
  } else if (rawUrl) {
    const isCatalogEmojiRel = Boolean(extractCatalogEmojiId({ modelUrl: rawUrl, catalogItemId }));
    if (!isCatalogEmojiRel && !/^(https?:\/\/|ipfs:\/\/)/i.test(rawUrl)) {
      return {
        provided: true,
        error: 'modelUrl must start with https://, http://, or ipfs://',
        customModel: null
      };
    }
  } else {
    return {
      provided: true,
      error: 'Provide modelBase64, modelData, or a valid modelUrl for your 3D file.',
      customModel: null
    };
  }

  const mimeType = FORMAT_MIME_TYPES[effectiveFormat] || 'application/octet-stream';
  const scale = Number.isFinite(rawScale) ? Math.min(60, Math.max(0.001, rawScale)) : 1;
  const rotationY = Number.isFinite(rawRotY) ? rawRotY : 0;

  return {
    provided: true,
    error: null,
    customModel: {
      format: effectiveFormat,
      mimeType,
      ext: effectiveFormat,
      bytes: decodedBytes,
      byteLength: decodedBytes ? decodedBytes.length : 0,
      externalUrl: rawUrl,
      scale,
      rotationY,
      stats
    }
  };
}

export function hasCustomModelPayload(input = {}) {
  return extractCustomModelInput(input).provided;
}

export function sniffFormatFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return '';
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    return 'glb';
  }
  const headText = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(2048, bytes.length)))
    .trimStart();
  if (/^ply[\r\n]/i.test(headText)) return 'ply';
  if (headText.startsWith('{') && /"asset"\s*:/.test(headText)) return 'gltf';
  if (/^solid\b/i.test(headText) && /facet\s+normal/i.test(headText)) return 'stl';
  if (/^\s*v\s+[-+\d.eE]+\s+[-+\d.eE]+\s+[-+\d.eE]+/m.test(headText)) return 'obj';
  if (bytes.length >= 134) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);
    if (triCount >= 1 && bytes.length === 84 + triCount * 50) return 'stl';
  }
  return '';
}

function deriveSuggestedTitleFromUrl(rawUrl = '') {
  try {
    const clean = String(rawUrl || '').split('?')[0].split('#')[0];
    const seg = clean.split('/').filter(Boolean).pop() || '';
    const base = decodeURIComponent(seg).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
    return base.slice(0, 48);
  } catch {
    return '';
  }
}

/**
 * Fetches and validates an external 3D model URL (https://, http://, or ipfs://) against
 * SPRAY.LAND's supported formats (.glb, .gltf, .obj, .stl, .ply), size limit, and WebGL budgets.
 */
/**
 * Rejects loopback, private, link-local, CGNAT and cloud-metadata hosts so server-side model URL
 * validation cannot be used to probe internal services (SSRF). Hostname-only check; deployments
 * that resolve attacker-controlled DNS to private IPs should also enforce egress rules.
 */
export function isBlockedModelHost(rawHost) {
  const host = String(rawHost || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.goog'
  ) {
    return true;
  }
  const v4 = host.match(/^(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/);
  if (v4) {
    // Reject octal-prefixed IPv4 octets (e.g. 0177.0.0.1) defensively even if called outside new URL().
    if (v4.slice(1).some((part) => part.length > 1 && part.startsWith('0'))) return true;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  // Shorthand numeric IPv4 forms (e.g. 127.1, 127.0.1, 0x7f.1) are never legitimate public hosts.
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,2}$/.test(host)) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^(?:0{1,4}:){7}0{0,3}[01]$/.test(host) || /^0+::0*[01]?$/.test(host)) return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^(?:(?:0{1,4}:){5}|::)ffff:(.+)$/);
    if (mapped) return mapped[1].includes('.') ? isBlockedModelHost(mapped[1]) : true;
  }
  return false;
}

export async function validate3dModelUrl(rawUrl, { formatHint = '', timeoutMs = 9000 } = {}) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Enter a 3D model URL (https://... or ipfs://...).' };
  }

  // Fast in-process resolution for dynamic XeroEmoji 3D GLBs (avoids Worker self-fetch)
  const emojiId = extractCatalogEmojiId({ modelUrl: trimmed, catalogItemId: trimmed });
  if (emojiId) {
    try {
      const built = await buildCatalogEmojiGlb(emojiId);
      const checkedEmoji = extractCustomModelInput({
        modelFormat: 'glb',
        modelBase64: modelBytesToB64(built.bytes)
      });
      if (checkedEmoji.error || !checkedEmoji.customModel) {
        return { valid: false, error: checkedEmoji.error || 'Failed to build 3D emoji GLB.' };
      }
      return {
        valid: true,
        error: null,
        format: 'glb',
        mimeType: FORMAT_MIME_TYPES.glb,
        byteLength: built.bytes.length,
        stats: checkedEmoji.customModel.stats,
        suggestedTitle: built.title || `Emoji ${emojiId}`,
        resolvedUrl: `/api/catalog/emoji/${encodeURIComponent(built.emojiId)}.glb`,
        originalUrl: trimmed,
        bytes: built.bytes,
        customModel: {
          ...checkedEmoji.customModel,
          externalUrl: `/api/catalog/emoji/${encodeURIComponent(built.emojiId)}.glb`
        }
      };
    } catch (err) {
      return {
        valid: false,
        error: err?.message || `Could not build 3D XeroEmoji GLB (${emojiId}).`
      };
    }
  }

  if (!/^(https?:\/\/|ipfs:\/\/)/i.test(trimmed)) {
    return { valid: false, error: 'Model link must start with https://, http://, or ipfs://' };
  }

  let fetchUrl = trimmed;
  if (/^ipfs:\/\//i.test(trimmed)) {
    const cidPath = trimmed.slice(7).replace(/^ipfs\//i, '').trim();
    if (!cidPath) return { valid: false, error: 'Invalid ipfs:// URL.' };
    fetchUrl = `https://gateway.pinata.cloud/ipfs/${cidPath}`;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(fetchUrl);
  } catch {
    return { valid: false, error: 'Malformed 3D model URL.' };
  }
  // Local development / test fixtures serve models from 127.0.0.1; never set this in production.
  const allowPrivate = globalThis.process?.env?.GRAFFILAND_ALLOW_PRIVATE_MODEL_HOSTS === '1';
  if (!allowPrivate && isBlockedModelHost(parsedUrl.hostname)) {
    return { valid: false, error: 'Model links must point to a public internet host.' };
  }

  let res;
  try {
    // Follow redirects manually so every hop is re-checked against the private-host blocklist.
    let currentUrl = parsedUrl;
    for (let hop = 0; ; hop++) {
      res = await fetch(currentUrl.toString(), {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual'
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
      if (!location) break;
      if (hop >= 3) return { valid: false, error: '3D model link redirects too many times.' };
      currentUrl = new URL(location, currentUrl);
      if (
        !/^https?:$/.test(currentUrl.protocol) ||
        (!allowPrivate && isBlockedModelHost(currentUrl.hostname))
      ) {
        return { valid: false, error: 'Model links must point to a public internet host.' };
      }
    }
  } catch {
    return { valid: false, error: `Could not reach 3D model URL (${trimmed}). Check that the link is public.` };
  }
  if (!res.ok) {
    return { valid: false, error: `3D model link returned HTTP ${res.status}.` };
  }

  const contentLen = Number(res.headers?.get?.('content-length') || 0);
  if (contentLen > CUSTOM_MODEL_MAX_BYTES) {
    return {
      valid: false,
      error: `3D model exceeds ${Math.round(CUSTOM_MODEL_MAX_BYTES / (1024 * 1024))} MB maximum size.`
    };
  }

  let buf;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { valid: false, error: 'Failed to read 3D model bytes from link.' };
  }

  if (buf.length === 0) {
    return { valid: false, error: '3D model link returned an empty file.' };
  }
  if (buf.length > CUSTOM_MODEL_MAX_BYTES) {
    return {
      valid: false,
      error: `3D model exceeds ${Math.round(CUSTOM_MODEL_MAX_BYTES / (1024 * 1024))} MB maximum size.`
    };
  }

  const mime = res.headers?.get?.('content-type') || '';
  const detectedFormat =
    inferFormatFromHint('', trimmed, mime) ||
    sniffFormatFromBytes(buf) ||
    inferFormatFromHint(formatHint, '', '');
  if (!detectedFormat) {
    return {
      valid: false,
      error: `Unsupported file format. SPRAY.LAND supports: ${SUPPORTED_3D_FORMATS.map((f) => `.${f}`).join(', ')}.`
    };
  }

  const checked = extractCustomModelInput({
    modelFormat: detectedFormat,
    modelBase64: modelBytesToB64(buf)
  });
  if (checked.error || !checked.customModel) {
    return {
      valid: false,
      error: checked.error || `File at link is not a valid .${detectedFormat} 3D model.`
    };
  }

  return {
    valid: true,
    error: null,
    format: checked.customModel.format,
    mimeType: checked.customModel.mimeType,
    byteLength: buf.length,
    stats: checked.customModel.stats,
    suggestedTitle: deriveSuggestedTitleFromUrl(trimmed) || `3D ${detectedFormat.toUpperCase()} Model`,
    resolvedUrl: fetchUrl,
    originalUrl: trimmed,
    bytes: buf,
    customModel: {
      ...checked.customModel,
      externalUrl: trimmed
    }
  };
}

function isLikelyHtmlErrorBytes(bytes) {
  if (!bytes || bytes.length < 6) return false;
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 96)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head');
}

function resolveSafeExternalModelUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || !/^(https?:\/\/|ipfs:\/\/)/i.test(trimmed)) return '';
  let fetchUrl = trimmed;
  if (/^ipfs:\/\//i.test(trimmed)) {
    const cidPath = trimmed.slice(7).replace(/^ipfs\//i, '').trim();
    if (!cidPath) return '';
    fetchUrl = `https://gateway.pinata.cloud/ipfs/${cidPath}`;
  }
  try {
    const parsedUrl = new URL(fetchUrl);
    if (!/^https?:$/.test(parsedUrl.protocol)) return '';
    const allowPrivate = globalThis.process?.env?.GRAFFILAND_ALLOW_PRIVATE_MODEL_HOSTS === '1';
    if (!allowPrivate && isBlockedModelHost(parsedUrl.hostname)) return '';
    return parsedUrl.toString();
  } catch {
    return '';
  }
}

/**
 * Fetches custom 3D model bytes from IPFS gateways (and optional safe external URL)
 * whenever the asset exceeds `INLINE_MODEL_DB_MAX_BYTES` and is not yet in edge KV / local cache.
 * Validates binary integrity (e.g. GLB magic header, non-HTML payload, size cap) before returning.
 * @param {{
 *   cid?: string,
 *   gatewayBase?: string,
 *   gatewayUrl?: string,
 *   externalUrl?: string,
 *   format?: string,
 *   maxBytes?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch
 * }} [options]
 */
export async function fetchModelBytesFromGateways({
  cid = '',
  gatewayBase = 'https://gateway.pinata.cloud/ipfs',
  gatewayUrl = '',
  externalUrl = '',
  format = '',
  maxBytes = CUSTOM_MODEL_MAX_BYTES,
  timeoutMs = 12000,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const cleanCid = String(cid || '')
    .trim()
    .replace(/^ipfs:\/\//i, '');
  const cleanFormat = String(format || '').trim().toLowerCase();

  const candidateUrls = [];
  const pushUrl = (u) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (!candidateUrls.includes(s)) candidateUrls.push(s);
  };

  if (cleanCid && /^[a-zA-Z0-9_-]{16,128}$/.test(cleanCid)) {
    const base = String(gatewayBase || '').trim().replace(/\/+$/, '');
    if (base && /^https?:\/\//i.test(base)) {
      pushUrl(`${base}/${cleanCid}`);
    }
    if (gatewayUrl && String(gatewayUrl).includes(cleanCid)) {
      pushUrl(gatewayUrl);
    }
    pushUrl(`https://gateway.pinata.cloud/ipfs/${cleanCid}`);
    pushUrl(`https://ipfs.filebase.io/ipfs/${cleanCid}`);
    pushUrl(`https://dweb.link/ipfs/${cleanCid}`);
    pushUrl(`https://ipfs.io/ipfs/${cleanCid}`);
    pushUrl(`https://w3s.link/ipfs/${cleanCid}`);
  }

  if (externalUrl) {
    const emojiId = extractCatalogEmojiId({ modelUrl: externalUrl });
    if (emojiId) {
      try {
        const built = await buildCatalogEmojiGlb(emojiId, { fetchImpl });
        if (built?.bytes?.length > 0 && built.bytes.length <= maxBytes) {
          return built.bytes;
        }
      } catch {
        // Fall through to gateway URLs
      }
    }
    const resolvedExt = resolveSafeExternalModelUrl(externalUrl);
    if (resolvedExt) {
      pushUrl(resolvedExt);
    }
  }

  for (const targetUrl of candidateUrls) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(targetUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller?.signal,
        headers: {
          Accept: 'model/gltf-binary,model/gltf+json,application/octet-stream,*/*;q=0.8',
          'User-Agent': 'SPRAY.LAND/1.0 (+https://spray.land)'
        }
      });
      if (!res || !res.ok) continue;
      const cl = Number(res.headers?.get?.('content-length') || 0);
      if (cl > maxBytes) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > maxBytes) continue;
      if (isLikelyHtmlErrorBytes(bytes)) continue;
      if (
        cleanFormat === 'glb' &&
        (bytes.length < 20 ||
          bytes[0] !== 0x67 ||
          bytes[1] !== 0x6c ||
          bytes[2] !== 0x54 ||
          bytes[3] !== 0x46)
      ) {
        continue;
      }
      if (cleanFormat) {
        const formatErr = validateModelBytesByFormat(cleanFormat, bytes);
        if (formatErr) continue;
      }
      return {
        bytes,
        contentType:
          res.headers?.get?.('content-type') ||
          FORMAT_MIME_TYPES[cleanFormat] ||
          'application/octet-stream',
        sourceUrl: targetUrl
      };
    } catch {
      // Try next gateway cleanly
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return null;
}
