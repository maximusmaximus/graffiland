import { decodeGeohashBounds, haversineMeters } from '../server/services/pol.mjs';
import { STEWARD_DEFAULTS } from './constants.mjs';
import { looksMobileRequest } from './chatPolicy.mjs';
import { resolveLandDisplayName } from './landVolume.mjs';
import { McpServiceError, normalizeParcelId } from './mcp/helpers.mjs';
import { buildViewerDedupKey, recordLandView } from './landViewService.mjs';
import {
  createNotification,
  syncAllExpiringLandNotifications
} from './notificationService.mjs';

export const ARCHIVE_REASON_AGENT_72H = 'agent_72h_no_human_interaction';
export const ARCHIVE_REASON_INACTIVITY_28D = 'inactivity_28d_no_human_interaction';

export const ARCHIVE_REASON_LABELS = {
  [ARCHIVE_REASON_AGENT_72H]:
    'Archived & reclaimed: agent-created land had no verified in-person human interaction within 72 hours of minting.',
  [ARCHIVE_REASON_INACTIVITY_28D]:
    'Archived & reclaimed: pre-claimed land without permanent human AR art had no verified in-person human interaction for 28 consecutive days.'
};

function parseJsonSafe(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function computeDormantLeaseExpiresAt(fromIso = new Date().toISOString()) {
  const baseMs = Date.parse(fromIso);
  const startMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(startMs + STEWARD_DEFAULTS.dormantLeaseTtlHours * 60 * 60 * 1000).toISOString();
}

export function computeInactivityExpiresAt(fromIso = new Date().toISOString()) {
  const baseMs = Date.parse(fromIso);
  const startMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(
    startMs + STEWARD_DEFAULTS.inactivityArchiveDays * 24 * 60 * 60 * 1000
  ).toISOString();
}

/**
 * Computes authoritative agent free-slot accounting.
 * Consumed free slots that expired without an in-person human user (`forfeitedSlots`)
 * remain permanently consumed and NEVER open back up.
 */
export async function computeAgentSlotUsage(db, agentId) {
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanAgentId) {
    return {
      activeDormantSlots: 0,
      forfeitedSlots: 0,
      usedSlots: 0,
      maxSlots: STEWARD_DEFAULTS.starterDormantSlots,
      availableSlots: STEWARD_DEFAULTS.starterDormantSlots
    };
  }

  const [acctRow, dormantRow, forfeitedArchiveRow] = await Promise.all([
    db
      .get('SELECT max_slots, forfeited_slots FROM agent_accounts WHERE agent_id = ?', [
        cleanAgentId
      ])
      .catch(() => null),
    db
      .get(
        `SELECT COUNT(*) AS cnt FROM land_steward_state WHERE steward_sub = ? AND status = 'dormant'`,
        [cleanAgentId]
      )
      .catch(() => ({ cnt: 0 })),
    db
      .get(
        `SELECT COUNT(*) AS cnt FROM land_archives WHERE steward_sub = ? AND had_human_interaction = 0`,
        [cleanAgentId]
      )
      .catch(() => ({ cnt: 0 }))
  ]);

  const maxSlots = Number(acctRow?.max_slots ?? STEWARD_DEFAULTS.starterDormantSlots);
  const activeDormantSlots = Number(dormantRow?.cnt || 0);
  const forfeitedSlots = Math.max(
    Number(acctRow?.forfeited_slots || 0),
    Number(forfeitedArchiveRow?.cnt || 0)
  );
  const usedSlots = activeDormantSlots + forfeitedSlots;
  const availableSlots = Math.max(0, maxSlots - usedSlots);

  return {
    activeDormantSlots,
    forfeitedSlots,
    usedSlots,
    maxSlots,
    availableSlots
  };
}

/**
 * Records a verified in-person human interaction on a Virtual Land parcel.
 * - Land minted from manual human Mobile AR art (`irl_publish`) or already permanent
 *   (`had_human_interaction = 1`, `inactivity_expires_at = ''`, `lease_expires_at = ''`)
 *   NEVER gets an expiry timer attached or re-attached.
 * - For land made first (dormant 72h agent land or pre-claimed 28-day map land awaiting art),
 *   in-person AR Check-In / AR Chat / Pin Unlock clears any 72h agent timer and sets/refreshes
 *   a 28-day activity window until a human adds AR art to permanently own it.
 */
