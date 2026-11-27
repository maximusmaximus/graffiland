import { ethers } from 'ethers';
import { decodeGeohashBounds, encodeGeohash, haversineMeters } from '../server/services/pol.mjs';
import { LAND_VOLUME_LIMITS, STEWARD_DEFAULTS } from './constants.mjs';
import {
  buildDefaultVolumeFromBounds,
  buildParcelShareUrl,
  footprintsOverlap,
  resolveLandDisplayName,
  slugifyLandTitle,
  validateAndNormalizeLandVolume,
  validateLandTitle
} from './landVolume.mjs';
import {
  computeAgentSlotUsage,
  computeDormantLeaseExpiresAt,
  computeInactivityExpiresAt,
  reapAndArchiveExpiredLands
} from './landArchiveService.mjs';
import {
  getUserMintCapacityStatus,
  notifyAfterSculpturePublished,
  notifyFreeLimitReached,
  notifyLandMinted
} from './notificationService.mjs';
import { resolveAuthorHandleForStorage } from './userDisplay.mjs';
import {
  McpServiceError,
  checkParcelOwnership,
  getLatestParcelDisplayName,
  normalizeParcelId,
  resolvePreferredOwnerWallet
} from './mcp/helpers.mjs';
import { applyCreateSculptureOnLand } from './mcp/landMutations.mjs';
import { generateVoxelPrefab } from './proceduralSculpt.mjs';
import {
  calculateFeeSplitBreakdown,
  getParcelQualifiedHumanContributors,
  recordFeeLedgerSplit
} from './marketplaceService.mjs';
import { getLandSecurityPolicy, seedLandSecurityPolicy } from './landmarkService.mjs';

function parseSlotOffsets(rawJson) {
  try {
    const arr = JSON.parse(rawJson || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 16).map((slot, idx) => ({
      id: String(slot?.id || `plinth-${idx + 1}`).slice(0, 48),
      label: String(slot?.label || `Plinth ${idx + 1}`).slice(0, 48),
      dx: Number(slot?.dx || 0),
      dy: Number(slot?.dy || 0),
      dz: Number(slot?.dz || 0),
      yaw: Number(slot?.yaw || 0),
      claimedBySculptureId: slot?.claimedBySculptureId ? String(slot.claimedBySculptureId) : ''
    }));
  } catch {
    return [];
  }
}

function serializeQuestRow(row, stewardRow = null, curationRow = null, parcelRow = null) {
  const slots = parseSlotOffsets(row.slot_offsets_json);
  const openSlots = slots.filter((s) => !s.claimedBySculptureId);
  const landStatus = stewardRow?.status || 'awakened';
  return {
    id: row.id,
    parcelId: row.parcel_id,
    parcelName: curationRow?.custom_name || '',
    landDisplayName: resolveLandDisplayName({ customName: curationRow?.custom_name || '' }),
    stewardSub: row.steward_sub,
    stewardName: stewardRow?.steward_name || 'AI Steward',
    stewardType: stewardRow?.steward_type || 'agent',
    landStatus,
    firstSparkBoost: landStatus === 'dormant',
    badgeLabel:
      landStatus === 'dormant'
        ? '🔥 First-Spark Needed · 2x XP · 2% Pool'
        : '🎨 Active Land Quest · 2% Pool',
    title: row.title,
    prompt: row.prompt,
    theme: row.theme || 'open',
    bountyEth: Number(row.bounty_eth || 0),
    bountyWei: row.bounty_wei || '0',
    maxCompletions: Number(row.max_completions || 10),
    completionsCount: Number(row.completions_count || 0),
    humanContributorCount: Number(stewardRow?.human_contributor_count || 0),
    status: row.status,
    lat: parcelRow?.center_lat ?? null,
    lng: parcelRow?.center_lng ?? null,
    slotOffsets: slots,
    openSlotsCount: openSlots.length,
    leaseExpiresAt: stewardRow?.lease_expires_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Archives and destroys expired 72-hour dormant agent lands (with zero in-person human
 * interactions, even if the agent placed 3D models) AND any active lands that have had
 * zero verified in-person human interactions for 28 consecutive days.
 * Also emits 3-hour pre-expiry warning notifications for lands approaching expiry.
 */
export async function releaseExpiredDormantLands(db, nowIso = new Date().toISOString()) {
  return reapAndArchiveExpiredLands(db, nowIso);
}

/**
 * Lets an autonomous agent scout nearby claimed, dormant, awakened, and unclaimed claimable Virtual Land parcels.
 */
export async function scoutLands(
  db,
  { lat = null, lng = null, radiusMeters = 5000, statusFilter = 'all' } = {}
) {
  await releaseExpiredDormantLands(db);

  const rows = await db.all(
    `SELECT lp.*,
            st.steward_sub, st.steward_address, st.steward_name, st.steward_type,
            st.status AS steward_status, st.lease_expires_at, st.awakened_at,
            st.last_human_interaction_at, st.last_human_interaction_type,
            st.inactivity_expires_at, st.had_human_interaction,
            st.human_contributor_count, st.total_tx_volume_eth, st.agent_royalties_eth,
            pc.custom_name, pc.curation_note,
            (SELECT COUNT(*) FROM land_quests q WHERE q.parcel_id = lp.parcel_id AND q.status = 'open') AS open_quest_count
     FROM land_parcels lp
     LEFT JOIN land_steward_state st ON st.parcel_id = lp.parcel_id
     LEFT JOIN parcel_curations pc ON pc.parcel_id = lp.parcel_id
     ORDER BY lp.updated_at DESC`
  );

  const hasCoord =
    lat !== null &&
    lat !== undefined &&
    lat !== '' &&
    lng !== null &&
    lng !== undefined &&
    lng !== '' &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng));
  const refLat = hasCoord ? Number(lat) : null;
  const refLng = hasCoord ? Number(lng) : null;
  const knownParcelIds = new Set();

  let parcels = (rows || []).map((r) => {
    knownParcelIds.add(r.parcel_id);
    const landStatus = r.steward_status || 'awakened';
    const distanceMeters = hasCoord
      ? Math.round(haversineMeters(refLat, refLng, r.center_lat, r.center_lng) * 10) / 10
      : null;
    return {
      parcelId: r.parcel_id,
      geohash: r.geohash,
      lat: r.center_lat,
      lng: r.center_lng,
      bounds: decodeGeohashBounds(r.geohash),
      status: landStatus,
      claimableFree: false,
      stewardSub: r.steward_sub || r.first_claimant_sub || '',
      stewardName: r.steward_name || '',
      stewardType: r.steward_type || (String(r.first_claimant_sub || '').startsWith('agent:') ? 'agent' : 'human'),
      customName: r.custom_name || '',
      displayName: resolveLandDisplayName({ customName: r.custom_name || '' }),
      curationNote: r.curation_note || '',
      sculptureCount: Number(r.sculpture_count || 0),
      humanContributorCount: Number(r.human_contributor_count || 0),
      openQuestCount: Number(r.open_quest_count || 0),
      leaseExpiresAt: r.lease_expires_at || '',
      inactivityExpiresAt: r.inactivity_expires_at || '',
      lastHumanInteractionAt: r.last_human_interaction_at || '',
      lastHumanInteractionType: r.last_human_interaction_type || '',
      hadHumanInteraction: Number(r.had_human_interaction || 0) === 1,
      awakenedAt: r.awakened_at || '',
      distanceMeters
    };
  });

  if (hasCoord) {
    parcels = parcels.filter((p) => p.distanceMeters === null || p.distanceMeters <= radiusMeters);
  }

  const unclaimedCandidates = [];
  if (hasCoord && (statusFilter === 'all' || statusFilter === 'unclaimed')) {
    const offsets = [
      [0, 0],
      [0.00042, 0],
      [-0.00042, 0],
      [0, 0.00048],
      [0, -0.00048],
      [0.00042, 0.00048]
    ];
    for (const [dLat, dLng] of offsets) {
      const pLat = Math.max(-89.9, Math.min(89.9, refLat + dLat));
      const pLng = Math.max(-179.9, Math.min(179.9, refLng + dLng));
      const gh = encodeGeohash(pLat, pLng, 8);
      const pid = `GLAND-${gh.toUpperCase()}`;
      if (knownParcelIds.has(pid) || unclaimedCandidates.some((c) => c.parcelId === pid)) continue;
      const bounds = decodeGeohashBounds(gh);
      unclaimedCandidates.push({
        parcelId: pid,
        geohash: gh,
        lat: bounds.center[0],
        lng: bounds.center[1],
        bounds,
        status: 'unclaimed',
        claimableFree: true,
        stewardSub: '',
        stewardName: '',
        stewardType: 'none',
        customName: '',
        curationNote: '',
        sculptureCount: 0,
        humanContributorCount: 0,
        openQuestCount: 0,
        leaseExpiresAt: '',
        awakenedAt: '',
        distanceMeters:
          Math.round(haversineMeters(refLat, refLng, bounds.center[0], bounds.center[1]) * 10) / 10
      });
    }
  }

  let combined = [...unclaimedCandidates, ...parcels];
  if (statusFilter && statusFilter !== 'all') {
    combined = combined.filter((p) => p.status === statusFilter);
  }
  if (hasCoord) {
    combined.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  }

  return {
    parcels: combined.slice(0, 80),
    unclaimedCount: unclaimedCandidates.length,
    dormantCount: combined.filter((p) => p.status === 'dormant').length,
    awakenedCount: combined.filter((p) => p.status === 'awakened').length
  };
}

