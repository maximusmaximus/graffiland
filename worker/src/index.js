import { ethers } from 'ethers';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { POLICY, ROBINHOOD_NETWORKS, STEWARD_DEFAULTS, TRANSACTION_FEES } from '../../shared/constants.mjs';
import {
  formatAgentProfile,
  getAgentProfile,
  getDualLeaderboards,
  issueAgentAuthChallenge,
  registerOrLoginAgentWallet
} from '../../shared/agentAuthService.mjs';
import {
  awakenParcelByHumanVisit,
  claimDormantLand,
  createArtQuest,
  getLandTelemetry,
  listNearbyQuests,
  scoutLands,
  updateLandVolume
} from '../../shared/agentQuestService.mjs';
import { searchLocations } from '../../shared/geocodeService.mjs';
import {
  checkUsernameAvailability,
  getPublicProfile,
  updateUserProfile
} from '../../shared/profileService.mjs';
import {
  createMarketplaceListing,
  executeMarketplacePurchase,
  getEconomySplitsSummary,
  listMarketplaceItems
} from '../../shared/marketplaceService.mjs';
import {
  buildAgentSpec,
  buildLlmsTxt,
  buildWellKnownAgentCard,
  createAgentSession,
  getAgentSession,
  submitAgentSculpture
} from '../../shared/agentService.mjs';
import { buildSculptureGlb } from '../../shared/glb.mjs';
import {
  buildContractMetadata,
  buildIpfsMetadata,
  buildSculptureSelectSql,
  buildSpatialBoundingWhere,
  computeVerticalBounds,
  formatMarketplaceTokenMetadata,
  serializeSculptureRow
} from '../../shared/sculpture.mjs';
import {
  listSculptureTransfers,
  syncSculptureOwnership,
  transferSculptureNft
} from '../../shared/transferService.mjs';
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
import {
  getOwnerPinSeal,
  getPinnedBatchMeta,
  issueParcelPresenceChallenge,
  saveEncryptedPinBatch,
  unlockPinnedBatchForParcelVisitor
} from '../../shared/pinService.mjs';
import {
  consumeDraftOnPublish,
  deleteUserDraft,
  getUserDraft,
  listUserDrafts,
  saveUserDraft
} from '../../shared/draftService.mjs';
import {
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
  getSignatureRequest,
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
} from '../../shared/mcpService.mjs';
import { b64ToModelBytes, validate3dModelUrl, validateAnchorOffset } from '../../shared/model3d.mjs';
import {
  checkAndConsumeRelayerQuota,
  fetchParcelLandmarkAnchor,
  refundRelayerQuota,
  saveParcelLandmarkAnchor,
  updateLandSecurityPolicy
} from '../../shared/landmarkService.mjs';
import {
  deleteUserPasskey,
  issuePasskeyAssertionOptions,
  issuePasskeyRegistrationOptions,
  listUserPasskeys,
  verifyAndConsumePasskeyAssertionChallenge,
  verifyAndStorePasskeyRegistration
} from '../../shared/passkeyService.mjs';
import {
  checkRateLimit,
  getOperationalHealthReport,
  logStructured,
  recordOpsEvent
} from '../../shared/monitoringService.mjs';
import {
  buildPropertyOwnerPrompt,
  normalizePairingCode
} from '../../shared/landSignatureMessage.mjs';
import { verifyPayoutLinkSignature } from '../../shared/payoutLinkMessage.mjs';
import { validatePublishPayload } from '../../server/services/moderation.mjs';
import {
  assessTravelFeasibility,
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
  'function updateTokenURI(uint256 tokenId, string calldata newURI) external',
  'event MetadataUpdate(uint256 indexed _tokenId)',
  'event SculptureMinted(uint256 indexed tokenId, address indexed recipient, bytes32 indexed landParcelId, bytes32 proofOfLocationHash, string tokenURI, int32 latE6, int32 lngE6)'
];

function resolveTrustedWebAuthnOrigins(request, cfg) {
  const trusted = new Set();
  let publicHost = 'localhost';
  try {
    const pu = new URL(String(cfg?.publicUrl || ''));
    if (pu.origin) trusted.add(pu.origin);
    publicHost = pu.hostname.toLowerCase();
  } catch {
    // ignore invalid publicUrl
  }
  const isLocalPublic =
    publicHost === 'localhost' || publicHost === '127.0.0.1' || publicHost.endsWith('.local');
  const reqOrigin = String(request?.headers?.get?.('Origin') || '').trim();
  if (reqOrigin && isLocalPublic) {
    try {
      const ro = new URL(reqOrigin);
      const h = ro.hostname.toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) {
        trusted.add(ro.origin);
      }
    } catch {
      // ignore invalid Origin
    }
  }
  return [...trusted];
}

function resolveWorkerRpId(request, fallbackUrl, cfg = null) {
  const originHeader = String(request?.headers?.get?.('Origin') || '').trim();
  const trusted = cfg ? resolveTrustedWebAuthnOrigins(request, cfg) : [];
  if (originHeader && (trusted.length === 0 || trusted.includes(originHeader))) {
    try {
      const originHost = new URL(originHeader).hostname.toLowerCase();
      if (originHost) return originHost;
    } catch {
      // ignore invalid origin
    }
  }
  if (cfg?.publicUrl) {
    try {
      const pubHost = new URL(String(cfg.publicUrl)).hostname.toLowerCase();
      if (pubHost) return pubHost;
    } catch {
      // ignore invalid publicUrl
    }
  }
  return (fallbackUrl?.hostname || 'localhost').toLowerCase();
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Graffiland-Pairing-Code',
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
    // Opt-in only: a missing var must never enable passwordless dev logins.
    allowDevGoogleAuth: env.ALLOW_DEV_GOOGLE_AUTH === 'true',
    publicUrl: env.PUBLIC_URL || 'https://maximusmaximus.github.io/graffiland',
    ipfsGateway: env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs',
    sessionSecret: env.SESSION_SECRET || 'graffiland-worker-dev-session-secret',
    walletEncryptionKey: env.WALLET_ENCRYPTION_KEY || 'graffiland-worker-dev-wallet-key',
    pinMasterKek:
      env.PIN_MASTER_KEK || env.WALLET_ENCRYPTION_KEY || 'graffiland-worker-dev-pin-kek',
    relayerDailyQuota: Number(env.RELAYER_DAILY_QUOTA || 25),
    missingSecrets: ['SESSION_SECRET', 'WALLET_ENCRYPTION_KEY'].filter((k) => {
      const val = String(env[k] || '').trim();
      return !val || val.startsWith('graffiland-worker-dev-');
    }),
    isLocalDev: isLocalDevUrl(env.PUBLIC_URL)
  };
}

function isLocalDevUrl(publicUrl) {
  try {
    const host = new URL(String(publicUrl || '')).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'anon';
}

const SAFE_PREVIEW_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_PREVIEW_DATA_URL_CHARS = 450000;
// Content types the KV IPFS gateway may serve inline; anything else is a download.
// SVG is allowed because the gateway sends CSP sandbox + default-src 'none' (no script).
const SAFE_GATEWAY_MIME = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/json',
  'model/gltf-binary',
  'model/gltf+json',
  'model/obj',
  'model/stl',
  'application/x-ply',
  'application/octet-stream'
]);

