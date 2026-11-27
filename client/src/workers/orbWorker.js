// Non-reversible binary ORB (Oriented FAST + Rotated BRIEF-256) extractor and
// RANSAC 2D-similarity relocalization solver running strictly in a Web Worker.
// Raw camera pixels are NEVER transmitted or stored.

import {
  ORB_DEFAULT_MAX_REPROJ_ERR_PX,
  classifyLightingFromLuminance,
  computeMeanLuminance,
  detectOrbFeatures,
  matchAgainstKeyframes
} from '../utils/orbMatcher.js';

self.onmessage = (e) => {
  const { id, cmd, gray, width, height, yawDeg, keyframes, maxReprojErr, solarRegime } =
    e.data || {};
  try {
    const liveFeatures = detectOrbFeatures(gray, width, height, {
      yawDeg: Number(yawDeg || 0),
      maxFeatures: cmd === 'extract' ? 42 : 56
    });
    if (cmd === 'extract') {
      const meanLuminance = computeMeanLuminance(gray);
      self.postMessage({
        id,
        ok: true,
        features: liveFeatures,
        meanLuminance,
        lightingTag: classifyLightingFromLuminance(meanLuminance, solarRegime)
      });
      return;
    }
    if (cmd === 'match') {
      const res = matchAgainstKeyframes(
        liveFeatures,
        keyframes,
        width,
        height,
        Number(maxReprojErr || ORB_DEFAULT_MAX_REPROJ_ERR_PX)
      );
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