async function saveLandVolumeRow(db, vol, now) {
  await db.run(
    `INSERT INTO land_volumes (
      parcel_id, center_lat, center_lng, width_meters, depth_meters, height_meters,
      z_scale, rotation_deg, base_altitude_m, footprint_area_sqm, volume_cubic_m, corners_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      center_lat = excluded.center_lat,
      center_lng = excluded.center_lng,
      width_meters = excluded.width_meters,
      depth_meters = excluded.depth_meters,
      height_meters = excluded.height_meters,
      z_scale = excluded.z_scale,
      rotation_deg = excluded.rotation_deg,
      base_altitude_m = excluded.base_altitude_m,
      footprint_area_sqm = excluded.footprint_area_sqm,
      volume_cubic_m = excluded.volume_cubic_m,
      corners_json = excluded.corners_json,
      updated_at = excluded.updated_at`,
    [
      vol.parcelId,
      vol.centerLat,
      vol.centerLng,
      vol.widthMeters,
      vol.depthMeters,
      vol.heightMeters,
      vol.zScale,
      vol.rotationDeg,
      vol.baseAltitudeM || 0,
      vol.footprintAreaSqM,
      vol.volumeCubicM,
      JSON.stringify(vol.corners || []),
      now
    ]
  );
}

async function assertNoFootprintOverlap(db, targetVol) {
  const existingRows = await db
    .all(
      `SELECT lp.parcel_id, lp.geohash,
              lv.center_lat, lv.center_lng, lv.width_meters, lv.depth_meters,
              lv.rotation_deg, lv.corners_json
       FROM land_parcels lp
       LEFT JOIN land_volumes lv ON lv.parcel_id = lp.parcel_id
       LEFT JOIN land_steward_state st ON st.parcel_id = lp.parcel_id
       WHERE lp.parcel_id != ?
         AND COALESCE(st.status, 'awakened') != 'expired'`,
      [targetVol.parcelId]
    )
    .catch(() => []);

  for (const row of existingRows || []) {
    let otherVol = null;
    if (Number.isFinite(Number(row.width_meters)) && Number(row.width_meters) > 0) {
      let corners = [];
      try {
        corners = JSON.parse(row.corners_json || '[]');
      } catch {
        corners = [];
      }
      otherVol = {
        centerLat: Number(row.center_lat),
        centerLng: Number(row.center_lng),
        widthMeters: Number(row.width_meters),
        depthMeters: Number(row.depth_meters),
        rotationDeg: Number(row.rotation_deg || 0),
        corners
      };
    } else if (row.geohash) {
      otherVol = buildDefaultVolumeFromBounds(
        decodeGeohashBounds(row.geohash),
        row.parcel_id,
        row.geohash
      );
    }
    if (otherVol && footprintsOverlap(targetVol, otherVol)) {
      const otherLabel = await getLatestParcelDisplayName(db, row.parcel_id);
      throw new McpServiceError(
        `Selected 3D land footprint overlaps existing Virtual Land "${otherLabel}".`,
        409,
        { conflictingParcelId: row.parcel_id, conflictingLandName: otherLabel }
      );
    }
  }
}

/**
 * Checks whether a desired Virtual Land title is valid and unused by any other parcel.
 */
export async function checkLandTitleAvailability(db, { name = '', excludeParcelId = '' } = {}) {
  const check = validateLandTitle(name);
  if (!check.ok) {
    return {
      ok: false,
      available: false,
      normalized: check.normalized,
      reason: check.error
    };
  }
  const cleanExclude = excludeParcelId ? normalizeParcelId(excludeParcelId) : '';
  const conflict = cleanExclude
    ? await db.get(
        `SELECT parcel_id, custom_name
         FROM parcel_curations
         WHERE LOWER(TRIM(custom_name)) = LOWER(?)
           AND parcel_id != ?
         LIMIT 1`,
        [check.normalized, cleanExclude]
      )
    : await db.get(
        `SELECT parcel_id, custom_name
         FROM parcel_curations
         WHERE LOWER(TRIM(custom_name)) = LOWER(?)
         LIMIT 1`,
        [check.normalized]
      );

  if (conflict) {
    return {
      ok: true,
      available: false,
      normalized: check.normalized,
      conflictingParcelId: conflict.parcel_id,
      reason: `"${check.normalized}" is already taken by another Virtual Land.`
    };
  }
  return {
    ok: true,
    available: true,
    normalized: check.normalized,
    reason: ''
  };
}

/**
 * Claims an unclaimed or expired Virtual Land parcel with optional custom 3D volume/rotation/Z-scale.
 * Autonomous agents get a 7-day dormant lease (0 platform fee, agent pays own gas).
 * Human Desktop creators mint active starter parcels directly (gas-free starter quota).
 */
