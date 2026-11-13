import { ethers } from 'ethers';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { POLICY, ROBINHOOD_NETWORKS } from '../../shared/constants.mjs';
import {
  buildIpfsMetadata,
  computeVerticalBounds,
  serializeSculptureRow
} from '../../shared/sculpture.mjs';
import {
  claimClueUnlockedGrant,
  enterChatBoard,
  initChatBoard,
  listPendingGrantsForGrantor,
  postEncryptedChatMessage,
  requestChatGrant,
  submitPeerGrant,
  updateBoardClue
} from '../../shared/chatService.mjs';
import { validatePublishPayload } from '../../server/services/moderation.mjs';
import {
  decodeGeohashBounds,
  haversineMeters,
  verifyAndEnrichLocation
} from '../../server/services/pol.mjs';
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
  signJwt,
  verifyJwt
} from './crypto.js';

const NFT_ABI = [
  'function mintSculpture(address recipient, string calldata metadataURI, bytes32 landParcelId, bytes32 proofOfLocationHash, int32 latE6, int32 lngE6) external returns (uint256)',
  'event SculptureMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request)
    }
  });
}

function getRuntimeConfig(env) {
  const netKey = String(env.ROBINHOOD_NETWORK || 'testnet').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
  const baseNet = ROBINHOOD_NETWORKS[netKey];
  const network = {
    ...baseNet,
    rpcUrl:
      netKey === 'mainnet'
        ? env.ROBINHOOD_MAINNET_RPC || baseNet.rpcUrl
        : env.ROBINHOOD_TESTNET_RPC || baseNet.rpcUrl
  };
  const resaleFeeBps = Number(env.ROBINHOOD_RESALE_FEE_BPS || 500);
  const adminEmails = String(env.ADMIN_EMAILS || 'maxinfeld@gmail.com,admin@graffiland.local')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let relayerAddress = '';
  if (env.ROBINHOOD_RELAYER_PRIVATE_KEY) {
    try {
      relayerAddress = new ethers.Wallet(env.ROBINHOOD_RELAYER_PRIVATE_KEY).address;
    } catch {
      relayerAddress = '';
    }
  }

  return {
    network,
    resaleFeeBps,
    resaleFeePercent: resaleFeeBps / 100,
    contractAddress: env.ROBINHOOD_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000466300',
    liveChainReady: Boolean(env.ROBINHOOD_CONTRACT_ADDRESS && env.ROBINHOOD_RELAYER_PRIVATE_KEY),
    relayerAddress,
    royaltyReceiver:
      env.ROBINHOOD_ROYALTY_RECEIVER ||
      relayerAddress ||
      '0x000000000000000000000000000000000000dEaD',
    adminEmails,
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    allowDevGoogleAuth: env.ALLOW_DEV_GOOGLE_AUTH !== 'false',
    publicUrl: env.PUBLIC_URL || 'https://maximusmaximus.github.io/graffiland',
    ipfsGateway: env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs',
    sessionSecret: env.SESSION_SECRET || 'graffiland-worker-dev-session-secret',
    walletEncryptionKey: env.WALLET_ENCRYPTION_KEY || 'graffiland-worker-dev-wallet-key'
  };
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    walletAddress: row.wallet_address,
    customPayoutAddress: row.custom_payout_address || '',
    activeMintRecipient: row.custom_payout_address || row.wallet_address,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at
  };
}

async function getAuthUser(request, env, cfg) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  try {
    const decoded = await verifyJwt(token, cfg.sessionSecret);
    return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(decoded.sub).first();
  } catch {
    return null;
  }
}

