import {
  CHAT_CLUE_PROMPT_MAX,
  CHAT_MSG_MAX_CIPHERTEXT_LEN,
  ChatHttpError,
  looksMobileRequest,
  verifyCameraSightProof
} from './chatPolicy.mjs';

function sanitizePublicEcJwk(raw) {
  const jwk = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new ChatHttpError(400, 'Invalid P-256 public JWK.');
  }
  // Explicitly drop private key parameters (`d`, `key_ops`, etc.) if ever passed
  return {
    kty: 'EC',
    crv: 'P-256',
    x: String(jwk.x),
    y: String(jwk.y)
  };
}

function sanitizeFingerprint(fp) {
  const clean = String(fp || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clean)) {
    throw new ChatHttpError(400, 'Invalid public key fingerprint.');
  }
  return clean;
}

function sanitizeWrappedKeyEnvelope(raw) {
  const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (
    !env ||
    typeof env !== 'object' ||
    env.alg !== 'ECDH-P256-HKDF-SHA256-AES256GCM' ||
    !env.iv ||
    !env.ciphertext ||
    !env.ephPubJwk
  ) {
    throw new ChatHttpError(400, 'Invalid ECDH key-wrap envelope.');
  }
  return {
    alg: 'ECDH-P256-HKDF-SHA256-AES256GCM',
    iv: String(env.iv),
    ciphertext: String(env.ciphertext),
    ephPubJwk: sanitizePublicEcJwk(env.ephPubJwk)
  };
}

function sanitizeClueInput(body) {
  if (body?.clueAnswer !== undefined || body?.answer !== undefined) {
    throw new ChatHttpError(
      400,
      'Clue answers must never leave your device; wrap the room key client-side via PBKDF2.'
    );
  }
  const cluePrompt = String(body?.cluePrompt || '').trim().slice(0, CHAT_CLUE_PROMPT_MAX);
  let clueWrappedJson = '';
  if (cluePrompt) {
    const raw = body?.clueWrappedJson;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.alg !== 'PBKDF2-SHA256-AES256GCM' ||
      !parsed.iv ||
      !parsed.ciphertext
    ) {
      throw new ChatHttpError(400, 'Valid client-side PBKDF2 wrapped key blob is required with cluePrompt.');
    }
    clueWrappedJson = JSON.stringify({
      alg: 'PBKDF2-SHA256-AES256GCM',
      iterations: Number(parsed.iterations) || 210000,
      iv: String(parsed.iv),
      ciphertext: String(parsed.ciphertext)
    });
  }
  return { cluePrompt, clueWrappedJson };
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatGrantRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sculptureId: row.sculpture_id,
    keyEpoch: Number(row.key_epoch),
    requesterSub: row.requester_sub,
    requesterName: row.requester_name,
    requesterPubFp: row.requester_pub_fp,
    requesterEcdhPubJwk: JSON.parse(row.requester_ecdh_pub_jwk),
    requesterSignPubJwk: JSON.parse(row.requester_sign_pub_jwk),
    sightProof: JSON.parse(row.sight_proof_json || '{}'),
    sightScore: Number(row.sight_score),
    sightDistanceM: Number(row.sight_distance_m),
    status: row.status,
    grantorSub: row.grantor_sub || '',
    grantorEcdhPubJwk: row.grantor_ecdh_pub_jwk ? JSON.parse(row.grantor_ecdh_pub_jwk) : null,
    grantorSignPubJwk: row.grantor_sign_pub_jwk ? JSON.parse(row.grantor_sign_pub_jwk) : null,
    wrappedKeyJson: row.wrapped_key_json ? JSON.parse(row.wrapped_key_json) : null,
    grantSig: row.grant_sig || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sanitizeBoardRow(board) {
  return {
    sculptureId: board.sculpture_id,
    creatorSub: board.creator_sub,
    keyEpoch: Number(board.key_epoch),
    roomKeyCommit: board.room_key_commit,
    hasClue: Boolean(board.clue_prompt && board.clue_wrapped_json),
    cluePrompt: board.clue_prompt || '',
    clueWrappedJson: board.clue_wrapped_json ? JSON.parse(board.clue_wrapped_json) : null,
    autoGrantPol: Boolean(board.auto_grant_pol),
    createdAt: board.created_at,
    updatedAt: board.updated_at
  };
}