export async function claimDormantLand(
  db,
  {
    agentUser,
    parcelId = '',
    lat = null,
    lng = null,
    customName = '',
    description = '',
    curationNote = '',
    volume = null,
    txHash = '',
    chainCfg = null,
    envTier = '',
    geoInfo = null,
    skipRemoteLookup = undefined
  }
) {
  const effectiveDescription = String(description || curationNote || '').trim().slice(0, 240);
  const effectiveCustomName = String(customName || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 48);
  await releaseExpiredDormantLands(db);

  let cleanParcelId = normalizeParcelId(parcelId);
  let geohash = cleanParcelId.startsWith('GLAND-')
    ? cleanParcelId.slice(6).toLowerCase()
    : '';

  if (!cleanParcelId) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      throw new McpServiceError('Provide either parcelId (GLAND-...) or lat/lng coordinates.', 400);
    }
    geohash = encodeGeohash(Number(lat), Number(lng), 8);
    cleanParcelId = `GLAND-${geohash.toUpperCase()}`;
  } else if (!/^GLAND-[0-9A-Z]{6,10}$/.test(cleanParcelId)) {
    throw new McpServiceError('Invalid Virtual Land parcelId format. Expected GLAND-<GEOHASH>.', 400);
  }

  const bounds = decodeGeohashBounds(geohash);
  const stewardAddress = resolvePreferredOwnerWallet(agentUser);
  if (!stewardAddress) {
    throw new McpServiceError('Authenticated steward wallet address is required.', 401);
  }

  const refLat = Number.isFinite(Number(lat)) ? Number(lat) : bounds.center[0];
  const refLng = Number.isFinite(Number(lng)) ? Number(lng) : bounds.center[1];
  let resolvedVolume = buildDefaultVolumeFromBounds(bounds, cleanParcelId, geohash);

  if (volume && typeof volume === 'object') {
    const volCheck = validateAndNormalizeLandVolume({
      ...volume,
      lat: volume.centerLat ?? volume.lat ?? refLat,
      lng: volume.centerLng ?? volume.lng ?? refLng,
      parcelId: cleanParcelId,
      geohash
    });
    if (!volCheck.ok) {
      throw new McpServiceError(volCheck.errors[0], 400, {
        errors: volCheck.errors,
        limits: LAND_VOLUME_LIMITS
      });
    }
    resolvedVolume = volCheck.volume;
  }

  const existingSteward = await db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [
    cleanParcelId
  ]);
  const existingParcel = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [
    cleanParcelId
  ]);

  if (existingSteward && (existingSteward.status === 'dormant' || existingSteward.status === 'awakened')) {
    if (existingSteward.steward_sub === agentUser.id) {
      const nowExisting = new Date().toISOString();
      if (volume && typeof volume === 'object') {
        await assertNoFootprintOverlap(db, resolvedVolume);
        await saveLandVolumeRow(db, resolvedVolume, nowExisting);
      }
      return {
        claimed: true,
        alreadyClaimed: true,
        parcelId: cleanParcelId,
        status: existingSteward.status,
        leaseExpiresAt: existingSteward.lease_expires_at || '',
        bounds,
        volume: resolvedVolume,
        limits: LAND_VOLUME_LIMITS
      };
    }
    const existingLabel = await getLatestParcelDisplayName(db, cleanParcelId);
    throw new McpServiceError(
      `Virtual Land "${existingLabel}" is already claimed by ${existingSteward.steward_name || 'another steward'}.`,
      409
    );
  }

  if (existingParcel && !existingSteward) {
    const activeSc = await db.get(
      'SELECT COUNT(*) AS cnt FROM sculptures WHERE parcel_id = ? AND hidden = 0',
      [cleanParcelId]
    );
    if (
      Number(activeSc?.cnt || 0) > 0 &&
      existingParcel.first_claimant_sub &&
      existingParcel.first_claimant_sub !== agentUser.id
    ) {
      const existingLabel = await getLatestParcelDisplayName(db, cleanParcelId);
      throw new McpServiceError(`Virtual Land "${existingLabel}" is already held by another claimant.`, 409);
    }
  }

  await assertNoFootprintOverlap(db, resolvedVolume);

  const isAgent = String(agentUser.id || '').startsWith('agent:') || agentUser.actorType === 'agent';
  const agentRow = isAgent
    ? await db.get('SELECT * FROM agent_accounts WHERE agent_id = ?', [agentUser.id])
    : null;
  let usedSlots = 0;
  let forfeitedSlots = 0;
  let maxSlots = STEWARD_DEFAULTS.starterDormantSlots;

  if (isAgent) {
    const slotUsage = await computeAgentSlotUsage(db, agentUser.id);
    maxSlots = slotUsage.maxSlots;
    usedSlots = slotUsage.usedSlots;
    forfeitedSlots = slotUsage.forfeitedSlots;
    if (usedSlots >= maxSlots) {
      const forfeitNote =
        forfeitedSlots > 0
          ? ` (${forfeitedSlots} expired without human visitors and did not reopen)`
          : '';
      throw new McpServiceError(
        `Dormant claim slot limit reached (${usedSlots}/${maxSlots})${forfeitNote}. Attract a verified IRL human artist to awaken an active land and unlock +${STEWARD_DEFAULTS.slotsPerAwakenedLand} more slots.`,
        429,
        { usedSlots, forfeitedSlots, maxSlots }
      );
    }
  } else {
    maxSlots = LAND_VOLUME_LIMITS.starterFreeHumanClaims;
    const mintCapacity = await getUserMintCapacityStatus(db, agentUser.id);
    usedSlots = mintCapacity.usedSlots;
    forfeitedSlots = Number(mintCapacity.forfeitedSlots || 0);
    if (usedSlots >= maxSlots) {
      await notifyFreeLimitReached(db, {
        userSub: agentUser.id,
        usedSlots,
        maxSlots,
        unbuiltParcels: mintCapacity.unbuiltParcels
      }).catch(() => {});
      const forfeitNote =
        forfeitedSlots > 0
          ? ` (${forfeitedSlots} free slot${forfeitedSlots === 1 ? '' : 's'} expired without in-person human interaction and did not reopen)`
          : '';
      throw new McpServiceError(
        `You have used all ${usedSlots}/${maxSlots} free starter Desktop lands${forfeitNote}. Build or publish a sculpture on one of your existing lands to unlock another Desktop mint slot — or sculpt in person with Mobile AR right now to claim new land immediately!`,
        429,
        {
          code: 'STARTER_FREE_LAND_LIMIT_REACHED',
          usedSlots,
          forfeitedSlots,
          maxSlots,
          remainingSlots: 0,
          unbuiltParcels: mintCapacity.unbuiltParcels,
          canClaimInPersonMobile: true,
          nextSteps: [
            'Place or publish a sculpture on one of your existing unbuilt lands to free a Desktop mint slot.',
            'Or pair your phone and sculpt in person with Mobile AR to claim new land without waiting.'
          ]
        }
      );
    }

    const titleCheck = await checkLandTitleAvailability(db, {
      name: effectiveCustomName,
      excludeParcelId: cleanParcelId
    });
    if (!titleCheck.ok) {
      throw new McpServiceError(titleCheck.reason, 400, {
        code: 'LAND_TITLE_REQUIRED'
      });
    }
    if (!titleCheck.available) {
      throw new McpServiceError(titleCheck.reason, 409, {
        code: 'LAND_TITLE_TAKEN',
        conflictingParcelId: titleCheck.conflictingParcelId || ''
      });
    }
  }

  if (isAgent && effectiveCustomName) {
    const titleCheck = await checkLandTitleAvailability(db, {
      name: effectiveCustomName,
      excludeParcelId: cleanParcelId
    });
    if (!titleCheck.available) {
      throw new McpServiceError(titleCheck.reason, titleCheck.ok ? 409 : 400, {
        code: titleCheck.ok ? 'LAND_TITLE_TAKEN' : 'LAND_TITLE_INVALID',
        conflictingParcelId: titleCheck.conflictingParcelId || ''
      });
    }
  }

  const now = new Date().toISOString();
  const leaseExpiresAt = isAgent ? computeDormantLeaseExpiresAt(now) : '';
  const inactivityExpiresAt = isAgent ? '' : computeInactivityExpiresAt(now);
  const initialStatus = isAgent ? 'dormant' : 'awakened';

  await db.run(
    `INSERT INTO land_parcels (
      parcel_id, geohash, center_lat, center_lng,
      first_claimant_sub, first_claimant_address, latest_claimant_address,
      sculpture_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      first_claimant_sub = excluded.first_claimant_sub,
      first_claimant_address = excluded.first_claimant_address,
      latest_claimant_address = excluded.latest_claimant_address,
      updated_at = excluded.updated_at`,
    [
      cleanParcelId,
      geohash,
      resolvedVolume?.centerLat ?? bounds.center[0],
      resolvedVolume?.centerLng ?? bounds.center[1],
      agentUser.id,
      stewardAddress,
      stewardAddress,
      now
    ]
  );

  await db.run(
    `INSERT INTO land_steward_state (
      parcel_id, steward_sub, steward_address, steward_name, steward_type,
      status, claimed_at, lease_expires_at, awakened_at,
      last_human_interaction_at, last_human_interaction_type, last_human_interaction_sub,
      inactivity_expires_at, had_human_interaction,
      first_human_sub, first_human_address, human_contributor_count,
      total_tx_volume_eth, agent_royalties_eth, human_royalties_eth, platform_fees_eth, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, 0, '', '', 0, 0, 0, 0, 0, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      steward_sub = excluded.steward_sub,
      steward_address = excluded.steward_address,
      steward_name = excluded.steward_name,
      steward_type = excluded.steward_type,
      status = excluded.status,
      claimed_at = excluded.claimed_at,
      lease_expires_at = excluded.lease_expires_at,
      awakened_at = excluded.awakened_at,
      last_human_interaction_at = '',
      last_human_interaction_type = '',
      last_human_interaction_sub = '',
      inactivity_expires_at = excluded.inactivity_expires_at,
      had_human_interaction = 0,
      first_human_sub = '',
      first_human_address = '',
      human_contributor_count = 0,
      updated_at = excluded.updated_at`,
    [
      cleanParcelId,
      agentUser.id,
      stewardAddress,
      agentUser.name || (isAgent ? 'Autonomous Steward' : 'Land Creator'),
      isAgent ? 'agent' : 'human',
      initialStatus,
      now,
      leaseExpiresAt,
      isAgent ? '' : now,
      inactivityExpiresAt,
      now
    ]
  );

  if (resolvedVolume) {
    await saveLandVolumeRow(db, resolvedVolume, now);
  }

  if (effectiveCustomName || effectiveDescription) {
    await db.run(
      `INSERT INTO parcel_curations (
        parcel_id, owner_sub, owner_address, custom_name, curation_note,
        featured_sculpture_id, allow_public_ar, last_signed_tx_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', 1, '', ?)
      ON CONFLICT(parcel_id) DO UPDATE SET
        owner_sub = excluded.owner_sub,
        owner_address = excluded.owner_address,
        custom_name = COALESCE(NULLIF(excluded.custom_name, ''), parcel_curations.custom_name),
        curation_note = COALESCE(NULLIF(excluded.curation_note, ''), parcel_curations.curation_note),
        updated_at = excluded.updated_at`,
      [
        cleanParcelId,
        agentUser.id,
        stewardAddress,
        effectiveCustomName,
        effectiveDescription,
        now
      ]
    );
  }

  if (agentRow) {
    await db.run('UPDATE agent_accounts SET used_slots = ?, last_seen_at = ? WHERE agent_id = ?', [
      usedSlots + 1,
      now,
      agentUser.id
    ]);
  }

  const parcelBytes32 = ethers.keccak256(ethers.toUtf8Bytes(cleanParcelId));
  const latE6 = Math.round((resolvedVolume?.centerLat ?? bounds.center[0]) * 1e6);
  const lngE6 = Math.round((resolvedVolume?.centerLng ?? bounds.center[1]) * 1e6);
  const ttlSeconds = STEWARD_DEFAULTS.dormantLeaseTtlHours * 3600;
  const suppliedTxHash = /^0x[0-9a-fA-F]{64}$/.test(String(txHash || '').trim())
    ? String(txHash).trim()
    : '';
  const humanSimTxHash =
    !isAgent && !suppliedTxHash
      ? ethers.keccak256(ethers.toUtf8Bytes(`human-land-claim:${cleanParcelId}:${stewardAddress}:${now}`))
      : '';
  const chainTxRequest = {
    method: 'claimDormantLand',
    network: chainCfg?.network?.name || 'Robinhood Chain',
    chainId: Number(chainCfg?.network?.chainId || 46630),
    contractAddress:
      chainCfg?.contractAddress || '0x0000000000000000000000000000000000466300',
    from: stewardAddress,
    args: [parcelBytes32, stewardAddress, latE6, lngE6, ttlSeconds]
  };

  const slug = slugifyLandTitle(effectiveCustomName) || cleanParcelId.toLowerCase();
  const shareUrl = buildParcelShareUrl({
    parcelId: cleanParcelId,
    customName: effectiveCustomName,
    compact: true
  });

  const skipGeo =
    skipRemoteLookup !== undefined
      ? Boolean(skipRemoteLookup)
      : typeof process !== 'undefined' &&
        (process.env?.NODE_ENV === 'test' ||
          Boolean(process.env?.NODE_TEST_CONTEXT) ||
          process.env?.GRAFFILAND_SKIP_GEO_SEED === '1' ||
          /\.test\.mjs$/i.test(String(process.argv?.[1] || '')) ||
          (Array.isArray(process.execArgv) && process.execArgv.includes('--test')));

  const securityPolicy = await seedLandSecurityPolicy(db, {
    parcelId: cleanParcelId,
    ownerSub: agentUser.id,
    originSource: isAgent ? 'agent_mcp' : 'browser_map',
    envTier,
    lat: resolvedVolume?.centerLat ?? bounds.center[0],
    lng: resolvedVolume?.centerLng ?? bounds.center[1],
    geoInfo,
    skipRemoteLookup: skipGeo,
    timeoutMs: 1400
  }).catch(() => null);

  await notifyLandMinted(db, {
    userSub: agentUser.id,
    parcelId: cleanParcelId,
    landTitle: effectiveCustomName,
    txHash: suppliedTxHash || humanSimTxHash,
    volume: resolvedVolume
  }).catch(() => {});

  return {
    claimed: true,
    protocolFeeEth: 0,
    gasSponsored: !isAgent,
    gasPaidBy: isAgent ? 'agent' : 'platform-relayer',
    txHash: suppliedTxHash || humanSimTxHash,
    chainTxRequest,
    parcelId: cleanParcelId,
    geohash,
    customName: effectiveCustomName,
    description: effectiveDescription,
    curationNote: effectiveDescription,
    slug,
    shareUrl,
    status: initialStatus,
    leaseExpiresAt,
    inactivityExpiresAt,
    hadHumanInteraction: false,
    requiresInPersonVisit: true,
    permanentOwnership: false,
    bounds,
    volume: resolvedVolume,
    securityPolicy,
    limits: LAND_VOLUME_LIMITS,
    slots: {
      usedSlots: usedSlots + 1,
      forfeitedSlots,
      maxSlots,
      remaining: Math.max(0, maxSlots - usedSlots - 1)
    }
  };
}

