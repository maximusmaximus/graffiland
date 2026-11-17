import {
  PIN_BATCH_MAX_CIPHERTEXT_LEN,
  buildParcelPresenceSignPayload,
  looksMobileRequest,
  verifyParcelPhysicalPresence,
  verifyParcelPresenceSignature
} from './chatPolicy.mjs';
import { checkParcelOwnership, checkSculptureOwnership } from './mcpService.mjs';

const PARCEL_CHALLENGE_TTL_MS = 90 * 1000;

export class PinServiceError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeSha256HexFromB64(b64) {
  const digest = await crypto.subtle.digest('SHA-256', b64ToBytes(b64));
  return bytesToHex(digest);
}

function generateRandomB64(byteLen = 32) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}

function safeParseJson(raw, fallback = null) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function assertLandHolder(db, { sculpture, user }) {
  try {
    await checkParcelOwnership(db, {
      parcelId: sculpture.parcel_id,
      user
    });
    return true;
  } catch {
    try {
      await checkSculptureOwnership(db, {
        sculptureId: sculpture.id,
        user
      });
      return true;
    } catch {
      throw new PinServiceError(
        `Only the holder of Virtual Land ${sculpture.parcel_id} can pin or edit pinned IPFS messages here.`,
        403
      );
    }
  }
}

export async function isUserLandHolder(db, { sculpture, user }) {
  if (!sculpture || !user) return false;
  try {
    return await assertLandHolder(db, { sculpture, user });
  } catch {
    return false;
  }
}

export function formatPinBatchMeta(row, fallbackParcelId = '') {
  if (!row) {
    return {
      hasPins: false,
      batchSeq: 0,
      pinCount: 0,
      ipfsCid: '',
      ipfsUri: '',
      ipfsGatewayUrl: '',
      parcelId: fallbackParcelId || '',
      updatedAt: ''
    };
  }
  const pinCount = Number(row.pin_count || 0);
  return {
    hasPins: pinCount > 0 && Boolean(row.ipfs_cid),
    batchSeq: Number(row.batch_seq || 0),
    pinCount,
    ipfsCid: row.ipfs_cid || '',
    ipfsUri: row.ipfs_uri || '',
    ipfsGatewayUrl: row.ipfs_gateway_url || '',
    parcelId: row.parcel_id || fallbackParcelId || '',
    updatedAt: row.updated_at || ''
  };
}

export async function getPinnedBatchMeta(db, { sculptureId }) {
  const sculpture = await db.get(
    'SELECT id, parcel_id, hidden FROM sculptures WHERE id = ? AND hidden = 0',
    [sculptureId]
  );
  if (!sculpture) {
    throw new PinServiceError('Sculpture not found.', 404);
  }
  const row = await db.get('SELECT * FROM sculpture_pin_batches WHERE sculpture_id = ?', [
    sculptureId
  ]);
  return {
    sculptureId: sculpture.id,
    parcelId: sculpture.parcel_id,
    meta: formatPinBatchMeta(row, sculpture.parcel_id)
  };
}

