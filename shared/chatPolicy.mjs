import { encodeGeohash } from '../server/services/pol.mjs';

export const CHAT_SIGHT_MAX_DISTANCE_M = 75;
export const CHAT_SIGHT_CLIENT_DISTANCE_M = 60;
export const CHAT_SIGHT_MAX_ALT_DELTA_M = 65;
export const CHAT_SIGHT_MAX_AGE_MS = 5 * 60 * 1000;
export const PIN_PARCEL_PRESENCE_MAX_AGE_MS = 90 * 1000;
export const PIN_PARCEL_MAX_DISTANCE_M = 45;
export const PIN_BATCH_MAX_CIPHERTEXT_LEN = 48000;
export const CHAT_MSG_MAX_CIPHERTEXT_LEN = 12000;
export const CHAT_CLUE_PROMPT_MAX = 140;
export const CHAT_CLUE_PBKDF2_ITERATIONS = 210000;

export const LAND_CHAT_ACCESS_MODES = ['open', 'contributors', 'whitelist', 'off'];
export const DEFAULT_LAND_CHAT_ACCESS_MODE = 'open';
export const DEFAULT_LAND_CHAT_ALLOW_AGENTS = true;

export function normalizeLandChatAccessMode(raw) {
  const clean = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!clean || clean === 'default' || clean === 'open' || clean === 'everyone' || clean === 'all' || clean === 'public') {
    return 'open';
  }
  if (clean === 'contributors' || clean === 'contributors_only') {
    return 'contributors';
  }
  if (clean === 'whitelist' || clean === 'whitelist_only' || clean === 'allowlist') {
    return 'whitelist';
  }
  if (clean === 'off' || clean === 'disabled' || clean === 'none' || clean === 'false') {
    return 'off';
  }
  return DEFAULT_LAND_CHAT_ACCESS_MODE;
}

export function normalizeLandChatAllowAgents(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_LAND_CHAT_ALLOW_AGENTS;
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const clean = String(raw).trim().toLowerCase();
  if (clean === '0' || clean === 'false' || clean === 'off' || clean === 'no' || clean === 'disabled') {
    return false;
  }
  return true;
}

export function formatLandChatAccessModeLabel(mode) {
  const normalized = normalizeLandChatAccessMode(mode);
  if (normalized === 'contributors') return 'Contributors Only';
  if (normalized === 'whitelist') return 'Whitelist Only';
  if (normalized === 'off') return 'Off (Disabled)';
  return 'Everyone On Site (Google Login)';
}

export class ChatHttpError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.name = 'ChatHttpError';
    this.statusCode = statusCode;
    this.extra = extra && typeof extra === 'object' ? extra : {};
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

export function buildParcelPresenceSignPayload({
  sculptureId,
  parcelId,
  geohash,
  challengeId,
  challengeNonce,
  pubFingerprint,
  lat,
  lng,
  cameraFrames,
  visualDHash,
  selectedAt
}) {
  return [
    'GRAFFILAND-PARCEL-PRESENCE-V1',
    sculptureId,
    parcelId,
    String(geohash || '').toLowerCase(),
    challengeId,
    challengeNonce,
    pubFingerprint,
    String(lat),
    String(lng),
    String(cameraFrames),
    String(visualDHash || ''),
    selectedAt
  ].join('|');
}

