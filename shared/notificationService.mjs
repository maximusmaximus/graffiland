import { LAND_VOLUME_LIMITS, STEWARD_DEFAULTS } from './constants.mjs';
import { normalizeParcelId } from './mcp/helpers.mjs';

export const NOTIFICATION_CATEGORIES = [
  {
    key: 'sculpture_on_land',
    label: 'Sculptures on your lands',
    description: 'Alerts whenever an artist or agent places a sculpture on one of your lands.'
  },
  {
    key: 'mint_slots_unlocked',
    label: 'Minting eligibility & unlocked slots',
    description: 'Know immediately when you unlock another Desktop mint slot or earn new land capacity.'
  },
  {
    key: 'mint_limit_reached',
    label: 'Free mint limit guidance',
    description: 'Actionable steps when your 3 starter Desktop land slots are full, plus Mobile IRL options.'
  },
  {
    key: 'land_expiring',
    label: 'Land lease expirations',
    description: 'Reminders before a dormant land lease expires so you can awaken it in time.'
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
       WHERE st.steward_sub = ? AND st.steward_type = 'human'
         AND NOT EXISTS (
           SELECT 1 FROM sculptures s WHERE s.parcel_id = st.parcel_id AND s.hidden = 0
         )
       ORDER BY st.claimed_at ASC`,
      [cleanSub]
    )
    .catch(() => []);

  const totalRow = await db
    .get(
      `SELECT COUNT(DISTINCT parcel_id) AS cnt FROM (
         SELECT parcel_id FROM land_steward_state WHERE steward_sub = ?
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
    displayName: r.custom_name || r.parcel_id,
    claimedAt: r.claimed_at || '',
    centerLat: Number.isFinite(Number(r.center_lat)) ? Number(r.center_lat) : null,
    centerLng: Number.isFinite(Number(r.center_lng)) ? Number(r.center_lng) : null
  }));
  const usedSlots = unbuiltParcels.length;
  const remainingSlots = Math.max(0, maxSlots - usedSlots);

  return {
    usedSlots,
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

/**
 * Generates deduped reminders for any dormant lands owned by `userSub` expiring within 48 hours.
 */
async function syncExpiringLandNotifications(db, userSub) {
  const cleanSub = String(userSub || '').trim();
  if (!cleanSub) return;
  const nowMs = Date.now();
  const thresholdIso = new Date(nowMs + 48 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const rows = await db
    .all(
      `SELECT st.parcel_id, st.lease_expires_at, COALESCE(pc.custom_name, '') AS custom_name
       FROM land_steward_state st
       LEFT JOIN parcel_curations pc ON pc.parcel_id = st.parcel_id
       WHERE st.steward_sub = ?
         AND st.status = 'dormant'
         AND st.lease_expires_at != ''
         AND st.lease_expires_at > ?
         AND st.lease_expires_at <= ?`,
      [cleanSub, nowIso, thresholdIso]
    )
    .catch(() => []);

  for (const row of rows || []) {
    const remainingHrs = Math.max(
      1,
      Math.round((new Date(row.lease_expires_at).getTime() - nowMs) / (60 * 60 * 1000))
    );
    const label = row.custom_name || row.parcel_id;
    await createNotification(db, {
      userSub: cleanSub,
      category: 'land_expiring',
      severity: 'warning',
      title: `⏳ "${label}" lease expires in ~${remainingHrs}h`,
      message: `Place a verified IRL sculpture (${STEWARD_DEFAULTS.minHumanPoolVoxels}+ voxels) on ${label} before ${row.lease_expires_at.slice(0, 16).replace('T', ' ')} UTC to awaken it permanently.`,
      parcelId: row.parcel_id,
      actionType: 'open_land',
      actionLabel: 'Inspect Land',
      meta: { leaseExpiresAt: row.lease_expires_at, remainingHours: remainingHrs },
      dedupeKey: `expiring:${row.parcel_id}:${row.lease_expires_at.slice(0, 13)}`
    }).catch(() => {});
  }
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
  const landTitle = curation?.custom_name || cleanParcel;
  return {
    parcelId: cleanParcel,
    ownerSub,
    stewardType: steward?.steward_type || (ownerSub.startsWith('agent:') ? 'agent' : 'human'),
    landTitle
  };
}

/**
 * Emits notifications after a sculpture is published on a parcel:
 *  1) Alerts the land owner when someone builds on their land (`sculpture_on_land`).
 *  2) Alerts a human land owner when placing the first sculpture on an unbuilt land frees up
 *     a Desktop starter mint slot (`mint_slots_unlocked`)!
 *  3) Alerts the land owner if a dormant land was awakened permanently (`land_activity`).
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
  if (!info.ownerSub) return created;

  const cleanCreatorSub = String(creatorSub || '').trim();
  const safeCreatorName = String(creatorName || 'A creator').trim();
  const safeScTitle = String(sculptureTitle || 'Untitled Sculpture').trim();

  // 1) Someone else built on the owner's land
  if (cleanCreatorSub && cleanCreatorSub !== info.ownerSub) {
    const n = await createNotification(db, {
      userSub: info.ownerSub,
      category: 'sculpture_on_land',
      severity: 'info',
      title: `🎨 New sculpture on "${info.landTitle}"`,
      message: `${safeCreatorName} published "${safeScTitle}" on your Virtual Land "${info.landTitle}".`,
      parcelId: info.parcelId,
      sculptureId,
      actionType: 'open_land',
      actionLabel: 'Inspect Land',
      meta: { creatorName: safeCreatorName, sculptureTitle: safeScTitle, landTitle: info.landTitle }
    }).catch(() => null);
    if (n) created.push(n);
  }

  // 2) Dormant land awakened permanently
  if (awakenedParcel && info.ownerSub) {
    const n = await createNotification(db, {
      userSub: info.ownerSub,
      category: 'mint_slots_unlocked',
      severity: 'success',
      title: `✨ "${info.landTitle}" awakened permanently!`,
      message: `"${safeScTitle}" awakened "${info.landTitle}" into a permanent parcel and unlocked new steward capacity.`,
      parcelId: info.parcelId,
      sculptureId,
      actionType: 'open_land',
      actionLabel: 'View Land',
      meta: { awakenedParcel: true, landTitle: info.landTitle }
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
        sculptureId,
        actionType: 'open_mint',
        actionLabel: 'Mint New Land',
        meta: {
          remainingSlots: capacity.remainingSlots,
          usedSlots: capacity.usedSlots,
          maxSlots: capacity.maxSlots,
          landTitle: info.landTitle
        }
      }).catch(() => null);
      if (n) created.push(n);
    }
  }

  return created;
}

/**
 * Emits an actionable notification when a human hits the 3 free Desktop unbuilt land cap.
 */
export async function notifyFreeLimitReached(
  db,
  { userSub, usedSlots, maxSlots, unbuiltParcels = [] }
) {
  const names = unbuiltParcels
    .map((p) => p.displayName || p.customName || p.parcelId)
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
