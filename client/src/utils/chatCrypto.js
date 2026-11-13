import { CHAT_CLUE_PBKDF2_ITERATIONS } from '../../../shared/chatPolicy.mjs';

const ID_PREFIX = 'graffiland_e2ee_id_v1_';
const ROOM_PREFIX = 'graffiland_e2ee_room_v1_';

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

function bytesToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function getStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  if (!globalThis.__graffilandMemStore) globalThis.__graffilandMemStore = new Map();
  const map = globalThis.__graffilandMemStore;
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

function stripPrivateJwk(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

async function computePubFingerprint(ecdhPublicJwk, signPublicJwk) {
  const canonical = JSON.stringify({
    e: [ecdhPublicJwk.x, ecdhPublicJwk.y],
    s: [signPublicJwk.x, signPublicJwk.y]
  });
  const digest = await crypto.subtle.digest('SHA-256', textEnc.encode(canonical));
  const hex = bytesToHex(digest).slice(0, 16).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

async function hydrateIdentity(rawRecord) {
  const ecdhPrivateKey = await crypto.subtle.importKey(
    'jwk',
    rawRecord.ecdhPrivateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const ecdhPublicKey = await crypto.subtle.importKey(
    'jwk',
    rawRecord.ecdhPublicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
  const signPrivateKey = await crypto.subtle.importKey(
    'jwk',
    rawRecord.signPrivateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
  const signPublicKey = await crypto.subtle.importKey(
    'jwk',
    rawRecord.signPublicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );

  return {
    ...rawRecord,
    ecdhPrivateKey,
    ecdhPublicKey,
    signPrivateKey,
    signPublicKey
  };
}

export async function getOrCreateDeviceIdentity(userId) {
  const store = getStorage();
  const key = `${ID_PREFIX}${userId || 'anon'}`;
  const existing = store.getItem(key);
  if (existing) {
    try {
      return await hydrateIdentity(JSON.parse(existing));
    } catch {
      // regenerate corrupted identity
    }
  }

  const ecdhPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const signPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const ecdhPrivateJwk = await crypto.subtle.exportKey('jwk', ecdhPair.privateKey);
  const ecdhPublicJwk = stripPrivateJwk(await crypto.subtle.exportKey('jwk', ecdhPair.publicKey));
  const signPrivateJwk = await crypto.subtle.exportKey('jwk', signPair.privateKey);
  const signPublicJwk = stripPrivateJwk(await crypto.subtle.exportKey('jwk', signPair.publicKey));
  const pubFingerprint = await computePubFingerprint(ecdhPublicJwk, signPublicJwk);

  const record = {
    ecdhPrivateJwk,
    ecdhPublicJwk,
    signPrivateJwk,
    signPublicJwk,
    pubFingerprint
  };
  store.setItem(key, JSON.stringify(record));
  return hydrateIdentity(record);
}

export async function signSightProof(identity, { sculptureId, parcelId = '', sightProof }) {
  const payload = `${sculptureId}|${parcelId}|${identity.pubFingerprint}|${sightProof.lat}|${sightProof.lng}|${sightProof.visualDHash || ''}|${sightProof.selectedAt}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.signPrivateKey,
    textEnc.encode(payload)
  );
  return {
    ...sightProof,
    sightSignatureB64: bytesToB64(sig)
  };
}

export function generateRoomKeyB64() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return bytesToB64(raw);
}

export function saveLocalRoomKey(userId, sculptureId, keyEpoch, roomKeyB64) {
  getStorage().setItem(`${ROOM_PREFIX}${userId}_${sculptureId}_${keyEpoch}`, roomKeyB64);
}

export function loadLocalRoomKey(userId, sculptureId, keyEpoch = 1) {
  return getStorage().getItem(`${ROOM_PREFIX}${userId}_${sculptureId}_${keyEpoch}`) || '';
}

export function listAllLocalRoomKeysForUser(userId) {
  const prefix = `${ROOM_PREFIX}${userId}_`;
  const found = [];
  const collect = (k, val) => {
    if (k && k.startsWith(prefix) && val) {
      const rest = k.slice(prefix.length);
      const lastUnderscore = rest.lastIndexOf('_');
      if (lastUnderscore > 0) {
        found.push({
          sculptureId: rest.slice(0, lastUnderscore),
          keyEpoch: Number(rest.slice(lastUnderscore + 1)) || 1,
          roomKeyB64: val
        });
      }
    }
  };
  if (typeof globalThis.localStorage !== 'undefined') {
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const k = globalThis.localStorage.key(i);
      collect(k, globalThis.localStorage.getItem(k));
    }
  } else if (globalThis.__graffilandMemStore) {
    for (const [k, val] of globalThis.__graffilandMemStore.entries()) {
      collect(k, val);
    }
  }
  return found;
}

/**
 * Produces a double-hashed blinded possession proof so holders of K_room can prove
 * knowledge of K_room (e.g. after clue unlock) without exposing K_room or the clue answer.
 */
export async function computeRoomPossessionProof(roomKeyB64, sculptureId, keyEpoch = 1) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    b64ToBytes(roomKeyB64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const tag = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    textEnc.encode(`graffiland:room-commit:${sculptureId}:${keyEpoch}`)
  );
  const roomProofToken = bytesToHex(tag);
  const commitDigest = await crypto.subtle.digest('SHA-256', textEnc.encode(roomProofToken));
  return {
    roomProofToken,
    roomKeyCommit: bytesToHex(commitDigest)
  };
}

async function deriveEcdhWrapKey(ecdhPrivKey, peerPubJwk, sculptureId, keyEpoch, recipientPubFp) {
  const peerKey = await crypto.subtle.importKey(
    'jwk',
    stripPrivateJwk(peerPubJwk),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerKey },
    ecdhPrivKey,
    256
  );
  const hkdfBase = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEnc.encode(`graffiland-ecdh-wrap-v1:${sculptureId}:${keyEpoch}`),
      info: textEnc.encode(String(recipientPubFp))
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapRoomKeyForRecipient({
  roomKeyB64,
  sculptureId,
  keyEpoch = 1,
  recipientEcdhPubJwk,
  recipientPubFp,
  grantorIdentity
}) {
  // Fresh ephemeral ECDH keypair per grant gives per-delivery forward secrecy
  const ephPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const ephPubJwk = stripPrivateJwk(await crypto.subtle.exportKey('jwk', ephPair.publicKey));
  const wrapKey = await deriveEcdhWrapKey(
    ephPair.privateKey,
    recipientEcdhPubJwk,
    sculptureId,
    keyEpoch,
    recipientPubFp
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = textEnc.encode(`${sculptureId}|${keyEpoch}|${recipientPubFp}`);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    wrapKey,
    b64ToBytes(roomKeyB64)
  );

  const ivB64 = bytesToB64(iv);
  const ctB64 = bytesToB64(ct);
  const signPayload = `${sculptureId}|${keyEpoch}|${recipientPubFp}|${ephPubJwk.x}|${ephPubJwk.y}|${ivB64}|${ctB64}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    grantorIdentity.signPrivateKey,
    textEnc.encode(signPayload)
  );

  return {
    wrappedKeyJson: {
      alg: 'ECDH-P256-HKDF-SHA256-AES256GCM',
      ephPubJwk,
      iv: ivB64,
      ciphertext: ctB64
    },
    grantSig: bytesToB64(sig)
  };
}

export async function unwrapRoomKeyFromGrant({
  wrappedKeyJson,
  grantSig,
  grantorSignPubJwk,
  sculptureId,
  keyEpoch = 1,
  identity
}) {
  if (!wrappedKeyJson?.ephPubJwk || !wrappedKeyJson?.iv || !wrappedKeyJson?.ciphertext) {
    throw new Error('Missing wrapped key payload');
  }

  if (grantSig && grantorSignPubJwk) {
    const signPub = await crypto.subtle.importKey(
      'jwk',
      stripPrivateJwk(grantorSignPubJwk),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const signPayload = `${sculptureId}|${keyEpoch}|${identity.pubFingerprint}|${wrappedKeyJson.ephPubJwk.x}|${wrappedKeyJson.ephPubJwk.y}|${wrappedKeyJson.iv}|${wrappedKeyJson.ciphertext}`;
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      signPub,
      b64ToBytes(grantSig),
      textEnc.encode(signPayload)
    );
    if (!valid) {
      throw new Error('Invalid grantor ECDSA signature on key envelope.');
    }
  }

  const wrapKey = await deriveEcdhWrapKey(
    identity.ecdhPrivateKey,
    wrappedKeyJson.ephPubJwk,
    sculptureId,
    keyEpoch,
    identity.pubFingerprint
  );
  const aad = textEnc.encode(`${sculptureId}|${keyEpoch}|${identity.pubFingerprint}`);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64ToBytes(wrappedKeyJson.iv),
      additionalData: aad,
      tagLength: 128
    },
    wrapKey,
    b64ToBytes(wrappedKeyJson.ciphertext)
  );
  return bytesToB64(plain);
}

export function normalizeClueAnswer(answer) {
  return String(answer || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function deriveClueAesKey(clueAnswer, sculptureId, keyEpoch = 1, iterations = CHAT_CLUE_PBKDF2_ITERATIONS) {
  const norm = normalizeClueAnswer(clueAnswer);
  if (!norm) throw new Error('Enter the real-world clue answer first.');
  const base = await crypto.subtle.importKey('raw', textEnc.encode(norm), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: textEnc.encode(`graffiland:clue:v1:${sculptureId}:${keyEpoch}`),
      iterations
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapRoomKeyWithClue({ roomKeyB64, sculptureId, keyEpoch = 1, clueAnswer }) {
  const aesKey = await deriveClueAesKey(clueAnswer, sculptureId, keyEpoch);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = textEnc.encode(`${sculptureId}|${keyEpoch}|clue`);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    aesKey,
    b64ToBytes(roomKeyB64)
  );
  return {
    alg: 'PBKDF2-SHA256-AES256GCM',
    iterations: CHAT_CLUE_PBKDF2_ITERATIONS,
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(ct)
  };
}

export async function unwrapRoomKeyWithClue({ clueWrappedJson, sculptureId, keyEpoch = 1, clueAnswer }) {
  const iterations = Number(clueWrappedJson?.iterations) || CHAT_CLUE_PBKDF2_ITERATIONS;
  const aesKey = await deriveClueAesKey(clueAnswer, sculptureId, keyEpoch, iterations);
  const aad = textEnc.encode(`${sculptureId}|${keyEpoch}|clue`);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64ToBytes(clueWrappedJson.iv),
      additionalData: aad,
      tagLength: 128
    },
    aesKey,
    b64ToBytes(clueWrappedJson.ciphertext)
  );
  return bytesToB64(plain);
}

export async function encryptChatMessage({
  roomKeyB64,
  sculptureId,
  keyEpoch = 1,
  senderSub,
  identity,
  text,
  authorName,
  sightDistM = null,
  altM = null
}) {
  const cleanText = String(text || '').trim().slice(0, 500);
  if (!cleanText) throw new Error('Message cannot be empty.');
  const clientMsgId = crypto.randomUUID();
  const sentAt = new Date().toISOString();

  const payloadJson = JSON.stringify({
    v: 1,
    text: cleanText,
    authorName: String(authorName || 'Artist').slice(0, 48),
    sightDistM,
    altM,
    sentAt
  });

  const aadJson = JSON.stringify({
    sculptureId,
    keyEpoch,
    senderSub,
    senderPubFp: identity.pubFingerprint,
    clientMsgId
  });

  const aesKey = await crypto.subtle.importKey(
    'raw',
    b64ToBytes(roomKeyB64),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEnc.encode(aadJson), tagLength: 128 },
    aesKey,
    textEnc.encode(payloadJson)
  );

  const ivB64 = bytesToB64(iv);
  const ciphertextB64 = bytesToB64(ct);
  const signInput = `${sculptureId}|${keyEpoch}|${identity.pubFingerprint}|${ivB64}|${ciphertextB64}|${aadJson}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.signPrivateKey,
    textEnc.encode(signInput)
  );

  return {
    id: clientMsgId,
    keyEpoch,
    senderPubFp: identity.pubFingerprint,
    senderSignPubJwk: identity.signPublicJwk,
    ivB64,
    ciphertextB64,
    aadJson,
    signatureB64: bytesToB64(sig)
  };
}

export async function decryptChatMessage({ msg, roomKeyB64, sculptureId }) {
  const parsedAad = JSON.parse(msg.aadJson || '{}');
  if (
    parsedAad.sculptureId !== sculptureId ||
    Number(parsedAad.keyEpoch) !== Number(msg.keyEpoch) ||
    parsedAad.senderSub !== msg.senderSub ||
    parsedAad.senderPubFp !== msg.senderPubFp
  ) {
    throw new Error('Authenticated metadata mismatch.');
  }

  let verifiedSig = false;
  if (msg.senderSignPubJwk && msg.signatureB64) {
    const signPub = await crypto.subtle.importKey(
      'jwk',
      stripPrivateJwk(msg.senderSignPubJwk),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const signInput = `${sculptureId}|${msg.keyEpoch}|${msg.senderPubFp}|${msg.ivB64}|${msg.ciphertextB64}|${msg.aadJson}`;
    verifiedSig = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      signPub,
      b64ToBytes(msg.signatureB64),
      textEnc.encode(signInput)
    );
  }

  if (!verifiedSig) {
    throw new Error('Failed ECDSA sender signature verification.');
  }

  const aesKey = await crypto.subtle.importKey(
    'raw',
    b64ToBytes(roomKeyB64),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64ToBytes(msg.ivB64),
      additionalData: textEnc.encode(msg.aadJson),
      tagLength: 128
    },
    aesKey,
    b64ToBytes(msg.ciphertextB64)
  );

  const data = JSON.parse(textDec.decode(plain));
  return {
    id: msg.id,
    senderSub: msg.senderSub,
    senderPubFp: msg.senderPubFp,
    createdAt: msg.createdAt,
    verifiedSig,
    text: String(data.text || ''),
    authorName: String(data.authorName || 'Artist'),
    sightDistM: data.sightDistM ?? null,
    altM: data.altM ?? null,
    sentAt: data.sentAt || msg.createdAt
  };
}
