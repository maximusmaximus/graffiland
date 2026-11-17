import { ethers } from 'ethers';
import {
  buildPairingHandshakeMessage,
  buildPropertyOwnerPrompt,
  generateRandomNonceHex,
  generateRobustPairingCode,
  isValidPairingCodeFormat,
  normalizePairingCode
} from '../landSignatureMessage.mjs';
import { McpServiceError, resolvePreferredOwnerWallet, resolveUserWalletAddresses } from './helpers.mjs';

export function formatPairingRow(row) {
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
