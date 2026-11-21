import { isValidPairingCodeFormat, normalizePairingCode } from '../../../shared/landSignatureMessage.mjs';

/**
 * Parses a scanned QR string or pasted link/code from GRAFFILAND Desktop.
 * Supports:
 *  - Full launch URL: https://.../graffiland/?pair=ABC123
 *  - Query fragment: ?pair=ABC123 or pair=ABC123
 *  - Plain 6-character desktop live-mirror code: ABC123
 *  - Robust MCP pairing code: GLP-XXXX-XXXX-XXXX-XXXX
 */
export function parseDesktopPairQrText(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return null;

  // 1) Try full URL parsing (?pair=... or #pair=...)
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      const qPair = (parsed.searchParams.get('pair') || '').trim().toUpperCase();
      if (/^[A-Z0-9]{6}$/.test(qPair)) {
        return { kind: 'desktop', code: qPair, raw: text };
      }
      const qMcp = normalizePairingCode(parsed.searchParams.get('mcp') || parsed.searchParams.get('pairingCode') || '');
      if (isValidPairingCodeFormat(qMcp)) {
        return { kind: 'mcp', code: qMcp, raw: text };
      }
    } catch {
      // fall through to regex matchers
    }
  }

  // 2) Match pair=XXXXXX inside partial links/queries
  const pairParamMatch = text.match(/(?:[?&#]|^)pair=([A-Za-z0-9]{6})(?:[^A-Za-z0-9]|$)/i);
  if (pairParamMatch) {
    return { kind: 'desktop', code: pairParamMatch[1].toUpperCase(), raw: text };
  }

  // 3) Match robust GLP-... MCP pairing code anywhere in payload
  const glpMatch = text.match(/GLP-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2,3}/i);
  if (glpMatch) {
    const norm = normalizePairingCode(glpMatch[0]);
    if (isValidPairingCodeFormat(norm)) {
      return { kind: 'mcp', code: norm, raw: text };
    }
  }

  // 4) Plain 6-char desktop pair code
  const compact = text.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(compact)) {
    return { kind: 'desktop', code: compact, raw: text };
  }

  return null;
}

let jsQrLoader = null;
let barcodeDetectorInstance = null;

async function getJsQr() {
  if (!jsQrLoader) {
    jsQrLoader = import('jsqr').then((m) => m.default || m);
  }
  return jsQrLoader;
}

function getNativeQrDetector() {
  if (barcodeDetectorInstance !== null) return barcodeDetectorInstance;
  try {
    if (typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function') {
      barcodeDetectorInstance = new window.BarcodeDetector({ formats: ['qr_code'] });
      return barcodeDetectorInstance;
    }
  } catch {
    // BarcodeDetector not supported for qr_code
  }
  barcodeDetectorInstance = false;
  return false;
}

/**
 * Decodes a QR code string from an HTMLCanvasElement.
 * Uses native BarcodeDetector when available and falls back to pure-JS jsQR (works on iOS Safari).
 */
export async function decodeQrFromCanvas(canvas, ctx) {
  if (!canvas || !ctx || canvas.width < 16 || canvas.height < 16) return '';
  const nativeDetector = getNativeQrDetector();
  if (nativeDetector) {
    try {
      const codes = await nativeDetector.detect(canvas);
      const first = codes?.find((c) => c?.rawValue);
      if (first?.rawValue) return String(first.rawValue).trim();
    } catch {
      // Fall back to jsQR below
    }
  }
  try {
    const jsQR = await getJsQr();
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = jsQR(imgData.data, imgData.width, imgData.height, {
      inversionAttempts: 'attemptBoth'
    });
    return decoded?.data ? String(decoded.data).trim() : '';
  } catch {
    return '';
  }
}

/**
 * Decodes a QR code from an uploaded or captured image File / Blob.
 */
export async function decodeQrFromImageFile(file) {
  if (!file) return '';
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read QR image file.'));
      el.src = url;
    });
    const maxDim = 768;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const width = Math.max(32, Math.round((img.naturalWidth || 320) * scale));
    const height = Math.max(32, Math.round((img.naturalHeight || 320) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    ctx.drawImage(img, 0, 0, width, height);
    return await decodeQrFromCanvas(canvas, ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}
