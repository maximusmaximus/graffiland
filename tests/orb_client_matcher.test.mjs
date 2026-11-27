import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyLightingFromLuminance,
  detectOrbFeatures,
  matchAgainstKeyframes,
  meetsClientInitialCalibrationGate,
  solveSimilarityRansac,
  toB64,
  unwrapOrbPackCacheEntry
} from '../client/src/utils/orbMatcher.js';
import { verifyMatchedDescriptorsGeometry } from '../shared/landmarkService.mjs';

function makeDescB64(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    // Spread bits pseudo-randomly so distinct seeds have large Hamming distance (~128 bits)
    let x = ((seed + 1) * 2654435761 + (i + 1) * 1597334677) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0x5bd1e995) >>> 0;
    bytes[i] = (x >>> 16) & 0xff;
  }
  return toB64(bytes);
}

function makeKeyframeFeatures(seedOffset, count = 12) {
  const feats = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % 4;
    const row = Math.floor(i / 4) % 3;
    feats.push({
      u: 0.14 + col * 0.22,
      v: 0.18 + row * 0.28,
      x: 0.3,
      y: 0.1,
      z: -2.4,
      angle: 0.2,
      response: 62,
      descB64: makeDescB64(seedOffset + i)
    });
  }
  return feats;
}

describe('Client ORB 2D Similarity RANSAC, Dual Lighting Slots & Policy Passthrough', () => {
  test('solveSimilarityRansac recovers rotated + scaled + shifted camera views and strips all outliers', () => {
    const fw = 160;
    const fh = 120;
    const theta = (22 * Math.PI) / 180;
    const scale = 1.32;
    const a = Math.cos(theta) * scale;
    const b = Math.sin(theta) * scale;
    const tx = 8.0;
    const ty = -5.0;

    const kfFeats = makeKeyframeFeatures(100, 10);
    const matches = kfFeats.map((f, idx) => {
      const kx = f.u * fw;
      const ky = f.v * fh;
      const lx = a * kx - b * ky + tx;
      const ly = b * kx + a * ky + ty;
      return {
        keyframeIndex: 0,
        featureIndex: idx,
        liveDescB64: f.descB64,
        u: lx / fw,
        v: ly / fh,
        kx,
        ky,
        lx,
        ly
      };
    });

    // Inject 6 gross outlier matches
    for (let o = 0; o < 6; o += 1) {
      matches.push({
        keyframeIndex: 0,
        featureIndex: 10 + o,
        liveDescB64: makeDescB64(900 + o),
        u: 0.9,
        v: 0.1,
        kx: 20 + o * 18,
        ky: 20 + (o % 3) * 28,
        lx: 145 - o * 24,
        ly: 105 - (o % 2) * 70
      });
    }

    const res = solveSimilarityRansac(matches, fw, fh, 5.5);
    assert.equal(res.inlierCount, 10, 'Must recover all 10 similarity inliers');
    assert.equal(res.inliers.length, 10, 'Must emit ONLY verified inliers and strip all 6 outliers');
    assert.ok(Math.abs(res.estimatedScale - scale) < 0.02, `Expected scale ~${scale}, got ${res.estimatedScale}`);
    assert.ok(
      Math.abs(res.estimatedRotationRad - theta) < 0.02,
      `Expected rot ~${theta}, got ${res.estimatedRotationRad}`
    );
    assert.ok(res.reprojectionErrorPx < 1.0);
  });

  test('matchAgainstKeyframes picks best dual-lighting slot, respects maxReprojErr, and passes server geometry verification', () => {
    const fw = 160;
    const fh = 120;
    const daylightFeats = makeKeyframeFeatures(10, 12);
    const lowlightFeats = makeKeyframeFeatures(500, 12);

    const keyframes = [
      {
        keyframeIndex: 0,
        yawOffsetDeg: 0,
        frameWidth: fw,
        frameHeight: fh,
        lightingTag: 'daylight',
        features: daylightFeats
      },
      {
        keyframeIndex: 1,
        yawOffsetDeg: 0,
        frameWidth: fw,
        frameHeight: fh,
        lightingTag: 'lowlight',
        features: lowlightFeats
      }
    ];

    // Live frame matches 9 lowlight features under slight zoom (1.12x) + rotation (-12 deg) + jitter
    const theta = (-12 * Math.PI) / 180;
    const scale = 1.12;
    const cosT = Math.cos(theta) * scale;
    const sinT = Math.sin(theta) * scale;

    const liveFeatures = lowlightFeats.slice(0, 9).map((f, idx) => {
      const kx = f.u * fw;
      const ky = f.v * fh;
      const cx = kx - fw * 0.5;
      const cy = ky - fh * 0.5;
      // Add subtle deterministic jitter (~2.8px) on half the features to verify maxReprojErr sensitivity
      const jitterX = idx % 2 === 0 ? 1.2 : -1.1;
      const jitterY = idx % 2 === 0 ? -0.9 : 1.0;
      const lx = cosT * cx - sinT * cy + fw * 0.5 + 3.0 + jitterX;
      const ly = sinT * cx + cosT * cy + fh * 0.5 - 1.5 + jitterY;
      return {
        u: Math.max(0.01, Math.min(0.99, lx / fw)),
        v: Math.max(0.01, Math.min(0.99, ly / fh)),
        angle: f.angle,
        descB64: f.descB64
      };
    });

    // Add 3 mismatched outliers using lowlight descriptors at bogus coordinates
    for (let i = 9; i < 12; i += 1) {
      liveFeatures.push({
        u: 0.92 - (i - 9) * 0.04,
        v: 0.91,
        angle: 0,
        descB64: lowlightFeats[i].descB64
      });
    }

    const res = matchAgainstKeyframes(liveFeatures, keyframes, fw, fh, 8.0);
    assert.equal(res.matchedKeyframeIndex, 1);
    assert.equal(res.matchedLightingSlot, 'lowlight');
    assert.equal(res.inlierCount, 9);
    assert.equal(res.matchedDescriptors.length, 9, 'Outliers must NEVER leak into matchedDescriptors');

    // Verify client output directly passes server-side 2D similarity geometry check!
    const serverPairs = res.matchedDescriptors.map((m) => {
      const feat = keyframes[m.keyframeIndex].features[m.featureIndex];
      return {
        kIdx: m.keyframeIndex,
        fIdx: m.featureIndex,
        kx: feat.u * fw,
        ky: feat.v * fh,
        lx: m.u * fw,
        ly: m.v * fh,
        hasUv: true
      };
    });
    const serverGeo = verifyMatchedDescriptorsGeometry(serverPairs, 8.0);
    assert.equal(serverGeo.totalGeometricInliers, 9);
    assert.ok(serverGeo.meanResidualPx <= 3.0);
  });

  test('detectOrbFeatures extracts binary features from synthetic scene and matches translated capture', () => {
    const w = 160;
    const h = 120;
    const renderSynthetic = (shiftX = 0, shiftY = 0) => {
      const gray = new Uint8Array(w * h);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const sx = x - shiftX;
          const sy = y - shiftY;
          const cellX = Math.floor(sx / 16);
          const cellY = Math.floor(sy / 14);
          const checker = (cellX + cellY) % 2 === 0 ? 215 : 40;
          const accent = ((sx % 23 === 0 || sy % 19 === 0) ? 35 : 0);
          gray[y * w + x] = Math.min(255, checker + accent);
        }
      }
      return gray;
    };

    const kfFeats = detectOrbFeatures(renderSynthetic(0, 0), w, h, { yawDeg: 0, maxFeatures: 36 });
    assert.ok(kfFeats.length >= 12, `Expected >= 12 features on high-contrast scene, got ${kfFeats.length}`);

    const liveFeats = detectOrbFeatures(renderSynthetic(4, -2), w, h, { yawDeg: 0, maxFeatures: 48 });
    const match = matchAgainstKeyframes(
      liveFeats,
      [{ keyframeIndex: 0, frameWidth: w, frameHeight: h, lightingTag: 'daylight', features: kfFeats }],
      w,
      h,
      8.0
    );
    assert.ok(match.inlierCount >= 6, `Expected >= 6 matched inliers, got ${match.inlierCount}`);
    assert.equal(match.matchedDescriptors.length, match.inlierCount);
  });

  test('classifyLightingFromLuminance, meetsClientInitialCalibrationGate & unwrapOrbPackCacheEntry work cleanly', () => {
    assert.equal(classifyLightingFromLuminance(42, 'daylight'), 'lowlight');
    assert.equal(classifyLightingFromLuminance(140, 'daylight'), 'daylight');
    assert.equal(classifyLightingFromLuminance(95, 'night'), 'lowlight');
    assert.equal(classifyLightingFromLuminance(160, 'night'), 'daylight');

    const goodKfs = [
      { lightingTag: 'daylight', features: makeKeyframeFeatures(1, 10) },
      { lightingTag: 'daylight', features: makeKeyframeFeatures(50, 10) }
    ];
    assert.equal(meetsClientInitialCalibrationGate(goodKfs).ok, true);

    const weakKfs = [
      {
        lightingTag: 'daylight',
        features: Array.from({ length: 12 }, (_, i) => ({
          u: 0.4,
          v: 0.4,
          response: 30,
          descB64: makeDescB64(i)
        }))
      }
    ];
    assert.equal(meetsClientInitialCalibrationGate(weakKfs).ok, false);

    // Rich cache entry
    const rich = unwrapOrbPackCacheEntry({
      available: true,
      anchorPack: { descriptorDigest: 'abc', keyframes: goodKfs },
      effectivePolicy: { minOrbInliers: 5, maxReprojErrPx: 11.5 },
      orbStatus: 'optional',
      lightingSlots: ['daylight'],
      missingLightingSlots: ['lowlight']
    });
    assert.equal(rich.available, true);
    assert.equal(rich.effectivePolicy.maxReprojErrPx, 11.5);
    assert.deepEqual(rich.missingLightingSlots, ['lowlight']);

    // Legacy bare pack
    const legacy = unwrapOrbPackCacheEntry({ descriptorDigest: 'xyz', keyframes: goodKfs });
    assert.equal(legacy.available, true);
    assert.equal(legacy.anchorPack.descriptorDigest, 'xyz');

    // Null / no pack
    const empty = unwrapOrbPackCacheEntry(null);
    assert.equal(empty.available, false);
    assert.equal(empty.orbStatus, 'no_pack');
    assert.equal(empty.upgradePath, 'first_mobile_scan');
  });
});