export async function recordInPersonHumanInteraction(
  db,
  {
    parcelId,
    user,
    interactionType = 'ar_checkin',
    awakenDormant = true,
    grantAgentSlotSync = true,
    nowIso = new Date().toISOString()
  }
) {
  const userId = String(user?.id || '').trim();
  if (!userId || userId.startsWith('agent:') || user?.actorType === 'agent') {
    return { recorded: false, reason: 'not_human_actor' };
  }
  const cleanParcel = normalizeParcelId(parcelId);
  if (!cleanParcel) return { recorded: false, reason: 'missing_parcel' };

  const isPermanentArtPublish = String(interactionType || '') === 'irl_publish';
  const nextInactivityExp = isPermanentArtPublish ? '' : computeInactivityExpiresAt(nowIso);
  const steward = await db
    .get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [cleanParcel])
    .catch(() => null);

  if (!steward) {
    const parcelRow = await db
      .get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcel])
      .catch(() => null);
    if (!parcelRow) return { recorded: false, reason: 'parcel_not_found' };

    const ownerSub = parcelRow.first_claimant_sub || userId;
    const ownerType = String(ownerSub).startsWith('agent:') ? 'agent' : 'human';
    await db.run(
      `INSERT INTO land_steward_state (
        parcel_id, steward_sub, steward_address, steward_name, steward_type,
        status, claimed_at, lease_expires_at, awakened_at,
        last_human_interaction_at, last_human_interaction_type, last_human_interaction_sub,
        inactivity_expires_at, had_human_interaction,
        first_human_sub, first_human_address, human_contributor_count,
        total_tx_volume_eth, agent_royalties_eth, human_royalties_eth, platform_fees_eth, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'awakened', ?, '', ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, 0, 0, ?)`,
      [
        cleanParcel,
        ownerSub,
        parcelRow.first_claimant_address || user.wallet_address || '',
        user.name || 'Land Holder',
        ownerType,
        parcelRow.updated_at || nowIso,
        nowIso,
        nowIso,
        String(interactionType || 'ar_checkin'),
        userId,
        nextInactivityExp,
        userId,
        user.wallet_address || '',
        nowIso
      ]
    );
    return {
      recorded: true,
      parcelId: cleanParcel,
      awakenedNow: false,
      permanent: nextInactivityExp === '',
      interactionType,
      lastHumanInteractionAt: nowIso,
      inactivityExpiresAt: nextInactivityExp
    };
  }

  if (steward.status === 'archived' || steward.status === 'expired') {
    return { recorded: false, reason: 'parcel_archived' };
  }

  const alreadyPermanent =
    steward.status === 'awakened' &&
    Number(steward.had_human_interaction || 0) === 1 &&
    !String(steward.lease_expires_at || '').trim() &&
    !String(steward.inactivity_expires_at || '').trim();

  let awakenedNow = false;
  let effectiveInactivityExp = alreadyPermanent || isPermanentArtPublish ? '' : nextInactivityExp;

  if (steward.status === 'dormant' && awakenDormant) {
    awakenedNow = true;
    await db.run(
      `UPDATE land_steward_state
       SET status = 'awakened',
           lease_expires_at = '',
           awakened_at = COALESCE(NULLIF(awakened_at, ''), ?),
           last_human_interaction_at = ?,
           last_human_interaction_type = ?,
           last_human_interaction_sub = ?,
           inactivity_expires_at = ?,
           had_human_interaction = 1,
           first_human_sub = COALESCE(NULLIF(first_human_sub, ''), ?),
           first_human_address = COALESCE(NULLIF(first_human_address, ''), ?),
           updated_at = ?
       WHERE parcel_id = ?`,
      [
        nowIso,
        nowIso,
        String(interactionType || 'ar_checkin'),
        userId,
        effectiveInactivityExp,
        userId,
        user.wallet_address || '',
        nowIso,
        cleanParcel
      ]
    );

    if (grantAgentSlotSync && steward.steward_sub && steward.steward_sub.startsWith('agent:')) {
      const usage = await computeAgentSlotUsage(db, steward.steward_sub);
      await db
        .run(
          `UPDATE agent_accounts
           SET used_slots = ?,
               activated_lands_count = activated_lands_count + 1,
               last_seen_at = ?
           WHERE agent_id = ?`,
          [usage.usedSlots, nowIso, steward.steward_sub]
        )
        .catch(() => {});
    }
  } else {
    await db.run(
      `UPDATE land_steward_state
       SET last_human_interaction_at = ?,
           last_human_interaction_type = ?,
           last_human_interaction_sub = ?,
           inactivity_expires_at = ?,
           had_human_interaction = 1,
           updated_at = ?
       WHERE parcel_id = ?`,
      [
        nowIso,
        String(interactionType || 'ar_checkin'),
        userId,
        effectiveInactivityExp,
        nowIso,
        cleanParcel
      ]
    );
  }

  return {
    recorded: true,
    parcelId: cleanParcel,
    awakenedNow,
    permanent: effectiveInactivityExp === '',
    interactionType,
    lastHumanInteractionAt: nowIso,
    inactivityExpiresAt: effectiveInactivityExp
  };
}

