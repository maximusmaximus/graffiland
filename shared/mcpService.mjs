import { buildAgentSpec } from './agentService.mjs';
import { getAgentProfile } from './agentAuthService.mjs';
import {
  batchBuildLand,
  claimDormantLand,
  createArtQuest,
  getLandTelemetry,
  scoutLands
} from './agentQuestService.mjs';
import { listArchivedLands } from './landArchiveService.mjs';
import {
  buyLandDeed,
  getLandDeedSummary,
  listLandDeedForSale,
  transferLandDeed
} from './landDeedService.mjs';
import { getLandSecurityPolicy } from './landmarkService.mjs';
import { generateVoxelPrefab } from './proceduralSculpt.mjs';
import { sanitizeVoxels, validatePublishPayload } from '../server/services/moderation.mjs';
import { serializeSculptureRow } from './sculpture.mjs';
import { extractCustomModelInput, validate3dModelUrl } from './model3d.mjs';
import {
  resolveCatalogItemReference,
  search3dAssetCatalog
} from './catalogSearchService.mjs';
import { buildParcelShareUrl, slugifyLandTitle } from './landVolume.mjs';
import { buildPublicProfileUrl } from './profileRules.mjs';
import { getPublicProfile, updateUserProfile } from './profileService.mjs';
import {
  McpServiceError,
  checkParcelOwnership,
  checkSculptureEditPermission,
  checkSculptureOrLandOwnership,
  checkSculptureOwnership,
  isUserLandOwner,
  isUserParcelContributor,
  normalizeParcelId,
  resolveParcelPlacementAccess,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses,
  upsertAnchorAndRevision,
  validateEditableTitleAndDescription
} from './mcp/helpers.mjs';
import { MCP_TOOLS } from './mcp/toolSchemas.mjs';
import {
  DEFAULT_MCP_PAIRING_TTL_HOURS,
  connectMcpPairing,
  createMcpPairing,
  disconnectMcpPairing,
  listMcpPairings,
  requireActiveMcpPairing
} from './mcp/pairingService.mjs';
import {
  addLandChatWhitelistMember,
  addLandContributor,
  applyCreateSculptureOnLand,
  directOwnerDeleteSculpture,
  directOwnerEraseLand,
  directOwnerRollbackRevision,
  directOwnerSetSculptureVisibility,
  directOwnerUpdateParcel,
  directOwnerUpdateSculpture,
  getLandSettingsInternal,
  getMyLandsWorkspace,
  getPublicParcelDetail,
  inspectParcelFitForModel,
  listLandChatWhitelist,
  listLandContributorsAndEligible,
  listLandsWithCurations,
  listOwnerLandsAndSculptures,
  listSculptureRevisions,
  preflightCreateSculptureOnLand,
  preflightUpdateSculpture,
  removeLandChatWhitelistMember,
  removeLandContributor,
  updateLandSettings,
  upsertSculptureModelRow
} from './mcp/landMutations.mjs';
import {
  compactSignaturePayload,
  compactSignatureRequestsMaintenance,
  compactSignatureResult,
  createPublishSignatureRequestForMobile,
  enqueueGuestProposalForLandOwner,
  enqueueSignatureRequest,
  getSignatureRequest,
  getSignatureRequestPreviewModel,
  handlePairedLandMutationViaMcp,
  listPendingSignaturesForUser,
  listSignatureHistoryForUser,
  rejectSignatureRequest,
  signRequestByAgent,
  signRequestByMobile
} from './mcp/signatureService.mjs';

export async function directOwnerCreateSculptureOnLand(
  db,
  {
    parcelId,
    user,
    body,
    pinSculptureFn,
    mintSculptureFn,
    notifyMobileFn = null,
    stagedBlobStore = null
  }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const access = await resolveParcelPlacementAccess(db, { parcelId, user });
  if (access.mode === 'guest_requires_owner_approval') {
    await preflightCreateSculptureOnLand(db, {
      parcelCtx: access.parcelCtx,
      payload: body || {}
    });
    return enqueueGuestProposalForLandOwner(db, {
      parcelCtx: access.parcelCtx,
      landOwnerUser: access.landOwnerUser,
      landOwnerAddress: access.landOwnerAddress,
      proposerUser: user,
      payload: body || {},
      agentName: '',
      notifyMobileFn,
      stagedBlobStore
    });
  }
  const ownerAddress = resolvePreferredOwnerWallet(user);
  return applyCreateSculptureOnLand(db, {
    parcelCtx: access.parcelCtx,
    ownerUser: user,
    ownerAddress,
    payload: body || {},
    pinSculptureFn,
    mintSculptureFn,
    proofSeed: `direct:${user.id}`,
    isLandOwner: access.isOwner
  });
}