/**
 * Updates 3D dimensions, Z-axis scale, and rotation of an owned Virtual Land parcel.
 */
export async function updateLandVolume(db, { parcelId, user, volume }) {
  if (!user) throw new McpServiceError('Sign-in required.', 401);
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  const currentRow = await db
    .get('SELECT * FROM land_volumes WHERE parcel_id = ?', [parcelCtx.parcelId])
    .catch(() => null);

  const volCheck = validateAndNormalizeLandVolume({
    lat: volume?.centerLat ?? volume?.lat ?? currentRow?.center_lat ?? parcelCtx.bounds.center[0],
    lng: volume?.centerLng ?? volume?.lng ?? currentRow?.center_lng ?? parcelCtx.bounds.center[1],
    widthMeters: volume?.widthMeters ?? currentRow?.width_meters,
    depthMeters: volume?.depthMeters ?? currentRow?.depth_meters,
    heightMeters: volume?.heightMeters ?? (volume?.zScale !== undefined ? undefined : currentRow?.height_meters),
    zScale: volume?.zScale,
    rotationDeg: volume?.rotationDeg ?? currentRow?.rotation_deg,
    baseAltitudeM: volume?.baseAltitudeM ?? currentRow?.base_altitude_m,
    parcelId: parcelCtx.parcelId,
    geohash: parcelCtx.geohash
  });

  if (!volCheck.ok) {
    throw new McpServiceError(volCheck.errors[0], 400, {
      errors: volCheck.errors,
      limits: LAND_VOLUME_LIMITS
    });
  }

  await assertNoFootprintOverlap(db, volCheck.volume);
  const now = new Date().toISOString();
  await saveLandVolumeRow(db, volCheck.volume, now);
  return { parcelId: parcelCtx.parcelId, volume: volCheck.volume };
}

