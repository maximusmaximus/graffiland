// Main-thread interface to the non-reversible binary ORB Web Worker.
// Samples only small transient luminance frames inside an offscreen canvas (never retained or uploaded).

const SAMPLE_W = 160;
const SAMPLE_H = 120;

export class OrbLandmarkTracker {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.canvas = null;
    this.ctx = null;
  }

  ensureWorker() {
    if (!this.worker && typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('../workers/orbWorker.js', import.meta.url), {
        type: 'module'
      });
      this.worker.onmessage = (e) => {
        const { id, ...payload } = e.data || {};
        const resolver = this.pending.get(id);
        if (resolver) {
          this.pending.delete(id);
          resolver(payload);
        }
      };
      this.worker.onerror = (err) => {
        for (const [, rejectOrResolve] of this.pending) {
          rejectOrResolve({ ok: false, error: err?.message || 'ORB worker crashed' });
        }
        this.pending.clear();
      };
    }
    return this.worker;
  }

  captureLuminance(videoEl) {
    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) {
      return null;
    }
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = SAMPLE_W;
      this.canvas.height = SAMPLE_H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.ctx) return null;
    this.ctx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = this.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    const gray = new Uint8Array(SAMPLE_W * SAMPLE_H);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    return { gray, width: SAMPLE_W, height: SAMPLE_H };
  }

  postTask(message, transfer = []) {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({ ok: false, error: 'Web Worker unavailable' });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ id, ...message }, transfer);
    });
  }

  async extractKeyframeFeatures(videoEl, { yawDeg = 0, pitchDeg = 0 } = {}) {
    const frame = this.captureLuminance(videoEl);
    if (!frame) return null;
    const res = await this.postTask(
      {
        cmd: 'extract',
        gray: frame.gray,
        width: frame.width,
        height: frame.height,
        yawDeg
      },
      [frame.gray.buffer]
    );
    if (!res?.ok || !Array.isArray(res.features)) return null;
    return {
      yawOffsetDeg: Math.round(yawDeg * 10) / 10,
      pitchDeg: Math.round(pitchDeg * 10) / 10,
      frameWidth: frame.width,
      frameHeight: frame.height,
      lightingTag: 'live-scan',
      features: res.features
    };
  }

  async matchLiveFrame(videoEl, anchorPack, { maxReprojErr = 6.5 } = {}) {
    const frame = this.captureLuminance(videoEl);
    if (!frame || !anchorPack?.keyframes?.length) return null;
    const res = await this.postTask(
      {
        cmd: 'match',
        gray: frame.gray,
        width: frame.width,
        height: frame.height,
        keyframes: anchorPack.keyframes,
        maxReprojErr
      },
      [frame.gray.buffer]
    );
    if (!res?.ok) return null;
    return {
      descriptorDigest: anchorPack.descriptorDigest,
      inlierCount: res.inlierCount || 0,
      reprojectionErrorPx: res.reprojectionErrorPx || 999,
      poseCorrectionYawRad: res.poseCorrectionYawRad || 0,
      matchedKeyframeIndex: res.matchedKeyframeIndex ?? -1,
      matchedDescriptors: res.matchedDescriptors || []
    };
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
    this.canvas = null;
    this.ctx = null;
  }
}
