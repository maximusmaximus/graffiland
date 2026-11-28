import { buildParcelShareUrl, resolveLandDisplayName, slugifyLandTitle } from './landVolume.mjs';

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
const OG_WIDTH = OG_IMAGE_WIDTH;
const OG_HEIGHT = OG_IMAGE_HEIGHT;
const FEET_PER_METER = 3.28084;

export const LAND_OG_IMAGE_MODES = ['auto', 'custom', 'logo'];
export const DEFAULT_LAND_OG_IMAGE_MODE = 'auto';

export function normalizeLandOgImageMode(raw) {
  const clean = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (clean === 'logo' || clean === 'off' || clean === 'none' || clean === 'disabled' || clean === 'false') {
    return 'logo';
  }
  if (clean === 'custom' || clean === 'upload') {
    return 'custom';
  }
  return DEFAULT_LAND_OG_IMAGE_MODE;
}

function fnv1aHex(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Deterministic freshness signature for a Virtual Land's OG share preview.
 * Changes whenever the land's name, dimensions, OG mode/custom image, or any
 * visible sculpture's placement, scale, or revision changes — busting X/Facebook caches.
 */
export function computeLandOgContentSig({ parcel = null, sculptures = [] } = {}) {
  const mode = normalizeLandOgImageMode(
    parcel?.ogImageMode ?? parcel?.settings?.ogImageMode ?? DEFAULT_LAND_OG_IMAGE_MODE
  );
  const customUrl = String(
    parcel?.ogCustomImageUrl ?? parcel?.settings?.ogCustomImageUrl ?? ''
  ).trim();
  const vol = parcel?.volume || {};
  const visible = (sculptures || [])
    .filter((s) => s && !s.hidden)
    .map((s) => {
      const ao = s.anchorOffset || {};
      return [
        s.id || '',
        s.currentRev || 1,
        s.modelType || 'voxel',
        Math.round(Number(ao.dx || 0) * 100),
        Math.round(Number(ao.dy || 0) * 100),
        Math.round(Number(ao.dz || 0) * 100),
        Math.round(Number(ao.yaw || 0)),
        Math.round(Number(ao.scale ?? s.customModel?.scale ?? 1) * 100),
        s.updatedAt || s.createdAt || ''
      ].join(':');
    })
    .sort();
  const landName = resolveLandDisplayName(parcel || {}, { defaultName: 'Virtual Land' });
  const slug = slugifyLandTitle(parcel?.customName || landName);
  const basis = [
    mode,
    mode === 'custom' ? customUrl.slice(-64) : '',
    slug,
    Math.round(Number(vol.widthMeters || 0) * 10),
    Math.round(Number(vol.depthMeters || 0) * 10),
    Math.round(Number(vol.heightMeters || 0) * 10),
    Math.round(Number(vol.rotationDeg || 0)),
    parcel?.frozen ? '1' : '0',
    visible.join('|')
  ].join('#');
  return `${mode}-${visible.length}-${fnv1aHex(basis)}`;
}

export function computeSculptureOgContentSig({ sculpture = null, parcel = null } = {}) {
  const rev = Number(sculpture?.currentRev || 1);
  const landName = parcel
    ? resolveLandDisplayName(parcel, { defaultName: '' })
    : String(sculpture?.parcelName || '');
  const basis = [
    sculpture?.id || '',
    rev,
    sculpture?.title || '',
    sculpture?.modelType || 'voxel',
    sculpture?.voxelCount || sculpture?.voxels?.length || 0,
    String(sculpture?.ogPreviewUrl || '').slice(-48),
    String(sculpture?.previewDataUrl || '').slice(-48),
    landName
  ].join('#');
  return `s${rev}-${fnv1aHex(basis)}`;
}

const OG_IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Decodes a validated base64 image data URL (`png`, `jpeg`, `webp`) into raw bytes.
 * Works in both Node.js and Cloudflare Workers runtimes.
 */
export function decodeOgImageDataUrl(dataUrl, { maxBytes = 1.6 * 1024 * 1024 } = {}) {
  const str = String(dataUrl || '').trim();
  if (!str) return null;
  const match = str.match(OG_IMAGE_DATA_URL_RE);
  if (!match) return null;
  const rawMime = match[1].toLowerCase();
  const mime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
  const cleanB64 = match[2].replace(/\s+/g, '');
  try {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(cleanB64, 'base64');
      if (!buf.length || buf.length > maxBytes) return null;
      return { mime, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
    }
    const bin = atob(cleanB64);
    if (!bin.length || bin.length > maxBytes) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  } catch {
    return null;
  }
}

// Crisp 5x7 uppercase/numeric/punctuation bitmap font (each char = 7 rows of 5-bit masks)
const FONT_5X7 = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  0: [0b01110, 0b10011, 0b10101, 0b10101, 0b11001, 0b10001, 0b01110],
  1: [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  2: [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  3: [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  5: [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  6: [0b01110, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b01110],
  7: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  8: [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  9: [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ',': [0, 0, 0, 0, 0b00100, 0b00100, 0b01000],
  '-': [0, 0, 0, 0b11111, 0, 0, 0],
  '_': [0, 0, 0, 0, 0, 0, 0b11111],
  '/': [0b00001, 0b00010, 0b00100, 0b00100, 0b01000, 0b10000, 0b00000],
  ':': [0, 0b00100, 0b00100, 0, 0b00100, 0b00100, 0],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  '+': [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  '&': [0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101],
  '@': [0b01110, 0b10001, 0b10111, 0b10101, 0b10110, 0b10000, 0b01110],
  '#': [0b01010, 0b11111, 0b01010, 0b01010, 0b11111, 0b01010, 0],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '\'': [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
  '|': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100]
};

// Precomputed IEEE 802.3 CRC32 table for valid PNG chunks
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(typeStr, data) {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const view = new DataView(out.buffer);
  view.setUint32(0, len, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = typeStr.charCodeAt(i);
  }
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + len);
  view.setUint32(8 + len, crc32(crcInput), false);
  return out;
}

async function deflateZlib(rawBytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(rawBytes);
  writer.close();
  const chunks = [];
  let total = 0;
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    merged.set(ch, offset);
    offset += ch.byteLength;
  }
  return merged;
}

function createCanvas(width, height) {
  const buf = new Uint8Array(width * height * 4);

  function blendPixel(x, y, r, g, b, a = 1) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height || a <= 0) return;
    const idx = (iy * width + ix) * 4;
    if (a >= 0.999) {
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
      return;
    }
    const inv = 1 - a;
    buf[idx] = Math.round(buf[idx] * inv + r * a);
    buf[idx + 1] = Math.round(buf[idx + 1] * inv + g * a);
    buf[idx + 2] = Math.round(buf[idx + 2] * inv + b * a);
    buf[idx + 3] = 255;
  }

  function fillRect(x, y, w, h, r, g, b, a = 1) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w));
    const y1 = Math.min(height, Math.ceil(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        blendPixel(px, py, r, g, b, a);
      }
    }
  }

  function fillRoundedRect(x, y, w, h, radius, r, g, b, a = 1) {
    const rad = Math.max(0, Math.min(radius, w / 2, h / 2));
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(width, Math.ceil(x + w));
    const y1 = Math.min(height, Math.ceil(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const cx = px < x + rad ? x + rad : px > x + w - rad ? x + w - rad : px;
        const cy = py < y + rad ? y + rad : py > y + h - rad ? y + h - rad : py;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= rad * rad + 0.5) {
          blendPixel(px, py, r, g, b, a);
        }
      }
    }
  }

  function strokeRoundedRect(x, y, w, h, radius, thickness, r, g, b, a = 1) {
    const rad = Math.max(0, Math.min(radius, w / 2, h / 2));
    const x0 = Math.max(0, Math.floor(x - thickness));
    const y0 = Math.max(0, Math.floor(y - thickness));
    const x1 = Math.min(width, Math.ceil(x + w + thickness));
    const y1 = Math.min(height, Math.ceil(y + h + thickness));
    const innerRad = Math.max(0, rad - thickness);
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const cx = px < x + rad ? x + rad : px > x + w - rad ? x + w - rad : px;
        const cy = py < y + rad ? y + rad : py > y + h - rad ? y + h - rad : py;
        const dist = Math.hypot(px - cx, py - cy);
        const insideOuter =
          px >= x && px <= x + w && py >= y && py <= y + h && dist <= rad + 0.5;
        if (!insideOuter) continue;
        const ix =
          px < x + rad
            ? x + rad
            : px > x + w - rad
              ? x + w - rad
              : px;
        const iy =
          py < y + rad
            ? y + rad
            : py > y + h - rad
              ? y + h - rad
              : py;
        const insideInner =
          px >= x + thickness &&
          px <= x + w - thickness &&
          py >= y + thickness &&
          py <= y + h - thickness &&
          Math.hypot(px - ix, py - iy) <= innerRad;
        if (!insideInner) {
          blendPixel(px, py, r, g, b, a);
        }
      }
    }
  }

  function fillCircle(cx, cy, rad, r, g, b, a = 1) {
    const x0 = Math.max(0, Math.floor(cx - rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const x1 = Math.min(width - 1, Math.ceil(cx + rad));
    const y1 = Math.min(height - 1, Math.ceil(cy + rad));
    const r2 = rad * rad;
    for (let py = y0; py <= y1; py += 1) {
      const dy = py - cy;
      for (let px = x0; px <= x1; px += 1) {
        const dx = px - cx;
        if (dx * dx + dy * dy <= r2) {
          blendPixel(px, py, r, g, b, a);
        }
      }
    }
  }

  function drawLine(x0, y0, x1, y1, thickness, r, g, b, a = 1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.4));
    const rad = Math.max(0.6, thickness / 2);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      if (rad <= 0.85) {
        blendPixel(px, py, r, g, b, a);
      } else {
        fillCircle(px, py, rad, r, g, b, a);
      }
    }
  }

  function fillPolygon(points, r, g, b, a = 1) {
    if (!Array.isArray(points) || points.length < 3) return;
    let minY = height;
    let maxY = 0;
    for (const [, py] of points) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height - 1, Math.ceil(maxY));
    for (let py = y0; py <= y1; py += 1) {
      const nodes = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi < py && yj >= py) || (yj < py && yi >= py)) {
          nodes.push(xi + ((py - yi) / (yj - yi)) * (xj - xi));
        }
      }
      nodes.sort((u, v) => u - v);
      for (let n = 0; n < nodes.length - 1; n += 2) {
        const xStart = Math.max(0, Math.floor(nodes[n]));
        const xEnd = Math.min(width - 1, Math.ceil(nodes[n + 1]));
        for (let px = xStart; px <= xEnd; px += 1) {
          blendPixel(px, py, r, g, b, a);
        }
      }
    }
  }

  function drawText(rawText, x, y, scale, r, g, b, a = 1, letterSpacing = 1) {
    const clean = String(rawText || '')
      .toUpperCase()
      .replace(/[^\x20-\x7E]/g, ' ');
    const adv = (5 + letterSpacing) * scale;
    let cursorX = x;
    for (let i = 0; i < clean.length; i += 1) {
      const glyph = FONT_5X7[clean[i]] || FONT_5X7[' '];
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row];
        if (!bits) continue;
        for (let col = 0; col < 5; col += 1) {
          if ((bits & (1 << (4 - col))) !== 0) {
            fillRect(cursorX + col * scale, y + row * scale, scale, scale, r, g, b, a);
          }
        }
      }
      cursorX += adv;
    }
    return cursorX - x;
  }

  return {
    buf,
    blendPixel,
    fillRect,
    fillRoundedRect,
    strokeRoundedRect,
    fillCircle,
    drawLine,
    fillPolygon,
    drawText
  };
}