async function verifyGooglePayload(body, cfg) {
  if (cfg.googleClientId && body?.credential) {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential)}`
    );
    if (!res.ok) throw new Error('Invalid Google ID token');
    const info = await res.json();
    if (info.aud !== cfg.googleClientId) throw new Error('Google token audience mismatch');
    if (info.email_verified !== 'true' && info.email_verified !== true) {
      throw new Error('Google email not verified');
    }
    return {
      sub: `google:${info.sub}`,
      email: String(info.email).toLowerCase(),
      name: info.name || String(info.email).split('@')[0],
      picture: info.picture || ''
    };
  }

  if (cfg.allowDevGoogleAuth && body?.devProfile) {
    const email = String(body.devProfile.email || '').trim().toLowerCase();
    const name = String(body.devProfile.name || '').trim() || email.split('@')[0] || 'Artist';
    if (!email || !email.includes('@')) throw new Error('Valid email is required');
    return {
      sub: `dev-google:${email}`,
      email,
      name,
      picture: body.devProfile.picture || ''
    };
  }

  throw new Error('Google authentication required');
}

function decodePreviewDataUrl(previewDataUrl) {
  if (typeof previewDataUrl === 'string' && previewDataUrl.startsWith('data:image/')) {
    const idx = previewDataUrl.indexOf(',');
    if (idx !== -1) {
      const header = previewDataUrl.slice(0, idx);
      const b64 = previewDataUrl.slice(idx + 1);
      const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime };
    }
  }
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0d0f1a"/><text x="256" y="256" fill="#00f5d4" font-family="monospace" font-size="28" text-anchor="middle">GRAFFILAND 3D</text></svg>';
  return { bytes: new TextEncoder().encode(svg), mime: 'image/svg+xml' };
}

async function computeCid(bytes) {
  const hash = await sha256.digest(bytes);
  return CID.create(1, raw.code, hash).toString();
}

async function pinToKv(bytes, contentType, origin, env) {
  const cid = await computeCid(bytes);
  let b64 = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  await env.IPFS_KV.put(`cid:${cid}`, btoa(b64), {
    metadata: { contentType }
  });
  return {
    cid,
    uri: `ipfs://${cid}`,
    gatewayUrl: `${origin}/ipfs/${cid}`,
    provider: 'cloudflare-cid'
  };
}

async function pinToPinataFile(bytes, fileName, mimeType, env, cfg) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), fileName);
  form.append('pinataMetadata', JSON.stringify({ name: fileName }));
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
    body: form
  });
  if (!res.ok) throw new Error(`Pinata error: ${res.status}`);
  const data = await res.json();
  return {
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    gatewayUrl: `${cfg.ipfsGateway}/${data.IpfsHash}`,
    provider: 'pinata'
  };
}

