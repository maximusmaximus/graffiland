import { ethers } from 'ethers';
import {
  HUMAN_MAX_DRAW_SPAN_FEET,
  HUMAN_MAX_DRAW_SPAN_METERS,
  POLICY
} from '../constants.mjs';
import {
  buildDefaultVolumeFromBounds,
  buildMultiObjectFittedLandVolume,
  buildObjectFittedLandVolume,
  buildParcelShareUrl,
  computeOrientedFootprintLngLat,
  ensureLandVolumeFitsSculptures,
  resolveLandDisplayName,
  slugifyLandTitle,
  validateLandTitle
} from '../landVolume.mjs';
import {
  resolveAuthorHandleForStorage,
  resolvePublicUserHandle,
  resolveSafeUserAvatar
} from '../userDisplay.mjs';
import { notifyAfterSculpturePublished } from '../notificationService.mjs';
import { reapAndArchiveExpiredLands } from '../landArchiveService.mjs';
import { getLandViewCountsMap } from '../landViewService.mjs';
import { consumeDraftOnPublish } from '../draftService.mjs';
import { sanitizeVoxels, validatePublishPayload } from '../../server/services/moderation.mjs';
import { decodeGeohashBounds, encodeGeohash } from '../../server/services/pol.mjs';
import { computeVerticalBounds, serializeSculptureRow } from '../sculpture.mjs';
import {
  b64ToModelBytes,
  extractCustomModelInput,
  INLINE_MODEL_DB_MAX_BYTES,
  modelBytesToB64,
  validate3dModelUrl,
  validateAnchorOffset
} from '../model3d.mjs';
import {
  buildPlacementItemFromSculpture,
  computeMaxFeasibleScale,
  computeRotatedBoxDimensions,
  evaluateModelFitInParcel,
  extractSculptureBaseDimensions,
  extractSculptureScale,
  normalizeBaseDimensions,
  resolveParcelVolumeForPlacement,
  resolveSculpturePlacement,
  tiltToDegrees
} from '../sculpturePlacement.mjs';
import { DEFAULT_MAX_ORB_REPROJ_PX, DEFAULT_MIN_ORB_INLIERS } from '../landmarkService.mjs';
import {
  McpServiceError,
  checkParcelOwnership,
  checkSculptureEditPermission,
  checkSculptureOrLandOwnership,
  fetchSculptureWithModelRow,
  getLatestParcelDisplayName,
  normalizeParcelId,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses,
  upsertAnchorAndRevision,
  validateEditableTitleAndDescription
} from './helpers.mjs';

export async function listLandsWithCurations(db) {
  await reapAndArchiveExpiredLands(db).catch(() => {});
  const scRows = await db.all(
    `SELECT
      parcel_id,
      geohash,
      COUNT(*) AS visible_count,
      MAX(created_at) AS latest_at,
      MIN(created_at) AS first_at
     FROM sculptures
     WHERE hidden = 0
     GROUP BY parcel_id, geohash`
  );
  const lpRows = await db.all('SELECT * FROM land_parcels ORDER BY updated_at DESC');
  const stewardRows = await db.all('SELECT * FROM land_steward_state');
  const questCounts = await db.all(
    `SELECT parcel_id, COUNT(*) AS cnt FROM land_quests WHERE status = 'open' GROUP BY parcel_id`
  );
  const curations = await db.all('SELECT * FROM parcel_curations');
  const volumeRows = await db.all('SELECT * FROM land_volumes').catch(() => []);
  const settingRows = await db.all('SELECT * FROM land_settings').catch(() => []);
  const userRows = await db
    .all('SELECT id, username, avatar_image, user_number FROM users')
    .catch(() => []);
  const viewCountsMap = await getLandViewCountsMap(db);
  // Single bulk query for all visible sculptures (eliminates 2*N per-parcel queries inside the loop)
  const allVisibleScRows = await db
    .all(
      `SELECT s.parcel_id, s.geohash, s.lat, s.lng, s.voxels_json,
              s.recipient_address, s.creator_name, s.creator_sub, s.title, s.place_name, s.created_at,
              a.dx AS anchor_dx, a.dy AS anchor_dy, a.dz AS anchor_dz, a.yaw AS anchor_yaw,
              m.scale AS custom_model_scale
       FROM sculptures s
       LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
       LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
       WHERE s.hidden = 0
       ORDER BY s.created_at ASC`
    )
    .catch(() => []);
  const scByParcelMap = new Map();
  for (const row of allVisibleScRows || []) {
    if (!row?.parcel_id) continue;
    let bucket = scByParcelMap.get(row.parcel_id);
    if (!bucket) {
      bucket = [];
      scByParcelMap.set(row.parcel_id, bucket);
    }
    bucket.push(row);
  }

  const scMap = new Map((scRows || []).map((r) => [r.parcel_id, r]));
  const lpMap = new Map((lpRows || []).map((r) => [r.parcel_id, r]));
  const stewardMap = new Map((stewardRows || []).map((r) => [r.parcel_id, r]));
  const questMap = new Map((questCounts || []).map((r) => [r.parcel_id, Number(r.cnt || 0)]));
  const curationMap = new Map((curations || []).map((c) => [c.parcel_id, c]));
  const volumeMap = new Map((volumeRows || []).map((v) => [v.parcel_id, v]));
  const settingsMap = new Map((settingRows || []).map((s) => [s.parcel_id, s]));
  const userInfoMap = new Map(
    (userRows || []).map((u) => [
      u.id,
      {
        username: String(u.username || '').trim(),
        avatarImage: resolveSafeUserAvatar(u.avatar_image || ''),
        userNumber: Number(u.user_number || 0)
      }
    ])
  );

  const allParcelIds = new Set([...scMap.keys(), ...lpMap.keys()]);
  const parcels = [];

  for (const parcelId of allParcelIds) {
    const sc = scMap.get(parcelId);
    const lp = lpMap.get(parcelId);
    const st = stewardMap.get(parcelId);
    const geohash = sc?.geohash || lp?.geohash || parcelId.replace(/^GLAND-/, '').toLowerCase();
    const bounds = decodeGeohashBounds(geohash);
    const parcelScRows = sc ? scByParcelMap.get(parcelId) || [] : [];
    const first = parcelScRows.length > 0 ? parcelScRows[0] : null;
    const cur = curationMap.get(parcelId);
    const vr = volumeMap.get(parcelId);
    let parsedCorners = [];
    if (vr?.corners_json) {
      try {
        parsedCorners = JSON.parse(vr.corners_json);
      } catch {
        parsedCorners = [];
      }
    }
    let fittedFallbackVolume = null;
    if (sc && !vr && parcelScRows.length > 0) {
      fittedFallbackVolume = buildMultiObjectFittedLandVolume({
        parcelId,
        geohash,
        sculptures: parcelScRows,
        paddingFraction: 0.1
      });
    }

    const rawVolume = vr
      ? {
          parcelId,
          geohash,
          centerLat: Number(vr.center_lat),
          centerLng: Number(vr.center_lng),
          widthMeters: Number(vr.width_meters),
          depthMeters: Number(vr.depth_meters),
          heightMeters: Number(vr.height_meters),
          zScale: Number(vr.z_scale),
          rotationDeg: Number(vr.rotation_deg),
          baseAltitudeM: Number(vr.base_altitude_m || 0),
          footprintAreaSqM: Number(vr.footprint_area_sqm),
          volumeCubicM: Number(vr.volume_cubic_m),
          corners:
            parsedCorners.length >= 4
              ? parsedCorners
              : computeOrientedFootprintLngLat({
                  lat: Number(vr.center_lat),
                  lng: Number(vr.center_lng),
                  widthMeters: Number(vr.width_meters),
                  depthMeters: Number(vr.depth_meters),
                  rotationDeg: Number(vr.rotation_deg)
                }).corners,
          ring:
            parsedCorners.length >= 4
              ? [...parsedCorners.slice(0, 4), parsedCorners[0]]
              : computeOrientedFootprintLngLat({
                  lat: Number(vr.center_lat),
                  lng: Number(vr.center_lng),
                  widthMeters: Number(vr.width_meters),
                  depthMeters: Number(vr.depth_meters),
                  rotationDeg: Number(vr.rotation_deg)
                }).ring
        }
      : fittedFallbackVolume || buildDefaultVolumeFromBounds(bounds, parcelId, geohash);

    const volume =
      parcelScRows.length > 0
        ? ensureLandVolumeFitsSculptures(rawVolume, parcelScRows, { paddingFraction: 0.1 })
        : rawVolume;

    const stewardStatus = st?.status || 'awakened';
    const ownerSub = st?.steward_sub || first?.creator_sub || lp?.first_claimant_sub || '';
    const stewardType =
      st?.steward_type || (String(ownerSub).startsWith('agent:') ? 'agent' : 'human');
    const ownerInfo = userInfoMap.get(ownerSub) || null;
    const firstSub = first?.creator_sub || lp?.first_claimant_sub || ownerSub;
    const firstInfo = userInfoMap.get(firstSub) || ownerInfo;
    const safeStewardName = resolvePublicUserHandle(
      {
        id: ownerSub,
        username: ownerInfo?.username || '',
        stewardName: st?.steward_name || first?.creator_name || '',
        stewardType,
        userNumber: ownerInfo?.userNumber || 0
      },
      { fallback: stewardType === 'agent' ? 'AI Steward' : 'Land Holder', includeAt: true }
    );
    const safeFirstClaimantName = resolvePublicUserHandle(
      {
        id: firstSub,
        username: firstInfo?.username || '',
        creatorName: first?.creator_name || st?.steward_name || '',
        userNumber: firstInfo?.userNumber || 0
      },
      { fallback: 'Land Holder', includeAt: true }
    );

    parcels.push({
      parcelId,
      geohash,
      bounds,
      volume,
      centerLat: volume?.centerLat ?? bounds.center[0],
      centerLng: volume?.centerLng ?? bounds.center[1],
      sculptureCount: Number(sc?.visible_count ?? lp?.sculpture_count ?? 0),
      firstClaimantAddress: first?.recipient_address || lp?.first_claimant_address || '',
      firstClaimantName: safeFirstClaimantName,
      firstClaimantUsername: firstInfo?.username || '',
      firstClaimantAvatar: firstInfo?.avatarImage || '',
      ownerSub,
      stewardSub: ownerSub,
      stewardName: safeStewardName,
      stewardUsername: ownerInfo?.username || '',
      stewardAvatar: ownerInfo?.avatarImage || '',
      stewardType,
      stewardStatus,
      firstSparkBoost: stewardStatus === 'dormant',
      leaseExpiresAt: st?.lease_expires_at || '',
      inactivityExpiresAt: st?.inactivity_expires_at || '',
      lastHumanInteractionAt: st?.last_human_interaction_at || '',
      lastHumanInteractionType: st?.last_human_interaction_type || '',
      hadHumanInteraction: Number(st?.had_human_interaction || 0) === 1,
      awakenedAt: st?.awakened_at || '',
      humanContributorCount: Number(st?.human_contributor_count || 0),
      openQuestCount: questMap.get(parcelId) || 0,
      totalVolumeEth: Number(st?.total_tx_volume_eth || 0),
      agentRoyaltiesEth: Number(st?.agent_royalties_eth || 0),
      humanRoyaltiesEth: Number(st?.human_royalties_eth || 0),
      customName: cur?.custom_name || '',
      displayName: resolveLandDisplayName({
        customName: cur?.custom_name || '',
        firstSculptureTitle: first?.title || '',
        placeName: first?.place_name || ''
      }),
      description: cur?.curation_note || '',
      curationNote: cur?.curation_note || '',
      slug: slugifyLandTitle(cur?.custom_name || '') || parcelId.toLowerCase(),
      featuredSculptureId: cur?.featured_sculpture_id || '',
      lastSignedTxHash: cur?.last_signed_tx_hash || '',
      frozen: Boolean(settingsMap.get(parcelId)?.freeze_placements),
      settings: {
        allowAgentErase: settingsMap.has(parcelId)
          ? Boolean(settingsMap.get(parcelId).allow_agent_erase)
          : true,
        allowContributorEdits: settingsMap.has(parcelId)
          ? Boolean(settingsMap.get(parcelId).allow_contributor_edits)
          : true,
        frozen: Boolean(settingsMap.get(parcelId)?.freeze_placements)
      },
      pageViews: viewCountsMap.get(parcelId)?.pageViews || 0,
      inPersonViews: viewCountsMap.get(parcelId)?.inPersonViews || 0,
      createdAt: sc?.first_at || st?.created_at || lp?.updated_at || '',
      latestAt: sc?.latest_at || lp?.updated_at || st?.updated_at || ''
    });
  }

  parcels.sort((a, b) => (b.sculptureCount - a.sculptureCount) || (b.latestAt || '').localeCompare(a.latestAt || ''));
  return parcels;
}

async function loadParcelVolumeAndSiblings(db, { parcelId, geohash = '', bounds = null }) {
  const cleanId = normalizeParcelId(parcelId);
  const vr = await db
    .get('SELECT * FROM land_volumes WHERE parcel_id = ?', [cleanId])
    .catch(() => null);
  const fallbackGeo = geohash || cleanId.replace(/^GLAND-/, '').toLowerCase();
  const fallbackBounds = bounds || (fallbackGeo ? decodeGeohashBounds(fallbackGeo) : null);

  let parcelVolume = null;
  if (vr) {
    parcelVolume = resolveParcelVolumeForPlacement({
      volume: {
        parcelId: cleanId,
        geohash: fallbackGeo,
        centerLat: Number(vr.center_lat),
        centerLng: Number(vr.center_lng),
        widthMeters: Number(vr.width_meters),
        depthMeters: Number(vr.depth_meters),
        heightMeters: Number(vr.height_meters),
        rotationDeg: Number(vr.rotation_deg || 0),
        baseAltitudeM: Number(vr.base_altitude_m || 0)
      }
    });
  } else if (fallbackBounds) {
    parcelVolume = resolveParcelVolumeForPlacement({
      volume: buildDefaultVolumeFromBounds(fallbackBounds, cleanId, fallbackGeo)
    });
  } else {
    parcelVolume = resolveParcelVolumeForPlacement({});
  }

  const siblingRows = await db
    .all(
      `SELECT s.id, s.title, s.lat, s.lng, s.voxels_json, s.voxel_count,
        m.model_format AS custom_model_format, m.scale AS custom_model_scale,
        a.dx AS anchor_dx, a.dy AS anchor_dy, a.dz AS anchor_dz, a.yaw AS anchor_yaw,
        a.mesh_stats_json AS mesh_stats_json
       FROM sculptures s
       LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
       LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
       WHERE s.parcel_id = ? AND s.hidden = 0`,
      [cleanId]
    )
    .catch(() => []);

  const existingItems = (siblingRows || []).map((row) => {
    const parsedStats = (() => {
      try {
        const p = JSON.parse(row.mesh_stats_json || '{}');
        return p && typeof p === 'object' ? p : {};
      } catch {
        return {};
      }
    })();
    return buildPlacementItemFromSculpture(
      {
        id: row.id,
        title: row.title,
        lat: row.lat,
        lng: row.lng,
        modelType: row.custom_model_format ? 'custom-3d' : 'voxel',
        customModel: row.custom_model_format
          ? { format: row.custom_model_format, scale: Number(row.custom_model_scale || 1) }
          : null,
        voxels: JSON.parse(row.voxels_json || '[]'),
        voxelCount: Number(row.voxel_count || 0),
        meshStats: parsedStats,
        anchorOffset: {
          dx: Number(row.anchor_dx || 0),
          dy: Number(row.anchor_dy || 0),
          dz: Number(row.anchor_dz || 0),
          yaw: Number(row.anchor_yaw || 0),
          pitch: tiltToDegrees(parsedStats?.transformPitch || 0),
          roll: tiltToDegrees(parsedStats?.transformRoll || 0)
        }
      },
      parcelVolume
    );
  });

  return { parcelVolume, siblingRows: siblingRows || [], existingItems };
}