/**
 * Publishes or updates an Art Quest on a stewarded Virtual Land with snappable plinth slots.
 */
export async function createArtQuest(
  db,
  {
    parcelId,
    user,
    title,
    prompt,
    theme = 'open',
    bountyEth = 0,
    maxCompletions = 10,
    slotOffsets = []
  }
) {
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user });
  const cleanTitle = String(title || '').trim().replace(/[\r\n]+/g, ' ');
  const cleanPrompt = String(prompt || '').trim();
  if (cleanTitle.length < 3 || cleanTitle.length > 80) {
    throw new McpServiceError('Quest title must be between 3 and 80 characters.', 400);
  }
  if (cleanPrompt.length < 6 || cleanPrompt.length > 320) {
    throw new McpServiceError('Quest prompt must be between 6 and 320 characters.', 400);
  }
  const cleanBountyEth = Math.max(0, Number(bountyEth || 0));
  const cleanBountyStr = cleanBountyEth.toFixed(6).replace(/\.?0+$/, '') || '0';
  const bountyWei = ethers.parseEther(cleanBountyStr).toString();
  const cap = Math.max(1, Math.min(100, Math.round(Number(maxCompletions || 10))));

  const normalizedSlots = (Array.isArray(slotOffsets) ? slotOffsets : [])
    .slice(0, 16)
    .map((slot, i) => ({
      id: String(slot?.id || `plinth-${i + 1}`).slice(0, 48),
      label: String(slot?.label || `Plinth Slot ${i + 1}`).slice(0, 48),
      dx: Number(slot?.dx || 0),
      dy: Number(slot?.dy || 0),
      dz: Number(slot?.dz || 0),
      yaw: Number(slot?.yaw || 0),
      claimedBySculptureId: ''
    }));

  const now = new Date().toISOString();
  const questId = `qst_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  await db.run(
    `INSERT INTO land_quests (
      id, parcel_id, steward_sub, title, prompt, theme, bounty_wei, bounty_eth,
      slot_offsets_json, max_completions, completions_count, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?)`,
    [
      questId,
      parcelCtx.parcelId,
      user.id,
      cleanTitle,
      cleanPrompt,
      String(theme || 'open').slice(0, 32),
      bountyWei,
      cleanBountyEth,
      JSON.stringify(normalizedSlots),
      cap,
      now,
      now
    ]
  );

  const row = await db.get('SELECT * FROM land_quests WHERE id = ?', [questId]);
  const stewardRow = await db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [
    parcelCtx.parcelId
  ]);
  const curRow = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [
    parcelCtx.parcelId
  ]);
  return serializeQuestRow(row, stewardRow, curRow, parcelCtx.parcelRow);
}

/**
 * Atomically places multiple stage prefabs, voxels, or 3D models on an agent's parcel (`steward_stage`)
 * and optionally launches an Art Quest in the same call.
 */
export async function batchBuildLand(
  db,
  {
    agentUser,
    parcelId,
    items = [],
    customName,
    curationNote,
    quest = null,
    pinSculptureFn,
    mintSculptureFn
  }
) {
  const parcelCtx = await checkParcelOwnership(db, { parcelId, user: agentUser });
  const landSettingsRow = await db
    .get('SELECT freeze_placements FROM land_settings WHERE parcel_id = ?', [parcelCtx.parcelId])
    .catch(() => null);
  if (landSettingsRow && Number(landSettingsRow.freeze_placements) === 1) {
    const landLabel = await getLatestParcelDisplayName(db, parcelCtx.parcelId);
    throw new McpServiceError(
      `Virtual Land "${landLabel}" is frozen — unfreeze it in Land Settings before placing new items.`,
      403
    );
  }
  const ownerAddress = resolvePreferredOwnerWallet(agentUser);
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
    throw new McpServiceError('Provide between 1 and 10 items in batch_build_land.', 400);
  }

  const now = new Date().toISOString();
  if (customName !== undefined || curationNote !== undefined) {
    await db.run(
      `INSERT INTO parcel_curations (
        parcel_id, owner_sub, owner_address, custom_name, curation_note,
        featured_sculpture_id, allow_public_ar, last_signed_tx_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', 1, '', ?)
      ON CONFLICT(parcel_id) DO UPDATE SET
        custom_name = COALESCE(NULLIF(excluded.custom_name, ''), parcel_curations.custom_name),
        curation_note = COALESCE(NULLIF(excluded.curation_note, ''), parcel_curations.curation_note),
        updated_at = excluded.updated_at`,
      [
        parcelCtx.parcelId,
        agentUser.id,
        ownerAddress,
        String(customName || '').trim().slice(0, 48),
        String(curationNote || '').trim().slice(0, 240),
        now
      ]
    );
  }

  const built = [];
  const generatedSlots = [];
  const chainTxRequests = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    let payload = {
      title: item.title || `${item.prefab || 'Stage'} Module #${i + 1}`,
      description:
        item.description || 'Autonomous steward stage architecture awaiting IRL artist collaboration.',
      anchorOffset: item.anchorOffset || { dx: 0, dy: 0, dz: 0, yaw: 0 },
      lat: item.lat,
      lng: item.lng,
      altitude: item.altitude,
      previewDataUrl: item.previewDataUrl,
      txHash: String(item.txHash || '').trim()
    };

    if (item.prefab) {
      const gen = generateVoxelPrefab({
        prefab: item.prefab,
        primaryColor: item.primaryColor,
        accentColor: item.accentColor,
        material: item.material,
        accentMaterial: item.accentMaterial,
        widthBlocks: item.widthBlocks,
        heightBlocks: item.heightBlocks,
        offset: item.anchorOffset,
        label: item.slotLabel || payload.title
      });
      payload.voxels = gen.voxels;
      generatedSlots.push(gen.suggestedPlinthSlot);
    } else if (item.modelFormat) {
      payload = {
        ...payload,
        modelFormat: item.modelFormat,
        ...(item.modelBase64 ? { modelBase64: item.modelBase64 } : {}),
        ...(item.modelData ? { modelData: item.modelData } : {}),
        ...(item.modelUrl ? { modelUrl: item.modelUrl } : {}),
        modelScale: item.modelScale,
        modelRotationY: item.modelRotationY
      };
    } else {
      payload.voxels = item.voxels;
    }

    const res = await applyCreateSculptureOnLand(db, {
      parcelCtx,
      ownerUser: agentUser,
      ownerAddress,
      payload,
      proofSeed: `batch-${i}-${Date.now()}`,
      pinSculptureFn,
      mintSculptureFn,
      layerRole: item.layerRole === 'artist_work' ? 'artist_work' : 'steward_stage'
    });
    built.push(res.sculpture);
    if (res.mint?.chainTxRequest) {
      chainTxRequests.push({
        sculptureId: res.sculpture.id,
        title: res.sculpture.title,
        ...res.mint.chainTxRequest
      });
    }
  }

  let createdQuest = null;
  if (quest && quest.title && quest.prompt) {
    const slotOffsets =
      Array.isArray(quest.slotOffsets) && quest.slotOffsets.length > 0
        ? quest.slotOffsets
        : generatedSlots;
    createdQuest = await createArtQuest(db, {
      parcelId: parcelCtx.parcelId,
      user: agentUser,
      title: quest.title,
      prompt: quest.prompt,
      theme: quest.theme || 'open',
      bountyEth: quest.bountyEth || 0,
      maxCompletions: quest.maxCompletions || 10,
      slotOffsets
    });
  }

  return {
    parcelId: parcelCtx.parcelId,
    builtCount: built.length,
    gasSponsored: false,
    gasPaidBy: 'agent',
    sculptures: built,
    chainTxRequests,
    suggestedSlotOffsets: generatedSlots,
    quest: createdQuest
  };
}

