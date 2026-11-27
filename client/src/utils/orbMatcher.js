// Non-reversible binary ORB (Oriented FAST + Rotated BRIEF-256) extractor and
// 2D Similarity RANSAC relocalization solver (uniform scale + rotation + translation).
// Pure module shared by orbWorker.js and unit tests — raw camera pixels NEVER leave the device.

export const ORB_DEFAULT_MAX_REPROJ_ERR_PX = 8.0;
export const LOWLIGHT_LUMINANCE_THRESHOLD = 72;
export const CLIENT_INITIAL_CLAIM_MIN_FEATURES = 18;
export const CLIENT_INITIAL_CLAIM_MIN_SPREAD = 0.25;
export const CLIENT_INITIAL_CLAIM_MIN_RESPONSE = 36;

const PATCH_RADIUS = 13;

const BRIEF_PAIRS = (() => {
  // Deterministic 256-bit sampling pairs within radius <= 11px
  let seed = 0x51a9c37d;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pairs = [];
  for (let i = 0; i < 256; i += 1) {
    const a1 = nextRand() * Math.PI * 2;
    const r1 = 2 + nextRand() * 9;
    const a2 = nextRand() * Math.PI * 2;
    const r2 = 2 + nextRand() * 9;
    pairs.push([
      Math.cos(a1) * r1,
      Math.sin(a1) * r1,
      Math.cos(a2) * r2,
      Math.sin(a2) * r2
    ]);
  }
  return pairs;
})();

const POPCNT_LUT = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let x = i;
    let c = 0;
    while (x) {
      c += x & 1;
      x >>= 1;
    }
    lut[i] = c;
  }
  return lut;
})();

export function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export function fromB64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function hammingDistance(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    d += POPCNT_LUT[a[i] ^ b[i]];
  }
  return d;
}

export function computeMeanLuminance(gray) {
  if (!gray || !gray.length) return 128;
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) {
    sum += gray[i];
  }
  return Math.round((sum / gray.length) * 10) / 10;
}

/**
 * Classifies a camera capture into one of the dual calibration slots ('daylight' | 'lowlight')
 * using measured grayscale frame luminance and optional solar regime hint.
 */
export function classifyLightingFromLuminance(meanLuminance = 128, solarRegime = '') {
  const lum = Number(meanLuminance);
  const regime = String(solarRegime || '').trim().toLowerCase();
  if (Number.isFinite(lum) && lum < LOWLIGHT_LUMINANCE_THRESHOLD) {
    return 'lowlight';
  }
  if (regime === 'night' && (!Number.isFinite(lum) || lum < 115)) {
    return 'lowlight';
  }
  return 'daylight';
}

