import lockupTransparent from '../../../brand/svg/sprayland-lockup-transparent.svg';
import {
  computeLandOgContentSig,
  computeSculptureOgContentSig,
  normalizeLandOgImageMode,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH
} from '../../../shared/landOgImage.mjs';
import { API_BASE } from './api.js';

export const RECOMMENDED_OG_DIMENSIONS = {
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  ratioLabel: '1.91:1'
};

let cachedLogoImgPromise = null;

function loadImage(src) {
  if (typeof Image === 'undefined' || !src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function getOfficialLogoImage() {
  if (!cachedLogoImgPromise) {
    cachedLogoImgPromise = loadImage(lockupTransparent).then((img) => {
      if (!img) cachedLogoImgPromise = null;
      return img;
    });
  }
  return cachedLogoImgPromise;
}

/**
 * Draws cover-cropped background image onto the target canvas rect without distortion.
 */
function drawCoverImage(ctx, img, width, height) {
  const iw = img.naturalWidth || img.width || width;
  const ih = img.naturalHeight || img.height || height;
  if (!iw || !ih) return;
  const targetRatio = width / height;
  const srcRatio = iw / ih;
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (srcRatio > targetRatio) {
    sw = ih * targetRatio;
    sx = (iw - sw) / 2;
  } else {
    sh = iw / targetRatio;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
}

/**
 * Renders the crisp official SPRAY.LAND 1200x630 Open Graph PNG with the SPRAY.LAND
 * logotype centered directly in the middle over either:
 *  - `mode: 'auto'` -> the low-angle isometric land shot or 3D sculpture render
 *  - `mode: 'custom'` -> the land holder's uploaded custom cover photo
 *  - `mode: 'logo'` -> pure SPRAY.LAND brand backdrop + centered logotype (when preview is off)
 */
export async function composeCenteredLogoOgPng({
  backgroundDataUrl = '',
  mode = 'auto',
  width = OG_IMAGE_WIDTH,
  height = OG_IMAGE_HEIGHT
} = {}) {
  if (typeof document === 'undefined') return '';
  let canvas;
  let ctx;
  try {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
  } catch {
    return '';
  }
  if (!ctx) return '';

  const effectiveMode = normalizeLandOgImageMode(mode);

  // 1) Base dark brand canvas gradient
  const bgGrad = ctx.createLinearGradient(0, 0, width * 0.45, height);
  bgGrad.addColorStop(0, '#060a14');
  bgGrad.addColorStop(0.55, '#0c162e');
  bgGrad.addColorStop(1, '#060a14');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  const hasBackground = effectiveMode !== 'logo' && Boolean(backgroundDataUrl);
  let drewBackground = false;
  if (hasBackground) {
    const bgImg = await loadImage(backgroundDataUrl);
    if (bgImg) {
      drawCoverImage(ctx, bgImg, width, height);
      drewBackground = true;
    }
  }

  if (drewBackground) {
    // Subtle dark edge vignette + centered soft radial scrim so the centered logotype reads crisply
    const vignette = ctx.createRadialGradient(
      width * 0.5,
      height * 0.5,
      Math.min(width, height) * 0.16,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.68
    );
    vignette.addColorStop(0, 'rgba(6, 10, 20, 0.52)');
    vignette.addColorStop(0.52, 'rgba(6, 10, 20, 0.24)');
    vignette.addColorStop(1, 'rgba(6, 10, 20, 0.56)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  } else {
    // Logo-only brand backdrop with subtle teal/pink glow orbs
    const tealGlow = ctx.createRadialGradient(
      width * 0.28,
      height * 0.34,
      10,
      width * 0.28,
      height * 0.34,
      width * 0.46
    );
    tealGlow.addColorStop(0, 'rgba(0, 245, 212, 0.16)');
    tealGlow.addColorStop(1, 'rgba(0, 245, 212, 0)');
    ctx.fillStyle = tealGlow;
    ctx.fillRect(0, 0, width, height);

    const pinkGlow = ctx.createRadialGradient(
      width * 0.76,
      height * 0.68,
      10,
      width * 0.76,
      height * 0.68,
      width * 0.42
    );
    pinkGlow.addColorStop(0, 'rgba(255, 62, 127, 0.14)');
    pinkGlow.addColorStop(1, 'rgba(255, 62, 127, 0)');
    ctx.fillStyle = pinkGlow;
    ctx.fillRect(0, 0, width, height);
  }

  // Crisp subtle brand border
  ctx.strokeStyle = 'rgba(0, 245, 212, 0.28)';
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, width - 36, height - 36);

  // 2) Draw centered SPRAY.LAND logotype squarely in the middle (width/2, height/2)
  const logoImg = await getOfficialLogoImage();
  if (logoImg && (logoImg.naturalWidth || logoImg.width) > 0) {
    const iw = logoImg.naturalWidth || logoImg.width;
    const ih = logoImg.naturalHeight || logoImg.height || iw * 0.25;
    const targetW = drewBackground ? width * 0.46 : width * 0.62;
    const targetH = Math.min(height * 0.38, (targetW * ih) / iw);
    const drawW = (targetH * iw) / ih;
    const drawX = (width - drawW) / 2;
    const drawY = (height - targetH) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(6, 10, 20, 0.85)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 6;
    ctx.drawImage(logoImg, drawX, drawY, drawW, targetH);
    ctx.restore();
  } else {
    // Fallback vector-text logotype if SVG decode unavailable
    ctx.save();
    ctx.font = `900 ${Math.round(height * 0.11)}px "Audiowide", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(6, 10, 20, 0.85)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('SPRAY.LAND', width / 2, height / 2);
    ctx.restore();
  }

  try {
    const url = canvas.toDataURL('image/png');
    return url && url.startsWith('data:image/') ? url : '';
  } catch {
    return '';
  }
}

/**
 * Reads a user-selected File/Blob as a data URL for custom OG image upload.
 */
export function readImageFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No image file selected.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected image file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Builds the live freshness-versioned server OG image URL for a Virtual Land.
 */
export function buildLandOgImageUrl(parcel, sculptures = [], apiBase = API_BASE) {
  const pid = String(parcel?.parcelId || '').trim().toUpperCase();
  if (!pid) return '';
  const fallbackOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://spray.land';
  const base = String(apiBase || fallbackOrigin).replace(/\/+$/, '');
  const sig =
    parcel?.ogContentSig ||
    computeLandOgContentSig({ parcel, sculptures });
  const stamp = String(
    parcel?.ogPreviewUpdatedAt || parcel?.settings?.ogPreviewUpdatedAt || ''
  )
    .replace(/[^0-9]/g, '')
    .slice(-10);
  const version = stamp ? `${sig}-${stamp}` : sig;
  return `${base}/api/og/land/${encodeURIComponent(pid)}.png?v=${encodeURIComponent(version)}`;
}

/**
 * Builds the live freshness-versioned server OG image URL for a 3D Sculpture.
 */
export function buildSculptureOgImageUrl(sculpture, parcel = null, apiBase = API_BASE) {
  const id = String(sculpture?.id || '').trim();
  if (!id) return '';
  const fallbackOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://spray.land';
  const base = String(apiBase || fallbackOrigin).replace(/\/+$/, '');
  const sig = computeSculptureOgContentSig({ sculpture, parcel });
  return `${base}/api/og/sculpture/${encodeURIComponent(id)}.png?v=${encodeURIComponent(sig)}`;
}