/**
 * Lists open quests sorted by proximity & Awakening Rush (dormant) priority.
 */
export async function listNearbyQuests(
  db,
  { lat = null, lng = null, radiusMeters = 25000, status = 'open' } = {}
) {
  await releaseExpiredDormantLands(db);

  const statusClause = status && status !== 'all' ? 'WHERE q.status = ?' : '';
  const rows = await db.all(
    `SELECT q.*,
            st.steward_name, st.steward_type, st.status AS land_status,
            st.lease_expires_at, st.human_contributor_count,
            pc.custom_name, lp.center_lat, lp.center_lng
     FROM land_quests q
     LEFT JOIN land_steward_state st ON st.parcel_id = q.parcel_id
     LEFT JOIN parcel_curations pc ON pc.parcel_id = q.parcel_id
     LEFT JOIN land_parcels lp ON lp.parcel_id = q.parcel_id
     ${statusClause}
     ORDER BY CASE WHEN st.status = 'dormant' THEN 0 ELSE 1 END, q.created_at DESC`,
    status && status !== 'all' ? [status] : []
  );

  const hasCoord =
    lat !== null &&
    lat !== undefined &&
    lat !== '' &&
    lng !== null &&
    lng !== undefined &&
    lng !== '' &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng));
  const refLat = hasCoord ? Number(lat) : null;
  const refLng = hasCoord ? Number(lng) : null;

  let quests = (rows || []).map((r) => {
    const q = serializeQuestRow(
      r,
      {
        steward_name: r.steward_name,
        steward_type: r.steward_type,
        status: r.land_status,
        lease_expires_at: r.lease_expires_at,
        human_contributor_count: r.human_contributor_count
      },
      { custom_name: r.custom_name },
      { center_lat: r.center_lat, center_lng: r.center_lng }
    );
    q.distanceMeters =
      hasCoord && Number.isFinite(Number(r.center_lat)) && Number.isFinite(Number(r.center_lng))
        ? Math.round(haversineMeters(refLat, refLng, r.center_lat, r.center_lng) * 10) / 10
        : null;
    return q;
  });

  if (hasCoord) {
    quests = quests
      .filter((q) => q.distanceMeters === null || q.distanceMeters <= radiusMeters)
      .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  }

  return { quests };
}

/**
 * Processes an IRL verified mobile sculpture publish: tags `artist_work`, awakens dormant agent parcels,
 * unlocks +2 agent slots, awards XP, claims plinth slot, and records 2% contributor pool eligibility.
 */
