import { ethers } from 'ethers';
import { verifyAndEnrichLocation } from '../../server/services/pol.mjs';
import { validatePublishPayload } from '../../server/services/moderation.mjs';
import {
  buildObjectFittedLandVolume,
  resolveLandDisplayName,
  resolveMobilePublishParcel
} from '../landVolume.mjs';
import { extractCustomModelInput, validate3dModelUrl } from '../model3d.mjs';
import { computeVerticalBounds } from '../sculpture.mjs';
import {
  buildAgentSignPublishPrompt,
  buildLandActivityMessage,
  buildPublishOnBehalfMessage,
  generateRandomNonceHex,
  normalizePairingCode
} from '../landSignatureMessage.mjs';
import {
  McpServiceError,
  checkParcelOwnership,
  checkSculptureOrLandOwnership,
  hashPayloadCanonical,
  normalizeParcelId,
  resolveParcelPlacementAccess,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses
} from './helpers.mjs';
import { resolvePublicUserHandle } from '../userDisplay.mjs';
import { listMcpPairings, requireActiveMcpPairing } from './pairingService.mjs';
import { listLandDeedForSale, transferLandDeed } from '../landDeedService.mjs';
import {
  applyCreateSculptureOnLand,
  applyDeleteSculpture,
  applyEraseLand,
  applyPublishOnBehalf,
  applyRollbackSculptureRevision,
  applySetSculptureVisibility,
  applyUpdateParcel,
  applyUpdateSculpture,
  preflightCreateSculptureOnLand,
  preflightUpdateSculpture,
  updateLandSettings
} from './landMutations.mjs';
import { updateLandVolume } from '../agentQuestService.mjs';
import {
  notifyLandApprovalExecuted,
  notifyPendingLandApproval
} from '../notificationService.mjs';

export const STAGED_BLOB_TTL_SECONDS = 7200; // 2 hours (1h signature request expiry + 1h safety buffer)
const COMPACT_PAYLOAD_THRESHOLD_BYTES = 8192;
const COMPACT_RESULT_THRESHOLD_BYTES = 16384;

function extractHeavyBlobFields(payload) {
  const p = payload && typeof payload === 'object' ? { ...payload } : {};
  const heavy = {};
  let hasHeavyBlob = false;
  let hasAttachedModel = false;
  let heavyBytes = 0;

  if (typeof p.modelBase64 === 'string' && p.modelBase64.trim().length > 0) {
    heavy.modelBase64 = p.modelBase64;
    heavyBytes += p.modelBase64.length;
    delete p.modelBase64;
    hasHeavyBlob = true;
    hasAttachedModel = true;
  }
  if (typeof p.modelData === 'string' && p.modelData.trim().length > 0) {
    heavy.modelData = p.modelData;
    heavyBytes += p.modelData.length;
    delete p.modelData;
    hasHeavyBlob = true;
    hasAttachedModel = true;
  }
  if (p.model && typeof p.model === 'object') {
    const cleanModel = { ...p.model };
    const heavyModel = {};
    for (const key of ['dataBase64', 'data', 'dataText']) {
      if (typeof cleanModel[key] === 'string' && cleanModel[key].trim().length > 0) {
        heavyModel[key] = cleanModel[key];
        heavyBytes += cleanModel[key].length;
        delete cleanModel[key];
        hasHeavyBlob = true;
        hasAttachedModel = true;
      }
    }
    if (Object.keys(heavyModel).length > 0) {
      heavy.model = heavyModel;
      p.model = cleanModel;
    }
  }
  if (typeof p.previewDataUrl === 'string' && p.previewDataUrl.length > 16384) {
    heavy.previewDataUrl = p.previewDataUrl;
    heavyBytes += p.previewDataUrl.length;
    delete p.previewDataUrl;
    hasHeavyBlob = true;
  }

  if (hasAttachedModel) {
    p.hasAttachedModel = true;
    if (!p.modelFormat && p.model?.format) {
      p.modelFormat = p.model.format;
    }
  }

  return {
    hasHeavyBlob,
    hasAttachedModel,
    heavyBytes,
    heavyBlob: heavy,
    lightPayload: p
  };
}

export function compactSignaturePayload(payload, { stripVoxels = true } = {}) {
  const { lightPayload } = extractHeavyBlobFields(payload);
  delete lightPayload._stagedBlobKey;
  if (typeof lightPayload.previewDataUrl === 'string' && lightPayload.previewDataUrl.length > 1024) {
    delete lightPayload.previewDataUrl;
  }
  if (stripVoxels) {
    if (Array.isArray(lightPayload.voxels)) {
      lightPayload.voxelCount = lightPayload.voxels.length;
      delete lightPayload.voxels;
    }
    if (Array.isArray(lightPayload.cleanVoxels)) {
      lightPayload.voxelCount = lightPayload.cleanVoxels.length;
      delete lightPayload.cleanVoxels;
    }
  }
  return lightPayload;
}

export function compactSignatureResult(result) {
  if (!result || typeof result !== 'object') return result || {};
  const copy = { ...result };
  if (copy.sculpture && typeof copy.sculpture === 'object') {
    const sc = { ...copy.sculpture };
    if (Array.isArray(sc.voxels)) {
      sc.voxelCount = Number(sc.voxelCount || sc.voxels.length);
      delete sc.voxels;
    }
    if (typeof sc.previewDataUrl === 'string' && sc.previewDataUrl.length > 2048) {
      delete sc.previewDataUrl;
    }
    if (sc.customModel && typeof sc.customModel === 'object') {
      const cm = { ...sc.customModel };
      delete cm.inlineB64;
      delete cm.inlineBase64;
      delete cm.inlineText;
      sc.customModel = cm;
    }
    copy.sculpture = sc;
  }
  return copy;
}

function sanitizePayloadForResponse(payload) {
  const { lightPayload } = extractHeavyBlobFields(payload);
  delete lightPayload._stagedBlobKey;
  return lightPayload;
}

async function hydrateSignaturePayload(rawPayload, stagedBlobStore = null) {
  const payload = rawPayload && typeof rawPayload === 'object' ? { ...rawPayload } : {};
  const blobKey = String(payload._stagedBlobKey || '').trim();
  if (!blobKey) return payload;
  if (!stagedBlobStore || typeof stagedBlobStore.get !== 'function') {
    throw new McpServiceError(
      'Staged 3D model storage is unavailable for this signature request.',
      503
    );
  }
  const rawBlob = await stagedBlobStore.get(blobKey);
  if (!rawBlob) {
    throw new McpServiceError(
      'Staged 3D model payload has expired. Ask your agent to re-submit the request.',
      410
    );
  }
  const parsed = typeof rawBlob === 'string' ? JSON.parse(rawBlob) : rawBlob;
  delete payload._stagedBlobKey;
  delete payload._stagedModelBytes;
  if (parsed && typeof parsed === 'object') {
    if (parsed.modelBase64) payload.modelBase64 = parsed.modelBase64;
    if (parsed.modelData) payload.modelData = parsed.modelData;
    if (parsed.previewDataUrl) payload.previewDataUrl = parsed.previewDataUrl;
    if (parsed.model && typeof parsed.model === 'object') {
      payload.model = {
        ...(payload.model && typeof payload.model === 'object' ? payload.model : {}),
        ...parsed.model
      };
    }
  }
  return payload;
}

