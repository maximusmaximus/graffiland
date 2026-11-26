import { haversineMeters, looksMobileRequest } from './chatPolicy.mjs';
import { computeSolarPosition, decodeGeohashBounds } from '../server/services/pol.mjs';
import { seedEnvironmentTierForCoords } from './geocodeService.mjs';

export const LANDMARK_FETCH_MAX_DISTANCE_M = 65;
export const LANDMARK_MIN_FEATURES = 12;
export const LANDMARK_INITIAL_CLAIM_MIN_FEATURES = 18;
export const LANDMARK_INITIAL_CLAIM_MIN_SPREAD = 0.25;
export const LANDMARK_INITIAL_CLAIM_MIN_RESPONSE = 36;
export const LANDMARK_MAX_KEYFRAMES = 6;
export const LANDMARK_MAX_KEYFRAMES_PER_SLOT = 3;
export const DEFAULT_MIN_ORB_INLIERS = 6;
export const DEFAULT_MAX_ORB_REPROJ_PX = 8.0;

export const ENV_TIER_SEED_THRESHOLDS = {
  dense_urban: { minOrbInliers: 8, maxReprojErrPx: 5.5 },
  suburban_plaza: { minOrbInliers: 6, maxReprojErrPx: 8.0 },
  open_nature: { minOrbInliers: 4, maxReprojErrPx: 12.0 },
  unknown: { minOrbInliers: 6, maxReprojErrPx: 8.0 }
};

export const VALID_ORIGIN_SOURCES = new Set(['mobile_ar', 'browser_map', 'agent_mcp', 'unknown']);
export const VALID_ENV_TIERS = new Set(['dense_urban', 'suburban_plaza', 'open_nature', 'unknown']);

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

function normalizeOriginSource(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return VALID_ORIGIN_SOURCES.has(clean) ? clean : 'unknown';
}

function normalizeEnvTier(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  return VALID_ENV_TIERS.has(clean) ? clean : 'unknown';
}

/**
 * Maps arbitrary lighting tags or solar regime into one of the two calibrated slots:
 * 'daylight' or 'lowlight'.
 */
export function normalizeLightingSlot(lightingTag = '', solarRegime = '') {
  const raw = String(lightingTag || '').trim().toLowerCase();
  if (
    raw === 'lowlight' ||
    raw === 'low-light' ||
    raw === 'low_light' ||
    raw === 'night' ||
    raw === 'twilight' ||
    raw === 'dusk' ||
    raw === 'dawn' ||
    raw === 'dark'
  ) {
    return 'lowlight';
  }
  if (raw === 'daylight' || raw === 'day' || raw === 'bright' || raw === 'sunny') {
    return 'daylight';
  }
  const regime = String(solarRegime || '').trim().toLowerCase();
  if (regime === 'night' || regime === 'twilight') return 'lowlight';
  return 'daylight';
}

function extractLightingSlotsFromPackJson(packJson) {
  if (!packJson) return [];
  try {
    const parsed = typeof packJson === 'string' ? JSON.parse(packJson) : packJson;
    const keyframes = Array.isArray(parsed?.keyframes) ? parsed.keyframes : [];
    const slots = new Set();
    for (const kf of keyframes) {
      slots.add(normalizeLightingSlot(kf?.lightingTag, ''));
    }
    return Array.from(slots);
  } catch {
    return [];
  }
}

/**
 * Measures feature density, 4x3 spatial grid spread, average FAST response,
 * and multi-angle yaw coverage for an ORB keyframe set.
 */
export function computePackQualityMetrics(keyframes = []) {
  const list = Array.isArray(keyframes) ? keyframes : [];
  const occupiedCells = new Set();
  const yawBuckets = new Set();
  const lightingSlots = new Set();
  let featureCount = 0;
  let responseSum = 0;

  for (const kf of list) {
    const yawBucket = Math.round(Number(kf?.yawOffsetDeg || 0) / 18);
    yawBuckets.add(yawBucket);
    lightingSlots.add(normalizeLightingSlot(kf?.lightingTag, ''));
    const feats = Array.isArray(kf?.features) ? kf.features : [];
    for (const f of feats) {
      featureCount += 1;
      responseSum += Math.max(0, Number(f?.response || 0));
      const u = Math.max(0, Math.min(0.9999, Number(f?.u || 0)));
      const v = Math.max(0, Math.min(0.9999, Number(f?.v || 0)));
      const col = Math.floor(u * 4);
      const row = Math.floor(v * 3);
      occupiedCells.add(`${col}:${row}`);
    }
  }

  const spreadRatio = occupiedCells.size / 12;
  const avgResponse = featureCount > 0 ? responseSum / featureCount : 0;

  return {
    keyframeCount: list.length,
    featureCount,
    occupiedGridCells: occupiedCells.size,
    spreadRatio: Math.round(spreadRatio * 1000) / 1000,
    avgResponse: Math.round(avgResponse * 100) / 100,
    distinctYawBuckets: yawBuckets.size,
    lightingSlots: Array.from(lightingSlots)
  };
}

/**
 * Self-calibrates Auto ORB thresholds directly from the captured ORB landmark pack.
 * High-texture multi-angle scenes tighten thresholds; sparse/low-texture scenes relax cleanly.
 */