function wrapUpperLines(text, maxCharsPerLine, maxLines = 2) {
  const words = String(text || 'VIRTUAL LAND')
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return ['VIRTUAL LAND'];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else if (!current) {
      lines.push(word.slice(0, maxCharsPerLine));
    } else {
      lines.push(current);
      current = word.slice(0, maxCharsPerLine);
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines.slice(0, maxLines);
}

function parseHexRgb(hex, fallback = [0, 245, 212]) {
  const m = String(hex || '')
    .trim()
    .match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function escapeHtmlAttr(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function encodeCanvasPng(canvas) {
  const stride = OG_WIDTH * 4;
  const raw = new Uint8Array(OG_HEIGHT * (stride + 1));
  for (let y = 0; y < OG_HEIGHT; y += 1) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0;
    raw.set(canvas.buf.subarray(y * stride, (y + 1) * stride), rowOff + 1);
  }
  const compressed = await deflateZlib(raw);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, OG_WIDTH, false);
  ihdrView.setUint32(4, OG_HEIGHT, false);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = makePngChunk('IHDR', ihdrData);
  const idat = makePngChunk('IDAT', compressed);
  const iend = makePngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let pos = 0;
  png.set(sig, pos);
  pos += sig.length;
  png.set(ihdr, pos);
  pos += ihdr.length;
  png.set(idat, pos);
  pos += idat.length;
  png.set(iend, pos);
  return png;
}

function paintMidnightBackdrop(canvas, { isFrozen = false, spotlightX = 600, spotlightY = 340 } = {}) {
  for (let y = 0; y < OG_HEIGHT; y += 1) {
    const ty = y / OG_HEIGHT;
    for (let x = 0; x < OG_WIDTH; x += 1) {
      const tx = x / OG_WIDTH;
      let r = 6 + tx * 6 + ty * 7;
      let g = 10 + tx * 10 + ty * 10;
      let b = 22 + tx * 16 + ty * 16;

      const dxC = (x - spotlightX) / 480;
      const dyC = (y - spotlightY) / 300;
      const glowC = Math.max(0, 1 - (dxC * dxC + dyC * dyC));
      r += glowC * glowC * (isFrozen ? 18 : 6);
      g += glowC * glowC * (isFrozen ? 46 : 54);
      b += glowC * glowC * (isFrozen ? 74 : 62);

      const dxM = (x - 220) / 420;
      const dyM = (y - 110) / 280;
      const glowM = Math.max(0, 1 - (dxM * dxM + dyM * dyM));
      r += glowM * glowM * 44;
      g += glowM * glowM * 8;
      b += glowM * glowM * 38;

      const idx = (y * OG_WIDTH + x) * 4;
      canvas.buf[idx] = Math.min(255, Math.round(r));
      canvas.buf[idx + 1] = Math.min(255, Math.round(g));
      canvas.buf[idx + 2] = Math.min(255, Math.round(b));
      canvas.buf[idx + 3] = 255;
    }
  }
  for (let gx = 48; gx < OG_WIDTH; gx += 72) {
    canvas.drawLine(gx, 0, gx, OG_HEIGHT, 1, 148, 163, 184, 0.05);
  }
  for (let gy = 48; gy < OG_HEIGHT; gy += 72) {
    canvas.drawLine(0, gy, OG_WIDTH, gy, 1, 148, 163, 184, 0.05);
  }
}

/**
 * Draws the official SPRAY.LAND Voxel Spray Can mark + logotype centered squarely
 * in the middle of the 1200x630 image (`cx = 600, cy = 315`).
 */
function drawCenteredSprayLandLogotype(canvas, { variant = 'overlay' } = {}) {
  const isHero = variant === 'hero';
  const cx = Math.round(OG_WIDTH / 2);
  const cy = Math.round(OG_HEIGHT / 2);

  if (!isHero) {
    // Subtle dark glass badge directly behind the centered logotype so it pops over any 3D render
    const badgeW = 630;
    const badgeH = 124;
    const bx = cx - Math.round(badgeW / 2);
    const by = cy - Math.round(badgeH / 2);
    canvas.fillRoundedRect(bx, by, badgeW, badgeH, 28, 6, 10, 22, 0.66);
    canvas.strokeRoundedRect(bx, by, badgeW, badgeH, 28, 2, 0, 245, 212, 0.42);
  }

  // Iconic Voxel Spray Can mark to the left of the logotype
  const textScale = isHero ? 11.5 : 8.5;
  const word = 'SPRAY.LAND';
  const wordW = word.length * 6 * textScale - textScale;
  const canW = isHero ? 56 : 42;
  const gap = isHero ? 28 : 22;
  const totalW = canW + gap + wordW;
  const startX = Math.round(cx - totalW / 2);

  // Voxel spray can body (cyan top dome, magenta stripe, crisp nozzle + spray mist dots)
  const canH = isHero ? 78 : 58;
  const canX = startX;
  const canY = Math.round(cy - canH / 2);
  const nozzleW = Math.round(canW * 0.36);
  const nozzleH = Math.round(canH * 0.16);
  canvas.fillRoundedRect(canX + Math.round((canW - nozzleW) / 2), canY, nozzleW, nozzleH, 3, 243, 246, 255, 0.96);
  canvas.fillRoundedRect(canX + 4, canY + nozzleH + 2, canW - 8, Math.round(canH * 0.16), 4, 0, 245, 212, 0.95);
  canvas.fillRoundedRect(canX, canY + Math.round(canH * 0.32), canW, Math.round(canH * 0.68), 7, 24, 34, 58, 0.96);
  canvas.strokeRoundedRect(canX, canY + Math.round(canH * 0.32), canW, Math.round(canH * 0.68), 7, 2, 0, 245, 212, 0.9);
  canvas.fillRect(canX + 5, canY + Math.round(canH * 0.56), canW - 10, Math.round(canH * 0.18), 255, 62, 127, 0.96);
  // Subtle voxel spray mist pixels
  canvas.fillRect(canX - 10, canY - 2, 5, 5, 0, 245, 212, 0.9);
  canvas.fillRect(canX - 18, canY - 8, 4, 4, 255, 62, 127, 0.85);
  canvas.fillRect(canX - 14, canY + 6, 4, 4, 255, 209, 102, 0.85);

  // Centered SPRAY.LAND logotype with subtle cyan/magenta depth glow
  const textX = canX + canW + gap;
  const textY = Math.round(cy - (7 * textScale) / 2);
  canvas.drawText(word, textX + 3, textY + 3, textScale, 0, 245, 212, 0.34, 1);
  canvas.drawText(word, textX - 2, textY + 2, textScale, 255, 62, 127, 0.24, 1);
  canvas.drawText(word, textX, textY, textScale, 255, 255, 255, 0.98, 1);

  if (isHero) {
    const sub = '3D AR GRAFFITI & VIRTUAL LAND';
    const subScale = 2.6;
    const subW = sub.length * 6 * subScale;
    canvas.drawText(sub, Math.round(cx - subW / 2), cy + 68, subScale, 152, 238, 224, 0.9, 1);
  }
}

/**
 * Renders the default logo-only 1200x630 PNG (used when a land holder turns off
 * the land share preview image — just the SPRAY.LAND logotype centered on brand backdrop).
 */
export async function renderBrandLogoOgPng() {
  const canvas = createCanvas(OG_WIDTH, OG_HEIGHT);
  paintMidnightBackdrop(canvas, { spotlightX: 600, spotlightY: 315 });
  canvas.strokeRoundedRect(24, 24, OG_WIDTH - 48, OG_HEIGHT - 48, 22, 2, 0, 245, 212, 0.32);
  drawCenteredSprayLandLogotype(canvas, { variant: 'hero' });
  return encodeCanvasPng(canvas);
}

/**
 * Renders a crisp 1200x630 PNG Open Graph preview image for a specific SPRAY.LAND parcel:
 * - In `'logo'` mode: renders just the centered SPRAY.LAND logo card.
 * - In `'auto'` mode: renders a full-bleed low-angle isometric shot fitting many sculptures
 *   inside the land prism with the SPRAY.LAND logotype centered squarely in the middle.
 */
export async function renderLandOgPng({ parcel = null, sculptures = [], mode = '' } = {}) {
  const resolvedMode = normalizeLandOgImageMode(
    mode || parcel?.ogImageMode || parcel?.settings?.ogImageMode
  );
  if (resolvedMode === 'logo') {
    return renderBrandLogoOgPng();
  }

  const canvas = createCanvas(OG_WIDTH, OG_HEIGHT);
  const landName = resolveLandDisplayName(parcel || {}, { defaultName: 'Virtual Land' });
  const vol = parcel?.volume || {};
  const wM = Math.max(4, Number(vol.widthMeters || 18));
  const dM = Math.max(4, Number(vol.depthMeters || 18));
  const hM = Math.max(4, Number(vol.heightMeters || 16));
  const isFrozen = Boolean(parcel?.frozen);
  const visibleSculptures = (sculptures || []).filter((s) => s && !s.hidden);

  // 1. Deep midnight backdrop with dramatic center spotlight
  paintMidnightBackdrop(canvas, { isFrozen, spotlightX: 600, spotlightY: 370 });

  // 2. Full-bleed LOW-ANGLE ISOMETRIC shot of the land fitting many sculptures across the frame
  const prismCx = 600;
  const prismBaseY = 486;
  const maxHoriz = Math.max(wM, dM, 10);
  const scaleX = 335 / maxHoriz;
  const scaleY = Math.min(245 / Math.max(hM, 8), scaleX * 1.05);
  const halfW = (wM * scaleX) / 2;
  const halfD = (dM * scaleX) / 2;
  const prismH = Math.max(96, Math.min(265, hM * scaleY));

  // Low-angle isometric projection (shallow ~22 deg pitch: wider floor span, strong vertical presence)
  const projectLowIso = (lx, ly, lz) => {
    const sx = prismCx + (lx - lz) * 0.92;
    const sy = prismBaseY + (lx + lz) * 0.27 - ly * 0.96;
    return [sx, sy];
  };

  // Extended low-angle ground grid
  const gridPad = Math.max(halfW, halfD) * 1.45;
  for (let i = -5; i <= 5; i += 1) {
    const t = (i / 5) * gridPad;
    const a1 = projectLowIso(-gridPad, 0, t);
    const a2 = projectLowIso(gridPad, 0, t);
    canvas.drawLine(a1[0], a1[1], a2[0], a2[1], 1, 0, 245, 212, 0.14);
    const b1 = projectLowIso(t, 0, -gridPad);
    const b2 = projectLowIso(t, 0, gridPad);
    canvas.drawLine(b1[0], b1[1], b2[0], b2[1], 1, 0, 245, 212, 0.14);
  }

  const b0 = projectLowIso(-halfW, 0, -halfD);
  const b1 = projectLowIso(halfW, 0, -halfD);
  const b2 = projectLowIso(halfW, 0, halfD);
  const b3 = projectLowIso(-halfW, 0, halfD);
  const t0 = projectLowIso(-halfW, prismH, -halfD);
  const t1 = projectLowIso(halfW, prismH, -halfD);
  const t2 = projectLowIso(halfW, prismH, halfD);
  const t3 = projectLowIso(-halfW, prismH, halfD);

  const wireRgb = isFrozen ? [125, 211, 252] : [255, 31, 143];
  const accentRgb = [0, 245, 212];

  // Translucent floor & back walls
  canvas.fillPolygon([b0, b1, b2, b3], accentRgb[0], accentRgb[1], accentRgb[2], 0.24);
  canvas.fillPolygon([b0, b1, t1, t0], wireRgb[0], wireRgb[1], wireRgb[2], 0.06);
  canvas.fillPolygon([b0, b3, t3, t0], accentRgb[0], accentRgb[1], accentRgb[2], 0.05);

  // Back wireframe edges (softer)
  canvas.drawLine(b0[0], b0[1], b1[0], b1[1], 2, wireRgb[0], wireRgb[1], wireRgb[2], 0.45);
  canvas.drawLine(b0[0], b0[1], b3[0], b3[1], 2, wireRgb[0], wireRgb[1], wireRgb[2], 0.45);
  canvas.drawLine(b0[0], b0[1], t0[0], t0[1], 2, wireRgb[0], wireRgb[1], wireRgb[2], 0.36);

  const drawMiniIsoCube = (cx, cy, cz, cubeSize, rgb) => {
    const hs = cubeSize / 2;
    const pTop = [
      projectLowIso(cx - hs, cy + cubeSize, cz - hs),
      projectLowIso(cx + hs, cy + cubeSize, cz - hs),
      projectLowIso(cx + hs, cy + cubeSize, cz + hs),
      projectLowIso(cx - hs, cy + cubeSize, cz + hs)
    ];
    const pLeft = [
      projectLowIso(cx - hs, cy, cz + hs),
      projectLowIso(cx + hs, cy, cz + hs),
      projectLowIso(cx + hs, cy + cubeSize, cz + hs),
      projectLowIso(cx - hs, cy + cubeSize, cz + hs)
    ];
    const pRight = [
      projectLowIso(cx + hs, cy, cz + hs),
      projectLowIso(cx + hs, cy, cz - hs),
      projectLowIso(cx + hs, cy + cubeSize, cz - hs),
      projectLowIso(cx + hs, cy + cubeSize, cz + hs)
    ];
    canvas.fillPolygon(pTop, Math.min(255, rgb[0] + 35), Math.min(255, rgb[1] + 35), Math.min(255, rgb[2] + 35), 0.96);
    canvas.fillPolygon(pLeft, rgb[0], rgb[1], rgb[2], 0.92);
    canvas.fillPolygon(pRight, Math.round(rgb[0] * 0.7), Math.round(rgb[1] * 0.7), Math.round(rgb[2] * 0.7), 0.92);
  };

  // Render up to 16 sculptures back-to-front inside the low-angle isometric land volume
  if (visibleSculptures.length > 0) {
    const palette = [
      [0, 245, 212],
      [255, 209, 102],
      [255, 62, 127],
      [56, 189, 248],
      [168, 85, 247],
      [52, 211, 153]
    ];
    const count = Math.min(visibleSculptures.length, 16);
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const sc = visibleSculptures[i];
      const ao = sc?.anchorOffset || {};
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const ring = count > 6 && i % 2 === 1 ? 0.68 : 0.44;
      const spreadR = count === 1 ? 0 : Math.min(halfW, halfD) * ring;
      const lx =
        Number.isFinite(Number(ao.dx)) && Math.abs(Number(ao.dx)) > 0.05
          ? Math.max(-halfW * 0.76, Math.min(halfW * 0.76, Number(ao.dx) * scaleX))
          : Math.cos(angle) * spreadR;
      const lz =
        Number.isFinite(Number(ao.dz)) && Math.abs(Number(ao.dz)) > 0.05
          ? Math.max(-halfD * 0.76, Math.min(halfD * 0.76, Number(ao.dz) * scaleX))
          : Math.sin(angle) * spreadR;
      const ly = Math.max(0, Math.min(prismH * 0.5, Number(ao.dy || 0) * scaleY));
      items.push({ sc, i, lx, ly, lz });
    }
    items.sort((a, b) => a.lx + a.lz - (b.lx + b.lz));

    for (const { sc, i, lx, ly, lz } of items) {
      const vox = Array.isArray(sc.voxels) ? sc.voxels : [];
      const baseRgb = vox[0]?.color
        ? parseHexRgb(vox[0].color, palette[i % palette.length])
        : palette[i % palette.length];
      const topRgb = vox[Math.floor(vox.length / 2)]?.color
        ? parseHexRgb(vox[Math.floor(vox.length / 2)].color, [255, 209, 102])
        : palette[(i + 1) % palette.length];
      const sz = count <= 2 ? 46 : count <= 6 ? 34 : 24;
      drawMiniIsoCube(lx, ly + 2, lz, sz, baseRgb);
      drawMiniIsoCube(lx + sz * 0.12, ly + 2 + sz, lz - sz * 0.12, sz * 0.74, topRgb);
      if (count <= 4) {
        drawMiniIsoCube(lx - sz * 0.68, ly + 2, lz + sz * 0.34, sz * 0.58, palette[(i + 2) % palette.length]);
      }
    }
  } else {
    drawMiniIsoCube(0, 6, 0, 44, [0, 245, 212]);
    drawMiniIsoCube(0, 52, 0, 28, [255, 209, 102]);
  }

  // Front prism wireframe edges & glowing corner nodes
  const frontEdges = [
    [b1, b2],
    [b2, b3],
    [b1, t1],
    [b2, t2],
    [b3, t3],
    [t0, t1],
    [t1, t2],
    [t2, t3],
    [t3, t0]
  ];
  for (const [pA, pB] of frontEdges) {
    canvas.drawLine(pA[0], pA[1], pB[0], pB[1], 3, wireRgb[0], wireRgb[1], wireRgb[2], 0.9);
  }
  for (const pt of [t0, t1, t2, t3, b2]) {
    canvas.fillCircle(pt[0], pt[1], 5, 255, 255, 255, 0.95);
    canvas.fillCircle(pt[0], pt[1], 3, accentRgb[0], accentRgb[1], accentRgb[2], 1);
  }

  // Subtle corner frame & compact land metadata strip (keeping center open for the SPRAY.LAND logotype)
  canvas.strokeRoundedRect(20, 20, OG_WIDTH - 40, OG_HEIGHT - 40, 22, 2, 0, 245, 212, 0.26);
  const wFt = Math.round(wM * FEET_PER_METER);
  const dFt = Math.round(dM * FEET_PER_METER);
  const hFt = Math.round(hM * FEET_PER_METER);
  const topLabel = wrapUpperLines(landName, 26, 1)[0];
  const topPillW = Math.min(620, Math.max(240, topLabel.length * 19 + 46));
  canvas.fillRoundedRect(44, 40, topPillW, 48, 16, 6, 10, 22, 0.78);
  canvas.strokeRoundedRect(44, 40, topPillW, 48, 16, 1.5, wireRgb[0], wireRgb[1], wireRgb[2], 0.65);
  canvas.drawText(topLabel, 66, 54, 3.0, 255, 255, 255, 0.98, 1);

  const artChip =
    visibleSculptures.length > 0
      ? `${visibleSculptures.length} 3D ARTWORK${visibleSculptures.length === 1 ? '' : 'S'}`
      : 'OPEN FOR 3D ART';
  const bottomMeta = `${wFt}X${dFt}X${hFt} FT | ${artChip}`;
  const botPillW = Math.min(540, bottomMeta.length * 14 + 44);
  canvas.fillRoundedRect(44, OG_HEIGHT - 84, botPillW, 40, 14, 6, 10, 22, 0.76);
  canvas.strokeRoundedRect(44, OG_HEIGHT - 84, botPillW, 40, 14, 1.5, 0, 245, 212, 0.45);
  canvas.drawText(bottomMeta, 64, OG_HEIGHT - 72, 2.2, 206, 244, 240, 0.96, 1);

  const ownerHandle = String(parcel?.ownerUsername || parcel?.stewardUsername || '').trim();
  const rightTag = ownerHandle ? `@${ownerHandle.slice(0, 18)}` : 'VIRTUAL LAND';
  const rightTagW = rightTag.length * 14 + 38;
  canvas.fillRoundedRect(OG_WIDTH - 44 - rightTagW, OG_HEIGHT - 84, rightTagW, 40, 14, 6, 10, 22, 0.76);
  canvas.drawText(rightTag, OG_WIDTH - 44 - rightTagW + 19, OG_HEIGHT - 72, 2.2, 255, 225, 148, 0.95, 1);

  // 3. Official SPRAY.LAND logotype centered squarely in the middle over the land preview
  drawCenteredSprayLandLogotype(canvas, { variant: 'overlay' });

  return encodeCanvasPng(canvas);
}