export function detectOrbFeatures(gray, width, height, { yawDeg = 0, maxFeatures = 64 } = {}) {
  if (!gray || width < 40 || height < 40) return [];
  const step = 2;
  const threshold = 18;
  const candidates = [];

  for (let y = PATCH_RADIUS + 2; y < height - PATCH_RADIUS - 2; y += step) {
    const row = y * width;
    for (let x = PATCH_RADIUS + 2; x < width - PATCH_RADIUS - 2; x += step) {
      const idx = row + x;
      const p = gray[idx];
      const n = gray[idx - 3 * width];
      const s = gray[idx + 3 * width];
      const w = gray[idx - 3];
      const e = gray[idx + 3];

      let brighter = 0;
      let darker = 0;
      if (n > p + threshold) brighter += 1;
      else if (n < p - threshold) darker += 1;
      if (s > p + threshold) brighter += 1;
      else if (s < p - threshold) darker += 1;
      if (w > p + threshold) brighter += 1;
      else if (w < p - threshold) darker += 1;
      if (e > p + threshold) brighter += 1;
      else if (e < p - threshold) darker += 1;
      if (brighter < 3 && darker < 3) continue;

      const ne = gray[idx - 2 * width + 2];
      const se = gray[idx + 2 * width + 2];
      const sw = gray[idx + 2 * width - 2];
      const nw = gray[idx - 2 * width - 2];

      const gx = e + ne + se - (w + nw + sw);
      const gy = s + se + sw - (n + ne + nw);
      const response = Math.sqrt(gx * gx + gy * gy) + (brighter + darker) * 4;
      if (response < 34) continue;

      candidates.push({ x, y, response });
    }
  }

  candidates.sort((a, b) => b.response - a.response);

  // Spatial grid suppression so descriptors cover diverse parts of the scene
  const picked = [];
  const occupied = new Set();
  for (let i = 0; i < candidates.length && picked.length < maxFeatures; i += 1) {
    const c = candidates[i];
    const cellKey = `${c.x >> 3},${c.y >> 3}`;
    if (occupied.has(cellKey)) continue;
    occupied.add(cellKey);

    // Intensity Centroid orientation in local circular patch
    let m10 = 0;
    let m01 = 0;
    for (let dy = -6; dy <= 6; dy += 2) {
      const rOff = (c.y + dy) * width;
      for (let dx = -6; dx <= 6; dx += 2) {
        if (dx * dx + dy * dy > 36) continue;
        const val = gray[rOff + c.x + dx];
        m10 += dx * val;
        m01 += dy * val;
      }
    }
    const angle = Math.atan2(m01, m10);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Compute 256-bit rotated BRIEF descriptor (32 bytes)
    const desc = new Uint8Array(32);
    for (let b = 0; b < 256; b += 1) {
      const [px1, py1, px2, py2] = BRIEF_PAIRS[b];
      const sx1 = Math.round(c.x + (px1 * cosA - py1 * sinA));
      const sy1 = Math.round(c.y + (px1 * sinA + py1 * cosA));
      const sx2 = Math.round(c.x + (px2 * cosA - py2 * sinA));
      const sy2 = Math.round(c.y + (px2 * sinA + py2 * cosA));
      const i1 = gray[sy1 * width + sx1];
      const i2 = gray[sy2 * width + sx2];
      if (i1 < i2) {
        desc[b >> 3] |= 1 << (b & 7);
      }
    }

    // Approximate cylindrical 3D landmark ray at r = 2.6m radius around origin
    const uNorm = c.x / width;
    const vNorm = c.y / height;
    const fovYaw = ((uNorm - 0.5) * (62 * Math.PI)) / 180 + (yawDeg * Math.PI) / 180;
    const fovPitch = ((0.5 - vNorm) * (46 * Math.PI)) / 180;
    const r = 2.6;

    picked.push({
      u: Math.round(uNorm * 1000) / 1000,
      v: Math.round(vNorm * 1000) / 1000,
      x: Math.round(Math.sin(fovYaw) * Math.cos(fovPitch) * r * 1000) / 1000,
      y: Math.round(Math.sin(fovPitch) * r * 1000) / 1000,
      z: Math.round(-Math.cos(fovYaw) * Math.cos(fovPitch) * r * 1000) / 1000,
      angle: Math.round(angle * 1000) / 1000,
      response: Math.round(c.response * 100) / 100,
      descB64: toB64(desc)
    });
  }

  return picked;
}

/**
 * Deterministic 2-point 2D Similarity RANSAC solver:
 *   lx = a * kx - b * ky + tx
 *   ly = b * kx + a * ky + ty
 * Handles uniform scale (distance changes: s in [0.4, 2.5]), phone roll/tilt rotation,
 * and camera pan/translation, and returns ONLY geometrically verified inliers.
 */