export function computeAutoThresholdsFromPack(keyframes = []) {
  const metrics = computePackQualityMetrics(keyframes);
  const densityScore = Math.min(1, metrics.featureCount / 36);
  const spreadScore = Math.min(1, metrics.spreadRatio / 0.75);
  const angleScore = Math.min(1, metrics.distinctYawBuckets / 3);
  const responseScore = Math.min(1, Math.max(0, (metrics.avgResponse - 28) / 42));

  const qualityScore = Math.max(
    0,
    Math.min(
      1,
      0.35 * densityScore + 0.3 * spreadScore + 0.2 * angleScore + 0.15 * responseScore
    )
  );

  const autoMinOrbInliers = Math.max(4, Math.min(12, Math.round(4 + qualityScore * 6)));
  const autoMaxReprojErrPx = Math.max(
    4.0,
    Math.min(14.0, Math.round((13.5 - qualityScore * 8.5) * 10) / 10)
  );

  return {
    autoMinOrbInliers,
    autoMaxReprojErrPx,
    qualityScore: Math.round(qualityScore * 1000) / 1000,
    metrics
  };
}

/**
 * Applies solar-regime runtime relaxation (daylight / twilight / night) when lightingAdaptive is enabled.
 */
export function applyLightingRelaxation({
  minOrbInliers = DEFAULT_MIN_ORB_INLIERS,
  maxReprojErrPx = DEFAULT_MAX_ORB_REPROJ_PX,
  lightingAdaptive = true,
  solarRegime = 'daylight',
  hasMatchingLightingSlot = false
} = {}) {
  const baseMin = Math.max(4, Math.min(64, Number(minOrbInliers || DEFAULT_MIN_ORB_INLIERS)));
  const baseErr = Math.max(1.5, Math.min(25, Number(maxReprojErrPx || DEFAULT_MAX_ORB_REPROJ_PX)));
  const regime = String(solarRegime || 'daylight').toLowerCase();

  if (!lightingAdaptive || regime === 'daylight') {
    return {
      effectiveMinOrbInliers: baseMin,
      effectiveMaxReprojErrPx: Math.round(baseErr * 10) / 10,
      solarRegime: regime || 'daylight',
      relaxed: false
    };
  }

  const minDrop = regime === 'night' ? (hasMatchingLightingSlot ? 1 : 2) : 1;
  const errBoost = regime === 'night' ? (hasMatchingLightingSlot ? 1.5 : 2.5) : 1.5;

  return {
    effectiveMinOrbInliers: Math.max(4, baseMin - minDrop),
    effectiveMaxReprojErrPx: Math.min(25, Math.round((baseErr + errBoost) * 10) / 10),
    solarRegime: regime,
    relaxed: true
  };
}

function getSolarRegimeForParcel({ lat = null, lng = null, geohash = '', parcelId = '', nowDate = null } = {}) {
  let nLat = Number(lat);
  let nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) {
    const gh = String(geohash || normalizeParcelId(parcelId).replace(/^GLAND-/, '')).toLowerCase();
    if (gh && gh.length >= 4) {
      const bounds = decodeGeohashBounds(gh);
      nLat = bounds.center[0];
      nLng = bounds.center[1];
    }
  }
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) {
    return { regime: 'daylight', solarAltitudeDeg: 30 };
  }
  const dateObj = nowDate instanceof Date ? nowDate : nowDate ? new Date(nowDate) : new Date();
  return computeSolarPosition(nLat, nLng, dateObj);
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

/**
 * Formats a `land_security_policies` row (and optional `parcel_landmark_anchors` row)
 * into a consistent camelCase security policy payload across REST, MCP, and UI.
 */
export function formatLandSecurityPolicy(parcelId, row = null, anchorRow = null) {
  const cleanId = normalizeParcelId(parcelId || row?.parcel_id);
  const originSource = normalizeOriginSource(row?.origin_source);
  const envTier = normalizeEnvTier(row?.env_tier);
  const seed = ENV_TIER_SEED_THRESHOLDS[envTier] || ENV_TIER_SEED_THRESHOLDS.unknown;
  const overrideFlag = Boolean(row?.override_flag);
  const autoMinOrbInliers =
    row?.auto_min_orb_inliers !== undefined && row?.auto_min_orb_inliers !== null
      ? Number(row.auto_min_orb_inliers)
      : seed.minOrbInliers;
  const autoMaxReprojErrPx =
    row?.auto_max_reproj_err_px !== undefined && row?.auto_max_reproj_err_px !== null
      ? Number(row.auto_max_reproj_err_px)
      : seed.maxReprojErrPx;
  const minOrbInliers =
    row?.min_orb_inliers !== undefined && row?.min_orb_inliers !== null
      ? Number(row.min_orb_inliers)
      : autoMinOrbInliers;
  const maxReprojErrPx =
    row?.max_reproj_err_px !== undefined && row?.max_reproj_err_px !== null
      ? Number(row.max_reproj_err_px)
      : autoMaxReprojErrPx;
  const lightingAdaptive =
    row?.lighting_adaptive === undefined || row?.lighting_adaptive === null
      ? true
      : Boolean(row.lighting_adaptive);
  const hasLandmarkPack = Boolean(anchorRow?.descriptor_digest || anchorRow?.anchor_pack_json);
  const lightingSlots = hasLandmarkPack
    ? extractLightingSlotsFromPackJson(anchorRow?.anchor_pack_json)
    : [];

  return {
    parcelId: cleanId,
    requirePasskeyUnlock: Boolean(row?.require_passkey_unlock),
    requireOrbUnlock: Boolean(row?.require_orb_unlock),
    minOrbInliers,
    maxReprojErrPx: Math.round(maxReprojErrPx * 10) / 10,
    originSource,
    envTier,
    autoMinOrbInliers,
    autoMaxReprojErrPx: Math.round(autoMaxReprojErrPx * 10) / 10,
    overrideFlag,
    isAuto: !overrideFlag,
    lightingAdaptive,
    hasLandmarkPack,
    lightingSlots,
    updatedAt: row?.updated_at || ''
  };
}