export async function getOwnerPinSeal(db, { sculptureId, user, readIpfsJsonFn = null }) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [
    sculptureId
  ]);
  if (!sculpture) {
    throw new PinServiceError('Sculpture not found.', 404);
  }
  await assertLandHolder(db, { sculpture, user });

  let row = await db.get('SELECT * FROM sculpture_pin_batches WHERE sculpture_id = ?', [
    sculptureId
  ]);
  const now = new Date().toISOString();

  if (!row) {
    const sealSecretB64 = generateRandomB64(32);
    const keyCommitment = await computeSha256HexFromB64(sealSecretB64);
    await db.run(
      `INSERT INTO sculpture_pin_batches (
        sculpture_id, parcel_id, geohash, batch_seq, pin_count,
        seal_secret_b64, key_commitment, ipfs_cid, ipfs_uri, ipfs_gateway_url,
        encrypted_batch_json, updated_by_sub, updated_by_address, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 0, ?, ?, '', '', '', '{}', ?, ?, ?, ?)`,
      [
        sculpture.id,
        sculpture.parcel_id,
        String(sculpture.geohash || '').toLowerCase(),
        sealSecretB64,
        keyCommitment,
        user.id,
        user.custom_payout_address || user.wallet_address || '',
        now,
        now
      ]
    );
    row = await db.get('SELECT * FROM sculpture_pin_batches WHERE sculpture_id = ?', [sculptureId]);
  }

  let encryptedBatch = null;
  if (row.ipfs_cid) {
    if (typeof readIpfsJsonFn === 'function') {
      try {
        encryptedBatch = await readIpfsJsonFn(row.ipfs_cid);
      } catch {
        encryptedBatch = null;
      }
    }
    if (!encryptedBatch && row.encrypted_batch_json && row.encrypted_batch_json !== '{}') {
      encryptedBatch = safeParseJson(row.encrypted_batch_json, null);
    }
  }

  return {
    sculptureId: sculpture.id,
    parcelId: sculpture.parcel_id,
    geohash: String(sculpture.geohash || '').toLowerCase(),
    parcelSealKeyB64: row.seal_secret_b64,
    keyCommitment: row.key_commitment,
    nextBatchSeq: Number(row.batch_seq || 0) + 1,
    meta: formatPinBatchMeta(row, sculpture.parcel_id),
    encryptedBatch
  };
}

export async function saveEncryptedPinBatch(db, { sculptureId, user, body, pinJsonFn }) {
  if (
    body?.text !== undefined ||
    body?.message !== undefined ||
    body?.plaintext !== undefined ||
    body?.pins !== undefined
  ) {
    throw new PinServiceError(
      'Server refuses plaintext pinned messages. Encrypt the IPFS batch client-side before pinning.',
      400
    );
  }

  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [
    sculptureId
  ]);
  if (!sculpture) {
    throw new PinServiceError('Sculpture not found.', 404);
  }
  await assertLandHolder(db, { sculpture, user });

  const batch = body?.encryptedBatch;
  if (
    !batch ||
    batch.version !== 'graffiland-pins-ipfs-v1' ||
    typeof batch.ivB64 !== 'string' ||
    typeof batch.ciphertextB64 !== 'string' ||
    typeof batch.aadJson !== 'string'
  ) {
    throw new PinServiceError('Valid encrypted IPFS pin batch payload is required.', 400);
  }

  if (batch.ciphertextB64.length > PIN_BATCH_MAX_CIPHERTEXT_LEN) {
    throw new PinServiceError('Encrypted IPFS pin batch exceeds maximum size limit.', 400);
  }

  let parsedAad;
  try {
    parsedAad = JSON.parse(batch.aadJson);
  } catch {
    throw new PinServiceError('Invalid encrypted batch AAD JSON.', 400);
  }

  if (
    parsedAad?.sculptureId !== sculpture.id ||
    parsedAad?.parcelId !== sculpture.parcel_id ||
    String(parsedAad?.geohash || '').toLowerCase() !== String(sculpture.geohash || '').toLowerCase()
  ) {
    throw new PinServiceError('Encrypted IPFS batch AAD parcel binding mismatch.', 400);
  }

  const row = await db.get('SELECT * FROM sculpture_pin_batches WHERE sculpture_id = ?', [
    sculptureId
  ]);
  if (!row || !row.seal_secret_b64) {
    throw new PinServiceError('Initialize owner parcel seal first via /pins/owner-seal.', 400);
  }

  if (batch.keyCommitment !== row.key_commitment) {
    throw new PinServiceError('Parcel seal key commitment mismatch.', 403);
  }

  const expectedSeq = Number(row.batch_seq || 0) + 1;
  const suppliedSeq = Number(parsedAad.batchSeq || batch.batchSeq || 0);
  if (!Number.isInteger(suppliedSeq) || suppliedSeq !== expectedSeq) {
    throw new PinServiceError(
      `Batch sequence mismatch: expected v${expectedSeq}, got v${suppliedSeq}. Refresh owner seal and retry.`,
      409
    );
  }

  const pinCount = Number(batch.pinCount ?? 0);
  if (!Number.isInteger(pinCount) || pinCount < 0 || pinCount > 25) {
    throw new PinServiceError('pinCount must be between 0 and 25.', 400);
  }

  const normalizedBatch = {
    version: 'graffiland-pins-ipfs-v1',
    alg: 'AES-GCM-HKDF-PARCEL-SEAL',
    sculptureId: sculpture.id,
    parcelId: sculpture.parcel_id,
    geohash: String(sculpture.geohash || '').toLowerCase(),
    batchSeq: expectedSeq,
    pinCount,
    aadJson: batch.aadJson,
    ivB64: batch.ivB64,
    ciphertextB64: batch.ciphertextB64,
    keyCommitment: row.key_commitment,
    ownerPubFp: String(batch.ownerPubFp || ''),
    ownerSignPubJwk: batch.ownerSignPubJwk || null,
    ownerSignatureB64: String(batch.ownerSignatureB64 || ''),
    updatedAt: batch.updatedAt || new Date().toISOString()
  };

  if (typeof pinJsonFn !== 'function') {
    throw new PinServiceError('IPFS pinning service is not configured.', 500);
  }
  const ipfsPin = await pinJsonFn(normalizedBatch, `${sculpture.id}-pins-v${expectedSeq}.json`);
  const now = new Date().toISOString();

  await db.run(
    `UPDATE sculpture_pin_batches
     SET batch_seq = ?, pin_count = ?, ipfs_cid = ?, ipfs_uri = ?, ipfs_gateway_url = ?,
         encrypted_batch_json = ?, updated_by_sub = ?, updated_by_address = ?, updated_at = ?
     WHERE sculpture_id = ?`,
    [
      expectedSeq,
      pinCount,
      ipfsPin.cid,
      ipfsPin.uri,
      ipfsPin.gatewayUrl || '',
      JSON.stringify(normalizedBatch),
      user.id,
      user.custom_payout_address || user.wallet_address || '',
      now,
      sculpture.id
    ]
  );

  const updated = await db.get('SELECT * FROM sculpture_pin_batches WHERE sculpture_id = ?', [
    sculptureId
  ]);

  return {
    ok: true,
    nextBatchSeq: expectedSeq + 1,
    meta: formatPinBatchMeta(updated, sculpture.parcel_id),
    ipfs: {
      cid: ipfsPin.cid,
      uri: ipfsPin.uri,
      gatewayUrl: ipfsPin.gatewayUrl || '',
      provider: ipfsPin.provider || 'ipfs'
    }
  };
}