function b64ToUint8(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyParcelPresenceSignature({
  ecdhPublicJwk,
  signPublicJwk,
  pubFingerprint,
  payload,
  signatureB64
}) {
  if (!ecdhPublicJwk || !signPublicJwk || !pubFingerprint || !signatureB64) {
    throw new ChatHttpError(403, 'Signed device presence proof is required.');
  }
  const canonicalFpInput = JSON.stringify({
    e: [ecdhPublicJwk.x, ecdhPublicJwk.y],
    s: [signPublicJwk.x, signPublicJwk.y]
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFpInput));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
    .toUpperCase();
  const expectedFp = `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
  if (expectedFp !== pubFingerprint) {
    throw new ChatHttpError(403, 'Device identity fingerprint mismatch.');
  }

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: String(signPublicJwk.x), y: String(signPublicJwk.y) },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64ToUint8(signatureB64),
      new TextEncoder().encode(payload)
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new ChatHttpError(403, 'Invalid cryptographic parcel presence signature.');
  }
  return true;
}

export function verifyParcelPhysicalPresence({
  sightProof,
  polSnapshot,
  deviceProfile,
  userAgent = '',
  sculpture
}) {
  const baseSight = verifyCameraSightProof({
    sightProof,
    deviceProfile,
    userAgent,
    sculpture
  });

  const selectedMs = new Date(sightProof.selectedAt || 0).getTime();
  if (!Number.isFinite(selectedMs) || Math.abs(Date.now() - selectedMs) > PIN_PARCEL_PRESENCE_MAX_AGE_MS) {
    throw new ChatHttpError(
      403,
      'Parcel presence proof expired. Point your live AR camera at the sculpture again.'
    );
  }

  const lat = Number(sightProof.lat);
  const lng = Number(sightProof.lng);
  const visitorGeohash = encodeGeohash(lat, lng, 8).toLowerCase();
  const targetGeohash = String(sculpture.geohash || '').toLowerCase();
  if (!targetGeohash || visitorGeohash !== targetGeohash) {
    throw new ChatHttpError(
      403,
      `Location proof failed: you must stand physically inside Virtual Land ${sculpture.parcel_id} (detected parcel GLAND-${visitorGeohash.toUpperCase()}).`
    );
  }

  if (baseSight.distanceMeters > PIN_PARCEL_MAX_DISTANCE_M) {
    throw new ChatHttpError(
      403,
      `Stand right at the sculpture on parcel ${sculpture.parcel_id} (${baseSight.distanceMeters}m away; max ${PIN_PARCEL_MAX_DISTANCE_M}m).`
    );
  }

  const camFrames = Math.max(
    Number(polSnapshot?.cameraFrames || 0),
    Number(sightProof?.cameraFrames || 0)
  );
  if (camFrames < 3) {
    throw new ChatHttpError(
      403,
      'Live camera frames required (keep camera pointed at sculpture to decrypt pinned messages).'
    );
  }

  const visualDHash = String(polSnapshot?.visualDHash || sightProof?.visualDHash || '').trim();
  if (!/^[0-9a-f]{8,64}$/i.test(visualDHash)) {
    throw new ChatHttpError(403, 'Live camera perceptual fingerprint (visualDHash) is required.');
  }

  const gyroCount = Array.isArray(polSnapshot?.gyroSamples)
    ? polSnapshot.gyroSamples.length
    : Number(polSnapshot?.gyroSamples || 0);
  const opticalFlow = Number(
    polSnapshot?.opticalFlowCorrelation ?? sightProof?.opticalFlowCorrelation ?? 0
  );
  if (gyroCount < 2 || !Number.isFinite(opticalFlow) || opticalFlow < 0.3) {
    throw new ChatHttpError(
      403,
      'Anti-spoof camera/gyro motion telemetry check failed. Move your phone gently while aiming at the sculpture.'
    );
  }

  const gpsSamples = Array.isArray(polSnapshot?.gpsSamples) ? polSnapshot.gpsSamples : [];
  for (let i = 1; i < gpsSamples.length; i += 1) {
    const a = gpsSamples[i - 1];
    const b = gpsSamples[i];
    const dt = Math.max(0.5, (Number(b.t || 0) - Number(a.t || 0)) / 1000);
    const speed = haversineMeters(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng)) / dt;
    if (speed >= 60) {
      throw new ChatHttpError(403, 'Suspicious GPS teleport detected; presence proof rejected.');
    }
  }

  const rawAcc = sightProof?.accuracy ?? gpsSamples.at?.(-1)?.accuracy;
  if (rawAcc !== undefined && rawAcc !== null) {
    const acc = Number(rawAcc);
    if (!Number.isFinite(acc) || acc <= 0 || acc > 50) {
      throw new ChatHttpError(403, 'High-accuracy GPS fix (<= 50m) is required inside the parcel.');
    }
  }

  return {
    ...baseSight,
    visitorGeohash,
    cameraFrames: camFrames,
    opticalFlowCorrelation: opticalFlow,
    visualDHash,
    selectedAt: baseSight.proofSummary.selectedAt
  };
}