/**
 * Renders a crisp 1200x630 PNG Open Graph preview image for an individual 3D sculpture
 * with the official SPRAY.LAND logotype centered squarely in the middle.
 */
export async function renderSculptureOgPng({ sculpture = null, parcel = null } = {}) {
  const canvas = createCanvas(OG_WIDTH, OG_HEIGHT);
  const title = String(sculpture?.title || '3D Artwork').trim();
  const landName = parcel
    ? resolveLandDisplayName(parcel, { defaultName: 'SPRAY.LAND' })
    : String(sculpture?.parcelName || 'SPRAY.LAND');
  const voxels = Array.isArray(sculpture?.voxels) ? sculpture.voxels : [];

  paintMidnightBackdrop(canvas, { spotlightX: 600, spotlightY: 320 });

  const cx = 600;
  const cy = 345;
  const drawIsoVoxel = (sx, sy, size, rgb) => {
    const hw = size * 0.866;
    const hh = size * 0.46;
    const bh = size * 0.9;
    canvas.fillPolygon(
      [[sx, sy - bh - hh], [sx + hw, sy - bh], [sx, sy - bh + hh], [sx - hw, sy - bh]],
      Math.min(255, rgb[0] + 35),
      Math.min(255, rgb[1] + 35),
      Math.min(255, rgb[2] + 35),
      0.95
    );
    canvas.fillPolygon(
      [[sx - hw, sy - bh], [sx, sy - bh + hh], [sx, sy + hh], [sx - hw, sy]],
      rgb[0],
      rgb[1],
      rgb[2],
      0.92
    );
    canvas.fillPolygon(
      [[sx + hw, sy - bh], [sx, sy - bh + hh], [sx, sy + hh], [sx + hw, sy]],
      Math.round(rgb[0] * 0.68),
      Math.round(rgb[1] * 0.68),
      Math.round(rgb[2] * 0.68),
      0.92
    );
  };

  if (voxels.length > 0) {
    const maxSample = 140;
    const step = voxels.length > maxSample ? Math.ceil(voxels.length / maxSample) : 1;
    const pts = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < voxels.length; i += step) {
      const v = voxels[i];
      const vx = Number(v?.x);
      const vy = Number(v?.y);
      const vz = Number(v?.z);
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) continue;
      pts.push({ x: vx, y: vy, z: vz, rgb: parseHexRgb(v.color, [0, 245, 212]) });
      if (vx < minX) minX = vx;
      if (vx > maxX) maxX = vx;
      if (vy < minY) minY = vy;
      if (vy > maxY) maxY = vy;
      if (vz < minZ) minZ = vz;
      if (vz > maxZ) maxZ = vz;
    }
    if (pts.length > 0) {
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      const midZ = (minZ + maxZ) / 2;
      const span = Math.max(0.25, maxX - minX, maxY - minY, maxZ - minZ);
      const unit = Math.min(260 / span, 220);
      const blockSize = Math.max(10, Math.min(36, 220 / Math.max(3, Math.cbrt(pts.length) * 1.4)));
      pts.sort((a, b) => a.x + a.z + a.y * 0.5 - (b.x + b.z + b.y * 0.5));
      for (const p of pts) {
        const nx = (p.x - midX) * unit;
        const ny = (p.y - midY) * unit;
        const nz = (p.z - midZ) * unit;
        const sx = cx + (nx - nz) * 0.866;
        const sy = cy + (nx + nz) * 0.44 - ny;
        drawIsoVoxel(sx, sy, blockSize, p.rgb);
      }
    }
  } else {
    // Sleek glowing 3D model monument pedestal when sculpture is a custom GLB/OBJ/STL/PLY asset
    drawIsoVoxel(cx, cy + 70, 92, [20, 44, 72]);
    drawIsoVoxel(cx, cy - 20, 74, [0, 245, 212]);
    drawIsoVoxel(cx + 22, cy - 86, 48, [255, 62, 127]);
    drawIsoVoxel(cx - 48, cy - 34, 42, [255, 209, 102]);
  }

  canvas.strokeRoundedRect(20, 20, OG_WIDTH - 40, OG_HEIGHT - 40, 22, 2, 0, 245, 212, 0.28);

  const titleLine = wrapUpperLines(title, 28, 1)[0];
  const titleW = Math.min(640, Math.max(220, titleLine.length * 18 + 44));
  canvas.fillRoundedRect(44, 40, titleW, 46, 15, 6, 10, 22, 0.8);
  canvas.strokeRoundedRect(44, 40, titleW, 46, 15, 1.5, 0, 245, 212, 0.55);
  canvas.drawText(titleLine, 64, 53, 2.8, 255, 255, 255, 0.98, 1);

  const metaLine = wrapUpperLines(`ON ${landName}`, 32, 1)[0];
  const metaW = Math.min(580, Math.max(200, metaLine.length * 14 + 44));
  canvas.fillRoundedRect(44, OG_HEIGHT - 84, metaW, 40, 14, 6, 10, 22, 0.78);
  canvas.drawText(metaLine, 64, OG_HEIGHT - 72, 2.2, 180, 245, 236, 0.95, 1);

  // Centered SPRAY.LAND logotype over the sculpture preview
  drawCenteredSprayLandLogotype(canvas, { variant: 'overlay' });

  return encodeCanvasPng(canvas);
}

