import { ethers } from 'ethers';
import { AREA_HALF_SPAN_METERS, POLICY } from './constants.mjs';
import { buildAgentSpec } from './agentService.mjs';
import { consumeDraftOnPublish } from './draftService.mjs';
import { sanitizeVoxels, validatePublishPayload } from '../server/services/moderation.mjs';
import { decodeGeohashBounds, encodeGeohash, verifyAndEnrichLocation } from '../server/services/pol.mjs';
import { computeVerticalBounds, serializeSculptureRow } from './sculpture.mjs';
import {
  buildAgentSignPublishPrompt,
  buildLandActivityMessage,
  buildPairingHandshakeMessage,
  buildPropertyOwnerPrompt,
  buildPublishOnBehalfMessage,
  generateRandomNonceHex,
  generateRobustPairingCode,
  isValidPairingCodeFormat,
  normalizePairingCode
} from './landSignatureMessage.mjs';

export class McpServiceError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export function resolvePreferredOwnerWallet(user) {
  if (user?.custom_payout_address && ethers.isAddress(user.custom_payout_address)) {
    return ethers.getAddress(user.custom_payout_address);
  }
  if (user?.wallet_address && ethers.isAddress(user.wallet_address)) {
    return ethers.getAddress(user.wallet_address);
  }
  return '';
}

export function resolveUserWalletAddresses(user) {
  const out = [];
  for (const raw of [user?.wallet_address, user?.custom_payout_address]) {
    if (raw && ethers.isAddress(raw)) {
      const addr = ethers.getAddress(raw).toLowerCase();
      if (!out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

function hashPayloadCanonical(obj) {
  const json = JSON.stringify(obj || {});
  return ethers.keccak256(ethers.toUtf8Bytes(json));
}

function normalizeParcelId(raw) {
  return String(raw || '').trim().toUpperCase();
}

function validateEditableTitleAndDescription({ title, description }) {
  const errors = [];
  const cleanTitle = String(title || '').trim().replace(/[\r\n]+/g, ' ');
  const cleanDesc = String(description || '').trim();

  if (cleanTitle.length < POLICY.titleMin || cleanTitle.length > POLICY.titleMax) {
    errors.push(`Title must be between ${POLICY.titleMin} and ${POLICY.titleMax} characters.`);
  }
  const words = cleanDesc ? cleanDesc.split(/\s+/).filter(Boolean) : [];
  if (cleanDesc.length < POLICY.descriptionMin || cleanDesc.length > POLICY.descriptionMax) {
    errors.push(
      `Description must be between ${POLICY.descriptionMin} and ${POLICY.descriptionMax} characters.`
    );
  }
  if (words.length > POLICY.descriptionMaxWords) {
    errors.push(`Description cannot exceed ${POLICY.descriptionMaxWords} words.`);
  }
  const combined = `${cleanTitle} ${cleanDesc}`.toLowerCase();
  for (const term of POLICY.prohibitedTerms) {
    if (combined.includes(term)) {
      errors.push(`Content violates Limited Terms Policy (restricted phrase: "${term}").`);
      break;
    }
  }
  if (errors.length > 0) {
    throw new McpServiceError(errors[0], 400, { errors });
  }
  return { title: cleanTitle, description: cleanDesc };
}

export async function checkSculptureOwnership(db, { sculptureId, user = null, signerAddress = '' }) {
  const row = await db.get('SELECT * FROM sculptures WHERE id = ?', [String(sculptureId || '')]);
  if (!row || row.hidden) {
    throw new McpServiceError('Sculpture not found.', 404);
  }
  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }
  const currentOwner = String(row.recipient_address || '').toLowerCase();
  if (!currentOwner || !allowed.has(currentOwner)) {
    throw new McpServiceError(
      `Only the property owner (${row.recipient_address}) can edit this sculpture.`,
      403
    );
  }
  return row;
}

export async function checkParcelOwnership(db, { parcelId, user = null, signerAddress = '' }) {
  const cleanParcelId = normalizeParcelId(parcelId);
  if (!cleanParcelId) {
    throw new McpServiceError('Virtual Land parcelId is required.', 400);
  }
  const parcelRow = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcelId]);
  const visibleRows = await db.all(
    'SELECT * FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC',
    [cleanParcelId]
  );

  if (!parcelRow && (!visibleRows || visibleRows.length === 0)) {
    throw new McpServiceError(
      `Virtual Land parcel ${cleanParcelId} was not found. Publish a sculpture here first to claim it.`,
      404
    );
  }

  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }

  const ownsVisibleSculpture = (visibleRows || []).some((s) =>
    allowed.has(String(s.recipient_address || '').toLowerCase())
  );
  const ownsParcelFallback =
    visibleRows.length === 0 &&
    parcelRow &&
    (allowed.has(String(parcelRow.latest_claimant_address || '').toLowerCase()) ||
      (user?.id && parcelRow.first_claimant_sub === user.id));

  if (!ownsVisibleSculpture && !ownsParcelFallback) {
    throw new McpServiceError(
      `You do not hold property ownership on Virtual Land ${cleanParcelId}.`,
      403
    );
  }

  const geohash =
    parcelRow?.geohash ||
    visibleRows[0]?.geohash ||
    cleanParcelId.replace(/^GLAND-/, '').toLowerCase();
  const bounds = decodeGeohashBounds(geohash);

  return {
    parcelId: cleanParcelId,
    geohash,
    bounds,
    parcelRow: parcelRow || {
      parcel_id: cleanParcelId,
      geohash,
      center_lat: bounds.center[0],
      center_lng: bounds.center[1],
      first_claimant_sub: user?.id || visibleRows[0]?.creator_sub || '',
      first_claimant_address: visibleRows[0]?.recipient_address || '',
      latest_claimant_address: visibleRows[0]?.recipient_address || ''
    },
    visibleRows: visibleRows || []
  };
}

