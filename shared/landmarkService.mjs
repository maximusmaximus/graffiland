import { haversineMeters, looksMobileRequest } from './chatPolicy.mjs';
import { decodeGeohashBounds } from '../server/services/pol.mjs';

export const LANDMARK_FETCH_MAX_DISTANCE_M = 65;
export const LANDMARK_MIN_FEATURES = 12;
export const LANDMARK_MAX_KEYFRAMES = 6;
export const DEFAULT_MIN_ORB_INLIERS = 8;
export const DEFAULT_MAX_ORB_REPROJ_PX = 6.5;

export class LandmarkServiceError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function normalizeParcelId(raw) {
  return String(raw || '').trim().toUpperCase();
}

async function computeCanonicalDigestHex(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Enforces daily relayer gas-sponsorship quotas per account on chain-mutating operations.
 */
export async function checkAndConsumeRelayerQuota(
  db,
  { userId, isAdmin = false, dailyQuota = 25 }
) {
  if (!userId || isAdmin || !Number.isFinite(dailyQuota) || dailyQuota <= 0) {
    return { allowed: true, used: 0, limit: dailyQuota, consumed: false };
  }
  const dayKey = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const existing = await db.get(
    'SELECT op_count FROM relayer_usage WHERE user_id = ? AND day_key = ?',
    [userId, dayKey]
  );
  const currentCount = Number(existing?.op_count || 0);
  if (currentCount >= dailyQuota) {
    throw new LandmarkServiceError(
      `Daily relayer gas-sponsorship quota exceeded (${currentCount}/${dailyQuota} ops today). Retry tomorrow or sign transactions directly from your wallet.`,
      429,
      { quotaUsed: currentCount, dailyQuota }
    );
  }
  await db.run(
    `INSERT INTO relayer_usage (user_id, day_key, op_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET
       op_count = relayer_usage.op_count + 1,
       updated_at = excluded.updated_at`,
    [userId, dayKey, now]
  );
  return { allowed: true, used: currentCount + 1, limit: dailyQuota, consumed: true };
}

export async function refundRelayerQuota(db, { userId }) {
  if (!db || !userId) return;
  const dayKey = new Date().toISOString().slice(0, 10);
  await db
    .run(
      'UPDATE relayer_usage SET op_count = MAX(0, op_count - 1), updated_at = ? WHERE user_id = ? AND day_key = ?',
      [new Date().toISOString(), userId, dayKey]
    )
    .catch(() => {});
}

export async function getLandSecurityPolicy(db, parcelId) {
  const cleanId = normalizeParcelId(parcelId);
  const row = await db.get('SELECT * FROM land_security_policies WHERE parcel_id = ?', [cleanId]);
  return {
    parcelId: cleanId,
    requirePasskeyUnlock: Boolean(row?.require_passkey_unlock),
    requireOrbUnlock: Boolean(row?.require_orb_unlock),
    minOrbInliers: Number(row?.min_orb_inliers || DEFAULT_MIN_ORB_INLIERS),
    maxReprojErrPx: Number(row?.max_reproj_err_px || DEFAULT_MAX_ORB_REPROJ_PX),
    updatedAt: row?.updated_at || ''
  };
}

export async function assertParcelOwnerDirect(db, { parcelId, user }) {
  if (!user?.id) throw new LandmarkServiceError('Google sign-in required.', 401);
  const cleanId = normalizeParcelId(parcelId);
  const wallets = new Set(
    [user.wallet_address, user.custom_payout_address].filter(Boolean).map((a) => a.toLowerCase())
  );
  const visibleRows = await db.all(
    'SELECT recipient_address, creator_sub FROM sculptures WHERE parcel_id = ? AND hidden = 0',
    [cleanId]
  );
  const parcelRow = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanId]);
  if (!parcelRow && (!visibleRows || visibleRows.length === 0)) {
    throw new LandmarkServiceError(`Virtual Land parcel ${cleanId} not found.`, 404);
  }
  const isOwner =
    (visibleRows || []).some((r) => wallets.has(String(r.recipient_address || '').toLowerCase())) ||
    (parcelRow &&
      (wallets.has(String(parcelRow.latest_claimant_address || '').toLowerCase()) ||
        parcelRow.first_claimant_sub === user.id));
  if (!isOwner) {
    throw new LandmarkServiceError(
      `Only the Virtual Land holder of ${cleanId} can perform this operation.`,
      403
    );
  }
  return {
    parcelId: cleanId,
    geohash: parcelRow?.geohash || visibleRows[0]?.geohash || cleanId.replace(/^GLAND-/, '').toLowerCase()
  };
}

