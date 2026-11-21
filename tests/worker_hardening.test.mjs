import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { isBlockedModelHost } from '../shared/model3d.mjs';

const worker = (await import('../worker/src/index.js')).default;

// Minimal D1 + KV shims over node:sqlite so the Worker's fetch handler runs in-process.
function makeEnv(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql) => {
    let params = [];
    const stmt = {
      bind: (...p) => {
        params = p;
        return stmt;
      },
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      }
    };
    return stmt;
  };
  const kv = new Map();
  return {
    DB: { prepare },
    IPFS_KV: {
      put: async (k, v, opts) => kv.set(k, { value: v, metadata: opts?.metadata }),
      get: async (k) => kv.get(k)?.value ?? null,
      getWithMetadata: async (k) => kv.get(k) ?? { value: null, metadata: null }
    },
    PUBLIC_URL: 'https://example.github.io/graffiland',
    ALLOW_DEV_GOOGLE_AUTH: 'false',
    SESSION_SECRET: 'test-session-secret',
    WALLET_ENCRYPTION_KEY: 'test-wallet-key',
    _kv: kv,
    ...overrides
  };
}

function req(path, init = {}) {
  return new Request(`https://api.example.dev${path}`, init);
}

describe('Worker hardening', () => {
  test('deployed Worker fails closed when session/wallet secrets are missing or dev defaults', async () => {
    const env = makeEnv({ SESSION_SECRET: undefined });
    const res = await worker.fetch(req('/api/auth/me'), env);
    assert.equal(res.status, 503);
    const devDefaultEnv = makeEnv({ SESSION_SECRET: 'graffiland-worker-dev-session-secret' });
    const res2 = await worker.fetch(req('/api/auth/me'), devDefaultEnv);
    assert.equal(res2.status, 503);
    const health = await worker.fetch(req('/api/health'), env);
    assert.notEqual(health.status, 503);
  });

  test('dev Google login is opt-in (missing var does not enable it)', async () => {
    const env = makeEnv({ ALLOW_DEV_GOOGLE_AUTH: undefined });
    const res = await worker.fetch(
      req('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devProfile: { email: 'anyone@victim.test' } })
      }),
      env
    );
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  });

  test('KV IPFS gateway serves stored content with nosniff + sandbox CSP and no unsafe types', async () => {
    const env = makeEnv();
    env._kv.set('cid:bafytestcid0001', {
      value: btoa('<html><script>alert(1)</script></html>'),
      metadata: { contentType: 'text/html' }
    });
    const res = await worker.fetch(req('/ipfs/bafytestcid0001'), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(res.headers.get('Content-Security-Policy'), /sandbox/);
  });

  test('agent challenge endpoint is rate limited per IP', async () => {
    const env = makeEnv();
    let last;
    for (let i = 0; i < 22; i++) {
      last = await worker.fetch(
        req('/api/agents/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
          body: JSON.stringify({ walletAddress: '0x000000000000000000000000000000000000dEaD' })
        }),
        env
      );
    }
    assert.equal(last.status, 429);
  });

  test('model URL host blocklist covers loopback, private, metadata and encoded forms', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.1.1',
      '192.168.0.1',
      '169.254.169.254',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '0177.0.0.1',
      '127.1',
      'metadata.google.internal',
      '2130706433'
    ]) {
      assert.equal(isBlockedModelHost(h), true, h);
    }
    for (const h of ['github.com', 'raw.githubusercontent.com', 'gateway.pinata.cloud']) {
      assert.equal(isBlockedModelHost(h), false, h);
    }
  });
});