export async function inspectParcelFitForModel(
  db,
  { parcelId, bbox, modelScale = 1, anchorOffset = {} }
) {
  const cleanId = normalizeParcelId(parcelId);
  if (!cleanId) return null;
  const { parcelVolume, existingItems } = await loadParcelVolumeAndSiblings(db, {
    parcelId: cleanId
  });
  return evaluateModelFitInParcel({
    parcelVolume,
    bbox,
    modelScale,
    anchorOffset,
    existingItems
  });
}

async function resolveCustomModelBytes(customModel) {
  if (!customModel || customModel.bytes) return customModel;
  const formatHint = customModel.format && customModel.format !== 'auto' ? customModel.format : '';
  const checked = await validate3dModelUrl(customModel.externalUrl, { formatHint });
  if (!checked.valid || !checked.customModel) {
    throw new McpServiceError(
      checked.error || `Could not download or validate 3D model URL (${customModel.externalUrl}).`,
      400
    );
  }
  return {
    ...checked.customModel,
    scale: customModel.scale ?? checked.customModel.scale,
    rotationY: customModel.rotationY ?? checked.customModel.rotationY,
    externalUrl: customModel.externalUrl
  };
}

async function upsertSculptureModelRow(db, { sculptureId, parcelId, customModel, ipfsResult }) {
  const now = new Date().toISOString();
  const inlineB64 =
    customModel.bytes && customModel.bytes.length <= INLINE_MODEL_DB_MAX_BYTES
      ? modelBytesToB64(customModel.bytes)
      : '';
  await db.run(
    `INSERT INTO sculpture_models (
      sculpture_id, parcel_id, model_format, mime_type, source_type, model_url,
      model_cid, model_uri, gateway_url, inline_b64, byte_length, scale, rotation_y, updated_at
    ) VALUES (?, ?, ?, ?, 'ipfs', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sculpture_id) DO UPDATE SET
      parcel_id = excluded.parcel_id,
      model_format = excluded.model_format,
      mime_type = excluded.mime_type,
      source_type = excluded.source_type,
      model_url = excluded.model_url,
      model_cid = excluded.model_cid,
      model_uri = excluded.model_uri,
      gateway_url = excluded.gateway_url,
      inline_b64 = excluded.inline_b64,
      byte_length = excluded.byte_length,
      scale = excluded.scale,
      rotation_y = excluded.rotation_y,
      updated_at = excluded.updated_at`,
    [
      sculptureId,
      parcelId,
      customModel.format,
      customModel.mimeType,
      customModel.externalUrl || '',
      ipfsResult?.modelCid || '',
      ipfsResult?.modelUri || '',
      ipfsResult?.gatewayUrl || '',
      inlineB64,
      customModel.byteLength || customModel.bytes?.length || 0,
      Number(customModel.scale ?? 1),
      Number(customModel.rotationY ?? 0),
      now
    ]
  );
}

export async function getLandSettingsInternal(db, parcelId) {
  const cleanId = normalizeParcelId(parcelId);
  const row = await db.get('SELECT * FROM land_settings WHERE parcel_id = ?', [cleanId]);
  return {
    parcelId: cleanId,
    allowAgentErase: row ? Boolean(row.allow_agent_erase) : true,
    allowContributorEdits: row ? Boolean(row.allow_contributor_edits) : true,
    frozen: row ? Boolean(row.freeze_placements) : false,
    updatedAt: row?.updated_at || ''
  };
}