function formatMessageRow(row) {
  return {
    id: row.id,
    sculptureId: row.sculpture_id,
    keyEpoch: Number(row.key_epoch),
    senderSub: row.sender_sub,
    senderPubFp: row.sender_pub_fp,
    senderSignPubJwk: JSON.parse(row.sender_sign_pub_jwk),
    ivB64: row.iv_b64,
    ciphertextB64: row.ciphertext_b64,
    aadJson: row.aad_json,
    signatureB64: row.signature_b64,
    createdAt: row.created_at
  };
}

export async function initChatBoard(db, { sculptureId, user, body, userAgent = '' }) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [sculptureId]);
  if (!sculpture) throw new ChatHttpError(404, 'Sculpture not found');

  if (!looksMobileRequest(body?.deviceProfile, userAgent)) {
    throw new ChatHttpError(403, 'Initializing an AR chat board requires a mobile device.');
  }

  const existing = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (existing) {
    return { initialized: true, board: sanitizeBoardRow(existing) };
  }

  // Only the sculpture creator can initialize right after minting, OR an in-person camera viewer for legacy sculptures
  if (sculpture.creator_sub !== user.id) {
    verifyCameraSightProof({
      sightProof: body?.sightProof,
      deviceProfile: body?.deviceProfile,
      userAgent,
      sculpture
    });
  }

  const ownerEcdhPubJwk = sanitizePublicEcJwk(body?.ownerEcdhPubJwk);
  const ownerSignPubJwk = sanitizePublicEcJwk(body?.ownerSignPubJwk);
  const ownerPubFp = sanitizeFingerprint(body?.ownerPubFp);
  const selfEnvelope = sanitizeWrappedKeyEnvelope(body?.selfGrantEnvelope);
  const grantSig = String(body?.selfGrantSig || '').trim();
  const roomKeyCommit = String(body?.roomKeyCommit || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(roomKeyCommit)) {
    throw new ChatHttpError(400, 'Valid SHA-256 roomKeyCommit is required.');
  }
  if (!grantSig) {
    throw new ChatHttpError(400, 'Valid selfGrantSig ECDSA signature is required.');
  }

  const { cluePrompt, clueWrappedJson } = sanitizeClueInput(body);
  const now = new Date().toISOString();

  await db.run(
    `INSERT OR IGNORE INTO sculpture_chat_boards (
      sculpture_id, creator_sub, key_epoch, room_key_commit, clue_prompt, clue_wrapped_json,
      auto_grant_pol, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, 1, ?, ?)`,
    [sculptureId, user.id, roomKeyCommit.toLowerCase(), cluePrompt, clueWrappedJson, now, now]
  );

  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);

  // If this request created Epoch 1 cleanly, register founder's self-grant row
  if (board && board.creator_sub === user.id) {
    await db.run(
      `INSERT OR IGNORE INTO sculpture_chat_grants (
        id, sculpture_id, key_epoch, requester_sub, requester_name,
        requester_ecdh_pub_jwk, requester_sign_pub_jwk, requester_pub_fp,
        sight_proof_json, sight_score, sight_distance_m, status,
        grantor_sub, grantor_ecdh_pub_jwk, grantor_sign_pub_jwk, wrapped_key_json, grant_sig,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        sculptureId,
        Number(board.key_epoch),
        user.id,
        user.name,
        JSON.stringify(ownerEcdhPubJwk),
        JSON.stringify(ownerSignPubJwk),
        ownerPubFp,
        JSON.stringify({ selectionMethod: 'creator-init', selectedAt: now }),
        100,
        0,
        user.id,
        JSON.stringify(ownerEcdhPubJwk),
        JSON.stringify(ownerSignPubJwk),
        JSON.stringify(selfEnvelope),
        grantSig,
        now,
        now
      ]
    );
  }

  return { initialized: true, board: sanitizeBoardRow(board) };
}

export async function updateBoardClue(db, { sculptureId, user, body, userAgent = '' }) {
  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (!board) throw new ChatHttpError(404, 'Sculpture chat board not initialized');
  if (board.creator_sub !== user.id) {
    throw new ChatHttpError(403, 'Only the sculpture creator can configure the on-site clue.');
  }
  if (!looksMobileRequest(body?.deviceProfile, userAgent)) {
    throw new ChatHttpError(403, 'Clue configuration requires mobile studio access.');
  }

  const { cluePrompt, clueWrappedJson } = sanitizeClueInput(body);
  const now = new Date().toISOString();
  await db.run(
    'UPDATE sculpture_chat_boards SET clue_prompt = ?, clue_wrapped_json = ?, updated_at = ? WHERE sculpture_id = ?',
    [cluePrompt, clueWrappedJson, now, sculptureId]
  );

  const updated = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  return { board: sanitizeBoardRow(updated) };
}

export async function enterChatBoard(db, { sculptureId, user, body, userAgent = '' }) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [sculptureId]);
  const sight = verifyCameraSightProof({
    sightProof: body?.sightProof,
    deviceProfile: body?.deviceProfile,
    userAgent,
    sculpture
  });

  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (!board) {
    return {
      initialized: false,
      sight,
      board: null,
      myGrant: null,
      pendingRequestsCount: 0,
      messages: []
    };
  }

  const pubFp = body?.requesterPubFp ? sanitizeFingerprint(body.requesterPubFp) : '';
  let myGrantRow = null;
  if (pubFp) {
    myGrantRow = await db.get(
      `SELECT * FROM sculpture_chat_grants
       WHERE sculpture_id = ? AND key_epoch = ? AND requester_pub_fp = ?`,
      [sculptureId, Number(board.key_epoch), pubFp]
    );
  }
  if (!myGrantRow) {
    myGrantRow = await db.get(
      `SELECT * FROM sculpture_chat_grants
       WHERE sculpture_id = ? AND key_epoch = ? AND requester_sub = ?
       ORDER BY CASE WHEN status = 'granted' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
      [sculptureId, Number(board.key_epoch), user.id]
    );
  }

  let pendingRequestsCount = 0;
  if (myGrantRow?.status === 'granted') {
    const countRow = await db.get(
      `SELECT COUNT(*) AS c FROM sculpture_chat_grants
       WHERE sculpture_id = ? AND key_epoch = ? AND status = 'pending'`,
      [sculptureId, Number(board.key_epoch)]
    );
    pendingRequestsCount = Number(countRow?.c || 0);
  }

  const msgRows = await db.all(
    `SELECT * FROM sculpture_chat_messages
     WHERE sculpture_id = ? AND key_epoch = ?
     ORDER BY created_at ASC LIMIT 200`,
    [sculptureId, Number(board.key_epoch)]
  );

  return {
    initialized: true,
    sight,
    board: sanitizeBoardRow(board),
    myGrant: formatGrantRow(myGrantRow),
    pendingRequestsCount,
    messages: (msgRows || []).map(formatMessageRow)
  };
}