/**
 * Verifies a direct in-person Mobile AR Land Check-In (GPS proximity + live camera/motion PoL).
 * Allows a physical human visitor to interact directly with an agent or human land even if
 * it only contains 3D models or has no initialized chat board yet.
 * @param {any} db
 * @param {{ parcelId: string, user: any, body?: any, userAgent?: string }} opts
 */
export async function checkInToLandInPerson(
  db,
  { parcelId, user, body = {}, userAgent = '' }
) {
  if (!user?.id) {
    throw new McpServiceError('Sign-in required for in-person land check-in.', 401);
  }
  if (String(user.id).startsWith('agent:') || user.actorType === 'agent') {
    throw new McpServiceError(
      'AI agents cannot check in as in-person human visitors. A human must visit physically on mobile.',
      403
    );
  }
  if (!looksMobileRequest(body?.deviceProfile, userAgent)) {
    throw new McpServiceError(
      'In-person land check-in requires a mobile device with active camera and GPS on-site.',
      403
    );
  }

  const cleanParcel = normalizeParcelId(parcelId);
  const [parcelRow, volRow, stewardRow, curationRow] = await Promise.all([
    db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db.get('SELECT * FROM land_volumes WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [cleanParcel]).catch(() => null)
  ]);

  if (
    (!parcelRow && !volRow) ||
    stewardRow?.status === 'archived' ||
    stewardRow?.status === 'expired'
  ) {
    throw new McpServiceError(`Virtual Land ${cleanParcel} was not found or has been archived.`, 404);
  }

  const loc = body?.location || body?.sightProof || {};
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new McpServiceError('Live GPS coordinates (lat, lng) are required for in-person check-in.', 400);
  }

  const geohash = parcelRow?.geohash || cleanParcel.replace(/^GLAND-/, '').toLowerCase();
  const bounds = decodeGeohashBounds(geohash);
  const centerLat = Number(volRow?.center_lat ?? parcelRow?.center_lat ?? bounds.center[0]);
  const centerLng = Number(volRow?.center_lng ?? parcelRow?.center_lng ?? bounds.center[1]);
  const widthM = Number(volRow?.width_meters || 14);
  const depthM = Number(volRow?.depth_meters || 14);
  const maxAllowedDistM = Math.max(75, Math.hypot(widthM / 2, depthM / 2) + 35);
  const distanceMeters = Math.round(haversineMeters(lat, lng, centerLat, centerLng) * 10) / 10;

  if (distanceMeters > maxAllowedDistM) {
    throw new McpServiceError(
      `Move closer to this Virtual Land to check in in person (${Math.round(distanceMeters)}m away; must be within ${Math.round(maxAllowedDistM)}m).`,
      403,
      { distanceMeters, maxAllowedDistM }
    );
  }

  const pol = body?.proofOfLocation || body?.sightProof || {};
  const cameraFrames = Number(pol.cameraFrames ?? 0);
  const gyroSamples = Number(pol.gyroSamples ?? 0);
  const hasCameraFlag = Boolean(body?.deviceProfile?.hasCamera ?? pol.cameraReady ?? cameraFrames >= 2);
  if (!hasCameraFlag || cameraFrames < 2) {
    throw new McpServiceError(
      'Active rear camera feed (at least 2 live camera frames) is required to verify physical presence.',
      403
    );
  }
  if (gyroSamples < 1 && Number(pol.opticalFlowCorrelation || 0) <= 0 && !pol.visualDHash) {
    throw new McpServiceError(
      'Live device motion or visual scene proof is required for in-person check-in.',
      403
    );
  }

  const nowIso = new Date().toISOString();
  const rec = await recordInPersonHumanInteraction(db, {
    parcelId: cleanParcel,
    user,
    interactionType: 'ar_checkin',
    awakenDormant: true,
    grantAgentSlotSync: true,
    nowIso
  });

  const label = resolveLandDisplayName({ customName: curationRow?.custom_name || '' });
  const ownerSub = stewardRow?.steward_sub || parcelRow?.first_claimant_sub || '';
  if (ownerSub && ownerSub !== user.id) {
    await createNotification(db, {
      userSub: ownerSub,
      category: 'land_activity',
      severity: rec.awakenedNow ? 'success' : 'info',
      title: rec.awakenedNow
        ? `✨ "${label}" awakened by an in-person visitor!`
        : `📍 In-person visitor checked in at "${label}"`,
      message: rec.awakenedNow
        ? `A human visited ${label} in person via Mobile AR (${distanceMeters}m away). The 72-hour reclaim timer is cleared and the 28-day activity window is now active.`
        : `A human visited ${label} in person via Mobile AR (${distanceMeters}m away), refreshing its 28-day activity window.`,
      parcelId: cleanParcel,
      actionType: 'open_land',
      actionLabel: 'Inspect Land',
      meta: {
        interactionType: 'ar_checkin',
        distanceMeters,
        awakenedNow: rec.awakenedNow,
        inactivityExpiresAt: rec.inactivityExpiresAt
      },
      dedupeKey: `checkin:${cleanParcel}:${user.id}:${nowIso.slice(0, 13)}`
    }).catch(() => {});
  }

  await recordLandView(db, {
    parcelId: cleanParcel,
    viewType: 'in_person',
    viewerKey: buildViewerDedupKey({ userId: user.id }),
    verifiedInPerson: true
  }).catch(() => null);

  return {
    checkedIn: true,
    parcelId: cleanParcel,
    landName: label,
    distanceMeters,
    awakenedNow: Boolean(rec.awakenedNow),
    interactionType: 'ar_checkin',
    lastHumanInteractionAt: rec.lastHumanInteractionAt,
    inactivityExpiresAt: rec.inactivityExpiresAt
  };
}