function formatContributorRow(row) {
  const username = String(row.contributor_username || '').trim();
  const avatarImage = resolveSafeUserAvatar(row.contributor_avatar || '');
  return {
    id: row.id,
    parcelId: row.parcel_id,
    contributorSub: row.contributor_sub,
    email: row.contributor_email || '',
    username,
    avatarImage,
    name: resolvePublicUserHandle(
      { id: row.contributor_sub, username, name: row.contributor_name },
      { fallback: 'Artist', includeAt: true }
    ),
    walletAddress: row.contributor_address || '',
    canEditSculptures: Boolean(row.can_edit_sculptures),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findEligibleParcelVisitors(db, { parcelId, ownerSub = '' }) {
  const cleanId = normalizeParcelId(parcelId);
  const rows = await db.all(
    `SELECT DISTINCT u.id AS userId, u.email, u.username, u.avatar_image AS avatarImage,
            u.user_number AS userNumber, u.wallet_address AS walletAddress,
            u.custom_payout_address AS customPayoutAddress
     FROM users u
     WHERE u.id != ?
       AND (
         EXISTS (
           SELECT 1 FROM sculpture_chat_grants g
           LEFT JOIN sculptures s ON s.id = g.sculpture_id
           WHERE (g.sculpture_id = ? OR s.parcel_id = ?) AND g.requester_sub = u.id AND g.status = 'granted'
         )
         OR EXISTS (
           SELECT 1 FROM sculpture_chat_messages m
           LEFT JOIN sculptures s ON s.id = m.sculpture_id
           WHERE (m.sculpture_id = ? OR s.parcel_id = ?) AND m.sender_sub = u.id
         )
         OR EXISTS (
           SELECT 1 FROM parcel_presence_challenges p
           WHERE p.parcel_id = ? AND p.user_id = u.id AND p.consumed = 1
         )
       )
     ORDER BY u.username ASC, u.created_at ASC`,
    [ownerSub, cleanId, cleanId, cleanId, cleanId, cleanId]
  );
  return (rows || []).map((r) => {
    const username = String(r.username || '').trim();
    return {
      userId: r.userId,
      email: r.email || '',
      username,
      avatarImage: resolveSafeUserAvatar(r.avatarImage || ''),
      name: resolvePublicUserHandle(
        { id: r.userId, username, userNumber: r.userNumber },
        { fallback: 'Visitor', includeAt: true }
      ),
      walletAddress: r.customPayoutAddress || r.walletAddress || ''
    };
  });
}

async function findEligibleParcelVisitorsMap(db, { parcelIds = [], ownerSub = '' }) {
  const cleanIds = [...new Set((parcelIds || []).map(normalizeParcelId).filter(Boolean))];
  const out = new Map(cleanIds.map((pid) => [pid, []]));
  if (cleanIds.length === 0) return out;
  const placeholders = cleanIds.map(() => '?').join(', ');

  const pairs = new Map(cleanIds.map((pid) => [pid, new Set()]));
  const addPair = (pid, uid) => {
    const cleanPid = normalizeParcelId(pid);
    if (!uid || uid === ownerSub || !pairs.has(cleanPid)) return;
    pairs.get(cleanPid).add(uid);
  };

  const [grantRows, msgRows, presenceRows] = await Promise.all([
    db
      .all(
        `SELECT COALESCE(s.parcel_id, g.sculpture_id) AS parcel_id, g.requester_sub AS uid
         FROM sculpture_chat_grants g
         LEFT JOIN sculptures s ON s.id = g.sculpture_id
         WHERE g.status = 'granted'
           AND (g.sculpture_id IN (${placeholders}) OR s.parcel_id IN (${placeholders}))`,
        [...cleanIds, ...cleanIds]
      )
      .catch(() => []),
    db
      .all(
        `SELECT COALESCE(s.parcel_id, m.sculpture_id) AS parcel_id, m.sender_sub AS uid
         FROM sculpture_chat_messages m
         LEFT JOIN sculptures s ON s.id = m.sculpture_id
         WHERE m.sculpture_id IN (${placeholders}) OR s.parcel_id IN (${placeholders})`,
        [...cleanIds, ...cleanIds]
      )
      .catch(() => []),
    db
      .all(
        `SELECT parcel_id, user_id AS uid
         FROM parcel_presence_challenges
         WHERE consumed = 1 AND parcel_id IN (${placeholders})`,
        cleanIds
      )
      .catch(() => [])
  ]);

  const allUserIds = new Set();
  for (const r of [...(grantRows || []), ...(msgRows || []), ...(presenceRows || [])]) {
    if (r?.parcel_id && r?.uid && r.uid !== ownerSub) {
      addPair(r.parcel_id, r.uid);
      if (pairs.has(normalizeParcelId(r.parcel_id))) allUserIds.add(r.uid);
    }
  }
  if (allUserIds.size === 0) return out;

  const uidList = [...allUserIds];
  const userRows = await db
    .all(
      `SELECT id AS userId, email, username, avatar_image AS avatarImage,
              user_number AS userNumber, wallet_address AS walletAddress,
              custom_payout_address AS customPayoutAddress, created_at
       FROM users
       WHERE id IN (${uidList.map(() => '?').join(', ')})
       ORDER BY username ASC, created_at ASC`,
      uidList
    )
    .catch(() => []);

  const formattedUsers = (userRows || []).map((r) => {
    const username = String(r.username || '').trim();
    return {
      userId: r.userId,
      email: r.email || '',
      username,
      avatarImage: resolveSafeUserAvatar(r.avatarImage || ''),
      name: resolvePublicUserHandle(
        { id: r.userId, username, userNumber: r.userNumber },
        { fallback: 'Visitor', includeAt: true }
      ),
      walletAddress: r.customPayoutAddress || r.walletAddress || ''
    };
  });

  for (const pid of cleanIds) {
    const allowedSet = pairs.get(pid);
    if (!allowedSet || allowedSet.size === 0) continue;
    out.set(
      pid,
      formattedUsers.filter((u) => allowedSet.has(u.userId))
    );
  }
  return out;
}

export async function listOwnerLandsAndSculptures(db, ownerUser) {
  await reapAndArchiveExpiredLands(db).catch(() => {});
  const wallets = new Set(resolveUserWalletAddresses(ownerUser));
  const ownerId = ownerUser?.id ? String(ownerUser.id) : '';
  const allRows = await db.all(
    `SELECT s.*,
      COALESCE(pc.custom_name, '') AS parcel_custom_name,
      m.model_format AS custom_model_format,
      m.mime_type AS custom_model_mime,
      m.source_type AS custom_model_source_type,
      m.model_url AS custom_model_url,
      m.model_cid AS custom_model_cid,
      m.model_uri AS custom_model_uri,
      m.scale AS custom_model_scale,
      m.rotation_y AS custom_model_rotation_y,
      m.byte_length AS custom_model_bytes,
      a.dx AS anchor_dx,
      a.dy AS anchor_dy,
      a.dz AS anchor_dz,
      a.yaw AS anchor_yaw,
      a.current_rev AS current_rev,
      a.last_erc4906_tx_hash AS last_erc4906_tx_hash,
      a.mesh_stats_json AS mesh_stats_json,
      COALESCE(l.layer_role, 'artist_work') AS layer_role,
      COALESCE(l.quest_id, '') AS layer_quest_id,
      COALESCE(l.plinth_slot_id, '') AS layer_plinth_slot_id,
      COALESCE(l.qual_contributor, 1) AS qual_contributor,
      COALESCE(cu.username, '') AS creator_username,
      COALESCE(cu.avatar_image, '') AS creator_avatar,
      COALESCE(cu.user_number, 0) AS creator_user_number
     FROM sculptures s
     LEFT JOIN parcel_curations pc ON pc.parcel_id = s.parcel_id
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     LEFT JOIN users cu ON cu.id = s.creator_sub
     ORDER BY s.created_at DESC`
  );
  const ownedSculptures = (allRows || []).filter(
    (r) => !r.hidden && wallets.has(String(r.recipient_address || '').toLowerCase())
  );
  const ownedParcelSet = new Set(ownedSculptures.map((s) => s.parcel_id));

  // Include minted 3D parcels & stewarded parcels even before any sculpture is placed on them
  const lpRows = await db.all('SELECT * FROM land_parcels').catch(() => []);
  const lpMap = new Map((lpRows || []).map((r) => [r.parcel_id, r]));
  for (const lp of lpRows || []) {
    if (
      (ownerId && lp.first_claimant_sub === ownerId) ||
      wallets.has(String(lp.first_claimant_address || '').toLowerCase()) ||
      wallets.has(String(lp.latest_claimant_address || '').toLowerCase())
    ) {
      ownedParcelSet.add(lp.parcel_id);
    }
  }
  const stewardRows = await db.all('SELECT * FROM land_steward_state').catch(() => []);
  const stewardMap = new Map((stewardRows || []).map((st) => [st.parcel_id, st]));
  for (const st of stewardRows || []) {
    if (st.status === 'archived' || st.status === 'expired') continue;
    if (
      (ownerId && st.steward_sub === ownerId) ||
      wallets.has(String(st.steward_address || '').toLowerCase())
    ) {
      ownedParcelSet.add(st.parcel_id);
    }
  }

  const curations = await db.all('SELECT * FROM parcel_curations');
  const curationMap = new Map((curations || []).map((c) => [c.parcel_id, c]));
  const volumeRows = await db.all('SELECT * FROM land_volumes').catch(() => []);
  const volumeMap = new Map((volumeRows || []).map((v) => [v.parcel_id, v]));
  const viewCountsMap = await getLandViewCountsMap(db);

  // Bulk-load per-parcel metadata once to eliminate 5*N queries inside the owned-parcel loop
  const ownedParcelIds = [...ownedParcelSet];
  const ownedPlaceholders = ownedParcelIds.map(() => '?').join(', ');
  const [
    settingsRows,
    allContribRows,
    allSecPolicyRows,
    allLandmarkRows,
    eligibleVisitorsMap
  ] =
    ownedParcelIds.length > 0
      ? await Promise.all([
          db
            .all(
              `SELECT * FROM land_settings WHERE parcel_id IN (${ownedPlaceholders})`,
              ownedParcelIds
            )
            .catch(() => []),
          db
            .all(
              `SELECT lc.*, COALESCE(u.username, '') AS contributor_username, COALESCE(u.avatar_image, '') AS contributor_avatar
               FROM land_contributors lc
               LEFT JOIN users u ON u.id = lc.contributor_sub
               WHERE lc.parcel_id IN (${ownedPlaceholders})
               ORDER BY lc.created_at DESC`,
              ownedParcelIds
            )
            .catch(() => []),
          db
            .all(
              `SELECT * FROM land_security_policies WHERE parcel_id IN (${ownedPlaceholders})`,
              ownedParcelIds
            )
            .catch(() => []),
          db
            .all(
              `SELECT parcel_id, descriptor_digest, keyframe_count, feature_count, anchor_cid, updated_at
               FROM parcel_landmark_anchors
               WHERE parcel_id IN (${ownedPlaceholders})`,
              ownedParcelIds
            )
            .catch(() => []),
          findEligibleParcelVisitorsMap(db, {
            parcelIds: ownedParcelIds,
            ownerSub: ownerUser.id
          })
        ])
      : [[], [], [], [], new Map()];

  const settingsByParcel = new Map((settingsRows || []).map((r) => [r.parcel_id, r]));
  const contribsByParcel = new Map();
  for (const r of allContribRows || []) {
    if (!r?.parcel_id) continue;
    let bucket = contribsByParcel.get(r.parcel_id);
    if (!bucket) {
      bucket = [];
      contribsByParcel.set(r.parcel_id, bucket);
    }
    bucket.push(r);
  }
  const secPolicyByParcel = new Map((allSecPolicyRows || []).map((r) => [r.parcel_id, r]));
  const landmarkByParcel = new Map((allLandmarkRows || []).map((r) => [r.parcel_id, r]));

  const sculpturesByParcel = new Map();
  for (const s of allRows || []) {
    if (!s?.parcel_id) continue;
    let bucket = sculpturesByParcel.get(s.parcel_id);
    if (!bucket) {
      bucket = [];
      sculpturesByParcel.set(s.parcel_id, bucket);
    }
    bucket.push(s);
  }

  const parcels = [];
  for (const pid of ownedParcelIds) {
    const onLand = sculpturesByParcel.get(pid) || [];
    const lp = lpMap.get(pid);
    const st = stewardMap.get(pid);
    const cur = curationMap.get(pid);
    const sRow = settingsByParcel.get(pid);
    const settings = {
      parcelId: normalizeParcelId(pid),
      allowAgentErase: sRow ? Boolean(sRow.allow_agent_erase) : true,
      allowContributorEdits: sRow ? Boolean(sRow.allow_contributor_edits) : true,
      frozen: sRow ? Boolean(sRow.freeze_placements) : false,
      updatedAt: sRow?.updated_at || ''
    };
    const contribRows = contribsByParcel.get(pid) || [];
    const eligibleVisitors = eligibleVisitorsMap.get(normalizeParcelId(pid)) || [];
    const spRow = secPolicyByParcel.get(pid);
    const securityPolicy = {
      parcelId: normalizeParcelId(pid),
      requirePasskeyUnlock: Boolean(spRow?.require_passkey_unlock),
      requireOrbUnlock: Boolean(spRow?.require_orb_unlock),
      minOrbInliers: Number(spRow?.min_orb_inliers || DEFAULT_MIN_ORB_INLIERS),
      maxReprojErrPx: Number(spRow?.max_reproj_err_px || DEFAULT_MAX_ORB_REPROJ_PX),
      updatedAt: spRow?.updated_at || ''
    };
    const landmarkAnchor = landmarkByParcel.get(pid) || null;
    const geohash = onLand[0]?.geohash || lp?.geohash || pid.replace(/^GLAND-/, '').toLowerCase();
    const bounds = geohash ? decodeGeohashBounds(geohash) : null;
    const vr = volumeMap.get(pid);
    let parsedCorners = [];
    if (vr?.corners_json) {
      try {
        parsedCorners = JSON.parse(vr.corners_json);
      } catch {
        parsedCorners = [];
      }
    }
    const fallbackFootprint = vr
      ? computeOrientedFootprintLngLat({
          lat: Number(vr.center_lat),
          lng: Number(vr.center_lng),
          widthMeters: Number(vr.width_meters),
          depthMeters: Number(vr.depth_meters),
          rotationDeg: Number(vr.rotation_deg)
        })
      : null;
    const resolvedCorners =
      parsedCorners.length >= 4 ? parsedCorners.slice(0, 4) : fallbackFootprint?.corners || [];
    const visibleOnLand = onLand.filter((r) => !r.hidden);
    const fittedOwnerFallback =
      !vr && visibleOnLand.length > 0
        ? buildMultiObjectFittedLandVolume({
            parcelId: pid,
            geohash,
            sculptures: visibleOnLand,
            paddingFraction: 0.1
          })
        : null;
    const rawOwnerVolume = vr
      ? {
          parcelId: pid,
          geohash,
          centerLat: Number(vr.center_lat),
          centerLng: Number(vr.center_lng),
          widthMeters: Number(vr.width_meters),
          depthMeters: Number(vr.depth_meters),
          heightMeters: Number(vr.height_meters),
          zScale: Number(vr.z_scale),
          rotationDeg: Number(vr.rotation_deg),
          baseAltitudeM: Number(vr.base_altitude_m || 0),
          footprintAreaSqM: Number(vr.footprint_area_sqm),
          volumeCubicM: Number(vr.volume_cubic_m),
          corners: resolvedCorners,
          ring:
            resolvedCorners.length >= 4
              ? [...resolvedCorners, resolvedCorners[0]]
              : fallbackFootprint?.ring || []
        }
      : fittedOwnerFallback || (bounds ? buildDefaultVolumeFromBounds(bounds, pid, geohash) : null);

    const volume =
      rawOwnerVolume && visibleOnLand.length > 0
        ? ensureLandVolumeFitsSculptures(rawOwnerVolume, visibleOnLand, { paddingFraction: 0.1 })
        : rawOwnerVolume;

    const visibleCount = visibleOnLand.length;
    parcels.push({
      parcelId: pid,
      geohash,
      bounds,
      volume,
      centerLat: volume?.centerLat ?? bounds?.center?.[0] ?? null,
      centerLng: volume?.centerLng ?? bounds?.center?.[1] ?? null,
      stewardStatus: st?.status || 'awakened',
      leaseExpiresAt: st?.lease_expires_at || '',
      inactivityExpiresAt: st?.inactivity_expires_at || '',
      lastHumanInteractionAt: st?.last_human_interaction_at || '',
      lastHumanInteractionType: st?.last_human_interaction_type || '',
      hadHumanInteraction: Number(st?.had_human_interaction || 0) === 1,
      awakenedAt: st?.awakened_at || '',
      customName: cur?.custom_name || '',
      displayName: resolveLandDisplayName({
        customName: cur?.custom_name || '',
        firstSculptureTitle: visibleOnLand[0]?.title || onLand[0]?.title || '',
        placeName: visibleOnLand[0]?.place_name || onLand[0]?.place_name || ''
      }),
      description: cur?.curation_note || '',
      curationNote: cur?.curation_note || '',
      slug: slugifyLandTitle(cur?.custom_name || '') || pid.toLowerCase(),
      shareUrl: buildParcelShareUrl({ parcelId: pid, customName: cur?.custom_name || '', compact: true }),
      featuredSculptureId: cur?.featured_sculpture_id || '',
      lastSignedTxHash: cur?.last_signed_tx_hash || '',
      frozen: Boolean(settings.frozen),
      settings,
      securityPolicy,
      landmarkAnchor: landmarkAnchor
        ? {
            hasLandmark: true,
            keyframeCount: Number(landmarkAnchor.keyframe_count || 0),
            featureCount: Number(landmarkAnchor.feature_count || 0),
            descriptorDigest: landmarkAnchor.descriptor_digest,
            anchorCid: landmarkAnchor.anchor_cid || '',
            updatedAt: landmarkAnchor.updated_at
          }
        : { hasLandmark: false, keyframeCount: 0, featureCount: 0 },
      contributors: (contribRows || []).map(formatContributorRow),
      eligibleVisitors,
      sculptureCount: visibleCount,
      hiddenSculptureCount: onLand.length - visibleCount,
      pageViews: viewCountsMap.get(pid)?.pageViews || 0,
      inPersonViews: viewCountsMap.get(pid)?.inPersonViews || 0,
      createdAt: onLand[onLand.length - 1]?.created_at || st?.created_at || lp?.updated_at || '',
      sculptures: onLand.map((r) =>
        serializeSculptureRow(r, {
          includeVoxels: true,
          viewerIsLandOwner: true,
          parcelFrozen: settings.frozen
        })
      )
    });
  }

  return {
    ownerAddress: resolvePreferredOwnerWallet(ownerUser),
    parcelCount: parcels.length,
    sculptureCount: ownedSculptures.length,
    parcels
  };
}

export async function preflightUpdateSculpture(db, { sculptureRow, payload }) {
  const existingAnchor = await db.get(
    'SELECT * FROM sculpture_anchors WHERE sculpture_id = ?',
    [sculptureRow.id]
  );
  const currentRev = Number(existingAnchor?.current_rev || 1);
  if (payload.expectedRev !== undefined && payload.expectedRev !== null) {
    const exp = Number(payload.expectedRev);
    if (Number.isFinite(exp) && exp !== currentRev) {
      throw new McpServiceError(
        `Revision conflict: sculpture is already at v${currentRev} (you edited from v${exp}). Refresh revisions before saving.`,
        409,
        { currentRev, expectedRev: exp }
      );
    }
  }

  const existingMeshStats = (() => {
    try {
      const parsed = JSON.parse(existingAnchor?.mesh_stats_json || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  })();

  const existingModelForScale = await db.get(
    'SELECT scale FROM sculpture_models WHERE sculpture_id = ?',
    [sculptureRow.id]
  );

  // Load parcel 3D volume so anchorOffset validation and collision-push math respect real land bounds
  let parcelVolume = null;
  if (sculptureRow.parcel_id) {
    const vr = await db
      .get('SELECT * FROM land_volumes WHERE parcel_id = ?', [sculptureRow.parcel_id])
      .catch(() => null);
    if (vr) {
      parcelVolume = {
        parcelId: sculptureRow.parcel_id,
        geohash: sculptureRow.geohash || '',
        centerLat: Number(vr.center_lat),
        centerLng: Number(vr.center_lng),
        widthMeters: Number(vr.width_meters),
        depthMeters: Number(vr.depth_meters),
        heightMeters: Number(vr.height_meters),
        rotationDeg: Number(vr.rotation_deg || 0),
        baseAltitudeM: Number(vr.base_altitude_m || 0)
      };
    } else {
      parcelVolume = resolveParcelVolumeForPlacement({
        sculpture: {
          parcelId: sculptureRow.parcel_id,
          geohash: sculptureRow.geohash,
          lat: sculptureRow.lat,
          lng: sculptureRow.lng
        }
      });
    }
  }

  let anchorOffset = {
    dx: Number(existingAnchor?.dx || 0),
    dy: Number(existingAnchor?.dy || 0),
    dz: Number(existingAnchor?.dz || 0),
    yaw: Number(existingAnchor?.yaw || 0),
    pitch: tiltToDegrees(existingMeshStats?.transformPitch || 0),
    roll: tiltToDegrees(existingMeshStats?.transformRoll || 0)
  };
  let targetScale = extractSculptureScale({
    meshStats: existingMeshStats,
    customModel: existingModelForScale ? { scale: existingModelForScale.scale } : null
  });
  const requestedBaseDims = normalizeBaseDimensions(payload.baseDimensions);

  const rawRequestedScale =
    payload.scale !== undefined
      ? payload.scale
      : payload.anchorOffset?.scale !== undefined
      ? payload.anchorOffset.scale
      : payload.modelScale !== undefined
      ? payload.modelScale
      : undefined;

  if (payload.anchorOffset !== undefined) {
    const offRes = validateAnchorOffset(
      {
        ...payload.anchorOffset,
        ...(rawRequestedScale !== undefined ? { scale: rawRequestedScale } : {})
      },
      { parcelVolume }
    );
    if (offRes.error) throw new McpServiceError(offRes.error, 400);
    anchorOffset = {
      dx: offRes.offset.dx,
      dy: offRes.offset.dy,
      dz: offRes.offset.dz,
      yaw: offRes.offset.yaw,
      pitch: offRes.offset.pitch !== undefined ? offRes.offset.pitch : anchorOffset.pitch,
      roll: offRes.offset.roll !== undefined ? offRes.offset.roll : anchorOffset.roll
    };
    if (offRes.offset.scale !== undefined) {
      targetScale = offRes.offset.scale;
    }
  } else if (rawRequestedScale !== undefined) {
    const offRes = validateAnchorOffset(
      { ...anchorOffset, scale: rawRequestedScale },
      { parcelVolume }
    );
    if (offRes.error) throw new McpServiceError(offRes.error, 400);
    targetScale = offRes.offset.scale;
  }

  const transformProvided =
    payload.anchorOffset !== undefined ||
    rawRequestedScale !== undefined ||
    Boolean(requestedBaseDims);

  const nextTitle = payload.title !== undefined ? payload.title : sculptureRow.title;
  const nextDescription =
    payload.description !== undefined ? payload.description : sculptureRow.description;
  const { title, description } = validateEditableTitleAndDescription({
    title: nextTitle,
    description: nextDescription
  });

  const modelExtract = extractCustomModelInput(payload);
  if (modelExtract.error) {
    throw new McpServiceError(modelExtract.error, 400);
  }

  let cleanVoxels = JSON.parse(sculptureRow.voxels_json || '[]');
  let activeCustomModel = null;
  let existingModelSnapshot = null;
  let shouldClearExistingModel = false;

  if (modelExtract.provided) {
    activeCustomModel = await resolveCustomModelBytes(modelExtract.customModel);
    cleanVoxels = [];
  } else if (payload.voxels !== undefined) {
    const voxelCheck = sanitizeVoxels(payload.voxels);
    if (voxelCheck.errors.length > 0) {
      throw new McpServiceError(voxelCheck.errors[0], 400, { errors: voxelCheck.errors });
    }
    cleanVoxels = voxelCheck.cleanVoxels;
    shouldClearExistingModel = true;
  } else {
    const existingModelRow = await db.get(
      'SELECT * FROM sculpture_models WHERE sculpture_id = ?',
      [sculptureRow.id]
    );
    if (existingModelRow) {
      existingModelSnapshot = existingModelRow;
      activeCustomModel = {
        format: existingModelRow.model_format,
        mimeType: existingModelRow.mime_type,
        ext: existingModelRow.model_format,
        bytes: existingModelRow.inline_b64 ? b64ToModelBytes(existingModelRow.inline_b64) : null,
        byteLength: Number(existingModelRow.byte_length || 0),
        externalUrl: existingModelRow.model_url || '',
        scale: targetScale,
        rotationY: Number(existingModelRow.rotation_y || 0)
      };
    }
  }

  if (modelExtract.provided && activeCustomModel && !activeCustomModel.stats?.bbox) {
    throw new McpServiceError(
      'Could not measure 3D model bounding box dimensions — ensure POSITION bounds or valid vertices are present so land-boundary fit can be verified.',
      400
    );
  }

  if (activeCustomModel && rawRequestedScale !== undefined) {
    activeCustomModel.scale = targetScale;
  }

  // Enforce land bounds + non-intersecting collision-push against other placed artworks on this parcel
  let pushedSiblings = [];
  let resolvedPlacement = null;
  if (
    (transformProvided || modelExtract.provided || payload.voxels !== undefined) &&
    sculptureRow.parcel_id &&
    parcelVolume
  ) {
    const siblingRows = await db
      .all(
        `SELECT s.id, s.title, s.lat, s.lng, s.voxels_json, s.voxel_count,
          m.model_format AS custom_model_format, m.scale AS custom_model_scale,
          a.dx AS anchor_dx, a.dy AS anchor_dy, a.dz AS anchor_dz, a.yaw AS anchor_yaw,
          a.mesh_stats_json AS mesh_stats_json
         FROM sculptures s
         LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
         LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
         WHERE s.parcel_id = ? AND s.hidden = 0`,
        [sculptureRow.parcel_id]
      )
      .catch(() => []);

    const effectiveTargetDims =
      requestedBaseDims ||
      normalizeBaseDimensions(activeCustomModel?.stats?.bbox) ||
      (!modelExtract.provided ? normalizeBaseDimensions(existingMeshStats?.bbox) : null) ||
      null;

    const placementItems = (siblingRows || []).map((row) => {
      const parsedStats = (() => {
        try {
          const p = JSON.parse(row.mesh_stats_json || '{}');
          return p && typeof p === 'object' ? p : {};
        } catch {
          return {};
        }
      })();
      const isTarget = row.id === sculptureRow.id;
      const scObj = {
        id: row.id,
        title: isTarget ? title : row.title,
        lat: row.lat,
        lng: row.lng,
        modelType: (isTarget ? Boolean(activeCustomModel) : Boolean(row.custom_model_format))
          ? 'custom-3d'
          : 'voxel',
        customModel:
          isTarget && activeCustomModel
            ? { format: activeCustomModel.format, scale: targetScale }
            : row.custom_model_format
            ? { format: row.custom_model_format, scale: Number(row.custom_model_scale || 1) }
            : null,
        voxels: isTarget ? cleanVoxels : JSON.parse(row.voxels_json || '[]'),
        voxelCount: isTarget ? cleanVoxels.length : Number(row.voxel_count || 0),
        meshStats: parsedStats,
        anchorOffset: {
          dx: Number(row.anchor_dx || 0),
          dy: Number(row.anchor_dy || 0),
          dz: Number(row.anchor_dz || 0),
          yaw: Number(row.anchor_yaw || 0),
          pitch: tiltToDegrees(parsedStats?.transformPitch || 0),
          roll: tiltToDegrees(parsedStats?.transformRoll || 0)
        }
      };
      return buildPlacementItemFromSculpture(
        scObj,
        parcelVolume,
        isTarget ? effectiveTargetDims : null
      );
    });

    if (!placementItems.some((it) => it.id === sculptureRow.id)) {
      placementItems.push(
        buildPlacementItemFromSculpture(
          {
            id: sculptureRow.id,
            title,
            lat: sculptureRow.lat,
            lng: sculptureRow.lng,
            modelType: activeCustomModel ? 'custom-3d' : 'voxel',
            customModel: activeCustomModel
              ? { format: activeCustomModel.format, scale: targetScale }
              : null,
            voxels: cleanVoxels,
            voxelCount: cleanVoxels.length,
            meshStats: existingMeshStats,
            anchorOffset
          },
          parcelVolume,
          effectiveTargetDims
        )
      );
    }

    if (!activeCustomModel) {
      const targetItem = placementItems.find((it) => it.id === sculptureRow.id);
      const baseW = Number(targetItem?.baseWidth || effectiveTargetDims?.width || 0);
      const baseH = Number(targetItem?.baseHeight || effectiveTargetDims?.height || 0);
      const baseD = Number(targetItem?.baseDepth || effectiveTargetDims?.depth || 0);
      const unitRot = computeRotatedBoxDimensions({
        width: baseW || 0.05,
        height: baseH || 0.05,
        depth: baseD || 0.05,
        yaw: anchorOffset.yaw,
        pitch: anchorOffset.pitch,
        roll: anchorOffset.roll,
        scale: 1
      });
      const scaledW = unitRot.effW * targetScale;
      const scaledD = unitRot.effD * targetScale;
      if (
        scaledW > HUMAN_MAX_DRAW_SPAN_METERS + 1e-3 ||
        scaledD > HUMAN_MAX_DRAW_SPAN_METERS + 1e-3
      ) {
        const effW = Math.max(0.01, unitRot.effW);
        const effD = Math.max(0.01, unitRot.effD);
        const maxHumanScale =
          Math.floor(
            Math.min(HUMAN_MAX_DRAW_SPAN_METERS / effW, HUMAN_MAX_DRAW_SPAN_METERS / effD) * 1000
          ) / 1000;
        throw new McpServiceError(
          `Human voxel sculptures cannot exceed ${HUMAN_MAX_DRAW_SPAN_FEET}ft x ${HUMAN_MAX_DRAW_SPAN_FEET}ft (${HUMAN_MAX_DRAW_SPAN_METERS}m x ${HUMAN_MAX_DRAW_SPAN_METERS}m).`,
          400,
          {
            code: 'HUMAN_DRAW_FOOTPRINT_EXCEEDED',
            maxSafeScale: maxHumanScale,
            suggestedScale: maxHumanScale
          }
        );
      }
    }

    const siblingCount = placementItems.filter((it) => it.id !== sculptureRow.id).length;
    const isMicroSoloAutoParcel =
      siblingCount === 0 &&
      rawRequestedScale === undefined &&
      (Number(parcelVolume.widthMeters || 0) < 3 || Number(parcelVolume.depthMeters || 0) < 3);

    if (!isMicroSoloAutoParcel) {
      const placement = resolveSculpturePlacement({
        parcelVolume,
        targetId: sculptureRow.id,
        targetTransform: {
          dx: anchorOffset.dx,
          dy: anchorOffset.dy,
          dz: anchorOffset.dz,
          yaw: anchorOffset.yaw,
          pitch: anchorOffset.pitch,
          roll: anchorOffset.roll,
          scale: targetScale
        },
        items: placementItems
      });

      if (!placement.ok) {
        const maxSafeScale = computeMaxFeasibleScale({
          parcelVolume,
          targetId: sculptureRow.id,
          targetTransform: {
            dx: anchorOffset.dx,
            dy: anchorOffset.dy,
            dz: anchorOffset.dz,
            yaw: anchorOffset.yaw,
            pitch: anchorOffset.pitch,
            roll: anchorOffset.roll
          },
          items: placementItems
        });
        const targetItem = placementItems.find((it) => it.id === sculptureRow.id);
        const nativeDims = targetItem
          ? {
              width: targetItem.baseWidth,
              height: targetItem.baseHeight,
              depth: targetItem.baseDepth
            }
          : effectiveTargetDims;
        throw new McpServiceError(placement.message, 409, {
          code: placement.reason,
          maxSafeScale,
          suggestedScale: maxSafeScale,
          parcelDimensions: {
            widthMeters: Number(parcelVolume.widthMeters),
            depthMeters: Number(parcelVolume.depthMeters),
            heightMeters: Number(parcelVolume.heightMeters)
          },
          modelNativeDimensions: nativeDims,
          requestedScale: targetScale,
          collidingIds: placement.collidingIds || []
        });
      }

      anchorOffset = {
        dx: placement.target.dx,
        dy: placement.target.dy,
        dz: placement.target.dz,
        yaw: placement.target.yaw,
        pitch: placement.target.pitch,
        roll: placement.target.roll
      };
      targetScale = placement.target.scale;
      if (activeCustomModel) {
        activeCustomModel.scale = targetScale;
      }
      pushedSiblings = placement.pushedSiblings || [];
      resolvedPlacement = placement;
    }
  }

  return {
    existingAnchor,
    currentRev,
    existingMeshStats,
    parcelVolume,
    anchorOffset,
    targetScale,
    rawRequestedScale,
    requestedBaseDims,
    title,
    description,
    modelExtract,
    cleanVoxels,
    activeCustomModel,
    existingModelSnapshot,
    shouldClearExistingModel,
    pushedSiblings,
    resolvedPlacement
  };
}

export async function applyUpdateSculpture(
  db,
  {
    sculptureRow,
    payload,
    pinSculptureFn,
    emitMetadataUpdateFn = null,
    editorUser = null,
    editorRole = 'owner'
  }
) {
  const {
    currentRev,
    existingMeshStats,
    anchorOffset,
    targetScale,
    rawRequestedScale,
    requestedBaseDims,
    title,
    description,
    modelExtract,
    cleanVoxels,
    activeCustomModel,
    existingModelSnapshot,
    shouldClearExistingModel,
    pushedSiblings,
    resolvedPlacement
  } = await preflightUpdateSculpture(db, { sculptureRow, payload });

  if (shouldClearExistingModel) {
    await db.run('DELETE FROM sculpture_models WHERE sculpture_id = ?', [sculptureRow.id]);
  }

  let ipfsMetadataCid = sculptureRow.ipfs_metadata_cid;
  let ipfsModelCid = sculptureRow.ipfs_model_cid;
  let ipfsImageCid = sculptureRow.ipfs_image_cid;
  let ipfsGatewayUrl = sculptureRow.ipfs_gateway_url;
  const nextPreview =
    typeof payload.previewDataUrl === 'string' && payload.previewDataUrl
      ? payload.previewDataUrl.slice(0, 450000)
      : sculptureRow.preview_data_url;

  const canPinModel = !activeCustomModel || Boolean(activeCustomModel.bytes);
  if (typeof pinSculptureFn === 'function' && canPinModel) {
    const existingPol = JSON.parse(sculptureRow.pol_json || '{}');
    const verticalBounds = activeCustomModel
      ? { minY: 0, maxY: 1.5 }
      : computeVerticalBounds(cleanVoxels);
    const locationBundle = {
      lat: sculptureRow.lat,
      lng: sculptureRow.lng,
      altitude: sculptureRow.altitude,
      accuracy: sculptureRow.accuracy,
      heading: sculptureRow.heading,
      timezone: sculptureRow.timezone,
      geohash: sculptureRow.geohash,
      parcelId: sculptureRow.parcel_id,
      parcelBounds: decodeGeohashBounds(sculptureRow.geohash),
      geoInfo: existingPol.location?.geo || {
        city: sculptureRow.place_name || '',
        country: sculptureRow.country || '',
        displayName: sculptureRow.place_name || sculptureRow.parcel_id
      },
      solar: existingPol.solar || { regime: 'daylight', solarAltitudeDeg: null, solarAzimuthDeg: null },
      elevation: {
        ...(existingPol.elevation || {}),
        sculptureVerticalMinM: verticalBounds.minY,
        sculptureVerticalMaxM: verticalBounds.maxY
      },
      score: sculptureRow.pol_score,
      proofBundle: existingPol,
      proofHash: sculptureRow.proof_hash
    };
    const ipfsRes = await pinSculptureFn({
      sculptureId: sculptureRow.id,
      title,
      description,
      voxels: cleanVoxels,
      customModel: activeCustomModel,
      previewDataUrl: nextPreview,
      locationBundle,
      creatorAddress: sculptureRow.recipient_address
    });
    ipfsMetadataCid = ipfsRes.metadataCid;
    ipfsModelCid = ipfsRes.modelCid;
    ipfsImageCid = ipfsRes.imageCid;
    ipfsGatewayUrl = ipfsRes.gatewayUrl;
    if (activeCustomModel) {
      await upsertSculptureModelRow(db, {
        sculptureId: sculptureRow.id,
        parcelId: sculptureRow.parcel_id,
        customModel: activeCustomModel,
        ipfsResult: ipfsRes
      });
    }
  } else if (activeCustomModel && modelExtract.provided) {
    await upsertSculptureModelRow(db, {
      sculptureId: sculptureRow.id,
      parcelId: sculptureRow.parcel_id,
      customModel: activeCustomModel,
      ipfsResult: null
    });
  } else if (activeCustomModel && rawRequestedScale !== undefined) {
    // Persist custom-3D scale even when raw model bytes live in IPFS/KV rather than inline_b64
    await db.run(
      'UPDATE sculpture_models SET scale = ?, updated_at = ? WHERE sculpture_id = ?',
      [targetScale, new Date().toISOString(), sculptureRow.id]
    );
  }

  await db.run(
    `UPDATE sculptures
     SET title = ?, description = ?, voxels_json = ?, voxel_count = ?,
         preview_data_url = ?, ipfs_metadata_cid = ?, ipfs_model_cid = ?,
         ipfs_image_cid = ?, ipfs_gateway_url = ?
     WHERE id = ?`,
    [
      title,
      description,
      JSON.stringify(cleanVoxels),
      cleanVoxels.length,
      nextPreview,
      ipfsMetadataCid,
      ipfsModelCid,
      ipfsImageCid,
      ipfsGatewayUrl,
      sculptureRow.id
    ]
  );

  const revCountRow = await db.get(
    'SELECT MAX(rev_num) AS maxRev FROM sculpture_revisions WHERE sculpture_id = ?',
    [sculptureRow.id]
  );
  const highestExistingRev = Number(revCountRow?.maxRev || 0);
  if (highestExistingRev === 0) {
    await upsertAnchorAndRevision(db, {
      sculptureId: sculptureRow.id,
      parcelId: sculptureRow.parcel_id,
      revNum: 1,
      anchorOffset,
      editorUser: { id: sculptureRow.creator_sub, name: sculptureRow.creator_name },
      editorRole: 'owner',
      modelType: existingModelSnapshot ? 'custom-3d' : 'voxel',
      voxels: JSON.parse(sculptureRow.voxels_json || '[]'),
      title: sculptureRow.title,
      description: sculptureRow.description,
      ipfsMetadataCid: sculptureRow.ipfs_metadata_cid,
      ipfsModelCid: sculptureRow.ipfs_model_cid,
      ipfsImageCid: sculptureRow.ipfs_image_cid,
      changeSummary: 'Initial publish baseline'
    });
  }

  const nextRev = Math.max(currentRev, highestExistingRev, 1) + 1;
  let erc4906TxHash = '';
  if (typeof emitMetadataUpdateFn === 'function') {
    try {
      const updRes = await emitMetadataUpdateFn({
        tokenId: sculptureRow.token_id,
        metadataUri: `ipfs://${ipfsMetadataCid}`
      });
      erc4906TxHash = updRes?.txHash || '';
    } catch {}
  }

  const savedCustomModelRow = activeCustomModel
    ? await db.get('SELECT * FROM sculpture_models WHERE sculpture_id = ?', [sculptureRow.id])
    : null;
  const customSnap = savedCustomModelRow
    ? {
        format: savedCustomModelRow.model_format,
        mimeType: savedCustomModelRow.mime_type,
        sourceType: savedCustomModelRow.source_type,
        modelUrl: savedCustomModelRow.model_url,
        modelCid: savedCustomModelRow.model_cid,
        modelUri: savedCustomModelRow.model_uri,
        inlineB64: savedCustomModelRow.inline_b64 || '',
        byteLength: savedCustomModelRow.byte_length,
        scale: savedCustomModelRow.scale,
        rotationY: savedCustomModelRow.rotation_y
      }
    : null;

  const mergedMeshStats = {
    ...existingMeshStats,
    ...(activeCustomModel?.stats || {}),
    ...(requestedBaseDims ? { bbox: requestedBaseDims } : {}),
    transformScale: targetScale,
    transformPitch: tiltToDegrees(anchorOffset.pitch || 0),
    transformRoll: tiltToDegrees(anchorOffset.roll || 0)
  };

  await upsertAnchorAndRevision(db, {
    sculptureId: sculptureRow.id,
    parcelId: sculptureRow.parcel_id,
    revNum: nextRev,
    anchorOffset: { ...anchorOffset, scale: targetScale },
    erc4906TxHash,
    meshStats: mergedMeshStats,
    editorUser: editorUser || { id: sculptureRow.creator_sub, name: sculptureRow.creator_name },
    editorRole,
    modelType: activeCustomModel ? 'custom-3d' : 'voxel',
    voxels: cleanVoxels,
    title,
    description,
    ipfsMetadataCid,
    ipfsModelCid,
    ipfsImageCid,
    changeSummary:
      String(payload.changeSummary || '').trim() ||
      (activeCustomModel ? `Updated 3D model (${activeCustomModel.format})` : 'Updated sculpture'),
    customModelSnapshot: customSnap
  });

  // Atomically persist any neighboring artworks that were gently pushed within the land bounds
  if (pushedSiblings.length > 0) {
    const pushNow = new Date().toISOString();
    for (const sib of pushedSiblings) {
      await db.run(
        `INSERT INTO sculpture_anchors (
          sculpture_id, parcel_id, dx, dy, dz, yaw, current_rev, last_erc4906_tx_hash, mesh_stats_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, '', '{}', ?)
        ON CONFLICT(sculpture_id) DO UPDATE SET
          dx = excluded.dx,
          dy = excluded.dy,
          dz = excluded.dz,
          updated_at = excluded.updated_at`,
        [
          sib.id,
          sculptureRow.parcel_id,
          Number(sib.dx || 0),
          Number(sib.dy || 0),
          Number(sib.dz || 0),
          Number(sib.yaw || 0),
          pushNow
        ]
      );
    }
  }

  const updated = await fetchSculptureWithModelRow(db, sculptureRow.id);
  return {
    sculpture: serializeSculptureRow(updated, { includeVoxels: true }),
    revNum: nextRev,
    erc4906TxHash,
    pushedSiblings,
    ...(resolvedPlacement ? { placement: resolvedPlacement } : {})
  };
}

export async function preflightCreateSculptureOnLand(db, { parcelCtx, payload }) {
  const landSettings = await getLandSettingsInternal(db, parcelCtx.parcelId);
  if (landSettings.frozen) {
    const landLabel = await getLatestParcelDisplayName(db, parcelCtx.parcelId);
    throw new McpServiceError(
      `Virtual Land "${landLabel}" is frozen — no new sculptures can be placed until you unfreeze it in Land Settings.`,
      403
    );
  }
  const modelExtract = extractCustomModelInput(payload);
  if (modelExtract.error) {
    throw new McpServiceError(modelExtract.error, 400);
  }

  let title = '';
  let description = '';
  let cleanVoxels = [];
  let activeCustomModel = null;
  let anchorOffset = { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 };

  const { parcelVolume, existingItems } = await loadParcelVolumeAndSiblings(db, {
    parcelId: parcelCtx.parcelId,
    geohash: parcelCtx.geohash,
    bounds: parcelCtx.bounds
  });

  if (payload.anchorOffset !== undefined) {
    const offRes = validateAnchorOffset(payload.anchorOffset, { parcelVolume });
    if (offRes.error) throw new McpServiceError(offRes.error, 400);
    anchorOffset = {
      dx: offRes.offset.dx,
      dy: offRes.offset.dy,
      dz: offRes.offset.dz,
      yaw: offRes.offset.yaw,
      pitch: offRes.offset.pitch ?? 0,
      roll: offRes.offset.roll ?? 0,
      ...(offRes.offset.scale !== undefined ? { scale: offRes.offset.scale } : {})
    };
  }

  if (modelExtract.provided) {
    const checkedMeta = validateEditableTitleAndDescription({
      title: payload.title,
      description: payload.description
    });
    title = checkedMeta.title;
    description = checkedMeta.description;
    activeCustomModel = await resolveCustomModelBytes(modelExtract.customModel);
    if (!activeCustomModel?.stats?.bbox) {
      throw new McpServiceError(
        'Could not measure 3D model bounding box dimensions — ensure POSITION bounds or valid vertices are present so land-boundary fit can be verified.',
        400
      );
    }
  } else {
    const validation = validatePublishPayload({
      title: payload.title,
      description: payload.description,
      termsAccepted: true,
      voxels: payload.voxels
    });
    if (!validation.ok) {
      throw new McpServiceError(validation.errors[0], 400, { errors: validation.errors });
    }
    title = validation.title;
    description = validation.description;
    cleanVoxels = validation.cleanVoxels;
  }

  const defaultLat =
    Number.isFinite(Number(parcelVolume?.centerLat)) &&
    encodeGeohash(Number(parcelVolume.centerLat), Number(parcelVolume.centerLng), 8).toUpperCase() ===
      parcelCtx.geohash.toUpperCase()
      ? Number(parcelVolume.centerLat)
      : parcelCtx.bounds.center[0];
  const defaultLng =
    Number.isFinite(Number(parcelVolume?.centerLng)) &&
    encodeGeohash(Number(parcelVolume.centerLat), Number(parcelVolume.centerLng), 8).toUpperCase() ===
      parcelCtx.geohash.toUpperCase()
      ? Number(parcelVolume.centerLng)
      : parcelCtx.bounds.center[1];

  const hasPayloadLat = payload.lat !== undefined && payload.lat !== null && payload.lat !== '';
  const hasPayloadLng = payload.lng !== undefined && payload.lng !== null && payload.lng !== '';
  const lat =
    hasPayloadLat && Number.isFinite(Number(payload.lat)) && Math.abs(Number(payload.lat)) <= 90
      ? Number(payload.lat)
      : defaultLat;
  const lng =
    hasPayloadLng && Number.isFinite(Number(payload.lng)) && Math.abs(Number(payload.lng)) <= 180
      ? Number(payload.lng)
      : defaultLng;

  const coordHash = encodeGeohash(lat, lng, 8);
  if (coordHash.toUpperCase() !== parcelCtx.geohash.toUpperCase()) {
    throw new McpServiceError(
      `Coordinates (${lat}, ${lng}) lie outside owned parcel ${parcelCtx.parcelId}.`,
      400
    );
  }

  const sculptureId = globalThis.crypto.randomUUID();

  // Strict land-boundary & non-overlap guardrail BEFORE IPFS pin, chain mint, or DB write
  let targetScale = extractSculptureScale({
    scale:
      payload.scale !== undefined
        ? payload.scale
        : payload.anchorOffset?.scale !== undefined
        ? payload.anchorOffset.scale
        : payload.modelScale !== undefined
        ? payload.modelScale
        : activeCustomModel?.scale ?? 1
  });
  if (activeCustomModel) {
    activeCustomModel.scale = targetScale;
  }

  const candidateNativeDims = activeCustomModel
    ? normalizeBaseDimensions(activeCustomModel.stats?.bbox)
    : extractSculptureBaseDimensions({ voxels: cleanVoxels });

  const candidateItem = buildPlacementItemFromSculpture(
    {
      id: sculptureId,
      title,
      lat,
      lng,
      modelType: activeCustomModel ? 'custom-3d' : 'voxel',
      customModel: activeCustomModel
        ? { format: activeCustomModel.format, scale: targetScale }
        : null,
      voxels: cleanVoxels,
      voxelCount: cleanVoxels.length,
      meshStats: activeCustomModel?.stats || {},
      anchorOffset: { ...anchorOffset, scale: targetScale }
    },
    parcelVolume,
    candidateNativeDims
  );

  const placementItems = [...existingItems, candidateItem];
  const placement = resolveSculpturePlacement({
    parcelVolume,
    targetId: sculptureId,
    targetTransform: {
      dx: anchorOffset.dx,
      dy: anchorOffset.dy,
      dz: anchorOffset.dz,
      yaw: anchorOffset.yaw,
      pitch: anchorOffset.pitch || 0,
      roll: anchorOffset.roll || 0,
      scale: targetScale
    },
    items: placementItems
  });

  if (!placement.ok) {
    const maxSafeScale = computeMaxFeasibleScale({
      parcelVolume,
      targetId: sculptureId,
      targetTransform: {
        dx: anchorOffset.dx,
        dy: anchorOffset.dy,
        dz: anchorOffset.dz,
        yaw: anchorOffset.yaw,
        pitch: anchorOffset.pitch || 0,
        roll: anchorOffset.roll || 0
      },
      items: placementItems
    });
    const scaledDims = candidateNativeDims
      ? {
          widthMeters: Math.round(candidateNativeDims.width * targetScale * 1000) / 1000,
          depthMeters: Math.round(candidateNativeDims.depth * targetScale * 1000) / 1000,
          heightMeters: Math.round(candidateNativeDims.height * targetScale * 1000) / 1000
        }
      : null;
    const fitGuidance =
      maxSafeScale >= 0.001
        ? ` Maximum safe scale for this land is ${maxSafeScale}×.`
        : ' Object is too large even at minimum scale (0.001×) — re-export smaller in meters.';
    throw new McpServiceError(`${placement.message}${fitGuidance}`, 409, {
      code: placement.reason,
      maxSafeScale,
      suggestedScale: maxSafeScale,
      parcelDimensions: {
        widthMeters: Number(parcelVolume.widthMeters),
        depthMeters: Number(parcelVolume.depthMeters),
        heightMeters: Number(parcelVolume.heightMeters)
      },
      modelNativeDimensions: candidateNativeDims,
      scaledDimensions: scaledDims,
      requestedScale: targetScale,
      collidingIds: placement.collidingIds || []
    });
  }

  anchorOffset = {
    dx: placement.target.dx,
    dy: placement.target.dy,
    dz: placement.target.dz,
    yaw: placement.target.yaw,
    pitch: placement.target.pitch,
    roll: placement.target.roll,
    scale: placement.target.scale
  };
  targetScale = placement.target.scale;
  if (activeCustomModel) {
    activeCustomModel.scale = targetScale;
  }
  const pushedSiblings = placement.pushedSiblings || [];

  return {
    sculptureId,
    title,
    description,
    cleanVoxels,
    activeCustomModel,
    anchorOffset,
    targetScale,
    candidateNativeDims,
    lat,
    lng,
    parcelVolume,
    placement,
    pushedSiblings
  };
}

export async function applyCreateSculptureOnLand(
  db,
  {
    parcelCtx,
    ownerUser,
    ownerAddress,
    payload,
    pinSculptureFn,
    mintSculptureFn,
    proofSeed = '',
    layerRole = ''
  }
) {
  const {
    sculptureId,
    title,
    description,
    cleanVoxels,
    activeCustomModel,
    anchorOffset,
    targetScale,
    candidateNativeDims,
    lat,
    lng,
    placement,
    pushedSiblings
  } = await preflightCreateSculptureOnLand(db, { parcelCtx, payload });

  const seedSculpture = parcelCtx.visibleRows[0] || null;
  const seedPol = seedSculpture ? JSON.parse(seedSculpture.pol_json || '{}') : {};
  const verticalBounds = activeCustomModel
    ? { minY: 0, maxY: Math.round((candidateNativeDims?.height || 1.4) * targetScale * 1000) / 1000 }
    : computeVerticalBounds(cleanVoxels);
  const alt =
    Number.isFinite(Number(payload.altitude)) ? Number(payload.altitude) : seedSculpture?.altitude ?? null;
  const now = new Date().toISOString();
  const parcelBytes32 = ethers.keccak256(ethers.toUtf8Bytes(parcelCtx.parcelId));
  const proofHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      `land-owner:${parcelCtx.parcelId}:${sculptureId}:${ownerAddress}:${proofSeed}:${now}`
    )
  );

  const locationBundle = {
    lat,
    lng,
    altitude: alt,
    accuracy: seedSculpture?.accuracy ?? 8,
    heading: null,
    timezone: seedSculpture?.timezone || 'UTC',
    geohash: parcelCtx.geohash,
    parcelId: parcelCtx.parcelId,
    parcelBounds: parcelCtx.bounds,
    parcelBytes32,
    geoInfo: seedPol?.location?.geo || {
      city: seedSculpture?.place_name || '',
      country: seedSculpture?.country || '',
      displayName: seedSculpture?.place_name || parcelCtx.parcelId
    },
    solar: seedPol?.solar || { regime: 'daylight', solarAltitudeDeg: null, solarAzimuthDeg: null },
    elevation: {
      deviceAltitudeMeters: alt,
      altitudeAccuracyMeters: null,
      altitudeSource: 'parcel-anchor',
      terrainElevationMeters: null,
      anchorAltitudeMeters: alt,
      heightAboveGroundMeters: null,
      sculptureVerticalMinM: verticalBounds.minY,
      sculptureVerticalMaxM: verticalBounds.maxY
    },
    score: seedSculpture?.pol_score || 95,
    proofBundle: {
      propertyAuthorized: true,
      parcelId: parcelCtx.parcelId,
      ownerAddress,
      ...(activeCustomModel ? { modelFormat: activeCustomModel.format, modelType: 'custom-3d' } : {}),
      sensors: seedPol?.sensors || { opticalFlowCorrelation: 1, horizonLuminance: 128, visualDHash: '' }
    },
    proofHash
  };

  const ipfsResult = await pinSculptureFn({
    sculptureId,
    title,
    description,
    voxels: cleanVoxels,
    customModel: activeCustomModel,
    previewDataUrl: String(payload.previewDataUrl || '').slice(0, 450000),
    locationBundle,
    creatorAddress: ownerAddress
  });

  const isSelfFundedAgent =
    String(ownerUser?.id || '').startsWith('agent:') || ownerUser?.actorType === 'agent';

  const mintResult = await mintSculptureFn({
    recipientAddress: ownerAddress,
    metadataUri: ipfsResult.metadataUri,
    parcelBytes32,
    proofHash,
    lat,
    lng,
    selfPaidGas: isSelfFundedAgent,
    agentTxHash: String(payload?.txHash || '')
  });

  await db.run(
    `INSERT INTO sculptures (
      id, title, description, creator_sub, creator_name, creator_email, recipient_address,
      lat, lng, altitude, accuracy, heading, parcel_id, geohash, place_name, country, timezone,
      voxels_json, voxel_count, pol_score, pol_json, proof_hash, preview_data_url,
      ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url,
      chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain,
      royalty_bps, royalty_receiver, hidden, hidden_reason, hidden_by,
      terms_accepted_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?)`,
    [
      sculptureId,
      title,
      description,
      ownerUser.id,
      resolveAuthorHandleForStorage(ownerUser, 'Creator'),
      ownerUser.email,
      ownerAddress,
      lat,
      lng,
      alt,
      locationBundle.accuracy,
      null,
      parcelCtx.parcelId,
      parcelCtx.geohash,
      locationBundle.geoInfo.displayName || '',
      locationBundle.geoInfo.country || '',
      locationBundle.timezone,
      JSON.stringify(cleanVoxels),
      cleanVoxels.length,
      locationBundle.score,
      JSON.stringify(locationBundle.proofBundle),
      proofHash,
      String(payload.previewDataUrl || '').slice(0, 450000),
      ipfsResult.metadataCid,
      ipfsResult.modelCid,
      ipfsResult.imageCid,
      ipfsResult.gatewayUrl,
      mintResult.chainId,
      mintResult.chainName,
      mintResult.contractAddress,
      mintResult.tokenId,
      mintResult.txHash,
      mintResult.simulated ? 1 : 0,
      mintResult.royaltyBps,
      mintResult.royaltyReceiver,
      POLICY.termsVersion,
      now
    ]
  );

  if (activeCustomModel) {
    await upsertSculptureModelRow(db, {
      sculptureId,
      parcelId: parcelCtx.parcelId,
      customModel: activeCustomModel,
      ipfsResult
    });
  }

  const savedModelRow = activeCustomModel
    ? await db.get('SELECT * FROM sculpture_models WHERE sculpture_id = ?', [sculptureId])
    : null;
  await upsertAnchorAndRevision(db, {
    sculptureId,
    parcelId: parcelCtx.parcelId,
    revNum: 1,
    anchorOffset,
    meshStats: {
      ...(activeCustomModel?.stats || {}),
      transformScale: targetScale,
      transformPitch: tiltToDegrees(anchorOffset.pitch || 0),
      transformRoll: tiltToDegrees(anchorOffset.roll || 0)
    },
    editorUser: ownerUser,
    editorRole: 'mcp-agent',
    modelType: activeCustomModel ? 'custom-3d' : 'voxel',
    voxels: cleanVoxels,
    title,
    description,
    ipfsMetadataCid: ipfsResult.metadataCid,
    ipfsModelCid: ipfsResult.modelCid,
    ipfsImageCid: ipfsResult.imageCid,
    changeSummary: 'Created on owned land',
    customModelSnapshot: savedModelRow
      ? {
          format: savedModelRow.model_format,
          mimeType: savedModelRow.mime_type,
          sourceType: savedModelRow.source_type,
          modelUrl: savedModelRow.model_url,
          modelCid: savedModelRow.model_cid,
          modelUri: savedModelRow.model_uri,
          inlineB64: savedModelRow.inline_b64 || '',
          byteLength: savedModelRow.byte_length,
          scale: savedModelRow.scale,
          rotationY: savedModelRow.rotation_y
        }
      : null
  });

  if (pushedSiblings.length > 0) {
    for (const sib of pushedSiblings) {
      await db.run(
        `INSERT INTO sculpture_anchors (
          sculpture_id, parcel_id, dx, dy, dz, yaw, current_rev, last_erc4906_tx_hash, mesh_stats_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, '', '{}', ?)
        ON CONFLICT(sculpture_id) DO UPDATE SET
          dx = excluded.dx,
          dy = excluded.dy,
          dz = excluded.dz,
          updated_at = excluded.updated_at`,
        [
          sib.id,
          parcelCtx.parcelId,
          Number(sib.dx || 0),
          Number(sib.dy || 0),
          Number(sib.dz || 0),
          Number(sib.yaw || 0),
          now
        ]
      );
    }
  }

  await db.run(
    `UPDATE land_parcels
     SET latest_claimant_address = ?, sculpture_count = sculpture_count + 1, updated_at = ?
     WHERE parcel_id = ?`,
    [ownerAddress, now, parcelCtx.parcelId]
  );

  const effectiveLayerRole =
    layerRole === 'steward_stage' ||
    payload?.layerRole === 'steward_stage' ||
    String(ownerUser?.id || '').startsWith('agent:') ||
    ownerUser?.actorType === 'agent'
      ? 'steward_stage'
      : 'artist_work';
  await db.run(
    `INSERT INTO sculpture_layers (
      sculpture_id, parcel_id, layer_role, quest_id, plinth_slot_id, agent_id, qual_contributor, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sculpture_id) DO UPDATE SET
      layer_role = excluded.layer_role,
      updated_at = excluded.updated_at`,
    [
      sculptureId,
      parcelCtx.parcelId,
      effectiveLayerRole,
      String(payload?.questId || ''),
      String(payload?.plinthSlotId || ''),
      String(ownerUser?.id || '').startsWith('agent:') ? ownerUser.id : '',
      effectiveLayerRole === 'artist_work' && cleanVoxels.length >= 3 ? 1 : 0,
      now,
      now
    ]
  );

  const saved = await fetchSculptureWithModelRow(db, sculptureId);

  try {
    const visibleCntRow = await db
      .get('SELECT COUNT(*) AS cnt FROM sculptures WHERE parcel_id = ? AND hidden = 0', [
        parcelCtx.parcelId
      ])
      .catch(() => null);
    await notifyAfterSculpturePublished(db, {
      parcelId: parcelCtx.parcelId,
      sculptureId,
      sculptureTitle: title,
      creatorSub: ownerUser?.id || '',
      creatorName: resolveAuthorHandleForStorage(ownerUser, 'Creator'),
      awakenedParcel: false,
      wasPreviouslyEmpty: Number(visibleCntRow?.cnt || 0) <= 1
    });
  } catch {
    // Non-fatal notification failure
  }

  return {
    sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
    mint: mintResult,
    ipfs: ipfsResult,
    pushedSiblings,
    placement
  };
}

export async function applySetSculptureVisibility(
  db,
  { sculptureRow, actorAddress, hidden = true, reason = '' }
) {
  const now = new Date().toISOString();
  const hideFlag = hidden ? 1 : 0;
  const cleanReason = hideFlag
    ? String(reason || '').trim().slice(0, 160) || 'Hidden by Virtual Land owner'
    : '';
  await db.run(
    `UPDATE sculptures SET hidden = ?, hidden_reason = ?, hidden_by = ? WHERE id = ?`,
    [hideFlag, cleanReason, hideFlag ? String(actorAddress || '') : '', sculptureRow.id]
  );
  const remaining = await db.get(
    'SELECT COUNT(*) AS cnt FROM sculptures WHERE parcel_id = ? AND hidden = 0',
    [sculptureRow.parcel_id]
  );
  await db.run(
    'UPDATE land_parcels SET sculpture_count = ?, updated_at = ? WHERE parcel_id = ?',
    [Number(remaining?.cnt || 0), now, sculptureRow.parcel_id]
  );
  const refreshed = await fetchSculptureWithModelRow(db, sculptureRow.id);
  const settings = await getLandSettingsInternal(db, sculptureRow.parcel_id);
  return {
    sculpture: serializeSculptureRow(refreshed, {
      includeVoxels: true,
      viewerIsLandOwner: true,
      parcelFrozen: settings.frozen
    }),
    hidden: Boolean(hideFlag),
    parcelId: sculptureRow.parcel_id
  };
}

export async function applyDeleteSculpture(db, { sculptureRow, ownerAddress }) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE sculptures SET hidden = 1, hidden_reason = 'Removed by property owner', hidden_by = ? WHERE id = ?`,
    [ownerAddress, sculptureRow.id]
  );
  const remaining = await db.get(
    'SELECT COUNT(*) AS cnt FROM sculptures WHERE parcel_id = ? AND hidden = 0',
    [sculptureRow.parcel_id]
  );
  await db.run(
    'UPDATE land_parcels SET sculpture_count = ?, updated_at = ? WHERE parcel_id = ?',
    [Number(remaining?.cnt || 0), now, sculptureRow.parcel_id]
  );
  return { deleted: true, sculptureId: sculptureRow.id, parcelId: sculptureRow.parcel_id };
}

export async function applyEraseLand(db, { parcelCtx, ownerAddress, reason = '', viaAgent = false }) {
  const settings = await getLandSettingsInternal(db, parcelCtx.parcelId);
  if (viaAgent && !settings.allowAgentErase) {
    const landLabel = await getLatestParcelDisplayName(db, parcelCtx.parcelId);
    throw new McpServiceError(
      `Agent land erasure is disabled by the holder of Virtual Land "${landLabel}". Enable Allow Agent Erase in Land Management first.`,
      403
    );
  }
  const cleanReason =
    String(reason || '').trim().slice(0, 160) ||
    (viaAgent ? 'Land erased by authorized agent' : 'Land erased by property owner');

  const layerRows = await db.all(
    `SELECT s.id, s.recipient_address, COALESCE(l.layer_role, 'artist_work') AS layer_role
     FROM sculptures s
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     WHERE s.parcel_id = ? AND s.hidden = 0`,
    [parcelCtx.parcelId]
  );
  const erasableIds = (layerRows || [])
    .filter(
      (r) =>
        r.layer_role === 'steward_stage' ||
        String(r.recipient_address || '').toLowerCase() === String(ownerAddress || '').toLowerCase()
    )
    .map((r) => r.id);
  const preservedHumanWorks = (layerRows || []).length - erasableIds.length;

  for (const sid of erasableIds) {
    await db.run(
      `UPDATE sculptures SET hidden = 1, hidden_reason = ?, hidden_by = ? WHERE id = ?`,
      [cleanReason, ownerAddress, sid]
    );
    await db.run('DELETE FROM sculpture_models WHERE sculpture_id = ?', [sid]);
    await db.run('DELETE FROM sculpture_anchors WHERE sculpture_id = ?', [sid]);
  }
  await db.run('DELETE FROM parcel_curations WHERE parcel_id = ?', [parcelCtx.parcelId]);

  if (preservedHumanWorks === 0) {
    await db.run('DELETE FROM land_contributors WHERE parcel_id = ?', [parcelCtx.parcelId]);
    await db.run('DELETE FROM land_settings WHERE parcel_id = ?', [parcelCtx.parcelId]);
    await db.run('DELETE FROM parcel_landmark_anchors WHERE parcel_id = ?', [parcelCtx.parcelId]);
    await db.run('DELETE FROM land_security_policies WHERE parcel_id = ?', [parcelCtx.parcelId]);
    await db.run('DELETE FROM sculpture_pin_batches WHERE parcel_id = ?', [parcelCtx.parcelId]);
    await db.run('DELETE FROM land_volumes WHERE parcel_id = ?', [parcelCtx.parcelId]).catch(() => {});
    await db.run('DELETE FROM land_steward_state WHERE parcel_id = ?', [parcelCtx.parcelId]).catch(() => {});
    await db.run('DELETE FROM land_parcels WHERE parcel_id = ?', [parcelCtx.parcelId]);
  } else {
    await db.run(
      'UPDATE land_parcels SET sculpture_count = ?, updated_at = ? WHERE parcel_id = ?',
      [preservedHumanWorks, new Date().toISOString(), parcelCtx.parcelId]
    );
  }

  return {
    erased: true,
    parcelId: parcelCtx.parcelId,
    erasedSculptureCount: erasableIds.length,
    preservedHumanWorks,
    reason: cleanReason
  };
}

export async function applyUpdateParcel(db, { parcelCtx, ownerUser, ownerAddress, payload, txHash = '' }) {
  const existing = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [
    parcelCtx.parcelId
  ]);
  const incomingName =
    payload.customName !== undefined
      ? payload.customName
      : payload.name !== undefined
      ? payload.name
      : payload.title;
  const incomingNote =
    payload.description !== undefined ? payload.description : payload.curationNote;
  const customName =
    incomingName !== undefined
      ? String(incomingName || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 48)
      : existing?.custom_name || '';
  const curationNote =
    incomingNote !== undefined
      ? String(incomingNote || '').trim().slice(0, 240)
      : existing?.curation_note || '';
  const featuredId =
    payload.featuredSculptureId !== undefined
      ? String(payload.featuredSculptureId || '').trim()
      : existing?.featured_sculpture_id || '';

  const combined = `${customName} ${curationNote}`.toLowerCase();
  for (const term of POLICY.prohibitedTerms) {
    if (combined.includes(term)) {
      throw new McpServiceError(`Land curation violates Limited Terms Policy ("${term}").`, 400);
    }
  }
  if (incomingName !== undefined && customName) {
    const titleCheck = validateLandTitle(customName);
    if (!titleCheck.ok) {
      throw new McpServiceError(titleCheck.error, 400, { code: 'LAND_TITLE_INVALID' });
    }
    const conflict = await db
      .get(
        `SELECT parcel_id FROM parcel_curations
         WHERE LOWER(TRIM(custom_name)) = LOWER(?) AND parcel_id != ?
         LIMIT 1`,
        [titleCheck.normalized, parcelCtx.parcelId]
      )
      .catch(() => null);
    if (conflict) {
      throw new McpServiceError(
        `"${titleCheck.normalized}" is already taken by another Virtual Land.`,
        409,
        { code: 'LAND_TITLE_TAKEN', conflictingParcelId: conflict.parcel_id }
      );
    }
  }
  if (featuredId && !parcelCtx.visibleRows.some((s) => s.id === featuredId)) {
    throw new McpServiceError('featuredSculptureId must belong to this Virtual Land parcel.', 400);
  }

  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO parcel_curations (
      parcel_id, owner_sub, owner_address, custom_name, curation_note,
      featured_sculpture_id, allow_public_ar, last_signed_tx_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      owner_sub = excluded.owner_sub,
      owner_address = excluded.owner_address,
      custom_name = excluded.custom_name,
      curation_note = excluded.curation_note,
      featured_sculpture_id = excluded.featured_sculpture_id,
      last_signed_tx_hash = CASE
        WHEN excluded.last_signed_tx_hash != '' THEN excluded.last_signed_tx_hash
        ELSE parcel_curations.last_signed_tx_hash
      END,
      updated_at = excluded.updated_at`,
    [parcelCtx.parcelId, ownerUser.id, ownerAddress, customName, curationNote, featuredId, txHash || '', now]
  );

  const row = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [parcelCtx.parcelId]);
  const slug = slugifyLandTitle(row.custom_name || '') || parcelCtx.parcelId.toLowerCase();
  const displayName = resolveLandDisplayName({
    customName: row.custom_name || '',
    firstSculptureTitle: parcelCtx.visibleRows?.[0]?.title || '',
    placeName: parcelCtx.visibleRows?.[0]?.place_name || ''
  });
  return {
    parcel: {
      parcelId: parcelCtx.parcelId,
      geohash: parcelCtx.geohash,
      customName: row.custom_name,
      displayName,
      description: row.curation_note,
      curationNote: row.curation_note,
      slug,
      shareUrl: buildParcelShareUrl({
        parcelId: parcelCtx.parcelId,
        customName: row.custom_name,
        compact: true
      }),
      featuredSculptureId: row.featured_sculpture_id,
      lastSignedTxHash: row.last_signed_tx_hash,
      updatedAt: row.updated_at
    }
  };
}

