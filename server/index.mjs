import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { ethers } from 'ethers';
import { WebSocketServer } from 'ws';
import { CONFIG, POLICY, ROOT_DIR } from './config.mjs';
import { verifyPayoutLinkSignature } from '../shared/payoutLinkMessage.mjs';
import { STEWARD_DEFAULTS, TRANSACTION_FEES } from '../shared/constants.mjs';
import {
  getAgentProfile,
  getDualLeaderboards,
  issueAgentAuthChallenge,
  registerOrLoginAgentWallet
} from '../shared/agentAuthService.mjs';
import {
  awakenParcelByHumanVisit,
  checkLandTitleAvailability,
  claimDormantLand,
  createArtQuest,
  getLandTelemetry,
  listNearbyQuests,
  scoutLands,
  updateLandVolume
} from '../shared/agentQuestService.mjs';
import {
  checkInToLandInPerson,
  getArchivedLandDetail,
  listArchivedLands,
  reapAndArchiveExpiredLands
} from '../shared/landArchiveService.mjs';
import {
  clearUserNotifications,
  deleteNotification,
  listUserNotifications,
  markNotificationsRead,
  updateNotificationPreferences
} from '../shared/notificationService.mjs';
import {
  buildObjectFittedLandVolume,
  centerVoxelsHorizontally,
  offsetLatLngByLocalXZ
} from '../shared/landVolume.mjs';
import { resolveAuthorHandleForStorage } from '../shared/userDisplay.mjs';
import { reverseGeocodeLocation, searchLocations } from '../shared/geocodeService.mjs';
import {
  checkUsernameAvailability,
  getPublicProfile,
  updateUserProfile
} from '../shared/profileService.mjs';
import {
  createMarketplaceListing,
  executeMarketplacePurchase,
  getEconomySplitsSummary,
  listMarketplaceItems
} from '../shared/marketplaceService.mjs';
import { getDb } from './db.mjs';
import {
  getAuthUserFromRequest,
  issueSessionToken,
  requireAdmin,
  requireAuth,
  sanitizeUser,
  upsertGoogleUser,
  verifyGoogleSignIn
} from './services/auth.mjs';
import {
  emitMetadataUpdateOnChain,
  getChainStatus,
  mintOnRobinhoodChain
} from './services/blockchain.mjs';
import {
  cacheLocalIpfsCid,
  pinJsonDocumentToIpfs,
  pinSculptureToIpfs,
  readLocalIpfsCid
} from './services/ipfs.mjs';
import { validatePublishPayload } from './services/moderation.mjs';
import {
  assessTravelFeasibility,
  haversineMeters,
  verifyAndEnrichLocation
} from './services/pol.mjs';
import {
  buildAgentSpec,
  buildLlmsTxt,
  buildWellKnownAgentCard,
  createAgentSession,
  getAgentSession,
  submitAgentSculpture
} from '../shared/agentService.mjs';
import { buildSculptureGlb } from '../shared/glb.mjs';
import {
  buildContractMetadata,
  buildSculptureSelectSql,
  buildSpatialBoundingWhere,
  computeVerticalBounds,
  formatMarketplaceTokenMetadata,
  serializeSculptureRow
} from '../shared/sculpture.mjs';
import {
  listSculptureTransfers,
  syncSculptureOwnership,
  transferSculptureNft
} from '../shared/transferService.mjs';
import {
  claimClueUnlockedGrant,
  enterChatBoard,
  initChatBoard,
  listPendingGrantsForGrantor,
  postEncryptedChatMessage,
  requestChatGrant,
  submitPeerGrant,
  updateBoardClue
} from '../shared/chatService.mjs';
import {
  getOwnerPinSeal,
  getPinnedBatchMeta,
  issueParcelPresenceChallenge,
  saveEncryptedPinBatch,
  unlockPinnedBatchForParcelVisitor
} from '../shared/pinService.mjs';
import {
  consumeDraftOnPublish,
  deleteUserDraft,
  getUserDraft,
  listUserDrafts,
  saveUserDraft
} from '../shared/draftService.mjs';
import {
  DEFAULT_MCP_PAIRING_TTL_HOURS,
  MCP_TOOLS,
  addLandContributor,
  connectMcpPairing,
  createMcpPairing,
  createPublishSignatureRequestForMobile,
  directOwnerCreateSculptureOnLand,
  directOwnerDeleteSculpture,
  directOwnerEraseLand,
  directOwnerRollbackRevision,
  directOwnerSetSculptureVisibility,
  directOwnerUpdateParcel,
  directOwnerUpdateSculpture,
  disconnectMcpPairing,
  getLandSettingsInternal,
  getMyLandsWorkspace,
  getPublicParcelDetail,
  inspectParcelFitForModel,
  getSignatureRequest,
  getSignatureRequestPreviewModel,
  handleMcpJsonRpc,
  isUserLandOwner,
  isUserParcelContributor,
  listLandContributorsAndEligible,
  listLandsWithCurations,
  listMcpPairings,
  listPendingSignaturesForUser,
  listSculptureRevisions,
  listSignatureHistoryForUser,
  rejectSignatureRequest,
  removeLandContributor,
  signRequestByAgent,
  signRequestByMobile,
  updateLandSettings,
  upsertAnchorAndRevision
} from '../shared/mcpService.mjs';
import {
  b64ToModelBytes,
  CUSTOM_MODEL_MAX_BYTES,
  fetchModelBytesFromGateways,
  FORMAT_MIME_TYPES,
  validate3dModelUrl,
  validateAnchorOffset
} from '../shared/model3d.mjs';
import { buildViewerDedupKey, recordLandView } from '../shared/landViewService.mjs';
import {
  checkAndConsumeRelayerQuota,
  fetchParcelLandmarkAnchor,
  refundRelayerQuota,
  saveParcelLandmarkAnchor,
  updateLandSecurityPolicy
} from '../shared/landmarkService.mjs';
import {
  deleteUserPasskey,
  issuePasskeyAssertionOptions,
  issuePasskeyRegistrationOptions,
  listUserPasskeys,
  verifyAndConsumePasskeyAssertionChallenge,
  verifyAndStorePasskeyRegistration
} from '../shared/passkeyService.mjs';
import {
  checkRateLimit,
  getOperationalHealthReport,
  logStructured,
  recordOpsEvent
} from '../shared/monitoringService.mjs';
import {
  buildPropertyOwnerPrompt,
  normalizePairingCode
} from '../shared/landSignatureMessage.mjs';
import { decryptPrivateKey, resolveRecipientAddress } from './services/wallet.mjs';

