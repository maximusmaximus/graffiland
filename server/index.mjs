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
import { getChainStatus, mintOnRobinhoodChain } from './services/blockchain.mjs';
import { pinSculptureToIpfs, readLocalIpfsCid } from './services/ipfs.mjs';
import { validatePublishPayload } from './services/moderation.mjs';
import {
  decodeGeohashBounds,
  haversineMeters,
  verifyAndEnrichLocation
} from './services/pol.mjs';
import { buildSculptureGlb } from '../shared/glb.mjs';
import {
  buildContractMetadata,
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
import { decryptPrivateKey, resolveRecipientAddress } from './services/wallet.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createAppServer() {
  const db = getDb();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '12mb' }));

  // Ensure server responds cleanly to health checks
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'graffiland-api', timestamp: new Date().toISOString() });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      googleClientId: CONFIG.googleClientId || null,
      allowDevGoogleAuth: CONFIG.allowDevGoogleAuth,
      policy: POLICY,
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

  app.post('/api/wallet/payout', requireAuth, (req, res) => {
    const raw = String(req.body?.address || '').trim();
    if (raw && !ethers.isAddress(raw)) {
      return res.status(400).json({ error: 'Invalid EVM wallet address.' });
    }
    const normalized = raw ? ethers.getAddress(raw) : '';
    db.prepare('UPDATE users SET custom_payout_address = ? WHERE id = ?').run(
      normalized,
      req.user.id
    );
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: sanitizeUser(updated) });
  });

  app.get('/api/wallet/export', requireAuth, (req, res) => {
    try {
      const privateKey = decryptPrivateKey(req.user.encrypted_wallet_json);
      res.json({
        walletAddress: req.user.wallet_address,
        privateKey
      });
    } catch {
      res.status(500).json({ error: 'Failed to export embedded wallet' });
    }
  });

  // Public Sculptures (Map, Gallery, Mobile AR Preview Mode)
  app.get('/api/sculptures', (req, res) => {
    const rows = db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
          (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue
         FROM sculptures s
         WHERE s.hidden = 0
         ORDER BY s.created_at DESC`
      )
      .all();

    const latParam = req.query.lat !== undefined ? Number(req.query.lat) : null;
    const lngParam = req.query.lng !== undefined ? Number(req.query.lng) : null;
    const radiusMeters =
      req.query.radiusMeters !== undefined ? Math.max(10, Number(req.query.radiusMeters)) : null;
    const parcelFilter = req.query.parcel ? String(req.query.parcel).toUpperCase() : null;

    let items = rows.map((r) => serializeSculptureRow(r, { includeVoxels: true }));

    if (parcelFilter) {
      items = items.filter((item) => item.parcelId === parcelFilter);
    }

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
    const row = db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
          (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue
         FROM sculptures s
         WHERE s.id = ?`
      )
      .get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Sculpture not found' });
    const caller = getAuthUserFromRequest(req);
    if (row.hidden && !caller?.is_admin) {
      return res.status(404).json({ error: 'Sculpture not available' });
    }
    const transfers = await listSculptureTransfers(chatDb, req.params.id);
    res.json({
      sculpture: serializeSculptureRow(row, {
        includeAdminFields: Boolean(caller?.is_admin),
        includeVoxels: true,
        transfers
      })
    });
  });

  app.get('/api/sculptures/:id/model.glb', (req, res) => {
    const row = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Sculpture not found' });
    const caller = getAuthUserFromRequest(req);
    if (row.hidden && !caller?.is_admin) {
      return res.status(404).json({ error: 'Sculpture not available' });
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
  });

  app.get('/api/sculptures/:id/metadata.json', (req, res) => {
    const row = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(req.params.id);
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
        res.status(err?.statusCode || 400).json({ error: err.message || 'Chat request failed' });
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

  app.get('/api/parcels', (_req, res) => {
    const rows = db
      .prepare(`
        SELECT
          parcel_id,
          geohash,
          AVG(lat) AS center_lat,
          AVG(lng) AS center_lng,
          COUNT(*) AS visible_count,
          MAX(created_at) AS latest_at,
          MIN(created_at) AS first_at
        FROM sculptures
        WHERE hidden = 0
        GROUP BY parcel_id, geohash
        ORDER BY visible_count DESC, latest_at DESC
      `)
      .all();

    const parcels = rows.map((row) => {
      const bounds = decodeGeohashBounds(row.geohash);
      const firstRow = db
        .prepare(
          'SELECT recipient_address, creator_name FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 1'
        )
        .get(row.parcel_id);

      return {
        parcelId: row.parcel_id,
        geohash: row.geohash,
        bounds,
        centerLat: bounds.center[0],
        centerLng: bounds.center[1],
        sculptureCount: row.visible_count,
        firstClaimantAddress: firstRow?.recipient_address || '',
        firstClaimantName: firstRow?.creator_name || '',
        latestAt: row.latest_at
      };
    });

    res.json({ parcels });
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
          error: `Proof of Location check failed (score ${locationBundle.score}/100). Enable GPS, live camera, and move your phone gently while sculpting.`,
          proofOfLocation: locationBundle
        });
      }

      const sculptureId = crypto.randomUUID();
      const recipientAddress = resolveRecipientAddress(req.user);

      const ipfsResult = await pinSculptureToIpfs({
        sculptureId,
        title: validation.title,
        description: validation.description,
        voxels: validation.cleanVoxels,
        previewDataUrl: req.body?.previewDataUrl || '',
        locationBundle,
        creatorAddress: recipientAddress,
        royaltyBps: CONFIG.resaleFeeBps,
        royaltyReceiver: getChainStatus().royaltyReceiver
      });

      const mintResult = await mintOnRobinhoodChain({
        recipientAddress,
        metadataUri: ipfsResult.metadataUri,
        parcelBytes32: locationBundle.parcelBytes32,
        proofHash: locationBundle.proofHash,
        lat: locationBundle.lat,
        lng: locationBundle.lng
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
        req.user.name,
        req.user.email,
        recipientAddress,
        locationBundle.lat,
        locationBundle.lng,
        locationBundle.altitude,
        locationBundle.accuracy,
        locationBundle.heading,
        locationBundle.parcelId,
        locationBundle.geohash,
        locationBundle.geoInfo.placeName,
        locationBundle.geoInfo.country,
        locationBundle.timezone,
        JSON.stringify(validation.cleanVoxels),
        validation.cleanVoxels.length,
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
          locationBundle.parcelBounds.center[0],
          locationBundle.parcelBounds.center[1],
          req.user.id,
          recipientAddress,
          recipientAddress,
          now
        );
      }

      const saved = db.prepare('SELECT * FROM sculptures WHERE id = ?').get(sculptureId);
      res.status(201).json({
        sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
        mint: mintResult,
        ipfs: ipfsResult
      });
    } catch (err) {
      console.error('Publish failed:', err);
      res.status(400).json({ error: err.message || 'Failed to publish sculpture' });
    }
  });

  // Admin Moderation Endpoints
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

  wss.on('connection', (ws) => {
    ws.meta = { role: null, code: null };

    ws.on('message', (rawMsg) => {
      let msg;
      try {
        msg = JSON.parse(rawMsg.toString('utf8'));
      } catch {
        return;
      }

      if (msg.type === 'create_pair') {
        const code = generatePairCode();
        pairRooms.set(code, {
          code,
          desktopWs: ws,
          mobileWs: null,
          createdAt: Date.now()
        });
        ws.meta = { role: 'desktop', code };
        safeSend(ws, { type: 'pair_created', code });
        return;
      }

      if (msg.type === 'join_pair') {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = pairRooms.get(code);
        if (!room) {
          safeSend(ws, { type: 'pair_error', error: 'Invalid or expired pairing code.' });
          return;
        }
        room.mobileWs = ws;
        ws.meta = { role: 'mobile', code };
        safeSend(ws, { type: 'pair_connected', code, role: 'mobile' });
        safeSend(room.desktopWs, { type: 'pair_connected', code, role: 'desktop' });
        return;
      }

      const code = ws.meta?.code;
      const room = code ? pairRooms.get(code) : null;
      if (!room) return;

      if (ws.meta.role === 'mobile') {
        // Relay live gyro, brush cursor, voxel ops, and mode state to paired desktop
        safeSend(room.desktopWs, msg);
      } else if (ws.meta.role === 'desktop') {
        // Relay desktop remote brush/view commands back to mobile
        safeSend(room.mobileWs, msg);
      }
    });

    ws.on('close', () => {
      const code = ws.meta?.code;
      if (!code || !pairRooms.has(code)) return;
      const room = pairRooms.get(code);
      if (ws.meta.role === 'desktop') {
        safeSend(room.mobileWs, { type: 'pair_ended', reason: 'Desktop closed pairing session.' });
        pairRooms.delete(code);
      } else if (ws.meta.role === 'mobile') {
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
    console.log(`GRAFFILAND API & WS server listening on http://0.0.0.0:${CONFIG.port}`);
  });
}