export async function getPublicParcelDetail(
  db,
  { parcelOrSlug = '', publicOrigin = 'https://spray.land', publicPathname = '/' } = {}
) {
  const raw = String(parcelOrSlug || '').trim();
  if (!raw) throw new McpServiceError('Parcel ID or slug is required.', 400);

  const allParcels = await listLandsWithCurations(db);
  const upper = normalizeParcelId(raw);
  const cleanSlug = slugifyLandTitle(raw);

  const matched =
    allParcels.find((p) => p.parcelId === upper) ||
    allParcels.find((p) => p.slug === cleanSlug && cleanSlug !== '') ||
    allParcels.find((p) => slugifyLandTitle(p.customName || '') === cleanSlug && cleanSlug !== '');

  if (!matched) {
    throw new McpServiceError(`Virtual Land "${raw}" not found.`, 404);
  }

  const scRows = await db.all(
    `SELECT s.*,
      COALESCE(pc.custom_name, '') AS parcel_custom_name,
      m.model_format AS custom_model_format, m.mime_type AS custom_model_mime,
      m.source_type AS custom_model_source_type, m.model_url AS custom_model_url,
      m.model_cid AS custom_model_cid, m.model_uri AS custom_model_uri,
      m.scale AS custom_model_scale, m.rotation_y AS custom_model_rotation_y,
      m.byte_length AS custom_model_bytes,
      a.dx AS anchor_dx, a.dy AS anchor_dy, a.dz AS anchor_dz, a.yaw AS anchor_yaw,
      a.current_rev AS current_rev, a.last_erc4906_tx_hash AS last_erc4906_tx_hash,
      a.mesh_stats_json AS mesh_stats_json,
      COALESCE(l.layer_role, 'artist_work') AS layer_role,
      COALESCE(l.quest_id, '') AS layer_quest_id,
      COALESCE(l.plinth_slot_id, '') AS layer_plinth_slot_id,
      COALESCE(l.qual_contributor, 1) AS qual_contributor
     FROM sculptures s
     LEFT JOIN parcel_curations pc ON pc.parcel_id = s.parcel_id
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     WHERE s.parcel_id = ? AND s.hidden = 0
     ORDER BY s.created_at ASC`,
    [matched.parcelId]
  );

  const openQuests = await db
    .all(
      `SELECT id, title, prompt, theme, bounty_eth, max_completions, completions_count, slot_offsets_json
       FROM land_quests WHERE parcel_id = ? AND status = 'open' ORDER BY created_at DESC`,
      [matched.parcelId]
    )
    .catch(() => []);

  const shareUrl = buildParcelShareUrl({
    origin: publicOrigin,
    pathname: publicPathname,
    parcelId: matched.parcelId,
    customName: matched.customName,
    compact: true
  });

  return {
    parcel: {
      ...matched,
      shareUrl,
      openQuests: (openQuests || []).map((q) => ({
        id: q.id,
        title: q.title,
        prompt: q.prompt,
        theme: q.theme,
        bountyEth: Number(q.bounty_eth || 0),
        maxCompletions: Number(q.max_completions || 10),
        completionsCount: Number(q.completions_count || 0),
        slotOffsets: (() => {
          try {
            return JSON.parse(q.slot_offsets_json || '[]');
          } catch {
            return [];
          }
        })()
      }))
    },
    sculptures: (scRows || []).map((r) =>
      serializeSculptureRow(r, {
        includeVoxels: true,
        parcelFrozen: Boolean(matched.frozen)
      })
    ),
    shareUrl
  };
}