async function pinToPinataJson(obj, name, env, cfg) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.PINATA_JWT}`
    },
    body: JSON.stringify({ pinataMetadata: { name }, pinataContent: obj })
  });
  if (!res.ok) throw new Error(`Pinata JSON error: ${res.status}`);
  const data = await res.json();
  return {
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    gatewayUrl: `${cfg.ipfsGateway}/${data.IpfsHash}`,
    provider: 'pinata'
  };
}

async function pinSculptureBundle(params, requestOrigin, env, cfg) {
  const preview = decodePreviewDataUrl(params.previewDataUrl);
  const modelJson = {
    schema: 'graffiland.voxel.v1',
    id: params.sculptureId,
    title: params.title,
    voxelCount: params.voxels.length,
    voxels: params.voxels,
    virtualLandParcel: params.locationBundle.parcelId,
    geohash: params.locationBundle.geohash,
    createdAt: new Date().toISOString()
  };
  const modelBytes = new TextEncoder().encode(JSON.stringify(modelJson, null, 2));

  let imagePin;
  let modelPin;
  if (env.PINATA_JWT) {
    imagePin = await pinToPinataFile(
      preview.bytes,
      `${params.sculptureId}-preview.png`,
      preview.mime,
      env,
      cfg
    );
    modelPin = await pinToPinataFile(
      modelBytes,
      `${params.sculptureId}-model.json`,
      'application/json',
      env,
      cfg
    );
  } else {
    imagePin = await pinToKv(preview.bytes, preview.mime, requestOrigin, env);
    modelPin = await pinToKv(modelBytes, 'application/json', requestOrigin, env);
  }

  const metadata = buildIpfsMetadata({
    sculptureId: params.sculptureId,
    title: params.title,
    description: params.description,
    imageUri: imagePin.uri,
    modelUri: modelPin.uri,
    publicUrl: cfg.publicUrl,
    voxels: params.voxels,
    locationBundle: params.locationBundle,
    creatorAddress: params.creatorAddress,
    royaltyBps: cfg.resaleFeeBps,
    royaltyReceiver: cfg.royaltyReceiver
  });

  let metadataPin;
  if (env.PINATA_JWT) {
    metadataPin = await pinToPinataJson(metadata, `${params.sculptureId}-metadata.json`, env, cfg);
  } else {
    metadataPin = await pinToKv(
      new TextEncoder().encode(JSON.stringify(metadata, null, 2)),
      'application/json',
      requestOrigin,
      env
    );
  }

  return {
    provider: metadataPin.provider,
    metadataCid: metadataPin.cid,
    metadataUri: metadataPin.uri,
    gatewayUrl: metadataPin.gatewayUrl,
    modelCid: modelPin.cid,
    modelUri: modelPin.uri,
    imageCid: imagePin.cid,
    imageUri: imagePin.uri,
    metadata
  };
}

async function mintOnChainOrSimulate({
  recipientAddress,
  metadataUri,
  parcelBytes32,
  proofHash,
  lat,
  lng
}, env, cfg) {
  const latE6 = Math.round(lat * 1e6);
  const lngE6 = Math.round(lng * 1e6);

  if (cfg.liveChainReady) {
    const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, cfg.network.chainId);
    const relayer = new ethers.Wallet(env.ROBINHOOD_RELAYER_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(cfg.contractAddress, NFT_ABI, relayer);
    const tx = await contract.mintSculpture(
      recipientAddress,
      metadataUri,
      parcelBytes32,
      proofHash,
      latE6,
      lngE6
    );
    const receipt = await tx.wait();
    let tokenId = '0';
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed?.name === 'SculptureMinted') {
          tokenId = parsed.args.tokenId.toString();
          break;
        }
      } catch {
        // ignore
      }
    }
    return {
      simulated: false,
      chainId: cfg.network.chainId,
      chainName: cfg.network.name,
      contractAddress: cfg.contractAddress,
      tokenId,
      txHash: receipt.hash,
      explorerTxUrl: `${cfg.network.explorerUrl}/tx/${receipt.hash}`,
      royaltyBps: cfg.resaleFeeBps,
      royaltyReceiver: cfg.royaltyReceiver,
      gasSponsoredBy: relayer.address
    };
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM sculptures').first();
  const nextTokenId = String(Number(countRow?.c || 0) + 1);
  const txHash = ethers.keccak256(
    ethers.toUtf8Bytes(`${recipientAddress}|${metadataUri}|${proofHash}|${Date.now()}`)
  );

  return {
    simulated: true,
    chainId: cfg.network.chainId,
    chainName: `${cfg.network.name} (Simulated Relayer)`,
    contractAddress: cfg.contractAddress,
    tokenId: nextTokenId,
    txHash,
    explorerTxUrl: `${cfg.network.explorerUrl}/tx/${txHash}`,
    royaltyBps: cfg.resaleFeeBps,
    royaltyReceiver: cfg.royaltyReceiver,
    gasSponsoredBy: 'Platform Relayer (Simulated)'
  };
}

export class PairCoordinator {
  constructor(state) {
    this.state = state;
    this.rooms = new Map();
  }

  generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return this.rooms.has(code) ? this.generateCode() : code;
  }

  sendJson(ws, data) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
      }
    } catch {
      // ignore closed socket
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let meta = { role: null, code: null };

    server.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'create_pair') {
        const code = this.generateCode();
        this.rooms.set(code, { code, desktopWs: server, mobileWs: null });
        meta = { role: 'desktop', code };
        this.sendJson(server, { type: 'pair_created', code });
        return;
      }

      if (msg.type === 'join_pair') {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = this.rooms.get(code);
        if (!room) {
          this.sendJson(server, { type: 'pair_error', error: 'Invalid or expired pairing code.' });
          return;
        }
        room.mobileWs = server;
        meta = { role: 'mobile', code };
        this.sendJson(server, { type: 'pair_connected', code, role: 'mobile' });
        this.sendJson(room.desktopWs, { type: 'pair_connected', code, role: 'desktop' });
        return;
      }

      const room = meta.code ? this.rooms.get(meta.code) : null;
      if (!room) return;
      if (meta.role === 'mobile') {
        this.sendJson(room.desktopWs, msg);
      } else if (meta.role === 'desktop') {
        this.sendJson(room.mobileWs, msg);
      }
    });

    server.addEventListener('close', () => {
      if (!meta.code || !this.rooms.has(meta.code)) return;
      const room = this.rooms.get(meta.code);
      if (meta.role === 'desktop') {
        this.sendJson(room.mobileWs, { type: 'pair_ended', reason: 'Desktop closed pairing.' });
        this.rooms.delete(meta.code);
      } else if (meta.role === 'mobile') {
        room.mobileWs = null;
        this.sendJson(room.desktopWs, { type: 'mobile_disconnected', code: meta.code });
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const cfg = getRuntimeConfig(env);

    // WebSocket Pairing Gateway
    if (pathname === '/ws') {
      const id = env.PAIR_COORDINATOR.idFromName('global-hub');
      const stub = env.PAIR_COORDINATOR.get(id);
      return stub.fetch(request);
    }

    if (pathname === '/api/health') {
      return jsonResponse(
        { ok: true, service: 'graffiland-worker', timestamp: new Date().toISOString() },
        200,
        request
      );
    }

    if (pathname === '/api/config') {
      return jsonResponse(
        {
          googleClientId: cfg.googleClientId || null,
          allowDevGoogleAuth: cfg.allowDevGoogleAuth,
          policy: POLICY,
          chain: {
            network: cfg.network,
            contractAddress: cfg.contractAddress,
            liveReady: cfg.liveChainReady,
            relayerAddress: cfg.relayerAddress,
            royaltyReceiver: cfg.royaltyReceiver,
            resaleFeeBps: cfg.resaleFeeBps,
            resaleFeePercent: cfg.resaleFeePercent
          },
          ipfsProvider: env.PINATA_JWT ? 'pinata' : 'cloudflare-cid'
        },
        200,
        request
      );
    }

    // Google Login
    if (pathname === '/api/auth/google' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const profile = await verifyGooglePayload(body, cfg);
        const now = new Date().toISOString();
        const isAdmin = cfg.adminEmails.includes(profile.email.toLowerCase()) ? 1 : 0;

        let userRow = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(profile.sub).first();
        if (userRow) {
          await env.DB.prepare(
            'UPDATE users SET email = ?, name = ?, picture = ?, is_admin = ?, last_login_at = ? WHERE id = ?'
          )
            .bind(profile.email, profile.name, profile.picture, isAdmin, now, profile.sub)
            .run();
        } else {
          const wallet = ethers.Wallet.createRandom();
          const encryptedJson = await encryptWalletPrivateKey(wallet.privateKey, cfg.walletEncryptionKey);
          await env.DB.prepare(
            `INSERT INTO users (
              id, email, name, picture, wallet_address, encrypted_wallet_json,
              custom_payout_address, is_admin, created_at, last_login_at
            ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`
          )
            .bind(
              profile.sub,
              profile.email,
              profile.name,
              profile.picture,
              wallet.address,
              encryptedJson,
              isAdmin,
              now,
              now
            )
            .run();
        }
        userRow = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(profile.sub).first();
        const token = await signJwt(
          { sub: userRow.id, email: userRow.email, isAdmin: Boolean(userRow.is_admin) },
          cfg.sessionSecret
        );
        return jsonResponse({ token, user: sanitizeUser(userRow) }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Google login failed' }, 401, request);
      }
    }

    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      return jsonResponse({ user: sanitizeUser(user) }, 200, request);
    }

    if (pathname === '/api/wallet/payout' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      const body = await request.json().catch(() => ({}));
      const raw = String(body?.address || '').trim();
      if (raw && !ethers.isAddress(raw)) {
        return jsonResponse({ error: 'Invalid EVM wallet address.' }, 400, request);
      }
      const normalized = raw ? ethers.getAddress(raw) : '';
      await env.DB.prepare('UPDATE users SET custom_payout_address = ? WHERE id = ?')
        .bind(normalized, user.id)
        .run();
      const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      return jsonResponse({ user: sanitizeUser(updated) }, 200, request);
    }

    if (pathname === '/api/wallet/export' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const privateKey = await decryptWalletPrivateKey(
          user.encrypted_wallet_json,
          cfg.walletEncryptionKey
        );
        return jsonResponse({ walletAddress: user.wallet_address, privateKey }, 200, request);
      } catch {
        return jsonResponse({ error: 'Failed to decrypt embedded wallet' }, 500, request);
      }
    }

    // List public sculptures
    if (pathname === '/api/sculptures' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
          (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue
         FROM sculptures s
         WHERE s.hidden = 0
         ORDER BY s.created_at DESC`
      ).all();
      let items = (results || []).map((r) => serializeSculptureRow(r, { includeVoxels: true }));

      const parcelFilter = url.searchParams.get('parcel')?.toUpperCase();
      if (parcelFilter) {
        items = items.filter((item) => item.parcelId === parcelFilter);
      }

      const latParam = url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : null;
      const lngParam = url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : null;
      const radiusMeters = url.searchParams.has('radiusMeters')
        ? Math.max(10, Number(url.searchParams.get('radiusMeters')))
        : null;

      if (Number.isFinite(latParam) && Number.isFinite(lngParam)) {
        items = items
          .map((item) => ({
            ...item,
            distanceMeters: Math.round(haversineMeters(latParam, lngParam, item.lat, item.lng) * 10) / 10
          }))
          .filter((item) => (Number.isFinite(radiusMeters) ? item.distanceMeters <= radiusMeters : true))
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
      }

      return jsonResponse({ sculptures: items }, 200, request);
    }

    // List Virtual Land parcels
    if (pathname === '/api/parcels' && request.method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT
          parcel_id,
          geohash,
          COUNT(*) AS visible_count,
          MAX(created_at) AS latest_at
        FROM sculptures
        WHERE hidden = 0
        GROUP BY parcel_id, geohash
        ORDER BY visible_count DESC, latest_at DESC
      `).all();

      const parcels = [];
      for (const row of results || []) {
        const bounds = decodeGeohashBounds(row.geohash);
        const first = await env.DB.prepare(
          'SELECT recipient_address, creator_name FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 1'
        )
          .bind(row.parcel_id)
          .first();
        parcels.push({
          parcelId: row.parcel_id,
          geohash: row.geohash,
          bounds,
          centerLat: bounds.center[0],
          centerLng: bounds.center[1],
          sculptureCount: row.visible_count,
          firstClaimantAddress: first?.recipient_address || '',
          firstClaimantName: first?.creator_name || '',
          latestAt: row.latest_at
        });
      }
      return jsonResponse({ parcels }, 200, request);
    }

    // Publish Sculpture
    if (pathname === '/api/sculptures/publish' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);

      try {
        const body = await request.json().catch(() => ({}));
        const ua = request.headers.get('User-Agent') || '';
        const looksMobile =
          Boolean(body?.deviceProfile?.isMobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
        if (!looksMobile) {
          return jsonResponse(
            { error: 'Publishing sculptures requires a mobile device with camera, gyroscope, and GPS.' },
            403,
            request
          );
        }

        const validation = validatePublishPayload(body);
        if (!validation.ok) {
          return jsonResponse(
            { error: validation.errors.join(' '), errors: validation.errors },
            400,
            request
          );
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
          return jsonResponse(
            {
              error: `Proof of Location check failed (score ${locationBundle.score}/100). Enable GPS, live camera, and move your phone gently while sculpting.`,
              proofOfLocation: locationBundle
            },
            422,
            request
          );
        }

        const sculptureId = crypto.randomUUID();
        const recipientAddress =
          user.custom_payout_address && ethers.isAddress(user.custom_payout_address)
            ? ethers.getAddress(user.custom_payout_address)
            : ethers.getAddress(user.wallet_address);

        const ipfsResult = await pinSculptureBundle(
          {
            sculptureId,
            title: validation.title,
            description: validation.description,
            voxels: validation.cleanVoxels,
            previewDataUrl: body?.previewDataUrl || '',
            locationBundle,
            creatorAddress: recipientAddress
          },
          url.origin,
          env,
          cfg
        );

        const mintResult = await mintOnChainOrSimulate(
          {
            recipientAddress,
            metadataUri: ipfsResult.metadataUri,
            parcelBytes32: locationBundle.parcelBytes32,
            proofHash: locationBundle.proofHash,
            lat: locationBundle.lat,
            lng: locationBundle.lng
          },
          env,
          cfg
        );

        const now = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO sculptures (
            id, title, description, creator_sub, creator_name, creator_email, recipient_address,
            lat, lng, altitude, accuracy, heading, parcel_id, geohash, place_name, country, timezone,
            voxels_json, voxel_count, pol_score, pol_json, proof_hash, preview_data_url,
            ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url,
            chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain,
            royalty_bps, royalty_receiver, hidden, hidden_reason, hidden_by,
            terms_accepted_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?)
        `)
          .bind(
            sculptureId,
            validation.title,
            validation.description,
            user.id,
            user.name,
            user.email,
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
            String(body?.previewDataUrl || '').slice(0, 450000),
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
          )
          .run();

        const existingParcel = await env.DB.prepare(
          'SELECT * FROM land_parcels WHERE parcel_id = ?'
        )
          .bind(locationBundle.parcelId)
          .first();

        if (existingParcel) {
          await env.DB.prepare(
            'UPDATE land_parcels SET latest_claimant_address = ?, sculpture_count = sculpture_count + 1, updated_at = ? WHERE parcel_id = ?'
          )
            .bind(recipientAddress, now, locationBundle.parcelId)
            .run();
        } else {
          await env.DB.prepare(
            `INSERT INTO land_parcels (
              parcel_id, geohash, center_lat, center_lng,
              first_claimant_sub, first_claimant_address, latest_claimant_address,
              sculpture_count, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
          )
            .bind(
              locationBundle.parcelId,
              locationBundle.geohash,
              locationBundle.parcelBounds.center[0],
              locationBundle.parcelBounds.center[1],
              user.id,
              recipientAddress,
              recipientAddress,
              now
            )
            .run();
        }

        const saved = await env.DB.prepare('SELECT * FROM sculptures WHERE id = ?')
          .bind(sculptureId)
          .first();
        return jsonResponse(
          {
            sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
            mint: mintResult,
            ipfs: ipfsResult
          },
          201,
          request
        );
      } catch (err) {
        return jsonResponse({ error: err.message || 'Publish failed' }, 400, request);
      }
    }

    // Admin list
    if (pathname === '/api/admin/sculptures' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      if (!user.is_admin) return jsonResponse({ error: 'Admin access required' }, 403, request);
      const { results } = await env.DB.prepare('SELECT * FROM sculptures ORDER BY created_at DESC').all();
      return jsonResponse(
        {
          sculptures: (results || []).map((r) =>
            serializeSculptureRow(r, { includeAdminFields: true, includeVoxels: true })
          )
        },
        200,
        request
      );
    }

    // Admin hide/unhide
    const visMatch = pathname.match(/^\/api\/admin\/sculptures\/([^/]+)\/visibility$/);
    if (visMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      if (!user.is_admin) return jsonResponse({ error: 'Admin access required' }, 403, request);
      const id = decodeURIComponent(visMatch[1]);
      const existing = await env.DB.prepare('SELECT * FROM sculptures WHERE id = ?').bind(id).first();
      if (!existing) return jsonResponse({ error: 'Sculpture not found' }, 404, request);
      const body = await request.json().catch(() => ({}));
      const hidden = body?.hidden ? 1 : 0;
      const reason = String(body?.reason || '').trim().slice(0, 160);
      await env.DB.prepare(
        'UPDATE sculptures SET hidden = ?, hidden_reason = ?, hidden_by = ? WHERE id = ?'
      )
        .bind(hidden, hidden ? reason || 'Moderated by admin' : '', hidden ? user.email : '', id)
        .run();
      const updated = await env.DB.prepare('SELECT * FROM sculptures WHERE id = ?').bind(id).first();
      return jsonResponse(
        {
          sculpture: serializeSculptureRow(updated, { includeAdminFields: true, includeVoxels: true })
        },
        200,
        request
      );
    }

    // Server-Blind Location-Locked E2EE Sculpture Chat Routes
    const chatDb = {
      get: (sql, params = []) => env.DB.prepare(sql).bind(...params).first(),
      all: async (sql, params = []) => {
        const res = await env.DB.prepare(sql).bind(...params).all();
        return res.results || [];
      },
      run: (sql, params = []) => env.DB.prepare(sql).bind(...params).run()
    };

    if (pathname === '/api/chat/pending-grants' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const out = await listPendingGrantsForGrantor(chatDb, { user });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Chat request failed' }, err?.statusCode || 400, request);
      }
    }

    const chatMatch = pathname.match(
      /^\/api\/sculptures\/([^/]+)\/chat\/(init|clue|enter|request-grant|claim-grant|pending-grants|grants|messages)$/
    );
    if (chatMatch) {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      const sculptureId = decodeURIComponent(chatMatch[1]);
      const action = chatMatch[2];
      const userAgent = request.headers.get('User-Agent') || '';

      try {
        if (action === 'pending-grants' && request.method === 'GET') {
          const out = await listPendingGrantsForGrantor(chatDb, { user, sculptureId });
          return jsonResponse(out, 200, request);
        }
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Method not allowed' }, 405, request);
        }
        const body = await request.json().catch(() => ({}));
        let out;
        if (action === 'init') {
          out = await initChatBoard(chatDb, { sculptureId, user, body, userAgent });
        } else if (action === 'clue') {
          out = await updateBoardClue(chatDb, { sculptureId, user, body, userAgent });
        } else if (action === 'enter') {
          out = await enterChatBoard(chatDb, { sculptureId, user, body, userAgent });
        } else if (action === 'request-grant') {
          out = await requestChatGrant(chatDb, { sculptureId, user, body, userAgent });
        } else if (action === 'claim-grant') {
          out = await claimClueUnlockedGrant(chatDb, { sculptureId, user, body, userAgent });
        } else if (action === 'grants') {
          out = await submitPeerGrant(chatDb, { sculptureId, user, body });
        } else if (action === 'messages') {
          out = await postEncryptedChatMessage(chatDb, { sculptureId, user, body, userAgent });
        }
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Chat request failed' }, err?.statusCode || 400, request);
      }
    }

    // Single sculpture GET
    const scMatch = pathname.match(/^\/api\/sculptures\/([^/]+)$/);
    if (scMatch && request.method === 'GET') {
      const id = decodeURIComponent(scMatch[1]);
      const row = await env.DB.prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
          (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
          (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue
         FROM sculptures s
         WHERE s.id = ?`
      )
        .bind(id)
        .first();
      if (!row) return jsonResponse({ error: 'Sculpture not found' }, 404, request);
      const caller = await getAuthUser(request, env, cfg);
      if (row.hidden && !caller?.is_admin) {
        return jsonResponse({ error: 'Sculpture not available' }, 404, request);
      }
      return jsonResponse(
        {
          sculpture: serializeSculptureRow(row, {
            includeAdminFields: Boolean(caller?.is_admin),
            includeVoxels: true
          })
        },
        200,
        request
      );
    }

    // KV IPFS CID gateway
    const ipfsMatch = pathname.match(/^\/ipfs\/([a-zA-Z0-9_-]{10,128})$/);
    if (ipfsMatch && request.method === 'GET') {
      const cid = ipfsMatch[1];
      const { value, metadata } = await env.IPFS_KV.getWithMetadata(`cid:${cid}`);
      if (!value) return jsonResponse({ error: 'CID not found' }, 404, request);
      const bin = atob(value);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': metadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...corsHeaders(request)
        }
      });
    }

    return jsonResponse({ error: 'Not found' }, 404, request);
  }
};
