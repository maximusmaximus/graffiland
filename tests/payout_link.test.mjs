import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ethers } from 'ethers';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-payout-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');
const { buildPayoutLinkMessage, verifyPayoutLinkSignature } =
  await import('../shared/payoutLinkMessage.mjs');

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

async function apiJson(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(email) {
  const res = await apiJson('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ devProfile: { email, name: email.split('@')[0] } })
  });
  assert.equal(res.status, 200);
  return res.body;
}

describe('Payout address requires proof of control', () => {
  test('verifyPayoutLinkSignature accepts fresh signatures from the address only', async () => {
    const wallet = ethers.Wallet.createRandom();
    const issuedAt = new Date().toISOString();
    const message = buildPayoutLinkMessage({ userId: 'u1', address: wallet.address, issuedAt });
    const signature = await wallet.signMessage(message);
    assert.equal(
      verifyPayoutLinkSignature({ userId: 'u1', address: wallet.address, issuedAt, signature })
        .address,
      wallet.address
    );
    // Bound to the account id: another account cannot replay it.
    assert.throws(() =>
      verifyPayoutLinkSignature({ userId: 'u2', address: wallet.address, issuedAt, signature })
    );
    // Expired.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oldSig = await wallet.signMessage(
      buildPayoutLinkMessage({ userId: 'u1', address: wallet.address, issuedAt: old })
    );
    assert.throws(
      () =>
        verifyPayoutLinkSignature({
          userId: 'u1',
          address: wallet.address,
          issuedAt: old,
          signature: oldSig
        }),
      /expired/
    );
  });

  test("cannot claim another user's wallet as payout address (ownership hijack)", async () => {
    const alice = await login('payout-alice@graffiland.test');
    const bob = await login('payout-bob@graffiland.test');
    const aliceAddr = alice.user.walletAddress;

    // Unsigned attempt to point Bob's payout at Alice's embedded wallet is rejected.
    const unsigned = await apiJson('/api/wallet/payout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ address: aliceAddr })
    });
    assert.ok([400, 401].includes(unsigned.status), `got ${unsigned.status}`);

    const me = await apiJson('/api/auth/me', { headers: { Authorization: `Bearer ${bob.token}` } });
    assert.equal(me.body.user.customPayoutAddress, '');
  });

  test('signed external wallet links; same address cannot be linked to a second account', async () => {
    const carol = await login('payout-carol@graffiland.test');
    const dave = await login('payout-dave@graffiland.test');
    const ext = ethers.Wallet.createRandom();

    const sign = async (user) => {
      const issuedAt = new Date().toISOString();
      const signature = await ext.signMessage(
        buildPayoutLinkMessage({ userId: user.id, address: ext.address, issuedAt })
      );
      return { issuedAt, signature };
    };

    const ok = await apiJson('/api/wallet/payout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.token}` },
      body: JSON.stringify({ address: ext.address, ...(await sign(carol.user)) })
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.customPayoutAddress, ext.address);

    const dup = await apiJson('/api/wallet/payout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dave.token}` },
      body: JSON.stringify({ address: ext.address, ...(await sign(dave.user)) })
    });
    assert.equal(dup.status, 409);

    // Clearing the payout address never needs a signature.
    const cleared = await apiJson('/api/wallet/payout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${carol.token}` },
      body: JSON.stringify({ address: '' })
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.user.customPayoutAddress, '');
  });
});
