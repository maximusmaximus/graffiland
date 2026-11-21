export class PasskeyError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export function b64UrlToUint8(b64url) {
  let b64 = String(b64url || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function uint8ToB64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Converts ASN.1 DER ECDSA signature produced by WebAuthn authenticators into raw 64-byte IEEE P1363 (r || s)
 * expected by WebCrypto `crypto.subtle.verify`.
 */
export function asn1DerToP1363(sigBytes) {
  if (sigBytes.length === 64) return sigBytes;
  if (sigBytes.length < 8 || sigBytes[0] !== 0x30) {
    throw new PasskeyError('Malformed WebAuthn ECDSA signature encoding.', 403);
  }
  let offset = 2;
  if (sigBytes[1] & 0x80) {
    offset = 2 + (sigBytes[1] & 0x7f);
  }
  if (sigBytes[offset] !== 0x02) throw new PasskeyError('Invalid ECDSA R integer.', 403);
  const rLen = sigBytes[offset + 1];
  const rStart = offset + 2;
  const rSlice = sigBytes.subarray(rStart, rStart + rLen);

  const sTag = rStart + rLen;
  if (sigBytes[sTag] !== 0x02) throw new PasskeyError('Invalid ECDSA S integer.', 403);
  const sLen = sigBytes[sTag + 1];
  const sStart = sTag + 2;
  const sSlice = sigBytes.subarray(sStart, sStart + sLen);

  const out = new Uint8Array(64);
  const rTrim = rSlice.length > 32 ? rSlice.subarray(rSlice.length - 32) : rSlice;
  const sTrim = sSlice.length > 32 ? sSlice.subarray(sSlice.length - 32) : sSlice;
  out.set(rTrim, 32 - rTrim.length);
  out.set(sTrim, 64 - sTrim.length);
  return out;
}

export async function hasRegisteredPasskey(db, userId) {
  if (!userId) return false;
  const row = await db.get('SELECT id FROM user_passkeys WHERE user_id = ? LIMIT 1', [userId]);
  return Boolean(row);
}

export async function listUserPasskeys(db, userId) {
  if (!userId) return [];
  const rows = await db.all(
    'SELECT id, credential_id, rp_id, device_label, sign_count, created_at, last_used_at FROM user_passkeys WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    credentialId: r.credential_id,
    rpId: r.rp_id,
    deviceLabel: r.device_label || 'Hardware Passkey',
    signCount: Number(r.sign_count || 0),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || ''
  }));
}

export const PASSKEY_MANAGE_MAX_SESSION_AGE_SEC = 15 * 60;

export function assertRecentSessionForPasskeyChange(
  user,
  maxAgeSec = PASSKEY_MANAGE_MAX_SESSION_AGE_SEC
) {
  const issuedAt = Number(user?.sessionIssuedAt || 0);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return;
  const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
  if (ageSec > maxAgeSec) {
    throw new PasskeyError(
      'Recent Google sign-in (within 15 minutes) is required to manage hardware Passkeys. Sign out and sign back in first.',
      403,
      { code: 'REAUTH_REQUIRED' }
    );
  }
}

