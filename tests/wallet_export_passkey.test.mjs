import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-pk-export-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');
const { CONFIG } = await import('../server/config.mjs');
const worker = (await import('../worker/src/index.js')).default;

let server;
let baseUrl;

before(async () => {
  const { server: srv } = createAppServer();
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const b64u = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

async function apiJson(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

async function login(email) {
  const res = await apiJson('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ devProfile: { email, name: email.split('@')[0] } })
  });
  assert.equal(res.status, 200);
  return res.body;
}

async function makePasskeyFor(fetcher, token, origin) {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  );
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', keyPair.publicKey));
  const credentialId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const opts = await fetcher('/api/passkeys/register/options', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(opts.status, 200);
  const verify = await fetcher('/api/passkeys/register/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      credentialId,
      publicKeySpkiB64: b64u(spki),
      clientDataJSON: b64u(
        new TextEncoder().encode(
          JSON.stringify({ type: 'webauthn.create', challenge: opts.body.challenge, origin })
        )
      ),
      deviceLabel: 'Test Device'
    })
  });
  assert.equal(verify.status, 200);

  const sign = async (challengeB64, signCount, signingKey = keyPair.privateKey) => {
    const rpHash = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.body.rp.id))
    );
    const authData = new Uint8Array(37);
    authData.set(rpHash, 0);
    authData[32] = 0x05;
    new DataView(authData.buffer).setUint32(33, signCount, false);
    const clientDataBytes = new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: challengeB64, origin })
    );
    const clientHash = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', clientDataBytes)
    );
    const payload = new Uint8Array(authData.length + clientHash.length);
    payload.set(authData, 0);
    payload.set(clientHash, authData.length);
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, payload)
    );
    return {
      credentialId,
      clientDataJSON: b64u(clientDataBytes),
      authenticatorData: b64u(authData),
      signature: b64u(sig)
    };
  };
  return { credentialId, sign };
}