export async function requestChatGrant(db, { sculptureId, user, body, userAgent = '' }) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [sculptureId]);
  const sight = verifyCameraSightProof({
    sightProof: body?.sightProof,
    deviceProfile: body?.deviceProfile,
    userAgent,
    sculpture
  });

  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (!board) throw new ChatHttpError(404, 'Sculpture chat board is not initialized yet.');

  const ecdhPubJwk = sanitizePublicEcJwk(body?.requesterEcdhPubJwk);
  const signPubJwk = sanitizePublicEcJwk(body?.requesterSignPubJwk);
  const pubFp = sanitizeFingerprint(body?.requesterPubFp);
  const keyEpoch = Number(board.key_epoch);

  const existing = await db.get(
    `SELECT * FROM sculpture_chat_grants
     WHERE sculpture_id = ? AND key_epoch = ? AND requester_pub_fp = ?`,
    [sculptureId, keyEpoch, pubFp]
  );

  const now = new Date().toISOString();
  if (existing && existing.status === 'granted') {
    return { grant: formatGrantRow(existing), sight };
  }

  if (existing) {
    await db.run(
      `UPDATE sculpture_chat_grants
       SET sight_proof_json = ?, sight_score = ?, sight_distance_m = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(sight.proofSummary), sight.sightScore, sight.distanceMeters, now, existing.id]
    );
    const updated = await db.get('SELECT * FROM sculpture_chat_grants WHERE id = ?', [existing.id]);
    return { grant: formatGrantRow(updated), sight };
  }

  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO sculpture_chat_grants (
      id, sculpture_id, key_epoch, requester_sub, requester_name,
      requester_ecdh_pub_jwk, requester_sign_pub_jwk, requester_pub_fp,
      sight_proof_json, sight_score, sight_distance_m, status,
      grantor_sub, grantor_ecdh_pub_jwk, grantor_sign_pub_jwk, wrapped_key_json, grant_sig,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', '', '', ?, ?)`,
    [
      id,
      sculptureId,
      keyEpoch,
      user.id,
      user.name,
      JSON.stringify(ecdhPubJwk),
      JSON.stringify(signPubJwk),
      pubFp,
      JSON.stringify(sight.proofSummary),
      sight.sightScore,
      sight.distanceMeters,
      now,
      now
    ]
  );

  const created = await db.get('SELECT * FROM sculpture_chat_grants WHERE id = ?', [id]);
  return { grant: formatGrantRow(created), sight };
}