/**
 * Snapshots a land and all of its artworks into `land_archives`, then destroys the active
 * parcel records so its physical coordinates reopen. Consumed free slots with zero human
 * visitors are permanently forfeited and never open back up.
 */
export async function archiveAndDestroyParcel(
  db,
  {
    stewardRow,
    archiveReason = ARCHIVE_REASON_AGENT_72H,
    archiveReasonLabel = '',
    expiredAt = '',
    nowIso = new Date().toISOString()
  }
) {
  const parcelId = normalizeParcelId(stewardRow?.parcel_id);
  if (!parcelId) return null;

  const reasonLabel =
    archiveReasonLabel ||
    ARCHIVE_REASON_LABELS[archiveReason] ||
    'Archived & reclaimed due to missing in-person human interaction.';

  const [parcelRow, volRow, curationRow, sculptureRows] = await Promise.all([
    db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [parcelId]).catch(() => null),
    db.get('SELECT * FROM land_volumes WHERE parcel_id = ?', [parcelId]).catch(() => null),
    db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [parcelId]).catch(() => null),
    db
      .all(
        `SELECT s.id, s.title, s.description, s.creator_sub, s.creator_name, s.voxel_count,
                s.ipfs_metadata_cid, s.ipfs_model_cid, s.ipfs_image_cid, s.ipfs_gateway_url,
                s.token_id, s.tx_hash, s.created_at,
                m.model_format, m.model_cid, m.model_url, m.gateway_url AS model_gateway_url,
                m.scale AS custom_model_scale, m.rotation_y AS custom_model_rotation_y,
                a.dx, a.dy, a.dz, a.yaw,
                COALESCE(l.layer_role, 'artist_work') AS layer_role
         FROM sculptures s
         LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
         LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
         LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
         WHERE s.parcel_id = ? AND s.hidden = 0
         ORDER BY s.created_at ASC`,
        [parcelId]
      )
      .catch(() => [])
  ]);

  const geohash = parcelRow?.geohash || parcelId.replace(/^GLAND-/, '').toLowerCase();
  const bounds = decodeGeohashBounds(geohash);
  const centerLat = Number(volRow?.center_lat ?? parcelRow?.center_lat ?? bounds.center[0]);
  const centerLng = Number(volRow?.center_lng ?? parcelRow?.center_lng ?? bounds.center[1]);

  const volumeSnapshot = volRow
    ? {
        centerLat,
        centerLng,
        widthMeters: Number(volRow.width_meters || 14),
        depthMeters: Number(volRow.depth_meters || 14),
        heightMeters: Number(volRow.height_meters || 18),
        zScale: Number(volRow.z_scale || 1),
        rotationDeg: Number(volRow.rotation_deg || 0),
        baseAltitudeM: Number(volRow.base_altitude_m || 0),
        footprintAreaSqM: Number(volRow.footprint_area_sqm || 196),
        volumeCubicM: Number(volRow.volume_cubic_m || 3528),
        corners: parseJsonSafe(volRow.corners_json, [])
      }
    : {
        centerLat,
        centerLng,
        widthMeters: 14,
        depthMeters: 14,
        heightMeters: 18,
        rotationDeg: 0
      };

  const sculpturesSnapshot = (sculptureRows || []).map((s) => ({
    id: s.id,
    title: s.title || 'Untitled Artwork',
    description: s.description || '',
    creatorSub: s.creator_sub || '',
    creatorName: s.creator_name || '',
    layerRole: s.layer_role || 'artist_work',
    modelType: s.model_format ? 'custom-3d' : 'voxel',
    modelFormat: s.model_format || 'voxel',
    voxelCount: Number(s.voxel_count || 0),
    scale: Number(s.custom_model_scale || 1),
    anchorOffset: {
      dx: Number(s.dx || 0),
      dy: Number(s.dy || 0),
      dz: Number(s.dz || 0),
      yaw: Number(s.yaw || 0)
    },
    ipfsMetadataCid: s.ipfs_metadata_cid || '',
    ipfsModelCid: s.model_cid || s.ipfs_model_cid || '',
    ipfsImageCid: s.ipfs_image_cid || '',
    ipfsGatewayUrl: s.model_gateway_url || s.ipfs_gateway_url || '',
    tokenId: s.token_id || '',
    txHash: s.tx_hash || '',
    createdAt: s.created_at || ''
  }));

  const landName = resolveLandDisplayName({
    customName: curationRow?.custom_name || '',
    firstSculptureTitle: sculpturesSnapshot[0]?.title || ''
  });
  const description = String(curationRow?.curation_note || '').trim();
  const stewardSub = String(stewardRow.steward_sub || parcelRow?.first_claimant_sub || '');
  const stewardType =
    stewardRow.steward_type || (stewardSub.startsWith('agent:') ? 'agent' : 'human');
  const hadHumanInteraction =
    Number(stewardRow.had_human_interaction || 0) === 1 ||
    Boolean(stewardRow.last_human_interaction_at && stewardRow.last_human_interaction_type && stewardRow.last_human_interaction_type !== 'human_mint')
      ? 1
      : 0;

  const archiveId = `arch_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  await db.run(
    `INSERT INTO land_archives (
      id, parcel_id, geohash, land_name, description,
      steward_sub, steward_name, steward_address, steward_type,
      archive_reason, archive_reason_label,
      center_lat, center_lng, volume_json,
      sculpture_count, sculptures_snapshot_json,
      human_contributor_count, had_human_interaction,
      claimed_at, awakened_at, last_human_interaction_at,
      expired_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      archiveId,
      parcelId,
      geohash,
      landName,
      description,
      stewardSub,
      stewardRow.steward_name || (stewardType === 'agent' ? 'Autonomous Steward' : 'Land Holder'),
      stewardRow.steward_address || parcelRow?.first_claimant_address || '',
      stewardType,
      archiveReason,
      reasonLabel,
      centerLat,
      centerLng,
      JSON.stringify(volumeSnapshot),
      sculpturesSnapshot.length,
      JSON.stringify(sculpturesSnapshot),
      Number(stewardRow.human_contributor_count || 0),
      hadHumanInteraction,
      stewardRow.claimed_at || '',
      stewardRow.awakened_at || '',
      stewardRow.last_human_interaction_at || '',
      expiredAt || nowIso,
      nowIso
    ]
  );

  // Destroy active land state & hide all sculptures placed on the destroyed land
  await db.run(
    `UPDATE land_steward_state
     SET status = 'archived',
         lease_expires_at = '',
         inactivity_expires_at = '',
         updated_at = ?
     WHERE parcel_id = ?`,
    [nowIso, parcelId]
  );
  await db
    .run(
      `UPDATE land_quests SET status = 'archived', updated_at = ? WHERE parcel_id = ? AND status = 'open'`,
      [nowIso, parcelId]
    )
    .catch(() => {});
  await db
    .run(
      `UPDATE marketplace_listings SET status = 'cancelled' WHERE parcel_id = ? AND status = 'active'`,
      [parcelId]
    )
    .catch(() => {});
  await db.run(
    `UPDATE sculptures
     SET hidden = 1, hidden_reason = ?, hidden_by = 'protocol:land-archive'
     WHERE parcel_id = ? AND hidden = 0`,
    [reasonLabel, parcelId]
  );

  for (const tbl of [
    'parcel_curations',
    'land_parcels',
    'land_volumes',
    'land_settings',
    'land_contributors',
    'land_security_policies',
    'parcel_landmark_anchors'
  ]) {
    await db.run(`DELETE FROM ${tbl} WHERE parcel_id = ?`, [parcelId]).catch(() => {});
  }

  // Free mint slot enforcement: if the land NEVER received an in-person human user,
  // permanently forfeit that free slot so it does NOT open back up.
  if (stewardSub.startsWith('agent:')) {
    if (!hadHumanInteraction) {
      await db
        .run(
          `UPDATE agent_accounts
           SET forfeited_slots = COALESCE(forfeited_slots, 0) + 1,
               last_seen_at = ?
           WHERE agent_id = ?`,
          [nowIso, stewardSub]
        )
        .catch(() => {});
    }
    const usage = await computeAgentSlotUsage(db, stewardSub);
    await db
      .run(`UPDATE agent_accounts SET used_slots = ?, last_seen_at = ? WHERE agent_id = ?`, [
        usage.usedSlots,
        nowIso,
        stewardSub
      ])
      .catch(() => {});
  }

  if (stewardSub) {
    await createNotification(db, {
      userSub: stewardSub,
      category: 'land_expiring',
      severity: 'warning',
      title: `🗄️ "${landName}" was archived & reclaimed`,
      message: `${reasonLabel}${!hadHumanInteraction ? ' Because no in-person human interacted with this land, its free mint slot did not reopen.' : ''} Inspect the permanent record in the Land Archive.`,
      parcelId,
      actionType: 'open_archive',
      actionLabel: 'View Archive',
      meta: {
        archiveId,
        parcelId,
        archiveReason,
        hadHumanInteraction: Boolean(hadHumanInteraction),
        freeSlotForfeited: !hadHumanInteraction
      },
      dedupeKey: `archived:${archiveId}`
    }).catch(() => {});
  }

  return {
    archiveId,
    parcelId,
    landName,
    archiveReason,
    hadHumanInteraction: Boolean(hadHumanInteraction),
    sculptureCount: sculpturesSnapshot.length
  };
}