export function createAppServer(serverOptions = {}) {
  const effectiveRelayerDailyQuota =
    Number.isFinite(Number(serverOptions?.relayerDailyQuota))
      ? Number(serverOptions.relayerDailyQuota)
      : CONFIG.relayerDailyQuota;
  const effectivePublishRateLimit =
    Number.isFinite(Number(serverOptions?.publishRateLimit))
      ? Number(serverOptions.publishRateLimit)
      : 30;
  const effectiveMcpRateLimit =
    Number.isFinite(Number(serverOptions?.mcpRateLimit))
      ? Number(serverOptions.mcpRateLimit)
      : 120;
  const db = getDb();
  const app = express();

  function getTrustedWebAuthnOrigins(req) {
    const trusted = new Set();
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
      .split(',')[0]
      .trim();
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
      .split(',')[0]
      .trim();
    if (hostHeader) trusted.add(`${proto}://${hostHeader}`);
    if (CONFIG.publicUrl) {
      try {
        trusted.add(new URL(String(CONFIG.publicUrl)).origin);
      } catch {
        // ignore invalid publicUrl
      }
    }
    const originHeader = String(req.headers?.origin || '').trim();
    if (originHeader) {
      try {
        const ro = new URL(originHeader);
        const h = ro.hostname.toLowerCase();
        const hostName = hostHeader.split(':')[0].toLowerCase();
        if (
          (hostName === 'localhost' || hostName === '127.0.0.1') &&
          (h === 'localhost' || h === '127.0.0.1')
        ) {
          trusted.add(ro.origin);
        }
      } catch {
        // ignore invalid origin
      }
    }
    return [...trusted];
  }

  function getRequestRpId(req) {
    const originHeader = String(req.headers?.origin || '').trim();
    const trusted = getTrustedWebAuthnOrigins(req);
    if (originHeader && trusted.includes(originHeader)) {
      try {
        const originHost = new URL(originHeader).hostname.toLowerCase();
        if (originHost) return originHost;
      } catch {
        // ignore invalid origin
      }
    }
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
      .split(',')[0]
      .trim();
    return hostHeader.split(':')[0].toLowerCase() || 'localhost';
  }
  app.use(cors());
  app.use(express.json({ limit: '12mb' }));

  app.get('/llms.txt', (req, res) => {
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(buildLlmsTxt(apiOrigin));
  });

  app.get('/.well-known/agent.json', (req, res) => {
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.json(buildWellKnownAgentCard(apiOrigin));
  });

  // Ensure server responds cleanly to health checks
  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.json({ ok: true, db: 'connected', service: 'graffiland-api', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || 'Database probe failed' });
    }
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      googleClientId: CONFIG.googleClientId || null,
      allowDevGoogleAuth: CONFIG.allowDevGoogleAuth,
      policy: POLICY,
      feeBreakdown: TRANSACTION_FEES,
      stewardDefaults: STEWARD_DEFAULTS,
      chain: getChainStatus(),
      ipfsProvider: CONFIG.pinataJwt
        ? 'pinata'
        : CONFIG.ipfsApiUrl
        ? 'kubo'
        : 'local-cid'
    });
  });

  // EIP-7572 / OpenSea Collection Metadata
  app.get('/api/contract/metadata.json', (req, res) => {
    const chain = getChainStatus();
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.json(
      buildContractMetadata({
        publicUrl: CONFIG.publicUrl,
        apiOrigin,
        royaltyBps: chain.resaleFeeBps,
        royaltyReceiver: chain.royaltyReceiver,
        contractAddress: chain.contractAddress,
        chain: chain.network
      })
    );
  });

  // ERC-721 Token ID Metadata endpoint (for marketplaces resolving by tokenId)
  app.get('/api/tokens/:tokenId.json', (req, res) => {
    const tokenId = String(req.params.tokenId || '').trim();
    const row = db
      .prepare('SELECT * FROM sculptures WHERE token_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 1')
      .get(tokenId);
    if (!row) return res.status(404).json({ error: 'Token not found' });
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.json(formatMarketplaceTokenMetadata(row, { apiOrigin, publicUrl: CONFIG.publicUrl }));
  });

  const sharedDb = {
    get: async (sql, params = []) => db.prepare(sql).get(...params),
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    run: async (sql, params = []) => db.prepare(sql).run(...params)
  };

  // Agent Sculpture Handoff Spec & Location-Anchored Session Routes
  app.get('/api/agent/spec', (req, res) => {
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.json(buildAgentSpec(apiOrigin));
  });

  app.post('/api/agent/sessions', async (req, res) => {
    try {
      const caller = getAuthUserFromRequest(req);
      const apiOrigin = `${req.protocol}://${req.get('host')}`;
      const out = await createAgentSession(sharedDb, {
        callerUser: caller,
        location: req.body?.location,
        apiOrigin
      });
      res.status(201).json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to create agent session' });
    }
  });

  app.get('/api/agent/sessions/:code', async (req, res) => {
    try {
      const apiOrigin = `${req.protocol}://${req.get('host')}`;
      const out = await getAgentSession(sharedDb, { code: req.params.code, apiOrigin });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to fetch agent session' });
    }
  });

  app.post('/api/agent/sessions/:code/sculpture', async (req, res) => {
    try {
      const apiOrigin = `${req.protocol}://${req.get('host')}`;
      const out = await submitAgentSculpture(sharedDb, {
        code: req.params.code,
        body: req.body || {},
        apiOrigin
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        error: err.message || 'Failed to stage agent sculpture',
        ...(err?.extra || {})
      });
    }
  });

  // Google Auth Only
  app.post('/api/auth/google', async (req, res) => {
    try {
      const profile = await verifyGoogleSignIn(req.body || {});
      const userRow = upsertGoogleUser(profile);
      const token = issueSessionToken(userRow);
      res.json({ token, user: sanitizeUser(userRow) });
    } catch (err) {
      res.status(401).json({ error: err.message || 'Google login failed' });
    }
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
  });

  // User Profiles: live username availability validation, profile update (username + bio), and public profiles
  app.get('/api/profile/check-username', async (req, res) => {
    try {
      const authUser = getAuthUserFromRequest(req);
      const result = await checkUsernameAvailability(chatDb, {
        username: String(req.query?.username || ''),
        excludeUserId: authUser?.id || ''
      });
      res.json(result);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Username check failed' });
    }
  });

  app.get('/api/profile/me', requireAuth, async (req, res) => {
    try {
      const origin = `${req.protocol}://${req.get('host')}`;
      const pub = await getPublicProfile(chatDb, {
        identifier: req.user.id,
        origin,
        pathname: '/'
      });
      res.json({ user: sanitizeUser(req.user), ...pub });
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to load profile' });
    }
  });

  const handleProfileSave = async (req, res) => {
    try {
      const updated = await updateUserProfile(chatDb, {
        user: req.user,
        username: req.body?.username,
        bio: req.body?.bio,
        avatarImage: req.body?.avatarImage,
        headerImage: req.body?.headerImage
      });
      const origin = `${req.protocol}://${req.get('host')}`;
      const pub = await getPublicProfile(chatDb, {
        identifier: updated.id,
        origin,
        pathname: '/'
      });
      res.json({ user: sanitizeUser(updated), ...pub });
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to save profile' });
    }
  };
  app.patch('/api/profile', requireAuth, handleProfileSave);
  app.post('/api/profile', requireAuth, handleProfileSave);

  app.get('/api/profiles/:handle', async (req, res) => {
    try {
      const origin = `${req.protocol}://${req.get('host')}`;
      const pub = await getPublicProfile(chatDb, {
        identifier: decodeURIComponent(req.params.handle || ''),
        origin,
        pathname: '/'
      });
      res.json(pub);
    } catch (err) {
      res.status(err?.statusCode || 404).json({ error: err.message || 'Profile not found' });
    }
  });

  app.post('/api/wallet/payout', requireAuth, (req, res) => {
    const raw = String(req.body?.address || '').trim();
    if (raw && !ethers.isAddress(raw)) {
      return res.status(400).json({ error: 'Invalid EVM wallet address.' });
    }
    const normalized = raw ? ethers.getAddress(raw) : '';
    const isEmbedded =
      normalized && String(req.user.wallet_address || '').toLowerCase() === normalized.toLowerCase();
    let verifiedProof = null;
    if (normalized && !isEmbedded) {
      // The payout address is also treated as an ownership identity (land + sculpture checks),
      // so require proof of control and refuse addresses already linked to another account.
      try {
        verifiedProof = verifyPayoutLinkSignature({
          userId: req.user.id,
          address: normalized,
          issuedAt: req.body?.issuedAt,
          signature: req.body?.signature
        });
      } catch (err) {
        return res.status(err?.statusCode || 400).json({ error: err.message });
      }
      const taken = db
        .prepare(
          'SELECT id FROM users WHERE id != ? AND (LOWER(wallet_address) = ? OR LOWER(custom_payout_address) = ?) LIMIT 1'
        )
        .get(req.user.id, normalized.toLowerCase(), normalized.toLowerCase());
      if (taken) {
        return res
          .status(409)
          .json({ error: 'That wallet address is already linked to another SPRAY.LAND account.' });
      }
      db.prepare(
        `INSERT INTO payout_address_proofs (user_id, address, message, signature, verified_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           address = excluded.address,
           message = excluded.message,
           signature = excluded.signature,
           verified_at = excluded.verified_at`
      ).run(
        req.user.id,
        normalized,
        verifiedProof.message,
        String(req.body?.signature || '').trim(),
        new Date().toISOString()
      );
    } else {
      db.prepare('DELETE FROM payout_address_proofs WHERE user_id = ?').run(req.user.id);
    }
    db.prepare('UPDATE users SET custom_payout_address = ? WHERE id = ?').run(
      normalized,
      req.user.id
    );
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: sanitizeUser(updated) });
  });

  app.get('/api/wallet/export', requireAuth, (_req, res) => {
    res.status(403).json({
      error: 'Hardware Passkey verification is required to export your embedded wallet key.',
      code: 'PASSKEY_REQUIRED'
    });
  });

  app.post('/api/wallet/export/challenge', requireAuth, async (req, res) => {
    try {
      await checkRateLimit(chatDb, {
        scope: 'wallet_export',
        key: req.user.id,
        windowSec: 300,
        maxRequests: 10
      });
      const options = await issuePasskeyAssertionOptions(chatDb, {
        user: req.user,
        purpose: 'wallet_export',
        rpId: getRequestRpId(req)
      });
      res.json(options);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message, ...(err?.extra || {}) });
    }
  });

  app.post('/api/wallet/export', requireAuth, async (req, res) => {
    try {
      await checkRateLimit(chatDb, {
        scope: 'wallet_export',
        key: req.user.id,
        windowSec: 300,
        maxRequests: 10
      });
      await verifyAndConsumePasskeyAssertionChallenge(chatDb, {
        user: req.user,
        challenge: req.body?.challenge,
        assertion: req.body?.assertion,
        purpose: 'wallet_export',
        expectedRpId: getRequestRpId(req),
        allowedOrigins: getTrustedWebAuthnOrigins(req)
      });
      const privateKey = decryptPrivateKey(req.user.encrypted_wallet_json);
      res.set('Cache-Control', 'no-store');
      res.json({
        walletAddress: req.user.wallet_address,
        privateKey
      });
    } catch (err) {
      const status = err?.statusCode || 500;
      res.status(status).json({
        error: err?.message || 'Failed to export embedded wallet',
        ...(err?.extra || {})
      });
    }
  });

  // Public Sculptures (Map, Gallery, Mobile AR Preview Mode)
  const SCULPTURE_SELECT_SQL = `
    SELECT s.*,
      (SELECT COUNT(*) FROM sculpture_chat_boards b
        LEFT JOIN sculptures bs ON bs.id = b.sculpture_id
        WHERE b.sculpture_id = s.id OR b.sculpture_id = s.parcel_id OR (s.parcel_id != '' AND bs.parcel_id = s.parcel_id AND bs.hidden = 0)) AS chat_initialized,
      (SELECT COUNT(*) FROM sculpture_chat_messages m
        LEFT JOIN sculptures ms ON ms.id = m.sculpture_id
        WHERE m.sculpture_id = s.id OR m.sculpture_id = s.parcel_id OR (s.parcel_id != '' AND ms.parcel_id = s.parcel_id AND ms.hidden = 0)) AS chat_message_count,
      (SELECT COUNT(*) FROM sculpture_chat_boards b
        LEFT JOIN sculptures bs ON bs.id = b.sculpture_id
        WHERE (b.sculpture_id = s.id OR b.sculpture_id = s.parcel_id OR (s.parcel_id != '' AND bs.parcel_id = s.parcel_id AND bs.hidden = 0))
          AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue,
      (SELECT b.batch_seq FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_batch_seq,
      (SELECT b.pin_count FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_count,
      (SELECT b.ipfs_cid FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_ipfs_cid,
      (SELECT b.ipfs_uri FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_ipfs_uri,
      (SELECT b.updated_at FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_updated_at,
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
      COALESCE(l.qual_contributor, 1) AS qual_contributor
     FROM sculptures s
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
  `;

  app.get('/api/sculptures', (req, res) => {
    const latParam = req.query.lat !== undefined ? Number(req.query.lat) : null;
    const lngParam = req.query.lng !== undefined ? Number(req.query.lng) : null;
    const radiusMeters =
      req.query.radiusMeters !== undefined ? Math.max(10, Number(req.query.radiusMeters)) : null;
    const parcelFilter = req.query.parcel ? String(req.query.parcel).toUpperCase() : null;
    const includeVoxels =
      req.query.includeVoxels !== '0' && req.query.includeVoxels !== 'false';

    const selectSql = buildSculptureSelectSql({ includeVoxels });
    const { whereSql, params } = buildSpatialBoundingWhere({
      lat: latParam,
      lng: lngParam,
      radiusMeters,
      parcel: parcelFilter
    });
    const rows = db
      .prepare(`${selectSql} WHERE ${whereSql} ORDER BY s.created_at DESC`)
      .all(...params);

    let items = rows.map((r) => serializeSculptureRow(r, { includeVoxels }));

    if (Number.isFinite(latParam) && Number.isFinite(lngParam)) {
      items = items
        .map((item) => ({
          ...item,
          distanceMeters: Math.round(haversineMeters(latParam, lngParam, item.lat, item.lng) * 10) / 10
        }))
        .filter((item) => (Number.isFinite(radiusMeters) ? item.distanceMeters <= radiusMeters : true))
        .sort((a, b) => a.distanceMeters - b.distanceMeters);
    }

    res.json({ sculptures: items });
  });

  app.get('/api/sculptures/:id', async (req, res) => {
    const row = db.prepare(`${SCULPTURE_SELECT_SQL} WHERE s.id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Sculpture not found' });
    const caller = getAuthUserFromRequest(req);
    const viewerIsLandOwner = caller
      ? await isUserLandOwner(chatDb, { parcelId: row.parcel_id, user: caller })
      : false;
    const callerWallets = caller
      ? [caller.wallet_address, caller.custom_payout_address]
          .filter(Boolean)
          .map((a) => String(a).toLowerCase())
      : [];
    const viewerIsSculptureOwner = Boolean(
      row.recipient_address && callerWallets.includes(String(row.recipient_address).toLowerCase())
    );
    if (row.hidden && !caller?.is_admin && !viewerIsLandOwner && !viewerIsSculptureOwner) {
      return res.status(404).json({ error: 'Sculpture not available' });
    }
    const transfers = await listSculptureTransfers(chatDb, req.params.id);
    const viewerCanContribute = caller
      ? await isUserParcelContributor(chatDb, { parcelId: row.parcel_id, user: caller })
      : false;
    const landSettings = await getLandSettingsInternal(chatDb, row.parcel_id);
    res.json({
      sculpture: serializeSculptureRow(row, {
        includeAdminFields: Boolean(caller?.is_admin),
        includeVoxels: true,
        transfers,
        viewerCanContribute,
        viewerIsLandOwner,
        parcelFrozen: landSettings.frozen
      })
    });
  });

  async function handleSculptureModelDownload(req, res) {
    const row = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Sculpture not found' });
    const caller = getAuthUserFromRequest(req);
    if (row.hidden && !caller?.is_admin) {
      return res.status(404).json({ error: 'Sculpture not available' });
    }
    const custom = db
      .prepare('SELECT * FROM sculpture_models WHERE sculpture_id = ?')
      .get(row.id);
    if (custom) {
      let bytesBuf = null;
      let modelSource = '';
      const cid = custom.model_cid || row.ipfs_model_cid || '';
      const fmt = String(custom.model_format || 'glb').toLowerCase();
      const resolvedMime =
        custom.mime_type || FORMAT_MIME_TYPES[fmt] || 'application/octet-stream';

      if (custom.inline_b64) {
        bytesBuf = Buffer.from(b64ToModelBytes(custom.inline_b64));
        modelSource = 'db-inline';
      }
      if (!bytesBuf && cid) {
        const local = readLocalIpfsCid(cid);
        if (local?.buffer) {
          bytesBuf = local.buffer;
          modelSource = 'local-ipfs';
        }
      }
      if (!bytesBuf && (cid || custom.model_url)) {
        const fetched = await fetchModelBytesFromGateways({
          cid,
          gatewayBase: CONFIG.ipfsGateway,
          gatewayUrl: custom.gateway_url || '',
          externalUrl: custom.model_url || '',
          format: fmt,
          maxBytes: CUSTOM_MODEL_MAX_BYTES
        });
        if (fetched?.bytes && fetched.bytes.length > 0) {
          bytesBuf = Buffer.from(fetched.bytes);
          modelSource = 'ipfs-gateway';
          if (cid) {
            cacheLocalIpfsCid(cid, bytesBuf, fmt);
          }
        }
      }
      if (bytesBuf) {
        res.setHeader('Content-Type', resolvedMime);
        res.setHeader(
          'Content-Disposition',
          `inline; filename="graffiland-${row.id}.${fmt}"`
        );
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Model-Source', modelSource);
        return res.send(bytesBuf);
      }
      if (custom.model_url) {
        return res.redirect(302, custom.model_url);
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        error: `3D .${fmt.toUpperCase()} model asset is temporarily unreachable from IPFS.`,
        cid
      });
    }
    const voxels = JSON.parse(row.voxels_json || '[]');
    const glb = buildSculptureGlb(voxels, {
      id: row.id,
      title: row.title,
      parcelId: row.parcel_id,
      geohash: row.geohash
    });
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', `inline; filename="graffiland-${row.id}.glb"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(glb));
  }

  app.get('/api/sculptures/:id/model', handleSculptureModelDownload);
  app.get('/api/sculptures/:id/model.glb', handleSculptureModelDownload);

  app.get('/api/sculptures/:id/metadata.json', (req, res) => {
    const row = db.prepare(`${SCULPTURE_SELECT_SQL} WHERE s.id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Sculpture not found' });
    const caller = getAuthUserFromRequest(req);
    if (row.hidden && !caller?.is_admin) {
      return res.status(404).json({ error: 'Sculpture not available' });
    }
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.json(formatMarketplaceTokenMetadata(row, { apiOrigin, publicUrl: CONFIG.publicUrl }));
  });

  app.post('/api/sculptures/:id/transfer', requireAuth, async (req, res) => {
    try {
      const result = await transferSculptureNft(chatDb, {
        sculptureId: req.params.id,
        callerUser: req.user,
        toAddress: req.body?.toAddress,
        txHash: req.body?.txHash,
        signature: req.body?.signature,
        decryptEmbeddedPrivateKey: async (u) => decryptPrivateKey(u.encrypted_wallet_json),
        chainCfg: getChainStatus()
      });
      res.json(result);
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        error: err.message || 'Transfer failed',
        ...(err?.extra || {})
      });
    }
  });

  app.post('/api/sculptures/:id/sync-ownership', async (req, res) => {
    try {
      const caller = getAuthUserFromRequest(req);
      const result = await syncSculptureOwnership(chatDb, {
        sculptureId: req.params.id,
        chainCfg: getChainStatus(),
        callerUser: caller
      });
      res.json(result);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Ownership sync failed' });
    }
  });

  // Server-Blind Location-Locked E2EE Sculpture Chat Routes
  const chatDb = {
    get: async (sql, params = []) => db.prepare(sql).get(...params),
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    run: async (sql, params = []) => db.prepare(sql).run(...params)
  };

  function handleChatRoute(fn) {
    return async (req, res) => {
      try {
        const result = await fn(req);
        res.json(result);
      } catch (err) {
        res
          .status(err?.statusCode || 400)
          .json({ error: err.message || 'Chat request failed', ...(err?.extra || {}) });
      }
    };
  }

  app.post(
    '/api/sculptures/:id/chat/init',
    requireAuth,
    handleChatRoute((req) =>
      initChatBoard(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.post(
    '/api/sculptures/:id/chat/clue',
    requireAuth,
    handleChatRoute((req) =>
      updateBoardClue(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.post(
    '/api/sculptures/:id/chat/enter',
    requireAuth,
    handleChatRoute((req) =>
      enterChatBoard(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.post(
    '/api/sculptures/:id/chat/request-grant',
    requireAuth,
    handleChatRoute((req) =>
      requestChatGrant(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.post(
    '/api/sculptures/:id/chat/claim-grant',
    requireAuth,
    handleChatRoute((req) =>
      claimClueUnlockedGrant(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.get(
    '/api/chat/pending-grants',
    requireAuth,
    handleChatRoute((req) => listPendingGrantsForGrantor(chatDb, { user: req.user }))
  );

  app.get(
    '/api/sculptures/:id/chat/pending-grants',
    requireAuth,
    handleChatRoute((req) =>
      listPendingGrantsForGrantor(chatDb, { user: req.user, sculptureId: req.params.id })
    )
  );

  app.post(
    '/api/sculptures/:id/chat/grants',
    requireAuth,
    handleChatRoute((req) =>
      submitPeerGrant(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body
      })
    )
  );

  app.post(
    '/api/sculptures/:id/chat/messages',
    requireAuth,
    handleChatRoute(async (req) => {
      const out = await postEncryptedChatMessage(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      });
      return out;
    })
  );

  async function readIpfsJsonDoc(cid) {
    const local = readLocalIpfsCid(cid);
    if (local?.buffer) {
      try {
        return JSON.parse(local.buffer.toString('utf8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  app.get(
    '/api/sculptures/:id/pins/meta',
    handleChatRoute((req) => getPinnedBatchMeta(chatDb, { sculptureId: req.params.id }))
  );

  app.post(
    '/api/sculptures/:id/pins/owner-seal',
    requireAuth,
    handleChatRoute((req) =>
      getOwnerPinSeal(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        readIpfsJsonFn: readIpfsJsonDoc,
        pinMasterKek: CONFIG.pinMasterKek
      })
    )
  );

  app.post(
    '/api/sculptures/:id/pins/batch',
    requireAuth,
    handleChatRoute((req) =>
      saveEncryptedPinBatch(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        pinJsonFn: (obj, name) => pinJsonDocumentToIpfs(obj, name)
      })
    )
  );

  app.post(
    '/api/sculptures/:id/pins/challenge',
    requireAuth,
    handleChatRoute((req) =>
      issueParcelPresenceChallenge(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.post(
    '/api/sculptures/:id/pins/unlock',
    requireAuth,
    handleChatRoute((req) =>
      unlockPinnedBatchForParcelVisitor(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        userAgent: req.headers['user-agent'] || '',
        readIpfsJsonFn: readIpfsJsonDoc,
        pinMasterKek: CONFIG.pinMasterKek,
        expectedRpId: getRequestRpId(req)
      })
    )
  );

  app.get(
    '/api/drafts',
    requireAuth,
    handleChatRoute((req) => listUserDrafts(chatDb, { user: req.user }))
  );

  app.post(
    '/api/drafts',
    requireAuth,
    handleChatRoute((req) => saveUserDraft(chatDb, { user: req.user, body: req.body }))
  );

  app.get(
    '/api/drafts/:id',
    requireAuth,
    handleChatRoute((req) => getUserDraft(chatDb, { draftId: req.params.id, user: req.user }))
  );

  app.delete(
    '/api/drafts/:id',
    requireAuth,
    handleChatRoute((req) => deleteUserDraft(chatDb, { draftId: req.params.id, user: req.user }))
  );

  // Robust MCP Pairing, Land Ownership Edits, Signature Notifications & Agent Signing
  const mcpNotifySubscribers = new Map(); // pairingCode -> Set<WebSocket>
  function notifyPairedMobile(event) {
    const code = normalizePairingCode(event?.pairingCode || '');
    if (!code) return;
    const set = mcpNotifySubscribers.get(code);
    if (!set) return;
    const msgStr = JSON.stringify(event);
    for (const sock of set) {
      if (sock && sock.readyState === 1) {
        sock.send(msgStr);
      }
    }
  }

  function makePinHook() {
    return ({ sculptureId, title, description, voxels, customModel, previewDataUrl, locationBundle, creatorAddress }) =>
      pinSculptureToIpfs({
        sculptureId,
        title,
        description,
        voxels,
        customModel,
        previewDataUrl,
        locationBundle,
        creatorAddress,
        royaltyBps: CONFIG.resaleFeeBps,
        royaltyReceiver: getChainStatus().royaltyReceiver
      });
  }

  function makeMintHook() {
    return (mintArgs) => mintOnRobinhoodChain(mintArgs);
  }

  function getPairingCodeFromReq(req) {
    return (
      req.headers['x-graffiland-pairing-code'] ||
      req.body?.pairingCode ||
      req.body?.params?.pairingCode ||
      req.body?.params?.arguments?.pairingCode ||
      req.query?.pairingCode ||
      ''
    );
  }

  // Zero-OAuth Agent Auth, Scouting, Free Claims, Quests & 5%/3%/2% Marketplace
  app.post(
    '/api/agents/challenge',
    handleChatRoute((req) =>
      issueAgentAuthChallenge(chatDb, { walletAddress: req.body?.walletAddress })
    )
  );

  app.post('/api/agents/register', async (req, res) => {
    try {
      const out = await registerOrLoginAgentWallet(chatDb, {
        walletAddress: req.body?.walletAddress,
        nonce: req.body?.nonce,
        signature: req.body?.signature,
        name: req.body?.name,
        framework: req.body?.framework,
        description: req.body?.description,
        endpointUrl: req.body?.endpointUrl,
        sessionSecret: CONFIG.sessionSecret
      });
      res.status(201).json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Agent registration failed' });
    }
  });

  app.get(
    '/api/agents/me',
    requireAuth,
    handleChatRoute((req) => getAgentProfile(chatDb, req.user.id))
  );

  app.get(
    '/api/agents/leaderboard',
    handleChatRoute((req) =>
      getDualLeaderboards(chatDb, { limit: Number(req.query?.limit || 25) })
    )
  );

  app.get(
    '/api/agents/:agentId',
    handleChatRoute((req) => getAgentProfile(chatDb, req.params.agentId))
  );

  app.get(
    '/api/lands/scout',
    handleChatRoute((req) =>
      scoutLands(chatDb, {
        lat: req.query?.lat !== undefined ? Number(req.query.lat) : null,
        lng: req.query?.lng !== undefined ? Number(req.query.lng) : null,
        radiusMeters: req.query?.radiusMeters ? Number(req.query.radiusMeters) : 5000,
        statusFilter: String(req.query?.status || 'all')
      })
    )
  );

  app.get('/api/lands/check-name', async (req, res) => {
    try {
      const out = await checkLandTitleAvailability(chatDb, {
        name: String(req.query?.name || ''),
        excludeParcelId: String(req.query?.excludeParcelId || '')
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not check land title' });
    }
  });

  app.get('/api/archive', async (req, res) => {
    try {
      const out = await listArchivedLands(chatDb, {
        q: String(req.query?.q || ''),
        reason: String(req.query?.reason || ''),
        steward: String(req.query?.steward || ''),
        limit: req.query?.limit ? Number(req.query.limit) : 50,
        offset: req.query?.offset ? Number(req.query.offset) : 0
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not load land archive' });
    }
  });

  app.get('/api/archive/:id', async (req, res) => {
    try {
      const out = await getArchivedLandDetail(chatDb, req.params.id);
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 404).json({ error: err.message || 'Archive record not found' });
    }
  });

  app.get('/api/lands/archive', async (req, res) => {
    try {
      const out = await listArchivedLands(chatDb, {
        q: String(req.query?.q || ''),
        reason: String(req.query?.reason || ''),
        steward: String(req.query?.steward || ''),
        limit: req.query?.limit ? Number(req.query.limit) : 50,
        offset: req.query?.offset ? Number(req.query.offset) : 0
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not load land archive' });
    }
  });

  app.get('/api/lands/archive/:id', async (req, res) => {
    try {
      const out = await getArchivedLandDetail(chatDb, req.params.id);
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 404).json({ error: err.message || 'Archive record not found' });
    }
  });

  app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
      await reapAndArchiveExpiredLands(chatDb).catch(() => {});
      const out = await listUserNotifications(chatDb, req.user.id, {
        limit: req.query?.limit ? Number(req.query.limit) : 40
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not load notifications' });
    }
  });

  app.post('/api/notifications/read', requireAuth, async (req, res) => {
    try {
      const out = await markNotificationsRead(chatDb, req.user.id, {
        ids: Array.isArray(req.body?.ids) ? req.body.ids : null,
        markAll: Boolean(req.body?.markAll)
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not mark notifications read' });
    }
  });

  app.patch('/api/notifications/preferences', requireAuth, async (req, res) => {
    try {
      const preferences = await updateNotificationPreferences(chatDb, req.user.id, req.body || {});
      res.json({ preferences });
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not update notification preferences' });
    }
  });

  app.delete('/api/notifications', requireAuth, async (req, res) => {
    try {
      const scope = req.query?.scope === 'read' ? 'read' : 'all';
      const out = await clearUserNotifications(chatDb, req.user.id, { scope });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not clear notifications' });
    }
  });

  app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
    try {
      const out = await deleteNotification(chatDb, req.user.id, req.params.id);
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Could not delete notification' });
    }
  });

  app.post('/api/lands/claim', requireAuth, async (req, res) => {
    try {
      const out = await claimDormantLand(chatDb, {
        agentUser: req.user,
        parcelId: req.body?.parcelId || '',
        lat: req.body?.lat,
        lng: req.body?.lng,
        customName: req.body?.customName || '',
        description: req.body?.description || '',
        curationNote: req.body?.curationNote || '',
        volume: req.body?.volume || null,
        txHash: req.body?.txHash || '',
        chainCfg: getChainStatus()
      });
      res.status(201).json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        error: err.message || 'Land claim failed',
        ...(err?.extra || {})
      });
    }
  });

  app.post('/api/lands/:parcelId/volume', requireAuth, async (req, res) => {
    try {
      const out = await updateLandVolume(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        volume: req.body?.volume || req.body || {}
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        error: err.message || 'Could not update 3D land volume',
        ...(err?.extra || {})
      });
    }
  });

  app.get(
    '/api/geocode/search',
    handleChatRoute((req) =>
      searchLocations({
        query: String(req.query?.q || ''),
        lat: req.query?.lat !== undefined ? Number(req.query.lat) : null,
        lng: req.query?.lng !== undefined ? Number(req.query.lng) : null,
        limit: req.query?.limit ? Number(req.query.limit) : 6
      })
    )
  );

  app.get(
    '/api/geocode/reverse',
    handleChatRoute((req) =>
      reverseGeocodeLocation({
        lat: req.query?.lat !== undefined ? Number(req.query.lat) : null,
        lng: req.query?.lng !== undefined ? Number(req.query.lng) : null
      })
    )
  );

  app.get(
    '/api/lands/:parcelId/telemetry',
    handleChatRoute((req) => getLandTelemetry(chatDb, req.params.parcelId))
  );

  app.post('/api/lands/:parcelId/checkin', requireAuth, async (req, res) => {
    try {
      const out = await checkInToLandInPerson(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body || {},
        userAgent: String(req.headers['user-agent'] || '')
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        error: err.message || 'In-person check-in failed',
        ...(err?.extra || {})
      });
    }
  });

  app.post('/api/lands/:parcelId/quests', requireAuth, async (req, res) => {
    try {
      const out = await createArtQuest(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        title: req.body?.title,
        prompt: req.body?.prompt,
        theme: req.body?.theme,
        bountyEth: req.body?.bountyEth,
        maxCompletions: req.body?.maxCompletions,
        slotOffsets: req.body?.slotOffsets
      });
      res.status(201).json({ quest: out });
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Quest creation failed' });
    }
  });

  app.get(
    '/api/quests/nearby',
    handleChatRoute((req) =>
      listNearbyQuests(chatDb, {
        lat: req.query?.lat !== undefined ? Number(req.query.lat) : null,
        lng: req.query?.lng !== undefined ? Number(req.query.lng) : null,
        radiusMeters: req.query?.radiusMeters ? Number(req.query.radiusMeters) : 25000,
        status: String(req.query?.status || 'open')
      })
    )
  );

  app.get(
    '/api/marketplace/listings',
    handleChatRoute(async (req) => ({
      listings: await listMarketplaceItems(chatDb, {
        status: String(req.query?.status || 'active'),
        parcelId: String(req.query?.parcel || ''),
        limit: req.query?.limit ? Number(req.query.limit) : 60
      })
    }))
  );

  app.post('/api/marketplace/listings', requireAuth, async (req, res) => {
    try {
      const listing = await createMarketplaceListing(chatDb, {
        sculptureId: req.body?.sculptureId,
        sellerUser: req.user,
        priceEth: req.body?.priceEth,
        platformAddress: getChainStatus().royaltyReceiver
      });
      res.status(201).json({ listing });
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Listing failed' });
    }
  });

  app.post('/api/marketplace/listings/:id/buy', requireAuth, async (req, res) => {
    try {
      const out = await executeMarketplacePurchase(chatDb, {
        listingId: req.params.id,
        buyerUser: req.user,
        buyerAddress: req.body?.buyerAddress || '',
        txHash: req.body?.txHash || '',
        platformAddress: getChainStatus().royaltyReceiver
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Purchase failed' });
    }
  });

  app.get(
    '/api/economy/splits',
    handleChatRoute((req) =>
      getEconomySplitsSummary(chatDb, {
        parcelId: String(req.query?.parcel || ''),
        address: String(req.query?.address || '')
      })
    )
  );

  app.get('/api/mcp/spec', (req, res) => {
    const apiOrigin = `${req.protocol}://${req.get('host')}`;
    res.json({
      protocol: 'Model Context Protocol (JSON-RPC 2.0)',
      endpoint: `${apiOrigin}/api/mcp`,
      requiresActivePairingConnection: true,
      tools: MCP_TOOLS,
      agentSpec: buildAgentSpec(apiOrigin),
      ownerPromptTemplate: buildPropertyOwnerPrompt({ apiOrigin })
    });
  });

  app.post(
    '/api/mcp/pairings',
    requireAuth,
    handleChatRoute((req) =>
      createMcpPairing(chatDb, {
        user: req.user,
        expiresHours: Number(req.body?.expiresHours || DEFAULT_MCP_PAIRING_TTL_HOURS),
        apiOrigin: `${req.protocol}://${req.get('host')}`
      })
    )
  );

  app.get(
    '/api/mcp/pairings',
    requireAuth,
    handleChatRoute((req) => listMcpPairings(chatDb, { user: req.user }))
  );

  app.post('/api/mcp/pairings/connect', async (req, res) => {
    try {
      const caller = getAuthUserFromRequest(req);
      const out = await connectMcpPairing(chatDb, {
        pairingCode: req.body?.pairingCode || req.body?.code || getPairingCodeFromReq(req),
        agentName: req.body?.agentName,
        agentAddress: req.body?.agentAddress,
        signature: req.body?.signature,
        callerUser: caller,
        apiOrigin: `${req.protocol}://${req.get('host')}`
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Pairing connect failed' });
    }
  });

  app.post(
    '/api/mcp/pairings/:code/disconnect',
    requireAuth,
    handleChatRoute((req) =>
      disconnectMcpPairing(chatDb, { pairingCode: req.params.code, user: req.user })
    )
  );

  app.post('/api/mcp', async (req, res) => {
    const id = req.body?.id ?? null;
    try {
      const pairingCode = getPairingCodeFromReq(req);
      await checkRateLimit(chatDb, {
        scope: 'mcp',
        key: pairingCode || req.ip || 'anon',
        windowSec: 60,
        maxRequests: effectiveMcpRateLimit
      });
      const caller = getAuthUserFromRequest(req);
      const out = await handleMcpJsonRpc(chatDb, {
        rpcBody: req.body || {},
        pairingCode,
        callerUser: caller,
        apiOrigin: `${req.protocol}://${req.get('host')}`,
        pinSculptureFn: makePinHook(),
        mintSculptureFn: makeMintHook(),
        notifyMobileFn: notifyPairedMobile,
        emitMetadataUpdateFn: emitMetadataUpdateOnChain
      });
      res.json(out);
    } catch (err) {
      if (err?.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      res.status(err?.statusCode || 400).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: err?.statusCode === 403 ? -32001 : -32000,
          message: err.message || 'MCP request failed',
          data: err?.extra || {}
        }
      });
    }
  });

  app.put(
    '/api/sculptures/:id',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerUpdateSculpture(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        pinSculptureFn: makePinHook(),
        emitMetadataUpdateFn: emitMetadataUpdateOnChain
      })
    )
  );

  app.post(
    '/api/sculptures/:id/edit',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerUpdateSculpture(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        body: req.body,
        pinSculptureFn: makePinHook(),
        emitMetadataUpdateFn: emitMetadataUpdateOnChain
      })
    )
  );

  app.get(
    '/api/sculptures/:id/revisions',
    handleChatRoute((req) => listSculptureRevisions(chatDb, { sculptureId: req.params.id }))
  );

  app.post(
    '/api/sculptures/:id/revisions/:revNum/rollback',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerRollbackRevision(chatDb, {
        sculptureId: req.params.id,
        revNum: Number(req.params.revNum),
        user: req.user,
        emitMetadataUpdateFn: emitMetadataUpdateOnChain
      })
    )
  );

  app.post(
    '/api/sculptures/:id/visibility',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerSetSculptureVisibility(chatDb, {
        sculptureId: req.params.id,
        user: req.user,
        hidden: Boolean(req.body?.hidden),
        reason: req.body?.reason || ''
      })
    )
  );

  app.delete(
    '/api/sculptures/:id',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerDeleteSculpture(chatDb, { sculptureId: req.params.id, user: req.user })
    )
  );

  app.get('/api/lands', async (_req, res) => {
    res.json({ parcels: await listLandsWithCurations(chatDb) });
  });

  app.get(
    '/api/lands/mine',
    requireAuth,
    handleChatRoute((req) => getMyLandsWorkspace(chatDb, { user: req.user }))
  );

  app.post('/api/models/validate-url', requireAuth, async (req, res) => {
    const modelUrl = String(req.body?.modelUrl || req.body?.url || '').trim();
    const formatHint = String(req.body?.modelFormat || req.body?.format || '').trim();
    const parcelId = String(req.body?.parcelId || '').trim();
    const modelScale = Number(req.body?.modelScale ?? req.body?.scale ?? 1);
    const anchorOffset = req.body?.anchorOffset && typeof req.body.anchorOffset === 'object' ? req.body.anchorOffset : {};
    const checked = await validate3dModelUrl(modelUrl, { formatHint });
    let landFit = null;
    if (checked.valid && parcelId) {
      landFit = await inspectParcelFitForModel(chatDb, {
        parcelId,
        bbox: checked.stats?.bbox || null,
        modelScale: Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 1,
        anchorOffset
      });
    }
    const payload = {
      valid: Boolean(checked.valid),
      error: checked.error || null,
      format: checked.format || '',
      mimeType: checked.mimeType || '',
      byteLength: checked.byteLength || 0,
      stats: checked.stats || null,
      suggestedTitle: checked.suggestedTitle || '',
      modelUrl,
      ...(landFit ? { landFit } : {})
    };
    return res.status(checked.valid ? 200 : 400).json(payload);
  });

  app.get(
    '/api/lands/:parcelId',
    handleChatRoute((req) =>
      getPublicParcelDetail(chatDb, { parcelOrSlug: req.params.parcelId })
    )
  );

  app.post(
    '/api/lands/:parcelId/view',
    handleChatRoute((req) => {
      const caller = getAuthUserFromRequest(req);
      const body = req.body || {};
      const viewerKey = buildViewerDedupKey({
        userId: caller?.id || '',
        sessionId: String(body.sessionId || ''),
        ip: String(req.headers['x-forwarded-for'] || req.ip || ''),
        userAgent: String(req.headers['user-agent'] || '')
      });
      return recordLandView(chatDb, {
        parcelId: req.params.parcelId,
        viewType: body.viewType === 'in_person' ? 'in_person' : 'page',
        viewerKey,
        lat: body.lat,
        lng: body.lng
      });
    })
  );

  app.post(
    '/api/lands/:parcelId/settings',
    requireAuth,
    handleChatRoute((req) =>
      updateLandSettings(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body
      })
    )
  );

  app.get(
    '/api/lands/:parcelId/contributors',
    requireAuth,
    handleChatRoute((req) =>
      listLandContributorsAndEligible(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user
      })
    )
  );

  app.post(
    '/api/lands/:parcelId/contributors',
    requireAuth,
    handleChatRoute((req) =>
      addLandContributor(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body
      })
    )
  );

  app.delete(
    '/api/lands/:parcelId/contributors/:contributorSub',
    requireAuth,
    handleChatRoute((req) =>
      removeLandContributor(chatDb, {
        parcelId: req.params.parcelId,
        contributorSub: req.params.contributorSub,
        user: req.user
      })
    )
  );

  app.post(
    '/api/lands/:parcelId/erase',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerEraseLand(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body
      })
    )
  );

  app.post(
    '/api/lands/:parcelId/update',
    requireAuth,
    handleChatRoute((req) =>
      directOwnerUpdateParcel(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body
      })
    )
  );

  app.post(
    '/api/lands/:parcelId/sculptures',
    requireAuth,
    handleChatRoute(async (req) => {
      await checkRateLimit(chatDb, {
        scope: 'land_create',
        key: req.user.id,
        windowSec: 60,
        maxRequests: effectivePublishRateLimit
      });
      const quotaRes = await checkAndConsumeRelayerQuota(chatDb, {
        userId: req.user.id,
        isAdmin: Boolean(req.user.is_admin),
        dailyQuota: effectiveRelayerDailyQuota
      });
      try {
        const out = await directOwnerCreateSculptureOnLand(chatDb, {
          parcelId: req.params.parcelId,
          user: req.user,
          body: req.body,
          pinSculptureFn: makePinHook(),
          mintSculptureFn: makeMintHook(),
          notifyMobileFn: notifyPairedMobile
        });
        if (out?.requiresOwnerApproval && quotaRes?.consumed) {
          await refundRelayerQuota(chatDb, { userId: req.user.id });
        }
        return out;
      } catch (err) {
        if (quotaRes?.consumed) {
          await refundRelayerQuota(chatDb, { userId: req.user.id });
        }
        throw err;
      }
    })
  );

  app.post(
    '/api/lands/:parcelId/landmark-pack',
    requireAuth,
    handleChatRoute((req) =>
      saveParcelLandmarkAnchor(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body,
        pinJsonFn: (obj, name) => pinJsonDocumentToIpfs(obj, name)
      })
    )
  );

  app.post(
    '/api/lands/:parcelId/landmark-pack/fetch',
    handleChatRoute((req) =>
      fetchParcelLandmarkAnchor(chatDb, {
        parcelId: req.params.parcelId,
        body: req.body,
        userAgent: req.headers['user-agent'] || ''
      })
    )
  );

  app.post(
    '/api/lands/:parcelId/security',
    requireAuth,
    handleChatRoute((req) =>
      updateLandSecurityPolicy(chatDb, {
        parcelId: req.params.parcelId,
        user: req.user,
        body: req.body
      })
    )
  );

  app.get(
    '/api/passkeys/status',
    requireAuth,
    handleChatRoute(async (req) => ({
      passkeys: await listUserPasskeys(chatDb, req.user.id)
    }))
  );

  app.post(
    '/api/passkeys/register/options',
    requireAuth,
    handleChatRoute((req) =>
      issuePasskeyRegistrationOptions(req.user, { db: chatDb, rpId: getRequestRpId(req) })
    )
  );

  app.post(
    '/api/passkeys/register/verify',
    requireAuth,
    handleChatRoute((req) =>
      verifyAndStorePasskeyRegistration(chatDb, {
        user: req.user,
        body: req.body,
        rpId: getRequestRpId(req),
        allowedOrigins: getTrustedWebAuthnOrigins(req)
      })
    )
  );

  app.delete(
    '/api/passkeys/:id',
    requireAuth,
    handleChatRoute((req) =>
      deleteUserPasskey(chatDb, { userId: req.user.id, passkeyId: req.params.id, user: req.user })
    )
  );

  app.get(
    '/api/signatures/pending',
    requireAuth,
    handleChatRoute((req) =>
      listPendingSignaturesForUser(chatDb, {
        user: req.user,
        includeHistory: String(req.query?.includeHistory || '') === '1'
      })
    )
  );

  app.get(
    '/api/signatures/history',
    requireAuth,
    handleChatRoute((req) =>
      listSignatureHistoryForUser(chatDb, {
        user: req.user,
        limit: Number(req.query?.limit || 40)
      })
    )
  );

  app.post('/api/signatures/requests', requireAuth, async (req, res) => {
    try {
      const ua = String(req.headers['user-agent'] || '');
      const isMobile =
        Boolean(req.body?.deviceProfile?.isMobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
      const out = await createPublishSignatureRequestForMobile(chatDb, {
        user: req.user,
        body: req.body || {},
        pairingCode: getPairingCodeFromReq(req),
        isMobileRequest: isMobile,
        apiOrigin: `${req.protocol}://${req.get('host')}`
      });
      res.status(201).json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({
        error: err.message || 'Failed to create signature request',
        ...(err?.extra || {})
      });
    }
  });

  app.get('/api/signatures/requests/:id/preview-model', requireAuth, async (req, res) => {
    try {
      const out = await getSignatureRequestPreviewModel(chatDb, {
        requestId: req.params.id,
        user: req.user
      });
      res.setHeader('Content-Type', out.mimeType || 'model/gltf-binary');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(Buffer.from(out.bytes));
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Preview model unavailable' });
    }
  });

  app.get('/api/signatures/requests/:id', async (req, res) => {
    try {
      const caller = getAuthUserFromRequest(req);
      const out = await getSignatureRequest(chatDb, {
        requestId: req.params.id,
        user: caller,
        pairingCode: getPairingCodeFromReq(req)
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Signature status error' });
    }
  });

  app.post(
    '/api/signatures/requests/:id/mobile-sign',
    requireAuth,
    handleChatRoute((req) =>
      signRequestByMobile(chatDb, {
        requestId: req.params.id,
        user: req.user,
        signature: req.body?.signature || '',
        autoFitScale: Boolean(req.body?.autoFitScale),
        overrideScale: req.body?.overrideScale ?? null,
        decryptEmbeddedPrivateKey: async (u) => decryptPrivateKey(u.encrypted_wallet_json),
        pinSculptureFn: makePinHook(),
        mintSculptureFn: makeMintHook(),
        emitMetadataUpdateFn: emitMetadataUpdateOnChain
      })
    )
  );

  app.post('/api/signatures/requests/:id/agent-sign', async (req, res) => {
    try {
      const out = await signRequestByAgent(chatDb, {
        requestId: req.params.id,
        pairingCode: getPairingCodeFromReq(req),
        signature: req.body?.signature || '',
        txHash: req.body?.txHash || '',
        agentName: req.body?.agentName || '',
        pinSculptureFn: makePinHook(),
        mintSculptureFn: makeMintHook(),
        emitMetadataUpdateFn: emitMetadataUpdateOnChain
      });
      res.json(out);
    } catch (err) {
      res.status(err?.statusCode || 400).json({ error: err.message || 'Agent signature failed' });
    }
  });

  app.post(
    '/api/signatures/requests/:id/reject',
    requireAuth,
    handleChatRoute((req) => rejectSignatureRequest(chatDb, { requestId: req.params.id, user: req.user }))
  );

  app.get('/api/parcels', async (_req, res) => {
    res.json({ parcels: await listLandsWithCurations(chatDb) });
  });

  // Publish & Mint Sculpture (Mobile-created + PoL + IPFS + Robinhood Chain)
  app.post('/api/sculptures/publish', requireAuth, async (req, res) => {
    try {
      const ua = String(req.headers['user-agent'] || '');
      const deviceProfile = req.body?.deviceProfile || {};
      const looksMobile =
        Boolean(deviceProfile.isMobile) ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

      if (!looksMobile) {
        return res.status(403).json({
          error: 'Publishing sculptures requires a mobile device with camera, gyroscope, and GPS.'
        });
      }

      const validation = validatePublishPayload(req.body);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.errors.join(' '), errors: validation.errors });
      }

      const anchorCheck = validateAnchorOffset(req.body?.anchorOffset || {});
      if (anchorCheck.error) {
        return res.status(400).json({ error: anchorCheck.error });
      }

      await checkRateLimit(chatDb, {
        scope: 'publish',
        key: req.user.id || req.ip || 'anon',
        windowSec: 60,
        maxRequests: effectivePublishRateLimit
      });

      const verticalBounds = computeVerticalBounds(validation.cleanVoxels);
      const locationBundle = await verifyAndEnrichLocation(
        {
          ...(req.body?.location || {}),
          sculptureVerticalMinM: verticalBounds.minY,
          sculptureVerticalMaxM: verticalBounds.maxY
        },
        req.body?.proofOfLocation,
        req.user.id
      );

      if (!locationBundle.verified) {
        return res.status(422).json({
          error: `Proof of Location check failed (score ${locationBundle.score}/100${locationBundle.evidenceIssues?.length ? `: ${locationBundle.evidenceIssues.join('; ')}` : ''}). Enable GPS, live camera, and move your phone gently while sculpting.`,
          proofOfLocation: locationBundle
        });
      }

      // Only compare against previous IRL mobile PoL publishes (exclude remote MCP / owner land placements).
      const previousPublish = db
        .prepare(
          `SELECT lat, lng, created_at
           FROM sculptures
           WHERE creator_sub = ?
             AND pol_json NOT LIKE '%"propertyAuthorized":true%'
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get(req.user.id);
      const travel = assessTravelFeasibility(
        previousPublish
          ? { lat: previousPublish.lat, lng: previousPublish.lng, at: previousPublish.created_at }
          : null,
        { lat: locationBundle.lat, lng: locationBundle.lng }
      );
      if (!travel.ok) {
        return res.status(422).json({
          error: `Location jump too fast since your last publish (${Math.round(travel.distanceM / 1000)} km). Publish again from your current location later.`,
          travel
        });
      }

      const targetLandSettings = await getLandSettingsInternal(chatDb, locationBundle.parcelId);
      if (targetLandSettings.frozen) {
        return res.status(403).json({
          error: `Virtual Land ${locationBundle.parcelId} is frozen by its owner — no new sculptures can be placed here.`
        });
      }

      const quotaRes = await checkAndConsumeRelayerQuota(chatDb, {
        userId: req.user.id,
        isAdmin: Boolean(req.user.is_admin),
        dailyQuota: effectiveRelayerDailyQuota
      });

      // Horizontally center newly drawn voxel clouds on their own local origin (0, 0)
      // and shift (lat, lng) by the centroid offset so the art ALWAYS fits dead-center inside its land.
      const centeredVoxelCloud = centerVoxelsHorizontally(validation.cleanVoxels);
      const publishedVoxels = centeredVoxelCloud.voxels;
      const shiftedGeo =
        centeredVoxelCloud.shiftX !== 0 || centeredVoxelCloud.shiftZ !== 0
          ? offsetLatLngByLocalXZ(
              locationBundle.lat,
              locationBundle.lng,
              centeredVoxelCloud.shiftX,
              centeredVoxelCloud.shiftZ
            )
          : { lat: locationBundle.lat, lng: locationBundle.lng };
      const publishedLat = Number.isFinite(shiftedGeo.lat) ? shiftedGeo.lat : locationBundle.lat;
      const publishedLng = Number.isFinite(shiftedGeo.lng) ? shiftedGeo.lng : locationBundle.lng;
      const publishedLocationBundle = {
        ...locationBundle,
        lat: publishedLat,
        lng: publishedLng
      };

      const sculptureId = crypto.randomUUID();
      const recipientAddress = resolveRecipientAddress(req.user);

      let ipfsResult;
      let mintResult;
      try {
        ipfsResult = await pinSculptureToIpfs({
          sculptureId,
          title: validation.title,
          description: validation.description,
          voxels: publishedVoxels,
          previewDataUrl: req.body?.previewDataUrl || '',
          locationBundle: publishedLocationBundle,
          creatorAddress: recipientAddress,
          royaltyBps: CONFIG.resaleFeeBps,
          royaltyReceiver: getChainStatus().royaltyReceiver
        });

        mintResult = await mintOnRobinhoodChain({
          recipientAddress,
          metadataUri: ipfsResult.metadataUri,
          parcelBytes32: locationBundle.parcelBytes32,
          proofHash: locationBundle.proofHash,
          lat: locationBundle.lat,
          lng: locationBundle.lng
        });
      } catch (err) {
        if (quotaRes?.consumed) {
          await refundRelayerQuota(chatDb, { userId: req.user.id });
        }
        await recordOpsEvent(chatDb, {
          category: /pinata|ipfs/i.test(err?.message || '') ? 'pinata' : 'relayer_mint',
          status: 'error',
          actorId: req.user.id,
          parcelId: locationBundle.parcelId,
          detail: err?.message || 'Publish pipeline failure'
        }).catch(() => {});
        throw err;
      }

      await recordOpsEvent(chatDb, {
        category: 'relayer_mint',
        status: 'ok',
        actorId: req.user.id,
        parcelId: locationBundle.parcelId,
        detail: `Minted ${sculptureId} (${mintResult.simulated ? 'sim' : 'live'})`
      }).catch(() => {});
      logStructured('info', 'sculpture_published', {
        sculptureId,
        parcelId: locationBundle.parcelId,
        simulated: Boolean(mintResult.simulated)
      });

      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO sculptures (
          id, title, description, creator_sub, creator_name, creator_email, recipient_address,
          lat, lng, altitude, accuracy, heading, parcel_id, geohash, place_name, country, timezone,
          voxels_json, voxel_count, pol_score, pol_json, proof_hash, preview_data_url,
          ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url,
          chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain,
          royalty_bps, royalty_receiver, hidden, hidden_reason, hidden_by,
          terms_accepted_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?)
      `).run(
        sculptureId,
        validation.title,
        validation.description,
        req.user.id,
        resolveAuthorHandleForStorage(req.user, 'Creator'),
        req.user.email,
        recipientAddress,
        publishedLat,
        publishedLng,
        locationBundle.altitude,
        locationBundle.accuracy,
        locationBundle.heading,
        locationBundle.parcelId,
        locationBundle.geohash,
        locationBundle.geoInfo.placeName,
        locationBundle.geoInfo.country,
        locationBundle.timezone,
        JSON.stringify(publishedVoxels),
        publishedVoxels.length,
        locationBundle.score,
        JSON.stringify(locationBundle.proofBundle),
        locationBundle.proofHash,
        String(req.body?.previewDataUrl || '').slice(0, 450000),
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
      );

      const fittedVol = buildObjectFittedLandVolume({
        parcelId: locationBundle.parcelId,
        geohash: locationBundle.geohash,
        lat: publishedLat,
        lng: publishedLng,
        voxels: publishedVoxels,
        anchorOffset: anchorCheck.offset,
        paddingFraction: 0.1
      });
      const parcelCenterLat = fittedVol?.centerLat ?? locationBundle.parcelBounds.center[0];
      const parcelCenterLng = fittedVol?.centerLng ?? locationBundle.parcelBounds.center[1];

      const existingParcel = db
        .prepare('SELECT * FROM land_parcels WHERE parcel_id = ?')
        .get(locationBundle.parcelId);
      if (existingParcel) {
        db.prepare(`
          UPDATE land_parcels
          SET latest_claimant_address = ?, sculpture_count = sculpture_count + 1, updated_at = ?
          WHERE parcel_id = ?
        `).run(recipientAddress, now, locationBundle.parcelId);
      } else {
        db.prepare(`
          INSERT INTO land_parcels (
            parcel_id, geohash, center_lat, center_lng,
            first_claimant_sub, first_claimant_address, latest_claimant_address,
            sculpture_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          locationBundle.parcelId,
          locationBundle.geohash,
          parcelCenterLat,
          parcelCenterLng,
          req.user.id,
          recipientAddress,
          recipientAddress,
          now
        );
      }

      await recordLandView(chatDb, {
        parcelId: locationBundle.parcelId,
        viewType: 'in_person',
        viewerKey: buildViewerDedupKey({ userId: req.user.id }),
        verifiedInPerson: true
      }).catch(() => null);

      if (fittedVol) {
        db.prepare(`
          INSERT OR IGNORE INTO land_volumes (
            parcel_id, center_lat, center_lng, width_meters, depth_meters, height_meters,
            z_scale, rotation_deg, base_altitude_m, footprint_area_sqm, volume_cubic_m,
            corners_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          fittedVol.parcelId,
          fittedVol.centerLat,
          fittedVol.centerLng,
          fittedVol.widthMeters,
          fittedVol.depthMeters,
          fittedVol.heightMeters,
          fittedVol.zScale,
          fittedVol.rotationDeg,
          fittedVol.baseAltitudeM,
          fittedVol.footprintAreaSqM,
          fittedVol.volumeCubicM,
          JSON.stringify(fittedVol.corners || []),
          now
        );
      }

      await upsertAnchorAndRevision(chatDb, {
        sculptureId,
        parcelId: locationBundle.parcelId,
        revNum: 1,
        anchorOffset: anchorCheck.offset,
        erc4906TxHash: mintResult.txHash || '',
        editorUser: req.user,
        editorRole: 'owner',
        modelType: 'voxel',
        voxels: validation.cleanVoxels,
        title: validation.title,
        description: validation.description,
        ipfsMetadataCid: ipfsResult.metadataCid,
        ipfsModelCid: ipfsResult.modelCid,
        ipfsImageCid: ipfsResult.imageCid,
        changeSummary: 'Initial mobile publish'
      });

      const awakening = await awakenParcelByHumanVisit(chatDb, {
        parcelId: locationBundle.parcelId,
        sculptureId,
        artistUser: req.user,
        artistAddress: recipientAddress,
        voxelCount: validation.cleanVoxels.length,
        isCustomModel: false,
        questId: req.body?.questId || '',
        plinthSlotId: req.body?.plinthSlotId || '',
        platformAddress: getChainStatus().royaltyReceiver
      });

      if (req.body?.draftId) {
        await consumeDraftOnPublish(chatDb, { draftId: req.body.draftId, user: req.user });
      }

      const saved = db.prepare(`${SCULPTURE_SELECT_SQL} WHERE s.id = ?`).get(sculptureId);
      res.status(201).json({
        sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
        mint: mintResult,
        ipfs: ipfsResult,
        awakening
      });
    } catch (err) {
      console.error('Publish failed:', err);
      res.status(err?.statusCode || 400);
      if (err?.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      res.json({ error: err.message || 'Failed to publish sculpture', ...(err?.extra || {}) });
    }
  });

  // Admin Moderation & Operational Metrics Endpoints
  app.get('/api/admin/metrics', requireAdmin, async (_req, res) => {
    try {
      const report = await getOperationalHealthReport(chatDb, {
        chain: getChainStatus(),
        ipfsProvider: CONFIG.pinataJwt ? 'pinata' : CONFIG.ipfsApiUrl ? 'kubo' : 'local-cid'
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not compute metrics' });
    }
  });
  app.get('/api/admin/sculptures', requireAdmin, (_req, res) => {
    const rows = db.prepare('SELECT * FROM sculptures ORDER BY created_at DESC').all();
    res.json({
      sculptures: rows.map((r) =>
        serializeSculptureRow(r, { includeAdminFields: true, includeVoxels: true })
      )
    });
  });

  app.post('/api/admin/sculptures/:id/visibility', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Sculpture not found' });

    const hidden = req.body?.hidden ? 1 : 0;
    const reason = String(req.body?.reason || '').trim().slice(0, 160);
    db.prepare('UPDATE sculptures SET hidden = ?, hidden_reason = ?, hidden_by = ? WHERE id = ?').run(
      hidden,
      hidden ? reason || 'Moderated by admin' : '',
      hidden ? req.user.email : '',
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
    res.json({
      sculpture: serializeSculptureRow(updated, { includeAdminFields: true, includeVoxels: true })
    });
  });

  // Local IPFS CID gateway
  app.get('/ipfs/:cid', (req, res) => {
    const result = readLocalIpfsCid(req.params.cid);
    if (!result) return res.status(404).json({ error: 'CID not found locally' });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(result.buffer);
  });

  // Serve production client build if present when running in production / --prod mode
  const distDir = path.join(ROOT_DIR, 'dist');
  const serveDist =
    process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
  if (serveDist && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // HTTP + WebSocket Pairing Server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const pairRooms = new Map();

  function generatePairCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return pairRooms.has(code) ? generatePairCode() : code;
  }

  function safeSend(ws, payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  const PAIR_CODE_RE = /^[A-Z2-9]{6}$/;
  const DESKTOP_RECONNECT_GRACE_MS = 120_000;
  const IDLE_PAIR_ROOM_TTL_MS = 30 * 60 * 1000;

  function clearRoomCleanupTimer(room) {
    if (room?.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }
  }

  wss.on('connection', (ws) => {
    ws.meta = { role: null, code: null, mcpCode: null };

    ws.on('message', (rawMsg) => {
      let msg;
      try {
        msg = JSON.parse(rawMsg.toString('utf8'));
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        safeSend(ws, { type: 'pong', ts: Date.now() });
        return;
      }

      if (msg.type === 'subscribe_mcp') {
        const mCode = normalizePairingCode(msg.pairingCode || '');
        if (mCode) {
          if (ws.meta.mcpCode && mcpNotifySubscribers.has(ws.meta.mcpCode)) {
            mcpNotifySubscribers.get(ws.meta.mcpCode).delete(ws);
          }
          ws.meta.mcpCode = mCode;
          if (!mcpNotifySubscribers.has(mCode)) mcpNotifySubscribers.set(mCode, new Set());
          mcpNotifySubscribers.get(mCode).add(ws);
          safeSend(ws, { type: 'mcp_subscribed', pairingCode: mCode });
        }
        return;
      }

      if (msg.type === 'end_pair') {
        const targetCode = String(msg.code || ws.meta?.code || '').trim().toUpperCase();
        const existing = targetCode ? pairRooms.get(targetCode) : null;
        if (existing && (!existing.desktopWs || existing.desktopWs === ws)) {
          clearRoomCleanupTimer(existing);
          if (existing.mobileWs && existing.mobileWs.readyState === 1) {
            safeSend(existing.mobileWs, {
              type: 'pair_ended',
              reason: 'Desktop started a new pairing session.'
            });
          }
          pairRooms.delete(targetCode);
          if (ws.meta.code === targetCode) {
            ws.meta = { ...ws.meta, role: null, code: null };
          }
        }
        return;
      }

      if (msg.type === 'create_pair') {
        const preferred = String(msg.preferredCode || '').trim().toUpperCase();
        let code = '';
        let reclaimed = false;
        let room = null;

        if (PAIR_CODE_RE.test(preferred)) {
          const existing = pairRooms.get(preferred);
          if (!existing) {
            code = preferred;
          } else if (!existing.desktopWs || existing.desktopWs.readyState !== 1 || existing.desktopWs === ws) {
            code = preferred;
            room = existing;
            reclaimed = true;
          }
        }

        if (!code) {
          code = generatePairCode();
        }

        if (room) {
          clearRoomCleanupTimer(room);
          room.desktopWs = ws;
          room.desktopDisconnectedAt = 0;
          room.lastActiveAt = Date.now();
        } else {
          room = {
            code,
            desktopWs: ws,
            mobileWs: null,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            desktopDisconnectedAt: 0,
            cleanupTimer: null
          };
          pairRooms.set(code, room);
        }

        ws.meta = { ...ws.meta, role: 'desktop', code };
        safeSend(ws, { type: 'pair_created', code, reclaimed });

        if (room.mobileWs && room.mobileWs.readyState === 1) {
          safeSend(ws, { type: 'pair_connected', code, role: 'desktop', reconnected: true });
          safeSend(room.mobileWs, { type: 'pair_connected', code, role: 'mobile', reconnected: true });
        }
        return;
      }

      if (msg.type === 'join_pair') {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = pairRooms.get(code);
        if (!room) {
          safeSend(ws, { type: 'pair_error', error: 'Invalid or expired pairing code.' });
          return;
        }
        clearRoomCleanupTimer(room);
        room.mobileWs = ws;
        room.lastActiveAt = Date.now();
        ws.meta = { ...ws.meta, role: 'mobile', code };
        const desktopOpen = Boolean(room.desktopWs && room.desktopWs.readyState === 1);
        safeSend(ws, { type: 'pair_connected', code, role: 'mobile', desktopPending: !desktopOpen });
        if (desktopOpen) {
          safeSend(room.desktopWs, { type: 'pair_connected', code, role: 'desktop' });
        }
        return;
      }

      const code = ws.meta?.code;
      const room = code ? pairRooms.get(code) : null;
      if (!room) return;
      room.lastActiveAt = Date.now();

      if (ws.meta.role === 'mobile') {
        // Relay live gyro, brush cursor, voxel ops, and mode state to paired desktop
        safeSend(room.desktopWs, msg);
      } else if (ws.meta.role === 'desktop') {
        // Relay desktop remote brush/view commands back to mobile
        safeSend(room.mobileWs, msg);
      }
    });

    ws.on('close', () => {
      if (ws.meta.mcpCode && mcpNotifySubscribers.has(ws.meta.mcpCode)) {
        mcpNotifySubscribers.get(ws.meta.mcpCode).delete(ws);
      }
      const code = ws.meta?.code;
      if (!code || !pairRooms.has(code)) return;
      const room = pairRooms.get(code);
      if (ws.meta.role === 'desktop' && room.desktopWs === ws) {
        room.desktopWs = null;
        room.desktopDisconnectedAt = Date.now();
        clearRoomCleanupTimer(room);
        const hasMobile = Boolean(room.mobileWs && room.mobileWs.readyState === 1);
        if (hasMobile) {
          safeSend(room.mobileWs, { type: 'desktop_reconnecting', code });
        }
        const ttlMs = hasMobile ? DESKTOP_RECONNECT_GRACE_MS : IDLE_PAIR_ROOM_TTL_MS;
        const timer = setTimeout(() => {
          const cur = pairRooms.get(code);
          if (!cur || (cur.desktopWs && cur.desktopWs.readyState === 1)) return;
          if (cur.mobileWs && cur.mobileWs.readyState === 1) {
            safeSend(cur.mobileWs, { type: 'pair_ended', reason: 'Desktop pairing timed out.' });
          }
          pairRooms.delete(code);
        }, ttlMs);
        timer.unref?.();
        room.cleanupTimer = timer;
      } else if (ws.meta.role === 'mobile' && room.mobileWs === ws) {
        room.mobileWs = null;
        safeSend(room.desktopWs, { type: 'mobile_disconnected', code });
      }
    });
  });

  return { app, server, wss, pairRooms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createAppServer();
  server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`SPRAY.LAND API & WS server listening on http://0.0.0.0:${CONFIG.port}`);
  });
}