export async function getLandSecurityPolicy(db, parcelId) {
  const cleanId = normalizeParcelId(parcelId);
  const [row, anchorRow] = await Promise.all([
    db.get('SELECT * FROM land_security_policies WHERE parcel_id = ?', [cleanId]),
    db.get(
      'SELECT descriptor_digest, anchor_pack_json FROM parcel_landmark_anchors WHERE parcel_id = ?',
      [cleanId]
    )
  ]);
  return formatLandSecurityPolicy(cleanId, row, anchorRow);
}

/**
 * Seeds a Virtual Land parcel's initial Auto ORB security policy based on creation origin
 * (`mobile_ar`, `browser_map`, `agent_mcp`) and deterministic environment tier (`dense_urban`,
 * `suburban_plaza`, `open_nature`, `unknown`). Never overwrites an owner's custom override
 * (`override_flag = 1`) or an existing scan-calibrated auto threshold.
 */
export async function seedLandSecurityPolicy(
  db,
  {
    parcelId = '',
    ownerSub = '',
    originSource = 'unknown',
    envTier = '',
    lat = null,
    lng = null,
    geoInfo = null,
    skipRemoteLookup = false,
    timeoutMs = 1400
  } = {}
) {
  const cleanId = normalizeParcelId(parcelId);
  if (!cleanId) return null;

  const cleanOrigin = normalizeOriginSource(originSource);
  let resolvedEnvTier = normalizeEnvTier(envTier);
  if (resolvedEnvTier === 'unknown') {
    resolvedEnvTier = await seedEnvironmentTierForCoords({
      lat,
      lng,
      geoInfo,
      skipRemoteLookup,
      timeoutMs
    });
  }

  const seed = ENV_TIER_SEED_THRESHOLDS[resolvedEnvTier] || ENV_TIER_SEED_THRESHOLDS.unknown;
  const now = new Date().toISOString();

  const [existing, existingAnchor] = await Promise.all([
    db.get('SELECT * FROM land_security_policies WHERE parcel_id = ?', [cleanId]),
    db.get('SELECT descriptor_digest FROM parcel_landmark_anchors WHERE parcel_id = ?', [cleanId])
  ]);

  if (!existing) {
    await db.run(
      `INSERT INTO land_security_policies (
        parcel_id, owner_sub, require_passkey_unlock, require_orb_unlock,
        min_orb_inliers, max_reproj_err_px, origin_source, env_tier,
        auto_min_orb_inliers, auto_max_reproj_err_px, override_flag, lighting_adaptive, updated_at
      ) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      [
        cleanId,
        String(ownerSub || ''),
        seed.minOrbInliers,
        seed.maxReprojErrPx,
        cleanOrigin,
        resolvedEnvTier,
        seed.minOrbInliers,
        seed.maxReprojErrPx,
        now
      ]
    );
  } else {
    const nextOrigin =
      existing.origin_source && existing.origin_source !== 'unknown'
        ? existing.origin_source
        : cleanOrigin;
    const nextEnvTier =
      existing.env_tier && existing.env_tier !== 'unknown' ? existing.env_tier : resolvedEnvTier;
    const hasPack = Boolean(existingAnchor?.descriptor_digest);
    const nextSeed = ENV_TIER_SEED_THRESHOLDS[nextEnvTier] || ENV_TIER_SEED_THRESHOLDS.unknown;
    const isOverridden = Boolean(existing.override_flag);

    const nextAutoMin =
      hasPack && existing.auto_min_orb_inliers !== null && existing.auto_min_orb_inliers !== undefined
        ? Number(existing.auto_min_orb_inliers)
        : nextSeed.minOrbInliers;
    const nextAutoErr =
      hasPack && existing.auto_max_reproj_err_px !== null && existing.auto_max_reproj_err_px !== undefined
        ? Number(existing.auto_max_reproj_err_px)
        : nextSeed.maxReprojErrPx;

    const nextActiveMin = isOverridden ? Number(existing.min_orb_inliers) : nextAutoMin;
    const nextActiveErr = isOverridden ? Number(existing.max_reproj_err_px) : nextAutoErr;

    await db.run(
      `UPDATE land_security_policies
       SET owner_sub = COALESCE(NULLIF(owner_sub, ''), ?),
           origin_source = ?,
           env_tier = ?,
           auto_min_orb_inliers = ?,
           auto_max_reproj_err_px = ?,
           min_orb_inliers = ?,
           max_reproj_err_px = ?,
           updated_at = ?
       WHERE parcel_id = ?`,
      [
        String(ownerSub || ''),
        nextOrigin,
        nextEnvTier,
        nextAutoMin,
        nextAutoErr,
        nextActiveMin,
        nextActiveErr,
        now,
        cleanId
      ]
    );
  }

  return getLandSecurityPolicy(db, cleanId);
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
  const lightingAdaptive =
    body?.lightingAdaptive !== undefined
      ? Boolean(body.lightingAdaptive)
      : current.lightingAdaptive;
  const envTier =
    body?.envTier !== undefined && VALID_ENV_TIERS.has(String(body.envTier).trim().toLowerCase())
      ? normalizeEnvTier(body.envTier)
      : current.envTier;

  const seedForTier = ENV_TIER_SEED_THRESHOLDS[envTier] || ENV_TIER_SEED_THRESHOLDS.unknown;
  const autoMinOrbInliers =
    current.hasLandmarkPack
      ? current.autoMinOrbInliers
      : body?.envTier !== undefined
        ? seedForTier.minOrbInliers
        : current.autoMinOrbInliers;
  const autoMaxReprojErrPx =
    current.hasLandmarkPack
      ? current.autoMaxReprojErrPx
      : body?.envTier !== undefined
        ? seedForTier.maxReprojErrPx
        : current.autoMaxReprojErrPx;

  const wantsAuto = body?.useAuto === true || body?.overrideFlag === false;
  const suppliedCustomThresholds =
    body?.minOrbInliers !== undefined || body?.maxReprojErrPx !== undefined;

  let overrideFlag = current.overrideFlag;
  let minOrbInliers = current.minOrbInliers;
  let maxReprojErrPx = current.maxReprojErrPx;

  if (wantsAuto) {
    overrideFlag = false;
    minOrbInliers = autoMinOrbInliers;
    maxReprojErrPx = autoMaxReprojErrPx;
  } else if (body?.overrideFlag === true || suppliedCustomThresholds) {
    overrideFlag = true;
    minOrbInliers = Math.min(
      64,
      Math.max(4, Math.round(Number(body?.minOrbInliers ?? current.minOrbInliers)))
    );
    maxReprojErrPx =
      Math.round(
        Math.min(25, Math.max(1.5, Number(body?.maxReprojErrPx ?? current.maxReprojErrPx))) * 10
      ) / 10;
  } else if (!overrideFlag && body?.envTier !== undefined && !current.hasLandmarkPack) {
    minOrbInliers = autoMinOrbInliers;
    maxReprojErrPx = autoMaxReprojErrPx;
  }

  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO land_security_policies (
      parcel_id, owner_sub, require_passkey_unlock, require_orb_unlock,
      min_orb_inliers, max_reproj_err_px, origin_source, env_tier,
      auto_min_orb_inliers, auto_max_reproj_err_px, override_flag, lighting_adaptive, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      owner_sub = excluded.owner_sub,
      require_passkey_unlock = excluded.require_passkey_unlock,
      require_orb_unlock = excluded.require_orb_unlock,
      min_orb_inliers = excluded.min_orb_inliers,
      max_reproj_err_px = excluded.max_reproj_err_px,
      origin_source = COALESCE(NULLIF(land_security_policies.origin_source, 'unknown'), excluded.origin_source),
      env_tier = excluded.env_tier,
      auto_min_orb_inliers = excluded.auto_min_orb_inliers,
      auto_max_reproj_err_px = excluded.auto_max_reproj_err_px,
      override_flag = excluded.override_flag,
      lighting_adaptive = excluded.lighting_adaptive,
      updated_at = excluded.updated_at`,
    [
      ctx.parcelId,
      user.id,
      requirePasskeyUnlock ? 1 : 0,
      requireOrbUnlock ? 1 : 0,
      minOrbInliers,
      maxReprojErrPx,
      current.originSource,
      envTier,
      autoMinOrbInliers,
      autoMaxReprojErrPx,
      overrideFlag ? 1 : 0,
      lightingAdaptive ? 1 : 0,
      now
    ]
  );

  return { policy: await getLandSecurityPolicy(db, ctx.parcelId) };
}

export function validateLandmarkPackPayload(body = {}, { fallbackSolarRegime = 'daylight' } = {}) {
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
        u: Math.round(Number(f?.u || 0) * 1000) / 1000,
        v: Math.round(Number(f?.v || 0) * 1000) / 1000,
        x: Math.round(Number(f?.x || 0) * 1000) / 1000,
        y: Math.round(Number(f?.y || 0) * 1000) / 1000,
        z: Math.round(Number(f?.z || 0) * 1000) / 1000,
        angle: Math.round(Number(f?.angle || 0) * 100) / 100,
        response: Math.round(Number(f?.response || 0) * 100) / 100,
        descB64
      };
    });
    featureCount += cleanFeatures.length;
    const slot = normalizeLightingSlot(kf?.lightingTag || body?.lightingTag, fallbackSolarRegime);
    return {
      keyframeIndex: idx,
      yawOffsetDeg: Math.round(Number(kf?.yawOffsetDeg || 0) * 10) / 10,
      pitchDeg: Math.round(Number(kf?.pitchDeg || 0) * 10) / 10,
      frameWidth: Math.min(1920, Math.max(64, Number(kf?.frameWidth || 160))),
      frameHeight: Math.min(1080, Math.max(48, Number(kf?.frameHeight || 120))),
      lightingTag: slot,
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

function mergeDualLightingKeyframes(existingKeyframes = [], incomingKeyframes = [], { replaceAll = false } = {}) {
  const bySlot = {
    daylight: [],
    lowlight: []
  };

  if (!replaceAll && Array.isArray(existingKeyframes)) {
    for (const kf of existingKeyframes) {
      const slot = normalizeLightingSlot(kf?.lightingTag, 'daylight');
      if (bySlot[slot].length < LANDMARK_MAX_KEYFRAMES_PER_SLOT) {
        bySlot[slot].push({ ...kf, lightingTag: slot });
      }
    }
  }

  // Group incoming keyframes by slot; each incoming slot replaces that slot (up to 3 per slot)
  const incomingBySlot = { daylight: [], lowlight: [] };
  for (const kf of incomingKeyframes) {
    const slot = normalizeLightingSlot(kf?.lightingTag, 'daylight');
    incomingBySlot[slot].push({ ...kf, lightingTag: slot });
  }

  for (const slot of ['daylight', 'lowlight']) {
    if (incomingBySlot[slot].length > 0) {
      bySlot[slot] = incomingBySlot[slot].slice(0, LANDMARK_MAX_KEYFRAMES_PER_SLOT);
    }
  }

  const merged = [...bySlot.daylight, ...bySlot.lowlight]
    .slice(0, LANDMARK_MAX_KEYFRAMES)
    .map((kf, idx) => ({
      ...kf,
      keyframeIndex: idx
    }));

  const featureCount = merged.reduce(
    (sum, kf) => sum + (Array.isArray(kf.features) ? kf.features.length : 0),
    0
  );
  const lightingSlots = [];
  if (bySlot.daylight.length > 0) lightingSlots.push('daylight');
  if (bySlot.lowlight.length > 0) lightingSlots.push('lowlight');

  return { mergedKeyframes: merged, featureCount, lightingSlots };
}

export async function saveParcelLandmarkAnchor(
  db,
  { parcelId, user, body, userAgent = '', pinJsonFn = null }
) {
  if (!user?.id) throw new LandmarkServiceError('Google sign-in required.', 401);
  const cleanId = normalizeParcelId(parcelId);
  const [parcelRow, scRow, existingAnchor] = await Promise.all([
    db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanId]),
    db.get(
      'SELECT geohash, parcel_id, recipient_address, creator_sub FROM sculptures WHERE parcel_id = ? AND hidden = 0 LIMIT 1',
      [cleanId]
    ),
    db.get('SELECT * FROM parcel_landmark_anchors WHERE parcel_id = ?', [cleanId])
  ]);

  const geohash =
    parcelRow?.geohash ||
    scRow?.geohash ||
    String(body?.geohash || cleanId.replace(/^GLAND-/, '')).toLowerCase();

  // Check parcel owner or approved IRL contributor
  let isOwnerOrContributor = false;
  const wallets = new Set(
    [user.wallet_address, user.custom_payout_address].filter(Boolean).map((a) => a.toLowerCase())
  );
  if (
    (scRow && wallets.has(String(scRow.recipient_address || '').toLowerCase())) ||
    (parcelRow &&
      (wallets.has(String(parcelRow.latest_claimant_address || '').toLowerCase()) ||
        parcelRow.first_claimant_sub === user.id))
  ) {
    isOwnerOrContributor = true;
  } else if (scRow || parcelRow) {
    const contrib = await db.get(
      'SELECT * FROM land_contributors WHERE parcel_id = ? AND contributor_sub = ? AND can_edit_sculptures = 1',
      [cleanId, user.id]
    );
    if (contrib) isOwnerOrContributor = true;
  }

  const solar = getSolarRegimeForParcel({
    lat: body?.lat,
    lng: body?.lng,
    geohash,
    parcelId: cleanId
  });
  const { cleanKeyframes } = validateLandmarkPackPayload(body, {
    fallbackSolarRegime: solar.regime
  });

  let existingKeyframes = [];
  if (existingAnchor?.anchor_pack_json) {
    try {
      const parsed = JSON.parse(existingAnchor.anchor_pack_json);
      if (Array.isArray(parsed?.keyframes)) existingKeyframes = parsed.keyframes;
    } catch {
      existingKeyframes = [];
    }
  }
  const existingSlots = new Set(
    existingKeyframes.map((kf) => normalizeLightingSlot(kf?.lightingTag, 'daylight'))
  );

  let effectiveIncoming = cleanKeyframes;

  if (!isOwnerOrContributor) {
    if (!body?.allowInitialClaim) {
      throw new LandmarkServiceError(
        `Only the holder or IRL Contributor of ${cleanId} can save landmark anchors.`,
        403
      );
    }

    // Non-owner initial claim / complementary lighting slot MUST NEVER overwrite an existing slot
    if (existingAnchor && existingKeyframes.length > 0) {
      effectiveIncoming = cleanKeyframes.filter((kf) => !existingSlots.has(kf.lightingTag));
      if (effectiveIncoming.length === 0) {
        throw new LandmarkServiceError(
          `Virtual Land ${cleanId} already has a calibrated ORB anchor pack for this lighting slot. Only the land holder or approved contributor can recalibrate it.`,
          403
        );
      }
    }

    // Strict mobile + on-site proximity + anti-poisoning quality gate for non-owner first/complementary scan
    if (!looksMobileRequest(body?.deviceProfile, userAgent)) {
      throw new LandmarkServiceError(
        'Mobile device on site is required to contribute an initial ORB landmark calibration.',
        403
      );
    }
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new LandmarkServiceError(
        'Live GPS coordinates (lat, lng) within 65m of the parcel are required for initial visitor ORB calibration.',
        403
      );
    }
    const bounds = decodeGeohashBounds(geohash);
    const distM = haversineMeters(lat, lng, bounds.center[0], bounds.center[1]);
    if (distM > LANDMARK_FETCH_MAX_DISTANCE_M) {
      throw new LandmarkServiceError(
        `Must be within ${LANDMARK_FETCH_MAX_DISTANCE_M}m of ${cleanId} to contribute initial ORB calibration (currently ${Math.round(distM)}m away).`,
        403
      );
    }

    const qm = computePackQualityMetrics(effectiveIncoming);
    if (
      qm.featureCount < LANDMARK_INITIAL_CLAIM_MIN_FEATURES ||
      qm.spreadRatio < LANDMARK_INITIAL_CLAIM_MIN_SPREAD ||
      qm.avgResponse < LANDMARK_INITIAL_CLAIM_MIN_RESPONSE
    ) {
      throw new LandmarkServiceError(
        `Initial visitor ORB scan did not meet anti-poisoning quality gate (need >=${LANDMARK_INITIAL_CLAIM_MIN_FEATURES} features, spread >=${LANDMARK_INITIAL_CLAIM_MIN_SPREAD}, avgResponse >=${LANDMARK_INITIAL_CLAIM_MIN_RESPONSE}; got ${qm.featureCount} features, spread ${qm.spreadRatio}, avgResponse ${qm.avgResponse}).`,
        400,
        { qualityMetrics: qm }
      );
    }
  }

  const { mergedKeyframes, featureCount, lightingSlots } = mergeDualLightingKeyframes(
    existingKeyframes,
    effectiveIncoming,
    { replaceAll: isOwnerOrContributor && Boolean(body?.replaceAll) }
  );

  const packDoc = {
    version: 'graffiland-orb-anchor-v1',
    parcelId: cleanId,
    geohash,
    sharedLandmarkOrigin: true,
    lightingSlots,
    keyframeCount: mergedKeyframes.length,
    featureCount,
    keyframes: mergedKeyframes,
    updatedAt: new Date().toISOString()
  };
  const descriptorDigest = await computeCanonicalDigestHex(mergedKeyframes);
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
      mergedKeyframes.length,
      featureCount,
      JSON.stringify(packDoc),
      user.id,
      user.id,
      now,
      now
    ]
  );

  // Scene-scan self-calibration: update auto_* thresholds; apply to active thresholds when override_flag === 0
  const calibration = computeAutoThresholdsFromPack(mergedKeyframes);
  const existingPolicy = await db.get('SELECT * FROM land_security_policies WHERE parcel_id = ?', [
    cleanId
  ]);
  if (!existingPolicy) {
    await db.run(
      `INSERT INTO land_security_policies (
        parcel_id, owner_sub, require_passkey_unlock, require_orb_unlock,
        min_orb_inliers, max_reproj_err_px, origin_source, env_tier,
        auto_min_orb_inliers, auto_max_reproj_err_px, override_flag, lighting_adaptive, updated_at
      ) VALUES (?, ?, 0, 0, ?, ?, 'mobile_ar', 'unknown', ?, ?, 0, 1, ?)`,
      [
        cleanId,
        parcelRow?.first_claimant_sub || user.id,
        calibration.autoMinOrbInliers,
        calibration.autoMaxReprojErrPx,
        calibration.autoMinOrbInliers,
        calibration.autoMaxReprojErrPx,
        now
      ]
    );
  } else {
    const isOverridden = Boolean(existingPolicy.override_flag);
    const nextMin = isOverridden
      ? Number(existingPolicy.min_orb_inliers)
      : calibration.autoMinOrbInliers;
    const nextErr = isOverridden
      ? Number(existingPolicy.max_reproj_err_px)
      : calibration.autoMaxReprojErrPx;
    await db.run(
      `UPDATE land_security_policies
       SET auto_min_orb_inliers = ?,
           auto_max_reproj_err_px = ?,
           min_orb_inliers = ?,
           max_reproj_err_px = ?,
           updated_at = ?
       WHERE parcel_id = ?`,
      [
        calibration.autoMinOrbInliers,
        calibration.autoMaxReprojErrPx,
        nextMin,
        nextErr,
        now,
        cleanId
      ]
    );
  }

  const updatedPolicy = await getLandSecurityPolicy(db, cleanId);

  return {
    ok: true,
    parcelId: cleanId,
    descriptorDigest,
    keyframeCount: mergedKeyframes.length,
    featureCount,
    lightingSlots,
    anchorCid: ipfsPin.cid || '',
    anchorUri: ipfsPin.uri || '',
    calibration,
    policy: updatedPolicy
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

  const [row, policy] = await Promise.all([
    db.get('SELECT * FROM parcel_landmark_anchors WHERE parcel_id = ?', [cleanId]),
    getLandSecurityPolicy(db, cleanId)
  ]);

  const solar = getSolarRegimeForParcel({ lat, lng, parcelId: cleanId });
  const desiredSlot = normalizeLightingSlot('', solar.regime);

  if (!row) {
    const relaxed = applyLightingRelaxation({
      minOrbInliers: policy.minOrbInliers,
      maxReprojErrPx: policy.maxReprojErrPx,
      lightingAdaptive: policy.lightingAdaptive,
      solarRegime: solar.regime,
      hasMatchingLightingSlot: false
    });
    return {
      available: false,
      parcelId: cleanId,
      anchorPack: null,
      orbStatus: 'no_pack',
      upgradePath: 'first_mobile_scan',
      lightingSlots: [],
      desiredLightingSlot: desiredSlot,
      missingLightingSlots: [desiredSlot],
      policy,
      effectivePolicy: {
        minOrbInliers: relaxed.effectiveMinOrbInliers,
        maxReprojErrPx: relaxed.effectiveMaxReprojErrPx,
        solarRegime: relaxed.solarRegime,
        relaxed: relaxed.relaxed,
        envTier: policy.envTier,
        originSource: policy.originSource,
        isAuto: policy.isAuto,
        lightingAdaptive: policy.lightingAdaptive
      }
    };
  }

  const bounds = decodeGeohashBounds(row.geohash);
  const distM = haversineMeters(lat, lng, bounds.center[0], bounds.center[1]);
  if (distM > LANDMARK_FETCH_MAX_DISTANCE_M) {
    throw new LandmarkServiceError(
      `Walk within ${LANDMARK_FETCH_MAX_DISTANCE_M}m of Virtual Land ${cleanId} to unlock visual ORB landmark relocalization (currently ${Math.round(distM)}m away).`,
      403
    );
  }

  const anchorPack = JSON.parse(row.anchor_pack_json);
  const lightingSlots = extractLightingSlotsFromPackJson(anchorPack);
  const hasMatchingLightingSlot = lightingSlots.includes(desiredSlot);
  const relaxed = applyLightingRelaxation({
    minOrbInliers: policy.minOrbInliers,
    maxReprojErrPx: policy.maxReprojErrPx,
    lightingAdaptive: policy.lightingAdaptive,
    solarRegime: solar.regime,
    hasMatchingLightingSlot
  });

  return {
    available: true,
    parcelId: cleanId,
    distanceMeters: Math.round(distM * 10) / 10,
    descriptorDigest: row.descriptor_digest,
    anchorCid: row.anchor_cid,
    anchorUri: row.anchor_uri,
    anchorPack,
    orbStatus: policy.requireOrbUnlock ? 'required' : 'optional',
    lightingSlots,
    desiredLightingSlot: desiredSlot,
    missingLightingSlots: hasMatchingLightingSlot ? [] : [desiredSlot],
    policy,
    effectivePolicy: {
      minOrbInliers: relaxed.effectiveMinOrbInliers,
      maxReprojErrPx: relaxed.effectiveMaxReprojErrPx,
      solarRegime: relaxed.solarRegime,
      relaxed: relaxed.relaxed,
      envTier: policy.envTier,
      originSource: policy.originSource,
      isAuto: policy.isAuto,
      lightingAdaptive: policy.lightingAdaptive
    }
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

/**
 * Deterministic 2D similarity RANSAC check on server-verified descriptor pairs.
 * Fits uniform scale + rotation + translation:
 *   lx = a * kx - b * ky + tx
 *   ly = b * kx + a * ky + ty
 * with scale s = hypot(a, b) in [0.35, 2.85]. Runs in <1ms on Cloudflare Workers.
 */
export function verifyMatchedDescriptorsGeometry(verifiedPairs = [], maxErrPx = DEFAULT_MAX_ORB_REPROJ_PX) {
  const byKf = new Map();
  for (const p of verifiedPairs) {
    if (!p?.hasUv) continue;
    const list = byKf.get(p.kIdx) || [];
    list.push(p);
    byKf.set(p.kIdx, list);
  }

  const geoResidualCap = Math.max(4.5, maxErrPx * 1.8 + 2.0);
  let totalGeometricInliers = 0;
  let weightedResidualSum = 0;

  for (const rawPts of byKf.values()) {
    const pts = rawPts.slice(0, 20);
    if (pts.length < 4) continue;

    // Build deterministic pair hypotheses (up to 45 pairs)
    const pairs = [];
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        pairs.push([i, j]);
      }
    }
    const maxHyp = 45;
    const stride = pairs.length > maxHyp ? pairs.length / maxHyp : 1;

    let bestInliers = 0;
    let bestErrSum = Infinity;

    for (let h = 0; h < Math.min(maxHyp, pairs.length); h += 1) {
      const [i, j] = pairs[Math.floor(h * stride)];
      const p1 = pts[i];
      const p2 = pts[j];
      const dkx = p2.kx - p1.kx;
      const dky = p2.ky - p1.ky;
      const denom = dkx * dkx + dky * dky;
      if (denom < 9) continue; // skip near-colocated points (<3px apart)

      const dlx = p2.lx - p1.lx;
      const dly = p2.ly - p1.ly;
      const a = (dkx * dlx + dky * dly) / denom;
      const b = (dkx * dly - dky * dlx) / denom;
      const scale = Math.hypot(a, b);
      if (!Number.isFinite(scale) || scale < 0.35 || scale > 2.85) continue;

      const tx = p1.lx - (a * p1.kx - b * p1.ky);
      const ty = p1.ly - (b * p1.kx + a * p1.ky);

      let inliers = 0;
      let errSum = 0;
      for (let q = 0; q < pts.length; q += 1) {
        const pt = pts[q];
        const predX = a * pt.kx - b * pt.ky + tx;
        const predY = b * pt.kx + a * pt.ky + ty;
        const dist = Math.hypot(pt.lx - predX, pt.ly - predY);
        if (dist <= geoResidualCap) {
          inliers += 1;
          errSum += dist;
        }
      }

      if (inliers > bestInliers || (inliers === bestInliers && errSum < bestErrSum)) {
        bestInliers = inliers;
        bestErrSum = errSum;
      }
    }

    const meanResidual = bestInliers > 0 ? bestErrSum / bestInliers : 999;
    if (bestInliers >= 4 && meanResidual <= maxErrPx + 2.0) {
      totalGeometricInliers += bestInliers;
      weightedResidualSum += bestErrSum;
    }
  }

  return {
    totalGeometricInliers,
    meanResidualPx:
      totalGeometricInliers > 0
        ? Math.round((weightedResidualSum / totalGeometricInliers) * 100) / 100
        : 999
  };
}

