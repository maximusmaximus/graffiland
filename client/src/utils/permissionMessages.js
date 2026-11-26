// Short, actionable copy for phone camera, GPS, motion & publish errors (no raw browser strings).

export function detectMobilePlatform(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export function describeGeolocationError(err, options = {}) {
  const platform = detectMobilePlatform(options.userAgent);
  // GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
  if (err?.code === 1) {
    if (platform === 'ios') {
      return 'Location blocked. Settings → Privacy → Location Services → Safari → While Using (Precise), then reload.';
    }
    if (platform === 'android') {
      return 'Location blocked. Tap address bar lock → Permissions → Allow Location, then reload.';
    }
    return 'Location blocked. Allow Location in browser settings, then reload.';
  }
  if (err?.code === 3) {
    return 'No GPS fix yet. Turn on Location in phone Settings and step outside.';
  }
  if (platform === 'ios') {
    return 'Location unavailable. Turn on Settings → Privacy → Location Services.';
  }
  if (platform === 'android') {
    return 'Location unavailable. Turn on phone Location (GPS) in Quick Settings.';
  }
  return 'Location unavailable. Turn on Location Services in phone Settings.';
}

export function describeCameraError(err, options = {}) {
  const platform = detectMobilePlatform(options.userAgent);
  const name = String(err?.name || '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    if (platform === 'ios') {
      return 'Camera blocked. Settings → Safari → Camera → Allow, then tap Retry Camera.';
    }
    if (platform === 'android') {
      return 'Camera blocked. Tap address bar lock → Permissions → Allow Camera, then tap Retry Camera.';
    }
    return 'Camera blocked. Allow Camera in browser settings, then tap Retry Camera.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No rear camera found. Open on a phone with a camera.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Camera in use. Close other camera apps, then tap Retry Camera.';
  }
  return 'Camera failed. Tap Retry Camera.';
}

export function describeMotionError(reason = 'denied', options = {}) {
  const platform = detectMobilePlatform(options.userAgent);
  if (reason === 'denied') {
    if (platform === 'ios') {
      return 'Motion blocked. Settings → Safari → Motion & Orientation Access → On, then reload.';
    }
    if (platform === 'android') {
      return 'Motion blocked. Allow Motion Sensors in site settings, then reload.';
    }
    return 'Motion blocked. Enable Motion & Orientation in phone Settings, or drag to aim.';
  }
  return 'Motion sensors off. Enable Motion & Orientation in phone Settings, or drag to aim.';
}

export function describeHttpsRequiredError() {
  return 'Open on HTTPS to use camera & GPS.';
}

export function describeLocationNeededAction(options = {}) {
  const platform = detectMobilePlatform(options.userAgent);
  if (platform === 'ios') {
    return 'Turn on Location: Settings → Privacy → Location Services → Safari, then step outside.';
  }
  if (platform === 'android') {
    return 'Turn on Location in Quick Settings & allow Location for this site.';
  }
  return 'Turn on phone Location & allow site access for GPS.';
}

export function describeCameraNeededAction(options = {}) {
  const platform = detectMobilePlatform(options.userAgent);
  if (platform === 'ios') {
    return 'Allow Camera: Settings → Safari → Camera → Allow, then tap Retry Camera.';
  }
  if (platform === 'android') {
    return 'Allow Camera: address bar lock → Permissions → Camera, then tap Retry Camera.';
  }
  return 'Allow Camera in browser settings, then tap Retry Camera.';
}

export function describeApiErrorForMobile(err, options = {}) {
  const raw = String(err?.message || err || '').trim();
  if (!raw) return 'Action failed. Check connection and retry.';
  const lower = raw.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) {
    return 'No connection. Turn off Airplane Mode or switch Wi-Fi/cellular, then retry.';
  }
  if (lower.includes('gps') || lower.includes('location')) {
    return describeLocationNeededAction(options);
  }
  if (lower.includes('camera')) {
    return describeCameraNeededAction(options);
  }
  if (lower.includes('unauthorized') || lower.includes('sign in') || lower.includes('authentication')) {
    return 'Sign in with Google to continue.';
  }
  return raw;
}
