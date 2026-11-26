import { LAND_VOLUME_LIMITS, STEWARD_DEFAULTS } from './constants.mjs';
import { resolveLandDisplayName } from './landVolume.mjs';
import { normalizeParcelId } from './mcp/helpers.mjs';

export const NOTIFICATION_CATEGORIES = [
  {
    key: 'sculpture_on_land',
    label: 'New art on your lands & contributions',
    description:
      'Alerts with direct links whenever new art is minted on any Virtual Land you own or have contributed to.'
  },
  {
    key: 'mint_slots_unlocked',
    label: 'Minting eligibility & unlocked slots',
    description: 'Know immediately when you unlock another Desktop mint slot or earn new land capacity.'
  },
  {
    key: 'mint_limit_reached',
    label: 'Free mint limit guidance',
    description: `Actionable steps when your ${LAND_VOLUME_LIMITS.starterFreeHumanClaims} starter Desktop land slots are full, plus Mobile IRL options.`
  },
  {
    key: 'land_expiring',
    label: 'Land expiry & archive alerts',
    description:
      'Urgent alerts 3 hours before a land expires (72h agent limit or 28-day human inactivity) and when archived.'
  },
  {
    key: 'land_activity',
    label: 'Marketplace & land activity',
    description: 'Sales, royalties, quests, and collaborator milestones on your Virtual Lands.'
  }
];

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  sculpture_on_land: true,
  mint_slots_unlocked: true,
  mint_limit_reached: true,
  land_expiring: true,
  land_activity: true,
  browser_push_enabled: false
});

const ALLOWED_PREF_KEYS = new Set(Object.keys(DEFAULT_NOTIFICATION_PREFS));

function parseJsonSafe(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function serializeNotificationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userSub: row.user_sub,
    category: row.category || 'land_activity',
    severity: row.severity || 'info',
    title: row.title || '',
    message: row.message || '',
    parcelId: row.parcel_id || '',
    sculptureId: row.sculpture_id || '',
    actionType: row.action_type || '',
    actionLabel: row.action_label || '',
    meta: parseJsonSafe(row.meta_json, {}),
    readAt: row.read_at || '',
    read: Boolean(row.read_at),
    createdAt: row.created_at || ''
  };
}

export async function getNotificationPreferences(db, userSub) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) return { ...DEFAULT_NOTIFICATION_PREFS };
  const row = await db
    .get('SELECT * FROM user_notification_prefs WHERE user_sub = ?', [cleanSub])
    .catch(() => null);
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFS };
  return {
    sculpture_on_land: Number(row.sculpture_on_land ?? 1) !== 0,
    mint_slots_unlocked: Number(row.mint_slots_unlocked ?? 1) !== 0,
    mint_limit_reached: Number(row.mint_limit_reached ?? 1) !== 0,
    land_expiring: Number(row.land_expiring ?? 1) !== 0,
    land_activity: Number(row.land_activity ?? 1) !== 0,
    browser_push_enabled: Number(row.browser_push_enabled ?? 0) !== 0
  };
}