export async function applyPublishOnBehalf(
  db,
  { ownerUser, ownerAddress, payload, pinSculptureFn, mintSculptureFn, proofSignature = '' }
) {
  const locBundle = payload.locationBundle;
  const landSettings = await getLandSettingsInternal(db, locBundle.parcelId);
  if (landSettings.frozen) {
    const landLabel = await getLatestParcelDisplayName(db, locBundle.parcelId);
    throw new McpServiceError(
      `Virtual Land "${landLabel}" is frozen — no new sculptures can be placed here.`,
      403
    );
  }
  const sculptureId = globalThis.crypto.randomUUID();
  const ipfsResult = await pinSculptureFn({
    sculptureId,
    title: payload.title,
    description: payload.description,
    voxels: payload.cleanVoxels,
    previewDataUrl: payload.previewDataUrl || '',
    locationBundle: locBundle,
    creatorAddress: ownerAddress
  });

  const mintResult = await mintSculptureFn({
    recipientAddress: ownerAddress,
    metadataUri: ipfsResult.metadataUri,
    parcelBytes32: locBundle.parcelBytes32,
    proofHash: locBundle.proofHash,
    lat: locBundle.lat,
    lng: locBundle.lng
  });

  const now = new Date().toISOString();
  const polJson = JSON.stringify({
    ...(locBundle.proofBundle || {}),
    agentAssistedSignature: Boolean(proofSignature)
  });

  await db.run(
    `INSERT INTO sculptures (
      id, title, description, creator_sub, creator_name, creator_email, recipient_address,
      lat, lng, altitude, accuracy, heading, parcel_id, geohash, place_name, country, timezone,
      voxels_json, voxel_count, pol_score, pol_json, proof_hash, preview_data_url,
      ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url,
      chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain,
      royalty_bps, royalty_receiver, hidden, hidden_reason, hidden_by,
      terms_accepted_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?)`,
    [
      sculptureId,
      payload.title,
      payload.description,
      ownerUser.id,
      resolveAuthorHandleForStorage(ownerUser, 'Creator'),
      ownerUser.email,
      ownerAddress,
      locBundle.lat,
      locBundle.lng,
      locBundle.altitude,
      locBundle.accuracy,
      locBundle.heading,
      locBundle.parcelId,
      locBundle.geohash,
      locBundle.geoInfo?.placeName || locBundle.geoInfo?.displayName || '',
      locBundle.geoInfo?.country || '',
      locBundle.timezone || '',
      JSON.stringify(payload.cleanVoxels),
      payload.cleanVoxels.length,
      locBundle.score,
      polJson,
      locBundle.proofHash,
      String(payload.previewDataUrl || '').slice(0, 450000),
      ipfsResult.metadataCid,
      ipfsResult.modelCid,
      ipfsResult.imageCid,
      ipfsResult.gatewayUrl,
      mintResult.chainId,
      mintResult.chainName,
      mintResult.contractAddress,
      mintResult.tokenId,
      mintResult.txHash,
      mintResult.simulated ? 1 : 0,
      mintResult.royaltyBps,
      mintResult.royaltyReceiver,
      POLICY.termsVersion,
      now
    ]
  );

  const fittedVolume = buildObjectFittedLandVolume({
    parcelId: locBundle.parcelId,
    geohash: locBundle.geohash,
    lat: locBundle.lat,
    lng: locBundle.lng,
    voxels: payload.cleanVoxels,
    anchorOffset: payload.anchorOffset || null,
    paddingFraction: 0.1
  });

  const existingParcel = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [
    locBundle.parcelId
  ]);
  if (existingParcel) {
    await db.run(
      'UPDATE land_parcels SET latest_claimant_address = ?, sculpture_count = sculpture_count + 1, updated_at = ? WHERE parcel_id = ?',
      [ownerAddress, now, locBundle.parcelId]
    );
  } else {
    await db.run(
      `INSERT INTO land_parcels (
        parcel_id, geohash, center_lat, center_lng,
        first_claimant_sub, first_claimant_address, latest_claimant_address,
        sculpture_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        locBundle.parcelId,
        locBundle.geohash,
        fittedVolume ? fittedVolume.centerLat : locBundle.parcelBounds.center[0],
        fittedVolume ? fittedVolume.centerLng : locBundle.parcelBounds.center[1],
        ownerUser.id,
        ownerAddress,
        ownerAddress,
        now
      ]
    );
  }

  if (fittedVolume) {
    await db
      .run(
        `INSERT OR IGNORE INTO land_volumes (
          parcel_id, geohash, center_lat, center_lng,
          width_meters, depth_meters, height_meters, z_scale, rotation_deg,
          base_altitude_m, footprint_area_sqm, volume_cubic_m, corners_json,
          claimed_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fittedVolume.parcelId,
          fittedVolume.geohash,
          fittedVolume.centerLat,
          fittedVolume.centerLng,
          fittedVolume.widthMeters,
          fittedVolume.depthMeters,
          fittedVolume.heightMeters,
          fittedVolume.zScale,
          fittedVolume.rotationDeg,
          fittedVolume.baseAltitudeM,
          fittedVolume.footprintAreaSqM,
          fittedVolume.volumeCubicM,
          JSON.stringify(fittedVolume.corners),
          ownerUser.id,
          now,
          now
        ]
      )
      .catch(() => {});
  }

  if (payload.draftId) {
    await consumeDraftOnPublish(db, { draftId: payload.draftId, user: ownerUser });
  }

  try {
    const visibleCntRow = await db
      .get('SELECT COUNT(*) AS cnt FROM sculptures WHERE parcel_id = ? AND hidden = 0', [
        locBundle.parcelId
      ])
      .catch(() => null);
    await notifyAfterSculpturePublished(db, {
      parcelId: locBundle.parcelId,
      sculptureId,
      sculptureTitle: payload.title,
      creatorSub: ownerUser?.id || '',
      creatorName: resolveAuthorHandleForStorage(ownerUser, 'Creator'),
      awakenedParcel: false,
      wasPreviouslyEmpty: Number(visibleCntRow?.cnt || 0) <= 1
    });
  } catch {
    // Non-fatal notification failure
  }

  const saved = await fetchSculptureWithModelRow(db, sculptureId);
  return {
    sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
    mint: mintResult,
    ipfs: ipfsResult
  };
}

