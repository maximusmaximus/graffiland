import { buildAgentSpec } from './agentService.mjs';
import { sanitizeVoxels, validatePublishPayload } from '../server/services/moderation.mjs';
import { serializeSculptureRow } from './sculpture.mjs';
import { extractCustomModelInput } from './model3d.mjs';
import {
  McpServiceError,
  checkParcelOwnership,
  checkSculptureEditPermission,
  checkSculptureOwnership,
  isUserParcelContributor,
  normalizeParcelId,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses,
  upsertAnchorAndRevision,
  validateEditableTitleAndDescription
} from './mcp/helpers.mjs';
import { MCP_TOOLS } from './mcp/toolSchemas.mjs';
import {
  connectMcpPairing,
  createMcpPairing,
  disconnectMcpPairing,
  listMcpPairings,
  requireActiveMcpPairing
} from './mcp/pairingService.mjs';
import {
  addLandContributor,
  directOwnerCreateSculptureOnLand,
  directOwnerDeleteSculpture,
  directOwnerEraseLand,
  directOwnerRollbackRevision,
  directOwnerUpdateParcel,
  directOwnerUpdateSculpture,
  getLandSettingsInternal,
  getMyLandsWorkspace,
  listLandContributorsAndEligible,
  listLandsWithCurations,
  listOwnerLandsAndSculptures,
  listSculptureRevisions,
  removeLandContributor,
  updateLandSettings
} from './mcp/landMutations.mjs';
import {
  createPublishSignatureRequestForMobile,
  getSignatureRequest,
  handlePairedLandMutationViaMcp,
  listPendingSignaturesForUser,
  rejectSignatureRequest,
  signRequestByAgent,
  signRequestByMobile
} from './mcp/signatureService.mjs';