export async function updateNotificationPreferences(db, userSub, patch = {}) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) throw new Error('Authenticated user required');
  const current = await getNotificationPreferences(db, cleanSub);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (ALLOWED_PREF_KEYS.has(key) && typeof value === 'boolean') {
      next[key] = value;
    }
  }
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO user_notification_prefs (
      user_sub, sculpture_on_land, mint_slots_unlocked, mint_limit_reached,
      land_expiring, land_activity, browser_push_enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_sub) DO UPDATE SET
      sculpture_on_land = excluded.sculpture_on_land,
      mint_slots_unlocked = excluded.mint_slots_unlocked,
      mint_limit_reached = excluded.mint_limit_reached,
      land_expiring = excluded.land_expiring,
      land_activity = excluded.land_activity,
      browser_push_enabled = excluded.browser_push_enabled,
      updated_at = excluded.updated_at`,
    [
      cleanSub,
      next.sculpture_on_land ? 1 : 0,
      next.mint_slots_unlocked ? 1 : 0,
      next.mint_limit_reached ? 1 : 0,
      next.land_expiring ? 1 : 0,
      next.land_activity ? 1 : 0,
      next.browser_push_enabled ? 1 : 0,
      now
    ]
  );
  return next;
}

/**
 * Computes real-time Desktop starter mint capacity & unbuilt lands for a human user.
 */
export async function getUserMintCapacityStatus(db, userSub) {
  const cleanSub = String(userSub || '').trim();
  const maxSlots = LAND_VOLUME_LIMITS.starterFreeHumanClaims;
  if (!cleanSub) {
    return {
      usedSlots: 0,
      maxSlots,
      remainingSlots: maxSlots,
      canMintDesktop: true,
      canClaimInPersonMobile: true,
      unbuiltParcels: [],
      totalOwnedParcels: 0
    };
  }

  const unbuiltRows = await db
    .all(
      `SELECT st.parcel_id, st.claimed_at,
              COALESCE(pc.custom_name, '') AS custom_name,
              COALESCE(lv.center_lat, lp.center_lat) AS center_lat,
              COALESCE(lv.center_lng, lp.center_lng) AS center_lng
       FROM land_steward_state st
       LEFT JOIN parcel_curations pc ON pc.parcel_id = st.parcel_id
       LEFT JOIN land_parcels lp ON lp.parcel_id = st.parcel_id
       LEFT JOIN land_volumes lv ON lv.parcel_id = st.parcel_id
       WHERE st.steward_sub = ?
         AND st.steward_type = 'human'
         AND st.status IN ('dormant', 'awakened')
         AND NOT EXISTS (
           SELECT 1 FROM sculptures s WHERE s.parcel_id = st.parcel_id AND s.hidden = 0
         )
       ORDER BY st.claimed_at ASC`,
      [cleanSub]
    )
    .catch(() => []);

  // Consumed free starter slots that expired/archived with zero in-person human users never reopen
  const forfeitedRow = await db
    .get(
      `SELECT COUNT(*) AS cnt
       FROM land_archives
       WHERE steward_sub = ? AND steward_type = 'human' AND had_human_interaction = 0`,
      [cleanSub]
    )
    .catch(() => ({ cnt: 0 }));

  const totalRow = await db
    .get(
      `SELECT COUNT(DISTINCT parcel_id) AS cnt FROM (
         SELECT parcel_id FROM land_steward_state WHERE steward_sub = ? AND status IN ('dormant', 'awakened')
         UNION
         SELECT parcel_id FROM land_parcels WHERE first_claimant_sub = ?
         UNION
         SELECT parcel_id FROM parcel_curations WHERE owner_sub = ?
       )`,
      [cleanSub, cleanSub, cleanSub]
    )
    .catch(() => ({ cnt: 0 }));

  const unbuiltParcels = (unbuiltRows || []).map((r) => ({
    parcelId: r.parcel_id,
    customName: r.custom_name || '',
    displayName: resolveLandDisplayName({ customName: r.custom_name || '' }),
    claimedAt: r.claimed_at || '',
    centerLat: Number.isFinite(Number(r.center_lat)) ? Number(r.center_lat) : null,
    centerLng: Number.isFinite(Number(r.center_lng)) ? Number(r.center_lng) : null
  }));
  const forfeitedSlots = Number(forfeitedRow?.cnt || 0);
  const usedSlots = unbuiltParcels.length + forfeitedSlots;
  const remainingSlots = Math.max(0, maxSlots - usedSlots);

  return {
    usedSlots,
    forfeitedSlots,
    maxSlots,
    remainingSlots,
    canMintDesktop: remainingSlots > 0,
    canClaimInPersonMobile: true,
    unbuiltParcels,
    totalOwnedParcels: Number(totalRow?.cnt || 0)
  };
}

export async function createNotification(
  db,
  {
    userSub,
    category = 'land_activity',
    severity = 'info',
    title = '',
    message = '',
    parcelId = '',
    sculptureId = '',
    actionType = '',
    actionLabel = '',
    meta = {},
    dedupeKey = '',
    ignorePrefs = false
  }
) {
  const cleanSub = String(userSub || '').trim();
  const cleanTitle = String(title || '').trim().slice(0, 140);
  const cleanMessage = String(message || '').trim().slice(0, 500);
  if (!cleanSub || !cleanTitle || !cleanMessage) return null;

  if (!ignorePrefs && ALLOWED_PREF_KEYS.has(category)) {
    const prefs = await getNotificationPreferences(db, cleanSub);
    if (!prefs[category]) return null;
  }

  const cleanDedupe = String(dedupeKey || '').trim().slice(0, 120);
  if (cleanDedupe) {
    const existing = await db
      .get('SELECT * FROM user_notifications WHERE user_sub = ? AND dedupe_key = ? LIMIT 1', [
        cleanSub,
        cleanDedupe
      ])
      .catch(() => null);
    if (existing) {
      return serializeNotificationRow(existing);
    }
  }

  const id = globalThis.crypto.randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO user_notifications (
      id, user_sub, category, severity, title, message,
      parcel_id, sculpture_id, action_type, action_label,
      meta_json, read_at, dedupe_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
    [
      id,
      cleanSub,
      category,
      severity,
      cleanTitle,
      cleanMessage,
      parcelId ? normalizeParcelId(parcelId) : '',
      String(sculptureId || '').trim(),
      String(actionType || '').trim(),
      String(actionLabel || '').trim(),
      JSON.stringify(meta && typeof meta === 'object' ? meta : {}),
      cleanDedupe,
      now
    ]
  );

  // Keep per-user notification history tidy (latest 80 items)
  await db
    .run(
      `DELETE FROM user_notifications
       WHERE user_sub = ?
         AND id NOT IN (
           SELECT id FROM user_notifications
           WHERE user_sub = ?
           ORDER BY created_at DESC
           LIMIT 80
         )`,
      [cleanSub, cleanSub]
    )
    .catch(() => {});

  const saved = await db.get('SELECT * FROM user_notifications WHERE id = ?', [id]).catch(() => null);
  return serializeNotificationRow(saved);
}

function formatRemainingShort(diffMs) {
  const totalMins = Math.max(1, Math.round(diffMs / 60000));
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs >= 1 && mins > 0) return `${hrs}h ${mins}m`;
  if (hrs >= 1) return `${hrs}h`;
  return `${mins}m`;
}

/**
 * Generates deduped 3-hour pre-expiry warning notifications for any active lands
 * (72-hour agent dormant leases OR 28-day human-inactivity windows) approaching expiry.
 * When `userSub` is omitted, sweeps ALL landholders globally (used by cron & reaper).
 */
export async function syncExpiringLandNotifications(
  db,
  userSub = '',
  nowIso = new Date().toISOString()
) {
  const cleanSub = String(userSub || '').trim();
  const parsedNow = Date.parse(nowIso);
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const warningWindowHours = Number(STEWARD_DEFAULTS.expiryWarningHours || 3);
  const thresholdIso = new Date(nowMs + warningWindowHours * 60 * 60 * 1000).toISOString();
  const effectiveNowIso = new Date(nowMs).toISOString();

  const userClause = cleanSub ? 'AND st.steward_sub = ?' : '';
  const baseParams = cleanSub
    ? [effectiveNowIso, thresholdIso, cleanSub]
    : [effectiveNowIso, thresholdIso];

  // 1) 72-hour agent dormant leases expiring within 3 hours
  const dormantRows = await db
    .all(
      `SELECT st.parcel_id, st.steward_sub, st.lease_expires_at,
              COALESCE(pc.custom_name, '') AS custom_name
       FROM land_steward_state st
       LEFT JOIN parcel_curations pc ON pc.parcel_id = st.parcel_id
       WHERE st.status = 'dormant'
         AND st.steward_sub != ''
         AND st.lease_expires_at != ''
         AND st.lease_expires_at > ?
         AND st.lease_expires_at <= ?
         ${userClause}`,
      baseParams
    )
    .catch(() => []);

  let sentCount = 0;
  for (const row of dormantRows || []) {
    const expMs = Date.parse(row.lease_expires_at);
    const diffMs = Math.max(60000, expMs - nowMs);
    const remainingLabel = formatRemainingShort(diffMs);
    const label = resolveLandDisplayName({ customName: row.custom_name || '' });
    const utcStr = row.lease_expires_at.slice(0, 16).replace('T', ' ');
    const created = await createNotification(db, {
      userSub: row.steward_sub,
      category: 'land_expiring',
      severity: 'warning',
      title: `⏳ "${label}" expires in ${remainingLabel} (72h limit)`,
      message: `Agent land "${label}" has no verified in-person human interaction yet and will be archived & destroyed at ${utcStr} UTC (free slot will not reopen). Visit in person on Mobile AR (sculpt ${STEWARD_DEFAULTS.minHumanPoolVoxels}+ blocks, Check In, join AR chat, or unlock pinned notes) to keep it live.`,
      parcelId: row.parcel_id,
      actionType: 'open_land',
      actionLabel: 'Inspect Land',
      meta: {
        expiryKind: 'agent_72h',
        leaseExpiresAt: row.lease_expires_at,
        expiresAt: row.lease_expires_at,
        remainingMinutes: Math.max(1, Math.round(diffMs / 60000))
      },
      dedupeKey: `expiring:3h:dormant:${row.parcel_id}:${row.lease_expires_at.slice(0, 16)}`
    }).catch(() => null);
    if (created) sentCount += 1;
  }

  // 2) 28-day human inactivity windows expiring within 3 hours
  const inactiveRows = await db
    .all(
      `SELECT st.parcel_id, st.steward_sub, st.inactivity_expires_at,
              COALESCE(pc.custom_name, '') AS custom_name
       FROM land_steward_state st
       LEFT JOIN parcel_curations pc ON pc.parcel_id = st.parcel_id
       WHERE st.status = 'awakened'
         AND st.steward_sub != ''
         AND st.inactivity_expires_at != ''
         AND st.inactivity_expires_at > ?
         AND st.inactivity_expires_at <= ?
         ${userClause}`,
      baseParams
    )
    .catch(() => []);

  for (const row of inactiveRows || []) {
    const expMs = Date.parse(row.inactivity_expires_at);
    const diffMs = Math.max(60000, expMs - nowMs);
    const remainingLabel = formatRemainingShort(diffMs);
    const label = resolveLandDisplayName({ customName: row.custom_name || '' });
    const utcStr = row.inactivity_expires_at.slice(0, 16).replace('T', ' ');
    const created = await createNotification(db, {
      userSub: row.steward_sub,
      category: 'land_expiring',
      severity: 'warning',
      title: `⏳ "${label}" expires in ${remainingLabel} (28-day inactivity)`,
      message: `"${label}" was pre-claimed without permanent manual human AR art and will be archived & recycled at ${utcStr} UTC. Visit in person on Mobile AR and draw art to make it permanently owned (no timer), or Check In on-site to extend.`,
      parcelId: row.parcel_id,
      actionType: 'open_land',
      actionLabel: 'Inspect Land',
      meta: {
        expiryKind: 'inactivity_28d',
        inactivityExpiresAt: row.inactivity_expires_at,
        expiresAt: row.inactivity_expires_at,
        remainingMinutes: Math.max(1, Math.round(diffMs / 60000))
      },
      dedupeKey: `expiring:3h:inactivity:${row.parcel_id}:${row.inactivity_expires_at.slice(0, 16)}`
    }).catch(() => null);
    if (created) sentCount += 1;
  }

  return { sentCount };
}

export async function syncAllExpiringLandNotifications(db, nowIso = new Date().toISOString()) {
  return syncExpiringLandNotifications(db, '', nowIso);
}

/**
 * Emits a deduped notification when a user's MCP agent pairing has expired,
 * was disconnected while an agent tried to use it, or is about to expire so they know to re-pair.
 */
export async function notifyMcpRepairNeeded(
  db,
  {
    userSub,
    code = '',
    reason = 'expired', // 'expired' | 'disconnected' | 'expiring_soon'
    agentName = '',
    expiresAt = '',
    remainingMs = 0
  }
) {
  const cleanSub = String(userSub || '').trim();
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanSub) return null;
  const label = String(agentName || '').trim() || cleanCode || 'your AI agent';

  let title = `🔗 Re-pair needed: ${label} pairing expired`;
  let message = `Your pairing (${cleanCode || label}) has expired. Open Pair to generate a fresh code and reconnect your agent.`;
  let dedupeSuffix = `expired:${cleanCode || 'latest'}`;

  if (reason === 'disconnected') {
    title = `🔗 Re-pair needed: ${label} was disconnected`;
    message = `${label} tried to act on your land using a disconnected pairing (${cleanCode || 'old code'}). Open Pair to generate a fresh pairing code.`;
    dedupeSuffix = `disconnected:${cleanCode || 'latest'}`;
  } else if (reason === 'expiring_soon') {
    const remLabel = formatRemainingShort(Math.max(60000, Number(remainingMs || 0)));
    title = `🔗 Pairing expires in ${remLabel} — re-pair soon`;
    message = `Your active pairing with ${label} (${cleanCode}) expires in ${remLabel}. Open Pair to refresh your pairing code without interrupting your agent.`;
    dedupeSuffix = `expiring:${cleanCode || 'latest'}`;
  }

  return createNotification(db, {
    userSub: cleanSub,
    category: 'land_activity',
    severity: 'warning',
    title,
    message,
    actionType: 'open_pair_mobile',
    actionLabel: 'Re-pair Now',
    meta: {
      needsRepair: true,
      repairReason: reason,
      pairingCode: cleanCode,
      agentName: String(agentName || '').trim(),
      expiresAt: String(expiresAt || '')
    },
    dedupeKey: `repair:${dedupeSuffix}`,
    ignorePrefs: true
  }).catch(() => null);
}

/**
 * Emits an actionable notification when a paired agent queues a land transaction
 * awaiting the land holder's approval.
 */
export async function notifyPendingLandApproval(db, { userSub, request }) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub || !request?.id) return null;
  const landTitle = resolveLandDisplayName(
    { customName: request.parcelName || request.landDisplayName || '' },
    { defaultName: 'your land' }
  );
  const agentLabel = String(request.agentName || 'Your paired agent').trim();
  const parcelUrl = request.parcelId ? `?parcel=${encodeURIComponent(request.parcelId)}` : '';
  const hasSculpturePreview =
    request.action === 'create_sculpture' ||
    request.action === 'publish_sculpture' ||
    request.action === 'update_sculpture';
  return createNotification(db, {
    userSub: cleanSub,
    category: 'land_activity',
    severity: 'action',
    title: `✍️ Approval needed: ${request.summaryTitle || 'Land Transaction'}`,
    message: hasSculpturePreview
      ? `${agentLabel} requested "${request.summaryTitle || request.action}" on "${landTitle}". Preview on the map or approve right here.`
      : `${agentLabel} requested "${request.summaryTitle || request.action}" on "${landTitle}". Approve right here or review on the land page.`,
    parcelId: request.parcelId || '',
    sculptureId: request.sculptureId || '',
    actionType: 'open_land_approval',
    actionLabel: hasSculpturePreview ? 'Preview on Land' : 'Review & Approve',
    meta: {
      requestId: request.id,
      pairingCode: request.pairingCode || '',
      action: request.action || '',
      agentName: agentLabel,
      landTitle,
      parcelUrl,
      hasSculpturePreview,
      expiresAt: request.expiresAt || ''
    },
    dedupeKey: `sigreq:${request.id}`,
    ignorePrefs: true
  }).catch(() => null);
}

/**
 * Emits a persisted confirmation notification after a pending land/sculpture
 * request is approved & executed, with a direct "Go to Land" navigation action.
 * Also marks the superseded pending-approval notification as read.
 */
export async function notifyLandApprovalExecuted(db, { userSub, request, result = null }) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub || !request?.id) return null;

  const now = new Date().toISOString();
  await db
    .run(
      `UPDATE user_notifications
       SET read_at = ?
       WHERE user_sub = ? AND dedupe_key = ? AND (read_at IS NULL OR read_at = '')`,
      [now, cleanSub, `sigreq:${request.id}`]
    )
    .catch(() => {});

  const rawParcelId =
    result?.sculpture?.parcelId || result?.parcel?.parcelId || request?.parcelId || '';
  const resolvedParcelId = rawParcelId ? normalizeParcelId(rawParcelId) : '';
  const resolvedSculptureId = String(
    result?.sculpture?.id || request?.sculptureId || ''
  ).trim();

  let landTitle = resolveLandDisplayName(
    { customName: request.parcelName || request.landDisplayName || '' },
    { defaultName: '' }
  );
  if (!landTitle && resolvedParcelId) {
    const info = await resolveParcelOwnerInfo(db, resolvedParcelId).catch(() => null);
    landTitle = info?.landTitle || '';
  }
  if (!landTitle) landTitle = 'Virtual Land';

  const action = String(request?.action || '').trim();
  const isMint = action === 'create_sculpture' || action === 'publish_sculpture';
  const summaryTitle = String(
    request?.summaryTitle ||
      result?.sculpture?.title ||
      (action ? action.replace(/_/g, ' ') : 'Land Transaction')
  ).trim();
  const displaySummary = summaryTitle.includes('"') ? summaryTitle : `"${summaryTitle}"`;

  const parcelUrl = resolvedParcelId ? `?parcel=${encodeURIComponent(resolvedParcelId)}` : '';
  const sculptureUrl = resolvedSculptureId
    ? `?sculpture=${encodeURIComponent(resolvedSculptureId)}`
    : '';

  return createNotification(db, {
    userSub: cleanSub,
    category: 'land_activity',
    severity: 'success',
    title: isMint ? `✅ Approved & minted: ${summaryTitle}` : `✅ Approved: ${summaryTitle}`,
    message: isMint
      ? `${displaySummary} was approved and minted on "${landTitle}".`
      : `${displaySummary} was approved on "${landTitle}".`,
    parcelId: resolvedParcelId,
    sculptureId: resolvedSculptureId,
    actionType: resolvedParcelId ? 'open_land' : resolvedSculptureId ? 'open_sculpture' : '',
    actionLabel: resolvedParcelId ? 'Go to Land' : resolvedSculptureId ? 'View Art' : '',
    meta: {
      requestId: request.id,
      action,
      approvedAndMinted: true,
      isMint,
      landTitle,
      parcelId: resolvedParcelId,
      parcelUrl,
      sculptureId: resolvedSculptureId,
      sculptureUrl,
      txHash: String(request?.txHash || result?.mint?.txHash || '').trim()
    },
    dedupeKey: `sigreq_exec:${request.id}`,
    ignorePrefs: true
  }).catch(() => null);
}

/**
 * Emits a confirmation notification when a Virtual Land parcel is freshly minted,
 * with a direct "Go to Land" navigation button.
 */
export async function notifyLandMinted(
  db,
  { userSub, parcelId, landTitle = '', txHash = '', volume = null }
) {
  const cleanSub = String(userSub || '').trim();
  const cleanParcel = parcelId ? normalizeParcelId(parcelId) : '';
  if (!cleanSub || !cleanParcel) return null;

  const safeTitle = resolveLandDisplayName(
    { customName: landTitle || '' },
    { defaultName: 'Virtual Land' }
  );
  const dims =
    volume &&
    Number.isFinite(Number(volume.widthMeters)) &&
    Number.isFinite(Number(volume.depthMeters)) &&
    Number.isFinite(Number(volume.heightMeters))
      ? ` (${Math.round(volume.widthMeters)}×${Math.round(volume.depthMeters)}×${Math.round(volume.heightMeters)}m)`
      : '';
  const parcelUrl = `?parcel=${encodeURIComponent(cleanParcel)}`;

  return createNotification(db, {
    userSub: cleanSub,
    category: 'land_activity',
    severity: 'success',
    title: `🏗️ Land minted: "${safeTitle}"`,
    message: `"${safeTitle}"${dims} is now minted and live on the map.`,
    parcelId: cleanParcel,
    actionType: 'open_land',
    actionLabel: 'Go to Land',
    meta: {
      landMinted: true,
      landTitle: safeTitle,
      parcelId: cleanParcel,
      parcelUrl,
      txHash: String(txHash || '').trim()
    },
    dedupeKey: `land_minted:${cleanParcel}:${cleanSub}`,
    ignorePrefs: true
  }).catch(() => null);
}

/**
 * Checks a user's MCP pairing health and notifies them when an active pairing is expiring
 * within 2 hours or when their most recent pairing has expired and needs re-pairing.
 */
export async function syncPairingHealthNotifications(
  db,
  userSub = '',
  nowIso = new Date().toISOString()
) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) return { sentCount: 0 };
  const parsedNow = Date.parse(nowIso);
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();

  const rows = await db
    .all(
      `SELECT code, status, agent_name, connected_at, expires_at
       FROM mcp_pairings
       WHERE owner_sub = ?
       ORDER BY created_at DESC
       LIMIT 6`,
      [cleanSub]
    )
    .catch(() => []);

  if (!rows || rows.length === 0) return { sentCount: 0 };

  let sentCount = 0;
  const activeConnected = rows.find(
    (r) => r.status === 'connected' && Date.parse(String(r.expires_at || '')) > nowMs
  );

  if (activeConnected) {
    const expMs = Date.parse(String(activeConnected.expires_at || ''));
    const diffMs = expMs - nowMs;
    if (Number.isFinite(diffMs) && diffMs > 0 && diffMs <= 2 * 60 * 60 * 1000) {
      const n = await notifyMcpRepairNeeded(db, {
        userSub: cleanSub,
        code: activeConnected.code,
        reason: 'expiring_soon',
        agentName: activeConnected.agent_name,
        expiresAt: activeConnected.expires_at,
        remainingMs: diffMs
      });
      if (n) sentCount += 1;
    }
    return { sentCount };
  }

  // No active connected pairing — if the latest pairing expired (and wasn't manually replaced by a valid pending one), notify user to re-pair
  const latest = rows[0];
  const latestExpMs = Date.parse(String(latest?.expires_at || ''));
  const latestExpired = Number.isFinite(latestExpMs) && latestExpMs <= nowMs;
  if (latest && latest.status !== 'disconnected' && latestExpired) {
    const n = await notifyMcpRepairNeeded(db, {
      userSub: cleanSub,
      code: latest.code,
      reason: 'expired',
      agentName: latest.agent_name,
      expiresAt: latest.expires_at
    });
    if (n) sentCount += 1;
  }

  return { sentCount };
}

export async function listUserNotifications(
  db,
  userSub,
  { limit = 40, includeMintStatus = true } = {}
) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) {
    return {
      notifications: [],
      unreadCount: 0,
      preferences: { ...DEFAULT_NOTIFICATION_PREFS },
      mintStatus: includeMintStatus ? await getUserMintCapacityStatus(db, '') : null
    };
  }

  await syncExpiringLandNotifications(db, cleanSub);
  await syncPairingHealthNotifications(db, cleanSub);

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40));
  const rows = await db
    .all(
      `SELECT * FROM user_notifications
       WHERE user_sub = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [cleanSub, safeLimit]
    )
    .catch(() => []);

  const unreadRow = await db
    .get(
      `SELECT COUNT(*) AS cnt FROM user_notifications
       WHERE user_sub = ? AND (read_at IS NULL OR read_at = '')`,
      [cleanSub]
    )
    .catch(() => ({ cnt: 0 }));

  const preferences = await getNotificationPreferences(db, cleanSub);
  const mintStatus = includeMintStatus ? await getUserMintCapacityStatus(db, cleanSub) : null;

  return {
    notifications: (rows || []).map(serializeNotificationRow),
    unreadCount: Number(unreadRow?.cnt || 0),
    preferences,
    mintStatus
  };
}