export {
  DEFAULT_MCP_PAIRING_TTL_HOURS,
  MCP_TOOLS,
  McpServiceError,
  addLandChatWhitelistMember,
  addLandContributor,
  checkParcelOwnership,
  checkSculptureEditPermission,
  checkSculptureOrLandOwnership,
  checkSculptureOwnership,
  compactSignaturePayload,
  compactSignatureRequestsMaintenance,
  compactSignatureResult,
  connectMcpPairing,
  createMcpPairing,
  createPublishSignatureRequestForMobile,
  directOwnerDeleteSculpture,
  directOwnerEraseLand,
  directOwnerRollbackRevision,
  directOwnerSetSculptureVisibility,
  directOwnerUpdateParcel,
  directOwnerUpdateSculpture,
  disconnectMcpPairing,
  enqueueGuestProposalForLandOwner,
  getLandSettingsInternal,
  getMyLandsWorkspace,
  getPublicParcelDetail,
  getSignatureRequest,
  getSignatureRequestPreviewModel,
  inspectParcelFitForModel,
  isUserLandOwner,
  isUserParcelContributor,
  listLandChatWhitelist,
  listLandContributorsAndEligible,
  listLandsWithCurations,
  listMcpPairings,
  listPendingSignaturesForUser,
  listSculptureRevisions,
  listSignatureHistoryForUser,
  rejectSignatureRequest,
  removeLandChatWhitelistMember,
  removeLandContributor,
  requireActiveMcpPairing,
  resolveParcelPlacementAccess,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses,
  signRequestByAgent,
  signRequestByMobile,
  updateLandSettings,
  upsertAnchorAndRevision,
  upsertSculptureModelRow
};

