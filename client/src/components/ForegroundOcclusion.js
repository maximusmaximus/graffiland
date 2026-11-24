/**
 * Computes source crop rectangle matching CSS `object-fit: cover` so occlusion
 * sampling and compositing align pixel-for-pixel with `<video class="camera-feed">`.
 */
export function computeVideoCoverCrop(videoW, videoH, targetW, targetH) {
  const vw = Math.max(1, Number(videoW) || 1);
  const vh = Math.max(1, Number(videoH) || 1);
  const tw = Math.max(1, Number(targetW) || 1);
  const th = Math.max(1, Number(targetH) || 1);
  const videoAspect = vw / vh;
  const targetAspect = tw / th;
  if (videoAspect > targetAspect) {
    const sw = vh * targetAspect;
    return { sx: (vw - sw) * 0.5, sy: 0, sw, sh: vh };
  }
  const sh = vw / targetAspect;
  return { sx: 0, sy: (vh - sh) * 0.5, sw: vw, sh };
}

/**
 * Gyro-Compensated Foreground Occlusion & Origin Visibility Detector
 * Detects hands, people, or closer objects crossing/holding in front of the
 * sculpture or its origin, composites them crisply over the AR WebGL layer so
 * occluded sculpture/origin parts stay hidden behind real items, and reports
 * whether the drawing origin is currently blocked.
 */
export class ForegroundOcclusionCompositor {
  constructor() {
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
    this.refLuma = null;
    this.currLuma = new Float32Array(len);
    this.scratchLuma = new Float32Array(len);
    this.rawForeground = new Uint8Array(len);
    this.persistedMask = new Float32Array(len);
    this.prevGyro = null;
    this.lensCovered = false;
    this.lastOriginStatus = {
      originBlocked: false,
      originVisible: true,
      blockedRatio: 0,
      cursorBlockedRatio: 0,
      reason: ''
    };
  }

  reset() {
    this.prevLuma = null;
    this.refLuma = null;
    this.prevGyro = null;
    this.persistedMask.fill(0);
    this.lensCovered = false;
    this.lastOriginStatus = {
      originBlocked: false,
      originVisible: true,
      blockedRatio: 0,
      cursorBlockedRatio: 0,
      reason: ''
    };
  }

  _shiftBuffer(buf, shiftX, shiftY, fallbackLuma) {
    const { width: w, height: h } = this;
    const scratch = this.scratchLuma;
    for (let y = 0; y < h; y++) {
      const py = y - shiftY;
      for (let x = 0; x < w; x++) {
        const px = x - shiftX;
        const idx = y * w + x;
        if (px >= 0 && px < w && py >= 0 && py < h) {
          scratch[idx] = buf[py * w + px];
        } else {
          scratch[idx] = fallbackLuma[idx];
        }
      }
    }
    buf.set(scratch);
  }

  _sampleMaskRatio(normX, normY, radiusPx = 5) {
    const { width: w, height: h } = this;
    const cx = Math.max(0, Math.min(w - 1, Math.round(normX * w)));
    const cy = Math.max(0, Math.min(h - 1, Math.round(normY * h)));
    let hits = 0;
    let total = 0;
    const minY = Math.max(0, cy - radiusPx);
    const maxY = Math.min(h - 1, cy + radiusPx);
    const minX = Math.max(0, cx - radiusPx);
    const maxX = Math.min(w - 1, cx + radiusPx);
    for (let y = minY; y <= maxY; y++) {
      const row = y * w;
      for (let x = minX; x <= maxX; x++) {
        total++;
        if (this.persistedMask[row + x] >= 0.5) hits++;
      }
    }
    return total ? hits / total : 0;
  }

  evaluateOriginVisibility(originScreen = null, cursorScreen = { x: 0.5, y: 0.5, onScreen: true }) {
    if (this.lensCovered) {
      this.lastOriginStatus = {
        originBlocked: true,
        originVisible: false,
        blockedRatio: 1,
        cursorBlockedRatio: 1,
        reason: 'Origin is blocked — uncover the camera or remove the item blocking the drawing origin.'
      };
      return this.lastOriginStatus;
    }

    if (originScreen?.requiredVisible && !originScreen.onScreen) {
      this.lastOriginStatus = {
        originBlocked: true,
        originVisible: false,
        blockedRatio: 1,
        cursorBlockedRatio: 0,
        reason: 'Origin is out of view — point your camera at the visible sculpture origin to paint.'
      };
      return this.lastOriginStatus;
    }

    const originRatio =
      originScreen?.onScreen ? this._sampleMaskRatio(originScreen.x, originScreen.y, 5) : 0;
    const cursorRatio =
      cursorScreen?.onScreen ? this._sampleMaskRatio(cursorScreen.x, cursorScreen.y, 5) : 0;

    if (originRatio >= 0.3 || cursorRatio >= 0.34) {
      this.lastOriginStatus = {
        originBlocked: true,
        originVisible: false,
        blockedRatio: Math.round(originRatio * 100) / 100,
        cursorBlockedRatio: Math.round(cursorRatio * 100) / 100,
        reason: 'Origin is blocked by an object in front of it — clear the obstruction before painting.'
      };
      return this.lastOriginStatus;
    }

    this.lastOriginStatus = {
      originBlocked: false,
      originVisible: true,
      blockedRatio: Math.round(originRatio * 100) / 100,
      cursorBlockedRatio: Math.round(cursorRatio * 100) / 100,
      reason: ''
    };
    return this.lastOriginStatus;
  }