export async function markNotificationsRead(db, userSub, { ids = null, markAll = false } = {}) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) return { updated: 0, unreadCount: 0 };
  const now = new Date().toISOString();
  if (markAll || !Array.isArray(ids) || ids.length === 0) {
    await db.run(
      `UPDATE user_notifications
       SET read_at = ?
       WHERE user_sub = ? AND (read_at IS NULL OR read_at = '')`,
      [now, cleanSub]
    );
  } else {
    const cleanIds = ids.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 50);
    for (const id of cleanIds) {
      await db.run(
        `UPDATE user_notifications
         SET read_at = ?
         WHERE id = ? AND user_sub = ? AND (read_at IS NULL OR read_at = '')`,
        [now, id, cleanSub]
      );
    }
  }
  const unreadRow = await db
    .get(
      `SELECT COUNT(*) AS cnt FROM user_notifications
       WHERE user_sub = ? AND (read_at IS NULL OR read_at = '')`,
      [cleanSub]
    )
    .catch(() => ({ cnt: 0 }));
  return { unreadCount: Number(unreadRow?.cnt || 0) };
}

export async function deleteNotification(db, userSub, notificationId) {
  const cleanSub = String(userSub || '').trim();
  const cleanId = String(notificationId || '').trim();
  if (!cleanSub || !cleanId) return { deleted: false };
  await db.run('DELETE FROM user_notifications WHERE id = ? AND user_sub = ?', [cleanId, cleanSub]);
  return { deleted: true };
}