/**
 * Called by a viewer who unlocked K_room locally using the On-Site Visual Clue.
 * Verifies cryptographic possession of K_room via double-hashed proofToken
 * (without ever revealing K_room or the clue answer) before promoting the viewer
 * to an admitted member/peer grantor.
 */
export async function claimClueUnlockedGrant(db, { sculptureId, user, body, userAgent = '' }) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [sculptureId]);
  const sight = verifyCameraSightProof({
    sightProof: body?.sightProof,
    deviceProfile: body?.deviceProfile,
    userAgent,
    sculpture
  });

  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (!board) throw new ChatHttpError(404, 'Chat board not initialized');

  const proofToken = String(body?.roomProofToken || '').trim();
  if (!proofToken) throw new ChatHttpError(400, 'roomProofToken is required.');

  const digest = await sha256Hex(proofToken);
  if (digest !== board.room_key_commit) {
    throw new ChatHttpError(403, 'Room possession proof does not match board commitment.');
  }

  const ecdhPubJwk = sanitizePublicEcJwk(body?.requesterEcdhPubJwk);
  const signPubJwk = sanitizePublicEcJwk(body?.requesterSignPubJwk);
  const pubFp = sanitizeFingerprint(body?.requesterPubFp);
  const selfEnvelope = sanitizeWrappedKeyEnvelope(body?.selfGrantEnvelope);
  const grantSig = String(body?.selfGrantSig || '').trim();
  if (!grantSig) throw new ChatHttpError(400, 'selfGrantSig is required.');

  const keyEpoch = Number(board.key_epoch);
  const now = new Date().toISOString();

  const existing = await db.get(
    `SELECT * FROM sculpture_chat_grants
     WHERE sculpture_id = ? AND key_epoch = ? AND requester_pub_fp = ?`,
    [sculptureId, keyEpoch, pubFp]
  );

  if (existing) {
    await db.run(
      `UPDATE sculpture_chat_grants
       SET status = 'granted', grantor_sub = ?, grantor_ecdh_pub_jwk = ?, grantor_sign_pub_jwk = ?,
           wrapped_key_json = ?, grant_sig = ?, sight_proof_json = ?, sight_score = ?,
           sight_distance_m = ?, updated_at = ?
       WHERE id = ?`,
      [
        user.id,
        JSON.stringify(ecdhPubJwk),
        JSON.stringify(signPubJwk),
        JSON.stringify(selfEnvelope),
        grantSig,
        JSON.stringify(sight.proofSummary),
        sight.sightScore,
        sight.distanceMeters,
        now,
        existing.id
      ]
    );
    const updated = await db.get('SELECT * FROM sculpture_chat_grants WHERE id = ?', [existing.id]);
    return { grant: formatGrantRow(updated) };
  }

  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO sculpture_chat_grants (
      id, sculpture_id, key_epoch, requester_sub, requester_name,
      requester_ecdh_pub_jwk, requester_sign_pub_jwk, requester_pub_fp,
      sight_proof_json, sight_score, sight_distance_m, status,
      grantor_sub, grantor_ecdh_pub_jwk, grantor_sign_pub_jwk, wrapped_key_json, grant_sig,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sculptureId,
      keyEpoch,
      user.id,
      user.name,
      JSON.stringify(ecdhPubJwk),
      JSON.stringify(signPubJwk),
      pubFp,
      JSON.stringify(sight.proofSummary),
      sight.sightScore,
      sight.distanceMeters,
      user.id,
      JSON.stringify(ecdhPubJwk),
      JSON.stringify(signPubJwk),
      JSON.stringify(selfEnvelope),
      grantSig,
      now,
      now
    ]
  );

  const created = await db.get('SELECT * FROM sculpture_chat_grants WHERE id = ?', [id]);
  return { grant: formatGrantRow(created) };
}

