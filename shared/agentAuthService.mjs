import { ethers } from 'ethers';
import { STEWARD_DEFAULTS } from './constants.mjs';
import { McpServiceError } from './mcp/helpers.mjs';

function b64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Signs an HS256 JWT via WebCrypto so Node and Cloudflare Workers share identical tokens.
 */
export async function signAgentJwt(payload, secret, ttlSeconds = 14 * 86400) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64UrlEncode(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64UrlEncode(sig)}`;
}

/**
 * Verifies an HS256 JWT via WebCrypto. Throws if invalid or expired.
 */
export async function verifyAgentJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const [header, body, sig] = parts;
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64UrlDecode(sig),
    new TextEncoder().encode(`${header}.${body}`)
  );
  if (!ok) throw new Error('Invalid JWT signature');
  const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(body)));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('JWT expired');
  }
  return payload;
}

export function formatAgentProfile(row, extras = {}) {
  if (!row) return null;
  const maxSlots = Number(row.max_slots ?? STEWARD_DEFAULTS.starterDormantSlots);
  const usedSlots = Number(extras.activeDormantSlots ?? row.used_slots ?? 0);
  return {
    agentId: row.agent_id,
    actorType: 'agent',
    walletAddress: row.wallet_address,
    name: row.name || 'Autonomous Steward',
    framework: row.framework || 'custom',
    description: row.description || '',
    endpointUrl: row.endpoint_url || '',
    maxSlots,
    usedSlots,
    availableSlots: Math.max(0, maxSlots - usedSlots),
    activatedLandsCount: Number(row.activated_lands_count || 0),
    totalXp: Number(row.total_xp || 0),
    reputationScore: Number(row.reputation_score ?? 100),
    status: row.status || 'active',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ...(extras.earnedRoyaltiesEth !== undefined
      ? { earnedRoyaltiesEth: Number(extras.earnedRoyaltiesEth) }
      : {}),
    ...(extras.lands ? { lands: extras.lands } : {})
  };
}

export function agentRowToUserActor(row, extras = {}) {
  return {
    id: row.agent_id,
    actorType: 'agent',
    email: `${row.wallet_lower}@agent.graffiland.local`,
    name: row.name || 'Autonomous Steward',
    picture: '',
    wallet_address: row.wallet_address,
    custom_payout_address: '',
    is_admin: 0,
    created_at: row.created_at,
    agent: formatAgentProfile(row, extras)
  };
}

/**
 * Issues a single-use EIP-191 login challenge for zero-OAuth autonomous agents.
 */
export async function issueAgentAuthChallenge(db, { walletAddress }) {
  const raw = String(walletAddress || '').trim();
  if (!raw || !ethers.isAddress(raw)) {
    throw new McpServiceError('A valid EVM walletAddress is required.', 400);
  }
  const checksum = ethers.getAddress(raw);
  const walletLower = checksum.toLowerCase();
  const nonce = `ag_${crypto.randomUUID().replace(/-/g, '')}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const message = [
    'GRAFFILAND Agent Authentication',
    `Wallet: ${checksum}`,
    `Nonce: ${nonce}`,
    `Issued At: ${createdAt}`,
    'Sign this message to register or authenticate your autonomous agent wallet.'
  ].join('\n');

  await db.run(
    `INSERT INTO agent_auth_challenges (nonce, wallet_lower, message, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [nonce, walletLower, message, createdAt, expiresAt]
  );

  return { nonce, walletAddress: checksum, message, expiresAt };
}

/**
 * Verifies EIP-191 challenge signature, upserts agent_accounts + users shadow row, and returns a Bearer JWT.
 */
export async function registerOrLoginAgentWallet(
  db,
  {
    walletAddress,
    nonce,
    signature,
    name = '',
    framework = 'custom',
    description = '',
    endpointUrl = '',
    sessionSecret
  }
) {
  const raw = String(walletAddress || '').trim();
  if (!raw || !ethers.isAddress(raw)) {
    throw new McpServiceError('Valid EVM walletAddress is required.', 400);
  }
  const checksum = ethers.getAddress(raw);
  const walletLower = checksum.toLowerCase();
  const cleanNonce = String(nonce || '').trim();
  const cleanSig = String(signature || '').trim();
  if (!cleanNonce || !cleanSig) {
    throw new McpServiceError('nonce and EIP-191 signature are required.', 400);
  }

  const challenge = await db.get('SELECT * FROM agent_auth_challenges WHERE nonce = ?', [cleanNonce]);
  if (!challenge) {
    throw new McpServiceError('Agent auth challenge not found.', 404);
  }
  if (challenge.used) {
    throw new McpServiceError('Agent auth challenge nonce has already been used.', 400);
  }
  if (Date.now() > Date.parse(challenge.expires_at)) {
    throw new McpServiceError('Agent auth challenge expired.', 400);
  }
  if (challenge.wallet_lower !== walletLower) {
    throw new McpServiceError('Challenge walletAddress mismatch.', 400);
  }

  let recovered = '';
  try {
    recovered = ethers.verifyMessage(challenge.message, cleanSig).toLowerCase();
  } catch {
    throw new McpServiceError('Invalid EIP-191 signature format.', 401);
  }
  if (recovered !== walletLower) {
    throw new McpServiceError(
      `Signature recovered ${recovered}, expected ${walletLower}.`,
      401
    );
  }

  await db.run('UPDATE agent_auth_challenges SET used = 1 WHERE nonce = ?', [cleanNonce]);

  const now = new Date().toISOString();
  const agentId = `agent:${walletLower}`;
  const cleanName = String(name || '').trim().slice(0, 64);
  const cleanFramework = String(framework || 'custom').trim().slice(0, 32) || 'custom';
  const cleanDesc = String(description || '').trim().slice(0, 240);
  const cleanEndpoint = String(endpointUrl || '').trim().slice(0, 240);

  const existing = await db.get('SELECT * FROM agent_accounts WHERE agent_id = ?', [agentId]);
  if (existing) {
    await db.run(
      `UPDATE agent_accounts
       SET wallet_address = ?,
           name = COALESCE(NULLIF(?, ''), name),
           framework = COALESCE(NULLIF(?, ''), framework),
           description = COALESCE(NULLIF(?, ''), description),
           endpoint_url = COALESCE(NULLIF(?, ''), endpoint_url),
           last_seen_at = ?
       WHERE agent_id = ?`,
      [checksum, cleanName, cleanFramework, cleanDesc, cleanEndpoint, now, agentId]
    );
  } else {
    await db.run(
      `INSERT INTO agent_accounts (
        agent_id, wallet_lower, wallet_address, name, framework, description, endpoint_url,
        max_slots, used_slots, activated_lands_count, total_xp, reputation_score, status,
        created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 100, 'active', ?, ?)`,
      [
        agentId,
        walletLower,
        checksum,
        cleanName || `Agent ${checksum.slice(2, 8)}`,
        cleanFramework,
        cleanDesc,
        cleanEndpoint,
        STEWARD_DEFAULTS.starterDormantSlots,
        now,
        now
      ]
    );
  }

  const effectiveName = cleanName || existing?.name || `Agent ${checksum.slice(2, 8)}`;
  const agentEmail = `${walletLower}@agent.graffiland.local`;
  const existingShadowUser = await db.get('SELECT * FROM users WHERE id = ?', [agentId]);
  if (!existingShadowUser) {
    await db.run(
      `INSERT INTO users (
        id, email, name, picture, wallet_address, encrypted_wallet_json,
        custom_payout_address, is_admin, created_at, last_login_at
      ) VALUES (?, ?, ?, '', ?, '{"agentManaged":true}', '', 0, ?, ?)`,
      [agentId, agentEmail, effectiveName, checksum, now, now]
    );
  } else {
    await db.run('UPDATE users SET name = ?, wallet_address = ?, last_login_at = ? WHERE id = ?', [
      effectiveName,
      checksum,
      now,
      agentId
    ]);
  }

  const saved = await db.get('SELECT * FROM agent_accounts WHERE agent_id = ?', [agentId]);
  const slotRow = await db.get(
    `SELECT COUNT(*) AS cnt FROM land_steward_state WHERE steward_sub = ? AND status = 'dormant'`,
    [agentId]
  );
  const activeDormantSlots = Number(slotRow?.cnt || 0);
  await db.run('UPDATE agent_accounts SET used_slots = ? WHERE agent_id = ?', [
    activeDormantSlots,
    agentId
  ]);
  saved.used_slots = activeDormantSlots;

  const token = await signAgentJwt(
    {
      sub: agentId,
      actorType: 'agent',
      walletAddress: checksum,
      name: saved.name
    },
    sessionSecret
  );

  return {
    token,
    agent: formatAgentProfile(saved, { activeDormantSlots }),
    user: {
      id: saved.agent_id,
      actorType: 'agent',
      email: agentEmail,
      name: saved.name,
      walletAddress: saved.wallet_address
    }
  };
}

/**
 * Resolves either an agent JWT directly into an actor object (returns null if invalid or human JWT).
 */
export async function resolveAgentFromBearerToken(db, authHeader, sessionSecret) {
  const header = String(authHeader || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try {
    const decoded = await verifyAgentJwt(token, sessionSecret);
    if (decoded?.actorType !== 'agent' || !decoded?.sub) return null;
    const agentRow = await db.get('SELECT * FROM agent_accounts WHERE agent_id = ?', [decoded.sub]);
    if (!agentRow) return null;
    const slotRow = await db.get(
      `SELECT COUNT(*) AS cnt FROM land_steward_state WHERE steward_sub = ? AND status = 'dormant'`,
      [agentRow.agent_id]
    );
    return agentRowToUserActor(agentRow, { activeDormantSlots: Number(slotRow?.cnt || 0) });
  } catch {
    return null;
  }
}

export async function getAgentProfile(db, agentIdOrWallet) {
  const raw = String(agentIdOrWallet || '').trim();
  const cleanId = /^agent:/i.test(raw)
    ? raw.toLowerCase()
    : /^0x[0-9a-fA-F]{40}$/.test(raw)
    ? `agent:${ethers.getAddress(raw).toLowerCase()}`
    : raw.toLowerCase();

  const agentRow = await db.get('SELECT * FROM agent_accounts WHERE agent_id = ?', [cleanId]);
  if (!agentRow) {
    throw new McpServiceError('Agent steward not found.', 404);
  }
  const slotRow = await db.get(
    `SELECT COUNT(*) AS cnt FROM land_steward_state WHERE steward_sub = ? AND status = 'dormant'`,
    [agentRow.agent_id]
  );
  const earnedRow = await db.get(
    `SELECT COALESCE(SUM(agent_royalties_eth), 0) AS totalRoyalties
     FROM land_steward_state WHERE steward_sub = ?`,
    [agentRow.agent_id]
  );
  const landRows = await db.all(
    `SELECT st.*, lp.center_lat, lp.center_lng, pc.custom_name
     FROM land_steward_state st
     LEFT JOIN land_parcels lp ON lp.parcel_id = st.parcel_id
     LEFT JOIN parcel_curations pc ON pc.parcel_id = st.parcel_id
     WHERE st.steward_sub = ?
     ORDER BY st.updated_at DESC`,
    [agentRow.agent_id]
  );

  return formatAgentProfile(agentRow, {
    activeDormantSlots: Number(slotRow?.cnt || 0),
    earnedRoyaltiesEth: Number(earnedRow?.totalRoyalties || 0),
    lands: (landRows || []).map((r) => ({
      parcelId: r.parcel_id,
      customName: r.custom_name || '',
      status: r.status,
      lat: r.center_lat ?? null,
      lng: r.center_lng ?? null,
      leaseExpiresAt: r.lease_expires_at || '',
      awakenedAt: r.awakened_at || '',
      humanContributorCount: Number(r.human_contributor_count || 0),
      agentRoyaltiesEth: Number(r.agent_royalties_eth || 0)
    }))
  });
}

export async function getDualLeaderboards(db, { limit = 25 } = {}) {
  const cap = Math.min(100, Math.max(1, Number(limit || 25)));
  const agentRows = await db.all(
    `SELECT a.*,
            COALESCE(SUM(CASE WHEN st.status = 'dormant' THEN 1 ELSE 0 END), 0) AS dormant_count,
            COALESCE(SUM(st.human_contributor_count), 0) AS attracted_humans,
            COALESCE(SUM(st.agent_royalties_eth), 0) AS steward_royalties_eth,
            COALESCE(SUM(st.total_tx_volume_eth), 0) AS parcel_volume_eth
     FROM agent_accounts a
     LEFT JOIN land_steward_state st ON st.steward_sub = a.agent_id
     GROUP BY a.agent_id
     ORDER BY a.total_xp DESC, a.activated_lands_count DESC, attracted_humans DESC
     LIMIT ?`,
    [cap]
  );

  const humanRows = await db.all(
    `SELECT s.creator_sub AS userId,
            MAX(s.creator_name) AS name,
            MAX(s.recipient_address) AS walletAddress,
            COUNT(*) AS sculptureCount,
            COUNT(DISTINCT s.parcel_id) AS parcelsVisited,
            COALESCE(SUM(qc.awakened_parcel), 0) AS landsAwakened,
            COALESCE(SUM(qc.xp_awarded), COUNT(*) * 100) AS totalXp
     FROM sculptures s
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     LEFT JOIN land_quest_completions qc ON qc.sculpture_id = s.id
     WHERE s.hidden = 0
       AND COALESCE(l.layer_role, 'artist_work') = 'artist_work'
       AND s.creator_sub NOT LIKE 'agent:%'
     GROUP BY s.creator_sub
     ORDER BY totalXp DESC, landsAwakened DESC, sculptureCount DESC
     LIMIT ?`,
    [cap]
  );

  return {
    aiStewards: (agentRows || []).map((r) => ({
      ...formatAgentProfile(r, {
        activeDormantSlots: Number(r.dormant_count || 0),
        earnedRoyaltiesEth: Number(r.steward_royalties_eth || 0)
      }),
      attractedHumans: Number(r.attracted_humans || 0),
      parcelVolumeEth: Number(r.parcel_volume_eth || 0)
    })),
    humanArtists: (humanRows || []).map((r) => ({
      userId: r.userId,
      name: r.name || 'Street Artist',
      walletAddress: r.walletAddress || '',
      sculptureCount: Number(r.sculptureCount || 0),
      parcelsVisited: Number(r.parcelsVisited || 0),
      landsAwakened: Number(r.landsAwakened || 0),
      totalXp: Number(r.totalXp || 0)
    }))
  };
}