export async function issueParcelPresenceChallenge(
  db,
  { sculptureId, user, body, userAgent = '' }
) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [
    sculptureId
  ]);
  if (!sculpture) {
    throw new PinServiceError('Sculpture not found.', 404);
  }

  if (!looksMobileRequest(body?.deviceProfile, userAgent)) {
    throw new PinServiceError(
      'Mobile device with live GPS, gyroscope, and AR camera is required to unlock parcel-pinned IPFS messages.',
      403
    );
  }

  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + PARCEL_CHALLENGE_TTL_MS).toISOString();
  const challengeId = crypto.randomUUID();
  const challengeNonce = generateRandomB64(24);

  await db.run(
    `INSERT INTO parcel_presence_challenges (
      id, sculpture_id, parcel_id, geohash, user_id, nonce,
      consumed, requester_pub_fp, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?, '')`,
    [
      challengeId,
      sculpture.id,
      sculpture.parcel_id,
      String(sculpture.geohash || '').toLowerCase(),
      user.id,
      challengeNonce,
      createdAt,
      expiresAt
    ]
  );

  return {
    challengeId,
    challengeNonce,
    sculptureId: sculpture.id,
    parcelId: sculpture.parcel_id,
    geohash: String(sculpture.geohash || '').toLowerCase(),
    expiresAt
  };
}