export async function clearUserNotifications(db, userSub, { scope = 'all' } = {}) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) return { cleared: false, unreadCount: 0 };
  if (scope === 'read') {
    await db.run(
      `DELETE FROM user_notifications
       WHERE user_sub = ? AND read_at IS NOT NULL AND read_at != ''`,
      [cleanSub]
    );
  } else {
    await db.run('DELETE FROM user_notifications WHERE user_sub = ?', [cleanSub]);
  }
  const unreadRow = await db
    .get(
      `SELECT COUNT(*) AS cnt FROM user_notifications
       WHERE user_sub = ? AND (read_at IS NULL OR read_at = '')`,
      [cleanSub]
    )
    .catch(() => ({ cnt: 0 }));
  return { cleared: true, unreadCount: Number(unreadRow?.cnt || 0) };
}

/**
 * Resolves the primary human/agent owner of a parcel and its friendly title.
 */
async function resolveParcelOwnerInfo(db, parcelId) {
  const cleanParcel = normalizeParcelId(parcelId);
  const steward = await db
    .get('SELECT steward_sub, steward_type, steward_name, status FROM land_steward_state WHERE parcel_id = ?', [
      cleanParcel
    ])
    .catch(() => null);
  const parcel = await db
    .get('SELECT first_claimant_sub, sculpture_count FROM land_parcels WHERE parcel_id = ?', [cleanParcel])
    .catch(() => null);
  const curation = await db
    .get('SELECT owner_sub, custom_name FROM parcel_curations WHERE parcel_id = ?', [cleanParcel])
    .catch(() => null);

  const ownerSub = steward?.steward_sub || curation?.owner_sub || parcel?.first_claimant_sub || '';
  const firstSc = !curation?.custom_name
    ? await db
        .get(
          'SELECT title, place_name FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 1',
          [cleanParcel]
        )
        .catch(() => null)
    : null;
  const landTitle = resolveLandDisplayName({
    customName: curation?.custom_name || '',
    firstSculptureTitle: firstSc?.title || '',
    placeName: firstSc?.place_name || ''
  });
  return {
    parcelId: cleanParcel,
    ownerSub,
    stewardType: steward?.steward_type || (ownerSub.startsWith('agent:') ? 'agent' : 'human'),
    landTitle
  };
}