function sanitizeUser(row) {
  if (!row) return null;
  const username = String(row.username || '').trim();
  const isAgent = String(row.id || '').startsWith('agent:');
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    username,
    bio: String(row.bio || ''),
    needsUsernameOnboarding: !username && !isAgent,
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
    const userRow = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(decoded.sub).first();
    if (!userRow) return null;
    if (
      userRow.custom_payout_address &&
      String(userRow.custom_payout_address).toLowerCase() !==
        String(userRow.wallet_address || '').toLowerCase()
    ) {
      const proof = await env.DB.prepare(
        'SELECT user_id FROM payout_address_proofs WHERE user_id = ? AND LOWER(address) = ?'
      )
        .bind(userRow.id, String(userRow.custom_payout_address).toLowerCase())
        .first()
        .catch(() => null);
      if (!proof) userRow.custom_payout_address = '';
    }
    if (decoded.actorType === 'agent' || String(userRow.id).startsWith('agent:')) {
      const agentRow = await env.DB.prepare('SELECT * FROM agent_accounts WHERE agent_id = ?')
        .bind(userRow.id)
        .first();
      if (agentRow) {
        const slotRow = await env.DB.prepare(
          `SELECT COUNT(*) AS cnt FROM land_steward_state WHERE steward_sub = ? AND status = 'dormant'`
        )
          .bind(agentRow.agent_id)
          .first();
        return {
          ...userRow,
          sessionIssuedAt: Number(decoded.iat || 0),
          actorType: 'agent',
          agent: formatAgentProfile(agentRow, {
            activeDormantSlots: Number(slotRow?.cnt || 0)
          })
        };
      }
    }
    return { ...userRow, sessionIssuedAt: Number(decoded.iat || 0) };
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
  if (
    typeof previewDataUrl === 'string' &&
    previewDataUrl.startsWith('data:image/') &&
    previewDataUrl.length <= MAX_PREVIEW_DATA_URL_CHARS
  ) {
    const idx = previewDataUrl.indexOf(',');
    const header = idx !== -1 ? previewDataUrl.slice(0, idx) : '';
    const mime = (header.match(/data:([^;]+)/)?.[1] || '').toLowerCase();
    // Raster only: an attacker-supplied image/svg+xml preview would be served from the API
    // origin as an active document.
    if (idx !== -1 && SAFE_PREVIEW_MIME.has(mime) && /;base64$/i.test(header)) {
      try {
        const b64 = previewDataUrl.slice(idx + 1);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes, mime };
      } catch {
        // Fall back to safe placeholder SVG when client supplies malformed base64.
      }
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
  const customModel = params.customModel || null;
  const hasCustomBytes = Boolean(customModel?.bytes && customModel.bytes.length > 0);
  const modelExt = hasCustomBytes ? customModel.ext || 'glb' : 'glb';
  const modelMime = hasCustomBytes
    ? customModel.mimeType || 'model/gltf-binary'
    : 'model/gltf-binary';
  const glbBytes = hasCustomBytes
    ? customModel.bytes
    : buildSculptureGlb(params.voxels, {
        id: params.sculptureId,
        title: params.title,
        parcelId: params.locationBundle.parcelId,
        geohash: params.locationBundle.geohash
      });

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
      glbBytes,
      `${params.sculptureId}-model.${modelExt}`,
      modelMime,
      env,
      cfg
    );
  } else {
    imagePin = await pinToKv(preview.bytes, preview.mime, requestOrigin, env);
    modelPin = await pinToKv(glbBytes, modelMime, requestOrigin, env);
  }

  const publicIpfsAvailable = Boolean(env.PINATA_JWT);
  const metadata = buildIpfsMetadata({
    sculptureId: params.sculptureId,
    title: params.title,
    description: params.description,
    imageUri: publicIpfsAvailable ? imagePin.uri : imagePin.gatewayUrl,
    modelUri: publicIpfsAvailable ? modelPin.uri : modelPin.gatewayUrl,
    modelMimeType: modelMime,
    modelFormat: modelExt,
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
  lng,
  selfPaidGas = false,
  agentTxHash = ''
}, env, cfg) {
  const latE6 = Math.round(lat * 1e6);
  const lngE6 = Math.round(lng * 1e6);

  if (selfPaidGas) {
    const chainTxRequest = {
      method: 'mintAgentStage',
      contractAddress: cfg.contractAddress,
      chainId: cfg.network.chainId,
      network: cfg.network.name,
      from: recipientAddress,
      args: [metadataUri, parcelBytes32, proofHash, latE6, lngE6]
    };
    if (cfg.liveChainReady && agentTxHash && /^0x[0-9a-fA-F]{64}$/.test(agentTxHash)) {
      const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, cfg.network.chainId);
      const receipt = await provider.getTransactionReceipt(agentTxHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Agent self-paid gas tx ${agentTxHash} was not confirmed on chain.`);
      }
      if (String(receipt.from || '').toLowerCase() !== String(recipientAddress || '').toLowerCase()) {
        throw new Error(`Agent self-paid gas tx ${agentTxHash} was not sent from agent wallet ${recipientAddress}.`);
      }
      let tokenId = '0';
      const iface = new ethers.Interface(NFT_ABI);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
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
        gasSponsored: false,
        gasPaidBy: 'agent',
        chainId: cfg.network.chainId,
        chainName: cfg.network.name,
        contractAddress: cfg.contractAddress,
        tokenId,
        txHash: receipt.hash,
        explorerTxUrl: `${cfg.network.explorerUrl}/tx/${receipt.hash}`,
        royaltyBps: cfg.resaleFeeBps,
        royaltyReceiver: cfg.royaltyReceiver,
        gasSponsoredBy: recipientAddress,
        chainTxRequest
      };
    }

    const countRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM sculptures').first();
    const nextTokenId = String(Number(countRow?.c || 0) + 1);
    const txHash =
      agentTxHash && /^0x[0-9a-fA-F]{64}$/.test(agentTxHash)
        ? agentTxHash
        : ethers.keccak256(
            ethers.toUtf8Bytes(`agent-self-gas:${recipientAddress}|${metadataUri}|${proofHash}|${Date.now()}`)
          );
    return {
      simulated: true,
      gasSponsored: false,
      gasPaidBy: 'agent',
      chainId: cfg.network.chainId,
      chainName: `${cfg.network.name} (Agent Self-Paid Gas)`,
      contractAddress: cfg.contractAddress,
      tokenId: nextTokenId,
      txHash,
      explorerTxUrl: `${cfg.network.explorerUrl}/tx/${txHash}`,
      royaltyBps: cfg.resaleFeeBps,
      royaltyReceiver: cfg.royaltyReceiver,
      gasSponsoredBy: `Agent Wallet (${recipientAddress})`,
      chainTxRequest
    };
  }

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

async function emitWorkerMetadataUpdate(
  { tokenId, metadataUri, selfPaidGas = false, agentTxHash = '' },
  env,
  cfg
) {
  if (selfPaidGas) {
    const cleanHash = /^0x[0-9a-fA-F]{64}$/.test(String(agentTxHash || '').trim())
      ? String(agentTxHash).trim()
      : '';
    return {
      simulated: !cfg.liveChainReady || !cleanHash,
      erc4906Emitted: Boolean(cleanHash),
      txHash: cleanHash,
      gasSponsored: false,
      gasPaidBy: 'agent',
      chainTxRequest: cleanHash
        ? null
        : {
            method: 'updateTokenURI',
            network: cfg.network.name,
            chainId: cfg.network.chainId,
            contractAddress: cfg.contractAddress,
            args: [String(tokenId || '0'), metadataUri]
          }
    };
  }
  if (cfg.liveChainReady && tokenId && /^\d+$/.test(String(tokenId))) {
    try {
      const provider = new ethers.JsonRpcProvider(cfg.network.rpcUrl, cfg.network.chainId);
      const relayer = new ethers.Wallet(env.ROBINHOOD_RELAYER_PRIVATE_KEY, provider);
      const contract = new ethers.Contract(cfg.contractAddress, NFT_ABI, relayer);
      const tx = await contract.updateTokenURI(BigInt(tokenId), metadataUri);
      const receipt = await tx.wait();
      return { simulated: false, erc4906Emitted: true, txHash: receipt.hash };
    } catch {
      // Older deployed contract instances without updateTokenURI still serve dynamic metadata
    }
  }
  return {
    simulated: true,
    erc4906Emitted: true,
    txHash: ethers.keccak256(
      ethers.toUtf8Bytes(`erc4906:${cfg.contractAddress}:${tokenId}:${metadataUri}:${Date.now()}`)
    )
  };
}

export class PairCoordinator {
  constructor(state) {
    this.state = state;
    this.rooms = new Map();
    this.mcpSubscribers = new Map();
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
    const reqUrl = new URL(request.url);
    if (reqUrl.pathname === '/notify' && request.method === 'POST') {
      const event = await request.json().catch(() => null);
      const code = normalizePairingCode(event?.pairingCode || '');
      const subs = code ? this.mcpSubscribers.get(code) : null;
      if (subs) {
        for (const ws of subs) {
          this.sendJson(ws, event);
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let meta = { role: null, code: null, mcpCode: null };

    server.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'subscribe_mcp') {
        const mCode = normalizePairingCode(msg.pairingCode || '');
        if (mCode) {
          if (meta.mcpCode && this.mcpSubscribers.has(meta.mcpCode)) {
            this.mcpSubscribers.get(meta.mcpCode).delete(server);
          }
          meta.mcpCode = mCode;
          if (!this.mcpSubscribers.has(mCode)) this.mcpSubscribers.set(mCode, new Set());
          this.mcpSubscribers.get(mCode).add(server);
          this.state.storage?.put?.(`mcp:${mCode}`, { updatedAt: Date.now() }).catch(() => {});
          this.sendJson(server, { type: 'mcp_subscribed', pairingCode: mCode });
        }
        return;
      }

      if (msg.type === 'create_pair') {
        const code = this.generateCode();
        this.rooms.set(code, { code, desktopWs: server, mobileWs: null });
        meta = { ...meta, role: 'desktop', code };
        this.state.storage?.put?.(`room:${code}`, { code, createdAt: Date.now() }).catch(() => {});
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
        meta = { ...meta, role: 'mobile', code };
        this.state.storage?.put?.(`room:${code}:connected`, { connectedAt: Date.now() }).catch(() => {});
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
      if (meta.mcpCode && this.mcpSubscribers.has(meta.mcpCode)) {
        this.mcpSubscribers.get(meta.mcpCode).delete(server);
      }
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

    // Never sign sessions or encrypt custodial keys with the public dev fallbacks in a deployed
    // Worker: anyone could forge JWTs for any account.
    if (
      cfg.missingSecrets.length > 0 &&
      !cfg.isLocalDev &&
      pathname.startsWith('/api/') &&
      pathname !== '/api/health' &&
      pathname !== '/api/config'
    ) {
      logStructured('error', 'worker_missing_secrets', { missing: cfg.missingSecrets });
      return jsonResponse({ error: 'Service misconfigured. Please try again later.' }, 503, request);
    }

    // LLM & A2A Agent Discovery Manifests
    if (pathname === '/llms.txt' && request.method === 'GET') {
      return new Response(buildLlmsTxt(url.origin), {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...corsHeaders(request)
        }
      });
    }

    if (pathname === '/.well-known/agent.json' && request.method === 'GET') {
      return jsonResponse(buildWellKnownAgentCard(url.origin), 200, request);
    }

    // WebSocket Pairing Gateway
    if (pathname === '/ws') {
      const id = env.PAIR_COORDINATOR.idFromName('global-hub');
      const stub = env.PAIR_COORDINATOR.get(id);
      return stub.fetch(request);
    }

    if (pathname === '/api/health') {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        return jsonResponse(
          { ok: true, db: 'connected', service: 'graffiland-worker', timestamp: new Date().toISOString() },
          200,
          request
        );
      } catch (err) {
        return jsonResponse({ ok: false, error: err?.message || 'D1 check failed' }, 500, request);
      }
    }

    if (pathname === '/api/config') {
      return jsonResponse(
        {
          googleClientId: cfg.googleClientId || null,
          allowDevGoogleAuth: cfg.allowDevGoogleAuth,
          policy: POLICY,
          feeBreakdown: TRANSACTION_FEES,
          stewardDefaults: STEWARD_DEFAULTS,
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

    // EIP-7572 / OpenSea Collection Metadata
    if (pathname === '/api/contract/metadata.json' && request.method === 'GET') {
      return jsonResponse(
        buildContractMetadata({
          publicUrl: cfg.publicUrl,
          apiOrigin: url.origin,
          royaltyBps: cfg.resaleFeeBps,
          royaltyReceiver: cfg.royaltyReceiver,
          contractAddress: cfg.contractAddress,
          chain: cfg.network
        }),
        200,
        request
      );
    }

    // ERC-721 Token ID Metadata endpoint
    const tokenMetaMatch = pathname.match(/^\/api\/tokens\/([^/]+)\.json$/);
    if (tokenMetaMatch && request.method === 'GET') {
      const tokenId = decodeURIComponent(tokenMetaMatch[1]);
      const row = await env.DB.prepare(
        'SELECT * FROM sculptures WHERE token_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 1'
      )
        .bind(tokenId)
        .first();
      if (!row) return jsonResponse({ error: 'Token not found' }, 404, request);
      return jsonResponse(
        formatMarketplaceTokenMetadata(row, { apiOrigin: url.origin, publicUrl: cfg.publicUrl }),
        200,
        request
      );
    }

    const d1Adapter = {
      get: (sql, params = []) => env.DB.prepare(sql).bind(...params).first(),
      all: async (sql, params = []) => {
        const res = await env.DB.prepare(sql).bind(...params).all();
        return res.results || [];
      },
      run: (sql, params = []) => env.DB.prepare(sql).bind(...params).run()
    };

    // Agent Sculpture Handoff Spec & Location-Anchored Session Routes
    if (pathname === '/api/agent/spec' && request.method === 'GET') {
      return jsonResponse(buildAgentSpec(url.origin), 200, request);
    }

    if (pathname === '/api/agent/sessions' && request.method === 'POST') {
      try {
        const caller = await getAuthUser(request, env, cfg);
        const body = await request.json().catch(() => ({}));
        const out = await createAgentSession(d1Adapter, {
          callerUser: caller,
          location: body?.location,
          apiOrigin: url.origin
        });
        return jsonResponse(out, 201, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Failed to create agent session' },
          err?.statusCode || 400,
          request
        );
      }
    }

    const agentSubmitMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/sculpture$/);
    if (agentSubmitMatch && request.method === 'POST') {
      try {
        const code = decodeURIComponent(agentSubmitMatch[1]);
        const body = await request.json().catch(() => ({}));
        const out = await submitAgentSculpture(d1Adapter, {
          code,
          body,
          apiOrigin: url.origin
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Failed to stage agent sculpture', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const agentGetMatch = pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/);
    if (agentGetMatch && request.method === 'GET') {
      try {
        const code = decodeURIComponent(agentGetMatch[1]);
        const out = await getAgentSession(d1Adapter, { code, apiOrigin: url.origin });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Failed to fetch agent session' },
          err?.statusCode || 400,
          request
        );
      }
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

    // User Profiles: username availability validation, profile update (username + bio), and public profiles
    if (pathname === '/api/profile/check-username' && request.method === 'GET') {
      try {
        const authUser = await getAuthUser(request, env, cfg);
        const result = await checkUsernameAvailability(d1Adapter, {
          username: String(url.searchParams.get('username') || ''),
          excludeUserId: authUser?.id || ''
        });
        return jsonResponse(result, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Username check failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/profile/me' && request.method === 'GET') {
      try {
        const user = await getAuthUser(request, env, cfg);
        if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
        const pub = await getPublicProfile(d1Adapter, {
          identifier: user.id,
          origin: request.headers.get('Origin') || url.origin,
          pathname: '/'
        });
        return jsonResponse({ user: sanitizeUser(user), ...pub }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to load profile' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/profile' && (request.method === 'PATCH' || request.method === 'POST')) {
      try {
        const user = await getAuthUser(request, env, cfg);
        if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
        const body = await request.json().catch(() => ({}));
        const updated = await updateUserProfile(d1Adapter, {
          user,
          username: body?.username,
          bio: body?.bio
        });
        const pub = await getPublicProfile(d1Adapter, {
          identifier: updated.id,
          origin: request.headers.get('Origin') || url.origin,
          pathname: '/'
        });
        return jsonResponse({ user: sanitizeUser(updated), ...pub }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to save profile' }, err?.statusCode || 400, request);
      }
    }

    const publicProfileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (publicProfileMatch && request.method === 'GET') {
      try {
        const handle = decodeURIComponent(publicProfileMatch[1]);
        const pub = await getPublicProfile(d1Adapter, {
          identifier: handle,
          origin: request.headers.get('Origin') || url.origin,
          pathname: '/'
        });
        return jsonResponse(pub, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Profile not found' }, err?.statusCode || 404, request);
      }
    }

    // Cloud Saved Drafts (Auto-Saved & Named WIP Sculptures)
    if (pathname === '/api/drafts') {
      try {
        const user = await getAuthUser(request, env, cfg);
        if (request.method === 'GET') {
          return jsonResponse(await listUserDrafts(d1Adapter, { user }), 200, request);
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse(await saveUserDraft(d1Adapter, { user, body }), 200, request);
        }
        return jsonResponse({ error: 'Method not allowed' }, 405, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Draft request failed' },
          err?.statusCode || 400,
          request
        );
      }
    }

    const draftMatch = pathname.match(/^\/api\/drafts\/([^/]+)$/);
    if (draftMatch) {
      try {
        const draftId = decodeURIComponent(draftMatch[1]);
        const user = await getAuthUser(request, env, cfg);
        if (request.method === 'GET') {
          return jsonResponse(await getUserDraft(d1Adapter, { draftId, user }), 200, request);
        }
        if (request.method === 'DELETE') {
          return jsonResponse(await deleteUserDraft(d1Adapter, { draftId, user }), 200, request);
        }
        return jsonResponse({ error: 'Method not allowed' }, 405, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Draft request failed' },
          err?.statusCode || 400,
          request
        );
      }
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
      const isEmbedded =
        normalized && String(user.wallet_address || '').toLowerCase() === normalized.toLowerCase();
      if (normalized && !isEmbedded) {
        // The payout address doubles as an ownership identity (land + sculpture checks), so
        // require proof of control and refuse addresses already linked to another account.
        let verifiedProof;
        try {
          verifiedProof = verifyPayoutLinkSignature({
            userId: user.id,
            address: normalized,
            issuedAt: body?.issuedAt,
            signature: body?.signature
          });
        } catch (err) {
          return jsonResponse({ error: err.message }, err?.statusCode || 400, request);
        }
        const taken = await env.DB.prepare(
          'SELECT id FROM users WHERE id != ? AND (LOWER(wallet_address) = ? OR LOWER(custom_payout_address) = ?) LIMIT 1'
        )
          .bind(user.id, normalized.toLowerCase(), normalized.toLowerCase())
          .first();
        if (taken) {
          return jsonResponse(
            { error: 'That wallet address is already linked to another GRAFFILAND account.' },
            409,
            request
          );
        }
        await env.DB.prepare(
          `INSERT INTO payout_address_proofs (user_id, address, message, signature, verified_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             address = excluded.address,
             message = excluded.message,
             signature = excluded.signature,
             verified_at = excluded.verified_at`
        )
          .bind(
            user.id,
            normalized,
            verifiedProof.message,
            String(body?.signature || '').trim(),
            new Date().toISOString()
          )
          .run();
      } else {
        await env.DB.prepare('DELETE FROM payout_address_proofs WHERE user_id = ?')
          .bind(user.id)
          .run();
      }
      await env.DB.prepare('UPDATE users SET custom_payout_address = ? WHERE id = ?')
        .bind(normalized, user.id)
        .run();
      const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      return jsonResponse({ user: sanitizeUser(updated) }, 200, request);
    }

    if (pathname === '/api/wallet/export' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      return jsonResponse(
        {
          error: 'Hardware Passkey verification is required to export your embedded wallet key.',
          code: 'PASSKEY_REQUIRED'
        },
        403,
        request
      );
    }

    if (pathname === '/api/wallet/export/challenge' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        await checkRateLimit(d1Adapter, {
          scope: 'wallet_export',
          key: user.id,
          windowSec: 300,
          maxRequests: 10
        });
        const options = await issuePasskeyAssertionOptions(d1Adapter, {
          user,
          purpose: 'wallet_export',
          rpId: resolveWorkerRpId(request, url, cfg)
        });
        return jsonResponse(options, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Passkey challenge failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    if (pathname === '/api/wallet/export' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        await checkRateLimit(d1Adapter, {
          scope: 'wallet_export',
          key: user.id,
          windowSec: 300,
          maxRequests: 10
        });
        const body = await request.json().catch(() => ({}));
        const allowedOrigins = resolveTrustedWebAuthnOrigins(request, cfg);
        await verifyAndConsumePasskeyAssertionChallenge(d1Adapter, {
          user,
          challenge: body?.challenge,
          assertion: body?.assertion,
          purpose: 'wallet_export',
          expectedRpId: resolveWorkerRpId(request, url, cfg),
          allowedOrigins
        });
        const privateKey = await decryptWalletPrivateKey(
          user.encrypted_wallet_json,
          cfg.walletEncryptionKey
        );
        return new Response(JSON.stringify({ walletAddress: user.wallet_address, privateKey }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...corsHeaders(request)
          }
        });
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Failed to export embedded wallet', ...(err?.extra || {}) },
          err?.statusCode || 500,
          request
        );
      }
    }

    const WORKER_SCULPTURE_SELECT_SQL = `
      SELECT s.*,
        (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
        (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
        (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue,
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

    // List public sculptures
    if (pathname === '/api/sculptures' && request.method === 'GET') {
      const includeVoxelsParam = url.searchParams.get('includeVoxels');
      const includeVoxels = includeVoxelsParam !== '0' && includeVoxelsParam !== 'false';
      const parcelFilter = url.searchParams.get('parcel')?.toUpperCase() || '';
      const latParam = url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : null;
      const lngParam = url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : null;
      const radiusMeters = url.searchParams.has('radiusMeters')
        ? Math.max(10, Number(url.searchParams.get('radiusMeters')))
        : null;

      const selectSql = buildSculptureSelectSql({ includeVoxels });
      const { whereSql, params } = buildSpatialBoundingWhere({
        lat: latParam,
        lng: lngParam,
        radiusMeters,
        parcel: parcelFilter
      });
      const { results } = await env.DB.prepare(
        `${selectSql} WHERE ${whereSql} ORDER BY s.created_at DESC`
      )
        .bind(...params)
        .all();
      let items = (results || []).map((r) => serializeSculptureRow(r, { includeVoxels }));

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

    // List Virtual Land parcels (with owner curation metadata)
    if ((pathname === '/api/parcels' || pathname === '/api/lands') && request.method === 'GET') {
      const parcels = await listLandsWithCurations(d1Adapter);
      return jsonResponse({ parcels }, 200, request);
    }

    // Robust MCP Pairing, Land Ownership Edits, Signature Notifications & Agent Signing
    const makeWorkerPinHook = () => (params) => pinSculptureBundle(params, url.origin, env, cfg);
    const makeWorkerPinJsonHook = () => async (obj, fileName) => {
      if (env.PINATA_JWT) {
        return pinToPinataJson(obj, fileName, env, cfg);
      }
      return pinToKv(
        new TextEncoder().encode(JSON.stringify(obj, null, 2)),
        'application/json',
        url.origin,
        env
      );
    };
    const makeWorkerMintHook = () => (params) => mintOnChainOrSimulate(params, env, cfg);
    const makeWorkerMetadataUpdateHook = () => (params) =>
      emitWorkerMetadataUpdate(params, env, cfg);
    const notifyWorkerMobile = async (event) => {
      try {
        const doId = env.PAIR_COORDINATOR.idFromName('global-hub');
        await env.PAIR_COORDINATOR.get(doId).fetch('https://pair/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event)
        });
      } catch {
        // non-blocking push notification
      }
    };
    const extractPairingCode = (req, body = {}) =>
      req.headers.get('X-Graffiland-Pairing-Code') ||
      body?.pairingCode ||
      body?.code ||
      body?.params?.pairingCode ||
      body?.params?.arguments?.pairingCode ||
      url.searchParams.get('pairingCode') ||
      '';

    // Zero-OAuth Agent Auth, Scouting, Free Claims, Quests & 5%/3%/2% Marketplace
    if (pathname === '/api/agents/challenge' && request.method === 'POST') {
      try {
        await checkRateLimit(d1Adapter, {
          scope: 'agent_challenge',
          key: clientIp(request),
          windowSec: 60,
          maxRequests: 20
        });
        const body = await request.json().catch(() => ({}));
        const out = await issueAgentAuthChallenge(d1Adapter, {
          walletAddress: body?.walletAddress
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Challenge failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/agents/register' && request.method === 'POST') {
      try {
        // Each new wallet gets free dormant-claim slots; throttle bulk wallet registration.
        await checkRateLimit(d1Adapter, {
          scope: 'agent_register',
          key: clientIp(request),
          windowSec: 3600,
          maxRequests: 10
        });
        const body = await request.json().catch(() => ({}));
        const out = await registerOrLoginAgentWallet(d1Adapter, {
          walletAddress: body?.walletAddress,
          nonce: body?.nonce,
          signature: body?.signature,
          name: body?.name,
          framework: body?.framework,
          description: body?.description,
          endpointUrl: body?.endpointUrl,
          sessionSecret: cfg.sessionSecret
        });
        return jsonResponse(out, 201, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Agent registration failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/agents/me' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
      try {
        return jsonResponse(await getAgentProfile(d1Adapter, user.id), 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Profile failed' }, err?.statusCode || 404, request);
      }
    }

    if (pathname === '/api/agents/leaderboard' && request.method === 'GET') {
      try {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 25;
        return jsonResponse(await getDualLeaderboards(d1Adapter, { limit }), 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Leaderboard failed' }, err?.statusCode || 400, request);
      }
    }

    const agentProfileMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentProfileMatch && request.method === 'GET') {
      try {
        const out = await getAgentProfile(d1Adapter, decodeURIComponent(agentProfileMatch[1]));
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Agent not found' }, err?.statusCode || 404, request);
      }
    }

    if (pathname === '/api/lands/scout' && request.method === 'GET') {
      try {
        const out = await scoutLands(d1Adapter, {
          lat: url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : null,
          lng: url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : null,
          radiusMeters: url.searchParams.has('radiusMeters')
            ? Number(url.searchParams.get('radiusMeters'))
            : 5000,
          statusFilter: url.searchParams.get('status') || 'all'
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Scout failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/lands/claim' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
      try {
        await checkRateLimit(d1Adapter, {
          scope: 'land_claim',
          key: user.id,
          windowSec: 60,
          maxRequests: 10
        });
        const body = await request.json().catch(() => ({}));
        const out = await claimDormantLand(d1Adapter, {
          agentUser: user,
          parcelId: body?.parcelId || '',
          lat: body?.lat,
          lng: body?.lng,
          customName: body?.customName || '',
          description: body?.description || '',
          curationNote: body?.curationNote || '',
          volume: body?.volume || null,
          txHash: body?.txHash || '',
          chainCfg: cfg
        });
        return jsonResponse(out, 201, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Land claim failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const landVolumeMatch = pathname.match(/^\/api\/lands\/([^/]+)\/volume$/);
    if (landVolumeMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await updateLandVolume(d1Adapter, {
          parcelId: decodeURIComponent(landVolumeMatch[1]),
          user,
          volume: body?.volume || body || {}
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Could not update 3D land volume', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    if (pathname === '/api/geocode/search' && request.method === 'GET') {
      try {
        // Upstream Nominatim policy is ~1 req/s; don't let one client burn it for everyone.
        await checkRateLimit(d1Adapter, {
          scope: 'geocode',
          key: clientIp(request),
          windowSec: 60,
          maxRequests: 30
        });
        const out = await searchLocations({
          query: url.searchParams.get('q') || '',
          lat: url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : null,
          lng: url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : null,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 6
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Location search failed' },
          err?.statusCode || 400,
          request
        );
      }
    }

    const landTelemetryMatch = pathname.match(/^\/api\/lands\/([^/]+)\/telemetry$/);
    if (landTelemetryMatch && request.method === 'GET') {
      try {
        const out = await getLandTelemetry(d1Adapter, decodeURIComponent(landTelemetryMatch[1]));
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Telemetry failed' }, err?.statusCode || 404, request);
      }
    }

    const landQuestsMatch = pathname.match(/^\/api\/lands\/([^/]+)\/quests$/);
    if (landQuestsMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await createArtQuest(d1Adapter, {
          parcelId: decodeURIComponent(landQuestsMatch[1]),
          user,
          title: body?.title,
          prompt: body?.prompt,
          theme: body?.theme,
          bountyEth: body?.bountyEth,
          maxCompletions: body?.maxCompletions,
          slotOffsets: body?.slotOffsets
        });
        return jsonResponse({ quest: out }, 201, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Quest creation failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/quests/nearby' && request.method === 'GET') {
      try {
        const out = await listNearbyQuests(d1Adapter, {
          lat: url.searchParams.has('lat') ? Number(url.searchParams.get('lat')) : null,
          lng: url.searchParams.has('lng') ? Number(url.searchParams.get('lng')) : null,
          radiusMeters: url.searchParams.has('radiusMeters')
            ? Number(url.searchParams.get('radiusMeters'))
            : 25000,
          status: url.searchParams.get('status') || 'open'
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Quest lookup failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/marketplace/listings') {
      try {
        if (request.method === 'GET') {
          const listings = await listMarketplaceItems(d1Adapter, {
            status: url.searchParams.get('status') || 'active',
            parcelId: url.searchParams.get('parcel') || '',
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 60
          });
          return jsonResponse({ listings }, 200, request);
        }
        if (request.method === 'POST') {
          const user = await getAuthUser(request, env, cfg);
          if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
          const body = await request.json().catch(() => ({}));
          const listing = await createMarketplaceListing(d1Adapter, {
            sculptureId: body?.sculptureId,
            sellerUser: user,
            priceEth: body?.priceEth,
            platformAddress: cfg.royaltyReceiver
          });
          return jsonResponse({ listing }, 201, request);
        }
        return jsonResponse({ error: 'Method not allowed' }, 405, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Marketplace error' }, err?.statusCode || 400, request);
      }
    }

    const marketBuyMatch = pathname.match(/^\/api\/marketplace\/listings\/([^/]+)\/buy$/);
    if (marketBuyMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await executeMarketplacePurchase(d1Adapter, {
          listingId: decodeURIComponent(marketBuyMatch[1]),
          buyerUser: user,
          buyerAddress: body?.buyerAddress || '',
          txHash: body?.txHash || '',
          platformAddress: cfg.royaltyReceiver
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Purchase failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/economy/splits' && request.method === 'GET') {
      try {
        const out = await getEconomySplitsSummary(d1Adapter, {
          parcelId: url.searchParams.get('parcel') || '',
          address: url.searchParams.get('address') || ''
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Economy lookup failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/mcp/spec' && request.method === 'GET') {
      return jsonResponse(
        {
          protocol: 'Model Context Protocol (JSON-RPC 2.0)',
          endpoint: `${url.origin}/api/mcp`,
          requiresActivePairingConnection: true,
          tools: MCP_TOOLS,
          agentSpec: buildAgentSpec(url.origin),
          ownerPromptTemplate: buildPropertyOwnerPrompt({ apiOrigin: url.origin })
        },
        200,
        request
      );
    }

    if (pathname === '/api/mcp/pairings') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        if (request.method === 'GET') {
          return jsonResponse(await listMcpPairings(d1Adapter, { user }), 200, request);
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse(
            await createMcpPairing(d1Adapter, {
              user,
              expiresHours: Number(body?.expiresHours || 24),
              apiOrigin: url.origin
            }),
            200,
            request
          );
        }
        return jsonResponse({ error: 'Method not allowed' }, 405, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'MCP pairing error' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/mcp/pairings/connect' && request.method === 'POST') {
      try {
        const caller = await getAuthUser(request, env, cfg);
        const body = await request.json().catch(() => ({}));
        const out = await connectMcpPairing(d1Adapter, {
          pairingCode: extractPairingCode(request, body),
          agentName: body?.agentName,
          agentAddress: body?.agentAddress,
          signature: body?.signature,
          callerUser: caller,
          apiOrigin: url.origin
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Pairing connect failed' }, err?.statusCode || 400, request);
      }
    }

    const mcpDisconnectMatch = pathname.match(/^\/api\/mcp\/pairings\/([^/]+)\/disconnect$/);
    if (mcpDisconnectMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const out = await disconnectMcpPairing(d1Adapter, {
          pairingCode: decodeURIComponent(mcpDisconnectMatch[1]),
          user
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Disconnect failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/mcp' && request.method === 'POST') {
      const rpcBody = await request.json().catch(() => ({}));
      const id = rpcBody?.id ?? null;
      try {
        const pairingCode = extractPairingCode(request, rpcBody);
        const clientIp = request.headers.get('CF-Connecting-IP') || 'anon';
        await checkRateLimit(d1Adapter, {
          scope: 'mcp',
          key: pairingCode || clientIp,
          windowSec: 60,
          maxRequests: 120
        });
        const caller = await getAuthUser(request, env, cfg);
        const out = await handleMcpJsonRpc(d1Adapter, {
          rpcBody,
          pairingCode,
          callerUser: caller,
          apiOrigin: url.origin,
          pinSculptureFn: makeWorkerPinHook(),
          mintSculptureFn: makeWorkerMintHook(),
          notifyMobileFn: notifyWorkerMobile,
          emitMetadataUpdateFn: makeWorkerMetadataUpdateHook()
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id,
            error: {
              code: err?.statusCode === 403 ? -32001 : -32000,
              message: err.message || 'MCP request failed',
              data: err?.extra || {}
            }
          },
          err?.statusCode || 400,
          request
        );
      }
    }

    if (pathname === '/api/lands/mine' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        return jsonResponse(await getMyLandsWorkspace(d1Adapter, { user }), 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Could not load lands' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/models/validate-url' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Authentication required' }, 401, request);
      try {
        await checkRateLimit(d1Adapter, {
          scope: 'model_url',
          key: user.id,
          windowSec: 60,
          maxRequests: 10
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, err?.statusCode || 429, request);
      }
      const body = await request.json().catch(() => ({}));
      const modelUrl = String(body?.modelUrl || body?.url || '').trim();
      const formatHint = String(body?.modelFormat || body?.format || '').trim();
      const checked = await validate3dModelUrl(modelUrl, { formatHint });
      return jsonResponse(
        {
          valid: Boolean(checked.valid),
          error: checked.error || null,
          format: checked.format || '',
          mimeType: checked.mimeType || '',
          byteLength: checked.byteLength || 0,
          stats: checked.stats || null,
          suggestedTitle: checked.suggestedTitle || '',
          modelUrl
        },
        checked.valid ? 200 : 400,
        request
      );
    }

    const landDetailMatch = pathname.match(/^\/api\/lands\/([^/]+)$/);
    if (
      landDetailMatch &&
      request.method === 'GET' &&
      !['scout', 'mine', 'claim'].includes(landDetailMatch[1].toLowerCase())
    ) {
      try {
        const out = await getPublicParcelDetail(d1Adapter, {
          parcelOrSlug: decodeURIComponent(landDetailMatch[1])
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Virtual Land not found' },
          err?.statusCode || 404,
          request
        );
      }
    }

    const landSettingsMatch = pathname.match(/^\/api\/lands\/([^/]+)\/settings$/);
    if (landSettingsMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await updateLandSettings(d1Adapter, {
          parcelId: decodeURIComponent(landSettingsMatch[1]),
          user,
          body
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Settings update failed' }, err?.statusCode || 400, request);
      }
    }

    const landContribMatch = pathname.match(/^\/api\/lands\/([^/]+)\/contributors$/);
    if (landContribMatch) {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      const parcelId = decodeURIComponent(landContribMatch[1]);
      try {
        if (request.method === 'GET') {
          return jsonResponse(
            await listLandContributorsAndEligible(d1Adapter, { parcelId, user }),
            200,
            request
          );
        }
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse(
            await addLandContributor(d1Adapter, { parcelId, user, body }),
            200,
            request
          );
        }
        return jsonResponse({ error: 'Method not allowed' }, 405, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Contributor request failed' }, err?.statusCode || 400, request);
      }
    }

    const landContribDelMatch = pathname.match(/^\/api\/lands\/([^/]+)\/contributors\/([^/]+)$/);
    if (landContribDelMatch && request.method === 'DELETE') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const out = await removeLandContributor(d1Adapter, {
          parcelId: decodeURIComponent(landContribDelMatch[1]),
          contributorSub: decodeURIComponent(landContribDelMatch[2]),
          user
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Remove contributor failed' }, err?.statusCode || 400, request);
      }
    }

    const landEraseMatch = pathname.match(/^\/api\/lands\/([^/]+)\/erase$/);
    if (landEraseMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await directOwnerEraseLand(d1Adapter, {
          parcelId: decodeURIComponent(landEraseMatch[1]),
          user,
          body
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Erase land failed' }, err?.statusCode || 400, request);
      }
    }

    const landUpdateMatch = pathname.match(/^\/api\/lands\/([^/]+)\/update$/);
    if (landUpdateMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await directOwnerUpdateParcel(d1Adapter, {
          parcelId: decodeURIComponent(landUpdateMatch[1]),
          user,
          body
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Land update failed' }, err?.statusCode || 400, request);
      }
    }

    const landCreateMatch = pathname.match(/^\/api\/lands\/([^/]+)\/sculptures$/);
    if (landCreateMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      let quotaConsumed = false;
      try {
        const body = await request.json().catch(() => ({}));
        await checkRateLimit(d1Adapter, {
          scope: 'land_create',
          key: user.id,
          windowSec: 60,
          maxRequests: 30
        });
        const qRes = await checkAndConsumeRelayerQuota(d1Adapter, {
          userId: user.id,
          isAdmin: Boolean(user.is_admin),
          dailyQuota: cfg.relayerDailyQuota
        });
        quotaConsumed = Boolean(qRes?.consumed);
        const out = await directOwnerCreateSculptureOnLand(d1Adapter, {
          parcelId: decodeURIComponent(landCreateMatch[1]),
          user,
          body,
          pinSculptureFn: makeWorkerPinHook(),
          mintSculptureFn: makeWorkerMintHook()
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        if (quotaConsumed) await refundRelayerQuota(d1Adapter, { userId: user.id });
        return jsonResponse(
          { error: err.message || 'Create sculpture on land failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const landLandmarkMatch = pathname.match(/^\/api\/lands\/([^/]+)\/landmark-pack$/);
    if (landLandmarkMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await saveParcelLandmarkAnchor(d1Adapter, {
          parcelId: decodeURIComponent(landLandmarkMatch[1]),
          user,
          body,
          pinJsonFn: makeWorkerPinJsonHook()
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Landmark pack save failed' }, err?.statusCode || 400, request);
      }
    }

    const landLandmarkFetchMatch = pathname.match(/^\/api\/lands\/([^/]+)\/landmark-pack\/fetch$/);
    if (landLandmarkFetchMatch && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const out = await fetchParcelLandmarkAnchor(d1Adapter, {
          parcelId: decodeURIComponent(landLandmarkFetchMatch[1]),
          body,
          userAgent: request.headers.get('User-Agent') || ''
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Landmark pack fetch failed' }, err?.statusCode || 400, request);
      }
    }

    const landSecurityMatch = pathname.match(/^\/api\/lands\/([^/]+)\/security$/);
    if (landSecurityMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await updateLandSecurityPolicy(d1Adapter, {
          parcelId: decodeURIComponent(landSecurityMatch[1]),
          user,
          body
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Security policy update failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/passkeys/status' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      return jsonResponse({ passkeys: await listUserPasskeys(d1Adapter, user.id) }, 200, request);
    }

    if (pathname === '/api/passkeys/register/options' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const opts = await issuePasskeyRegistrationOptions(user, {
          db: d1Adapter,
          rpId: resolveWorkerRpId(request, url, cfg)
        });
        return jsonResponse(opts, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Passkey registration options failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    if (pathname === '/api/passkeys/register/verify' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const allowedOrigins = resolveTrustedWebAuthnOrigins(request, cfg);
        const out = await verifyAndStorePasskeyRegistration(d1Adapter, {
          user,
          body,
          rpId: resolveWorkerRpId(request, url, cfg),
          allowedOrigins
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Passkey registration failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const pkDelMatch = pathname.match(/^\/api\/passkeys\/([^/]+)$/);
    if (pkDelMatch && request.method === 'DELETE') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const out = await deleteUserPasskey(d1Adapter, {
          userId: user.id,
          passkeyId: decodeURIComponent(pkDelMatch[1]),
          user
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Passkey removal failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const ownerVisMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/visibility$/);
    if (ownerVisMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await directOwnerSetSculptureVisibility(d1Adapter, {
          sculptureId: decodeURIComponent(ownerVisMatch[1]),
          user,
          hidden: Boolean(body?.hidden),
          reason: body?.reason || ''
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Visibility update failed' }, err?.statusCode || 400, request);
      }
    }

    const editMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/edit$/);
    if (editMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await directOwnerUpdateSculpture(d1Adapter, {
          sculptureId: decodeURIComponent(editMatch[1]),
          user,
          body,
          pinSculptureFn: makeWorkerPinHook(),
          emitMetadataUpdateFn: makeWorkerMetadataUpdateHook()
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Update sculpture failed' }, err?.statusCode || 400, request);
      }
    }

    const revListMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/revisions$/);
    if (revListMatch && request.method === 'GET') {
      try {
        const out = await listSculptureRevisions(d1Adapter, {
          sculptureId: decodeURIComponent(revListMatch[1])
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Revision list failed' }, err?.statusCode || 400, request);
      }
    }

    const revRollbackMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/revisions\/(\d+)\/rollback$/);
    if (revRollbackMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const out = await directOwnerRollbackRevision(d1Adapter, {
          sculptureId: decodeURIComponent(revRollbackMatch[1]),
          revNum: Number(revRollbackMatch[2]),
          user,
          emitMetadataUpdateFn: makeWorkerMetadataUpdateHook()
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Revision rollback failed' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/signatures/pending' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const includeHistory = url.searchParams.get('includeHistory') === '1';
        return jsonResponse(
          await listPendingSignaturesForUser(d1Adapter, { user, includeHistory }),
          200,
          request
        );
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to load signatures' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/signatures/history' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const limit = Number(url.searchParams.get('limit') || 40);
        return jsonResponse(
          await listSignatureHistoryForUser(d1Adapter, { user, limit }),
          200,
          request
        );
      } catch (err) {
        return jsonResponse({ error: err.message || 'Failed to load signature history' }, err?.statusCode || 400, request);
      }
    }

    if (pathname === '/api/signatures/requests' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const ua = request.headers.get('User-Agent') || '';
        const isMobile =
          Boolean(body?.deviceProfile?.isMobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
        const out = await createPublishSignatureRequestForMobile(d1Adapter, {
          user,
          body,
          pairingCode: extractPairingCode(request, body),
          isMobileRequest: isMobile,
          apiOrigin: url.origin
        });
        return jsonResponse(out, 201, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Failed to stage signature request', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const sigActionMatch = pathname.match(
      /^\/api\/signatures\/requests\/([^/]+)\/(mobile-sign|agent-sign|reject)$/
    );
    if (sigActionMatch && request.method === 'POST') {
      const reqId = decodeURIComponent(sigActionMatch[1]);
      const action = sigActionMatch[2];
      const body = await request.json().catch(() => ({}));
      try {
        if (action === 'mobile-sign') {
          const user = await getAuthUser(request, env, cfg);
          if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
          const out = await signRequestByMobile(d1Adapter, {
            requestId: reqId,
            user,
            signature: body?.signature || '',
            decryptEmbeddedPrivateKey: async (u) =>
              decryptWalletPrivateKey(u.encrypted_wallet_json, cfg.walletEncryptionKey),
            pinSculptureFn: makeWorkerPinHook(),
            mintSculptureFn: makeWorkerMintHook(),
            emitMetadataUpdateFn: makeWorkerMetadataUpdateHook()
          });
          return jsonResponse(out, 200, request);
        }
        if (action === 'agent-sign') {
          const out = await signRequestByAgent(d1Adapter, {
            requestId: reqId,
            pairingCode: extractPairingCode(request, body),
            signature: body?.signature || '',
            txHash: body?.txHash || '',
            agentName: body?.agentName || '',
            pinSculptureFn: makeWorkerPinHook(),
            mintSculptureFn: makeWorkerMintHook(),
            emitMetadataUpdateFn: makeWorkerMetadataUpdateHook()
          });
          return jsonResponse(out, 200, request);
        }
        const user = await getAuthUser(request, env, cfg);
        if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
        return jsonResponse(
          await rejectSignatureRequest(d1Adapter, { requestId: reqId, user }),
          200,
          request
        );
      } catch (err) {
        return jsonResponse({ error: err.message || 'Signature action failed' }, err?.statusCode || 400, request);
      }
    }

    const sigGetMatch = pathname.match(/^\/api\/signatures\/requests\/([^/]+)$/);
    if (sigGetMatch && request.method === 'GET') {
      try {
        const caller = await getAuthUser(request, env, cfg);
        const out = await getSignatureRequest(d1Adapter, {
          requestId: decodeURIComponent(sigGetMatch[1]),
          user: caller,
          pairingCode: extractPairingCode(request, {})
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Signature fetch failed' }, err?.statusCode || 400, request);
      }
    }

    // Publish Sculpture
    if (pathname === '/api/sculptures/publish' && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);

      let quotaConsumed = false;
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

        const anchorCheck = validateAnchorOffset(body?.anchorOffset || {});
        if (anchorCheck.error) {
          return jsonResponse({ error: anchorCheck.error }, 400, request);
        }

        await checkRateLimit(d1Adapter, {
          scope: 'publish',
          key: user.id,
          windowSec: 60,
          maxRequests: 30
        });

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
              error: `Proof of Location check failed (score ${locationBundle.score}/100${locationBundle.evidenceIssues?.length ? `: ${locationBundle.evidenceIssues.join('; ')}` : ''}). Enable GPS, live camera, and move your phone gently while sculpting.`,
              proofOfLocation: locationBundle
            },
            422,
            request
          );
        }

        // Only compare against previous IRL mobile PoL publishes (exclude remote MCP / owner land placements).
        const previousPublish = await env.DB.prepare(
          `SELECT lat, lng, created_at
           FROM sculptures
           WHERE creator_sub = ?
             AND pol_json NOT LIKE '%"propertyAuthorized":true%'
           ORDER BY created_at DESC
           LIMIT 1`
        )
          .bind(user.id)
          .first();
        const travel = assessTravelFeasibility(
          previousPublish
            ? { lat: previousPublish.lat, lng: previousPublish.lng, at: previousPublish.created_at }
            : null,
          { lat: locationBundle.lat, lng: locationBundle.lng }
        );
        if (!travel.ok) {
          return jsonResponse(
            {
              error: `Location jump too fast since your last publish (${Math.round(travel.distanceM / 1000)} km). Publish again from your current location later.`,
              travel
            },
            422,
            request
          );
        }

        const targetLandSettings = await getLandSettingsInternal(d1Adapter, locationBundle.parcelId);
        if (targetLandSettings.frozen) {
          return jsonResponse(
            {
              error: `Virtual Land ${locationBundle.parcelId} is frozen by its owner — no new sculptures can be placed here.`
            },
            403,
            request
          );
        }

        const qRes = await checkAndConsumeRelayerQuota(d1Adapter, {
          userId: user.id,
          isAdmin: Boolean(user.is_admin),
          dailyQuota: cfg.relayerDailyQuota
        });
        quotaConsumed = Boolean(qRes?.consumed);

        const sculptureId = crypto.randomUUID();
        const recipientAddress =
          user.custom_payout_address && ethers.isAddress(user.custom_payout_address)
            ? ethers.getAddress(user.custom_payout_address)
            : ethers.getAddress(user.wallet_address);

        let ipfsResult;
        let mintResult;
        try {
          ipfsResult = await pinSculptureBundle(
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

          mintResult = await mintOnChainOrSimulate(
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
        } catch (err) {
          if (quotaConsumed) {
            await refundRelayerQuota(d1Adapter, { userId: user.id });
            quotaConsumed = false;
          }
          await recordOpsEvent(d1Adapter, {
            category: /pinata|ipfs/i.test(err?.message || '') ? 'pinata' : 'relayer_mint',
            status: 'error',
            actorId: user.id,
            parcelId: locationBundle.parcelId,
            detail: err?.message || 'Worker publish pipeline failure'
          }).catch(() => {});
          throw err;
        }

        await recordOpsEvent(d1Adapter, {
          category: 'relayer_mint',
          status: 'ok',
          actorId: user.id,
          parcelId: locationBundle.parcelId,
          detail: `Minted ${sculptureId} (${mintResult.simulated ? 'sim' : 'live'})`
        }).catch(() => {});
        logStructured('info', 'worker_sculpture_published', {
          sculptureId,
          parcelId: locationBundle.parcelId,
          simulated: Boolean(mintResult.simulated)
        });

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

        await upsertAnchorAndRevision(d1Adapter, {
          sculptureId,
          parcelId: locationBundle.parcelId,
          revNum: 1,
          anchorOffset: anchorCheck.offset,
          erc4906TxHash: mintResult.txHash || '',
          editorUser: user,
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

        const awakening = await awakenParcelByHumanVisit(d1Adapter, {
          parcelId: locationBundle.parcelId,
          sculptureId,
          artistUser: user,
          artistAddress: recipientAddress,
          voxelCount: validation.cleanVoxels.length,
          isCustomModel: false,
          questId: body?.questId || '',
          plinthSlotId: body?.plinthSlotId || '',
          platformAddress: cfg.royaltyReceiver
        });

        if (body?.draftId) {
          await consumeDraftOnPublish(d1Adapter, { draftId: body.draftId, user });
        }

        const saved = await env.DB.prepare(`${WORKER_SCULPTURE_SELECT_SQL} WHERE s.id = ?`)
          .bind(sculptureId)
          .first();
        return jsonResponse(
          {
            sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
            mint: mintResult,
            ipfs: ipfsResult,
            awakening
          },
          201,
          request
        );
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Publish failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    // Admin operational telemetry & metrics
    if (pathname === '/api/admin/metrics' && request.method === 'GET') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      if (!user.is_admin) return jsonResponse({ error: 'Admin access required' }, 403, request);
      const report = await getOperationalHealthReport(d1Adapter, {
        chain: { network: cfg.network, contractAddress: cfg.contractAddress, liveReady: cfg.liveChainReady },
        ipfsProvider: env.PINATA_JWT ? 'pinata' : 'cloudflare-cid'
      });
      return jsonResponse(report, 200, request);
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

    // Encrypted IPFS Pinned Messages (Land Holder Updateable, Non-Spoofable Physical Parcel Unlock)
    const pinMatch = pathname.match(
      /^\/api\/sculptures\/([^/]+)\/pins\/(meta|owner-seal|batch|challenge|unlock)$/
    );
    if (pinMatch) {
      const sculptureId = decodeURIComponent(pinMatch[1]);
      const action = pinMatch[2];
      const userAgent = request.headers.get('User-Agent') || '';
      const readWorkerIpfsJson = async (cid) => {
        if (!env.IPFS_KV) return null;
        try {
          const { value } = await env.IPFS_KV.getWithMetadata(`cid:${cid}`);
          if (!value) return null;
          const bin = atob(value);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return null;
        }
      };
      const pinWorkerJson = async (obj, fileName) => {
        if (env.PINATA_JWT) {
          return pinToPinataJson(obj, fileName, env, cfg);
        }
        return pinToKv(
          new TextEncoder().encode(JSON.stringify(obj, null, 2)),
          'application/json',
          url.origin,
          env
        );
      };

      try {
        if (action === 'meta' && request.method === 'GET') {
          return jsonResponse(await getPinnedBatchMeta(d1Adapter, { sculptureId }), 200, request);
        }
        if (request.method !== 'POST') {
          return jsonResponse({ error: 'Method not allowed' }, 405, request);
        }
        const user = await getAuthUser(request, env, cfg);
        if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
        const body = await request.json().catch(() => ({}));
        let out;
        if (action === 'owner-seal') {
          out = await getOwnerPinSeal(d1Adapter, {
            sculptureId,
            user,
            readIpfsJsonFn: readWorkerIpfsJson,
            pinMasterKek: cfg.pinMasterKek
          });
        } else if (action === 'batch') {
          out = await saveEncryptedPinBatch(d1Adapter, {
            sculptureId,
            user,
            body,
            pinJsonFn: pinWorkerJson
          });
        } else if (action === 'challenge') {
          out = await issueParcelPresenceChallenge(d1Adapter, {
            sculptureId,
            user,
            body,
            userAgent
          });
        } else if (action === 'unlock') {
          out = await unlockPinnedBatchForParcelVisitor(d1Adapter, {
            sculptureId,
            user,
            body,
            userAgent,
            readIpfsJsonFn: readWorkerIpfsJson,
            pinMasterKek: cfg.pinMasterKek,
            expectedRpId: resolveWorkerRpId(request, url)
          });
        }
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Pinned IPFS message request failed' },
          err?.statusCode || 400,
          request
        );
      }
    }

    // Sculpture 3D Model / GLB Export & ERC-721 Marketplace Metadata
    const glbMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/model(?:\.glb)?$/);
    if (glbMatch && request.method === 'GET') {
      const id = decodeURIComponent(glbMatch[1]);
      const row = await env.DB.prepare('SELECT * FROM sculptures WHERE id = ?').bind(id).first();
      if (!row) return jsonResponse({ error: 'Sculpture not found' }, 404, request);
      const caller = await getAuthUser(request, env, cfg);
      if (row.hidden && !caller?.is_admin) {
        return jsonResponse({ error: 'Sculpture not available' }, 404, request);
      }
      const custom = await env.DB.prepare('SELECT * FROM sculpture_models WHERE sculpture_id = ?')
        .bind(id)
        .first();
      if (custom) {
        let modelBytes = null;
        if (custom.inline_b64) {
          modelBytes = b64ToModelBytes(custom.inline_b64);
        } else {
          const cid = custom.model_cid || row.ipfs_model_cid;
          if (cid && env.IPFS_KV) {
            const { value } = await env.IPFS_KV.getWithMetadata(`cid:${cid}`);
            if (value) modelBytes = b64ToModelBytes(value);
          }
        }
        if (modelBytes) {
          return new Response(modelBytes, {
            status: 200,
            headers: {
              'Content-Type': custom.mime_type || 'application/octet-stream',
              'Content-Disposition': `inline; filename="graffiland-${row.id}.${custom.model_format || 'glb'}"`,
              'Cache-Control': 'public, max-age=86400',
              ...corsHeaders(request)
            }
          });
        }
        if (custom.model_url) {
          return Response.redirect(custom.model_url, 302);
        }
      }
      const voxels = JSON.parse(row.voxels_json || '[]');
      const glb = buildSculptureGlb(voxels, {
        id: row.id,
        title: row.title,
        parcelId: row.parcel_id,
        geohash: row.geohash
      });
      return new Response(glb, {
        status: 200,
        headers: {
          'Content-Type': 'model/gltf-binary',
          'Content-Disposition': `inline; filename="graffiland-${row.id}.glb"`,
          'Cache-Control': 'public, max-age=86400',
          ...corsHeaders(request)
        }
      });
    }

    const metaMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/metadata\.json$/);
    if (metaMatch && request.method === 'GET') {
      const id = decodeURIComponent(metaMatch[1]);
      const row = await env.DB.prepare(`${WORKER_SCULPTURE_SELECT_SQL} WHERE s.id = ?`)
        .bind(id)
        .first();
      if (!row) return jsonResponse({ error: 'Sculpture not found' }, 404, request);
      const caller = await getAuthUser(request, env, cfg);
      if (row.hidden && !caller?.is_admin) {
        return jsonResponse({ error: 'Sculpture not available' }, 404, request);
      }
      return jsonResponse(
        formatMarketplaceTokenMetadata(row, { apiOrigin: url.origin, publicUrl: cfg.publicUrl }),
        200,
        request
      );
    }

    const transferMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/transfer$/);
    if (transferMatch && request.method === 'POST') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      const id = decodeURIComponent(transferMatch[1]);
      const body = await request.json().catch(() => ({}));
      try {
        const result = await transferSculptureNft(chatDb, {
          sculptureId: id,
          callerUser: user,
          toAddress: body?.toAddress,
          txHash: body?.txHash,
          signature: body?.signature,
          decryptEmbeddedPrivateKey: async (u) =>
            decryptWalletPrivateKey(u.encrypted_wallet_json, cfg.walletEncryptionKey),
          chainCfg: cfg
        });
        return jsonResponse(result, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Transfer failed', ...(err?.extra || {}) },
          err?.statusCode || 400,
          request
        );
      }
    }

    const syncMatch = pathname.match(/^\/api\/sculptures\/([^/]+)\/sync-ownership$/);
    if (syncMatch && request.method === 'POST') {
      const id = decodeURIComponent(syncMatch[1]);
      const caller = await getAuthUser(request, env, cfg);
      try {
        const result = await syncSculptureOwnership(chatDb, {
          sculptureId: id,
          chainCfg: cfg,
          callerUser: caller
        });
        return jsonResponse(result, 200, request);
      } catch (err) {
        return jsonResponse(
          { error: err.message || 'Ownership sync failed' },
          err?.statusCode || 400,
          request
        );
      }
    }

    // Single sculpture GET / PUT / DELETE
    const scMatch = pathname.match(/^\/api\/sculptures\/([^/]+)$/);
    if (scMatch && request.method === 'PUT') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const body = await request.json().catch(() => ({}));
        const out = await directOwnerUpdateSculpture(d1Adapter, {
          sculptureId: decodeURIComponent(scMatch[1]),
          user,
          body,
          pinSculptureFn: makeWorkerPinHook(),
          emitMetadataUpdateFn: makeWorkerMetadataUpdateHook()
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Update failed' }, err?.statusCode || 400, request);
      }
    }

    if (scMatch && request.method === 'DELETE') {
      const user = await getAuthUser(request, env, cfg);
      if (!user) return jsonResponse({ error: 'Google sign-in required' }, 401, request);
      try {
        const out = await directOwnerDeleteSculpture(d1Adapter, {
          sculptureId: decodeURIComponent(scMatch[1]),
          user
        });
        return jsonResponse(out, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || 'Delete failed' }, err?.statusCode || 400, request);
      }
    }

    if (scMatch && request.method === 'GET') {
      const id = decodeURIComponent(scMatch[1]);
      const row = await env.DB.prepare(`${WORKER_SCULPTURE_SELECT_SQL} WHERE s.id = ?`)
        .bind(id)
        .first();
      if (!row) return jsonResponse({ error: 'Sculpture not found' }, 404, request);
      const caller = await getAuthUser(request, env, cfg);
      const viewerIsLandOwner = caller
        ? await isUserLandOwner(d1Adapter, { parcelId: row.parcel_id, user: caller })
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
        return jsonResponse({ error: 'Sculpture not available' }, 404, request);
      }
      const transfers = await listSculptureTransfers(chatDb, id);
      const viewerCanContribute = caller
        ? await isUserParcelContributor(d1Adapter, { parcelId: row.parcel_id, user: caller })
        : false;
      const landSettings = await getLandSettingsInternal(d1Adapter, row.parcel_id);
      return jsonResponse(
        {
          sculpture: serializeSculptureRow(row, {
            includeAdminFields: Boolean(caller?.is_admin),
            includeVoxels: true,
            transfers,
            viewerCanContribute,
            viewerIsLandOwner,
            parcelFrozen: landSettings.frozen
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
      const storedType = String(metadata?.contentType || '').toLowerCase();
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': SAFE_GATEWAY_MIME.has(storedType) ? storedType : 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          ...corsHeaders(request)
        }
      });
    }

    return jsonResponse({ error: 'Not found' }, 404, request);
  }
};