export async function listPendingGrantsForGrantor(db, { user, sculptureId = null }) {
  const rows = sculptureId
    ? await db.all(
        `SELECT g.* FROM sculpture_chat_grants g
         WHERE g.sculpture_id = ? AND g.status = 'pending'
           AND EXISTS (
             SELECT 1 FROM sculpture_chat_grants m
             WHERE m.sculpture_id = g.sculpture_id
               AND m.key_epoch = g.key_epoch
               AND m.requester_sub = ?
               AND m.status = 'granted'
           )
         ORDER BY g.updated_at DESC LIMIT 30`,
        [sculptureId, user.id]
      )
    : await db.all(
        `SELECT g.* FROM sculpture_chat_grants g
         WHERE g.status = 'pending'
           AND EXISTS (
             SELECT 1 FROM sculpture_chat_grants m
             WHERE m.sculpture_id = g.sculpture_id
               AND m.key_epoch = g.key_epoch
               AND m.requester_sub = ?
               AND m.status = 'granted'
           )
         ORDER BY g.updated_at DESC LIMIT 40`,
        [user.id]
      );

  return { grants: (rows || []).map(formatGrantRow) };
}

export async function submitPeerGrant(db, { sculptureId, user, body }) {
  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (!board) throw new ChatHttpError(404, 'Sculpture chat board not found.');

  const keyEpoch = Number(board.key_epoch);
  const callerMember = await db.get(
    `SELECT * FROM sculpture_chat_grants
     WHERE sculpture_id = ? AND key_epoch = ? AND requester_sub = ? AND status = 'granted'
     LIMIT 1`,
    [sculptureId, keyEpoch, user.id]
  );
  if (!callerMember) {
    throw new ChatHttpError(403, 'Only admitted keyholders can wrap the room key for new viewers.');
  }

  const targetGrantId = String(body?.targetGrantId || '').trim();
  const target = await db.get(
    `SELECT * FROM sculpture_chat_grants
     WHERE id = ? AND sculpture_id = ? AND key_epoch = ?`,
    [targetGrantId, sculptureId, keyEpoch]
  );
  if (!target) throw new ChatHttpError(404, 'Target key request not found.');

  const wrappedKeyJson = sanitizeWrappedKeyEnvelope(body?.wrappedKeyJson);
  const grantorEcdhPubJwk = sanitizePublicEcJwk(body?.grantorEcdhPubJwk);
  const grantorSignPubJwk = sanitizePublicEcJwk(body?.grantorSignPubJwk);
  const grantSig = String(body?.grantSig || '').trim();
  if (!grantSig) throw new ChatHttpError(400, 'ECDSA grantSig is required.');

  const now = new Date().toISOString();
  await db.run(
    `UPDATE sculpture_chat_grants
     SET status = 'granted', grantor_sub = ?, grantor_ecdh_pub_jwk = ?, grantor_sign_pub_jwk = ?,
         wrapped_key_json = ?, grant_sig = ?, updated_at = ?
     WHERE id = ?`,
    [
      user.id,
      JSON.stringify(grantorEcdhPubJwk),
      JSON.stringify(grantorSignPubJwk),
      JSON.stringify(wrappedKeyJson),
      grantSig,
      now,
      targetGrantId
    ]
  );

  const updated = await db.get('SELECT * FROM sculpture_chat_grants WHERE id = ?', [targetGrantId]);
  return { grant: formatGrantRow(updated) };
}