export async function awakenParcelByHumanVisit(
  db,
  {
    parcelId,
    sculptureId,
    artistUser,
    artistAddress,
    voxelCount = 0,
    isCustomModel = false,
    questId = '',
    plinthSlotId = '',
    platformAddress = ''
  }
) {
  const cleanParcel = normalizeParcelId(parcelId);
  const now = new Date().toISOString();
  const qualifiesForPool = Boolean(isCustomModel) || Number(voxelCount || 0) >= STEWARD_DEFAULTS.minHumanPoolVoxels;
  const isHumanActor = !String(artistUser?.id || '').startsWith('agent:');

  await db.run(
    `INSERT INTO sculpture_layers (
      sculpture_id, parcel_id, layer_role, quest_id, plinth_slot_id, agent_id, qual_contributor, created_at, updated_at
    ) VALUES (?, ?, 'artist_work', ?, ?, '', ?, ?, ?)
    ON CONFLICT(sculpture_id) DO UPDATE SET
      layer_role = 'artist_work',
      quest_id = excluded.quest_id,
      plinth_slot_id = excluded.plinth_slot_id,
      qual_contributor = excluded.qual_contributor,
      updated_at = excluded.updated_at`,
    [
      sculptureId,
      cleanParcel,
      String(questId || ''),
      String(plinthSlotId || ''),
      qualifiesForPool ? 1 : 0,
      now,
      now
    ]
  );

  const steward = await db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [cleanParcel]);
  let awakenedNow = false;
  let slotsUnlockedForAgent = 0;

  // Land minted from manual human Mobile AR art (or upgraded by physical human art on a
  // pre-claimed map/agent land) is immediately permanently owned with NO expiry timer.
  if (!steward || steward.status === 'archived' || steward.status === 'expired') {
    await db.run(
      `INSERT INTO land_steward_state (
        parcel_id, steward_sub, steward_address, steward_name, steward_type,
        status, claimed_at, lease_expires_at, awakened_at,
        last_human_interaction_at, last_human_interaction_type, last_human_interaction_sub,
        inactivity_expires_at, had_human_interaction,
        first_human_sub, first_human_address, human_contributor_count,
        total_tx_volume_eth, agent_royalties_eth, human_royalties_eth, platform_fees_eth, updated_at
      ) VALUES (?, ?, ?, ?, 'human', 'awakened', ?, '', ?, ?, 'irl_publish', ?, '', 1, ?, ?, ?, 0, 0, 0, 0, ?)
      ON CONFLICT(parcel_id) DO UPDATE SET
        steward_sub = excluded.steward_sub,
        steward_address = excluded.steward_address,
        steward_name = excluded.steward_name,
        steward_type = 'human',
        status = 'awakened',
        claimed_at = excluded.claimed_at,
        lease_expires_at = '',
        awakened_at = excluded.awakened_at,
        last_human_interaction_at = excluded.last_human_interaction_at,
        last_human_interaction_type = 'irl_publish',
        last_human_interaction_sub = excluded.last_human_interaction_sub,
        inactivity_expires_at = '',
        had_human_interaction = 1,
        first_human_sub = excluded.first_human_sub,
        first_human_address = excluded.first_human_address,
        human_contributor_count = excluded.human_contributor_count,
        updated_at = excluded.updated_at`,
      [
        cleanParcel,
        artistUser.id,
        artistAddress,
        artistUser.name || 'Human Pioneer',
        now,
        now,
        now,
        artistUser.id,
        artistUser.id,
        artistAddress,
        qualifiesForPool ? 1 : 0,
        now
      ]
    );
  } else if (steward.status === 'dormant' && qualifiesForPool && isHumanActor) {
    awakenedNow = true;
    await db.run(
      `UPDATE land_steward_state
       SET status = 'awakened',
           awakened_at = ?,
           lease_expires_at = '',
           last_human_interaction_at = ?,
           last_human_interaction_type = 'irl_publish',
           last_human_interaction_sub = ?,
           inactivity_expires_at = '',
           had_human_interaction = 1,
           first_human_sub = ?,
           first_human_address = ?,
           updated_at = ?
       WHERE parcel_id = ?`,
      [now, now, artistUser.id, artistUser.id, artistAddress, now, cleanParcel]
    );

    if (steward.steward_sub && steward.steward_sub.startsWith('agent:')) {
      slotsUnlockedForAgent = STEWARD_DEFAULTS.slotsPerAwakenedLand;
      const usageAfter = await computeAgentSlotUsage(db, steward.steward_sub);
      await db.run(
        `UPDATE agent_accounts
         SET max_slots = MIN(?, max_slots + ?),
             used_slots = ?,
             activated_lands_count = activated_lands_count + 1,
             total_xp = total_xp + ?,
             reputation_score = reputation_score + 25,
             last_seen_at = ?
         WHERE agent_id = ?`,
        [
          STEWARD_DEFAULTS.maxDormantSlots,
          STEWARD_DEFAULTS.slotsPerAwakenedLand,
          usageAfter.usedSlots,
          STEWARD_DEFAULTS.agentAwakenXp,
          now,
          steward.steward_sub
        ]
      );
    }
  } else if (
    steward.status === 'awakened' &&
    isHumanActor &&
    (qualifiesForPool || steward.steward_type === 'human')
  ) {
    // Physical human AR art clears any pre-minted countdown timer permanently -> fully minted & owned.
    await db.run(
      `UPDATE land_steward_state
       SET lease_expires_at = '',
           awakened_at = COALESCE(NULLIF(awakened_at, ''), ?),
           last_human_interaction_at = ?,
           last_human_interaction_type = 'irl_publish',
           last_human_interaction_sub = ?,
           inactivity_expires_at = '',
           had_human_interaction = 1,
           first_human_sub = COALESCE(NULLIF(first_human_sub, ''), ?),
           first_human_address = COALESCE(NULLIF(first_human_address, ''), ?),
           updated_at = ?
       WHERE parcel_id = ?`,
      [now, now, artistUser.id, artistUser.id, artistAddress, now, cleanParcel]
    );
  }

  let questCompleted = null;
  let claimedSlotId = String(plinthSlotId || '');
  let bountyPaidEth = 0;

  let activeQuest = questId
    ? await db.get(`SELECT * FROM land_quests WHERE id = ? AND parcel_id = ? AND status = 'open'`, [
        questId,
        cleanParcel
      ])
    : null;
  if (!activeQuest) {
    activeQuest = await db.get(
      `SELECT * FROM land_quests WHERE parcel_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1`,
      [cleanParcel]
    );
  }

  const xpAwarded = awakenedNow
    ? STEWARD_DEFAULTS.firstSparkXpHuman
    : qualifiesForPool
    ? STEWARD_DEFAULTS.humanQuestBaseXp
    : 40;

  if (activeQuest && qualifiesForPool && isHumanActor) {
    const slots = parseSlotOffsets(activeQuest.slot_offsets_json);
    if (slots.length > 0) {
      let targetIdx = claimedSlotId ? slots.findIndex((s) => s.id === claimedSlotId && !s.claimedBySculptureId) : -1;
      if (targetIdx === -1) {
        targetIdx = slots.findIndex((s) => !s.claimedBySculptureId);
      }
      if (targetIdx !== -1) {
        slots[targetIdx].claimedBySculptureId = sculptureId;
        claimedSlotId = slots[targetIdx].id;
      }
    }
    const nextCount = Number(activeQuest.completions_count || 0) + 1;
    const nextStatus = nextCount >= Number(activeQuest.max_completions || 10) ? 'fulfilled' : 'open';

    await db.run(
      `UPDATE land_quests
       SET completions_count = ?, status = ?, slot_offsets_json = ?, updated_at = ?
       WHERE id = ?`,
      [nextCount, nextStatus, JSON.stringify(slots), now, activeQuest.id]
    );

    if (Number(activeQuest.bounty_eth || 0) > 0) {
      const contributors = await getParcelQualifiedHumanContributors(db, cleanParcel);
      const splits = calculateFeeSplitBreakdown(activeQuest.bounty_eth, {
        sellerAddress: artistAddress,
        platformAddress,
        agentStewardAddress: steward?.steward_address || platformAddress,
        humanContributors: contributors
      });
      bountyPaidEth = splits.seller.amountEth;
      await recordFeeLedgerSplit(db, {
        txType: 'quest_bounty',
        parcelId: cleanParcel,
        sculptureId,
        txHash: '',
        splits,
        stewardSub: steward?.steward_sub || '',
        stewardName: steward?.steward_name || ''
      });
      await db.run(
        `UPDATE land_steward_state
         SET total_tx_volume_eth = total_tx_volume_eth + ?,
             agent_royalties_eth = agent_royalties_eth + ?,
             human_royalties_eth = human_royalties_eth + ?,
             platform_fees_eth = platform_fees_eth + ?,
             updated_at = ?
         WHERE parcel_id = ?`,
        [
          splits.grossEth,
          splits.agentSteward.amountEth,
          splits.humanContributors.poolEth,
          splits.platform.amountEth,
          now,
          cleanParcel
        ]
      );
    }

    await db.run(
      `INSERT INTO land_quest_completions (
        id, quest_id, parcel_id, sculpture_id, artist_sub, artist_name, artist_address,
        plinth_slot_id, voxel_count, qualifies_for_pool, xp_awarded, awakened_parcel, bounty_paid_eth, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        globalThis.crypto.randomUUID(),
        activeQuest.id,
        cleanParcel,
        sculptureId,
        artistUser.id,
        artistUser.name || '',
        artistAddress,
        claimedSlotId,
        Number(voxelCount || 0),
        xpAwarded,
        awakenedNow ? 1 : 0,
        bountyPaidEth,
        now
      ]
    );
    questCompleted = {
      questId: activeQuest.id,
      title: activeQuest.title,
      plinthSlotClaimed: claimedSlotId,
      bountyPaidEth
    };
  }

  const contribRow = await db.get(
    `SELECT COUNT(DISTINCT s.creator_sub) AS cnt
     FROM sculptures s
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     WHERE s.parcel_id = ?
       AND s.hidden = 0
       AND s.creator_sub NOT LIKE 'agent:%'
       AND COALESCE(l.layer_role, 'artist_work') = 'artist_work'
       AND COALESCE(l.qual_contributor, 1) = 1`,
    [cleanParcel]
  );
  const humanCount = Number(contribRow?.cnt || 0);
  await db.run(
    'UPDATE land_steward_state SET human_contributor_count = ?, updated_at = ? WHERE parcel_id = ?',
    [humanCount, now, cleanParcel]
  );

  // Emit land-owner & mint-slot-unlocked notifications cleanly (non-blocking)
  try {
    const scMeta = await db
      .get('SELECT title FROM sculptures WHERE id = ?', [sculptureId])
      .catch(() => null);
    const visibleCntRow = await db
      .get('SELECT COUNT(*) AS cnt FROM sculptures WHERE parcel_id = ? AND hidden = 0', [cleanParcel])
      .catch(() => null);
    const wasPreviouslyEmpty = Number(visibleCntRow?.cnt || 0) <= 1;
    await notifyAfterSculpturePublished(db, {
      parcelId: cleanParcel,
      sculptureId,
      sculptureTitle: scMeta?.title || 'New Sculpture',
      creatorSub: artistUser?.id || '',
      creatorName: resolveAuthorHandleForStorage(artistUser, 'Creator'),
      awakenedParcel: awakenedNow,
      wasPreviouslyEmpty
    });
  } catch {
    // Non-fatal notification failure must never break publish
  }

  return {
    parcelId: cleanParcel,
    awakenedParcel: awakenedNow,
    slotsUnlockedForAgent,
    qualifiesForContributorPool: qualifiesForPool,
    minVoxelsRequired: STEWARD_DEFAULTS.minHumanPoolVoxels,
    contributorPoolPercent: 2,
    humanContributorCount: humanCount,
    xpAwarded,
    questCompleted
  };
}

export async function getLandTelemetry(db, parcelId) {
  await releaseExpiredDormantLands(db);
  const cleanParcel = normalizeParcelId(parcelId);
  const steward = await db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [cleanParcel]);
  const curation = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [cleanParcel]);
  const parcel = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcel]);
  if (!steward && !parcel) {
    throw new McpServiceError(`Virtual Land ${cleanParcel} not found.`, 404);
  }
  const quests = await db.all(
    `SELECT * FROM land_quests WHERE parcel_id = ? ORDER BY created_at DESC`,
    [cleanParcel]
  );
  const layerCounts = await db.all(
    `SELECT COALESCE(l.layer_role, 'artist_work') AS role, COUNT(*) AS cnt
     FROM sculptures s
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     WHERE s.parcel_id = ? AND s.hidden = 0
     GROUP BY role`,
    [cleanParcel]
  );
  const counts = Object.fromEntries((layerCounts || []).map((r) => [r.role, Number(r.cnt || 0)]));
  const [contributors, securityPolicy] = await Promise.all([
    getParcelQualifiedHumanContributors(db, cleanParcel),
    getLandSecurityPolicy(db, cleanParcel)
  ]);

  return {
    parcelId: cleanParcel,
    customName: curation?.custom_name || '',
    displayName: resolveLandDisplayName({ customName: curation?.custom_name || '' }),
    curationNote: curation?.curation_note || '',
    securityPolicy,
    steward: steward
      ? {
          stewardSub: steward.steward_sub,
          stewardName: steward.steward_name,
          stewardAddress: steward.steward_address,
          stewardType: steward.steward_type,
          status: steward.status,
          claimedAt: steward.claimed_at,
          leaseExpiresAt: steward.lease_expires_at,
          inactivityExpiresAt: steward.inactivity_expires_at || '',
          lastHumanInteractionAt: steward.last_human_interaction_at || '',
          lastHumanInteractionType: steward.last_human_interaction_type || '',
          hadHumanInteraction: Number(steward.had_human_interaction || 0) === 1,
          awakenedAt: steward.awakened_at
        }
      : null,
    layers: {
      stewardStageCount: counts.steward_stage || 0,
      artistWorkCount: counts.artist_work || 0
    },
    qualifiedHumanContributors: contributors,
    economics: {
      totalVolumeEth: Number(steward?.total_tx_volume_eth || 0),
      platformFeesEth: Number(steward?.platform_fees_eth || 0),
      agentRoyaltiesEth: Number(steward?.agent_royalties_eth || 0),
      humanRoyaltiesEth: Number(steward?.human_royalties_eth || 0)
    },
    quests: (quests || []).map((q) => serializeQuestRow(q, steward, curation, parcel))
  };
}