/**
 * Enforces both land expiration rules & 3-hour pre-expiry warnings:
 * 1. Agent-created lands with 0 verified in-person human interactions within 72 hours
 *    (even if the agent placed 3D models/stages) -> archived, destroyed, coordinates reopened,
 *    free slot permanently forfeited.
 * 2. Any active land with 0 verified in-person human interactions for 28 consecutive days
 *    -> archived, destroyed, coordinates reopened (free slot forfeited if it never had human users).
 */
export async function reapAndArchiveExpiredLands(db, nowIso = new Date().toISOString()) {
  const archivedItems = [];
  let agent72hCount = 0;
  let inactivity28dCount = 0;

  // 1) Check 72-hour dormant agent lands
  const expiredDormant = await db
    .all(
      `SELECT * FROM land_steward_state
       WHERE status = 'dormant' AND lease_expires_at != '' AND lease_expires_at <= ?`,
      [nowIso]
    )
    .catch(() => []);

  for (const row of expiredDormant || []) {
    // Verify whether a genuine in-person human interacted with this land.
    // Agent-placed 3D models and stages NEVER count as human interaction.
    let hasHumanInteraction =
      Number(row.had_human_interaction || 0) === 1 ||
      Boolean(
        row.last_human_interaction_at &&
          row.last_human_interaction_type &&
          row.last_human_interaction_type !== 'human_mint'
      );

    if (!hasHumanInteraction) {
      const humanArt = await db
        .get(
          `SELECT COUNT(*) AS cnt, MAX(s.created_at) AS latest_at
           FROM sculptures s
           LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
           WHERE s.parcel_id = ?
             AND s.hidden = 0
             AND s.creator_sub NOT LIKE 'agent:%'
             AND COALESCE(l.layer_role, 'artist_work') = 'artist_work'
             AND COALESCE(l.qual_contributor, 1) = 1`,
          [row.parcel_id]
        )
        .catch(() => ({ cnt: 0, latest_at: '' }));
      if (Number(humanArt?.cnt || 0) > 0) {
        hasHumanInteraction = true;
        const latestAt = humanArt.latest_at || nowIso;
        await db.run(
          `UPDATE land_steward_state
           SET status = 'awakened',
               lease_expires_at = '',
               awakened_at = COALESCE(NULLIF(awakened_at, ''), ?),
               last_human_interaction_at = COALESCE(NULLIF(last_human_interaction_at, ''), ?),
               last_human_interaction_type = COALESCE(NULLIF(last_human_interaction_type, ''), 'irl_publish'),
               inactivity_expires_at = '',
               had_human_interaction = 1,
               updated_at = ?
           WHERE parcel_id = ?`,
          [latestAt, latestAt, nowIso, row.parcel_id]
        );
        continue;
      }
    } else {
      const lastAt = row.last_human_interaction_at || nowIso;
      const clearedByHumanArt = row.last_human_interaction_type === 'irl_publish';
      await db.run(
        `UPDATE land_steward_state
         SET status = 'awakened',
             lease_expires_at = '',
             awakened_at = COALESCE(NULLIF(awakened_at, ''), ?),
             inactivity_expires_at = ?,
             updated_at = ?
         WHERE parcel_id = ?`,
        [lastAt, clearedByHumanArt ? '' : computeInactivityExpiresAt(lastAt), nowIso, row.parcel_id]
      );
      continue;
    }

    const res = await archiveAndDestroyParcel(db, {
      stewardRow: row,
      archiveReason: ARCHIVE_REASON_AGENT_72H,
      archiveReasonLabel: ARCHIVE_REASON_LABELS[ARCHIVE_REASON_AGENT_72H],
      expiredAt: row.lease_expires_at || nowIso,
      nowIso
    });
    if (res) {
      archivedItems.push(res);
      agent72hCount += 1;
    }
  }

  // 2) Check 28-day expiry across pre-claimed lands that still carry an active countdown timer
  //    (lands minted or upgraded with manual human Mobile AR art have inactivity_expires_at = '' and NEVER expire)
  const expiredInactive = await db
    .all(
      `SELECT * FROM land_steward_state
       WHERE status = 'awakened' AND inactivity_expires_at != '' AND inactivity_expires_at <= ?`,
      [nowIso]
    )
    .catch(() => []);

  for (const row of expiredInactive || []) {
    // Safety guard: never recycle a land that already has manual human-drawn AR voxel art!
    const manualHumanArt = await db
      .get(
        `SELECT COUNT(*) AS cnt
         FROM sculptures s
         LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
         WHERE s.parcel_id = ?
           AND s.hidden = 0
           AND s.creator_sub NOT LIKE 'agent:%'
           AND m.model_format IS NULL`,
        [row.parcel_id]
      )
      .catch(() => ({ cnt: 0 }));
    if (Number(manualHumanArt?.cnt || 0) > 0) {
      await db.run(
        `UPDATE land_steward_state
         SET lease_expires_at = '',
             inactivity_expires_at = '',
             had_human_interaction = 1,
             updated_at = ?
         WHERE parcel_id = ?`,
        [nowIso, row.parcel_id]
      );
      continue;
    }

    const res = await archiveAndDestroyParcel(db, {
      stewardRow: row,
      archiveReason: ARCHIVE_REASON_INACTIVITY_28D,
      archiveReasonLabel: ARCHIVE_REASON_LABELS[ARCHIVE_REASON_INACTIVITY_28D],
      expiredAt: row.inactivity_expires_at || nowIso,
      nowIso
    });
    if (res) {
      archivedItems.push(res);
      inactivity28dCount += 1;
    }
  }

  // 3) Emit 3-hour pre-expiry warning notifications for any remaining lands approaching expiry
  await syncAllExpiringLandNotifications(db, nowIso).catch(() => {});

  return {
    releasedCount: archivedItems.length,
    archivedCount: archivedItems.length,
    agent72hCount,
    inactivity28dCount,
    archivedItems
  };
}