/**
 * Resolves all unique owners & contributors for a parcel (deduped) so every stakeholder
 * who owns or has contributed to the land is notified when new art is minted there.
 */
async function resolveParcelStakeholders(db, parcelId, primaryOwnerSub = '') {
  const cleanParcel = normalizeParcelId(parcelId);
  const rolesBySub = new Map();

  const register = (sub, role) => {
    const clean = String(sub || '').trim();
    if (!clean) return;
    if (!rolesBySub.has(clean) || role === 'owner') {
      rolesBySub.set(clean, role);
    }
  };

  register(primaryOwnerSub, 'owner');

  const [parcelRow, curationRow, stewardRow, explicitContribs, sculptureAuthors, questArtists] =
    await Promise.all([
      db
        .get('SELECT first_claimant_sub FROM land_parcels WHERE parcel_id = ?', [cleanParcel])
        .catch(() => null),
      db
        .get('SELECT owner_sub FROM parcel_curations WHERE parcel_id = ?', [cleanParcel])
        .catch(() => null),
      db
        .get('SELECT steward_sub, first_human_sub FROM land_steward_state WHERE parcel_id = ?', [
          cleanParcel
        ])
        .catch(() => null),
      db
        .all(
          'SELECT DISTINCT contributor_sub AS sub FROM land_contributors WHERE parcel_id = ?',
          [cleanParcel]
        )
        .catch(() => []),
      db
        .all(
          'SELECT DISTINCT creator_sub AS sub FROM sculptures WHERE parcel_id = ? AND hidden = 0',
          [cleanParcel]
        )
        .catch(() => []),
      db
        .all(
          'SELECT DISTINCT artist_sub AS sub FROM land_quest_completions WHERE parcel_id = ?',
          [cleanParcel]
        )
        .catch(() => [])
    ]);

  register(stewardRow?.steward_sub, 'owner');
  register(curationRow?.owner_sub, 'owner');
  register(parcelRow?.first_claimant_sub, 'owner');
  register(stewardRow?.first_human_sub, 'contributor');

  for (const row of explicitContribs || []) register(row?.sub, 'contributor');
  for (const row of sculptureAuthors || []) register(row?.sub, 'contributor');
  for (const row of questArtists || []) register(row?.sub, 'contributor');

  return Array.from(rolesBySub.entries()).map(([userSub, role]) => ({ userSub, role }));
}

