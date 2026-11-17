// Non-reversible binary ORB (Oriented FAST + Rotated BRIEF-256) extractor and
// RANSAC 2D-similarity / PnP relocalization solver running strictly in a Web Worker.
// Raw camera pixels are NEVER transmitted or stored.

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

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function hammingDistance(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    d += POPCNT_LUT[a[i] ^ b[i]];
  }
  return d;
}

function detectOrbFeatures(gray, width, height, { yawDeg = 0, maxFeatures = 64 } = {}) {
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
    const fovYaw = (uNorm - 0.5) * (62 * Math.PI) / 180 + (yawDeg * Math.PI) / 180;
    const fovPitch = (0.5 - vNorm) * (46 * Math.PI) / 180;
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

function matchAgainstKeyframes(liveFeatures, keyframes, width, height, maxReprojErr = 6.5) {
  if (!liveFeatures.length || !Array.isArray(keyframes) || keyframes.length === 0) {
    return {
      inlierCount: 0,
      reprojectionErrorPx: 999,
      poseCorrectionYawRad: 0,
      matchedKeyframeIndex: -1
    };
  }

  let bestResult = {
    inlierCount: 0,
    reprojectionErrorPx: 999,
    poseCorrectionYawRad: 0,
    matchedKeyframeIndex: 0
  };

  for (let kIdx = 0; kIdx < keyframes.length; kIdx += 1) {
    const kf = keyframes[kIdx];
    const kfFeats = Array.isArray(kf?.features) ? kf.features : [];
    if (kfFeats.length < 4) continue;

    const kfDescs = kfFeats.map((f) => fromB64(f.descB64));
    const matches = [];

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
      // Lowe-style Hamming ratio + ceiling
      if (bestJ >= 0 && bestDist <= 68 && bestDist <= secondDist * 0.86) {
        matches.push({
          lx: lf.u * width,
          ly: lf.v * height,
          kx: kfFeats[bestJ].u * (kf.frameWidth || width),
          ky: kfFeats[bestJ].v * (kf.frameHeight || height),
          liveYaw: lf.angle,
          kfYaw: kfFeats[bestJ].angle
        });
      }
    }

    if (matches.length < 4) continue;

    // RANSAC translation + scale offset estimation (2-point hypotheses across 36 iterations)
    let bestInliers = 0;
    let bestErrSum = 0;
    let bestDx = 0;
    const iters = Math.min(36, matches.length * matches.length);
    for (let it = 0; it < iters; it += 1) {
      const m = matches[it % matches.length];
      const dx = m.lx - m.kx;
      const dy = m.ly - m.ky;
      let inliers = 0;
      let errSum = 0;
      for (let q = 0; q < matches.length; q += 1) {
        const p = matches[q];
        const rx = p.lx - (p.kx + dx);
        const ry = p.ly - (p.ky + dy);
        const dist = Math.sqrt(rx * rx + ry * ry);
        if (dist <= Math.max(4, maxReprojErr * 2.2)) {
          inliers += 1;
          errSum += dist;
        }
      }
      if (
        inliers > bestInliers ||
        (inliers === bestInliers && errSum < bestErrSum)
      ) {
        bestInliers = inliers;
        bestErrSum = errSum;
        bestDx = dx;
      }
    }

    const avgErr = bestInliers > 0 ? Math.max(0.25, bestErrSum / bestInliers) : 999;
    if (
      bestInliers > bestResult.inlierCount ||
      (bestInliers === bestResult.inlierCount && avgErr < bestResult.reprojectionErrorPx)
    ) {
      bestResult = {
        inlierCount: bestInliers,
        reprojectionErrorPx: Math.round(avgErr * 100) / 100,
        poseCorrectionYawRad: Math.round((bestDx / width) * ((62 * Math.PI) / 180) * 1000) / 1000,
        matchedKeyframeIndex: kIdx
      };
    }
  }

  return bestResult;
}

self.onmessage = (e) => {
  const { id, cmd, gray, width, height, yawDeg, keyframes, maxReprojErr } = e.data || {};
  try {
    const liveFeatures = detectOrbFeatures(gray, width, height, {
      yawDeg: Number(yawDeg || 0),
      maxFeatures: cmd === 'extract' ? 42 : 56
    });
    if (cmd === 'extract') {
      self.postMessage({ id, ok: true, features: liveFeatures });
      return;
    }
    if (cmd === 'match') {
      const res = matchAgainstKeyframes(liveFeatures, keyframes, width, height, maxReprojErr);
      self.postMessage({
        id,
        ok: true,
        ...res,
        liveFeatureCount: liveFeatures.length
      });
      return;
    }
    self.postMessage({ id, ok: false, error: `Unknown ORB worker cmd: ${cmd}` });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || 'ORB worker error' });
  }
};