export async function unlockPinnedBatchForParcelVisitor(
  db,
  { sculptureId, user, body, userAgent = '', readIpfsJsonFn = null }
) {
  const sculpture = await db.get('SELECT * FROM sculptures WHERE id = ? AND hidden = 0', [
    sculptureId
  ]);
  if (!sculpture) {
    throw new PinServiceError('Sculpture not found.', 404);
  }

  const challengeId = String(body?.challengeId || '').trim();
  if (!challengeId) {
    throw new PinServiceError('Single-use parcel presence challengeId is required.', 403);
  }

  const challenge = await db.get(
    'SELECT * FROM parcel_presence_challenges WHERE id = ? AND sculpture_id = ?',
    [challengeId, sculpture.id]
  );
  if (!challenge) {
    throw new PinServiceError('Parcel presence challenge not found. Aim AR camera again.', 403);
  }
  if (challenge.user_id !== user.id) {
    throw new PinServiceError('Parcel presence challenge does not belong to signed-in user.', 403);
  }
  if (Number(challenge.consumed) !== 0) {
    throw new PinServiceError('Parcel presence challenge already used (replay blocked).', 403);
  }
  if (Date.now() > new Date(challenge.expires_at).getTime()) {
    throw new PinServiceError('Parcel presence challenge expired. Aim AR camera again.', 403);
  }

  const verifiedPresence = verifyParcelPhysicalPresence({
    sightProof: body?.sightProof,
    polSnapshot: body?.polSnapshot,
    deviceProfile: body?.deviceProfile,
    userAgent,
    sculpture
  });

  const payload = buildParcelPresenceSignPayload({
    sculptureId: sculpture.id,
    parcelId: sculpture.parcel_id,
    geohash: sculpture.geohash,
    challengeId: challenge.id,
    challengeNonce: challenge.nonce,
    pubFingerprint: body?.requesterPubFp,
    lat: body?.sightProof?.lat,
    lng: body?.sightProof?.lng,
    cameraFrames: verifiedPresence.cameraFrames,
    visualDHash: verifiedPresence.visualDHash,
    selectedAt: body?.sightProof?.selectedAt || verifiedPresence.selectedAt
  });

  await verifyParcelPresenceSignature({
    ecdhPublicJwk: body?.requesterEcdhPubJwk,
    signPublicJwk: body?.requesterSignPubJwk,
    pubFingerprint: body?.requesterPubFp,
    payload,
    signatureB64: body?.presenceSignatureB64
  });

  const upd = await db.run(
    `UPDATE parcel_presence_challenges
     SET consumed = 1, requester_pub_fp = ?, consumed_at = ?
     WHERE id = ? AND consumed = 0`,
    [String(body?.requesterPubFp || ''), new Date().toISOString(), challenge.id]
  );
  const changed = Number(upd?.changes ?? upd?.meta?.changes ?? 0);
  if (changed < 1) {
    throw new PinServiceError('Parcel presence challenge already consumed (replay blocked).', 403);
  }

  const batchRow = await db.get('SELECT * FROM sculpture_pin_batches WHERE sculpture_id = ?', [
    sculpture.id
  ]);
  const meta = formatPinBatchMeta(batchRow, sculpture.parcel_id);

  if (!batchRow || !batchRow.ipfs_cid || !batchRow.seal_secret_b64) {
    return {
      unlocked: true,
      hasPins: false,
      sculptureId: sculpture.id,
      parcelId: sculpture.parcel_id,
      geohash: String(sculpture.geohash || '').toLowerCase(),
      verifiedPresence,
      meta,
      parcelSealKeyB64: '',
      encryptedBatch: null
    };
  }

  let encryptedBatch = null;
  if (typeof readIpfsJsonFn === 'function') {
    try {
      encryptedBatch = await readIpfsJsonFn(batchRow.ipfs_cid);
    } catch {
      encryptedBatch = null;
    }
  }
  if (!encryptedBatch && batchRow.encrypted_batch_json && batchRow.encrypted_batch_json !== '{}') {
    encryptedBatch = safeParseJson(batchRow.encrypted_batch_json, null);
  }

  return {
    unlocked: true,
    hasPins: meta.hasPins,
    sculptureId: sculpture.id,
    parcelId: sculpture.parcel_id,
    geohash: String(sculpture.geohash || '').toLowerCase(),
    verifiedPresence,
    meta,
    ipfsCid: batchRow.ipfs_cid,
    ipfsUri: batchRow.ipfs_uri,
    ipfsGatewayUrl: batchRow.ipfs_gateway_url || '',
    batchSeq: Number(batchRow.batch_seq || 1),
    pinCount: Number(batchRow.pin_count || 0),
    parcelSealKeyB64: batchRow.seal_secret_b64,
    encryptedBatch
  };
}