/**
 * Emits notifications after a sculpture is published on a parcel:
 *  1) Alerts the land owner AND every user who has contributed to that land (`sculpture_on_land`)
 *     with direct links to the newly minted artwork.
 *  2) Alerts the land owner if a dormant land was awakened permanently (`mint_slots_unlocked`).
 *  3) Alerts a human land owner when placing the first sculpture on an unbuilt land frees up
 *     a Desktop starter mint slot (`mint_slots_unlocked`)!
 */
export async function notifyAfterSculpturePublished(
  db,
  {
    parcelId,
    sculptureId,
    sculptureTitle = 'Untitled Sculpture',
    creatorSub = '',
    creatorName = 'A creator',
    awakenedParcel = false,
    wasPreviouslyEmpty = false
  }
) {
  const info = await resolveParcelOwnerInfo(db, parcelId);
  const created = [];

  const cleanCreatorSub = String(creatorSub || '').trim();
  const cleanSculptureId = String(sculptureId || '').trim();
  const safeCreatorName = String(creatorName || 'A creator').trim();
  const safeScTitle = String(sculptureTitle || 'Untitled Sculpture').trim();
  const sculptureUrl = cleanSculptureId
    ? `?sculpture=${encodeURIComponent(cleanSculptureId)}`
    : '';
  const parcelUrl = info.parcelId ? `?parcel=${encodeURIComponent(info.parcelId)}` : '';

  // 1) Notify land owner(s) + every contributor on this parcel with direct links to the new art
  const stakeholders = await resolveParcelStakeholders(db, info.parcelId, info.ownerSub);
  for (const recipient of stakeholders) {
    if (!recipient.userSub) continue;
    if (cleanCreatorSub && recipient.userSub === cleanCreatorSub) continue;
    const isOwner = recipient.role === 'owner';
    const n = await createNotification(db, {
      userSub: recipient.userSub,
      category: 'sculpture_on_land',
      severity: 'info',
      title: `🎨 New art "${safeScTitle}" on "${info.landTitle}"`,
      message: isOwner
        ? `${safeCreatorName} minted "${safeScTitle}" on your Virtual Land "${info.landTitle}".`
        : `${safeCreatorName} minted "${safeScTitle}" on "${info.landTitle}", a Virtual Land you contributed to.`,
      parcelId: info.parcelId,
      sculptureId: cleanSculptureId,
      actionType: cleanSculptureId ? 'open_sculpture' : 'open_land',
      actionLabel: cleanSculptureId ? 'View Art' : 'Inspect Land',
      meta: {
        creatorName: safeCreatorName,
        sculptureTitle: safeScTitle,
        landTitle: info.landTitle,
        sculptureId: cleanSculptureId,
        parcelId: info.parcelId,
        sculptureUrl,
        parcelUrl,
        recipientRole: recipient.role
      },
      dedupeKey: cleanSculptureId ? `art:${cleanSculptureId}:${recipient.userSub}` : ''
    }).catch(() => null);
    if (n) created.push(n);
  }

  if (!info.ownerSub) return created;

  // 2) Dormant land awakened by an in-person human
  if (awakenedParcel && info.ownerSub) {
    const n = await createNotification(db, {
      userSub: info.ownerSub,
      category: 'mint_slots_unlocked',
      severity: 'success',
      title: `✨ "${info.landTitle}" awakened & permanently owned!`,
      message: `"${safeScTitle}" awakened "${info.landTitle}", cleared its expiry timer (now permanently owned), and unlocked +${STEWARD_DEFAULTS.slotsPerAwakenedLand} steward slots.`,
      parcelId: info.parcelId,
      sculptureId: cleanSculptureId,
      actionType: cleanSculptureId ? 'open_sculpture' : 'open_land',
      actionLabel: cleanSculptureId ? 'View Art' : 'View Land',
      meta: {
        awakenedParcel: true,
        landTitle: info.landTitle,
        sculptureId: cleanSculptureId,
        sculptureUrl,
        parcelUrl
      }
    }).catch(() => null);
    if (n) created.push(n);
  }

  // 3) Human owner just populated a previously unbuilt starter Desktop land -> freed a mint slot!
  if (wasPreviouslyEmpty && info.stewardType === 'human' && !info.ownerSub.startsWith('agent:')) {
    const capacity = await getUserMintCapacityStatus(db, info.ownerSub);
    if (capacity.canMintDesktop) {
      const n = await createNotification(db, {
        userSub: info.ownerSub,
        category: 'mint_slots_unlocked',
        severity: 'success',
        title: `🎉 You can mint more land! (${capacity.remainingSlots}/${capacity.maxSlots} slots open)`,
        message: `"${safeScTitle}" activated "${info.landTitle}". You now have ${capacity.remainingSlots} open Desktop starter land slot${capacity.remainingSlots === 1 ? '' : 's'} ready to mint.`,
        parcelId: info.parcelId,
        sculptureId: cleanSculptureId,
        actionType: 'open_mint',
        actionLabel: 'How to Mint Land',
        meta: {
          remainingSlots: capacity.remainingSlots,
          usedSlots: capacity.usedSlots,
          maxSlots: capacity.maxSlots,
          landTitle: info.landTitle,
          sculptureUrl,
          parcelUrl
        }
      }).catch(() => null);
      if (n) created.push(n);
    }
  }

  return created;
}