/**
 * Builds an Open Graph + Twitter/X Card HTML page for a specific land parcel so X, Facebook,
 * Discord, Slack & iMessage render a freshly generated 1200x630 PNG OG preview with the
 * centered SPRAY.LAND logotype while human browsers jump straight to the live land on SPRAY.LAND.
 */
export function buildLandSharePageHtml({
  parcelId = '',
  parcel = null,
  sculptures = [],
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev',
  publicUrl = 'https://spray.land'
} = {}) {
  const cleanPid = String(parcel?.parcelId || parcelId || '').trim().toUpperCase();
  const landName = resolveLandDisplayName(parcel || {}, { defaultName: 'Virtual Land' });
  const visibleCount = (sculptures || []).filter((s) => s && !s.hidden).length;
  const targetAppUrl = buildParcelShareUrl({
    origin: publicUrl,
    pathname: '/',
    parcelId: cleanPid,
    customName: parcel?.customName || landName,
    compact: true
  });
  const slug = slugifyLandTitle(parcel?.customName || landName);
  const cleanApiOrigin = String(apiOrigin || '').replace(/\/+$/, '');
  const sharePageUrl = `${cleanApiOrigin}/share/land/${encodeURIComponent(cleanPid)}${
    slug ? `?slug=${encodeURIComponent(slug)}` : ''
  }`;
  const contentSig = computeLandOgContentSig({ parcel, sculptures });
  const updatedStamp = String(
    parcel?.ogPreviewUpdatedAt || parcel?.settings?.ogPreviewUpdatedAt || ''
  ).replace(/[^0-9]/g, '').slice(-10);
  const ogVersion = updatedStamp ? `${contentSig}-${updatedStamp}` : contentSig;
  const ogImageUrl = `${cleanApiOrigin}/api/og/land/${encodeURIComponent(cleanPid)}.png?v=${encodeURIComponent(ogVersion)}`;

  const ogTitle = `${landName} — View & Build in 3D on SPRAY.LAND`;
  const ogDescription =
    visibleCount > 0
      ? `Explore ${landName} (${visibleCount} 3D artwork${visibleCount === 1 ? '' : 's'}) on SPRAY.LAND. View it in 3D, add your own art, or hand this land to your AI agent to add 3D models.`
      : `Explore ${landName} on SPRAY.LAND. View it in 3D, add your own art, or hand this land to your AI agent to add 3D models.`;

  const safeTitle = escapeHtmlAttr(ogTitle);
  const safeDesc = escapeHtmlAttr(ogDescription);
  const safeImage = escapeHtmlAttr(ogImageUrl);
  const safeShareUrl = escapeHtmlAttr(sharePageUrl);
  const safeAppUrl = escapeHtmlAttr(targetAppUrl);
  const safeLandName = escapeHtmlAttr(landName);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDesc}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="SPRAY.LAND" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDesc}" />
    <meta property="og:url" content="${safeShareUrl}" />
    <meta property="og:image" content="${safeImage}" />
    <meta property="og:image:secure_url" content="${safeImage}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="${OG_WIDTH}" />
    <meta property="og:image:height" content="${OG_HEIGHT}" />
    <meta property="og:image:alt" content="${safeLandName} — 3D Virtual Land on SPRAY.LAND" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@sprayland" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDesc}" />
    <meta name="twitter:image" content="${safeImage}" />
    <meta name="twitter:image:alt" content="${safeLandName} — 3D Virtual Land on SPRAY.LAND" />
    <meta http-equiv="refresh" content="0;url=${safeAppUrl}" />
    <link rel="canonical" href="${safeAppUrl}" />
    <script>window.location.replace(${JSON.stringify(targetAppUrl)});</script>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #060a14; color: #f3f6ff; font-family: system-ui, sans-serif; }
      a { color: #00f5d4; font-weight: 700; }
    </style>
  </head>
  <body>
    <p>Opening <strong>${safeLandName}</strong> on <a href="${safeAppUrl}">SPRAY.LAND</a>…</p>
  </body>
</html>`;
}

/**
 * Builds an Open Graph + Twitter/X Card HTML page for a specific 3D sculpture so X, Facebook,
 * Discord, and iMessage render its 1200x630 PNG preview with centered SPRAY.LAND logotype
 * while human visitors jump straight to the artwork on SPRAY.LAND.
 */
export function buildSculptureSharePageHtml({
  sculptureId = '',
  sculpture = null,
  parcel = null,
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev',
  publicUrl = 'https://spray.land'
} = {}) {
  const cleanId = String(sculpture?.id || sculptureId || '').trim();
  const title = String(sculpture?.title || '3D Artwork').trim();
  const landName = parcel
    ? resolveLandDisplayName(parcel, { defaultName: 'SPRAY.LAND' })
    : String(sculpture?.parcelName || 'SPRAY.LAND');
  const cleanPublic = String(publicUrl || 'https://spray.land').replace(/\/+$/, '');
  const cleanApiOrigin = String(apiOrigin || '').replace(/\/+$/, '');
  const targetAppUrl = `${cleanPublic}/?sculpture=${encodeURIComponent(cleanId)}`;
  const sharePageUrl = `${cleanApiOrigin}/share/sculpture/${encodeURIComponent(cleanId)}`;
  const contentSig = computeSculptureOgContentSig({ sculpture, parcel });
  const ogImageUrl = `${cleanApiOrigin}/api/og/sculpture/${encodeURIComponent(cleanId)}.png?v=${encodeURIComponent(contentSig)}`;

  const ogTitle = `${title} on ${landName} — 3D AR Artwork on SPRAY.LAND`;
  const ogDescription = sculpture?.description
    ? String(sculpture.description).trim().slice(0, 220)
    : `Inspect "${title}" anchored on ${landName} in 3D & Mobile AR on SPRAY.LAND.`;

  const safeTitle = escapeHtmlAttr(ogTitle);
  const safeDesc = escapeHtmlAttr(ogDescription);
  const safeImage = escapeHtmlAttr(ogImageUrl);
  const safeShareUrl = escapeHtmlAttr(sharePageUrl);
  const safeAppUrl = escapeHtmlAttr(targetAppUrl);
  const safeArtTitle = escapeHtmlAttr(title);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDesc}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="SPRAY.LAND" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDesc}" />
    <meta property="og:url" content="${safeShareUrl}" />
    <meta property="og:image" content="${safeImage}" />
    <meta property="og:image:secure_url" content="${safeImage}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="${OG_WIDTH}" />
    <meta property="og:image:height" content="${OG_HEIGHT}" />
    <meta property="og:image:alt" content="${safeArtTitle} — 3D AR Artwork on SPRAY.LAND" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@sprayland" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDesc}" />
    <meta name="twitter:image" content="${safeImage}" />
    <meta name="twitter:image:alt" content="${safeArtTitle} — 3D AR Artwork on SPRAY.LAND" />
    <meta http-equiv="refresh" content="0;url=${safeAppUrl}" />
    <link rel="canonical" href="${safeAppUrl}" />
    <script>window.location.replace(${JSON.stringify(targetAppUrl)});</script>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #060a14; color: #f3f6ff; font-family: system-ui, sans-serif; }
      a { color: #00f5d4; font-weight: 700; }
    </style>
  </head>
  <body>
    <p>Opening <strong>${safeArtTitle}</strong> on <a href="${safeAppUrl}">SPRAY.LAND</a>…</p>
  </body>
</html>`;
}