export async function handleMcpJsonRpc(
  db,
  {
    rpcBody,
    pairingCode,
    callerUser = null,
    apiOrigin = '',
    pinSculptureFn,
    mintSculptureFn,
    notifyMobileFn,
    emitMetadataUpdateFn = null,
    stagedBlobStore = null
  }
) {
  const id = rpcBody?.id ?? null;
  const method = String(rpcBody?.method || '');
  const params = rpcBody?.params || {};
  const effectiveCode =
    pairingCode || params?.pairingCode || params?.arguments?.pairingCode || '';

  let pairing;
  let ownerUser;
  if (!effectiveCode && callerUser?.actorType === 'agent') {
    ownerUser = callerUser;
    pairing = {
      code: 'DIRECT-AGENT-WALLET',
      ownerAddress: callerUser.wallet_address,
      mcpActive: true,
      keyConnected: true,
      agentName: callerUser.name || 'Autonomous Steward',
      agentAddress: callerUser.wallet_address
    };
  } else {
    const active = await requireActiveMcpPairing(db, {
      pairingCode: effectiveCode,
      callerUser
    });
    pairing = active.pairing;
    ownerUser = active.ownerUser;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'graffiland-mcp', version: '1.0.0' },
        capabilities: { tools: {} },
        pairing: {
          code: pairing.code,
          ownerAddress: pairing.ownerAddress,
          mcpActive: true,
          keyConnected: pairing.keyConnected
        }
      }
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'tools/call') {
    const toolName = String(params?.name || '');
    const args = params?.arguments || {};
    let toolResult;

    if (toolName === 'get_spec') {
      toolResult = buildAgentSpec(apiOrigin);
    } else if (toolName === 'get_my_profile') {
      const publicOrigin = 'https://spray.land';
      const detail = await getPublicProfile(db, {
        identifier: ownerUser.username || ownerUser.id,
        origin: publicOrigin,
        pathname: '/',
        viewerUserId: ownerUser.id
      });
      const shareUrl =
        detail?.profile?.profileUrl ||
        (detail?.profile?.username && detail?.profile?.profilePublic !== false
          ? buildPublicProfileUrl({
              origin: publicOrigin,
              pathname: '/',
              username: detail.profile.username
            })
          : '');
      toolResult = {
        ok: true,
        shareUrl,
        pairingCode: pairing.code,
        ...detail
      };
    } else if (toolName === 'update_profile') {
      const hasAnyField =
        args.username !== undefined ||
        args.bio !== undefined ||
        args.avatarImage !== undefined ||
        args.headerImage !== undefined ||
        typeof args.profilePublic === 'boolean';
      if (!hasAnyField) {
        throw new McpServiceError(
          'Provide at least one profile field to update (username, bio, avatarImage, headerImage, or profilePublic).',
          400
        );
      }
      let updatedRow;
      try {
        updatedRow = await updateUserProfile(db, {
          user: ownerUser,
          ...(args.username !== undefined ? { username: args.username } : {}),
          ...(args.bio !== undefined ? { bio: args.bio } : {}),
          ...(args.avatarImage !== undefined ? { avatarImage: args.avatarImage } : {}),
          ...(args.headerImage !== undefined ? { headerImage: args.headerImage } : {}),
          ...(typeof args.profilePublic === 'boolean' ? { profilePublic: args.profilePublic } : {})
        });
      } catch (err) {
        throw new McpServiceError(
          err?.message || 'Failed to update profile.',
          Number(err?.statusCode) || 400
        );
      }
      const publicOrigin = 'https://spray.land';
      const detail = await getPublicProfile(db, {
        identifier: updatedRow?.username || ownerUser.id,
        origin: publicOrigin,
        pathname: '/',
        viewerUserId: ownerUser.id
      });
      const shareUrl =
        detail?.profile?.profileUrl ||
        (detail?.profile?.username && detail?.profile?.profilePublic !== false
          ? buildPublicProfileUrl({
              origin: publicOrigin,
              pathname: '/',
              username: detail.profile.username
            })
          : '');
      toolResult = {
        ok: true,
        updatedBy: pairing.agentName || 'paired-agent',
        pairingCode: pairing.code,
        shareUrl,
        profile: detail.profile,
        stats: detail.stats
      };
    } else if (toolName === 'list_my_lands') {
      toolResult = await listOwnerLandsAndSculptures(db, ownerUser);
    } else if (toolName === 'get_land') {
      const parcelId = normalizeParcelId(args.parcelId);
      const isOwner = await isUserLandOwner(db, { parcelId, user: ownerUser });
      const isContributor = !isOwner
        ? await isUserParcelContributor(db, { parcelId, user: ownerUser })
        : false;
      const showHidden = Boolean(args.includeHidden && isOwner);
      const rows = await db.all(
        `SELECT s.*,
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
         LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
         LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
         LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
         WHERE s.parcel_id = ? ${showHidden ? '' : 'AND s.hidden = 0'}
         ORDER BY s.created_at ASC`,
        [parcelId]
      );
      const cur = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [parcelId]);
      const [settings, securityPolicy] = await Promise.all([
        getLandSettingsInternal(db, parcelId),
        getLandSecurityPolicy(db, parcelId)
      ]);
      const slug = slugifyLandTitle(cur?.custom_name || '') || parcelId.toLowerCase();
      toolResult = {
        parcelId,
        customName: cur?.custom_name || '',
        description: cur?.curation_note || '',
        curationNote: cur?.curation_note || '',
        slug,
        shareUrl: buildParcelShareUrl({
          parcelId,
          customName: cur?.custom_name || '',
          compact: true
        }),
        settings,
        securityPolicy,
        permissions: {
          isOwner,
          isContributor,
          frozen: Boolean(settings.frozen),
          requireApproval: Boolean(settings.requireApproval),
          canPlaceDirectly:
            !settings.frozen && (isOwner || isContributor || !settings.requireApproval),
          requiresOwnerApproval:
            !settings.frozen && !isOwner && !isContributor && Boolean(settings.requireApproval)
        },
        curation: cur
          ? {
              customName: cur.custom_name,
              description: cur.curation_note,
              curationNote: cur.curation_note,
              slug,
              featuredSculptureId: cur.featured_sculpture_id,
              lastSignedTxHash: cur.last_signed_tx_hash
            }
          : null,
        sculptures: (rows || []).map((r) =>
          serializeSculptureRow(r, {
            includeVoxels: true,
            viewerIsLandOwner: isOwner,
            parcelFrozen: settings.frozen
          })
        )
      };
    } else if (toolName === 'search_3d_catalog') {
      toolResult = await search3dAssetCatalog({
        query: args.query ?? args.q ?? '',
        source: args.source || 'all',
        limit: args.limit ?? 12,
        apiOrigin
      });
    } else if (toolName === 'validate_3d_model_url') {
      const catItem = args.catalogItemId
        ? resolveCatalogItemReference({ catalogItemId: args.catalogItemId, apiOrigin })
        : null;
      if (args.catalogItemId && !catItem) {
        throw new McpServiceError(
          `Invalid catalogItemId "${args.catalogItemId}". Expected simready:<id>, pixels:<id>, or xeroemoji:<id>.`,
          400
        );
      }
      const targetModelUrl = String(args.modelUrl || catItem?.modelUrl || '').trim();
      const checked = await validate3dModelUrl(targetModelUrl, {
        formatHint: args.modelFormat || catItem?.modelFormat || ''
      });
      let landFit = null;
      if (checked.valid && args.parcelId) {
        landFit = await inspectParcelFitForModel(db, {
          parcelId: args.parcelId,
          bbox: checked.stats?.bbox || null,
          modelScale: Number(args.modelScale ?? 1),
          anchorOffset: args.anchorOffset || {}
        });
      }
      toolResult = {
        valid: checked.valid,
        error: checked.error || null,
        format: checked.format || '',
        mimeType: checked.mimeType || '',
        byteLength: checked.byteLength || 0,
        stats: checked.stats || null,
        suggestedTitle: catItem?.title || checked.suggestedTitle || '',
        modelUrl: targetModelUrl,
        ...(catItem ? { catalogItem: catItem } : {}),
        ...(landFit ? { landFit } : {})
      };
    } else if (toolName === 'get_parcel_share_link') {
      const detail = await getPublicParcelDetail(db, { parcelOrSlug: args.parcelId });
      const lat = detail.parcel.centerLat;
      const lng = detail.parcel.centerLng;
      toolResult = {
        parcelId: detail.parcel.parcelId,
        customName: detail.parcel.customName,
        description: detail.parcel.description,
        slug: detail.parcel.slug,
        shareUrl: detail.shareUrl,
        directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}`,
        frozen: Boolean(detail.parcel.frozen),
        centerLat: lat,
        centerLng: lng,
        sculptureCount: detail.sculptures.length
      };
    } else if (toolName === 'put_sculpture_on_land' || toolName === 'load_3d_model_on_land') {
      const modelCheck = extractCustomModelInput(args);
      if (modelCheck.error) throw new McpServiceError(modelCheck.error, 400);
      if (toolName === 'load_3d_model_on_land' && !modelCheck.provided) {
        throw new McpServiceError(
          'Provide a valid 3D model (modelFormat + modelBase64 / modelData / modelUrl).',
          400
        );
      }

      const modelPayloadFields = modelCheck.provided
        ? {
            modelFormat: modelCheck.customModel.format,
            ...(args.catalogItemId || args.model?.catalogItemId
              ? { catalogItemId: args.catalogItemId || args.model?.catalogItemId }
              : {}),
            ...(args.modelBase64 || args.model?.dataBase64
              ? { modelBase64: args.modelBase64 || args.model?.dataBase64 }
              : {}),
            ...(args.modelData || args.model?.data || args.model?.dataText
              ? { modelData: args.modelData || args.model?.data || args.model?.dataText }
              : {}),
            ...(args.modelUrl || args.model?.url || modelCheck.customModel.externalUrl
              ? { modelUrl: args.modelUrl || args.model?.url || modelCheck.customModel.externalUrl }
              : {}),
            modelScale: modelCheck.customModel.scale,
            modelRotationY: modelCheck.customModel.rotationY
          }
        : {};

      if (toolName === 'load_3d_model_on_land' && args.sculptureId) {
        const parcelCtx = await checkParcelOwnership(db, { parcelId: args.parcelId, user: ownerUser });
        const perm = await checkSculptureOrLandOwnership(db, {
          sculptureId: args.sculptureId,
          user: ownerUser,
          allowHidden: true
        });
        const scRow = perm.row;
        if (scRow.parcel_id !== parcelCtx.parcelId) {
          throw new McpServiceError('Sculpture does not belong to target parcelId.', 400);
        }
        const checkedMeta = validateEditableTitleAndDescription({
          title: args.title !== undefined ? args.title : scRow.title,
          description: args.description !== undefined ? args.description : scRow.description
        });
        const updatePayload = {
          title: checkedMeta.title,
          description: checkedMeta.description,
          ...modelPayloadFields,
          ...(args.expectedRev !== undefined ? { expectedRev: args.expectedRev } : {}),
          ...(args.anchorOffset !== undefined ? { anchorOffset: args.anchorOffset } : {}),
          ...(args.previewDataUrl ? { previewDataUrl: args.previewDataUrl } : {})
        };
        await preflightUpdateSculpture(db, { sculptureRow: scRow, payload: updatePayload });
        toolResult = await handlePairedLandMutationViaMcp(db, {
          pairing,
          ownerUser,
          action: 'update_sculpture',
          parcelId: parcelCtx.parcelId,
          sculptureId: scRow.id,
          payload: updatePayload,
          signature: args.signature || '',
          auth: args.auth || null,
          txHash: args.txHash || '',
          pinSculptureFn,
          mintSculptureFn,
          notifyMobileFn,
          emitMetadataUpdateFn,
          stagedBlobStore
        });
      } else {
        const access = await resolveParcelPlacementAccess(db, {
          parcelId: args.parcelId,
          user: ownerUser
        });
        const parcelCtx = access.parcelCtx;
        let createPayload;
        if (modelCheck.provided) {
          const checkedMeta = validateEditableTitleAndDescription({
            title: args.title,
            description: args.description
          });
          createPayload = {
            title: checkedMeta.title,
            description: checkedMeta.description,
            ...modelPayloadFields,
            anchorOffset: args.anchorOffset,
            lat: args.lat,
            lng: args.lng,
            altitude: args.altitude,
            previewDataUrl: args.previewDataUrl,
            ...(args.txHash ? { txHash: args.txHash } : {})
          };
        } else {
          const validation = validatePublishPayload({
            title: args.title,
            description: args.description,
            termsAccepted: true,
            voxels: args.voxels
          });
          if (!validation.ok) {
            throw new McpServiceError(validation.errors[0], 400, { errors: validation.errors });
          }
          createPayload = {
            title: validation.title,
            description: validation.description,
            voxels: validation.cleanVoxels,
            anchorOffset: args.anchorOffset,
            lat: args.lat,
            lng: args.lng,
            altitude: args.altitude,
            previewDataUrl: args.previewDataUrl,
            ...(args.txHash ? { txHash: args.txHash } : {})
          };
        }
        await preflightCreateSculptureOnLand(db, { parcelCtx, payload: createPayload });
        if (access.mode === 'guest_requires_owner_approval') {
          toolResult = await enqueueGuestProposalForLandOwner(db, {
            parcelCtx,
            landOwnerUser: access.landOwnerUser,
            landOwnerAddress: access.landOwnerAddress,
            proposerUser: ownerUser,
            payload: createPayload,
            agentName: pairing.agentName || 'paired-agent',
            notifyMobileFn,
            stagedBlobStore
          });
        } else {
          toolResult = await handlePairedLandMutationViaMcp(db, {
            pairing,
            ownerUser,
            action: 'create_sculpture',
            parcelId: parcelCtx.parcelId,
            payload: createPayload,
            signature: args.signature || '',
            auth: args.auth || null,
            txHash: args.txHash || '',
            pinSculptureFn,
            mintSculptureFn,
            notifyMobileFn,
            stagedBlobStore
          });
        }
      }
    } else if (toolName === 'update_land_sculpture') {
      const perm = await checkSculptureOrLandOwnership(db, {
        sculptureId: args.sculptureId,
        user: ownerUser,
        allowHidden: true
      });
      const scRow = perm.row;
      const checkedMeta = validateEditableTitleAndDescription({
        title: args.title !== undefined ? args.title : scRow.title,
        description: args.description !== undefined ? args.description : scRow.description
      });
      const modelCheck = extractCustomModelInput(args);
      if (modelCheck.error) throw new McpServiceError(modelCheck.error, 400);
      let nextVoxels;
      if (!modelCheck.provided && args.voxels !== undefined) {
        const voxelRes = sanitizeVoxels(args.voxels);
        if (voxelRes.errors.length > 0) {
          throw new McpServiceError(voxelRes.errors[0], 400, { errors: voxelRes.errors });
        }
        nextVoxels = voxelRes.cleanVoxels;
      }
      const updatePayload = {
        title: checkedMeta.title,
        description: checkedMeta.description,
        ...(args.expectedRev !== undefined ? { expectedRev: args.expectedRev } : {}),
        ...(args.anchorOffset !== undefined ? { anchorOffset: args.anchorOffset } : {}),
        ...(nextVoxels ? { voxels: nextVoxels } : {}),
        ...(modelCheck.provided
          ? {
              modelFormat: modelCheck.customModel.format,
              ...(args.modelBase64 || args.model?.dataBase64
                ? { modelBase64: args.modelBase64 || args.model?.dataBase64 }
                : {}),
              ...(args.modelData || args.model?.data || args.model?.dataText
                ? { modelData: args.modelData || args.model?.data || args.model?.dataText }
                : {}),
              ...(args.modelUrl || args.model?.url ? { modelUrl: args.modelUrl || args.model?.url } : {}),
              modelScale: modelCheck.customModel.scale,
              modelRotationY: modelCheck.customModel.rotationY
            }
          : {}),
        ...(args.previewDataUrl ? { previewDataUrl: args.previewDataUrl } : {})
      };
      await preflightUpdateSculpture(db, { sculptureRow: scRow, payload: updatePayload });
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'update_sculpture',
        parcelId: scRow.parcel_id,
        sculptureId: scRow.id,
        payload: updatePayload,
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn,
        emitMetadataUpdateFn,
        stagedBlobStore
      });
    } else if (toolName === 'update_land_parcel') {
      const parcelCtx = await checkParcelOwnership(db, { parcelId: args.parcelId, user: ownerUser });
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'update_parcel',
        parcelId: parcelCtx.parcelId,
        payload: {
          customName: args.customName,
          description: args.description,
          curationNote: args.curationNote,
          featuredSculptureId: args.featuredSculptureId
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'update_land_volume') {
      const parcelCtx = await checkParcelOwnership(db, { parcelId: args.parcelId, user: ownerUser });
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'update_land_volume',
        parcelId: parcelCtx.parcelId,
        payload: {
          volume: {
            ...(args.centerLat !== undefined ? { centerLat: args.centerLat } : {}),
            ...(args.centerLng !== undefined ? { centerLng: args.centerLng } : {}),
            ...(args.widthMeters !== undefined ? { widthMeters: args.widthMeters } : {}),
            ...(args.depthMeters !== undefined ? { depthMeters: args.depthMeters } : {}),
            ...(args.heightMeters !== undefined ? { heightMeters: args.heightMeters } : {}),
            ...(args.zScale !== undefined ? { zScale: args.zScale } : {}),
            ...(args.rotationDeg !== undefined ? { rotationDeg: args.rotationDeg } : {})
          }
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'delete_land_sculpture') {
      const perm = await checkSculptureOrLandOwnership(db, {
        sculptureId: args.sculptureId,
        user: ownerUser
      });
      const scRow = perm.row;
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'delete_sculpture',
        parcelId: scRow.parcel_id,
        sculptureId: scRow.id,
        payload: { sculptureId: scRow.id },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'set_sculpture_visibility') {
      const perm = await checkSculptureOrLandOwnership(db, {
        sculptureId: args.sculptureId,
        user: ownerUser,
        allowHidden: true
      });
      const scRow = perm.row;
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'set_sculpture_visibility',
        parcelId: scRow.parcel_id,
        sculptureId: scRow.id,
        payload: {
          sculptureId: scRow.id,
          hidden: Boolean(args.hidden),
          reason: String(args.reason || '').slice(0, 160)
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'update_land_settings') {
      const parcelCtx = await checkParcelOwnership(db, { parcelId: args.parcelId, user: ownerUser });
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'update_land_settings',
        parcelId: parcelCtx.parcelId,
        payload: {
          ...(args.frozen !== undefined ? { frozen: Boolean(args.frozen) } : {}),
          ...(args.allowContributorEdits !== undefined
            ? { allowContributorEdits: Boolean(args.allowContributorEdits) }
            : {}),
          ...(args.allowAgentErase !== undefined
            ? { allowAgentErase: Boolean(args.allowAgentErase) }
            : {}),
          ...(args.requireApproval !== undefined
            ? { requireApproval: Boolean(args.requireApproval) }
            : {}),
          ...(args.chatAccessMode !== undefined
            ? { chatAccessMode: String(args.chatAccessMode) }
            : {})
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'manage_land_chat_whitelist') {
      const action = String(args.action || 'list').trim().toLowerCase();
      if (action === 'add') {
        toolResult = await addLandChatWhitelistMember(db, {
          parcelId: args.parcelId,
          user: ownerUser,
          body: {
            userId: args.userId,
            username: args.username,
            email: args.email,
            walletAddress: args.walletAddress
          }
        });
      } else if (action === 'remove') {
        let removeSub = String(args.userId || '').trim();
        if (!removeSub) {
          const currentList = await listLandChatWhitelist(db, {
            parcelId: args.parcelId,
            user: ownerUser
          });
          const cleanHandle = String(args.username || '').replace(/^@+/, '').trim().toLowerCase();
          const cleanEmail = String(args.email || '').trim().toLowerCase();
          const cleanWallet = String(args.walletAddress || '').trim().toLowerCase();
          const match = (currentList.whitelist || []).find(
            (m) =>
              (cleanHandle && m.username?.toLowerCase() === cleanHandle) ||
              (cleanEmail && m.email?.toLowerCase() === cleanEmail) ||
              (cleanWallet && m.walletAddress?.toLowerCase() === cleanWallet)
          );
          removeSub = match?.userSub || '';
        }
        toolResult = await removeLandChatWhitelistMember(db, {
          parcelId: args.parcelId,
          userSub: removeSub,
          user: ownerUser
        });
      } else {
        toolResult = await listLandChatWhitelist(db, {
          parcelId: args.parcelId,
          user: ownerUser
        });
      }
    } else if (toolName === 'rollback_sculpture_revision') {
      const perm = await checkSculptureOrLandOwnership(db, {
        sculptureId: args.sculptureId,
        user: ownerUser,
        allowHidden: true
      });
      const scRow = perm.row;
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'rollback_sculpture',
        parcelId: scRow.parcel_id,
        sculptureId: scRow.id,
        payload: { sculptureId: scRow.id, revNum: Number(args.revNum) },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn,
        emitMetadataUpdateFn
      });
    } else if (toolName === 'erase_land') {
      const parcelCtx = await checkParcelOwnership(db, { parcelId: args.parcelId, user: ownerUser });
      if (args.confirmParcelId && normalizeParcelId(args.confirmParcelId) !== parcelCtx.parcelId) {
        throw new McpServiceError(`confirmParcelId mismatch: expected ${parcelCtx.parcelId}.`, 400);
      }
      const settings = await getLandSettingsInternal(db, parcelCtx.parcelId);
      if (!settings.allowAgentErase) {
        throw new McpServiceError(
          `Agent land erasure is disabled by the holder of Virtual Land ${parcelCtx.parcelId}.`,
          403
        );
      }
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'erase_land',
        parcelId: parcelCtx.parcelId,
        payload: { parcelId: parcelCtx.parcelId, reason: String(args.reason || '').slice(0, 160) },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'list_pending_signatures') {
      toolResult = await listPendingSignaturesForUser(db, { user: ownerUser });
    } else if (toolName === 'sign_and_execute_pending') {
      toolResult = await signRequestByAgent(db, {
        requestId: args.requestId,
        pairingCode: pairing.code,
        signature: args.signature,
        txHash: args.txHash || '',
        agentName: pairing.agentName,
        pinSculptureFn,
        mintSculptureFn,
        emitMetadataUpdateFn,
        stagedBlobStore
      });
    } else if (toolName === 'agent_profile') {
      toolResult =
        ownerUser?.actorType === 'agent'
          ? await getAgentProfile(db, ownerUser.id)
          : {
              actorType: 'human-paired',
              userId: ownerUser.id,
              name: ownerUser.name,
              walletAddress: resolvePreferredOwnerWallet(ownerUser),
              pairingCode: pairing.code
            };
    } else if (toolName === 'scout_lands') {
      toolResult = await scoutLands(db, {
        lat: args.lat,
        lng: args.lng,
        radiusMeters: args.radiusMeters ?? 5000,
        statusFilter: args.statusFilter || 'all'
      });
    } else if (toolName === 'claim_land') {
      toolResult = await claimDormantLand(db, {
        agentUser: ownerUser,
        parcelId: args.parcelId || '',
        lat: args.lat,
        lng: args.lng,
        customName: args.customName || '',
        description: args.description || '',
        curationNote: args.curationNote || '',
        volume: args.volume || null,
        txHash: args.txHash || ''
      });
    } else if (toolName === 'generate_voxel_prefab') {
      toolResult = generateVoxelPrefab(args);
    } else if (toolName === 'batch_build_land') {
      toolResult = await batchBuildLand(db, {
        agentUser: ownerUser,
        parcelId: args.parcelId,
        items: args.items || [],
        customName: args.customName,
        curationNote: args.curationNote,
        quest: args.quest || null,
        pinSculptureFn,
        mintSculptureFn
      });
    } else if (toolName === 'create_art_quest') {
      toolResult = await createArtQuest(db, {
        parcelId: args.parcelId,
        user: ownerUser,
        title: args.title,
        prompt: args.prompt,
        theme: args.theme || 'open',
        bountyEth: args.bountyEth || 0,
        maxCompletions: args.maxCompletions || 10,
        slotOffsets: args.slotOffsets || []
      });
    } else if (toolName === 'get_land_telemetry') {
      toolResult = await getLandTelemetry(db, args.parcelId);
    } else if (toolName === 'list_archived_lands') {
      toolResult = await listArchivedLands(db, {
        q: args.q || '',
        reason: args.reason || '',
        limit: args.limit || 30
      });
    } else if (toolName === 'get_land_deed') {
      toolResult = await getLandDeedSummary(db, {
        parcelId: args.parcelId,
        callerUser: ownerUser
      });
    } else if (toolName === 'transfer_land_deed') {
      const isAutonomousAgent =
        ownerUser?.actorType === 'agent' ||
        Boolean(ownerUser?.is_agent) ||
        String(ownerUser?.id || '').startsWith('agent:');
      if (isAutonomousAgent) {
        toolResult = await transferLandDeed(db, {
          parcelId: args.parcelId,
          callerUser: ownerUser,
          toAddress: args.toAddress,
          includeOwnedArtworks: Boolean(args.includeOwnedArtworks)
        });
      } else {
        // Human Approval Guard: paired agents acting on a human's Land Deed MUST obtain explicit human approval
        const summary = await getLandDeedSummary(db, {
          parcelId: args.parcelId,
          callerUser: ownerUser
        });
        if (!summary.eligible || !summary.deed) {
          throw new McpServiceError(
            summary.eligibilityReason || 'This land does not have a permanent Land Deed NFT yet.',
            409
          );
        }
        if (!summary.isOwner) {
          throw new McpServiceError('Paired human owner does not hold this Land Deed NFT.', 403);
        }
        if (!args.toAddress || !/^0x[0-9a-fA-F]{40}$/.test(String(args.toAddress).trim())) {
          throw new McpServiceError('A valid 0x destination EVM address is required.', 400);
        }
        const reqItem = await enqueueSignatureRequest(db, {
          pairingCode: pairing.code,
          ownerUser,
          ownerAddress: summary.deed.ownerAddress || resolvePreferredOwnerWallet(ownerUser),
          action: 'transfer_land_deed',
          parcelId: summary.parcelId,
          payload: {
            parcelId: summary.parcelId,
            toAddress: String(args.toAddress).trim(),
            includeOwnedArtworks: Boolean(args.includeOwnedArtworks)
          },
          requestedBy: 'agent',
          agentName: pairing.agentName || 'paired-agent'
        });
        notifyMobileFn?.({
          userId: ownerUser.id,
          type: 'signature_request',
          request: reqItem
        });
        toolResult = {
          status: 'pending_human_approval',
          requiresHumanApproval: true,
          parcelId: summary.parcelId,
          requestId: reqItem.id,
          request: reqItem,
          message:
            'Land Deed NFT transfer requires explicit human owner approval in the SPRAY.LAND mobile/web approval hub.'
        };
      }
    } else if (toolName === 'list_land_for_sale') {
      const isAutonomousAgent =
        ownerUser?.actorType === 'agent' ||
        Boolean(ownerUser?.is_agent) ||
        String(ownerUser?.id || '').startsWith('agent:');
      if (isAutonomousAgent) {
        toolResult = await listLandDeedForSale(db, {
          parcelId: args.parcelId,
          sellerUser: ownerUser,
          priceEth: Number(args.priceEth),
          includeSellerArtworks: Boolean(args.includeSellerArtworks)
        });
      } else {
        const summary = await getLandDeedSummary(db, {
          parcelId: args.parcelId,
          callerUser: ownerUser
        });
        if (!summary.eligible || !summary.deed) {
          throw new McpServiceError(
            summary.eligibilityReason || 'This land does not have a permanent Land Deed NFT yet.',
            409
          );
        }
        if (!summary.isOwner) {
          throw new McpServiceError('Paired human owner does not hold this Land Deed NFT.', 403);
        }
        const priceEth = Number(args.priceEth);
        if (!Number.isFinite(priceEth) || priceEth <= 0) {
          throw new McpServiceError('priceEth must be greater than 0.', 400);
        }
        const reqItem = await enqueueSignatureRequest(db, {
          pairingCode: pairing.code,
          ownerUser,
          ownerAddress: summary.deed.ownerAddress || resolvePreferredOwnerWallet(ownerUser),
          action: 'list_land_for_sale',
          parcelId: summary.parcelId,
          payload: {
            parcelId: summary.parcelId,
            priceEth,
            includeSellerArtworks: Boolean(args.includeSellerArtworks)
          },
          requestedBy: 'agent',
          agentName: pairing.agentName || 'paired-agent'
        });
        notifyMobileFn?.({
          userId: ownerUser.id,
          type: 'signature_request',
          request: reqItem
        });
        toolResult = {
          status: 'pending_human_approval',
          requiresHumanApproval: true,
          parcelId: summary.parcelId,
          requestId: reqItem.id,
          request: reqItem,
          message:
            'Listing a human-owned Land Deed NFT for sale requires explicit human approval.'
        };
      }
    } else if (toolName === 'buy_land_deed') {
      toolResult = await buyLandDeed(db, {
        listingId: args.listingId,
        buyerUser: ownerUser,
        buyerAddress: args.buyerAddress || '',
        txHash: args.txHash || ''
      });
    } else {
      throw new McpServiceError(`Unknown MCP tool: ${toolName}`, 404);
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(toolResult) }],
        structuredContent: toolResult
      }
    };
  }

  throw new McpServiceError(`Unsupported MCP method: ${method}`, 400);
}