export async function updateLandSecurityPolicy(db, { parcelId, user, body }) {
  const ctx = await assertParcelOwnerDirect(db, { parcelId, user });
  const current = await getLandSecurityPolicy(db, ctx.parcelId);
  const requirePasskeyUnlock =
    body?.requirePasskeyUnlock !== undefined
      ? Boolean(body.requirePasskeyUnlock)
      : current.requirePasskeyUnlock;
  const requireOrbUnlock =
    body?.requireOrbUnlock !== undefined ? Boolean(body.requireOrbUnlock) : current.requireOrbUnlock;
  const minOrbInliers = Math.min(
    64,
    Math.max(4, Number(body?.minOrbInliers ?? current.minOrbInliers))
  );
  const maxReprojErrPx = Math.min(
    25,
    Math.max(1.5, Number(body?.maxReprojErrPx ?? current.maxReprojErrPx))
  );
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO land_security_policies (
      parcel_id, owner_sub, require_passkey_unlock, require_orb_unlock,
      min_orb_inliers, max_reproj_err_px, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      owner_sub = excluded.owner_sub,
      require_passkey_unlock = excluded.require_passkey_unlock,
      require_orb_unlock = excluded.require_orb_unlock,
      min_orb_inliers = excluded.min_orb_inliers,
      max_reproj_err_px = excluded.max_reproj_err_px,
      updated_at = excluded.updated_at`,
    [
      ctx.parcelId,
      user.id,
      requirePasskeyUnlock ? 1 : 0,
      requireOrbUnlock ? 1 : 0,
      minOrbInliers,
      maxReprojErrPx,
      now
    ]
  );

  return { policy: await getLandSecurityPolicy(db, ctx.parcelId) };
}

export function validateLandmarkPackPayload(body = {}) {
  const rawStr = JSON.stringify(body);
  if (/data:image\/|imageDataUrl|rawPixels|rgba/i.test(rawStr)) {
    throw new LandmarkServiceError(
      'Landmark packs must contain non-reversible binary ORB descriptors only — raw camera imagery is prohibited for privacy.',
      400
    );
  }
  const keyframes = Array.isArray(body?.keyframes) ? body.keyframes : [];
  if (keyframes.length < 1 || keyframes.length > LANDMARK_MAX_KEYFRAMES) {
    throw new LandmarkServiceError(
      `Provide between 1 and ${LANDMARK_MAX_KEYFRAMES} ORB descriptor keyframes.`,
      400
    );
  }

  let featureCount = 0;
  const cleanKeyframes = keyframes.map((kf, idx) => {
    const rawFeatures = Array.isArray(kf?.features) ? kf.features : [];
    const cleanFeatures = rawFeatures.slice(0, 128).map((f) => {
      const descB64 = String(f?.descB64 || '').trim();
      if (!/^[A-Za-z0-9+/=]{16,88}$/.test(descB64)) {
        throw new LandmarkServiceError('Each ORB keyframe feature must carry a valid binary descriptor.', 400);
      }
      return {
        u: Math.round(Number(f?.u || 0) * 100) / 100,
        v: Math.round(Number(f?.v || 0) * 100) / 100,
        x: Math.round(Number(f?.x || 0) * 1000) / 1000,
        y: Math.round(Number(f?.y || 0) * 1000) / 1000,
        z: Math.round(Number(f?.z || 0) * 1000) / 1000,
        angle: Math.round(Number(f?.angle || 0) * 100) / 100,
        response: Math.round(Number(f?.response || 0) * 100) / 100,
        descB64
      };
    });
    featureCount += cleanFeatures.length;
    return {
      keyframeIndex: idx,
      yawOffsetDeg: Math.round(Number(kf?.yawOffsetDeg || 0) * 10) / 10,
      pitchDeg: Math.round(Number(kf?.pitchDeg || 0) * 10) / 10,
      frameWidth: Math.min(1920, Math.max(64, Number(kf?.frameWidth || 160))),
      frameHeight: Math.min(1080, Math.max(48, Number(kf?.frameHeight || 120))),
      lightingTag: String(kf?.lightingTag || 'daylight').slice(0, 24),
      features: cleanFeatures
    };
  });

  if (featureCount < LANDMARK_MIN_FEATURES) {
    throw new LandmarkServiceError(
      `At least ${LANDMARK_MIN_FEATURES} ORB feature descriptors are required across scan keyframes (got ${featureCount}).`,
      400
    );
  }

  return { cleanKeyframes, featureCount };
}

export async function saveParcelLandmarkAnchor(
  db,
  { parcelId, user, body, pinJsonFn = null }
) {
  if (!user?.id) throw new LandmarkServiceError('Google sign-in required.', 401);
  const cleanId = normalizeParcelId(parcelId);
  const parcelRow = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanId]);
  const scRow = await db.get(
    'SELECT geohash, parcel_id, recipient_address, creator_sub FROM sculptures WHERE parcel_id = ? AND hidden = 0 LIMIT 1',
    [cleanId]
  );

  // Allow parcel owner, active IRL contributor, or publisher claiming the parcel right now
  let authorized = false;
  const wallets = new Set(
    [user.wallet_address, user.custom_payout_address].filter(Boolean).map((a) => a.toLowerCase())
  );
  if (
    (scRow && wallets.has(String(scRow.recipient_address || '').toLowerCase())) ||
    (parcelRow && wallets.has(String(parcelRow.latest_claimant_address || '').toLowerCase()))
  ) {
    authorized = true;
  } else if (scRow || parcelRow) {
    const contrib = await db.get(
      'SELECT * FROM land_contributors WHERE parcel_id = ? AND contributor_sub = ? AND can_edit_sculptures = 1',
      [cleanId, user.id]
    );
    if (contrib) authorized = true;
  }
  if (!authorized && body?.allowInitialClaim) {
    authorized = true;
  }
  if (!authorized) {
    throw new LandmarkServiceError(
      `Only the holder or IRL Contributor of ${cleanId} can save landmark anchors.`,
      403
    );
  }

  const geohash =
    parcelRow?.geohash ||
    scRow?.geohash ||
    String(body?.geohash || cleanId.replace(/^GLAND-/, '')).toLowerCase();
  const { cleanKeyframes, featureCount } = validateLandmarkPackPayload(body);

  const packDoc = {
    version: 'graffiland-orb-anchor-v1',
    parcelId: cleanId,
    geohash,
    sharedLandmarkOrigin: true,
    keyframeCount: cleanKeyframes.length,
    featureCount,
    keyframes: cleanKeyframes,
    updatedAt: new Date().toISOString()
  };
  const descriptorDigest = await computeCanonicalDigestHex(cleanKeyframes);
  packDoc.descriptorDigest = descriptorDigest;

  let ipfsPin = { cid: '', uri: '' };
  if (typeof pinJsonFn === 'function') {
    ipfsPin = await pinJsonFn(packDoc, `${cleanId}-orb-landmarks.json`);
  }

  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO parcel_landmark_anchors (
      parcel_id, geohash, anchor_cid, anchor_uri, descriptor_digest,
      keyframe_count, feature_count, anchor_pack_json,
      creator_sub, updated_by_sub, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      anchor_cid = excluded.anchor_cid,
      anchor_uri = excluded.anchor_uri,
      descriptor_digest = excluded.descriptor_digest,
      keyframe_count = excluded.keyframe_count,
      feature_count = excluded.feature_count,
      anchor_pack_json = excluded.anchor_pack_json,
      updated_by_sub = excluded.updated_by_sub,
      updated_at = excluded.updated_at`,
    [
      cleanId,
      geohash,
      ipfsPin.cid || '',
      ipfsPin.uri || '',
      descriptorDigest,
      cleanKeyframes.length,
      featureCount,
      JSON.stringify(packDoc),
      user.id,
      user.id,
      now,
      now
    ]
  );

  return {
    ok: true,
    parcelId: cleanId,
    descriptorDigest,
    keyframeCount: cleanKeyframes.length,
    featureCount,
    anchorCid: ipfsPin.cid || '',
    anchorUri: ipfsPin.uri || ''
  };
}

