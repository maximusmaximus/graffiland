export const CHAT_SIGHT_MAX_DISTANCE_M = 75;
export const CHAT_SIGHT_CLIENT_DISTANCE_M = 60;
export const CHAT_SIGHT_MAX_ALT_DELTA_M = 65;
export const CHAT_SIGHT_MAX_AGE_MS = 5 * 60 * 1000;
export const CHAT_MSG_MAX_CIPHERTEXT_LEN = 12000;
export const CHAT_CLUE_PROMPT_MAX = 140;
export const CHAT_CLUE_PBKDF2_ITERATIONS = 210000;

export class ChatHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'ChatHttpError';
    this.statusCode = statusCode;
  }
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function looksMobileRequest(deviceProfile, userAgent = '') {
  return Boolean(
    deviceProfile?.isMobile ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(String(userAgent || ''))
  );
}

/**
 * Verifies physical presence & live AR camera selection before allowing a client
 * to fetch encrypted board metadata/history, request a room key, or post messages.
 */
export function verifyCameraSightProof({
  sightProof,
  deviceProfile,
  userAgent = '',
  sculpture
}) {
  if (!sculpture || sculpture.hidden) {
    throw new ChatHttpError(404, 'Sculpture not found');
  }

  if (!looksMobileRequest(deviceProfile, userAgent)) {
    throw new ChatHttpError(
      403,
      'Encrypted location chats are only accessible on a mobile device while viewing the sculpture through the live AR camera.'
    );
  }

  if (!sightProof || typeof sightProof !== 'object') {
    throw new ChatHttpError(
      403,
      'Live AR camera selection proof is required to enter this sculpture chat.'
    );
  }

  if (sightProof.selectionMethod !== 'ar-camera-raycast' || !sightProof.rayHit) {
    throw new ChatHttpError(
      403,
      'You must tap the 3D sculpture directly inside the live camera view to enter its chat.'
    );
  }

  if (!sightProof.inFrustum || !sightProof.cameraReady || Number(sightProof.cameraFrames || 0) < 2) {
    throw new ChatHttpError(
      403,
      'Enable your live camera and face the sculpture in AR Preview before unlocking chat.'
    );
  }

  const selectedMs = new Date(sightProof.selectedAt || 0).getTime();
  if (!Number.isFinite(selectedMs) || Math.abs(Date.now() - selectedMs) > CHAT_SIGHT_MAX_AGE_MS) {
    throw new ChatHttpError(
      403,
      'Camera sight selection expired. Look at the sculpture in AR Preview and tap it again.'
    );
  }

  const lat = Number(sightProof.lat);
  const lng = Number(sightProof.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180 ||
    (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)
  ) {
    throw new ChatHttpError(403, 'Valid physical GPS coordinates are required.');
  }

  const distanceMeters =
    Math.round(haversineMeters(lat, lng, Number(sculpture.lat), Number(sculpture.lng)) * 10) / 10;
  if (distanceMeters > CHAT_SIGHT_MAX_DISTANCE_M) {
    throw new ChatHttpError(
      403,
      `Walk closer to this sculpture in person (${distanceMeters}m away; must be within ${CHAT_SIGHT_MAX_DISTANCE_M}m to enter chat).`
    );
  }

  let altDeltaMeters = null;
  if (
    sculpture.altitude !== null &&
    sculpture.altitude !== undefined &&
    Number.isFinite(Number(sculpture.altitude)) &&
    sightProof.altitude !== null &&
    sightProof.altitude !== undefined &&
    Number.isFinite(Number(sightProof.altitude))
  ) {
    altDeltaMeters =
      Math.round(Math.abs(Number(sightProof.altitude) - Number(sculpture.altitude)) * 10) / 10;
    if (altDeltaMeters > CHAT_SIGHT_MAX_ALT_DELTA_M) {
      throw new ChatHttpError(
        403,
        `Elevation mismatch (${altDeltaMeters}m vertical offset). View the sculpture from its physical level.`
      );
    }
  }

  const distPts = distanceMeters <= 15 ? 40 : distanceMeters <= 35 ? 32 : 24;
  const camPts = 25 + Math.min(15, Math.floor(Number(sightProof.cameraFrames || 0)));
  const flowPts = Number(sightProof.opticalFlowCorrelation || 0) >= 0.55 ? 20 : 12;
  const sightScore = Math.min(100, distPts + camPts + flowPts);

  return {
    ok: true,
    distanceMeters,
    altDeltaMeters,
    sightScore,
    proofSummary: {
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      altitude:
        sightProof.altitude !== null && sightProof.altitude !== undefined
          ? Math.round(Number(sightProof.altitude) * 100) / 100
          : null,
      distanceMeters,
      altDeltaMeters,
      cameraFrames: Number(sightProof.cameraFrames || 0),
      opticalFlowCorrelation: Number(sightProof.opticalFlowCorrelation || 0),
      visualDHash: String(sightProof.visualDHash || '').slice(0, 32),
      rayHitDistanceM: Number.isFinite(Number(sightProof.rayHitDistanceM))
        ? Math.round(Number(sightProof.rayHitDistanceM) * 100) / 100
        : null,
      selectedAt: new Date(selectedMs).toISOString(),
      sightSignatureB64: String(sightProof.sightSignatureB64 || '').slice(0, 256)
    }
  };
}
