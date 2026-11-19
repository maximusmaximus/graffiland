import { ethers } from 'ethers';
import { POLICY } from '../constants.mjs';
import { consumeDraftOnPublish } from '../draftService.mjs';
import { sanitizeVoxels, validatePublishPayload } from '../../server/services/moderation.mjs';
import { decodeGeohashBounds, encodeGeohash } from '../../server/services/pol.mjs';
import { computeVerticalBounds, serializeSculptureRow } from '../sculpture.mjs';
import {
  b64ToModelBytes,
  extractCustomModelInput,
  INLINE_MODEL_DB_MAX_BYTES,
  modelBytesToB64,
  validateAnchorOffset
} from '../model3d.mjs';
import { getLandSecurityPolicy } from '../landmarkService.mjs';
import {
  McpServiceError,
  checkParcelOwnership,
  checkSculptureEditPermission,
  checkSculptureOwnership,
  fetchSculptureWithModelRow,
  normalizeParcelId,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses,
  upsertAnchorAndRevision,
  validateEditableTitleAndDescription
} from './helpers.mjs';

export async function listLandsWithCurations(db) {
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

  const scMap = new Map((scRows || []).map((r) => [r.parcel_id, r]));
  const lpMap = new Map((lpRows || []).map((r) => [r.parcel_id, r]));
  const stewardMap = new Map((stewardRows || []).map((r) => [r.parcel_id, r]));
  const questMap = new Map((questCounts || []).map((r) => [r.parcel_id, Number(r.cnt || 0)]));
  const curationMap = new Map((curations || []).map((c) => [c.parcel_id, c]));

  const allParcelIds = new Set([...scMap.keys(), ...lpMap.keys()]);
  const parcels = [];

  for (const parcelId of allParcelIds) {
    const sc = scMap.get(parcelId);
    const lp = lpMap.get(parcelId);
    const st = stewardMap.get(parcelId);
    const geohash = sc?.geohash || lp?.geohash || parcelId.replace(/^GLAND-/, '').toLowerCase();
    const bounds = decodeGeohashBounds(geohash);
    const first = sc
      ? await db.get(
          'SELECT recipient_address, creator_name, creator_sub FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 1',
          [parcelId]
        )
      : null;
    const cur = curationMap.get(parcelId);
    const stewardStatus = st?.status || 'awakened';
    const ownerSub = st?.steward_sub || first?.creator_sub || lp?.first_claimant_sub || '';
    const stewardType =
      st?.steward_type || (String(ownerSub).startsWith('agent:') ? 'agent' : 'human');

    parcels.push({
      parcelId,
      geohash,
      bounds,
      centerLat: bounds.center[0],
      centerLng: bounds.center[1],
      sculptureCount: Number(sc?.visible_count ?? lp?.sculpture_count ?? 0),
      firstClaimantAddress: first?.recipient_address || lp?.first_claimant_address || '',
      firstClaimantName: first?.creator_name || st?.steward_name || '',
      ownerSub,
      stewardSub: ownerSub,
      stewardName: st?.steward_name || first?.creator_name || '',
      stewardType,
      stewardStatus,
      firstSparkBoost: stewardStatus === 'dormant',
      leaseExpiresAt: st?.lease_expires_at || '',
      awakenedAt: st?.awakened_at || '',
      humanContributorCount: Number(st?.human_contributor_count || 0),
      openQuestCount: questMap.get(parcelId) || 0,
      totalVolumeEth: Number(st?.total_tx_volume_eth || 0),
      agentRoyaltiesEth: Number(st?.agent_royalties_eth || 0),
      humanRoyaltiesEth: Number(st?.human_royalties_eth || 0),
      customName: cur?.custom_name || '',
      curationNote: cur?.curation_note || '',
      featuredSculptureId: cur?.featured_sculpture_id || '',
      lastSignedTxHash: cur?.last_signed_tx_hash || '',
      latestAt: sc?.latest_at || lp?.updated_at || st?.updated_at || ''
    });
  }

  parcels.sort((a, b) => (b.sculptureCount - a.sculptureCount) || (b.latestAt || '').localeCompare(a.latestAt || ''));
  return parcels;
}