describe('Embedded wallet export requires hardware Passkey', () => {
  test('GET /api/wallet/export is blocked and challenge requires a registered Passkey', async () => {
    const { token } = await login('pk-nopasskey@graffiland.test');

    const getRes = await apiJson('/api/wallet/export', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(getRes.status, 403);
    assert.equal(getRes.body.code, 'PASSKEY_REQUIRED');

    const chRes = await apiJson('/api/wallet/export/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(chRes.status, 403);
    assert.equal(chRes.body.code, 'PASSKEY_REQUIRED');
  });

  test('valid Passkey assertion exports key once with no-store and blocks replay or wrong key', async () => {
    const alice = await login('pk-alice@graffiland.test');
    const bob = await login('pk-bob@graffiland.test');
    const pk = await makePasskeyFor(apiJson, alice.token, baseUrl);

    // Bad key fails
    const ch1 = await apiJson('/api/wallet/export/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` }
    });
    assert.equal(ch1.status, 200);
    const wrongKey = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );
    const badExport = await apiJson('/api/wallet/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        challenge: ch1.body.challenge,
        assertion: await pk.sign(ch1.body.challenge, 1, wrongKey.privateKey)
      })
    });
    assert.equal(badExport.status, 403);

    // Even with a fresh valid signature, the failed challenge is already burned
    const burned = await apiJson('/api/wallet/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        challenge: ch1.body.challenge,
        assertion: await pk.sign(ch1.body.challenge, 2)
      })
    });
    assert.equal(burned.status, 403);

    // Fresh challenge + valid assertion succeeds
    const ch2 = await apiJson('/api/wallet/export/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` }
    });
    assert.equal(ch2.status, 200);
    const assertion = await pk.sign(ch2.body.challenge, 3);

    // Another account cannot use Alice's challenge
    const crossAccount = await apiJson('/api/wallet/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ challenge: ch2.body.challenge, assertion })
    });
    assert.equal(crossAccount.status, 403);

    const ok = await apiJson('/api/wallet/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ challenge: ch2.body.challenge, assertion })
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(new ethers.Wallet(ok.body.privateKey).address, alice.user.walletAddress);

    // Replaying the same challenge + assertion fails
    const replay = await apiJson('/api/wallet/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ challenge: ch2.body.challenge, assertion })
    });
    assert.equal(replay.status, 403);
  });

  test('Worker enforces Passkey requirement on /api/wallet/export', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
    const env = {
      DB: {
        prepare: (sql) => {
          let params = [];
          const stmt = {
            bind: (...p) => {
              params = p;
              return stmt;
            },
            first: async () => db.prepare(sql).get(...params) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...params) }),
            run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } })
          };
          return stmt;
        }
      },
      PUBLIC_URL: 'https://app.example.dev',
      ALLOW_DEV_GOOGLE_AUTH: 'true',
      SESSION_SECRET: 'test-session-secret',
      WALLET_ENCRYPTION_KEY: 'test-wallet-key'
    };
    const wFetch = async (route, opts = {}) => {
      const res = await worker.fetch(
        new Request(`https://api.example.dev${route}`, {
          ...opts,
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://app.example.dev',
            ...(opts.headers || {})
          }
        }),
        env
      );
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
    };
    const loginRes = await wFetch('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email: 'w-pk@graffiland.test', name: 'Worker PK' } })
    });
    assert.equal(loginRes.status, 200);
    const token = loginRes.body.token;

    const getRes = await wFetch('/api/wallet/export', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(getRes.status, 403);

    const pk = await makePasskeyFor(wFetch, token, 'https://app.example.dev');
    const ch = await wFetch('/api/wallet/export/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(ch.status, 200);
    const assertion = await pk.sign(ch.body.challenge, 1);
    const ok = await wFetch('/api/wallet/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ challenge: ch.body.challenge, assertion })
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(new ethers.Wallet(ok.body.privateKey).address, loginRes.body.user.walletAddress);

    // Untrusted Origin header cannot expand allowedOrigins or spoof rpId on Passkey registration or export
    const evilRegOpts = await wFetch('/api/passkeys/register/options', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }
    });
    assert.equal(evilRegOpts.status, 200);
    assert.equal(evilRegOpts.body.rp.id, 'app.example.dev');
    const evilKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );
    const evilSpki = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('spki', evilKeyPair.publicKey)
    );
    const evilVerify = await wFetch('/api/passkeys/register/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
      body: JSON.stringify({
        credentialId: b64u(globalThis.crypto.getRandomValues(new Uint8Array(16))),
        publicKeySpkiB64: b64u(evilSpki),
        clientDataJSON: b64u(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'webauthn.create',
              challenge: evilRegOpts.body.challenge,
              origin: 'https://evil.example'
            })
          )
        ),
        deviceLabel: 'Evil Origin Device'
      })
    });
    assert.equal(evilVerify.status, 403);
    assert.match(evilVerify.body.error, /Untrusted WebAuthn registration origin/i);

    const chEvil = await wFetch('/api/wallet/export/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }
    });
    assert.equal(chEvil.status, 200);
    assert.equal(chEvil.body.rpId, 'app.example.dev');
  });

  test('stale stolen JWT (>15m old) cannot register a rogue Passkey to bypass wallet export gate', async () => {
    const victim = await login('pk-stale@graffiland.test');
    const staleIat = Math.floor(Date.now() / 1000) - 3600;
    const staleToken = jwt.sign(
      {
        sub: victim.user.id,
        email: victim.user.email,
        isAdmin: false,
        iat: staleIat,
        exp: staleIat + 14 * 86400
      },
      CONFIG.sessionSecret
    );

    const opts = await apiJson('/api/passkeys/register/options', {
      method: 'POST',
      headers: { Authorization: `Bearer ${staleToken}` }
    });
    assert.equal(opts.status, 403);
    assert.equal(opts.body.code, 'REAUTH_REQUIRED');
  });
});
