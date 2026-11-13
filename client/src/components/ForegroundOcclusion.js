/**
 * Gyro-Compensated Foreground Occlusion Compositor
 * Detects hands, people, or closer moving foreground objects crossing in front of
 * the camera while compensating for slow camera rotation, and paints only those
 * verified foreground silhouettes cleanly over the AR WebGL sculpture layer.
 */
export class ForegroundOcclusionCompositor {
  constructor() {
    // Compact analysis resolution for fast zero-jank foreground silhouettes
    this.width = 128;
    this.height = 96;
    const len = this.width * this.height;

    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = this.width;
    this.sampleCanvas.height = this.height;
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = this.width;
    this.maskCanvas.height = this.height;
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.maskImgData = this.maskCtx.createImageData(this.width, this.height);

    this.prevLuma = null;
    this.currLuma = new Float32Array(len);
    this.rawForeground = new Uint8Array(len);
    this.persistedMask = new Float32Array(len);
    this.prevGyro = null;
  }

  reset() {
    this.prevLuma = null;
    this.prevGyro = null;
    this.persistedMask.fill(0);
  }

  processFrame(videoEl, outputCanvas, gyro, enabled = true, suppress = false) {
    if (!outputCanvas) return;
    const outCtx = outputCanvas.getContext('2d');
    if (!outCtx) return;

    if (!enabled || suppress || !videoEl || videoEl.readyState < 2) {
      if (this.persistedMask[0] !== 0 || suppress) {
        this.persistedMask.fill(0);
      }
      outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      return;
    }

    const { width: w, height: h } = this;
    const len = w * h;
    this.sampleCtx.drawImage(videoEl, 0, 0, w, h);
    const frame = this.sampleCtx.getImageData(0, 0, w, h).data;
    const luma = this.currLuma;
    for (let i = 0; i < len; i++) {
      const p = i * 4;
      luma[i] = 0.299 * frame[p] + 0.587 * frame[p + 1] + 0.114 * frame[p + 2];
    }

    let shiftX = 0;
    let shiftY = 0;
    let fastPan = false;

    if (gyro && this.prevGyro) {
      let dYaw = gyro.alpha - this.prevGyro.alpha;
      if (dYaw > 180) dYaw -= 360;
      if (dYaw < -180) dYaw += 360;
      const dPitch = gyro.beta - this.prevGyro.beta;
      if (Math.abs(dYaw) + Math.abs(dPitch) > 2.2) {
        fastPan = true;
      } else {
        shiftX = Math.round((dYaw / 62) * w);
        shiftY = Math.round((dPitch / 48) * h);
      }
    }

    this.rawForeground.fill(0);
    let activeCount = 0;

    if (this.prevLuma && !fastPan) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const px = x - shiftX;
          const py = y - shiftY;
          if (px < 0 || px >= w || py < 0 || py >= h) continue;
          const diff = Math.abs(luma[y * w + x] - this.prevLuma[py * w + px]);
          if (diff > 30) {
            this.rawForeground[y * w + x] = 1;
          }
        }
      }

      // Fast cleanup with immediate ghost-free decay (eliminates onion-skinning trails)
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const row = y * w;
          const neighbors =
            this.rawForeground[row - w + x - 1] +
            this.rawForeground[row - w + x] +
            this.rawForeground[row - w + x + 1] +
            this.rawForeground[row + x - 1] +
            this.rawForeground[row + x] +
            this.rawForeground[row + x + 1] +
            this.rawForeground[row + w + x - 1] +
            this.rawForeground[row + w + x] +
            this.rawForeground[row + w + x + 1];
          const idx = row + x;
          if (neighbors >= 5) {
            this.persistedMask[idx] = Math.min(1, this.persistedMask[idx] + 0.65);
          } else {
            const faded = this.persistedMask[idx] * 0.35 - 0.12;
            this.persistedMask[idx] = faded > 0.15 ? faded : 0;
          }
          if (this.persistedMask[idx] > 0.5) activeCount++;
        }
      }
    } else {
      // Clear mask immediately on camera rotation instead of leaving onion-skin trails
      this.persistedMask.fill(0);
    }

    if (!this.prevLuma) this.prevLuma = new Float32Array(len);
    this.prevLuma.set(luma);
    if (gyro) this.prevGyro = { ...gyro };

    const coverage = activeCount / len;
    outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

    // Reject full-screen shifts (>48% coverage) or sensor grain (<1.5%)
    if (fastPan || coverage < 0.015 || coverage > 0.48) {
      return;
    }

    const maskData = this.maskImgData.data;
    for (let i = 0; i < len; i++) {
      const m = this.persistedMask[i];
      // Crisp silhouette alpha (zero hazy translucent onion-skin ghosts)
      const alpha = m >= 0.5 ? 245 : 0;
      const p = i * 4;
      maskData[p] = 255;
      maskData[p + 1] = 255;
      maskData[p + 2] = 255;
      maskData[p + 3] = alpha;
    }
    this.maskCtx.putImageData(this.maskImgData, 0, 0);

    // Composite directly onto compact outputCanvas without expensive CPU blur()
    outCtx.save();
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.imageSmoothingEnabled = true;
    outCtx.drawImage(this.maskCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
    outCtx.globalCompositeOperation = 'source-in';
    outCtx.drawImage(videoEl, 0, 0, outputCanvas.width, outputCanvas.height);
    outCtx.restore();
  }
}
