import { buildParcelShareUrl, resolveLandDisplayName, slugifyLandTitle } from './landVolume.mjs';

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const FEET_PER_METER = 3.28084;

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

/**
 * Renders a crisp 1200x630 PNG Open Graph preview image for a specific SPRAY.LAND parcel,
 * showing the land's name, 3D isometric wireframe prism, anchored artworks, and clear CTA.
 */
export async function renderLandOgPng({ parcel = null, sculptures = [] } = {}) {
  const canvas = createCanvas(OG_WIDTH, OG_HEIGHT);
  const landName = resolveLandDisplayName(parcel || {}, { defaultName: 'Virtual Land' });
  const vol = parcel?.volume || {};
  const wM = Math.max(4, Number(vol.widthMeters || 18));
  const dM = Math.max(4, Number(vol.depthMeters || 18));
  const hM = Math.max(4, Number(vol.heightMeters || 16));
  const isFrozen = Boolean(parcel?.frozen);
  const visibleSculptures = (sculptures || []).filter((s) => s && !s.hidden);

  // 1. Deep dark space gradient background with subtle cyan & magenta radial glow
  for (let y = 0; y < OG_HEIGHT; y += 1) {
    const ty = y / OG_HEIGHT;
    for (let x = 0; x < OG_WIDTH; x += 1) {
      const tx = x / OG_WIDTH;
      // Base midnight gradient
      let r = 6 + tx * 8 + ty * 6;
      let g = 10 + tx * 12 + ty * 9;
      let b = 22 + tx * 18 + ty * 14;

      // Cyan spotlight behind isometric land prism (right side)
      const dxC = (x - 890) / 340;
      const dyC = (y - 310) / 260;
      const glowC = Math.max(0, 1 - (dxC * dxC + dyC * dyC));
      r += glowC * glowC * (isFrozen ? 20 : 0);
      g += glowC * glowC * (isFrozen ? 45 : 58);
      b += glowC * glowC * (isFrozen ? 72 : 62);

      // Magenta accent glow top-left
      const dxM = (x - 160) / 360;
      const dyM = (y - 90) / 240;
      const glowM = Math.max(0, 1 - (dxM * dxM + dyM * dyM));
      r += glowM * glowM * 42;
      g += glowM * glowM * 8;
      b += glowM * glowM * 36;

      const idx = (y * OG_WIDTH + x) * 4;
      canvas.buf[idx] = Math.min(255, Math.round(r));
      canvas.buf[idx + 1] = Math.min(255, Math.round(g));
      canvas.buf[idx + 2] = Math.min(255, Math.round(b));
      canvas.buf[idx + 3] = 255;
    }
  }

  // Subtle architectural grid lines
  for (let gx = 48; gx < OG_WIDTH; gx += 72) {
    canvas.drawLine(gx, 0, gx, OG_HEIGHT, 1, 148, 163, 184, 0.055);
  }
  for (let gy = 48; gy < OG_HEIGHT; gy += 72) {
    canvas.drawLine(0, gy, OG_WIDTH, gy, 1, 148, 163, 184, 0.055);
  }

  // Outer card frame border
  canvas.strokeRoundedRect(24, 24, OG_WIDTH - 48, OG_HEIGHT - 48, 22, 2, 0, 245, 212, 0.28);

  // 2. Right side: 3D Isometric Land Prism + Sculptures Preview
  const prismCx = 895;
  const prismBaseY = 455;
  const maxHoriz = Math.max(wM, dM, 10);
  const scaleX = 160 / maxHoriz;
  const scaleY = Math.min(185 / Math.max(hM, 8), scaleX * 1.15);
  const halfW = (wM * scaleX) / 2;
  const halfD = (dM * scaleX) / 2;
  const prismH = Math.max(76, Math.min(210, hM * scaleY));

  const projectIso = (lx, ly, lz) => {
    const sx = prismCx + (lx - lz) * 0.866;
    const sy = prismBaseY + (lx + lz) * 0.44 - ly;
    return [sx, sy];
  };

  // Ground grid under the land
  const gridPad = Math.max(halfW, halfD) * 1.38;
  for (let i = -3; i <= 3; i += 1) {
    const t = (i / 3) * gridPad;
    const a1 = projectIso(-gridPad, 0, t);
    const a2 = projectIso(gridPad, 0, t);
    canvas.drawLine(a1[0], a1[1], a2[0], a2[1], 1, 0, 245, 212, 0.14);
    const b1 = projectIso(t, 0, -gridPad);
    const b2 = projectIso(t, 0, gridPad);
    canvas.drawLine(b1[0], b1[1], b2[0], b2[1], 1, 0, 245, 212, 0.14);
  }

  // 8 corners of the isometric land prism
  const b0 = projectIso(-halfW, 0, -halfD);
  const b1 = projectIso(halfW, 0, -halfD);
  const b2 = projectIso(halfW, 0, halfD);
  const b3 = projectIso(-halfW, 0, halfD);
  const t0 = projectIso(-halfW, prismH, -halfD);
  const t1 = projectIso(halfW, prismH, -halfD);
  const t2 = projectIso(halfW, prismH, halfD);
  const t3 = projectIso(-halfW, prismH, halfD);

  const wireRgb = isFrozen ? [125, 211, 252] : [255, 31, 143];
  const accentRgb = [0, 245, 212];

  // Translucent shaded floor & walls
  canvas.fillPolygon([b0, b1, b2, b3], accentRgb[0], accentRgb[1], accentRgb[2], 0.22);
  canvas.fillPolygon([b3, b2, t2, t3], wireRgb[0], wireRgb[1], wireRgb[2], 0.08);
  canvas.fillPolygon([b2, b1, t1, t2], accentRgb[0], accentRgb[1], accentRgb[2], 0.07);
  canvas.fillPolygon([t0, t1, t2, t3], accentRgb[0], accentRgb[1], accentRgb[2], 0.06);

  // Back wireframe edges (softer)
  canvas.drawLine(b0[0], b0[1], b1[0], b1[1], 2, wireRgb[0], wireRgb[1], wireRgb[2], 0.45);
  canvas.drawLine(b0[0], b0[1], b3[0], b3[1], 2, wireRgb[0], wireRgb[1], wireRgb[2], 0.45);
  canvas.drawLine(b0[0], b0[1], t0[0], t0[1], 2, wireRgb[0], wireRgb[1], wireRgb[2], 0.38);

  // Sculptures inside the isometric prism
  const drawMiniIsoCube = (cx, cy, cz, cubeSize, rgb) => {
    const hs = cubeSize / 2;
    const pTop = [
      projectIso(cx - hs, cy + cubeSize, cz - hs),
      projectIso(cx + hs, cy + cubeSize, cz - hs),
      projectIso(cx + hs, cy + cubeSize, cz + hs),
      projectIso(cx - hs, cy + cubeSize, cz + hs)
    ];
    const pLeft = [
      projectIso(cx - hs, cy, cz + hs),
      projectIso(cx + hs, cy, cz + hs),
      projectIso(cx + hs, cy + cubeSize, cz + hs),
      projectIso(cx - hs, cy + cubeSize, cz + hs)
    ];
    const pRight = [
      projectIso(cx + hs, cy, cz + hs),
      projectIso(cx + hs, cy, cz - hs),
      projectIso(cx + hs, cy + cubeSize, cz - hs),
      projectIso(cx + hs, cy + cubeSize, cz + hs)
    ];
    canvas.fillPolygon(pTop, Math.min(255, rgb[0] + 35), Math.min(255, rgb[1] + 35), Math.min(255, rgb[2] + 35), 0.96);
    canvas.fillPolygon(pLeft, rgb[0], rgb[1], rgb[2], 0.92);
    canvas.fillPolygon(pRight, Math.round(rgb[0] * 0.72), Math.round(rgb[1] * 0.72), Math.round(rgb[2] * 0.72), 0.92);
  };

  if (visibleSculptures.length > 0) {
    const palette = [
      [0, 245, 212],
      [255, 209, 102],
      [255, 62, 127],
      [56, 189, 248],
      [168, 85, 247]
    ];
    const count = Math.min(visibleSculptures.length, 6);
    for (let i = 0; i < count; i += 1) {
      const sc = visibleSculptures[i];
      const ao = sc?.anchorOffset || {};
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const spreadR = count === 1 ? 0 : Math.min(halfW, halfD) * 0.42;
      const lx = Number.isFinite(Number(ao.dx)) && Math.abs(Number(ao.dx)) > 0.05
        ? Math.max(-halfW * 0.7, Math.min(halfW * 0.7, Number(ao.dx) * scaleX))
        : Math.cos(angle) * spreadR;
      const lz = Number.isFinite(Number(ao.dz)) && Math.abs(Number(ao.dz)) > 0.05
        ? Math.max(-halfD * 0.7, Math.min(halfD * 0.7, Number(ao.dz) * scaleX))
        : Math.sin(angle) * spreadR;

      // Render stacked isometric art preview cluster (using voxel colors when present)
      const vox = Array.isArray(sc.voxels) ? sc.voxels : [];
      const baseRgb = vox[0]?.color ? parseHexRgb(vox[0].color, palette[i % palette.length]) : palette[i % palette.length];
      const topRgb = vox[Math.floor(vox.length / 2)]?.color
        ? parseHexRgb(vox[Math.floor(vox.length / 2)].color, [255, 209, 102])
        : palette[(i + 1) % palette.length];
      const sz = count === 1 ? 34 : 24;
      drawMiniIsoCube(lx, 2, lz, sz, baseRgb);
      drawMiniIsoCube(lx + sz * 0.14, 2 + sz, lz - sz * 0.12, sz * 0.76, topRgb);
      if (count <= 2) {
        drawMiniIsoCube(lx - sz * 0.65, 2, lz + sz * 0.35, sz * 0.62, palette[(i + 2) % palette.length]);
      }
    }
  } else {
    // Open land glowing build beacon at center
    drawMiniIsoCube(0, 6, 0, 32, [0, 245, 212]);
    drawMiniIsoCube(0, 42, 0, 20, [255, 209, 102]);
  }

  // Front wireframe edges (crisp neon)
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
    canvas.drawLine(pA[0], pA[1], pB[0], pB[1], 3, wireRgb[0], wireRgb[1], wireRgb[2], 0.94);
  }
  // Glowing corner dots
  for (const pt of [t0, t1, t2, t3, b2]) {
    canvas.fillCircle(pt[0], pt[1], 5, 255, 255, 255, 0.95);
    canvas.fillCircle(pt[0], pt[1], 3, accentRgb[0], accentRgb[1], accentRgb[2], 1);
  }

  // 3. Left side: Brand Pill, Huge Property Name, Stats & Clear CTA
  const leftX = 70;

  // Top brand badge
  canvas.fillRoundedRect(leftX, 68, 355, 42, 21, 0, 245, 212, 0.16);
  canvas.strokeRoundedRect(leftX, 68, 355, 42, 21, 2, 0, 245, 212, 0.6);
  canvas.fillCircle(leftX + 24, 89, 6, 0, 245, 212, 1);
  canvas.drawText('SPRAY.LAND | VIRTUAL LAND', leftX + 42, 81, 2.2, 190, 255, 245, 1, 1);

  // Huge Property Name (1-2 wrapped lines)
  const nameLines = wrapUpperLines(landName, 14, 2);
  const titleScale = nameLines.length === 1 && nameLines[0].length <= 11 ? 8 : 6.5;
  let titleY = nameLines.length === 1 ? 168 : 146;
  for (const line of nameLines) {
    // Soft glow shadow
    canvas.drawText(line, leftX + 3, titleY + 3, titleScale, 0, 245, 212, 0.24, 1);
    canvas.drawText(line, leftX, titleY, titleScale, 255, 255, 255, 1, 1);
    titleY += Math.round(titleScale * 9.2);
  }

  // Real land specs chips
  const wFt = Math.round(wM * FEET_PER_METER);
  const dFt = Math.round(dM * FEET_PER_METER);
  const hFt = Math.round(hM * FEET_PER_METER);
  const dimsChip = `${wFt}X${dFt}X${hFt} FT`;
  const artChip =
    visibleSculptures.length > 0
      ? `${visibleSculptures.length} 3D ARTWORK${visibleSculptures.length === 1 ? '' : 'S'}`
      : 'OPEN FOR 3D ART';
  const ownerHandle = String(parcel?.ownerUsername || parcel?.stewardUsername || '').trim();
  const chipY = Math.max(305, titleY + 18);

  canvas.fillRoundedRect(leftX, chipY, 224, 38, 19, 255, 255, 255, 0.08);
  canvas.strokeRoundedRect(leftX, chipY, 224, 38, 19, 1.5, 255, 255, 255, 0.2);
  canvas.drawText(dimsChip, leftX + 18, chipY + 12, 2.2, 218, 232, 248, 1, 1);

  canvas.fillRoundedRect(leftX + 238, chipY, 268, 38, 19, 255, 209, 102, 0.14);
  canvas.strokeRoundedRect(leftX + 238, chipY, 268, 38, 19, 1.5, 255, 209, 102, 0.45);
  canvas.drawText(artChip, leftX + 256, chipY + 12, 2.2, 255, 227, 148, 1, 1);

  // Clear human + AI agent value prop lines
  const subY = chipY + 62;
  canvas.drawText('VIEW & ADD 3D ART ON THIS LAND', leftX, subY, 2.8, 224, 242, 254, 0.96, 1);
  canvas.drawText('OR SEND TO YOUR AI AGENT TO ADD MODELS', leftX, subY + 34, 2.5, 148, 238, 224, 0.95, 1);

  // Bottom CTA pill
  const ctaY = 514;
  canvas.fillRoundedRect(leftX, ctaY, 470, 54, 14, 0, 245, 212, 0.94);
  canvas.drawText('OPEN LAND ON SPRAY.LAND', leftX + 34, ctaY + 18, 2.7, 4, 16, 26, 1, 1);

  if (ownerHandle) {
    canvas.drawText(`LAND BY @${ownerHandle.slice(0, 18)}`, 740, 540, 2.2, 186, 208, 232, 0.85, 1);
  } else {
    canvas.drawText('MAKE FREE 3D LAND WITH GOOGLE', 695, 540, 2.1, 186, 208, 232, 0.85, 1);
  }

  // 4. Encode raw RGBA rows with PNG filter byte 0 per scanline + zlib deflate
  const stride = OG_WIDTH * 4;
  const raw = new Uint8Array(OG_HEIGHT * (stride + 1));
  for (let y = 0; y < OG_HEIGHT; y += 1) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0; // None filter
    raw.set(canvas.buf.subarray(y * stride, (y + 1) * stride), rowOff + 1);
  }

  const compressed = await deflateZlib(raw);

  // IHDR chunk (13 bytes)
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, OG_WIDTH, false);
  ihdrView.setUint32(4, OG_HEIGHT, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0; // deflate
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // non-interlaced

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

/**
 * Builds an Open Graph + Twitter Card HTML page for a specific land parcel so X / social crawlers
 * display the land's name and custom 1200x630 PNG OG preview image while human browsers jump straight
 * to the live land on SPRAY.LAND.
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
  const ogVersion = `${visibleCount}-${slug || 'v1'}`;
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
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="${OG_WIDTH}" />
    <meta property="og:image:height" content="${OG_HEIGHT}" />
    <meta name="twitter:card" content="summary_large_image" />
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
