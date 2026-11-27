import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { formatAgentProfile } from '../../shared/agentAuthService.mjs';
import { CONFIG } from '../config.mjs';
import { getDb } from '../db.mjs';
import { createEncryptedWallet } from './wallet.mjs';

const googleClient = CONFIG.googleClientId ? new OAuth2Client(CONFIG.googleClientId) : null;

export async function verifyGoogleSignIn({ credential, devProfile }) {
  if (googleClient && credential) {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: CONFIG.googleClientId
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload?.email) {
      throw new Error('Invalid Google token payload');
    }
    return {
      sub: `google:${payload.sub}`,
      email: payload.email.toLowerCase(),
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture || ''
    };
  }

  if (CONFIG.allowDevGoogleAuth && devProfile) {
    const email = String(devProfile.email || '')
      .trim()
      .toLowerCase();
    const name = String(devProfile.name || '').trim() || email.split('@')[0] || 'Artist';
    if (!email || !email.includes('@')) {
      throw new Error('Valid email is required for Google dev sign-in');
    }
    return {
      sub: `dev-google:${email}`,
      email,
      name,
      picture: devProfile.picture || ''
    };
  }

  throw new Error('Google authentication required');
}

export function upsertGoogleUser(profile) {
  const db = getDb();
  const now = new Date().toISOString();
  const isAdmin = CONFIG.adminEmails.includes(profile.email.toLowerCase()) ? 1 : 0;

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(profile.sub);
  if (existing) {
    let userNumber = Number(existing.user_number || 0);
    if (userNumber <= 0) {
      const maxRow = db.prepare('SELECT COALESCE(MAX(user_number), 0) AS max_num FROM users').get();
      userNumber = Number(maxRow?.max_num || 0) + 1;
    }
    db.prepare(
      `
      UPDATE users
      SET email = ?, name = ?, picture = ?, user_number = ?, is_admin = ?, last_login_at = ?
      WHERE id = ?
    `
    ).run(profile.email, profile.name, profile.picture, userNumber, isAdmin, now, profile.sub);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(profile.sub);
  }

  const wallet = createEncryptedWallet();
  const maxRow = db.prepare('SELECT COALESCE(MAX(user_number), 0) AS max_num FROM users').get();
  const nextUserNumber = Number(maxRow?.max_num || 0) + 1;
  db.prepare(
    `
    INSERT INTO users (
      id, email, name, picture, user_number, wallet_address, encrypted_wallet_json,
      custom_payout_address, is_admin, created_at, last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `
  ).run(
    profile.sub,
    profile.email,
    profile.name,
    profile.picture,
    nextUserNumber,
    wallet.address,
    wallet.encryptedWalletJson,
    isAdmin,
    now,
    now
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(profile.sub);
}

export function issueSessionToken(userRow) {
  return jwt.sign(
    {
      sub: userRow.id,
      email: userRow.email,
      isAdmin: Boolean(userRow.is_admin)
    },
    CONFIG.sessionSecret,
    { expiresIn: '14d' }
  );
}

export function sanitizeUser(userRow) {
  if (!userRow) return null;
  const username = String(userRow.username || '').trim();
  const isAgent = String(userRow.id || '').startsWith('agent:');
  const avatarImage = String(userRow.avatar_image || '');
  const headerImage = String(userRow.header_image || '');
  const userNumber = Number(userRow.user_number || 0);
  return {
    id: userRow.id,
    email: userRow.email,
    name: username ? `@${username}` : isAgent ? userRow.name || 'AI Agent' : 'Creator',
    username,
    bio: String(userRow.bio || ''),
    needsUsernameOnboarding: !username && !isAgent,
    picture: avatarImage || '',
    avatarImage,
    headerImage,
    profilePublic:
      userRow.profile_public === undefined || userRow.profile_public === null
        ? true
        : Number(userRow.profile_public) !== 0,
    userNumber,
    walletAddress: userRow.wallet_address,
    customPayoutAddress: userRow.custom_payout_address || '',
    activeMintRecipient: userRow.custom_payout_address || userRow.wallet_address,
    isAdmin: Boolean(userRow.is_admin),
    createdAt: userRow.created_at
  };
}

export function getAuthUserFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, CONFIG.sessionSecret);
    const db = getDb();
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub) || null;
    if (!userRow) return null;
    if (
      userRow.custom_payout_address &&
      String(userRow.custom_payout_address).toLowerCase() !==
        String(userRow.wallet_address || '').toLowerCase()
    ) {
      let proof = null;
      try {
        proof = db
          .prepare(
            'SELECT user_id FROM payout_address_proofs WHERE user_id = ? AND LOWER(address) = ?'
          )
          .get(userRow.id, String(userRow.custom_payout_address).toLowerCase());
      } catch {
        proof = null;
      }
      if (!proof) userRow.custom_payout_address = '';
    }
    if (decoded.actorType === 'agent' || String(userRow.id).startsWith('agent:')) {
      const agentRow = db
        .prepare('SELECT * FROM agent_accounts WHERE agent_id = ?')
        .get(userRow.id);
      if (agentRow) {
        const slotRow = db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM land_steward_state WHERE steward_sub = ? AND status = 'dormant'`
          )
          .get(agentRow.agent_id);
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

export function requireAuth(req, res, next) {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Google sign-in required' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  const user = getAuthUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Google sign-in required' });
  }
  if (!user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  next();
}
