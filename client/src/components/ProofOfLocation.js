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

    // Multi-angle Scene Analysis Coverage grid (4 yaw cols x 3 pitch rows = 12 sectors)
    this.scanCols = 4;
    this.scanRows = 3;
    this.scanTargetCount = 9;
    this.scanSectors = new Array(this.scanCols * this.scanRows).fill(false);
    this.anchorYawDeg = null;
    this.latestPose = null;
    this.sceneContrast = 0;
    this.latestGray = null;
  }

  analyzeSurfacePatch(normX = 0.5, normY = 0.5) {
    const gray = this.latestGray;
    if (!gray) {
      return {
        localContrast: 0,
        horizEdgeRatio: 1,
        brightness: 128,
        sharpnessScore: 0.5
      };
    }
    const w = 48;
    const h = 36;
    const cx = Math.max(4, Math.min(w - 5, Math.round(normX * w)));
    const cy = Math.max(4, Math.min(h - 5, Math.round(normY * h)));
    let gxSum = 0;
    let gySum = 0;
    let lumaSum = 0;
    let count = 0;
    for (let y = cy - 3; y <= cy + 3; y++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        const c = gray[y * w + x];
        gxSum += Math.abs(c - gray[y * w + x + 1]);
        gySum += Math.abs(c - gray[(y + 1) * w + x]);
        lumaSum += c;
        count++;
      }
    }
    const avgGx = gxSum / count;
    const avgGy = gySum / count;
    const localContrast = avgGx + avgGy;
    const horizEdgeRatio = avgGx > 0.2 ? avgGy / avgGx : 1;
    const brightness = lumaSum / count;
    const sharpnessScore = Math.max(0.1, Math.min(1, localContrast / 22));
    return { localContrast, horizEdgeRatio, brightness, sharpnessScore };
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

  recordViewPose({ yawDeg, pitchDeg, hasCamera = false }) {
    if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) {
      return this.getSceneCoverage();
    }
    if (this.anchorYawDeg === null) {
      this.anchorYawDeg = yawDeg;
    }

    let relYaw = yawDeg - this.anchorYawDeg;
    while (relYaw > 180) relYaw -= 360;
    while (relYaw < -180) relYaw += 360;

    const maxYawHalf = 64;
    const clampedYaw = Math.max(-maxYawHalf, Math.min(maxYawHalf, relYaw));
    const normX = (clampedYaw + maxYawHalf) / (maxYawHalf * 2);
    const col = Math.max(0, Math.min(this.scanCols - 1, Math.floor(normX * this.scanCols)));

    const maxPitchHalf = 32;
    const clampedPitch = Math.max(-maxPitchHalf, Math.min(maxPitchHalf, pitchDeg));
    // pitch > 0 is looking up (row 0), pitch < 0 is looking down (row 2)
    const normY = 1 - (clampedPitch + maxPitchHalf) / (maxPitchHalf * 2);
    const row = Math.max(0, Math.min(this.scanRows - 1, Math.floor(normY * this.scanRows)));

    this.latestPose = {
      yawDeg,
      pitchDeg,
      relYaw,
      col,
      row,
      cursorX: Math.max(0.06, Math.min(0.94, normX)),
      cursorY: Math.max(0.08, Math.min(0.92, normY)),
      t: Date.now()
    };

    if (hasCamera && (this.sceneContrast >= 1.0 || this.cameraFrames >= 2)) {
      this.scanSectors[row * this.scanCols + col] = true;
    }

    return this.getSceneCoverage();
  }

  getRefinedLocation(fallbackLocation = null) {
    if (!this.gpsSamples.length) return fallbackLocation;
    const latest = this.gpsSamples[this.gpsSamples.length - 1];
    const recent = this.gpsSamples.slice(-12);

    let wSum = 0;
    let latSum = 0;
    let lngSum = 0;
    let altWSum = 0;
    let altSum = 0;
    let bestAcc = Infinity;

    for (const s of recent) {
      const acc = Number.isFinite(s.accuracy) && s.accuracy > 0 ? s.accuracy : 25;
      if (acc < bestAcc) bestAcc = acc;
      const w = 1 / Math.max(9, acc * acc);
      wSum += w;
      latSum += s.lat * w;
      lngSum += s.lng * w;
      if (Number.isFinite(s.altitude)) {
        altWSum += w;
        altSum += s.altitude * w;
      }
    }

    if (wSum <= 0) return fallbackLocation;
    const avgLat = latSum / wSum;
    const avgLng = lngSum / wSum;
    const avgAlt = altWSum > 0 ? altSum / altWSum : (fallbackLocation?.altitude ?? latest.altitude ?? null);

    return {
      ...(fallbackLocation || {}),
      lat: avgLat,
      lng: avgLng,
      altitude: avgAlt,
      accuracy: Number.isFinite(bestAcc) ? Math.min(bestAcc, fallbackLocation?.accuracy ?? bestAcc) : fallbackLocation?.accuracy ?? null,
      altitudeAccuracy: fallbackLocation?.altitudeAccuracy ?? null,
      heading: fallbackLocation?.heading ?? latest.heading ?? null,
      speed: fallbackLocation?.speed ?? latest.speed ?? null
    };
  }

  getSceneCoverage() {
    const scannedCount = this.scanSectors.filter(Boolean).length;
    const targetCount = this.scanTargetCount;
    const sweepProgress = Math.min(1, scannedCount / targetCount);
    const hasCamera = this.cameraFrames > 0;
    const flowFactor = this.flowTotal >= 2 ? 1 : Math.min(0.85, this.cameraFrames / 5);
    const gpsBonus = this.gpsSamples.length > 0 ? 1 : 0.6;
    const stability = Math.min(1, flowFactor * 0.7 + gpsBonus * 0.3);

    const rawPct = hasCamera ? Math.round((sweepProgress * 0.88 + stability * 0.12) * 100) : 0;
    const optimal = scannedCount >= targetCount && this.cameraFrames >= 4;
    const coveragePct = optimal ? 100 : Math.min(99, rawPct);

    // Count missing regions to guide physical phone movement
    let leftMissing = 0;
    let rightMissing = 0;
    let upMissing = 0;
    let downMissing = 0;
    for (let r = 0; r < this.scanRows; r++) {
      for (let c = 0; c < this.scanCols; c++) {
        if (!this.scanSectors[r * this.scanCols + c]) {
          if (c < 2) leftMissing++;
          else rightMissing++;
          if (r === 0) upMissing++;
          if (r === 2) downMissing++;
        }
      }
    }

    let hint = 'Move phone around scene';
    if (!hasCamera) {
      hint = 'Camera needed for scan';
    } else if (optimal) {
      hint = 'Optimal scene lock';
    } else if (scannedCount <= 2) {
      hint = 'Move phone around scene';
    } else if (upMissing >= 2 && upMissing >= leftMissing && upMissing >= rightMissing) {
      hint = 'Tilt up & sweep scene';
    } else if (downMissing >= 2 && downMissing > leftMissing && downMissing > rightMissing) {
      hint = 'Tilt down & sweep scene';
    } else if (leftMissing > rightMissing) {
      hint = 'Pan left to sharpen lock';
    } else if (rightMissing > leftMissing) {
      hint = 'Pan right to sharpen lock';
    } else {
      hint = 'Sweep phone for 100%';
    }

    // Visual-inertial local placement precision estimate tightens as angular sweep fills
    const precisionMeters = Math.round((2.4 - sweepProgress * 2.25) * 100) / 100;

    return {
      coveragePct,
      scannedCount,
      targetCount,
      totalSectors: this.scanSectors.length,
      sectors: [...this.scanSectors],
      cursorX: this.latestPose?.cursorX ?? 0.5,
      cursorY: this.latestPose?.cursorY ?? 0.5,
      optimal,
      precisionMeters,
      hint
    };
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

    // Quantized 5-color ambient palette + texture contrast check
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
    let edgeSum = 0;
    let edgeSamples = 0;
    for (let y = 1; y < 35; y += 2) {
      for (let x = 1; x < 47; x += 2) {
        const c = gray[y * 48 + x];
        edgeSum += Math.abs(c - gray[y * 48 + x + 1]) + Math.abs(c - gray[(y + 1) * 48 + x]);
        edgeSamples += 2;
      }
    }
    this.sceneContrast = edgeSamples ? edgeSum / edgeSamples : 0;
    this.latestGray = gray;
    if (this.latestPose && (this.sceneContrast >= 1.0 || this.cameraFrames >= 2)) {
      this.scanSectors[this.latestPose.row * this.scanCols + this.latestPose.col] = true;
    } else if (!this.latestPose && (this.sceneContrast >= 1.0 || this.cameraFrames >= 2)) {
      // Seed center sector cleanly on initial stationary startup frames
      this.scanSectors[this.scanCols + 1] = true;
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
    const coverage = this.getSceneCoverage();
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
      deviceOrientationSummary: this.latestGyro,
      sceneCoveragePct: coverage.coveragePct,
      scannedSectors: coverage.scannedCount,
      placementPrecisionMeters: coverage.precisionMeters
    };
  }
}