/**
 * Emits an actionable notification when a human hits the free Desktop unbuilt land cap.
 */
export async function notifyFreeLimitReached(
  db,
  { userSub, usedSlots, maxSlots, unbuiltParcels = [] }
) {
  const names = unbuiltParcels
    .map((p) => resolveLandDisplayName(p))
    .filter(Boolean)
    .slice(0, 3);
  const landListText = names.length > 0 ? ` (${names.join(', ')})` : '';
  return createNotification(db, {
    userSub,
    category: 'mint_limit_reached',
    severity: 'action',
    title: `🛑 ${usedSlots}/${maxSlots} free Desktop lands used — here's how to unlock more`,
    message: `Build or publish a sculpture on one of your ${usedSlots} unbuilt lands${landListText} to unlock another Desktop mint slot. Or grab your phone and sculpt in person with Mobile AR right now to claim new land immediately!`,
    actionType: 'open_pair_mobile',
    actionLabel: 'Pair Phone & Sculpt IRL',
    meta: { usedSlots, maxSlots, unbuiltParcels, canClaimInPersonMobile: true },
    dedupeKey: `mint_limit:${usedSlots}:${names.join('|')}`
  }).catch(() => null);
}

/**
 * Emits a notification when a sculpture on a user's land sells on the marketplace.
 */