/**
 * Gates ORB landmark pack retrieval strictly to mobile devices physically near/inside the parcel (<= 65m)
 * so remote scrapers cannot synthesize AR relocalization spoofs off-site.
 */
/**
 * @param {any} db
 * @param {{ parcelId: string, body?: Record<string, any>, userAgent?: string }} opts
 */
export async function fetchParcelLandmarkAnchor(
  db,
  { parcelId, body = {}, userAgent = '' }
) {
  const cleanId = normalizeParcelId(parcelId);
  if (!looksMobileRequest(body?.deviceProfile, userAgent)) {
    throw new LandmarkServiceError(
      'Mobile device with live camera & GPS near the parcel is required to fetch visual ORB landmark packs.',
      403
    );
  }
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new LandmarkServiceError('Live GPS coordinates (lat, lng) are required.', 403);
  }

  const row = await db.get('SELECT * FROM parcel_landmark_anchors WHERE parcel_id = ?', [cleanId]);
  if (!row) {
    return { available: false, parcelId: cleanId, anchorPack: null };
  }

  const bounds = decodeGeohashBounds(row.geohash);
  const distM = haversineMeters(lat, lng, bounds.center[0], bounds.center[1]);
  if (distM > LANDMARK_FETCH_MAX_DISTANCE_M) {
    throw new LandmarkServiceError(
      `Walk within ${LANDMARK_FETCH_MAX_DISTANCE_M}m of Virtual Land ${cleanId} to unlock visual ORB landmark relocalization (currently ${Math.round(distM)}m away).`,
      403
    );
  }

  return {
    available: true,
    parcelId: cleanId,
    distanceMeters: Math.round(distM * 10) / 10,
    descriptorDigest: row.descriptor_digest,
    anchorCid: row.anchor_cid,
    anchorUri: row.anchor_uri,
    anchorPack: JSON.parse(row.anchor_pack_json)
  };
}