export async function applyRollbackSculptureRevision(
  db,
  { sculptureRow, revNum, ownerUser, emitMetadataUpdateFn = null }
) {
  const targetRev = Number(revNum);
  if (!Number.isInteger(targetRev) || targetRev < 1) {
    throw new McpServiceError('Valid integer revNum >= 1 is required.', 400);
  }
  const revRow = await db.get(
    'SELECT * FROM sculpture_revisions WHERE sculpture_id = ? AND rev_num = ?',
    [sculptureRow.id, targetRev]
  );
  if (!revRow) {
    throw new McpServiceError(`Revision v${targetRev} not found for sculpture.`, 404);
  }

  const maxRow = await db.get(
    'SELECT MAX(rev_num) AS maxRev FROM sculpture_revisions WHERE sculpture_id = ?',
    [sculptureRow.id]
  );
  const newRev = Math.max(Number(maxRow?.maxRev || 1), 1) + 1;
  const restoredVoxels = JSON.parse(revRow.voxels_json || '[]');
  const restoredOffset = revRow.anchor_offset_json
    ? JSON.parse(revRow.anchor_offset_json)
    : { dx: 0, dy: 0, dz: 0, yaw: 0 };
  const customSnap = revRow.custom_model_json ? JSON.parse(revRow.custom_model_json) : null;

  await db.run(
    `UPDATE sculptures
     SET title = ?, description = ?, voxels_json = ?, voxel_count = ?,
         ipfs_metadata_cid = ?, ipfs_model_cid = ?, ipfs_image_cid = ?
     WHERE id = ?`,
    [
      revRow.title,
      revRow.description,
      revRow.voxels_json || '[]',
      Number(revRow.voxel_count || restoredVoxels.length),
      revRow.ipfs_metadata_cid,
      revRow.ipfs_model_cid,
      revRow.ipfs_image_cid,
      sculptureRow.id
    ]
  );

  if (customSnap) {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO sculpture_models (
        sculpture_id, parcel_id, model_format, mime_type, source_type, model_url,
        model_cid, model_uri, gateway_url, inline_b64, byte_length, scale, rotation_y, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
      ON CONFLICT(sculpture_id) DO UPDATE SET
        model_format = excluded.model_format,
        mime_type = excluded.mime_type,
        model_url = excluded.model_url,
        model_cid = excluded.model_cid,
        model_uri = excluded.model_uri,
        inline_b64 = excluded.inline_b64,
        byte_length = excluded.byte_length,
        scale = excluded.scale,
        rotation_y = excluded.rotation_y,
        updated_at = excluded.updated_at`,
      [
        sculptureRow.id,
        sculptureRow.parcel_id,
        customSnap.format || 'glb',
        customSnap.mimeType || 'model/gltf-binary',
        customSnap.sourceType || 'ipfs',
        customSnap.modelUrl || '',
        customSnap.modelCid || revRow.ipfs_model_cid,
        customSnap.modelUri || `ipfs://${revRow.ipfs_model_cid}`,
        customSnap.inlineB64 || '',
        Number(customSnap.byteLength || 0),
        Number(customSnap.scale ?? 1),
        Number(customSnap.rotationY ?? 0),
        now
      ]
    );
  } else {
    await db.run('DELETE FROM sculpture_models WHERE sculpture_id = ?', [sculptureRow.id]);
  }

  const isSelfFundedAgent =
    String(ownerUser?.id || '').startsWith('agent:') || ownerUser?.actorType === 'agent';
  let erc4906TxHash = '';
  if (!isSelfFundedAgent && typeof emitMetadataUpdateFn === 'function') {
    try {
      const updRes = await emitMetadataUpdateFn({
        tokenId: sculptureRow.token_id,
        metadataUri: `ipfs://${revRow.ipfs_metadata_cid}`
      });
      erc4906TxHash = updRes?.txHash || '';
    } catch {}
  }

  const existingAnchorRow = await db
    .get('SELECT mesh_stats_json FROM sculpture_anchors WHERE sculpture_id = ?', [sculptureRow.id])
    .catch(() => null);
  const existingRestoreStats = (() => {
    try {
      const p = JSON.parse(existingAnchorRow?.mesh_stats_json || '{}');
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  })();

  await upsertAnchorAndRevision(db, {
    sculptureId: sculptureRow.id,
    parcelId: sculptureRow.parcel_id,
    revNum: newRev,
    anchorOffset: restoredOffset,
    meshStats: {
      ...existingRestoreStats,
      ...(restoredOffset?.scale !== undefined ? { transformScale: Number(restoredOffset.scale) } : {}),
      transformPitch: tiltToDegrees(restoredOffset?.pitch || 0),
      transformRoll: tiltToDegrees(restoredOffset?.roll || 0)
    },
    erc4906TxHash,
    editorUser: ownerUser,
    editorRole: 'owner',
    modelType: customSnap ? 'custom-3d' : 'voxel',
    voxels: restoredVoxels,
    title: revRow.title,
    description: revRow.description,
    ipfsMetadataCid: revRow.ipfs_metadata_cid,
    ipfsModelCid: revRow.ipfs_model_cid,
    ipfsImageCid: revRow.ipfs_image_cid,
    changeSummary: `Rolled back to v${targetRev}`,
    customModelSnapshot: customSnap
  });

  const updated = await fetchSculptureWithModelRow(db, sculptureRow.id);
  return {
    sculpture: serializeSculptureRow(updated, { includeVoxels: true }),
    restoredFromRev: targetRev,
    revNum: newRev,
    erc4906TxHash
  };
}