async function resolveCustomModelBytes(customModel) {
  if (!customModel || customModel.bytes) return customModel;
  let fetchUrl = customModel.externalUrl;
  if (fetchUrl.startsWith('ipfs://')) {
    fetchUrl = `https://gateway.pinata.cloud/ipfs/${fetchUrl.slice(7)}`;
  }
  let res;
  try {
    res = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new McpServiceError(`Could not download 3D model URL (${customModel.externalUrl}).`, 400);
  }
  if (!res.ok) {
    throw new McpServiceError(`Could not download 3D model URL (HTTP ${res.status}).`, 400);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const rechecked = extractCustomModelInput({
    modelFormat: customModel.format,
    modelBase64: modelBytesToB64(buf),
    modelScale: customModel.scale,
    modelRotationY: customModel.rotationY
  });
  if (rechecked.error || !rechecked.customModel) {
    throw new McpServiceError(rechecked.error || 'Downloaded URL is not a valid 3D model.', 400);
  }
  return {
    ...rechecked.customModel,
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
    updatedAt: row?.updated_at || ''
  };
}

function formatContributorRow(row) {
  return {
    id: row.id,
    parcelId: row.parcel_id,
    contributorSub: row.contributor_sub,
    email: row.contributor_email || '',
    name: row.contributor_name || 'Artist',
    walletAddress: row.contributor_address || '',
    canEditSculptures: Boolean(row.can_edit_sculptures),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findEligibleParcelVisitors(db, { parcelId, ownerSub = '' }) {
  const cleanId = normalizeParcelId(parcelId);
  const rows = await db.all(
    `SELECT DISTINCT u.id AS userId, u.email, u.name, u.wallet_address AS walletAddress,
            u.custom_payout_address AS customPayoutAddress
     FROM users u
     WHERE u.id != ?
       AND (
         EXISTS (
           SELECT 1 FROM sculpture_chat_grants g
           JOIN sculptures s ON s.id = g.sculpture_id
           WHERE s.parcel_id = ? AND g.requester_sub = u.id AND g.status = 'granted'
         )
         OR EXISTS (
           SELECT 1 FROM sculpture_chat_messages m
           JOIN sculptures s ON s.id = m.sculpture_id
           WHERE s.parcel_id = ? AND m.sender_sub = u.id
         )
         OR EXISTS (
           SELECT 1 FROM parcel_presence_challenges p
           WHERE p.parcel_id = ? AND p.user_id = u.id AND p.consumed = 1
         )
       )
     ORDER BY u.name ASC`,
    [ownerSub, cleanId, cleanId, cleanId]
  );
  return (rows || []).map((r) => ({
    userId: r.userId,
    email: r.email || '',
    name: r.name || 'Visitor',
    walletAddress: r.customPayoutAddress || r.walletAddress || ''
  }));
}

export async function listOwnerLandsAndSculptures(db, ownerUser) {
  const wallets = new Set(resolveUserWalletAddresses(ownerUser));
  const allRows = await db.all(
    `SELECT s.*,
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
      a.mesh_stats_json AS mesh_stats_json
     FROM sculptures s
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
     WHERE s.hidden = 0
     ORDER BY s.created_at DESC`
  );
  const ownedSculptures = (allRows || []).filter((r) =>
    wallets.has(String(r.recipient_address || '').toLowerCase())
  );
  const ownedParcelSet = new Set(ownedSculptures.map((s) => s.parcel_id));
  const curations = await db.all('SELECT * FROM parcel_curations');
  const curationMap = new Map((curations || []).map((c) => [c.parcel_id, c]));

  const parcels = [];
  for (const pid of ownedParcelSet) {
    const onLand = (allRows || []).filter((s) => s.parcel_id === pid);
    const cur = curationMap.get(pid);
    const settings = await getLandSettingsInternal(db, pid);
    const contribRows = await db.all(
      'SELECT * FROM land_contributors WHERE parcel_id = ? ORDER BY created_at DESC',
      [pid]
    );
    const eligibleVisitors = await findEligibleParcelVisitors(db, {
      parcelId: pid,
      ownerSub: ownerUser.id
    });
    const securityPolicy = await getLandSecurityPolicy(db, pid);
    const landmarkAnchor = await db.get(
      'SELECT parcel_id, descriptor_digest, keyframe_count, feature_count, anchor_cid, updated_at FROM parcel_landmark_anchors WHERE parcel_id = ?',
      [pid]
    );
    parcels.push({
      parcelId: pid,
      geohash: onLand[0]?.geohash || '',
      bounds: onLand[0]?.geohash ? decodeGeohashBounds(onLand[0].geohash) : null,
      customName: cur?.custom_name || '',
      curationNote: cur?.curation_note || '',
      featuredSculptureId: cur?.featured_sculpture_id || '',
      lastSignedTxHash: cur?.last_signed_tx_hash || '',
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
      sculptureCount: onLand.length,
      sculptures: onLand.map((r) => serializeSculptureRow(r, { includeVoxels: true }))
    });
  }

  return {
    ownerAddress: resolvePreferredOwnerWallet(ownerUser),
    parcelCount: parcels.length,
    sculptureCount: ownedSculptures.length,
    parcels
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

  let anchorOffset = {
    dx: Number(existingAnchor?.dx || 0),
    dy: Number(existingAnchor?.dy || 0),
    dz: Number(existingAnchor?.dz || 0),
    yaw: Number(existingAnchor?.yaw || 0)
  };
  if (payload.anchorOffset !== undefined) {
    const offRes = validateAnchorOffset(payload.anchorOffset);
    if (offRes.error) throw new McpServiceError(offRes.error, 400);
    anchorOffset = offRes.offset;
  }

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

  if (modelExtract.provided) {
    activeCustomModel = await resolveCustomModelBytes(modelExtract.customModel);
    cleanVoxels = [];
  } else if (payload.voxels !== undefined) {
    const voxelCheck = sanitizeVoxels(payload.voxels);
    if (voxelCheck.errors.length > 0) {
      throw new McpServiceError(voxelCheck.errors[0], 400, { errors: voxelCheck.errors });
    }
    cleanVoxels = voxelCheck.cleanVoxels;
    await db.run('DELETE FROM sculpture_models WHERE sculpture_id = ?', [sculptureRow.id]);
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
        scale: Number(existingModelRow.scale || 1),
        rotationY: Number(existingModelRow.rotation_y || 0)
      };
    }
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

  await upsertAnchorAndRevision(db, {
    sculptureId: sculptureRow.id,
    parcelId: sculptureRow.parcel_id,
    revNum: nextRev,
    anchorOffset,
    erc4906TxHash,
    meshStats: activeCustomModel?.stats || null,
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

  const updated = await fetchSculptureWithModelRow(db, sculptureRow.id);
  return {
    sculpture: serializeSculptureRow(updated, { includeVoxels: true }),
    revNum: nextRev,
    erc4906TxHash
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
  const modelExtract = extractCustomModelInput(payload);
  if (modelExtract.error) {
    throw new McpServiceError(modelExtract.error, 400);
  }

  let title = '';
  let description = '';
  let cleanVoxels = [];
  let activeCustomModel = null;
  let anchorOffset = { dx: 0, dy: 0, dz: 0, yaw: 0 };

  if (payload.anchorOffset !== undefined) {
    const offRes = validateAnchorOffset(payload.anchorOffset);
    if (offRes.error) throw new McpServiceError(offRes.error, 400);
    anchorOffset = offRes.offset;
  }

  if (modelExtract.provided) {
    const checkedMeta = validateEditableTitleAndDescription({
      title: payload.title,
      description: payload.description
    });
    title = checkedMeta.title;
    description = checkedMeta.description;
    activeCustomModel = await resolveCustomModelBytes(modelExtract.customModel);
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

  const lat =
    Number.isFinite(Number(payload.lat)) && Math.abs(Number(payload.lat)) <= 90
      ? Number(payload.lat)
      : parcelCtx.bounds.center[0];
  const lng =
    Number.isFinite(Number(payload.lng)) && Math.abs(Number(payload.lng)) <= 180
      ? Number(payload.lng)
      : parcelCtx.bounds.center[1];

  const coordHash = encodeGeohash(lat, lng, 8);
  if (coordHash.toUpperCase() !== parcelCtx.geohash.toUpperCase()) {
    throw new McpServiceError(
      `Coordinates (${lat}, ${lng}) lie outside owned parcel ${parcelCtx.parcelId}.`,
      400
    );
  }

  const seedSculpture = parcelCtx.visibleRows[0] || null;
  const seedPol = seedSculpture ? JSON.parse(seedSculpture.pol_json || '{}') : {};
  const verticalBounds = activeCustomModel
    ? { minY: 0, maxY: 1.5 }
    : computeVerticalBounds(cleanVoxels);
  const alt =
    Number.isFinite(Number(payload.altitude)) ? Number(payload.altitude) : seedSculpture?.altitude ?? null;
  const now = new Date().toISOString();
  const sculptureId = globalThis.crypto.randomUUID();
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

  const mintResult = await mintSculptureFn({
    recipientAddress: ownerAddress,
    metadataUri: ipfsResult.metadataUri,
    parcelBytes32,
    proofHash,
    lat,
    lng
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
      ownerUser.name,
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
    meshStats: activeCustomModel?.stats || null,
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
  return {
    sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
    mint: mintResult,
    ipfs: ipfsResult
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
    throw new McpServiceError(
      `Agent land erasure is disabled by the holder of Virtual Land ${parcelCtx.parcelId}. Enable Allow Agent Erase in Land Management first.`,
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
  const customName =
    payload.customName !== undefined
      ? String(payload.customName || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 48)
      : existing?.custom_name || '';
  const curationNote =
    payload.curationNote !== undefined
      ? String(payload.curationNote || '').trim().slice(0, 240)
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
  return {
    parcel: {
      parcelId: parcelCtx.parcelId,
      geohash: parcelCtx.geohash,
      customName: row.custom_name,
      curationNote: row.curation_note,
      featuredSculptureId: row.featured_sculpture_id,
      lastSignedTxHash: row.last_signed_tx_hash,
      updatedAt: row.updated_at
    }
  };
}

export async function applyPublishOnBehalf(
  db,
  { ownerUser, ownerAddress, payload, pinSculptureFn, mintSculptureFn, proofSignature = '' }
) {
  const locBundle = payload.locationBundle;
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
      ownerUser.name,
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
        locBundle.parcelBounds.center[0],
        locBundle.parcelBounds.center[1],
        ownerUser.id,
        ownerAddress,
        ownerAddress,
        now
      ]
    );
  }

  if (payload.draftId) {
    await consumeDraftOnPublish(db, { draftId: payload.draftId, user: ownerUser });
  }

  const saved = await db.get('SELECT * FROM sculptures WHERE id = ?', [sculptureId]);
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

  let erc4906TxHash = '';
  if (typeof emitMetadataUpdateFn === 'function') {
    try {
      const updRes = await emitMetadataUpdateFn({
        tokenId: sculptureRow.token_id,
        metadataUri: `ipfs://${revRow.ipfs_metadata_cid}`
      });
      erc4906TxHash = updRes?.txHash || '';
    } catch {}
  }

  await upsertAnchorAndRevision(db, {
    sculptureId: sculptureRow.id,
    parcelId: sculptureRow.parcel_id,
    revNum: newRev,
    anchorOffset: restoredOffset,
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
    `SELECT * FROM sculpture_revisions
     WHERE sculpture_id = ?
     ORDER BY rev_num DESC
     LIMIT 30`,
    [row.id]
  );
  return {
    sculptureId: row.id,
    parcelId: row.parcel_id,
    currentRev: Number(anchor?.current_rev || revRows?.[0]?.rev_num || 1),
    lastErc4906TxHash: anchor?.last_erc4906_tx_hash || '',
    revisions: (revRows || []).map((r) => ({
      id: r.id,
      revNum: Number(r.rev_num),
      editorSub: r.editor_sub,
      editorName: r.editor_name || 'Artist',
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
    }))
  };
}

export async function directOwnerRollbackRevision(
  db,
  { sculptureId, revNum, user, emitMetadataUpdateFn = null }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await checkSculptureOwnership(db, { sculptureId, user });
  return applyRollbackSculptureRevision(db, {
    sculptureRow: row,
    revNum,
    ownerUser: user,
    emitMetadataUpdateFn
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
  const now = new Date().toISOString();
  const ownerAddress = resolvePreferredOwnerWallet(user);

  await db.run(
    `INSERT INTO land_settings (
      parcel_id, owner_sub, owner_address, allow_agent_erase, allow_contributor_edits, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      owner_sub = excluded.owner_sub,
      owner_address = excluded.owner_address,
      allow_agent_erase = excluded.allow_agent_erase,
      allow_contributor_edits = excluded.allow_contributor_edits,
      updated_at = excluded.updated_at`,
    [
      parcelCtx.parcelId,
      user.id,
      ownerAddress,
      allowAgentErase ? 1 : 0,
      allowContributorEdits ? 1 : 0,
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
    throw new McpServiceError(
      `Only accounts that visited Virtual Land ${parcelCtx.parcelId} in person and can chat on this land can be added as Contributors.`,
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
  const row = await checkSculptureOwnership(db, { sculptureId, user });
  return applyDeleteSculpture(db, {
    sculptureRow: row,
    ownerAddress: resolvePreferredOwnerWallet(user)
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