export async function postEncryptedChatMessage(db, { sculptureId, user, body, userAgent = '' }) {
  // Enforce strict zero-plaintext contract
  if (
    body?.text !== undefined ||
    body?.message !== undefined ||
    body?.body !== undefined ||
    body?.plaintext !== undefined
  ) {
    throw new ChatHttpError(
      400,
      'Plaintext chat messages are rejected; encrypt messages client-side with AES-256-GCM.'
    );
  }

  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [sculptureId]);
  verifyCameraSightProof({
    sightProof: body?.sightProof,
    deviceProfile: body?.deviceProfile,
    userAgent,
    sculpture
  });

  const board = await db.get('SELECT * FROM sculpture_chat_boards WHERE sculpture_id = ?', [sculptureId]);
  if (!board) throw new ChatHttpError(404, 'Sculpture chat board is not initialized.');

  const keyEpoch = Number(board.key_epoch);
  const member = await db.get(
    `SELECT * FROM sculpture_chat_grants
     WHERE sculpture_id = ? AND key_epoch = ? AND requester_sub = ? AND status = 'granted'
     LIMIT 1`,
    [sculptureId, keyEpoch, user.id]
  );
  if (!member) {
    throw new ChatHttpError(403, 'Unlock the encrypted room key before posting.');
  }

  const id = String(body?.id || crypto.randomUUID()).trim().slice(0, 64);
  const senderPubFp = sanitizeFingerprint(body?.senderPubFp);
  const senderSignPubJwk = sanitizePublicEcJwk(body?.senderSignPubJwk);
  const ivB64 = String(body?.ivB64 || '').trim();
  const ciphertextB64 = String(body?.ciphertextB64 || '').trim();
  const aadJson = String(body?.aadJson || '').trim();
  const signatureB64 = String(body?.signatureB64 || '').trim();

  if (!ivB64 || !ciphertextB64 || !aadJson || !signatureB64) {
    throw new ChatHttpError(400, 'ivB64, ciphertextB64, aadJson, and signatureB64 are required.');
  }
  if (ciphertextB64.length > CHAT_MSG_MAX_CIPHERTEXT_LEN) {
    throw new ChatHttpError(400, 'Encrypted message exceeds maximum ciphertext size.');
  }

  let parsedAad;
  try {
    parsedAad = JSON.parse(aadJson);
  } catch {
    throw new ChatHttpError(400, 'aadJson must be valid JSON.');
  }
  if (
    parsedAad?.sculptureId !== sculptureId ||
    Number(parsedAad?.keyEpoch) !== keyEpoch ||
    parsedAad?.senderSub !== user.id ||
    parsedAad?.senderPubFp !== senderPubFp
  ) {
    throw new ChatHttpError(400, 'AAD metadata mismatch.');
  }

  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO sculpture_chat_messages (
      id, sculpture_id, key_epoch, sender_sub, sender_pub_fp, sender_sign_pub_jwk,
      iv_b64, ciphertext_b64, aad_json, signature_b64, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sculptureId,
      keyEpoch,
      user.id,
      senderPubFp,
      JSON.stringify(senderSignPubJwk),
      ivB64,
      ciphertextB64,
      aadJson,
      signatureB64,
      now
    ]
  );

  const saved = await db.get('SELECT * FROM sculpture_chat_messages WHERE id = ?', [id]);
  return { message: formatMessageRow(saved) };
}
