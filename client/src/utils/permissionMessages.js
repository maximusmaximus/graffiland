// Plain-language, actionable copy for camera / location failures (no raw browser error strings).

export function describeGeolocationError(err) {
  // GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
  if (err?.code === 1) {
    return 'Location is blocked. Allow location for this site in your browser settings, then reload to place art on Virtual Land.';
  }
  if (err?.code === 3) {
    return 'Still looking for a GPS fix. Step outside or near a window; this updates automatically.';
  }
  return 'Location is unavailable right now. Check that Location Services are on for your browser.';
}

export function describeCameraError(err) {
  const name = String(err?.name || '');
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera is blocked. Allow camera for this site in your browser settings, then tap Retry Camera.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No rear camera found. AR placement needs a phone or tablet camera.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Camera is in use by another app. Close it, then tap Retry Camera.';
  }
  return 'Camera could not start. Tap Retry Camera to try again.';
}