function formatPairingRow(row) {
  if (!row) return null;
  const expired = new Date(row.expires_at).getTime() < Date.now();
  const effectiveStatus = expired && row.status !== 'disconnected' ? 'expired' : row.status;
  return {
    code: row.code,
    ownerSub: row.owner_sub,
    ownerAddress: row.owner_address,
    status: effectiveStatus,
    agentName: row.agent_name || '',
    agentAddress: row.agent_address || '',
    keyConnected: Boolean(row.key_connected),
    challengeNonce: row.challenge_nonce,
    connectedAt: row.connected_at || '',
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

export async function createMcpPairing(db, { user, expiresHours = 24, apiOrigin = '' }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const ownerAddress = resolvePreferredOwnerWallet(user);
  if (!ownerAddress) {
    throw new McpServiceError('User wallet address unavailable.', 400);
  }
  const code = generateRobustPairingCode();
  const challengeNonce = generateRandomNonceHex(16);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresHours * 3600 * 1000).toISOString();

  await db.run(
    `INSERT INTO mcp_pairings (
      code, owner_sub, owner_address, status, agent_name, agent_address,
      key_connected, challenge_nonce, connected_at, last_active_at, created_at, expires_at
    ) VALUES (?, ?, ?, 'pending', '', '', 0, ?, '', ?, ?, ?)`,
    [code, user.id, ownerAddress, challengeNonce, createdAt, createdAt, expiresAt]
  );

  const row = await db.get('SELECT * FROM mcp_pairings WHERE code = ?', [code]);
  const pairing = formatPairingRow(row);
  return {
    pairing,
    handshakeMessage: buildPairingHandshakeMessage({
      pairingCode: code,
      ownerAddress,
      nonce: challengeNonce
    }),
    ownerPrompt: buildPropertyOwnerPrompt({
      apiOrigin,
      pairingCode: code,
      ownerAddress
    })
  };
}

export async function listMcpPairings(db, { user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const rows = await db.all(
    'SELECT * FROM mcp_pairings WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 15',
    [user.id]
  );
  const pairings = (rows || []).map(formatPairingRow);
  const activePairing = pairings.find((p) => p.status === 'connected') || null;
  return {
    mcpActive: Boolean(activePairing),
    activePairing,
    pairings
  };
}

export async function connectMcpPairing(
  db,
  { pairingCode, agentName = '', agentAddress = '', signature = '', callerUser = null, apiOrigin = '' }
) {
  const norm = normalizePairingCode(pairingCode);
  if (!isValidPairingCodeFormat(norm)) {
    throw new McpServiceError(
      'Invalid robust pairing code format (expected GLP-XXXX-XXXX-XXXX-XXXX).',
      400
    );
  }
  const row = await db.get('SELECT * FROM mcp_pairings WHERE code = ?', [norm]);
  if (!row) {
    throw new McpServiceError('Pairing code not found.', 404);
  }
  if (row.status === 'disconnected') {
    throw new McpServiceError('Pairing code was disconnected; generate a fresh code.', 403);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new McpServiceError('Pairing code has expired.', 410);
  }
  if (callerUser && callerUser.id !== row.owner_sub) {
    throw new McpServiceError('This pairing code belongs to a different account.', 403);
  }

  const ownerUser = await db.get('SELECT * FROM users WHERE id = ?', [row.owner_sub]);
  if (!ownerUser) {
    throw new McpServiceError('Owner account no longer exists.', 404);
  }

  let keyConnected = Number(row.key_connected || 0);
  let cleanAgentAddress = '';

  if (signature) {
    const handshakeMessage = buildPairingHandshakeMessage({
      pairingCode: norm,
      ownerAddress: row.owner_address,
      nonce: row.challenge_nonce
    });
    let recovered;
    try {
      recovered = ethers.getAddress(ethers.verifyMessage(handshakeMessage, signature));
    } catch {
      throw new McpServiceError('Invalid pairing handshake wallet signature.', 401);
    }
    const ownerWallets = resolveUserWalletAddresses(ownerUser);
    if (!ownerWallets.includes(recovered.toLowerCase())) {
      throw new McpServiceError(
        `Handshake signer ${recovered} does not match property owner wallet (${row.owner_address}).`,
        403
      );
    }
    keyConnected = 1;
    cleanAgentAddress = recovered;
  } else if (agentAddress) {
    if (!ethers.isAddress(agentAddress)) {
      throw new McpServiceError('Invalid agentAddress EVM format.', 400);
    }
    cleanAgentAddress = ethers.getAddress(agentAddress);
  }

  const cleanName = String(agentName || row.agent_name || 'paired-agent').trim().slice(0, 64);
  const now = new Date().toISOString();

  await db.run(
    `UPDATE mcp_pairings
     SET status = 'connected',
         agent_name = ?,
         agent_address = CASE WHEN ? != '' THEN ? ELSE agent_address END,
         key_connected = ?,
         connected_at = CASE WHEN connected_at = '' THEN ? ELSE connected_at END,
         last_active_at = ?
     WHERE code = ?`,
    [cleanName, cleanAgentAddress, cleanAgentAddress, keyConnected, now, now, norm]
  );

  const updated = await db.get('SELECT * FROM mcp_pairings WHERE code = ?', [norm]);
  const pairing = formatPairingRow(updated);
  return {
    ok: true,
    mcpActive: true,
    pairing,
    handshakeMessage: buildPairingHandshakeMessage({
      pairingCode: norm,
      ownerAddress: pairing.ownerAddress,
      nonce: pairing.challengeNonce
    }),
    mcpEndpoint: `${String(apiOrigin || '').replace(/\/$/, '')}/api/mcp`
  };
}

export async function disconnectMcpPairing(db, { pairingCode, user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const norm = normalizePairingCode(pairingCode);
  const row = await db.get('SELECT * FROM mcp_pairings WHERE code = ?', [norm]);
  if (!row) throw new McpServiceError('Pairing code not found.', 404);
  if (row.owner_sub !== user.id) {
    throw new McpServiceError('You do not own this pairing code.', 403);
  }
  const now = new Date().toISOString();
  await db.run(
    `UPDATE mcp_pairings SET status = 'disconnected', last_active_at = ? WHERE code = ?`,
    [now, norm]
  );
  const updated = await db.get('SELECT * FROM mcp_pairings WHERE code = ?', [norm]);
  return { ok: true, mcpActive: false, pairing: formatPairingRow(updated) };
}

export async function requireActiveMcpPairing(db, { pairingCode, callerUser = null }) {
  const norm = normalizePairingCode(pairingCode);
  if (!norm || !isValidPairingCodeFormat(norm)) {
    throw new McpServiceError(
      'MCP service is inactive for this user until a valid robust pairing code (GLP-...) is connected.',
      403,
      { reason: 'MCP_PAIRING_REQUIRED' }
    );
  }
  const row = await db.get('SELECT * FROM mcp_pairings WHERE code = ?', [norm]);
  if (!row) {
    throw new McpServiceError('MCP service is inactive: pairing code not found.', 403, {
      reason: 'MCP_PAIRING_NOT_FOUND'
    });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new McpServiceError('MCP service is inactive: pairing code expired.', 403, {
      reason: 'MCP_PAIRING_EXPIRED'
    });
  }
  if (row.status !== 'connected') {
    throw new McpServiceError(
      'MCP service is inactive for this user until the pairing code is connected.',
      403,
      { reason: 'MCP_PAIRING_NOT_CONNECTED', status: row.status }
    );
  }
  if (callerUser && callerUser.id !== row.owner_sub) {
    throw new McpServiceError('Pairing code does not match the authenticated user.', 403);
  }

  const ownerUser = await db.get('SELECT * FROM users WHERE id = ?', [row.owner_sub]);
  if (!ownerUser) {
    throw new McpServiceError('Paired owner account not found.', 404);
  }

  await db.run('UPDATE mcp_pairings SET last_active_at = ? WHERE code = ?', [
    new Date().toISOString(),
    norm
  ]);

  return { pairing: formatPairingRow(row), pairingRow: row, ownerUser };
}

export async function listLandsWithCurations(db) {
  const rows = await db.all(
    `SELECT
      parcel_id,
      geohash,
      COUNT(*) AS visible_count,
      MAX(created_at) AS latest_at,
      MIN(created_at) AS first_at
     FROM sculptures
     WHERE hidden = 0
     GROUP BY parcel_id, geohash
     ORDER BY visible_count DESC, latest_at DESC`
  );

  const curations = await db.all('SELECT * FROM parcel_curations');
  const curationMap = new Map((curations || []).map((c) => [c.parcel_id, c]));

  const parcels = [];
  for (const row of rows || []) {
    const bounds = decodeGeohashBounds(row.geohash);
    const first = await db.get(
      'SELECT recipient_address, creator_name, creator_sub FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 1',
      [row.parcel_id]
    );
    const cur = curationMap.get(row.parcel_id);
    parcels.push({
      parcelId: row.parcel_id,
      geohash: row.geohash,
      bounds,
      centerLat: bounds.center[0],
      centerLng: bounds.center[1],
      sculptureCount: row.visible_count,
      firstClaimantAddress: first?.recipient_address || '',
      firstClaimantName: first?.creator_name || '',
      ownerSub: first?.creator_sub || '',
      customName: cur?.custom_name || '',
      curationNote: cur?.curation_note || '',
      featuredSculptureId: cur?.featured_sculpture_id || '',
      lastSignedTxHash: cur?.last_signed_tx_hash || '',
      latestAt: row.latest_at
    });
  }
  return parcels;
}

async function listOwnerLandsAndSculptures(db, ownerUser) {
  const wallets = new Set(resolveUserWalletAddresses(ownerUser));
  const allRows = await db.all(
    'SELECT * FROM sculptures WHERE hidden = 0 ORDER BY created_at DESC'
  );
  const ownedSculptures = (allRows || []).filter((r) =>
    wallets.has(String(r.recipient_address || '').toLowerCase())
  );
  const ownedParcelSet = new Set(ownedSculptures.map((s) => s.parcel_id));
  const curations = await db.all('SELECT * FROM parcel_curations');
  const curationMap = new Map((curations || []).map((c) => [c.parcel_id, c]));

  const parcels = Array.from(ownedParcelSet).map((pid) => {
    const onLand = (allRows || []).filter((s) => s.parcel_id === pid);
    const cur = curationMap.get(pid);
    return {
      parcelId: pid,
      geohash: onLand[0]?.geohash || '',
      bounds: onLand[0]?.geohash ? decodeGeohashBounds(onLand[0].geohash) : null,
      customName: cur?.custom_name || '',
      curationNote: cur?.curation_note || '',
      featuredSculptureId: cur?.featured_sculpture_id || '',
      sculptureCount: onLand.length,
      sculptures: onLand.map((r) => serializeSculptureRow(r, { includeVoxels: true }))
    };
  });

  return {
    ownerAddress: resolvePreferredOwnerWallet(ownerUser),
    parcelCount: parcels.length,
    sculptureCount: ownedSculptures.length,
    parcels
  };
}

async function applyUpdateSculpture(db, { sculptureRow, payload, pinSculptureFn }) {
  const nextTitle = payload.title !== undefined ? payload.title : sculptureRow.title;
  const nextDescription =
    payload.description !== undefined ? payload.description : sculptureRow.description;
  const { title, description } = validateEditableTitleAndDescription({
    title: nextTitle,
    description: nextDescription
  });

  let cleanVoxels = JSON.parse(sculptureRow.voxels_json || '[]');
  if (payload.voxels !== undefined) {
    const voxelCheck = sanitizeVoxels(payload.voxels);
    if (voxelCheck.errors.length > 0) {
      throw new McpServiceError(voxelCheck.errors[0], 400, { errors: voxelCheck.errors });
    }
    cleanVoxels = voxelCheck.cleanVoxels;
  }

  let ipfsMetadataCid = sculptureRow.ipfs_metadata_cid;
  let ipfsModelCid = sculptureRow.ipfs_model_cid;
  let ipfsImageCid = sculptureRow.ipfs_image_cid;
  let ipfsGatewayUrl = sculptureRow.ipfs_gateway_url;
  const nextPreview =
    typeof payload.previewDataUrl === 'string' && payload.previewDataUrl
      ? payload.previewDataUrl.slice(0, 450000)
      : sculptureRow.preview_data_url;

  if (typeof pinSculptureFn === 'function') {
    const existingPol = JSON.parse(sculptureRow.pol_json || '{}');
    const verticalBounds = computeVerticalBounds(cleanVoxels);
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
      previewDataUrl: nextPreview,
      locationBundle,
      creatorAddress: sculptureRow.recipient_address
    });
    ipfsMetadataCid = ipfsRes.metadataCid;
    ipfsModelCid = ipfsRes.modelCid;
    ipfsImageCid = ipfsRes.imageCid;
    ipfsGatewayUrl = ipfsRes.gatewayUrl;
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

  const updated = await db.get('SELECT * FROM sculptures WHERE id = ?', [sculptureRow.id]);
  return {
    sculpture: serializeSculptureRow(updated, { includeVoxels: true })
  };
}

async function applyCreateSculptureOnLand(
  db,
  { parcelCtx, ownerUser, ownerAddress, payload, pinSculptureFn, mintSculptureFn, proofSeed = '' }
) {
  const validation = validatePublishPayload({
    title: payload.title,
    description: payload.description,
    termsAccepted: true,
    voxels: payload.voxels
  });
  if (!validation.ok) {
    throw new McpServiceError(validation.errors[0], 400, { errors: validation.errors });
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
  const verticalBounds = computeVerticalBounds(validation.cleanVoxels);
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
      sensors: seedPol?.sensors || { opticalFlowCorrelation: 1, horizonLuminance: 128, visualDHash: '' }
    },
    proofHash
  };

  const ipfsResult = await pinSculptureFn({
    sculptureId,
    title: validation.title,
    description: validation.description,
    voxels: validation.cleanVoxels,
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
      validation.title,
      validation.description,
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
      JSON.stringify(validation.cleanVoxels),
      validation.cleanVoxels.length,
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

  await db.run(
    `UPDATE land_parcels
     SET latest_claimant_address = ?, sculpture_count = sculpture_count + 1, updated_at = ?
     WHERE parcel_id = ?`,
    [ownerAddress, now, parcelCtx.parcelId]
  );

  const saved = await db.get('SELECT * FROM sculptures WHERE id = ?', [sculptureId]);
  return {
    sculpture: serializeSculptureRow(saved, { includeVoxels: true }),
    mint: mintResult,
    ipfs: ipfsResult
  };
}

async function applyDeleteSculpture(db, { sculptureRow, ownerAddress }) {
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

async function applyUpdateParcel(db, { parcelCtx, ownerUser, ownerAddress, payload, txHash = '' }) {
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

async function applyPublishOnBehalf(
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

function formatSignatureRequestRow(row) {
  if (!row) return null;
  const expired = new Date(row.expires_at).getTime() < Date.now();
  return {
    id: row.id,
    pairingCode: row.pairing_code || '',
    ownerSub: row.owner_sub,
    ownerAddress: row.owner_address,
    action: row.action,
    parcelId: row.parcel_id,
    sculptureId: row.sculpture_id || '',
    payload: JSON.parse(row.payload_json || '{}'),
    payloadHash: row.payload_hash,
    canonicalMessage: row.canonical_message,
    nonce: row.nonce,
    requestedBy: row.requested_by,
    agentName: row.agent_name || '',
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

async function enqueueSignatureRequest(
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
    agentName = ''
  }
) {
  const requestId = customRequestId ? String(customRequestId).trim().slice(0, 96) : `sigreq_${globalThis.crypto.randomUUID()}`;
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
      JSON.stringify(payload),
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

async function executeValidatedSignatureRow(
  db,
  { reqRow, ownerUser, signedBy, signerAddress, signature = '', txHash = '', pinSculptureFn, mintSculptureFn }
) {
  const payload = JSON.parse(reqRow.payload_json || '{}');
  let result;

  if (reqRow.action === 'create_sculpture') {
    const parcelCtx = await checkParcelOwnership(db, {
      parcelId: reqRow.parcel_id,
      user: ownerUser,
      signerAddress
    });
    result = await applyCreateSculptureOnLand(db, {
      parcelCtx,
      ownerUser,
      ownerAddress: reqRow.owner_address,
      payload,
      pinSculptureFn,
      mintSculptureFn,
      proofSeed: reqRow.id
    });
  } else if (reqRow.action === 'update_sculpture') {
    const sculptureRow = await checkSculptureOwnership(db, {
      sculptureId: reqRow.sculpture_id,
      user: ownerUser,
      signerAddress
    });
    result = await applyUpdateSculpture(db, { sculptureRow, payload, pinSculptureFn });
  } else if (reqRow.action === 'delete_sculpture') {
    const sculptureRow = await checkSculptureOwnership(db, {
      sculptureId: reqRow.sculpture_id,
      user: ownerUser,
      signerAddress
    });
    result = await applyDeleteSculpture(db, {
      sculptureRow,
      ownerAddress: reqRow.owner_address
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
  } else if (reqRow.action === 'publish_sculpture') {
    result = await applyPublishOnBehalf(db, {
      ownerUser,
      ownerAddress: reqRow.owner_address,
      payload,
      pinSculptureFn,
      mintSculptureFn,
      proofSignature: signature
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
  await db.run(
    `UPDATE land_signature_requests
     SET status = 'executed',
         signed_by = ?,
         signer_address = ?,
         signature = ?,
         tx_hash = ?,
         result_json = ?,
         updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [
      signedBy,
      signerAddress,
      signature,
      finalTxHash,
      JSON.stringify(result),
      now,
      reqRow.id
    ]
  );

  const updatedRow = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [reqRow.id]);
  return {
    ok: true,
    request: formatSignatureRequestRow(updatedRow),
    result
  };
}

export async function createPublishSignatureRequestForMobile(
  db,
  { user, body, pairingCode = '', isMobileRequest = false, apiOrigin = '' }
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

  const ownerAddress = resolvePreferredOwnerWallet(user);
  const reqObj = await enqueueSignatureRequest(db, {
    pairingCode: cleanPairingCode,
    ownerUser: user,
    ownerAddress,
    action: 'publish_sculpture',
    parcelId: locationBundle.parcelId,
    payload: {
      title: validation.title,
      description: validation.description,
      cleanVoxels: validation.cleanVoxels,
      previewDataUrl: String(body?.previewDataUrl || '').slice(0, 450000),
      draftId: body?.draftId || '',
      locationBundle
    },
    requestedBy: 'mobile',
    agentName: 'mobile-delegated-publish'
  });

  return {
    request: reqObj,
    promptText: buildAgentSignPublishPrompt({
      apiOrigin,
      pairingCode: cleanPairingCode,
      requestId: reqObj.id,
      parcelId: locationBundle.parcelId,
      title: validation.title,
      ownerAddress,
      canonicalMessage: reqObj.canonicalMessage
    })
  };
}

export async function listPendingSignaturesForUser(db, { user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const rows = await db.all(
    `SELECT * FROM land_signature_requests
     WHERE owner_sub = ? AND status = 'pending'
     ORDER BY created_at DESC LIMIT 25`,
    [user.id]
  );
  return {
    requests: (rows || [])
      .map(formatSignatureRequestRow)
      .filter((r) => r.status === 'pending')
  };
}

export async function getSignatureRequest(db, { requestId, user = null, pairingCode = '' }) {
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
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

export async function signRequestByMobile(
  db,
  { requestId, user, signature = '', decryptEmbeddedPrivateKey, pinSculptureFn, mintSculptureFn }
) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  if (row.owner_sub !== user.id) {
    throw new McpServiceError('Only the property owner can sign this request.', 403);
  }
  if (row.status !== 'pending') {
    throw new McpServiceError(`Signature request is already ${row.status}.`, 409);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new McpServiceError('Signature request has expired.', 410);
  }

  let finalSig = String(signature || '').trim();
  let signerAddress = '';

  if (finalSig) {
    let recovered;
    try {
      recovered = ethers.getAddress(ethers.verifyMessage(row.canonical_message, finalSig));
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
    finalSig = await wallet.signMessage(row.canonical_message);
    signerAddress = ethers.getAddress(wallet.address);
  }

  return executeValidatedSignatureRow(db, {
    reqRow: row,
    ownerUser: user,
    signedBy: 'mobile-wallet',
    signerAddress,
    signature: finalSig,
    pinSculptureFn,
    mintSculptureFn
  });
}

export async function signRequestByAgent(
  db,
  { requestId, pairingCode, signature, txHash = '', agentName = '', pinSculptureFn, mintSculptureFn }
) {
  const { pairing, ownerUser } = await requireActiveMcpPairing(db, { pairingCode });
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  if (row.owner_sub !== ownerUser.id) {
    throw new McpServiceError('Signature request does not belong to paired account.', 403);
  }
  if (row.status !== 'pending') {
    throw new McpServiceError(`Signature request is already ${row.status}.`, 409);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new McpServiceError('Signature request has expired.', 410);
  }
  if (!signature) {
    throw new McpServiceError(
      'Cryptographic owner EIP-191 signature is required when signing from the agent side.',
      400
    );
  }

  let recovered;
  try {
    recovered = ethers.getAddress(ethers.verifyMessage(row.canonical_message, signature));
  } catch {
    throw new McpServiceError('Invalid agent EIP-191 signature.', 401);
  }

  const allowed = resolveUserWalletAddresses(ownerUser);
  if (!allowed.includes(recovered.toLowerCase())) {
    throw new McpServiceError(
      `Agent signature belongs to ${recovered}, which does not match owner wallet(s).`,
      403
    );
  }

  await db.run(
    `UPDATE mcp_pairings SET key_connected = 1, agent_address = ?, last_active_at = ? WHERE code = ?`,
    [recovered, new Date().toISOString(), pairing.code]
  );

  return executeValidatedSignatureRow(db, {
    reqRow: row,
    ownerUser,
    signedBy: 'agent-key',
    signerAddress: recovered,
    signature,
    txHash: String(txHash || '').trim(),
    pinSculptureFn,
    mintSculptureFn
  });
}

export async function rejectSignatureRequest(db, { requestId, user }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  if (!row) throw new McpServiceError('Signature request not found.', 404);
  if (row.owner_sub !== user.id) {
    throw new McpServiceError('Only the property owner can reject this request.', 403);
  }
  if (row.status !== 'pending') {
    throw new McpServiceError(`Signature request is already ${row.status}.`, 409);
  }
  await db.run(
    `UPDATE land_signature_requests SET status = 'rejected', updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), requestId]
  );
  const updated = await db.get('SELECT * FROM land_signature_requests WHERE id = ?', [requestId]);
  return { ok: true, request: formatSignatureRequestRow(updated) };
}

export async function directOwnerUpdateSculpture(db, { sculptureId, user, body, pinSculptureFn }) {
  if (!user) throw new McpServiceError('Google sign-in required.', 401);
  const row = await checkSculptureOwnership(db, { sculptureId, user });
  return applyUpdateSculpture(db, { sculptureRow: row, payload: body || {}, pinSculptureFn });
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

async function handlePairedLandMutationViaMcp(
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
    notifyMobileFn
  }
) {
  const ownerAddress = resolvePreferredOwnerWallet(ownerUser);
  const reqObj = await enqueueSignatureRequest(db, {
    customRequestId: auth?.requestId || '',
    pairingCode: pairing.code,
    ownerUser,
    ownerAddress,
    action,
    parcelId,
    sculptureId,
    payload,
    requestedBy: 'agent',
    agentName: pairing.agentName || 'paired-mcp-agent'
  });

  if (signature || auth?.signature) {
    const suppliedSig = signature || auth.signature;
    const suppliedMsg = auth?.canonicalMessage || reqObj.canonicalMessage;
    let recovered;
    try {
      recovered = ethers.getAddress(ethers.verifyMessage(suppliedMsg, suppliedSig));
    } catch {
      throw new McpServiceError('Invalid agent EIP-191 signature.', 401);
    }
    const allowed = resolveUserWalletAddresses(ownerUser);
    if (!allowed.includes(recovered.toLowerCase())) {
      throw new McpServiceError(
        `Agent signature signer ${recovered} does not match owner wallet(s).`,
        403
      );
    }
    if (auth?.requestId && auth.nonce && auth.expiresAt) {
      const expectedDirectMsg = buildLandActivityMessage({
        requestId: String(auth.requestId),
        action,
        parcelId: normalizeParcelId(parcelId),
        sculptureId,
        ownerAddress: recovered,
        payloadHash: reqObj.payloadHash,
        nonce: String(auth.nonce),
        expiresAt: String(auth.expiresAt)
      });
      if (suppliedMsg !== expectedDirectMsg) {
        throw new McpServiceError('Signed direct message mismatch.', 400);
      }
      if (new Date(auth.expiresAt).getTime() < Date.now()) {
        throw new McpServiceError('Direct agent signature expired.', 410);
      }
    }

    await db.run(
      `UPDATE mcp_pairings SET key_connected = 1, agent_address = ?, last_active_at = ? WHERE code = ?`,
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
      mintSculptureFn
    });
    return {
      status: 'executed',
      signedBy: 'agent-key',
      signerAddress: recovered,
      ...execOut
    };
  }

  await notifyMobileFn?.({
    type: 'signature_request',
    pairingCode: pairing.code,
    request: reqObj
  });

  return {
    status: 'pending_mobile_signature',
    requiresMobileSignature: true,
    message:
      'Notification sent to the paired mobile device for user signature. Or sign canonicalMessage directly with the owner private key via `sign_and_execute_pending`.',
    request: reqObj
  };
}

export const MCP_TOOLS = [
  {
    name: 'get_spec',
    description: 'Read GRAFFILAND 4x voxel resolution spec, colors, block finishes, and limits.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_my_lands',
    description: 'List all Virtual Land parcels and sculptures owned by the paired property owner.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_land',
    description: 'Inspect a Virtual Land parcel and all sculptures/curations on it.',
    inputSchema: {
      type: 'object',
      properties: { parcelId: { type: 'string' } },
      required: ['parcelId']
    }
  },
  {
    name: 'put_sculpture_on_land',
    description:
      'Place/mint a new 3D voxel sculpture on a Virtual Land parcel owned by the paired user. Executes immediately with owner key signature or sends signature notification to mobile.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        voxels: { type: 'array' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        signature: { type: 'string' }
      },
      required: ['parcelId', 'title', 'description', 'voxels']
    }
  },
  {
    name: 'update_land_sculpture',
    description:
      'Edit title, description, or voxels of an existing sculpture on the user owned land. Signs via owner private key or notifies mobile device for signature.',
    inputSchema: {
      type: 'object',
      properties: {
        sculptureId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        voxels: { type: 'array' },
        signature: { type: 'string' }
      },
      required: ['sculptureId']
    }
  },
  {
    name: 'update_land_parcel',
    description:
      'Update parcel customName, curationNote, or featuredSculptureId on an owned Virtual Land parcel.',
    inputSchema: {
      type: 'object',
      properties: {
        parcelId: { type: 'string' },
        customName: { type: 'string' },
        curationNote: { type: 'string' },
        featuredSculptureId: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['parcelId']
    }
  },
  {
    name: 'delete_land_sculpture',
    description: 'Remove an owned sculpture from the user Virtual Land parcel.',
    inputSchema: {
      type: 'object',
      properties: {
        sculptureId: { type: 'string' },
        signature: { type: 'string' }
      },
      required: ['sculptureId']
    }
  },
  {
    name: 'list_pending_signatures',
    description: 'List pending signature/publish requests awaiting signature from user mobile or agent key.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sign_and_execute_pending',
    description:
      'Sign a pending requestId with the owner private key (EIP-191 signature over canonicalMessage) from the agent side and execute the land update or publish transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        signature: { type: 'string' },
        txHash: { type: 'string' }
      },
      required: ['requestId', 'signature']
    }
  }
];

export async function handleMcpJsonRpc(
  db,
  { rpcBody, pairingCode, callerUser = null, apiOrigin = '', pinSculptureFn, mintSculptureFn, notifyMobileFn }
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
        serverInfo: {
          name: 'graffiland-mcp',
          version: '1.0.0'
        },
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
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS }
    };
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
        'SELECT * FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC',
        [parcelId]
      );
      const cur = await db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [parcelId]);
      toolResult = {
        parcelId,
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
    } else if (toolName === 'put_sculpture_on_land') {
      const parcelCtx = await checkParcelOwnership(db, {
        parcelId: args.parcelId,
        user: ownerUser
      });
      const validation = validatePublishPayload({
        title: args.title,
        description: args.description,
        termsAccepted: true,
        voxels: args.voxels
      });
      if (!validation.ok) {
        throw new McpServiceError(validation.errors[0], 400, { errors: validation.errors });
      }
      toolResult = await handlePairedLandMutationViaMcp(db, {
        pairing,
        ownerUser,
        action: 'create_sculpture',
        parcelId: parcelCtx.parcelId,
        payload: {
          title: validation.title,
          description: validation.description,
          voxels: validation.cleanVoxels,
          lat: args.lat,
          lng: args.lng,
          altitude: args.altitude,
          previewDataUrl: args.previewDataUrl
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'update_land_sculpture') {
      const scRow = await checkSculptureOwnership(db, {
        sculptureId: args.sculptureId,
        user: ownerUser
      });
      const nextTitle = args.title !== undefined ? args.title : scRow.title;
      const nextDesc = args.description !== undefined ? args.description : scRow.description;
      const checkedMeta = validateEditableTitleAndDescription({
        title: nextTitle,
        description: nextDesc
      });
      let nextVoxels;
      if (args.voxels !== undefined) {
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
          ...(nextVoxels ? { voxels: nextVoxels } : {}),
          ...(args.previewDataUrl ? { previewDataUrl: args.previewDataUrl } : {})
        },
        signature: args.signature || '',
        auth: args.auth || null,
        txHash: args.txHash || '',
        pinSculptureFn,
        mintSculptureFn,
        notifyMobileFn
      });
    } else if (toolName === 'update_land_parcel') {
      const parcelCtx = await checkParcelOwnership(db, {
        parcelId: args.parcelId,
        user: ownerUser
      });
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
      const scRow = await checkSculptureOwnership(db, {
        sculptureId: args.sculptureId,
        user: ownerUser
      });
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
        mintSculptureFn
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