  processFrame(videoEl, outputCanvas, gyro, enabled = true, originScreen = null) {
    if (!outputCanvas) return this.lastOriginStatus;
    const outCtx = outputCanvas.getContext('2d');
    if (!outCtx) return this.lastOriginStatus;

    if (!enabled) {
      outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      this.persistedMask.fill(0);
      this.lensCovered = false;
      this.lastOriginStatus = {
        originBlocked: false,
        originVisible: true,
        blockedRatio: 0,
        cursorBlockedRatio: 0,
        reason: ''
      };
      return this.lastOriginStatus;
    }

    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
      outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      return this.evaluateOriginVisibility(originScreen);
    }

    const { width: w, height: h } = this;
    const len = w * h;
    const coverCrop = computeVideoCoverCrop(
      videoEl.videoWidth,
      videoEl.videoHeight,
      outputCanvas.width,
      outputCanvas.height
    );
    try {
      this.sampleCtx.drawImage(
        videoEl,
        coverCrop.sx,
        coverCrop.sy,
        coverCrop.sw,
        coverCrop.sh,
        0,
        0,
        w,
        h
      );
    } catch {
      outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      return this.evaluateOriginVisibility(originScreen);
    }
    const frame = this.sampleCtx.getImageData(0, 0, w, h).data;
    const luma = this.currLuma;

    let lumaSum = 0;
    for (let i = 0; i < len; i++) {
      const p = i * 4;
      const v = 0.299 * frame[p] + 0.587 * frame[p + 1] + 0.114 * frame[p + 2];
      luma[i] = v;
      lumaSum += v;
    }
    const meanLuma = lumaSum / len;

    let edgeSum = 0;
    let edgeCount = 0;
    for (let y = 8; y < h - 8; y += 3) {
      for (let x = 8; x < w - 8; x += 3) {
        edgeSum += Math.abs(luma[y * w + x] - luma[y * w + x + 2]);
        edgeCount++;
      }
    }
    const avgEdge = edgeCount ? edgeSum / edgeCount : 0;
    this.lensCovered = meanLuma < 16 && avgEdge < 3.0;

    let shiftX = 0;
    let shiftY = 0;
    let fastPan = false;

    if (gyro && this.prevGyro) {
      let dYaw = gyro.alpha - this.prevGyro.alpha;
      if (dYaw > 180) dYaw -= 360;
      if (dYaw < -180) dYaw += 360;
      const dPitch = gyro.beta - this.prevGyro.beta;
      if (Math.abs(dYaw) + Math.abs(dPitch) > 2.6) {
        fastPan = true;
      } else {
        shiftX = Math.round((dYaw / 62) * w);
        shiftY = Math.round((dPitch / 48) * h);
      }
    }

    this.rawForeground.fill(0);
    let activeCount = 0;

    if (this.refLuma && this.prevLuma && !fastPan) {
      if (shiftX !== 0 || shiftY !== 0) {
        this._shiftBuffer(this.refLuma, shiftX, shiftY, luma);
        this._shiftBuffer(this.prevLuma, shiftX, shiftY, luma);
      }

      // Compensate gradual camera auto-exposure shifts without hiding real foreground objects
      let deltaSum = 0;
      let deltaCount = 0;
      for (let i = 0; i < len; i += 4) {
        const d = luma[i] - this.refLuma[i];
        if (Math.abs(d) < 30) {
          deltaSum += d;
          deltaCount++;
        }
      }
      const dcShift =
        deltaCount > len * 0.08 ? Math.max(-16, Math.min(16, deltaSum / deltaCount)) : 0;

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = y * w + x;
          const adj = luma[idx] - dcShift;
          const diffRef = Math.abs(adj - this.refLuma[idx]);
          const diffMotion = Math.abs(adj - this.prevLuma[idx]);
          if (diffRef > 24 || diffMotion > 28) {
            this.rawForeground[idx] = 1;
          }
        }
      }

      for (let y = 1; y < h - 1; y++) {
        const row = y * w;
        for (let x = 1; x < w - 1; x++) {
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
            // Hold background reference behind the item so stationary blockers stay masked
            this.persistedMask[idx] = 1;
            activeCount++;
          } else {
            this.persistedMask[idx] = 0;
            this.refLuma[idx] = this.refLuma[idx] * 0.9 + luma[idx] * 0.1;
          }
        }
      }
    } else {
      if (!this.refLuma) this.refLuma = new Float32Array(len);
      if (!this.prevLuma) this.prevLuma = new Float32Array(len);
      this.refLuma.set(luma);
      this.persistedMask.fill(0);
    }

    if (!this.prevLuma) this.prevLuma = new Float32Array(len);
    this.prevLuma.set(luma);
    if (gyro) this.prevGyro = { ...gyro };

    outCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);

    const coverage = activeCount / len;
    if (enabled && !fastPan && coverage >= 0.024 && coverage <= 0.88) {
      const maskData = this.maskImgData.data;
      for (let i = 0; i < len; i++) {
        const p = i * 4;
        maskData[p] = 255;
        maskData[p + 1] = 255;
        maskData[p + 2] = 255;
        maskData[p + 3] = this.persistedMask[i] >= 0.5 ? 245 : 0;
      }
      this.maskCtx.putImageData(this.maskImgData, 0, 0);

      outCtx.save();
      outCtx.globalCompositeOperation = 'source-over';
      outCtx.imageSmoothingEnabled = true;
      outCtx.drawImage(this.maskCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
      outCtx.globalCompositeOperation = 'source-in';
      outCtx.drawImage(
        videoEl,
        coverCrop.sx,
        coverCrop.sy,
        coverCrop.sw,
        coverCrop.sh,
        0,
        0,
        outputCanvas.width,
        outputCanvas.height
      );
      outCtx.restore();
    }

    return this.evaluateOriginVisibility(originScreen);
  }
}