function hammingDistB64(b64A, b64B) {
  try {
    const a = atob(String(b64A || ''));
    const b = atob(String(b64B || ''));
    const len = Math.min(a.length, b.length);
    if (len < 8) return 999;
    let d = 0;
    for (let i = 0; i < len; i += 1) {
      let x = a.charCodeAt(i) ^ b.charCodeAt(i);
      while (x) {
        d += x & 1;
        x >>= 1;
      }
    }
    return d;
  } catch {
    return 999;
  }
}

export async function verifyOrbProofAgainstParcel(
  db,
  { parcelId, orbProof, policy }
) {
  const cleanId = normalizeParcelId(parcelId);
  const anchorRow = await db.get(
    'SELECT descriptor_digest, feature_count, anchor_pack_json FROM parcel_landmark_anchors WHERE parcel_id = ?',
    [cleanId]
  );
  if (!anchorRow) {
    if (policy?.requireOrbUnlock) {
      throw new LandmarkServiceError(
        `Strict ORB unlock enabled on ${cleanId}, but no landmark anchor pack has been recorded yet.`,
        403
      );
    }
    return { verified: false, skipped: true };
  }

  const minInliers = Number(policy?.minOrbInliers || DEFAULT_MIN_ORB_INLIERS);
  const maxErr = Number(policy?.maxReprojErrPx || DEFAULT_MAX_ORB_REPROJ_PX);
  if (!orbProof || typeof orbProof !== 'object') {
    throw new LandmarkServiceError(
      `Visual ORB landmark PnP match required on ${cleanId} (min ${minInliers} inliers). Aim camera at the landmark.`,
      403
    );
  }
  const digest = String(orbProof.descriptorDigest || '').trim().toLowerCase();
  if (digest !== String(anchorRow.descriptor_digest || '').toLowerCase()) {
    throw new LandmarkServiceError('ORB landmark descriptor digest mismatch.', 403);
  }
  const inliers = Number(orbProof.inlierCount || 0);
  const reprojErr = Number(orbProof.reprojectionErrorPx ?? 999);
  if (!Number.isFinite(inliers) || inliers < minInliers) {
    throw new LandmarkServiceError(
      `Insufficient visual ORB pose inliers (${inliers} < ${minInliers} required). Hold camera steady on landmark.`,
      403
    );
  }
  if (!Number.isFinite(reprojErr) || reprojErr <= 0 || reprojErr > maxErr) {
    throw new LandmarkServiceError(
      `Visual ORB PnP reprojection error too high (${reprojErr}px > ${maxErr}px max).`,
      403
    );
  }

  let serverVerifiedMatches = 0;
  if (Array.isArray(orbProof.matchedDescriptors) && anchorRow.anchor_pack_json) {
    const pack = JSON.parse(anchorRow.anchor_pack_json);
    const keyframes = Array.isArray(pack?.keyframes) ? pack.keyframes : [];
    const seen = new Set();
    for (const item of orbProof.matchedDescriptors.slice(0, 48)) {
      const kIdx = Number(item?.keyframeIndex ?? 0);
      const fIdx = Number(item?.featureIndex ?? -1);
      const feat = keyframes[kIdx]?.features?.[fIdx];
      if (!feat?.descB64 || !item?.liveDescB64) continue;
      const key = `${kIdx}:${fIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hd = hammingDistB64(item.liveDescB64, feat.descB64);
      if (hd <= 76) {
        serverVerifiedMatches += 1;
      }
    }
    if (serverVerifiedMatches < minInliers) {
      throw new LandmarkServiceError(
        `Server ORB descriptor verification failed (${serverVerifiedMatches} < ${minInliers} valid binary matches).`,
        403
      );
    }
  }

  return {
    verified: true,
    serverVerifiedMatches,
    descriptorDigest: digest,
    inlierCount: inliers,
    reprojectionErrorPx: Math.round(reprojErr * 100) / 100
  };
}