export async function issuePasskeyRegistrationOptions(
  user,
  { db = null, rpId = 'localhost' } = {}
) {
  if (!user?.id) throw new PasskeyError('Google sign-in required.', 401);
  assertRecentSessionForPasskeyChange(user);
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = uint8ToB64Url(challengeBytes);

  if (db) {
    const nowMs = Date.now();
    await db
      .run(
        `INSERT INTO webauthn_reg_challenges (challenge, user_id, rp_id, created_at, expires_at, used)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [
          challenge,
          user.id,
          rpId,
          new Date(nowMs).toISOString(),
          new Date(nowMs + 5 * 60 * 1000).toISOString()
        ]
      )
      .catch(() => {});
  }

  return {
    challenge,
    rp: { id: rpId, name: 'GRAFFILAND' },
    user: {
      id: uint8ToB64Url(new TextEncoder().encode(user.id)),
      name: user.email || user.id,
      displayName: user.name || user.email || 'GRAFFILAND Artist'
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60000,
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'preferred'
    },
    attestation: 'none'
  };
}

export async function verifyAndStorePasskeyRegistration(
  db,
  { user, body, rpId = '', allowedOrigins = [] }
) {
  if (!user?.id) throw new PasskeyError('Google sign-in required.', 401);
  assertRecentSessionForPasskeyChange(user);
  const credentialId = String(body?.credentialId || body?.id || '').trim();
  const publicKeySpkiB64 = String(body?.publicKeySpkiB64 || '').trim();
  const clientDataJSON = String(body?.clientDataJSON || '').trim();
  const deviceLabel = String(body?.deviceLabel || 'Hardware Device Passkey')
    .trim()
    .slice(0, 64);

  if (!credentialId || !publicKeySpkiB64 || !clientDataJSON) {
    throw new PasskeyError('credentialId, publicKeySpkiB64, and clientDataJSON are required.', 400);
  }

  let clientData;
  try {
    clientData = JSON.parse(new TextDecoder().decode(b64UrlToUint8(clientDataJSON)));
  } catch {
    throw new PasskeyError('Invalid WebAuthn clientDataJSON.', 400);
  }
  if (clientData?.type !== 'webauthn.create') {
    throw new PasskeyError('Expected WebAuthn creation ceremony.', 400);
  }
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(clientData?.origin)) {
    throw new PasskeyError(
      `Untrusted WebAuthn registration origin (${clientData?.origin || 'none'}).`,
      403
    );
  }

  // Require and atomically consume the single-use registration challenge issued by the server.
  const actualCh = String(clientData?.challenge || '').trim();
  if (!actualCh) {
    throw new PasskeyError('WebAuthn registration challenge is required.', 400);
  }
  const chRow = await db.get(
    'SELECT * FROM webauthn_reg_challenges WHERE challenge = ? AND user_id = ?',
    [actualCh, user.id]
  );
  if (!chRow || Date.now() > new Date(chRow.expires_at).getTime()) {
    throw new PasskeyError('WebAuthn registration challenge not found or expired.', 400);
  }
  const consumed = await db.run(
    'UPDATE webauthn_reg_challenges SET used = 1 WHERE challenge = ? AND user_id = ? AND used = 0',
    [actualCh, user.id]
  );
  const chChanges = Number(consumed?.changes ?? consumed?.meta?.changes ?? 0);
  if (chChanges < 1) {
    throw new PasskeyError('WebAuthn registration challenge has already been used.', 400);
  }

  try {
    await crypto.subtle.importKey(
      'spki',
      b64UrlToUint8(publicKeySpkiB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  } catch {
    throw new PasskeyError('Invalid ES256 P-256 SPKI passkey public key.', 400);
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO user_passkeys (
      id, user_id, credential_id, public_key_spki_b64, alg, sign_count, rp_id, device_label, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, -7, 0, ?, ?, ?, ?)
    ON CONFLICT(credential_id) DO UPDATE SET
      public_key_spki_b64 = excluded.public_key_spki_b64,
      device_label = excluded.device_label,
      rp_id = excluded.rp_id`,
    [id, user.id, credentialId, publicKeySpkiB64, rpId, deviceLabel, now, now]
  );

  return {
    ok: true,
    passkey: {
      id,
      credentialId,
      deviceLabel,
      rpId
    }
  };
}

export async function deleteUserPasskey(db, { userId, passkeyId, user = null }) {
  if (!userId) throw new PasskeyError('Google sign-in required.', 401);
  if (user) assertRecentSessionForPasskeyChange(user);
  const res = await db.run('DELETE FROM user_passkeys WHERE id = ? AND user_id = ?', [
    passkeyId,
    userId
  ]);
  const changes = Number(res?.changes ?? res?.meta?.changes ?? 0);
  if (changes < 1) throw new PasskeyError('Passkey not found for this account.', 404);
  return { ok: true, deletedId: passkeyId };
}

export async function verifyPasskeyAssertion(
  db,
  { user, assertion, expectedChallengeB64, expectedRpId = '', allowedOrigins = [] }
) {
  if (!user?.id) throw new PasskeyError('Authentication required.', 401);
  const credentialId = String(assertion?.credentialId || assertion?.id || '').trim();
  const clientDataJSONB64 = String(assertion?.clientDataJSON || '').trim();
  const authenticatorDataB64 = String(assertion?.authenticatorData || '').trim();
  const signatureB64 = String(assertion?.signature || '').trim();

  if (!credentialId || !clientDataJSONB64 || !authenticatorDataB64 || !signatureB64) {
    throw new PasskeyError('Hardware WebAuthn Passkey assertion is required.', 403);
  }

  const credRow = await db.get(
    'SELECT * FROM user_passkeys WHERE credential_id = ? AND user_id = ?',
    [credentialId, user.id]
  );
  if (!credRow) {
    throw new PasskeyError(
      'Registered hardware Passkey credential not found for this account.',
      403
    );
  }

  const clientDataBytes = b64UrlToUint8(clientDataJSONB64);
  let clientData;
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    throw new PasskeyError('Invalid WebAuthn assertion clientDataJSON.', 403);
  }
  if (clientData?.type !== 'webauthn.get') {
    throw new PasskeyError('Invalid WebAuthn ceremony type (expected webauthn.get).', 403);
  }
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(clientData?.origin)) {
    throw new PasskeyError(
      `Untrusted WebAuthn assertion origin (${clientData?.origin || 'none'}).`,
      403
    );
  }

  // Normalize base64url challenge comparison
  const normalizedExpected = uint8ToB64Url(b64UrlToUint8(expectedChallengeB64));
  const normalizedActual = uint8ToB64Url(b64UrlToUint8(clientData.challenge || ''));
  if (!normalizedExpected || normalizedActual !== normalizedExpected) {
    throw new PasskeyError('WebAuthn assertion challenge mismatch.', 403);
  }

  const authDataBytes = b64UrlToUint8(authenticatorDataB64);
  if (authDataBytes.length < 37) {
    throw new PasskeyError('Malformed WebAuthn authenticatorData.', 403);
  }

  // Verify User Present (UP bit = 0x01)
  const flags = authDataBytes[32];
  if ((flags & 0x01) === 0) {
    throw new PasskeyError('Hardware Passkey assertion did not assert user presence.', 403);
  }

  const rpToCheck = credRow.rp_id || expectedRpId;
  if (rpToCheck) {
    const rpDigest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpToCheck))
    );
    const actualRpHash = authDataBytes.subarray(0, 32);
    let rpMatch = true;
    for (let i = 0; i < 32; i += 1) {
      if (rpDigest[i] !== actualRpHash[i]) {
        rpMatch = false;
        break;
      }
    }
    if (!rpMatch) {
      throw new PasskeyError('WebAuthn RP ID hash mismatch.', 403);
    }
  }

  const signCount = new DataView(authDataBytes.buffer, authDataBytes.byteOffset + 33, 4).getUint32(
    0,
    false
  );
  if (
    Number(credRow.sign_count || 0) > 0 &&
    signCount > 0 &&
    signCount <= Number(credRow.sign_count)
  ) {
    throw new PasskeyError(
      'Hardware Passkey signCount rollback detected (cloned authenticator blocked).',
      403
    );
  }

  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
  const signedPayload = new Uint8Array(authDataBytes.length + clientHash.length);
  signedPayload.set(authDataBytes, 0);
  signedPayload.set(clientHash, authDataBytes.length);

  let verified = false;
  try {
    const pubKey = await crypto.subtle.importKey(
      'spki',
      b64UrlToUint8(credRow.public_key_spki_b64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const p1363Sig = asn1DerToP1363(b64UrlToUint8(signatureB64));
    verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      p1363Sig,
      signedPayload
    );
  } catch {
    verified = false;
  }

  if (!verified) {
    throw new PasskeyError('Invalid hardware WebAuthn Passkey ES256 signature.', 403);
  }

  await db.run('UPDATE user_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?', [
    Math.max(Number(credRow.sign_count || 0), signCount),
    new Date().toISOString(),
    credRow.id
  ]);

  return { verified: true, credentialId, signCount };
}