export function describeSignatureAction({
  action,
  parcelId = '',
  landDisplayName = '',
  sculptureId = '',
  payload = {}
}) {
  const p = /** @type {any} */ (payload && typeof payload === 'object' ? payload : {});
  const clip = (text, max = 110) => {
    const clean = String(text || '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  };
  const resolvedLand = resolveLandDisplayName(
    { customName: landDisplayName || p.customName || '' },
    { defaultName: '' }
  );
  const target = resolvedLand ? `"${resolvedLand}"` : parcelId ? 'your Virtual Land' : 'your land';

  if (action === 'create_sculpture') {
    const title = clip(p.title || 'Untitled Artwork', 56);
    const fmt = String(p.modelFormat || '').trim().toUpperCase();
    const voxelCount = Array.isArray(p.voxels)
      ? p.voxels.length
      : Number(p.voxelCount || 0);
    const kind = fmt
      ? `${fmt} 3D model`
      : p.hasAttachedModel || p._stagedBlobKey
        ? '3D model'
        : voxelCount > 0
          ? `${voxelCount}-block voxel sculpture`
          : '3D artwork';
    const desc = clip(p.description || '');
    const proposerHandle = String(p._proposer?.handle || '').trim();
    if (proposerHandle) {
      return {
        summaryTitle: `Place "${title}" (by ${proposerHandle})`,
        summaryDescription: `${proposerHandle} requests adding ${kind} on ${target}${desc ? ` — ${desc}` : ''} (NFT mints to artist).`
      };
    }
    return {
      summaryTitle: `Place "${title}"`,
      summaryDescription: `Add ${kind} on ${target}${desc ? ` — ${desc}` : ''}.`
    };
  }
  if (action === 'update_sculpture') {
    const changes = [];
    if (p.title) changes.push(`rename to "${clip(p.title, 40)}"`);
    if (p.description) changes.push('update description');
    if (
      p.modelFormat ||
      p.modelUrl ||
      p.modelBase64 ||
      p.modelData ||
      p.hasAttachedModel ||
      p._stagedBlobKey
    ) {
      changes.push('replace 3D model');
    } else if (Array.isArray(p.voxels) || Number(p.voxelCount || 0) > 0) {
      changes.push(`replace ${Array.isArray(p.voxels) ? p.voxels.length : Number(p.voxelCount)} voxels`);
    }
    if (p.anchorOffset) changes.push('adjust placement offset');
    const detail = changes.length ? changes.join(', ') : 'modify sculpture metadata';
    return {
      summaryTitle: p.title ? `Update "${clip(p.title, 48)}"` : 'Update Artwork',
      summaryDescription: `${detail.charAt(0).toUpperCase()}${detail.slice(1)} on ${target}.`
    };
  }
  if (action === 'set_sculpture_visibility') {
    const hiding = Boolean(p.hidden);
    const reason = clip(p.reason || '');
    return {
      summaryTitle: hiding ? 'Hide Artwork' : 'Restore Artwork',
      summaryDescription: `${hiding ? 'Hide' : 'Unhide'} artwork ${sculptureId ? `(${sculptureId.slice(0, 8)}…) ` : ''}on ${target}${reason ? ` — ${reason}` : ''}.`
    };
  }
  if (action === 'rollback_sculpture_revision') {
    return {
      summaryTitle: `Rollback to Rev #${p.revNum ?? '?'}`,
      summaryDescription: `Restore previous revision #${p.revNum ?? '?'} on ${target}.`
    };
  }
  if (action === 'delete_sculpture') {
    return {
      summaryTitle: 'Delete Artwork',
      summaryDescription: `Permanently hide/remove artwork ${sculptureId ? `(${sculptureId.slice(0, 8)}…) ` : ''}from ${target}.`
    };
  }
  if (action === 'update_parcel') {
    const parts = [];
    if (p.customName) parts.push(`name "${clip(p.customName, 44)}"`);
    if (p.description || p.curationNote) parts.push(`"${clip(p.description || p.curationNote, 70)}"`);
    return {
      summaryTitle: 'Update Land Details',
      summaryDescription: parts.length
        ? `Set ${parts.join(' · ')} on ${target}.`
        : `Update curation details on ${target}.`
    };
  }
  if (action === 'update_land_settings') {
    const flags = [];
    if (p.frozen !== undefined) flags.push(p.frozen ? 'Freeze land' : 'Unfreeze land');
    if (p.allowContributorEdits !== undefined) {
      flags.push(p.allowContributorEdits ? 'Allow contributor edits' : 'Disable contributor edits');
    }
    if (p.allowAgentErase !== undefined) {
      flags.push(p.allowAgentErase ? 'Allow agent erase' : 'Block agent erase');
    }
    if (p.requireApproval !== undefined) {
      flags.push(p.requireApproval ? 'Require approval for guests' : 'Allow anyone to add art');
    }
    if (p.chatAccessMode !== undefined) {
      const chatLabels = {
        open: 'Land Chat: Everyone on site (Google login · default)',
        contributors: 'Land Chat: Contributors only',
        whitelist: 'Land Chat: Whitelist only',
        off: 'Land Chat: Off'
      };
      flags.push(chatLabels[p.chatAccessMode] || `Land Chat: ${p.chatAccessMode}`);
    }
    if (p.chatAllowAgents !== undefined) {
      flags.push(
        p.chatAllowAgents
          ? 'Paired agentic users: Allowed'
          : 'Paired agentic users: Disabled'
      );
    }
    return {
      summaryTitle: p.frozen === true ? 'Freeze Land' : p.frozen === false ? 'Unfreeze Land' : 'Update Land Settings',
      summaryDescription: `${flags.length ? flags.join(' · ') : 'Modify access settings'} on ${target}.`
    };
  }
  if (action === 'update_land_volume') {
    const dims = [
      p.widthMeters ? `${p.widthMeters}m W` : '',
      p.depthMeters ? `${p.depthMeters}m D` : '',
      p.heightMeters ? `${p.heightMeters}m H` : '',
      p.rotationDeg !== undefined ? `${p.rotationDeg}° rot` : ''
    ].filter(Boolean);
    return {
      summaryTitle: 'Resize 3D Land Bounds',
      summaryDescription: `Adjust 3D prism (${dims.join(' · ') || 'volume'}) on ${target}.`
    };
  }
  if (action === 'erase_land') {
    const reason = clip(p.reason || '');
    return {
      summaryTitle: 'Erase All Land Artworks',
      summaryDescription: `Erase all artworks & curations on ${target}${reason ? ` — ${reason}` : ''}.`
    };
  }
  if (action === 'publish_sculpture') {
    const title = clip(p.title || 'Sculpture', 56);
    const desc = clip(p.description || '');
    return {
      summaryTitle: `Publish "${title}"`,
      summaryDescription: `Sign & mint mobile artwork on ${target}${desc ? ` — ${desc}` : ''}.`
    };
  }
  if (action === 'transfer_land_deed') {
    const to = String(p.toAddress || '').trim();
    const shortTo = to.length > 14 ? `${to.slice(0, 8)}…${to.slice(-4)}` : to || '0x…';
    const bundleText = p.includeOwnedArtworks ? ' + your artworks on this land' : ' (land deed only)';
    return {
      summaryTitle: `⚠️ Transfer Land Deed to ${shortTo}`,
      summaryDescription: `Transfer permanent Land Deed NFT for ${target}${bundleText}. Moves land ownership & future 3% steward royalties.`
    };
  }
  if (action === 'list_land_for_sale') {
    const price = Number(p.priceEth || 0);
    const bundleText = p.includeSellerArtworks ? ' + your artworks' : ' (land deed only)';
    return {
      summaryTitle: `List Land Deed for ${price} ETH`,
      summaryDescription: `List permanent Land Deed NFT for ${target}${bundleText} on the SPRAY.LAND Marketplace (5%/3%/2% split).`
    };
  }
  const readable = String(action || 'land_action').replace(/_/g, ' ');
  return {
    summaryTitle: `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`,
    summaryDescription: `Execute ${readable} on ${target}.`
  };
}

export function formatSignatureRequestRow(row) {
  if (!row) return null;
  const expired = new Date(row.expires_at).getTime() < Date.now();
  const rawPayload = JSON.parse(row.payload_json || '{}');
  const payload = sanitizePayloadForResponse(rawPayload);
  const parcelName = String(row.parcel_custom_name || '').trim();
  const landDisplayName = resolveLandDisplayName({
    customName: parcelName || payload?.customName || ''
  });
  const summary = describeSignatureAction({
    action: row.action,
    parcelId: row.parcel_id,
    landDisplayName,
    sculptureId: row.sculpture_id || '',
    payload
  });
  return {
    id: row.id,
    pairingCode: row.pairing_code || '',
    ownerSub: row.owner_sub,
    ownerAddress: row.owner_address,
    action: row.action,
    parcelId: row.parcel_id,
    parcelName,
    landDisplayName,
    sculptureId: row.sculpture_id || '',
    payload,
    payloadHash: row.payload_hash,
    canonicalMessage: row.canonical_message,
    nonce: row.nonce,
    requestedBy: row.requested_by,
    agentName: row.agent_name || '',
    summaryTitle: summary.summaryTitle,
    summaryDescription: summary.summaryDescription,
    status: expired && row.status === 'pending' ? 'expired' : row.status,
    signedBy: row.signed_by || '',
    signerAddress: row.signer_address || '',
    txHash: row.tx_hash || '',
    result: JSON.parse(row.result_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

export async function enqueueSignatureRequest(
  db,
  {
    customRequestId = '',
    pairingCode = '',
    ownerUser,
    ownerAddress,
    action,
    parcelId,
    sculptureId = '',
    payload,
    requestedBy = 'agent',
    agentName = '',
    stagedBlobStore = null
  }
) {
  const requestId = customRequestId
    ? String(customRequestId).trim().slice(0, 96)
    : `sigreq_${globalThis.crypto.randomUUID()}`;
  const existing = customRequestId
    ? await db.get('SELECT id, status FROM land_signature_requests WHERE id = ?', [requestId])
    : null;
  if (existing) {
    throw new McpServiceError(`Duplicate signature requestId (${requestId}).`, 409);
  }
  const nonce = generateRandomNonceHex(12);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const payloadHash = hashPayloadCanonical(payload);
  const canonicalMessage =
    action === 'publish_sculpture'
      ? buildPublishOnBehalfMessage({
          requestId,
          ownerAddress,
          parcelId,
          title: payload.title || 'Sculpture',
          payloadHash,
          nonce,
          expiresAt
        })
      : buildLandActivityMessage({
          requestId,
          action,
          parcelId,
          sculptureId,
          ownerAddress,
          payloadHash,
          nonce,
          expiresAt
        });

  let payloadForDb = payload;
  if (stagedBlobStore && typeof stagedBlobStore.put === 'function') {
    const extracted = extractHeavyBlobFields(payload);
    if (extracted.hasHeavyBlob) {
      const stagedKey = `sigblob:${requestId}`;
      await stagedBlobStore.put(
        stagedKey,
        JSON.stringify(extracted.heavyBlob),
        STAGED_BLOB_TTL_SECONDS
      );
      payloadForDb = {
        ...extracted.lightPayload,
        _stagedBlobKey: stagedKey,
        _stagedModelBytes: extracted.heavyBytes
      };
    }
  }

  await db.run(
    `INSERT INTO land_signature_requests (
      id, pairing_code, owner_sub, owner_address, action, parcel_id, sculpture_id,
      payload_json, payload_hash, canonical_message, nonce, requested_by, agent_name,
      status, signed_by, signer_address, signature, tx_hash, result_json,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', '', '{}', ?, ?, ?)`,
    [
      requestId,
      normalizePairingCode(pairingCode),
      ownerUser.id,
      ownerAddress,
      action,
      normalizeParcelId(parcelId),
      sculptureId || '',
      JSON.stringify(payloadForDb),
      payloadHash,
      canonicalMessage,
      nonce,
      requestedBy,
      agentName || '',
      createdAt,
      createdAt,
      expiresAt
    ]
  );

  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  return formatSignatureRequestRow(row);
}

export async function executeValidatedSignatureRow(
  db,
  {
    reqRow,
    ownerUser,
    signedBy,
    signerAddress,
    signature = '',
    txHash = '',
    pinSculptureFn,
    mintSculptureFn,
    emitMetadataUpdateFn = null,
    stagedBlobStore = null
  }
) {
  const rawPayload = JSON.parse(reqRow.payload_json || '{}');
  const stagedBlobKey = String(
    rawPayload?._stagedBlobKey || reqRow._cleanupStagedBlobKey || ''
  ).trim();
  const payload = await hydrateSignaturePayload(rawPayload, stagedBlobStore);
  const suppliedTxHash = String(txHash || payload?.txHash || '').trim();
  const isAgentOwner =
    String(ownerUser?.id || '').startsWith('agent:') || ownerUser?.actorType === 'agent';
  const safeEmitMetadataUpdateFn = isAgentOwner
    ? async () => ({
        simulated: true,
        erc4906Emitted: Boolean(suppliedTxHash),
        txHash: suppliedTxHash,
        gasSponsored: false,
        gasPaidBy: 'agent'
      })
    : emitMetadataUpdateFn;
  let result;
  let guestProposerSub = '';

  if (reqRow.action === 'create_sculpture') {
    const proposerInfo =
      reqRow.requested_by === 'guest_proposal' || payload?._proposer?.id
        ? payload._proposer || null
        : null;
    if (proposerInfo && proposerInfo.id) {
      // Land owner is approving a guest artist's proposal: verify owner owns the parcel,
      // then mint the NFT directly to the proposing artist!
      const parcelCtx = await checkParcelOwnership(db, {
        parcelId: reqRow.parcel_id,
        user: ownerUser,
        signerAddress
      });
      const proposerDbRow = await db
        .get('SELECT * FROM users WHERE id = ?', [String(proposerInfo.id)])
        .catch(() => null);
      const artistUser = proposerDbRow || {
        id: String(proposerInfo.id),
        email: String(proposerInfo.email || ''),
        name: String(proposerInfo.name || proposerInfo.handle || 'Artist'),
        username: String(proposerInfo.username || ''),
        wallet_address: String(proposerInfo.walletAddress || ''),
        custom_payout_address: ''
      };
      const artistAddress =
        resolvePreferredOwnerWallet(artistUser) || String(proposerInfo.walletAddress || '');
      if (!artistAddress) {
        throw new McpServiceError(
          'Proposing artist wallet address is unavailable for NFT minting.',
          400
        );
      }
      guestProposerSub = artistUser.id;
      result = await applyCreateSculptureOnLand(db, {
        parcelCtx,
        ownerUser: artistUser,
        ownerAddress: artistAddress,
        payload: suppliedTxHash ? { ...payload, txHash: suppliedTxHash } : payload,
        pinSculptureFn,
        mintSculptureFn,
        proofSeed: reqRow.id,
        isLandOwner: false
      });
    } else {
      const access = await resolveParcelPlacementAccess(db, {
        parcelId: reqRow.parcel_id,
        user: ownerUser,
        signerAddress
      });
      if (access.mode === 'guest_requires_owner_approval') {
        throw new McpServiceError(
          'The land holder has enabled "Require Approval" on this land. Re-submit to request owner approval.',
          403
        );
      }
      result = await applyCreateSculptureOnLand(db, {
        parcelCtx: access.parcelCtx,
        ownerUser,
        ownerAddress: reqRow.owner_address,
        payload: suppliedTxHash ? { ...payload, txHash: suppliedTxHash } : payload,
        pinSculptureFn,
        mintSculptureFn,
        proofSeed: reqRow.id,
        isLandOwner: access.isOwner
      });
    }
  } else if (reqRow.action === 'update_sculpture') {
    const perm = await checkSculptureOrLandOwnership(db, {
      sculptureId: reqRow.sculpture_id,
      user: ownerUser,
      signerAddress,
      allowHidden: true
    });
    result = await applyUpdateSculpture(db, {
      sculptureRow: perm.row,
      payload: suppliedTxHash ? { ...payload, txHash: suppliedTxHash } : payload,
      pinSculptureFn,
      emitMetadataUpdateFn: safeEmitMetadataUpdateFn,
      editorUser: ownerUser,
      editorRole: perm.role === 'land-owner' ? 'land-owner-agent' : 'mcp-agent'
    });
  } else if (reqRow.action === 'rollback_sculpture') {
    const perm = await checkSculptureOrLandOwnership(db, {
      sculptureId: reqRow.sculpture_id,
      user: ownerUser,
      signerAddress,
      allowHidden: true
    });
    result = await applyRollbackSculptureRevision(db, {
      sculptureRow: perm.row,
      revNum: payload.revNum,
      ownerUser,
      emitMetadataUpdateFn: safeEmitMetadataUpdateFn
    });
  } else if (reqRow.action === 'delete_sculpture') {
    const perm = await checkSculptureOrLandOwnership(db, {
      sculptureId: reqRow.sculpture_id,
      user: ownerUser,
      signerAddress
    });
    result = await applyDeleteSculpture(db, {
      sculptureRow: perm.row,
      ownerAddress: reqRow.owner_address
    });
  } else if (reqRow.action === 'set_sculpture_visibility') {
    const perm = await checkSculptureOrLandOwnership(db, {
      sculptureId: reqRow.sculpture_id,
      user: ownerUser,
      signerAddress,
      allowHidden: true
    });
    result = await applySetSculptureVisibility(db, {
      sculptureRow: perm.row,
      actorAddress: reqRow.owner_address,
      hidden: Boolean(payload.hidden),
      reason: payload.reason || ''
    });
  } else if (reqRow.action === 'update_land_settings') {
    result = await updateLandSettings(db, {
      parcelId: reqRow.parcel_id,
      user: ownerUser,
      body: payload
    });
  } else if (reqRow.action === 'update_land_volume') {
    result = await updateLandVolume(db, {
      parcelId: reqRow.parcel_id,
      user: ownerUser,
      volume: payload.volume || payload
    });
  } else if (reqRow.action === 'update_parcel') {
    const parcelCtx = await checkParcelOwnership(db, {
      parcelId: reqRow.parcel_id,
      user: ownerUser,
      signerAddress
    });
    result = await applyUpdateParcel(db, {
      parcelCtx,
      ownerUser,
      ownerAddress: reqRow.owner_address,
      payload,
      txHash: txHash || ethers.keccak256(ethers.toUtf8Bytes(`${reqRow.id}:${signature || signerAddress}`))
    });
  } else if (reqRow.action === 'erase_land') {
    const parcelCtx = await checkParcelOwnership(db, {
      parcelId: reqRow.parcel_id,
      user: ownerUser,
      signerAddress
    });
    result = await applyEraseLand(db, {
      parcelCtx,
      ownerAddress: reqRow.owner_address,
      reason: payload.reason || '',
      viaAgent: true
    });
  } else if (reqRow.action === 'publish_sculpture') {
    result = await applyPublishOnBehalf(db, {
      ownerUser,
      ownerAddress: reqRow.owner_address,
      payload,
      pinSculptureFn,
      mintSculptureFn,
      proofSignature: signature
    });
  } else if (reqRow.action === 'transfer_land_deed') {
    result = await transferLandDeed(db, {
      parcelId: reqRow.parcel_id,
      callerUser: ownerUser,
      toAddress: payload.toAddress,
      includeOwnedArtworks: Boolean(payload.includeOwnedArtworks)
    });
  } else if (reqRow.action === 'list_land_for_sale') {
    result = await listLandDeedForSale(db, {
      parcelId: reqRow.parcel_id,
      sellerUser: ownerUser,
      priceEth: Number(payload.priceEth),
      includeSellerArtworks: Boolean(payload.includeSellerArtworks)
    });
  } else {
    throw new McpServiceError(`Unsupported signed action: ${reqRow.action}`, 400);
  }

  const finalTxHash =
    txHash ||
    result?.mint?.txHash ||
    result?.parcel?.lastSignedTxHash ||
    ethers.keccak256(ethers.toUtf8Bytes(`signed:${reqRow.id}:${signerAddress}:${Date.now()}`));

  const now = new Date().toISOString();
  const compactedPayloadJson = JSON.stringify(
    compactSignaturePayload(rawPayload, { stripVoxels: true })
  );
  const compactedResultJson = JSON.stringify(compactSignatureResult(result));
  await db.run(
    `UPDATE land_signature_requests
     SET status = 'executed',
         payload_json = ?,
         payload_hash = ?,
         canonical_message = ?,
         signed_by = ?,
         signer_address = ?,
         signature = ?,
         tx_hash = ?,
         result_json = ?,
         updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [
      compactedPayloadJson,
      reqRow.payload_hash,
      reqRow.canonical_message,
      signedBy,
      signerAddress,
      signature,
      finalTxHash,
      compactedResultJson,
      now,
      reqRow.id
    ]
  );

  if (stagedBlobKey && stagedBlobStore && typeof stagedBlobStore.delete === 'function') {
    await stagedBlobStore.delete(stagedBlobKey).catch(() => {});
  }

  const updatedRow = await db.get(
    `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
     FROM land_signature_requests sr
     LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
     WHERE sr.id = ?`,
    [reqRow.id]
  );
  const formattedRequest = formatSignatureRequestRow(updatedRow);
  const executedNotification = await notifyLandApprovalExecuted(db, {
    userSub: ownerUser?.id || reqRow.owner_sub,
    request: formattedRequest,
    result
  }).catch(() => null);
  if (guestProposerSub && guestProposerSub !== (ownerUser?.id || reqRow.owner_sub)) {
    await notifyLandApprovalExecuted(db, {
      userSub: guestProposerSub,
      request: formattedRequest,
      result
    }).catch(() => null);
  }
  return {
    ok: true,
    request: formattedRequest,
    result,
    ...(executedNotification ? { notification: executedNotification } : {})
  };
}

export async function createPublishSignatureRequestForMobile(
  db,
  { user, body, pairingCode = '', isMobileRequest = false, apiOrigin = '', stagedBlobStore = null }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  if (!isMobileRequest) {
    throw new McpServiceError(
      'Publishing sculptures requires a mobile device with camera, gyroscope, and GPS.',
      403
    );
  }

  let cleanPairingCode = normalizePairingCode(pairingCode);
  if (cleanPairingCode) {
    const active = await requireActiveMcpPairing(db, {
      pairingCode: cleanPairingCode,
      callerUser: user
    });
    cleanPairingCode = active.pairing.code;
  } else {
    const pairings = await listMcpPairings(db, { user });
    if (!pairings.activePairing) {
      throw new McpServiceError(
        'Connect your MCP agent pairing code first to delegate publish signing.',
        403
      );
    }
    cleanPairingCode = pairings.activePairing.code;
  }

  const validation = validatePublishPayload(body);
  if (!validation.ok) {
    throw new McpServiceError(validation.errors[0], 400, { errors: validation.errors });
  }

  const verticalBounds = computeVerticalBounds(validation.cleanVoxels);
  const locationBundle = await verifyAndEnrichLocation(
    {
      ...(body?.location || {}),
      sculptureVerticalMinM: verticalBounds.minY,
      sculptureVerticalMaxM: verticalBounds.maxY
    },
    body?.proofOfLocation,
    user.id
  );
  if (!locationBundle.verified) {
    throw new McpServiceError(
      `Proof of Location check failed (score ${locationBundle.score}/100). Enable GPS, live camera, and move gently while sculpting.`,
      422,
      { proofOfLocation: locationBundle }
    );
  }

  const provisionalFittedVol = buildObjectFittedLandVolume({
    parcelId: locationBundle.parcelId,
    geohash: locationBundle.geohash,
    lat: locationBundle.lat,
    lng: locationBundle.lng,
    voxels: validation.cleanVoxels,
    anchorOffset: body?.anchorOffset || null,
    paddingFraction: 0.1
  });
  const resolvedTarget = await resolveMobilePublishParcel(db, {
    lat: locationBundle.lat,
    lng: locationBundle.lng,
    userLat: locationBundle.lat,
    userLng: locationBundle.lng,
    defaultParcelId: locationBundle.parcelId,
    defaultGeohash: locationBundle.geohash,
    requestedParcelId: body?.targetParcelId || '',
    fittedVolume: provisionalFittedVol
  });
  if (resolvedTarget.blockedOverlap) {
    throw new McpServiceError(
      `Cannot mint a new land overlapping "${resolvedTarget.conflictingLandName}". Move inside "${resolvedTarget.conflictingLandName}" to add art to it, or step outside its boundary.`,
      409,
      {
        conflictingParcelId: resolvedTarget.conflictingParcelId,
        conflictingLandName: resolvedTarget.conflictingLandName
      }
    );
  }
  const effectiveParcelId = resolvedTarget.parcelId || locationBundle.parcelId;
  const effectiveGeohash = resolvedTarget.geohash || locationBundle.geohash;
  const effectiveLocationBundle = {
    ...locationBundle,
    parcelId: effectiveParcelId,
    geohash: effectiveGeohash,
    parcelBytes32:
      effectiveParcelId === locationBundle.parcelId
        ? locationBundle.parcelBytes32
        : ethers.keccak256(ethers.toUtf8Bytes(effectiveParcelId)),
    parcelBounds: resolvedTarget.parcelBounds || locationBundle.parcelBounds
  };

  const ownerAddress = resolvePreferredOwnerWallet(user);
  const reqObj = await enqueueSignatureRequest(db, {
    pairingCode: cleanPairingCode,
    ownerUser: user,
    ownerAddress,
    action: 'publish_sculpture',
    parcelId: effectiveParcelId,
    payload: {
      title: validation.title,
      description: validation.description,
      cleanVoxels: validation.cleanVoxels,
      previewDataUrl: String(body?.previewDataUrl || '').slice(0, 450000),
      draftId: body?.draftId || '',
      targetParcelId: body?.targetParcelId || (resolvedTarget.matchedExisting ? effectiveParcelId : ''),
      locationBundle: effectiveLocationBundle
    },
    requestedBy: 'mobile',
    agentName: 'mobile-delegated-publish',
    stagedBlobStore
  });

  return {
    request: reqObj,
    promptText: buildAgentSignPublishPrompt({
      apiOrigin,
      pairingCode: cleanPairingCode,
      requestId: reqObj.id,
      parcelId: effectiveParcelId,
      title: validation.title,
      ownerAddress,
      canonicalMessage: reqObj.canonicalMessage
    })
  };
}

export async function listPendingSignaturesForUser(
  db,
  { user, includeHistory = false, historyLimit = 30 }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const wallets = resolveUserWalletAddresses(user);

  if (includeHistory) {
    const safeLimit = Math.max(1, Math.min(100, Number(historyLimit) || 30));
    const fetchLimit = safeLimit + 25;
    const allRows =
      wallets.length > 0
        ? await db.all(
            `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
             FROM land_signature_requests sr
             LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
             WHERE sr.id IN (
               SELECT id FROM (
                 SELECT id FROM land_signature_requests
                 WHERE owner_sub = ?
                 ORDER BY updated_at DESC, created_at DESC LIMIT ?
               )
               UNION
               SELECT id FROM (
                 SELECT id FROM land_signature_requests
                 WHERE LOWER(owner_address) IN (${wallets.map(() => '?').join(', ')})
                 ORDER BY updated_at DESC, created_at DESC LIMIT ?
               )
             )
             ORDER BY sr.updated_at DESC, sr.created_at DESC LIMIT ?`,
            [user.id, fetchLimit, ...wallets, fetchLimit, fetchLimit]
          )
        : await db.all(
            `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
             FROM land_signature_requests sr
             LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
             WHERE sr.owner_sub = ?
             ORDER BY sr.updated_at DESC, sr.created_at DESC LIMIT ?`,
            [user.id, fetchLimit]
          );
    const formatted = (allRows || []).map(formatSignatureRequestRow);
    const pending = formatted.filter((r) => r.status === 'pending').slice(0, 25);
    const history = formatted.filter((r) => r.status !== 'pending').slice(0, safeLimit);
    return {
      requests: pending,
      history
    };
  }

  const rows =
    wallets.length > 0
      ? await db.all(
          `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
           FROM land_signature_requests sr
           LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
           WHERE sr.id IN (
             SELECT id FROM land_signature_requests
             WHERE owner_sub = ? AND status = 'pending'
             UNION
             SELECT id FROM land_signature_requests
             WHERE LOWER(owner_address) IN (${wallets.map(() => '?').join(', ')}) AND status = 'pending'
           )
           ORDER BY sr.created_at DESC LIMIT 25`,
          [user.id, ...wallets]
        )
      : await db.all(
          `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
           FROM land_signature_requests sr
           LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
           WHERE sr.owner_sub = ? AND sr.status = 'pending'
           ORDER BY sr.created_at DESC LIMIT 25`,
          [user.id]
        );
  return {
    requests: (rows || [])
      .map(formatSignatureRequestRow)
      .filter((r) => r.status === 'pending')
  };
}

export async function listSignatureHistoryForUser(db, { user, limit = 40 }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40));
  const rows = await db.all(
    `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
     FROM land_signature_requests sr
     LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
     WHERE sr.owner_sub = ?
     ORDER BY sr.updated_at DESC, sr.created_at DESC LIMIT ?`,
    [user.id, safeLimit]
  );
  const formatted = (rows || []).map(formatSignatureRequestRow);
  const pending = formatted.filter((r) => r.status === 'pending');
  const history = formatted.filter((r) => r.status !== 'pending');
  return {
    pending,
    history,
    requests: formatted
  };
}

export async function getSignatureRequest(db, { requestId, user = null, pairingCode = '' }) {
  const row = await db.get(
    `SELECT sr.*, COALESCE(pc.custom_name, '') AS parcel_custom_name
     FROM land_signature_requests sr
     LEFT JOIN parcel_curations pc ON pc.parcel_id = sr.parcel_id
     WHERE sr.id = ?`,
    [requestId]
  );
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  if (user && row.owner_sub === user.id) {
    return { request: formatSignatureRequestRow(row) };
  }
  const active = await requireActiveMcpPairing(db, { pairingCode });
  if (active.ownerUser.id !== row.owner_sub) {
    throw new McpServiceError('Forbidden signature request access.', 403);
  }
  return { request: formatSignatureRequestRow(row) };
}

export async function getSignatureRequestPreviewModel(
  db,
  { requestId, user, stagedBlobStore = null }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  const callerWallets = resolveUserWalletAddresses(user);
  const ownsRequest =
    row.owner_sub === user.id ||
    (row.owner_address && callerWallets.includes(String(row.owner_address).toLowerCase()));
  if (!ownsRequest) {
    throw new McpServiceError('Only the property owner can preview this request.', 403);
  }
  const rawPayload = JSON.parse(row.payload_json || '{}');
  const payload = await hydrateSignaturePayload(rawPayload, stagedBlobStore);
  const extracted = extractCustomModelInput(payload);
  if (!extracted.provided || extracted.error || !extracted.customModel) {
    throw new McpServiceError(extracted.error || 'No 3D model file attached to this request.', 404);
  }
  let resolved = extracted.customModel;
  if (!resolved.bytes && resolved.externalUrl) {
    const formatHint = resolved.format && resolved.format !== 'auto' ? resolved.format : '';
    const checked = await validate3dModelUrl(resolved.externalUrl, { formatHint });
    if (!checked.valid || !checked.customModel?.bytes) {
      throw new McpServiceError(
        checked.error || 'Could not load 3D model preview from source URL.',
        502
      );
    }
    resolved = checked.customModel;
  }
  if (!resolved.bytes || resolved.bytes.length === 0) {
    throw new McpServiceError('Empty 3D model preview payload.', 404);
  }
  return {
    bytes: resolved.bytes,
    format: resolved.format || 'glb',
    mimeType: resolved.mimeType || 'model/gltf-binary'
  };
}

export async function signRequestByMobile(
  db,
  {
    requestId,
    user,
    signature = '',
    autoFitScale = false,
    overrideScale = null,
    decryptEmbeddedPrivateKey,
    pinSculptureFn,
    mintSculptureFn,
    emitMetadataUpdateFn = null,
    stagedBlobStore = null
  }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  const callerWallets = resolveUserWalletAddresses(user);
  const ownsRequest =
    row.owner_sub === user.id ||
    (row.owner_address && callerWallets.includes(String(row.owner_address).toLowerCase()));
  if (!ownsRequest) {
    throw new McpServiceError('Only the property owner can sign this request.', 403);
  }
  if (row.status !== 'pending') {
    throw new McpServiceError(`Signature request is already ${row.status}.`, 409);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new McpServiceError('Signature request has expired.', 410);
  }

  let effectiveRow = row;
  let appliedAutoFitScale = null;
  let finalSig = String(signature || '').trim();
  let signerAddress = '';

  const requestedOverrideScale =
    overrideScale !== null && overrideScale !== undefined && overrideScale !== ''
      ? Number(overrideScale)
      : NaN;
  const wantsScaleAdjust =
    (Boolean(autoFitScale) || (Number.isFinite(requestedOverrideScale) && requestedOverrideScale > 0)) &&
    (row.action === 'create_sculpture' || row.action === 'update_sculpture');

  if (wantsScaleAdjust) {
    if (finalSig) {
      throw new McpServiceError(
        'Auto-fit scale modifies the request payload and requires embedded wallet signing.',
        400
      );
    }
    const rawParsedPayload = JSON.parse(row.payload_json || '{}');
    const parsedPayload = await hydrateSignaturePayload(rawParsedPayload, stagedBlobStore);
    let nextScale = Number.isFinite(requestedOverrideScale) && requestedOverrideScale > 0
      ? requestedOverrideScale
      : null;

    if (nextScale === null && autoFitScale) {
      try {
        if (row.action === 'create_sculpture') {
          const access = await resolveParcelPlacementAccess(db, {
            parcelId: row.parcel_id,
            user
          });
          await preflightCreateSculptureOnLand(db, {
            parcelCtx: access.parcelCtx,
            payload: parsedPayload
          });
        } else if (row.action === 'update_sculpture') {
          const perm = await checkSculptureOrLandOwnership(db, {
            sculptureId: row.sculpture_id,
            user,
            allowHidden: true
          });
          await preflightUpdateSculpture(db, { sculptureRow: perm.row, payload: parsedPayload });
        }
      } catch (preflightErr) {
        const candidateScale = Number(
          preflightErr?.extra?.maxSafeScale ?? preflightErr?.extra?.suggestedScale ?? 0
        );
        if (preflightErr?.statusCode === 409 && candidateScale >= 0.001) {
          nextScale = candidateScale;
        } else {
          throw preflightErr;
        }
      }
    }

    if (nextScale !== null && nextScale >= 0.001) {
      const adjustedPayload = {
        ...parsedPayload,
        modelScale: nextScale,
        ...(parsedPayload.scale !== undefined ? { scale: nextScale } : {}),
        ...(parsedPayload.anchorOffset && typeof parsedPayload.anchorOffset === 'object'
          ? {
              anchorOffset: {
                ...parsedPayload.anchorOffset,
                ...(parsedPayload.anchorOffset.scale !== undefined ? { scale: nextScale } : {})
              }
            }
          : {})
      };
      const nextPayloadHash = hashPayloadCanonical(adjustedPayload);
      const nextCanonicalMessage = buildLandActivityMessage({
        requestId: row.id,
        action: row.action,
        parcelId: row.parcel_id,
        sculptureId: row.sculpture_id || '',
        ownerAddress: row.owner_address,
        payloadHash: nextPayloadHash,
        nonce: row.nonce,
        expiresAt: row.expires_at
      });
      effectiveRow = {
        ...row,
        payload_json: JSON.stringify(adjustedPayload),
        payload_hash: nextPayloadHash,
        canonical_message: nextCanonicalMessage,
        _cleanupStagedBlobKey: String(rawParsedPayload?._stagedBlobKey || '').trim()
      };
      appliedAutoFitScale = nextScale;
    }
  }

  if (finalSig) {
    let recovered;
    try {
      recovered = ethers.getAddress(ethers.verifyMessage(effectiveRow.canonical_message, finalSig));
    } catch {
      throw new McpServiceError('Invalid mobile wallet signature.', 401);
    }
    const allowed = resolveUserWalletAddresses(user);
    if (!allowed.includes(recovered.toLowerCase())) {
      throw new McpServiceError(
        `Signer ${recovered} does not match your account wallets.`,
        403
      );
    }
    signerAddress = recovered;
  } else {
    const pk = await decryptEmbeddedPrivateKey(user);
    const wallet = new ethers.Wallet(pk);
    finalSig = await wallet.signMessage(effectiveRow.canonical_message);
    signerAddress = ethers.getAddress(wallet.address);
  }

  const execOut = await executeValidatedSignatureRow(db, {
    reqRow: effectiveRow,
    ownerUser: user,
    signedBy: 'mobile-wallet',
    signerAddress,
    signature: finalSig,
    pinSculptureFn,
    mintSculptureFn,
    emitMetadataUpdateFn,
    stagedBlobStore
  });
  return appliedAutoFitScale !== null
    ? { ...execOut, autoFittedScale: appliedAutoFitScale }
    : execOut;
}

export async function signRequestByAgent(
  db,
  {
    requestId,
    pairingCode,
    signature,
    txHash = '',
    agentName = '',
    pinSculptureFn,
    mintSculptureFn,
    emitMetadataUpdateFn = null,
    stagedBlobStore = null
  }
) {
  const { pairing, ownerUser } = await requireActiveMcpPairing(db, { pairingCode });
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  if (row.owner_sub !== ownerUser.id) {
    throw new McpServiceError('Signature request does not belong to paired owner.', 403);
  }
  if (row.status !== 'pending') {
    throw new McpServiceError(`Signature request is already ${row.status}.`, 409);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new McpServiceError('Signature request has expired.', 410);
  }
  if (
    (row.action === 'transfer_land_deed' || row.action === 'list_land_for_sale') &&
    !String(ownerUser?.id || '').startsWith('agent:')
  ) {
    throw new McpServiceError(
      'Land Deed NFT transfer/listing requests require explicit human owner approval in the SPRAY.LAND app and cannot be self-signed by a paired agent.',
      403
    );
  }
  if (!signature) {
    throw new McpServiceError('Agent EIP-191 signature over canonicalMessage is required.', 400);
  }

  let recovered;
  try {
    recovered = ethers.getAddress(ethers.verifyMessage(row.canonical_message, signature));
  } catch {
    throw new McpServiceError('Invalid EIP-191 agent signature.', 401);
  }

  const allowed = resolveUserWalletAddresses(ownerUser);
  if (!allowed.includes(recovered.toLowerCase())) {
    throw new McpServiceError(
      `Signer ${recovered} does not match paired owner wallets (${ownerUser.wallet_address}).`,
      403
    );
  }

  await db.run(
    `UPDATE mcp_pairings
     SET key_connected = 1, agent_address = ?, agent_name = COALESCE(NULLIF(?, ''), agent_name), last_active_at = ?
     WHERE code = ?`,
    [recovered, String(agentName || '').trim().slice(0, 64), new Date().toISOString(), pairing.code]
  );

  return executeValidatedSignatureRow(db, {
    reqRow: row,
    ownerUser,
    signedBy: 'agent-key',
    signerAddress: recovered,
    signature,
    txHash: String(txHash || '').trim(),
    pinSculptureFn,
    mintSculptureFn,
    emitMetadataUpdateFn,
    stagedBlobStore
  });
}

export async function rejectSignatureRequest(db, { requestId, user, stagedBlobStore = null }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  const callerWallets = resolveUserWalletAddresses(user);
  const ownsRequest =
    row.owner_sub === user.id ||
    (row.owner_address && callerWallets.includes(String(row.owner_address).toLowerCase()));
  if (!ownsRequest) {
    throw new McpServiceError('Only the property owner can reject this request.', 403);
  }
  if (row.status !== 'pending') {
    throw new McpServiceError(`Signature request is already ${row.status}.`, 409);
  }
  const rawPayload = JSON.parse(row.payload_json || '{}');
  const stagedBlobKey = String(rawPayload?._stagedBlobKey || '').trim();
  const compactedPayloadJson = JSON.stringify(
    compactSignaturePayload(rawPayload, { stripVoxels: true })
  );
  await db.run(
    `UPDATE land_signature_requests
     SET status = 'rejected', payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [compactedPayloadJson, new Date().toISOString(), requestId]
  );
  if (stagedBlobKey && stagedBlobStore && typeof stagedBlobStore.delete === 'function') {
    await stagedBlobStore.delete(stagedBlobKey).catch(() => {});
  }
  const updated = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  return { ok: true, request: formatSignatureRequestRow(updated) };
}

export async function compactSignatureRequestsMaintenance(
  db,
  { stagedBlobStore = null, nowMs = Date.now(), maxRowsPerRun = 50 } = {}
) {
  const nowIso = new Date(nowMs).toISOString();
  let expiredMarked = 0;
  try {
    const expRes = await db.run(
      `UPDATE land_signature_requests
       SET status = 'expired', updated_at = ?
       WHERE status = 'pending' AND expires_at < ?`,
      [nowIso, nowIso]
    );
    expiredMarked = Number(expRes?.meta?.changes ?? expRes?.changes ?? 0);
  } catch {
    expiredMarked = 0;
  }

  const bloatedRows = await db
    .all(
      `SELECT id, payload_json, result_json
       FROM land_signature_requests
       WHERE status != 'pending'
         AND (LENGTH(payload_json) > ? OR LENGTH(result_json) > ?)
       ORDER BY updated_at ASC
       LIMIT ?`,
      [COMPACT_PAYLOAD_THRESHOLD_BYTES, COMPACT_RESULT_THRESHOLD_BYTES, maxRowsPerRun]
    )
    .catch(() => []);

  let rowsCompacted = 0;
  let bytesFreed = 0;
  for (const row of bloatedRows || []) {
    try {
      const origPayload = String(row.payload_json || '{}');
      const origResult = String(row.result_json || '{}');
      const parsedPayload = JSON.parse(origPayload);
      const parsedResult = JSON.parse(origResult);
      const stagedKey = String(parsedPayload?._stagedBlobKey || '').trim();
      const nextPayload = JSON.stringify(compactSignaturePayload(parsedPayload, { stripVoxels: true }));
      const nextResult = JSON.stringify(compactSignatureResult(parsedResult));
      if (nextPayload.length < origPayload.length || nextResult.length < origResult.length) {
        await db.run(
          `UPDATE land_signature_requests
           SET payload_json = ?, result_json = ?
           WHERE id = ?`,
          [nextPayload, nextResult, row.id]
        );
        rowsCompacted += 1;
        bytesFreed += Math.max(0, origPayload.length - nextPayload.length) +
          Math.max(0, origResult.length - nextResult.length);
      }
      if (stagedKey && stagedBlobStore && typeof stagedBlobStore.delete === 'function') {
        await stagedBlobStore.delete(stagedKey).catch(() => {});
      }
    } catch {
      // Ignore malformed row and continue compacting remaining rows
    }
  }

  // Periodic housekeeping: prune expired ephemeral challenges, agent sessions & old rate-limit buckets
  const cutoff24hIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const cutoff24hSec = Math.floor((nowMs - 24 * 60 * 60 * 1000) / 1000);
  let housekeepingDeleted = 0;
  for (const [sql, params] of [
    ['DELETE FROM parcel_presence_challenges WHERE expires_at < ?', [cutoff24hIso]],
    ['DELETE FROM agent_sessions WHERE expires_at < ?', [cutoff24hIso]],
    ['DELETE FROM rate_limit_buckets WHERE window_start < ?', [cutoff24hSec]]
  ]) {
    try {
      const r = await db.run(sql, params);
      housekeepingDeleted += Number(r?.meta?.changes ?? r?.changes ?? 0);
    } catch {
      // Optional table may not exist in older fixtures
    }
  }

  return { expiredMarked, rowsCompacted, bytesFreed, housekeepingDeleted };
}

export async function enqueueGuestProposalForLandOwner(
  db,
  {
    parcelCtx,
    landOwnerUser,
    landOwnerAddress,
    proposerUser,
    payload,
    agentName = '',
    notifyMobileFn = null,
    stagedBlobStore = null
  }
) {
  if (!landOwnerUser?.id) {
    throw new McpServiceError(
      'Unable to locate the land holder account for approval routing.',
      400
    );
  }
  const proposerHandle = resolvePublicUserHandle(proposerUser, {
    fallback: 'Artist',
    includeAt: true
  });
  const proposerWallet = resolvePreferredOwnerWallet(proposerUser);
  if (!proposerWallet) {
    throw new McpServiceError('Artist wallet address unavailable for NFT minting.', 400);
  }
  const ownerPairingRow = await db
    .get(
      `SELECT code FROM mcp_pairings
       WHERE owner_sub = ? AND status = 'connected'
       ORDER BY last_active_at DESC LIMIT 1`,
      [landOwnerUser.id]
    )
    .catch(() => null);
  const ownerPairingCode = ownerPairingRow?.code || '';
  const proposalPayload = {
    ...(payload && typeof payload === 'object' ? payload : {}),
    _proposer: {
      id: proposerUser.id,
      email: proposerUser.email || '',
      name: proposerUser.name || '',
      username: proposerUser.username || '',
      handle: proposerHandle,
      walletAddress: proposerWallet
    }
  };
  const displayAgent = agentName
    ? `${proposerHandle} via ${String(agentName).trim()}`
    : proposerHandle;
  const reqObj = await enqueueSignatureRequest(db, {
    pairingCode: ownerPairingCode,
    ownerUser: landOwnerUser,
    ownerAddress: landOwnerAddress || resolvePreferredOwnerWallet(landOwnerUser),
    action: 'create_sculpture',
    parcelId: parcelCtx.parcelId,
    payload: proposalPayload,
    requestedBy: 'guest_proposal',
    agentName: displayAgent,
    stagedBlobStore
  });

  await notifyPendingLandApproval(db, {
    userSub: landOwnerUser.id,
    request: reqObj
  }).catch(() => {});

  if (typeof notifyMobileFn === 'function' && ownerPairingCode) {
    try {
      await notifyMobileFn({
        type: 'signature_request',
        pairingCode: ownerPairingCode,
        request: reqObj
      });
    } catch {
      // non-blocking push notification
    }
  }

  const ownerHandle = resolvePublicUserHandle(landOwnerUser, {
    fallback: 'the land holder',
    includeAt: true
  });
  return {
    status: 'pending_owner_approval',
    requiresOwnerApproval: true,
    message: `Submitted "${payload?.title || 'Artwork'}" to ${ownerHandle} for approval on "${reqObj.landDisplayName || parcelCtx.parcelId}". Once approved, the artwork NFT will be minted to your wallet (${proposerWallet}).`,
    request: reqObj
  };
}

export async function handlePairedLandMutationViaMcp(
  db,
  {
    pairing,
    ownerUser,
    action,
    parcelId,
    sculptureId = '',
    payload,
    signature = '',
    auth = null,
    txHash = '',
    pinSculptureFn,
    mintSculptureFn,
    notifyMobileFn,
    emitMetadataUpdateFn = null,
    stagedBlobStore = null
  }
) {
  const ownerAddress = resolvePreferredOwnerWallet(ownerUser);
  const suppliedSig = String(signature || auth?.signature || '').trim();
  const customReqId = String(auth?.requestId || '').trim();
  const reqObj = await enqueueSignatureRequest(db, {
    customRequestId: customReqId,
    pairingCode: pairing.code,
    ownerUser,
    ownerAddress,
    action,
    parcelId,
    sculptureId,
    payload,
    requestedBy: 'agent',
    agentName: pairing.agentName || 'paired-agent',
    stagedBlobStore
  });

  if (suppliedSig) {
    let recovered;
    try {
      recovered = ethers.getAddress(ethers.verifyMessage(reqObj.canonicalMessage, suppliedSig));
    } catch {
      throw new McpServiceError('Invalid agent EIP-191 signature over canonicalMessage.', 401, {
        request: reqObj
      });
    }
    const allowed = resolveUserWalletAddresses(ownerUser);
    if (!allowed.includes(recovered.toLowerCase())) {
      throw new McpServiceError(
        `Agent signer ${recovered} does not hold owner wallet rights for parcel ${parcelId}.`,
        403
      );
    }

    await db.run(
      'UPDATE mcp_pairings SET key_connected = 1, agent_address = ?, last_active_at = ? WHERE code = ?',
      [recovered, new Date().toISOString(), pairing.code]
    );

    const reqRow = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [reqObj.id]);
    const execOut = await executeValidatedSignatureRow(db, {
      reqRow,
      ownerUser,
      signedBy: 'agent-key',
      signerAddress: recovered,
      signature: suppliedSig,
      txHash: String(txHash || auth?.txHash || '').trim(),
      pinSculptureFn,
      mintSculptureFn,
      emitMetadataUpdateFn,
      stagedBlobStore
    });

    if (typeof notifyMobileFn === 'function') {
      try {
        await notifyMobileFn({
          type: 'mcp_signature_executed',
          pairingCode: pairing.code,
          request: execOut.request
        });
      } catch {}
    }

    return {
      status: 'executed_by_agent',
      ...execOut
    };
  }

  if (
    pairing.code === 'DIRECT-AGENT-WALLET' &&
    ownerUser?.actorType === 'agent' &&
    action !== 'erase_land'
  ) {
    const reqRow = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [reqObj.id]);
    const execOut = await executeValidatedSignatureRow(db, {
      reqRow,
      ownerUser,
      signedBy: 'agent-wallet-jwt',
      signerAddress: ownerAddress,
      signature: 'jwt-session-authenticated',
      txHash: String(txHash || auth?.txHash || '').trim(),
      pinSculptureFn,
      mintSculptureFn,
      emitMetadataUpdateFn,
      stagedBlobStore
    });
    return {
      status: 'executed_by_agent',
      ...execOut
    };
  }

  await notifyPendingLandApproval(db, {
    userSub: ownerUser.id,
    request: reqObj
  }).catch(() => {});

  if (typeof notifyMobileFn === 'function') {
    try {
      await notifyMobileFn({
        type: 'signature_request',
        pairingCode: pairing.code,
        request: reqObj
      });
    } catch {}
  }

  return {
    status: 'pending_mobile_signature',
    requiresMobileSignature: true,
    message:
      'Approval request queued for the land holder (approve directly on the land page, Mobile HUD, or supply owner EIP-191 signature).',
    request: reqObj
  };
}
