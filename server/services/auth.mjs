import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
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
    const email = String(devProfile.email || '').trim().toLowerCase();
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
    db.prepare(`
      UPDATE users
      SET email = ?, name = ?, picture = ?, is_admin = ?, last_login_at = ?
      WHERE id = ?
    `).run(profile.email, profile.name, profile.picture, isAdmin, now, profile.sub);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(profile.sub);
  }

  const wallet = createEncryptedWallet();
  db.prepare(`
    INSERT INTO users (
      id, email, name, picture, wallet_address, encrypted_wallet_json,
      custom_payout_address, is_admin, created_at, last_login_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(
    profile.sub,
    profile.email,
    profile.name,
    profile.picture,
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
  return {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name,
    picture: userRow.picture,
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
    return db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.sub) || null;
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