export function solveSimilarityRansac(
  matches,
  width = 160,
  height = 120,
  maxReprojErr = ORB_DEFAULT_MAX_REPROJ_ERR_PX
) {
  if (!Array.isArray(matches) || matches.length < 2) {
    return {
      inlierCount: 0,
      reprojectionErrorPx: 999,
      poseCorrectionYawRad: 0,
      estimatedScale: 1,
      estimatedRotationRad: 0,
      inliers: []
    };
  }

  const inlierCap = Math.max(3.5, Number(maxReprojErr || ORB_DEFAULT_MAX_REPROJ_ERR_PX) * 1.8);
  const samplePool = matches.slice(0, 36);
  const pairs = [];
  for (let i = 0; i < samplePool.length; i += 1) {
    for (let j = i + 1; j < samplePool.length; j += 1) {
      pairs.push([i, j]);
    }
  }

  const maxHyp = 48;
  const stride = pairs.length > maxHyp ? pairs.length / maxHyp : 1;

  let bestInliers = [];
  let bestErrSum = Infinity;
  let bestA = 1;
  let bestB = 0;
  let bestTx = 0;

  for (let h = 0; h < Math.min(maxHyp, pairs.length); h += 1) {
    const [i, j] = pairs[Math.floor(h * stride)];
    const p1 = samplePool[i];
    const p2 = samplePool[j];
    const dkx = p2.kx - p1.kx;
    const dky = p2.ky - p1.ky;
    const denom = dkx * dkx + dky * dky;
    if (denom < 9) continue;

    const dlx = p2.lx - p1.lx;
    const dly = p2.ly - p1.ly;
    const a = (dkx * dlx + dky * dly) / denom;
    const b = (dkx * dly - dky * dlx) / denom;
    const scale = Math.hypot(a, b);
    if (!Number.isFinite(scale) || scale < 0.4 || scale > 2.5) continue;

    const tx = p1.lx - (a * p1.kx - b * p1.ky);
    const ty = p1.ly - (b * p1.kx + a * p1.ky);

    const inliers = [];
    let errSum = 0;
    for (let q = 0; q < matches.length; q += 1) {
      const pt = matches[q];
      const predX = a * pt.kx - b * pt.ky + tx;
      const predY = b * pt.kx + a * pt.ky + ty;
      const dist = Math.hypot(pt.lx - predX, pt.ly - predY);
      if (dist <= inlierCap) {
        inliers.push(pt);
        errSum += dist;
      }
    }

    if (
      inliers.length > bestInliers.length ||
      (inliers.length === bestInliers.length && errSum < bestErrSum)
    ) {
      bestInliers = inliers;
      bestErrSum = errSum;
      bestA = a;
      bestB = b;
      bestTx = tx;
    }
  }

  const inlierCount = bestInliers.length;
  const avgErr = inlierCount > 0 ? Math.max(0.25, bestErrSum / inlierCount) : 999;
  const cx = width * 0.5;
  const cy = height * 0.5;
  const centerDx = bestA * cx - bestB * cy + bestTx - cx;
  const poseCorrectionYawRad =
    inlierCount >= 3
      ? Math.round((centerDx / width) * ((62 * Math.PI) / 180) * 1000) / 1000
      : 0;

  return {
    inlierCount,
    reprojectionErrorPx: Math.round(avgErr * 100) / 100,
    poseCorrectionYawRad,
    estimatedScale: Math.round(Math.hypot(bestA, bestB) * 1000) / 1000,
    estimatedRotationRad: Math.round(Math.atan2(bestB, bestA) * 1000) / 1000,
    inliers: bestInliers
  };
}

export function matchAgainstKeyframes(
  liveFeatures,
  keyframes,
  width = 160,
  height = 120,
  maxReprojErr = ORB_DEFAULT_MAX_REPROJ_ERR_PX
) {
  if (!liveFeatures?.length || !Array.isArray(keyframes) || keyframes.length === 0) {
    return {
      inlierCount: 0,
      reprojectionErrorPx: 999,
      poseCorrectionYawRad: 0,
      matchedKeyframeIndex: -1,
      matchedLightingSlot: '',
      matchedDescriptors: []
    };
  }

  let bestResult = {
    inlierCount: 0,
    reprojectionErrorPx: 999,
    poseCorrectionYawRad: 0,
    matchedKeyframeIndex: -1,
    matchedLightingSlot: '',
    matchedDescriptors: []
  };

  for (let kIdx = 0; kIdx < keyframes.length; kIdx += 1) {
    const kf = keyframes[kIdx];
    const kfFeats = Array.isArray(kf?.features) ? kf.features : [];
    if (kfFeats.length < 4) continue;

    const kfDescs = kfFeats.map((f) => fromB64(f.descB64));
    const matches = [];
    const kfW = Number(kf.frameWidth || width);
    const kfH = Number(kf.frameHeight || height);

    for (let i = 0; i < liveFeatures.length; i += 1) {
      const lf = liveFeatures[i];
      const lDesc = fromB64(lf.descB64);
      let bestDist = 999;
      let secondDist = 999;
      let bestJ = -1;
      for (let j = 0; j < kfDescs.length; j += 1) {
        const d = hammingDistance(lDesc, kfDescs[j]);
        if (d < bestDist) {
          secondDist = bestDist;
          bestDist = d;
          bestJ = j;
        } else if (d < secondDist) {
          secondDist = d;
        }
      }
      // Slightly relaxed Lowe-style ratio & Hamming ceiling for outdoor lighting resilience
      if (bestJ >= 0 && bestDist <= 72 && bestDist <= secondDist * 0.88) {
        matches.push({
          keyframeIndex: kIdx,
          featureIndex: bestJ,
          liveDescB64: lf.descB64,
          u: lf.u,
          v: lf.v,
          lx: lf.u * width,
          ly: lf.v * height,
          kx: kfFeats[bestJ].u * kfW,
          ky: kfFeats[bestJ].v * kfH,
          liveYaw: lf.angle,
          kfYaw: kfFeats[bestJ].angle
        });
      }
    }

    if (matches.length < 4) continue;

    const ransac = solveSimilarityRansac(matches, width, height, maxReprojErr);
    if (
      ransac.inlierCount > bestResult.inlierCount ||
      (ransac.inlierCount === bestResult.inlierCount &&
        ransac.reprojectionErrorPx < bestResult.reprojectionErrorPx)
    ) {
      bestResult = {
        inlierCount: ransac.inlierCount,
        reprojectionErrorPx: ransac.reprojectionErrorPx,
        poseCorrectionYawRad: ransac.poseCorrectionYawRad,
        estimatedScale: ransac.estimatedScale,
        estimatedRotationRad: ransac.estimatedRotationRad,
        matchedKeyframeIndex: kIdx,
        matchedLightingSlot: String(kf.lightingTag || 'daylight'),
        // Emit strictly verified RANSAC inliers (never pre-RANSAC outlier matches)
        matchedDescriptors: ransac.inliers.slice(0, 32).map((m) => ({
          keyframeIndex: m.keyframeIndex,
          featureIndex: m.featureIndex,
          liveDescB64: m.liveDescB64,
          u: m.u,
          v: m.v
        }))
      };
    }
  }

  return bestResult;
}

