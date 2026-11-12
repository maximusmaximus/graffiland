function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

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

async function deriveAesKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ]);
}

export async function encryptWalletPrivateKey(privateKey, secret) {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      new TextEncoder().encode(privateKey)
    )
  );
  // WebCrypto AES-GCM appends the 16-byte auth tag at the end
  const data = cipherBuf.slice(0, cipherBuf.length - 16);
  const tag = cipherBuf.slice(cipherBuf.length - 16);
  return JSON.stringify({
    v: 1,
    iv: bytesToHex(iv),
    tag: bytesToHex(tag),
    data: bytesToHex(data)
  });
}

export async function decryptWalletPrivateKey(encryptedJson, secret) {
  const payload = JSON.parse(encryptedJson);
  const key = await deriveAesKey(secret);
  const iv = hexToBytes(payload.iv);
  const data = hexToBytes(payload.data);
  const tag = hexToBytes(payload.tag);
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    combined
  );
  return new TextDecoder().decode(plainBuf);
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJwt(payload, secret, ttlSeconds = 14 * 86400) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64UrlEncode(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64UrlEncode(sig)}`;
}

export async function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const [header, body, sig] = parts;
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64UrlDecode(sig),
    new TextEncoder().encode(`${header}.${body}`)
  );
  if (!ok) throw new Error('Invalid JWT signature');
  const parsed = JSON.parse(new TextDecoder().decode(b64UrlDecode(body)));
  if (parsed.exp && Math.floor(Date.now() / 1000) > parsed.exp) {
    throw new Error('Expired JWT');
  }
  return parsed;
}
