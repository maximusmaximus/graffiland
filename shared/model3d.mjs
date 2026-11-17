export const CUSTOM_MODEL_MAX_BYTES = 4 * 1024 * 1024;
export const INLINE_MODEL_DB_MAX_BYTES = 180 * 1024;

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

function validateModelBytesByFormat(format, bytes) {
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
      if (triCount >= 1 && bytes.length === 84 + triCount * 50) {
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

/**
 * Extracts, validates, and normalizes a non-voxel 3D model payload passed via MCP or HTTP API.
 * Returns null if no custom model fields are present.
 */
export function extractCustomModelInput(input = {}) {
  const modelObj =
    input?.model && typeof input.model === 'object' && !Array.isArray(input.model)
      ? input.model
      : null;

  const rawFormat = modelObj?.format ?? input?.modelFormat ?? '';
  const rawBase64 = modelObj?.dataBase64 ?? modelObj?.base64 ?? input?.modelBase64 ?? '';
  const rawData = modelObj?.dataText ?? modelObj?.data ?? input?.modelData ?? '';
  const rawUrl = String(modelObj?.url ?? input?.modelUrl ?? '').trim();
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
  if (!format) {
    return {
      provided: true,
      error: `Unsupported or missing 3D model format. Supported: ${SUPPORTED_3D_FORMATS.join(', ')}.`,
      customModel: null
    };
  }

  if (decodedBytes) {
    const err = validateModelBytesByFormat(format, decodedBytes);
    if (err) {
      return { provided: true, error: err, customModel: null };
    }
  } else if (rawUrl) {
    if (!/^(https?:\/\/|ipfs:\/\/)/i.test(rawUrl)) {
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

  const mimeType = FORMAT_MIME_TYPES[format] || 'application/octet-stream';
  const scale = Number.isFinite(rawScale) ? Math.min(20, Math.max(0.05, rawScale)) : 1;
  const rotationY = Number.isFinite(rawRotY) ? rawRotY : 0;

  return {
    provided: true,
    error: null,
    customModel: {
      format,
      mimeType,
      ext: format,
      bytes: decodedBytes,
      byteLength: decodedBytes ? decodedBytes.length : 0,
      externalUrl: rawUrl,
      scale,
      rotationY
    }
  };
}

export function hasCustomModelPayload(input = {}) {
  return extractCustomModelInput(input).provided;
}
