import {
  MAX_AVATAR_DATA_URL_LEN,
  MAX_HEADER_DATA_URL_LEN,
  validateProfileImage
} from '../../../shared/profileRules.mjs';

const ALLOWED_FILE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif'
]);

const MAX_RAW_UPLOAD_BYTES = 12 * 1024 * 1024;

async function readFileAsDataUrl(file) {
  const Reader =
    typeof FileReader !== 'undefined'
      ? FileReader
      : typeof window !== 'undefined' && window.FileReader
        ? window.FileReader
        : null;
  if (Reader) {
    return new Promise((resolve, reject) => {
      const reader = new Reader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read selected image file.'));
      reader.readAsDataURL(file);
    });
  }
  if (typeof file.arrayBuffer === 'function') {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    const mime = file.type || 'image/png';
    return `data:${mime};base64,${btoa(bin)}`;
  }
  throw new Error('Could not read selected image file.');
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode selected image.'));
    img.src = src;
  });
}

/**
 * Center-crops and optimizes a user-selected image file for either:
 * - 'avatar' (bio image / profile icon): 256×256 crisp square
 * - 'header' (profile banner background): 960×320 crisp 3:1 widescreen banner
 * Safely falls back to raw raster Data URL in non-canvas test environments.
 * @param {File} file
 * @param {'avatar' | 'header'} [kind]
 * @returns {Promise<string>}
 */
export async function prepareProfileImageFile(file, kind = 'avatar') {
  if (!file) throw new Error('No image file selected.');

  const mime = String(file.type || '').toLowerCase();
  if (mime === 'image/svg+xml' || /\.svg$/i.test(String(file.name || ''))) {
    throw new Error('Please upload a PNG, JPEG, or WebP image (SVG is not allowed).');
  }
  if (mime && !ALLOWED_FILE_TYPES.has(mime)) {
    throw new Error('Unsupported file type. Use PNG, JPEG, or WebP.');
  }
  if (Number(file.size || 0) > MAX_RAW_UPLOAD_BYTES) {
    throw new Error('Image file is too large (max 12 MB before optimization).');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const maxLen = kind === 'header' ? MAX_HEADER_DATA_URL_LEN : MAX_AVATAR_DATA_URL_LEN;
  const targetW = kind === 'header' ? 960 : 256;
  const targetH = kind === 'header' ? 320 : 256;

  // Attempt smart client-side center-crop & compression via Canvas2D
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
  if (!isJsdom && typeof document !== 'undefined' && typeof Image !== 'undefined') {
    try {
      const img = await loadImageElement(rawDataUrl);
      const srcW = Number(img.naturalWidth || img.width || 0);
      const srcH = Number(img.naturalHeight || img.height || 0);
      if (srcW > 0 && srcH > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const targetAspect = targetW / targetH;
          const srcAspect = srcW / srcH;
          let sx = 0;
          let sy = 0;
          let sw = srcW;
          let sh = srcH;
          if (srcAspect > targetAspect) {
            sw = srcH * targetAspect;
            sx = (srcW - sw) / 2;
          } else {
            sh = srcW / targetAspect;
            sy = (srcH - sh) / 2;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

          // Try WebP first, then JPEG, stepping down quality if needed to fit payload budget
          const candidates = [
            ['image/webp', 0.86],
            ['image/webp', 0.74],
            ['image/jpeg', 0.84],
            ['image/jpeg', 0.72],
            ['image/jpeg', 0.58]
          ];
          for (const [outMime, q] of candidates) {
            const encoded = canvas.toDataURL(outMime, q);
            if (encoded.startsWith(`data:${outMime};base64,`) && encoded.length <= maxLen) {
              const check = validateProfileImage(encoded, { kind });
              if (check.ok) return check.value;
            }
          }
        }
      }
    } catch {
      // Fall through to raw validation below if browser decode fails
    }
  }

  const check = validateProfileImage(rawDataUrl, { kind });
  if (!check.ok) {
    throw new Error(check.error || 'Could not process image.');
  }
  return check.value;
}
