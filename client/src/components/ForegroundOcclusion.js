/**
 * Gyro-Compensated Foreground Occlusion Compositor
 * Detects hands, people, or closer moving foreground objects crossing in front of
 * the camera while compensating for slow camera rotation, and paints only those
 * verified foreground silhouettes cleanly over the AR WebGL sculpture layer.
 */
export class ForegroundOcclusionCompositor {
  constructor() {
    // 4x mask resolution (160x120 vs 80x60) for crisp foreground occluder edges
    this.width = 160;
    this.height = 120;

    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = this.width;
    this.sampleCanvas.height = this.height;
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = this.width;
    this.maskCanvas.height = this.height;
    this.maskCtx = this.maskCanvas.getContext('2d');

    this.prevLuma = null;
    this.prevGyro = null;
    this.persistedMask = new Float32Array(this.width * this.height);
  }

  reset() {
    this.prevLuma = null;
    this.prevGyro = null;
    this.persistedMask.fill(0);
  }

  processFrame(videoEl, outputCanvas, gyro, enabled = true) {
    if (!outputCanvas) return;
    const outCtx = outputCanvas.getContext('2d');
    if (!outCtx) return;

    if (!enabled || !videoEl || videoEl.readyState < 2) {
      outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      return;
    }

    const { width: w, height: h } = this;
    this.sampleCtx.drawImage(videoEl, 0, 0, w, h);
    const frame = this.sampleCtx.getImageData(0, 0, w, h).data;
    const luma = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
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
      if (Math.abs(dYaw) + Math.abs(dPitch) > 4.5) {
        fastPan = true;
      } else {
        shiftX = Math.round((dYaw / 62) * w);
        shiftY = Math.round((dPitch / 48) * h);
      }
    }

    const rawForeground = new Uint8Array(w * h);
    let activeCount = 0;

    if (this.prevLuma && !fastPan) {
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const px = x - shiftX;
          const py = y - shiftY;
          if (px < 0 || px >= w || py < 0 || py >= h) continue;
          const diff = Math.abs(luma[y * w + x] - this.prevLuma[py * w + px]);
          if (diff > 26) {
            rawForeground[y * w + x] = 1;
          }
        }
      }

      // 3x3 morphological cleanup to keep solid foreground silhouettes and drop sensor grain
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          let neighbors = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              neighbors += rawForeground[(y + dy) * w + (x + dx)];
            }
          }
          const idx = y * w + x;
          if (neighbors >= 5) {
            this.persistedMask[idx] = Math.min(1, this.persistedMask[idx] + 0.45);
          } else {
            this.persistedMask[idx] = Math.max(0, this.persistedMask[idx] - 0.14);
          }
          if (this.persistedMask[idx] > 0.25) activeCount++;
        }
      }
    } else {
      for (let i = 0; i < w * h; i++) {
        this.persistedMask[i] = Math.max(0, this.persistedMask[i] - 0.25);
      }
    }

    this.prevLuma = luma;
    if (gyro) this.prevGyro = { ...gyro };

    const coverage = activeCount / (w * h);
    outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

    // Reject full-screen exposure flashes (>55% coverage) or noise-only frames (<1.2%)
    if (coverage < 0.012 || coverage > 0.55) {
      return;
    }

    const maskImg = this.maskCtx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const alpha = Math.round(Math.max(0, Math.min(1, this.persistedMask[i])) * 255);
      maskImg.data[i * 4] = 255;
      maskImg.data[i * 4 + 1] = 255;
      maskImg.data[i * 4 + 2] = 255;
      maskImg.data[i * 4 + 3] = alpha;
    }
    this.maskCtx.putImageData(maskImg, 0, 0);

    // Draw feathered foreground mask, then clip live camera video into it
    outCtx.save();
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.filter = 'blur(4px)';
    outCtx.drawImage(this.maskCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
    outCtx.filter = 'none';
    outCtx.globalCompositeOperation = 'source-in';
    outCtx.drawImage(videoEl, 0, 0, outputCanvas.width, outputCanvas.height);
    outCtx.restore();
  }
}