export async function notifyLandMarketplaceSale(
  db,
  { parcelId, sculptureId, sculptureTitle = 'Sculpture', buyerName = 'A collector', sellerSub = '', stewardSub = '', priceEth = 0 }
) {
  const info = await resolveParcelOwnerInfo(db, parcelId);
  const targetSub = stewardSub || info.ownerSub;
  const created = [];

  if (sellerSub) {
    const n = await createNotification(db, {
      userSub: sellerSub,
      category: 'land_activity',
      severity: 'success',
      title: `💎 "${sculptureTitle}" sold for ${priceEth} ETH`,
      message: `${buyerName} purchased your sculpture "${sculptureTitle}" on "${info.landTitle}".`,
      parcelId: info.parcelId,
      sculptureId,
      actionType: 'open_land',
      actionLabel: 'View Land',
      meta: { priceEth, buyerName, sculptureTitle }
    }).catch(() => null);
    if (n) created.push(n);
  }

  if (targetSub && targetSub !== sellerSub && !targetSub.startsWith('agent:')) {
    const n = await createNotification(db, {
      userSub: targetSub,
      category: 'land_activity',
      severity: 'success',
      title: `💰 Royalty earned on "${info.landTitle}"`,
      message: `"${sculptureTitle}" sold for ${priceEth} ETH on your Virtual Land "${info.landTitle}".`,
      parcelId: info.parcelId,
      sculptureId,
      actionType: 'open_land',
      actionLabel: 'View Land',
      meta: { priceEth, buyerName, sculptureTitle }
    }).catch(() => null);
    if (n) created.push(n);
  }

  return created;
}
