export class ProofOfLocationTracker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 48;
    this.canvas.height = 36;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.gpsSamples = [];
    this.gyroSamples = 0;
    this.cameraFrames = 0;
    this.prevFrame = null;
    this.prevGyro = null;
    this.latestGyro = null;
    this.flowMatches = 0;
    this.flowTotal = 0;
    this.horizonLuminance = 128;
    this.ambientPalette = ['#00f5d4', '#1b263b', '#ffd166'];
    this.visualDHash = '';
    this.cameraResolution = 'unknown';
    this.cameraFacingMode = 'environment';
    this.startedAt = Date.now();
  }

  recordGps(pos) {
    if (!pos?.coords) return;
    const { latitude, longitude, accuracy, altitude, heading, speed } = pos.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const now = Date.now();
    const last = this.gpsSamples[this.gpsSamples.length - 1];
    if (!last || now - last.t >= 1200) {
      this.gpsSamples.push({
        lat: latitude,
        lng: longitude,
        accuracy: accuracy ?? null,
        altitude: altitude ?? null,
        heading: heading ?? null,
        speed: speed ?? null,
        t: now
      });
      if (this.gpsSamples.length > 40) this.gpsSamples.shift();
    }
  }

  recordGyro(alpha, beta, gamma) {
    if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return;
    this.gyroSamples += 1;
    this.latestGyro = { alpha, beta, gamma: gamma || 0, t: Date.now() };
  }

  sampleCameraFrame(videoEl) {
    if (!videoEl || videoEl.readyState < 2 || !this.ctx) return null;
    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;
    this.cameraResolution = `${vw}x${vh}`;

    this.ctx.drawImage(videoEl, 0, 0, 48, 36);
    const imgData = this.ctx.getImageData(0, 0, 48, 36).data;
    this.cameraFrames += 1;

    // 1. Upper-horizon luminance (top 40% of frame)
    let topLumSum = 0;
    const topRows = 14;
    for (let y = 0; y < topRows; y++) {
      for (let x = 0; x < 48; x++) {
        const idx = (y * 48 + x) * 4;
        topLumSum += 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
      }
    }
    this.horizonLuminance = Math.round(topLumSum / (topRows * 48));

    // 2. Quantized 5-color ambient palette
    const buckets = new Map();
    const gray = new Float32Array(48 * 36);
    for (let i = 0; i < 48 * 36; i++) {
      const idx = i * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const qr = Math.min(240, Math.round(r / 32) * 32);
      const qg = Math.min(240, Math.round(g / 32) * 32);
      const qb = Math.min(240, Math.round(b / 32) * 32);
      const hex = `#${[qr, qg, qb].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
      buckets.set(hex, (buckets.get(hex) || 0) + 1);
    }
    this.ambientPalette = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([hex]) => hex);

    // 3. Compact perceptual dHash (8x8 differences)
    let bits = '';
    for (let y = 0; y < 8; y++) {
      const sy = Math.floor((y / 8) * 36);
      for (let x = 0; x < 8; x++) {
        const sx1 = Math.floor((x / 9) * 48);
        const sx2 = Math.floor(((x + 1) / 9) * 48);
        bits += gray[sy * 48 + sx1] > gray[sy * 48 + sx2] ? '1' : '0';
      }
    }
    let hexHash = '';
    for (let i = 0; i < 64; i += 4) {
      hexHash += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    this.visualDHash = hexHash;

    // 4. Optical-flow vs Gyro angular correlation (panning right shifts image left)
    if (this.prevFrame && this.prevGyro && this.latestGyro) {
      let dYaw = this.latestGyro.alpha - this.prevGyro.alpha;
      if (dYaw > 180) dYaw -= 360;
      if (dYaw < -180) dYaw += 360;

      if (Math.abs(dYaw) >= 1.2 && Math.abs(dYaw) <= 35) {
        // Test horizontal shift dx in [-5..5] pixels for best SAD match
        let bestDx = 0;
        let bestSad = Infinity;
        for (let dx = -5; dx <= 5; dx++) {
          let sad = 0;
          let count = 0;
          for (let y = 6; y < 30; y += 2) {
            for (let x = 6; x < 42; x += 2) {
              const nx = x + dx;
              if (nx >= 0 && nx < 48) {
                sad += Math.abs(gray[y * 48 + nx] - this.prevFrame[y * 48 + x]);
                count++;
              }
            }
          }
          const avgSad = count ? sad / count : Infinity;
          if (avgSad < bestSad) {
            bestSad = avgSad;
            bestDx = dx;
          }
        }
        // In Web DeviceOrientation, rotating phone left increases alpha (+dYaw) and shifts scene right (+dx)
        this.flowTotal += 1;
        if ((dYaw > 0 && bestDx >= 0) || (dYaw < 0 && bestDx <= 0)) {
          this.flowMatches += 1;
        }
      }
    }

    this.prevFrame = gray;
    if (this.latestGyro) this.prevGyro = { ...this.latestGyro };
    return this.getSnapshot();
  }

  getOpticalFlowCorrelation() {
    if (this.flowTotal === 0) {
      return this.cameraFrames >= 4 && this.gyroSamples >= 6 ? 0.65 : 0.3;
    }
    return Math.round((this.flowMatches / this.flowTotal) * 1000) / 1000;
  }

  getSnapshot() {
    return {
      gpsSamples: this.gpsSamples,
      gyroSamples: this.gyroSamples,
      cameraFrames: this.cameraFrames,
      opticalFlowCorrelation: this.getOpticalFlowCorrelation(),
      horizonLuminance: this.horizonLuminance,
      ambientPalette: this.ambientPalette,
      visualDHash: this.visualDHash,
      cameraFacingMode: this.cameraFacingMode,
      cameraResolution: this.cameraResolution,
      sculptDurationMs: Date.now() - this.startedAt,
      deviceOrientationSummary: this.latestGyro
    };
  }
}