export function serializeArchiveRow(row, { includeSculptures = true } = {}) {
  if (!row) return null;
  const volume = parseJsonSafe(row.volume_json, {});
  const sculptures = includeSculptures ? parseJsonSafe(row.sculptures_snapshot_json, []) : [];
  return {
    id: row.id,
    parcelId: row.parcel_id,
    geohash: row.geohash,
    landName: row.land_name || row.parcel_id,
    description: row.description || '',
    stewardSub: row.steward_sub || '',
    stewardName: row.steward_name || (row.steward_type === 'agent' ? 'AI Steward' : 'Land Holder'),
    stewardAddress: row.steward_address || '',
    stewardType: row.steward_type || 'agent',
    archiveReason: row.archive_reason || ARCHIVE_REASON_AGENT_72H,
    archiveReasonLabel:
      row.archive_reason_label ||
      ARCHIVE_REASON_LABELS[row.archive_reason] ||
      'Archived & reclaimed',
    centerLat: Number(row.center_lat || 0),
    centerLng: Number(row.center_lng || 0),
    volume,
    sculptureCount: Number(row.sculpture_count || 0),
    ...(includeSculptures ? { sculpturesSnapshot: Array.isArray(sculptures) ? sculptures : [] } : {}),
    humanContributorCount: Number(row.human_contributor_count || 0),
    hadHumanInteraction: Number(row.had_human_interaction || 0) === 1,
    freeSlotForfeited: Number(row.had_human_interaction || 0) === 0,
    claimedAt: row.claimed_at || '',
    awakenedAt: row.awakened_at || '',
    lastHumanInteractionAt: row.last_human_interaction_at || '',
    expiredAt: row.expired_at || '',
    archivedAt: row.archived_at || ''
  };
}