export async function directOwnerUpdateSculpture(
  db,
  { sculptureId, user, body, pinSculptureFn, emitMetadataUpdateFn = null }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const perm = await checkSculptureEditPermission(db, { sculptureId, user });
  const out = await applyUpdateSculpture(db, {
    sculptureRow: perm.row,
    payload: body || {},
    pinSculptureFn,
    emitMetadataUpdateFn,
    editorUser: user,
    editorRole: perm.role
  });
  return { ...out, editorRole: perm.role };
}

export async function listSculptureRevisions(db, { sculptureId }) {
  const row = await db.get('SELECT id, title, parcel_id, hidden FROM sculptures WHERE id = ?', [
    String(sculptureId || '')
  ]);
  if (!row || row.hidden) {
    throw new McpServiceError('Sculpture not found.', 404);
  }
  const anchor = await db.get('SELECT * FROM sculpture_anchors WHERE sculpture_id = ?', [row.id]);
  const revRows = await db.all(
    `SELECT sr.*,
            COALESCE(u.username, '') AS editor_username,
            COALESCE(u.avatar_image, '') AS editor_avatar,
            COALESCE(u.user_number, 0) AS editor_user_number
     FROM sculpture_revisions sr
     LEFT JOIN users u ON u.id = sr.editor_sub
     WHERE sr.sculpture_id = ?
     ORDER BY sr.rev_num DESC
     LIMIT 30`,
    [row.id]
  );
  return {
    sculptureId: row.id,
    parcelId: row.parcel_id,
    currentRev: Number(anchor?.current_rev || revRows?.[0]?.rev_num || 1),
    lastErc4906TxHash: anchor?.last_erc4906_tx_hash || '',
    revisions: (revRows || []).map((r) => {
      const editorUsername = String(r.editor_username || '').trim();
      const editorAvatar = resolveSafeUserAvatar(r.editor_avatar || '');
      return {
        id: r.id,
        revNum: Number(r.rev_num),
        editorSub: r.editor_sub,
        editorUsername,
        editorAvatar,
        editorName: resolvePublicUserHandle(
          {
            id: r.editor_sub,
            username: editorUsername,
            editorName: r.editor_name,
            editorRole: r.editor_role,
            userNumber: r.editor_user_number
          },
          { fallback: 'Creator', includeAt: true }
        ),
        editorRole: r.editor_role || 'owner',
        modelType: r.model_type || 'voxel',
        voxelCount: Number(r.voxel_count || 0),
        title: r.title,
        description: r.description,
        ipfsMetadataCid: r.ipfs_metadata_cid,
        ipfsModelCid: r.ipfs_model_cid,
        ipfsImageCid: r.ipfs_image_cid,
        changeSummary: r.change_summary || '',
        createdAt: r.created_at
      };
    })
  };
}