export {
  MCP_TOOLS,
  McpServiceError,
  addLandContributor,
  checkParcelOwnership,
  checkSculptureEditPermission,
  checkSculptureOwnership,
  connectMcpPairing,
  createMcpPairing,
  createPublishSignatureRequestForMobile,
  directOwnerCreateSculptureOnLand,
  directOwnerDeleteSculpture,
  directOwnerEraseLand,
  directOwnerRollbackRevision,
  directOwnerUpdateParcel,
  directOwnerUpdateSculpture,
  disconnectMcpPairing,
  getMyLandsWorkspace,
  getSignatureRequest,
  isUserParcelContributor,
  listLandContributorsAndEligible,
  listLandsWithCurations,
  listMcpPairings,
  listPendingSignaturesForUser,
  listSculptureRevisions,
  rejectSignatureRequest,
  removeLandContributor,
  requireActiveMcpPairing,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses,
  signRequestByAgent,
  signRequestByMobile,
  updateLandSettings,
  upsertAnchorAndRevision
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
    emitMetadataUpdateFn = null
  }
) {
  const id = rpcBody?.id ?? null;
  const method = String(rpcBody?.method || '');
  const params = rpcBody?.params || {};
  const effectiveCode =
    pairingCode || params?.pairingCode || params?.arguments?.pairingCode || '';

  const { pairing, ownerUser } = await requireActiveMcpPairing(db, {
    pairingCode: effectiveCode,
    callerUser
  });

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
    } else if (toolName === 'list_my_lands') {
      toolResult = await listOwnerLandsAndSculptures(db, ownerUser);
    } else if (toolName === 'get_land') {
      const parcelId = normalizeParcelId(args.parcelId);
      const rows = await db.all(
        `SELECT s.*,
          m.model_format AS custom_model_format, m.mime_type AS custom_model_mime,
          m.source_type AS custom_model_source_type, m.model_url AS custom_model_url,
          m.model_cid AS custom_model_cid, m.model_uri AS custom_model_uri,
          m.scale AS custom_model_scale, m.rotation_y AS custom_model_rotation_y,
          m.byte_length AS custom_model_bytes,
          a.dx AS anchor_dx, a.dy AS anchor_dy, a.dz AS anchor_dz, a.yaw AS anchor_yaw,
          a.current_rev AS current_rev, a.last_erc4906_tx_hash AS last_erc4906_tx_hash,
          a.mesh_stats_json AS mesh_stats_json
         FROM sculptures s
         LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
         LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
         WHERE s.parcel_id = ? AND s.hidden = 0
         ORDER BY s.created_at ASC`,
        [parcelId]
      );
      const cur = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [parcelId]);
      const settings = await getLandSettingsInternal(db, parcelId);
      toolResult = {
        parcelId,
        settings,
        curation: cur
          ? {
              customName: cur.custom_name,
              curationNote: cur.curation_note,
              featuredSculptureId: cur.featured_sculpture_id,
              lastSignedTxHash: cur.last_signed_tx_hash
            }
          : null,
        sculptures: (rows || []).map((r) => serializeSculptureRow(r, { includeVoxels: true }))
      };
    } else if (toolName === 'put_sculpture_on_land' || toolName === 'load_3d_model_on_land') {
      const parcelCtx = await checkParcelOwnership(db, { parcelId: args.parcelId, user: ownerUser });
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
            ...(args.modelBase64 || args.model?.dataBase64
              ? { modelBase64: args.modelBase64 || args.model?.dataBase64 }
              : {}),
            ...(args.modelData || args.model?.data || args.model?.dataText
              ? { modelData: args.modelData || args.model?.data || args.model?.dataText }
              : {}),
            ...(args.modelUrl || args.model?.url
              ? { modelUrl: args.modelUrl || args.model?.url }
              : {}),
            modelScale: modelCheck.customModel.scale,
            modelRotationY: modelCheck.customModel.rotationY
          }
        : {};

      if (toolName === 'load_3d_model_on_land' && args.sculptureId) {
        const scRow = await checkSculptureOwnership(db, { sculptureId: args.sculptureId, user: ownerUser });
        if (scRow.parcel_id !== parcelCtx.parcelId) {
          throw new McpServiceError('Sculpture does not belong to target parcelId.', 400);
        }
        const checkedMeta = validateEditableTitleAndDescription({
          title: args.title !== undefined ? args.title : scRow.title,
          description: args.description !== undefined ? args.description : scRow.description
        });
        toolResult = await handlePairedLandMutationViaMcp(db, {
          pairing,
          ownerUser,
          action: 'update_sculpture',
          parcelId: parcelCtx.parcelId,
          sculptureId: scRow.id,
          payload: {
            title: checkedMeta.title,
            description: checkedMeta.description,
            ...modelPayloadFields,
            ...(args.expectedRev !== undefined ? { expectedRev: args.expectedRev } : {}),
            ...(args.anchorOffset !== undefined ? { anchorOffset: args.anchorOffset } : {}),
            ...(args.previewDataUrl ? { previewDataUrl: args.previewDataUrl } : {})
          },
          signature: args.signature || '',
          auth: args.auth || null,
          txHash: args.txHash || '',
          pinSculptureFn,
          mintSculptureFn,
          notifyMobileFn,
          emitMetadataUpdateFn
        });
      } else {
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
            previewDataUrl: args.previewDataUrl
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
            previewDataUrl: args.previewDataUrl
          };
        }
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
          notifyMobileFn
        });
      }
    } else if (toolName === 'update_land_sculpture') {
      const scRow = await checkSculptureOwnership(db, { sculptureId: args.sculptureId, user: ownerUser });
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
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'update_sculpture',
        parcelId: scRow.parcel_id,
        sculptureId: scRow.id,
        payload: {
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
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn,
        emitMetadataUpdateFn
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
    } else if (toolName === 'delete_land_sculpture') {
      const scRow = await checkSculptureOwnership(db, { sculptureId: args.sculptureId, user: ownerUser });
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
    } else if (toolName === 'rollback_sculpture_revision') {
      const scRow = await checkSculptureOwnership(db, { sculptureId: args.sculptureId, user: ownerUser });
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
        emitMetadataUpdateFn
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
