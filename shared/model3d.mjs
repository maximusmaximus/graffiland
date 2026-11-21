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

function inspectGltfJsonStats(parsed) {
  const accessors = Array.isArray(parsed?.accessors) ? parsed.accessors : [];
  const meshes = Array.isArray(parsed?.meshes) ? parsed.meshes : [];
  const textures = Array.isArray(parsed?.textures) ? parsed.textures : [];
  const images = Array.isArray(parsed?.images) ? parsed.images : [];
  const extensionsUsed = Array.isArray(parsed?.extensionsUsed) ? parsed.extensionsUsed : [];
  let triangleCount = 0;

  for (const mesh of meshes) {
    for (const prim of mesh?.primitives || []) {
      const mode = prim?.mode ?? 4;
      if (prim?.indices !== undefined && accessors[prim.indices]) {
        const count = Number(accessors[prim.indices].count || 0);
        triangleCount += mode === 4 ? Math.ceil(count / 3) : Math.max(0, count - 2);
      } else if (prim?.attributes?.POSITION !== undefined && accessors[prim.attributes.POSITION]) {
        const count = Number(accessors[prim.attributes.POSITION].count || 0);
        triangleCount += mode === 4 ? Math.ceil(count / 3) : Math.max(0, count - 2);
      }
    }
  }

  return {
    triangleCount,
    textureCount: Math.max(textures.length, images.length),
    hasDraco: extensionsUsed.includes('KHR_draco_mesh_compression'),
    hasMeshopt: extensionsUsed.includes('EXT_meshopt_compression')
  };
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
    const faces = text.match(/^\s*f\s+.+/gm) || [];
    stats.triangleCount = faces.length;
  } else if (format === 'stl') {
    const text = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.length)));
    if (text.trimStart().toLowerCase().startsWith('solid')) {
      const fullText = new TextDecoder().decode(bytes);
      stats.triangleCount = (fullText.match(/facet\s+normal/gi) || []).length;
    } else if (bytes.length >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      stats.triangleCount = view.getUint32(80, true);
    }
  } else if (format === 'ply') {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(1024, bytes.length)));
    const faceMatch = head.match(/element\s+face\s+(\d+)/i);
    if (faceMatch) stats.triangleCount = Number(faceMatch[1] || 0);
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

export function validateAnchorOffset(raw = {}) {
  const src = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {});
  const dx = Number(src.dx ?? 0);
  const dy = Number(src.dy ?? 0);
  const dz = Number(src.dz ?? 0);
  const yaw = Number(src.yaw ?? 0);
  if (![dx, dy, dz, yaw].every(Number.isFinite)) {
    return { error: 'anchorOffset coordinates (dx, dy, dz, yaw) must be finite numbers.', offset: null };
  }
  if (Math.abs(dx) > 20 || Math.abs(dz) > 20 || dy < -5 || dy > 30) {
    return {
      error: 'anchorOffset out of parcel landmark bounds (|dx|,|dz| <= 20m, -5m <= dy <= 30m).',
      offset: null
    };
  }
  return {
    error: null,
    offset: {
      dx: Math.round(dx * 1000) / 1000,
      dy: Math.round(dy * 1000) / 1000,
      dz: Math.round(dz * 1000) / 1000,
      yaw: Math.round(yaw * 10000) / 10000
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

  const mimeType = FORMAT_MIME_TYPES[effectiveFormat] || 'application/octet-stream';
  const scale = Number.isFinite(rawScale) ? Math.min(20, Math.max(0.05, rawScale)) : 1;
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
 * GRAFFILAND's supported formats (.glb, .gltf, .obj, .stl, .ply), size limit, and WebGL budgets.
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
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
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
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(.+)$/);
    if (mapped) return mapped[1].includes('.') ? isBlockedModelHost(mapped[1]) : true;
  }
  // Integer / hex / octal IPv4 forms (e.g. 2130706433, 0x7f000001) are never legitimate here.
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) return true;
  return false;
}

export async function validate3dModelUrl(rawUrl, { formatHint = '', timeoutMs = 9000 } = {}) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Enter a 3D model URL (https://... or ipfs://...).' };
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
      error: `Unsupported file format. GRAFFILAND supports: ${SUPPORTED_3D_FORMATS.map((f) => `.${f}`).join(', ')}.`
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