export async function directOwnerRollbackRevision(
  db,
  { sculptureId, revNum, user, emitMetadataUpdateFn = null }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const perm = await checkSculptureOrLandOwnership(db, { sculptureId, user, allowHidden: true });
  return applyRollbackSculptureRevision(db, {
    sculptureRow: perm.row,
    revNum,
    ownerUser: user,
    emitMetadataUpdateFn
  });
}

export async function directOwnerSetSculptureVisibility(
  db,
  { sculptureId, user, hidden, reason = '' }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const perm = await checkSculptureOrLandOwnership(db, {
    sculptureId,
    user,
    allowHidden: true
  });
  return applySetSculptureVisibility(db, {
    sculptureRow: perm.row,
    actorAddress: resolvePreferredOwnerWallet(user) || perm.ownerAddress,
    hidden: Boolean(hidden),
    reason
  });
}

export async function getMyLandsWorkspace(db, { user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  return listOwnerLandsAndSculptures(db, user);
}

export async function updateLandSettings(db, { parcelId, user, body }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  const current = await getLandSettingsInternal(db, parcelCtx.parcelId);
  const allowAgentErase =
    body?.allowAgentErase !== undefined ? Boolean(body.allowAgentErase) : current.allowAgentErase;
  const allowContributorEdits =
    body?.allowContributorEdits !== undefined
      ? Boolean(body.allowContributorEdits)
      : current.allowContributorEdits;
  const frozenInput =
    body?.frozen !== undefined
      ? body.frozen
      : body?.freezePlacements !== undefined
      ? body.freezePlacements
      : body?.freeze_placements;
  const frozen = frozenInput !== undefined ? Boolean(frozenInput) : current.frozen;
  const now = new Date().toISOString();
  const ownerAddress = resolvePreferredOwnerWallet(user);

  await db.run(
    `INSERT INTO land_settings (
      parcel_id, owner_sub, owner_address, allow_agent_erase, allow_contributor_edits, freeze_placements, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      owner_sub = excluded.owner_sub,
      owner_address = excluded.owner_address,
      allow_agent_erase = excluded.allow_agent_erase,
      allow_contributor_edits = excluded.allow_contributor_edits,
      freeze_placements = excluded.freeze_placements,
      updated_at = excluded.updated_at`,
    [
      parcelCtx.parcelId,
      user.id,
      ownerAddress,
      allowAgentErase ? 1 : 0,
      allowContributorEdits ? 1 : 0,
      frozen ? 1 : 0,
      now
    ]
  );

  return { settings: await getLandSettingsInternal(db, parcelCtx.parcelId) };
}

export async function listLandContributorsAndEligible(db, { parcelId, user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  const rows = await db.all(
    'SELECT * FROM land_contributors WHERE parcel_id = ? ORDER BY created_at DESC',
    [parcelCtx.parcelId]
  );
  const eligibleVisitors = await findEligibleParcelVisitors(db, {
    parcelId: parcelCtx.parcelId,
    ownerSub: user.id
  });
  const settings = await getLandSettingsInternal(db, parcelCtx.parcelId);
  return {
    parcelId: parcelCtx.parcelId,
    contributors: (rows || []).map(formatContributorRow),
    eligibleVisitors,
    settings
  };
}

export async function addLandContributor(db, { parcelId, user, body }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });

  const targetUserId = String(body?.contributorUserId || body?.userId || '').trim();
  const targetEmail = String(body?.email || '').trim().toLowerCase();
  const targetAddress = String(body?.walletAddress || '').trim().toLowerCase();

  if (!targetUserId && !targetEmail && !targetAddress) {
    throw new McpServiceError(
      'Select an IRL visitor or enter contributor email / wallet address.',
      400
    );
  }

  let candidate = null;
  if (targetUserId) {
    candidate = await db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  } else if (targetEmail) {
    candidate = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', [targetEmail]);
  } else if (targetAddress) {
    candidate = await db.get(
      'SELECT * FROM users WHERE LOWER(wallet_address) = ? OR LOWER(custom_payout_address) = ?',
      [targetAddress, targetAddress]
    );
  }

  if (!candidate) throw new McpServiceError('Target user account was not found.', 404);
  if (candidate.id === user.id) {
    throw new McpServiceError('Land holder already holds full ownership on this parcel.', 400);
  }

  const eligibleVisitors = await findEligibleParcelVisitors(db, {
    parcelId: parcelCtx.parcelId,
    ownerSub: user.id
  });
  if (!eligibleVisitors.some((v) => v.userId === candidate.id)) {
    const landLabel = await getLatestParcelDisplayName(db, parcelCtx.parcelId);
    throw new McpServiceError(
      `Only accounts that visited Virtual Land "${landLabel}" in person and can chat on this land can be added as Contributors.`,
      403
    );
  }

  const now = new Date().toISOString();
  const contributorId = globalThis.crypto.randomUUID();
  const candidateAddr = candidate.custom_payout_address || candidate.wallet_address || '';

  await db.run(
    `INSERT INTO land_contributors (
      id, parcel_id, contributor_sub, contributor_email, contributor_name,
      contributor_address, can_edit_sculptures, added_by_sub, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(parcel_id, contributor_sub) DO UPDATE SET
      contributor_email = excluded.contributor_email,
      contributor_name = excluded.contributor_name,
      contributor_address = excluded.contributor_address,
      can_edit_sculptures = 1,
      updated_at = excluded.updated_at`,
    [
      contributorId,
      parcelCtx.parcelId,
      candidate.id,
      candidate.email || '',
      candidate.name || 'Artist',
      candidateAddr,
      user.id,
      now,
      now
    ]
  );

  const listRes = await listLandContributorsAndEligible(db, {
    parcelId: parcelCtx.parcelId,
    user
  });
  return {
    ok: true,
    contributor: listRes.contributors.find((c) => c.contributorSub === candidate.id) || null,
    ...listRes
  };
}

export async function removeLandContributor(db, { parcelId, contributorSub, user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  const cleanSub = String(contributorSub || '').trim();
  if (!cleanSub) throw new McpServiceError('contributorSub is required.', 400);

  await db.run('DELETE FROM land_contributors WHERE parcel_id = ? AND contributor_sub = ?', [
    parcelCtx.parcelId,
    cleanSub
  ]);

  const listRes = await listLandContributorsAndEligible(db, {
    parcelId: parcelCtx.parcelId,
    user
  });
  return { ok: true, removedSub: cleanSub, ...listRes };
}

export async function directOwnerEraseLand(db, { parcelId, user, body }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  return applyEraseLand(db, {
    parcelCtx,
    ownerAddress: resolvePreferredOwnerWallet(user),
    reason: body?.reason || '',
    viaAgent: false
  });
}

export async function directOwnerCreateSculptureOnLand(
  db,
  { parcelId, user, body, pinSculptureFn, mintSculptureFn }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  const ownerAddress = resolvePreferredOwnerWallet(user);
  return applyCreateSculptureOnLand(db, {
    parcelCtx,
    ownerUser: user,
    ownerAddress,
    payload: body || {},
    pinSculptureFn,
    mintSculptureFn,
    proofSeed: `direct:${user.id}`
  });
}

export async function directOwnerDeleteSculpture(db, { sculptureId, user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const perm = await checkSculptureOrLandOwnership(db, { sculptureId, user });
  return applyDeleteSculpture(db, {
    sculptureRow: perm.row,
    ownerAddress: resolvePreferredOwnerWallet(user) || perm.ownerAddress
  });
}

export async function directOwnerUpdateParcel(db, { parcelId, user, body }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  return applyUpdateParcel(db, {
    parcelCtx,
    ownerUser: user,
    ownerAddress: resolvePreferredOwnerWallet(user),
    payload: body || {}
  });
}