export async function listArchivedLands(
  db,
  { q = '', reason = '', steward = '', limit = 50, offset = 0 } = {}
) {
  await reapAndArchiveExpiredLands(db).catch(() => {});

  const where = [];
  const params = [];
  const cleanQ = String(q || '').trim().toLowerCase();
  const cleanReason = String(reason || '').trim();
  const cleanSteward = String(steward || '').trim();

  if (cleanQ) {
    where.push(
      '(LOWER(land_name) LIKE ? OR LOWER(parcel_id) LIKE ? OR LOWER(steward_name) LIKE ? OR LOWER(description) LIKE ?)'
    );
    const pat = `%${cleanQ}%`;
    params.push(pat, pat, pat, pat);
  }
  if (cleanReason && cleanReason !== 'all') {
    where.push('archive_reason = ?');
    params.push(cleanReason);
  }
  if (cleanSteward) {
    where.push('steward_sub = ?');
    params.push(cleanSteward);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const [rows, countRow, summaryRow] = await Promise.all([
    db
      .all(
        `SELECT * FROM land_archives ${whereClause} ORDER BY archived_at DESC LIMIT ? OFFSET ?`,
        [...params, safeLimit, safeOffset]
      )
      .catch(() => []),
    db
      .get(`SELECT COUNT(*) AS cnt FROM land_archives ${whereClause}`, params)
      .catch(() => ({ cnt: 0 })),
    db
      .get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN archive_reason = ? THEN 1 ELSE 0 END), 0) AS agent72h,
                COALESCE(SUM(CASE WHEN archive_reason = ? THEN 1 ELSE 0 END), 0) AS inactivity28d
         FROM land_archives`,
        [ARCHIVE_REASON_AGENT_72H, ARCHIVE_REASON_INACTIVITY_28D]
      )
      .catch(() => ({ total: 0, agent72h: 0, inactivity28d: 0 }))
  ]);

  return {
    archives: (rows || []).map((r) => serializeArchiveRow(r, { includeSculptures: true })),
    total: Number(countRow?.cnt || 0),
    counts: {
      total: Number(summaryRow?.total || 0),
      agent72h: Number(summaryRow?.agent72h || 0),
      inactivity28d: Number(summaryRow?.inactivity28d || 0)
    }
  };
}

export async function getArchivedLandDetail(db, archiveId) {
  const cleanId = String(archiveId || '').trim();
  if (!cleanId) throw new McpServiceError('Archive ID is required.', 400);
  const row = await db
    .get('SELECT * FROM land_archives WHERE id = ? OR parcel_id = ? ORDER BY archived_at DESC LIMIT 1', [
      cleanId,
      normalizeParcelId(cleanId)
    ])
    .catch(() => null);
  if (!row) throw new McpServiceError('Archived land record not found.', 404);
  return { archive: serializeArchiveRow(row, { includeSculptures: true }) };
}