export async function verifyOrbProofAgainstParcel(
  db,
  { parcelId, orbProof, policy, lat = null, lng = null, nowDate = null }
) {
  const cleanId = normalizeParcelId(parcelId);
  const anchorRow = await db.get(
    'SELECT geohash, descriptor_digest, feature_count, anchor_pack_json FROM parcel_landmark_anchors WHERE parcel_id = ?',
    [cleanId]
  );

  // Graceful no_pack state: Browser/Agent lands without a physical ORB scan NEVER 403.
  if (!anchorRow) {
    return {
      verified: false,
      skipped: true,
      orbStatus: 'no_pack',
      upgradePath: 'first_mobile_scan'
    };
  }

  // Opt-in strict unlock gate: pack existence alone never forces ORB when requireOrbUnlock is false
  if (!policy?.requireOrbUnlock && (!orbProof || typeof orbProof !== 'object')) {
    return {
      verified: false,
      skipped: true,
      orbStatus: 'skipped',
      upgradePath: ''
    };
  }

  const solar = getSolarRegimeForParcel({
    lat,
    lng,
    geohash: anchorRow.geohash,
    parcelId: cleanId,
    nowDate
  });
  const pack = anchorRow.anchor_pack_json ? JSON.parse(anchorRow.anchor_pack_json) : {};
  const keyframes = Array.isArray(pack?.keyframes) ? pack.keyframes : [];
  const lightingSlots = extractLightingSlotsFromPackJson(pack);
  const desiredSlot = normalizeLightingSlot('', solar.regime);

  const relaxed = applyLightingRelaxation({
    minOrbInliers: policy?.minOrbInliers ?? DEFAULT_MIN_ORB_INLIERS,
    maxReprojErrPx: policy?.maxReprojErrPx ?? DEFAULT_MAX_ORB_REPROJ_PX,
    lightingAdaptive: policy?.lightingAdaptive !== false,
    solarRegime: solar.regime,
    hasMatchingLightingSlot: lightingSlots.includes(desiredSlot)
  });

  const minInliers = relaxed.effectiveMinOrbInliers;
  const maxErr = relaxed.effectiveMaxReprojErrPx;

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

  // Security hardening: matchedDescriptors is MANDATORY (omission bypass closed)
  if (!Array.isArray(orbProof.matchedDescriptors) || orbProof.matchedDescriptors.length === 0) {
    throw new LandmarkServiceError(
      'Server ORB descriptor verification failed: matchedDescriptors array is required.',
      403
    );
  }

  let serverVerifiedMatches = 0;
  const verifiedPairs = [];
  const seen = new Set();

  for (const item of orbProof.matchedDescriptors.slice(0, 48)) {
    const kIdx = Number(item?.keyframeIndex ?? 0);
    const fIdx = Number(item?.featureIndex ?? -1);
    const kf = keyframes[kIdx];
    const feat = kf?.features?.[fIdx];
    if (!feat?.descB64 || !item?.liveDescB64) continue;
    const key = `${kIdx}:${fIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const hd = hammingDistB64(item.liveDescB64, feat.descB64);
    if (hd <= 80) {
      serverVerifiedMatches += 1;
      const fw = Math.min(1920, Math.max(64, Number(kf?.frameWidth || 160)));
      const fh = Math.min(1080, Math.max(48, Number(kf?.frameHeight || 120)));
      const uVal = Number(item?.u);
      const vVal = Number(item?.v);
      const hasUv =
        Number.isFinite(uVal) &&
        Number.isFinite(vVal) &&
        uVal >= 0 &&
        uVal <= 1 &&
        vVal >= 0 &&
        vVal <= 1;
      verifiedPairs.push({
        kIdx,
        fIdx,
        kx: Number(feat.u || 0) * fw,
        ky: Number(feat.v || 0) * fh,
        lx: hasUv ? uVal * fw : 0,
        ly: hasUv ? vVal * fh : 0,
        hasUv
      });
    }
  }

  if (serverVerifiedMatches < minInliers) {
    throw new LandmarkServiceError(
      `Server ORB descriptor verification failed (${serverVerifiedMatches} < ${minInliers} valid binary matches).`,
      403
    );
  }

  const geo = verifyMatchedDescriptorsGeometry(verifiedPairs, maxErr);
  if (geo.totalGeometricInliers < minInliers) {
    throw new LandmarkServiceError(
      `Server ORB geometric verification failed (${geo.totalGeometricInliers} < ${minInliers} consistent 2D similarity inliers).`,
      403
    );
  }

  return {
    verified: true,
    orbStatus: 'verified',
    upgradePath: '',
    serverVerifiedMatches,
    geometricInliers: geo.totalGeometricInliers,
    serverReprojectionErrorPx: geo.meanResidualPx,
    descriptorDigest: digest,
    inlierCount: inliers,
    reprojectionErrorPx: Math.round(reprojErr * 100) / 100,
    effectiveMinOrbInliers: minInliers,
    effectiveMaxReprojErrPx: maxErr,
    solarRegime: relaxed.solarRegime,
    lightingRelaxed: relaxed.relaxed
  };
}