/**
 * Mirrors the server's anti-poisoning quality gate before uploading a visitor's first
 * or complementary-lighting ORB calibration scan.
 */
export function meetsClientInitialCalibrationGate(keyframes = []) {
  const list = Array.isArray(keyframes) ? keyframes : [];
  const occupied = new Set();
  let featureCount = 0;
  let responseSum = 0;
  for (const kf of list) {
    const feats = Array.isArray(kf?.features) ? kf.features : [];
    for (const f of feats) {
      featureCount += 1;
      responseSum += Math.max(0, Number(f?.response || 0));
      const u = Math.max(0, Math.min(0.9999, Number(f?.u || 0)));
      const v = Math.max(0, Math.min(0.9999, Number(f?.v || 0)));
      occupied.add(`${Math.floor(u * 4)}:${Math.floor(v * 3)}`);
    }
  }
  const spreadRatio = occupied.size / 12;
  const avgResponse = featureCount > 0 ? responseSum / featureCount : 0;
  return {
    ok:
      featureCount >= CLIENT_INITIAL_CLAIM_MIN_FEATURES &&
      spreadRatio >= CLIENT_INITIAL_CLAIM_MIN_SPREAD &&
      avgResponse >= CLIENT_INITIAL_CLAIM_MIN_RESPONSE,
    featureCount,
    spreadRatio: Math.round(spreadRatio * 1000) / 1000,
    avgResponse: Math.round(avgResponse * 100) / 100
  };
}

/**
 * Unwraps either a rich cached fetch response `{ available, anchorPack, effectivePolicy, ... }`
 * or a legacy bare `anchorPack` `{ descriptorDigest, keyframes }` cleanly.
 */
export function unwrapOrbPackCacheEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return {
      available: false,
      anchorPack: null,
      effectivePolicy: null,
      orbStatus: 'no_pack',
      upgradePath: 'first_mobile_scan',
      lightingSlots: [],
      desiredLightingSlot: '',
      missingLightingSlots: []
    };
  }
  if (Array.isArray(entry.keyframes)) {
    return {
      available: true,
      anchorPack: entry,
      effectivePolicy: null,
      orbStatus: 'optional',
      upgradePath: '',
      lightingSlots: [],
      desiredLightingSlot: '',
      missingLightingSlots: []
    };
  }
  return {
    available: Boolean(entry.available && entry.anchorPack),
    anchorPack: entry.anchorPack || null,
    effectivePolicy: entry.effectivePolicy || null,
    orbStatus: entry.orbStatus || (entry.available ? 'optional' : 'no_pack'),
    upgradePath: entry.upgradePath || (entry.available ? '' : 'first_mobile_scan'),
    lightingSlots: Array.isArray(entry.lightingSlots) ? entry.lightingSlots : [],
    desiredLightingSlot: entry.desiredLightingSlot || '',
    missingLightingSlots: Array.isArray(entry.missingLightingSlots) ? entry.missingLightingSlots : []
  };
}