export async function issuePasskeyAssertionOptions(
  db,
  { user, purpose = 'wallet_export', rpId = 'localhost', ttlMs = 2 * 60 * 1000 }
) {
  if (!user?.id) throw new PasskeyError('Google sign-in required.', 401);
  if (String(user.id).startsWith('agent:') || user.actorType === 'agent') {
    throw new PasskeyError('Agent accounts do not have an embedded wallet key to export.', 403);
  }
  const passkeys = await listUserPasskeys(db, user.id);
  if (passkeys.length === 0) {
    throw new PasskeyError(
      'Register a hardware Passkey first to export your embedded wallet key.',
      403,
      { code: 'PASSKEY_REQUIRED', passkeyCount: 0 }
    );
  }
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const challenge = uint8ToB64Url(challengeBytes);
  const nowMs = Date.now();
  await db.run(
    `INSERT INTO webauthn_auth_challenges (challenge, user_id, purpose, rp_id, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [
      challenge,
      user.id,
      purpose,
      rpId,
      new Date(nowMs).toISOString(),
      new Date(nowMs + ttlMs).toISOString()
    ]
  );
  return {
    challenge,
    rpId,
    timeout: 60000,
    userVerification: 'preferred',
    allowCredentials: passkeys.map((p) => p.credentialId)
  };
}

export async function verifyAndConsumePasskeyAssertionChallenge(
  db,
  { user, challenge, assertion, purpose = 'wallet_export', expectedRpId = '', allowedOrigins = [] }
) {
  if (!user?.id) throw new PasskeyError('Google sign-in required.', 401);
  if (String(user.id).startsWith('agent:') || user.actorType === 'agent') {
    throw new PasskeyError('Agent accounts do not have an embedded wallet key to export.', 403);
  }
  const cleanChallenge = String(challenge || '').trim();
  if (!cleanChallenge) {
    throw new PasskeyError('Hardware Passkey challenge and assertion are required.', 403, {
      code: 'PASSKEY_REQUIRED'
    });
  }
  const chRow = await db.get(
    'SELECT * FROM webauthn_auth_challenges WHERE challenge = ? AND user_id = ? AND purpose = ?',
    [cleanChallenge, user.id, purpose]
  );
  if (!chRow) {
    throw new PasskeyError(
      'Passkey export challenge not found or expired. Request a new challenge and try again.',
      403
    );
  }
  if (Date.now() > new Date(chRow.expires_at).getTime()) {
    throw new PasskeyError('Passkey export challenge expired. Try again.', 403);
  }
  const consumed = await db.run(
    'UPDATE webauthn_auth_challenges SET used = 1 WHERE challenge = ? AND user_id = ? AND purpose = ? AND used = 0',
    [cleanChallenge, user.id, purpose]
  );
  const changes = Number(consumed?.changes ?? consumed?.meta?.changes ?? 0);
  if (changes < 1) {
    throw new PasskeyError('Passkey export challenge has already been used.', 403);
  }
  return verifyPasskeyAssertion(db, {
    user,
    assertion,
    expectedChallengeB64: cleanChallenge,
    expectedRpId: expectedRpId || chRow.rp_id,
    allowedOrigins
  });
}
