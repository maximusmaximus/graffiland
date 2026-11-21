import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-pol-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');
const { assessPolEvidence, assessTravelFeasibility } = await import('../server/services/pol.mjs');

let server;
let baseUrl;
let token;

before(async () => {
  const { server: srv } = createAppServer();
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const res = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devProfile: { email: 'pol-tester@graffiland.test', name: 'PoL' } })
  });
  token = (await res.json()).token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function evidenceAt(lat, lng) {
  const now = Date.now();
  return {
    cameraFrames: 6,
    gyroSamples: 12,
    opticalFlowCorrelation: 0.8,
    visualDHash: 'abcdef0123456789',
    gpsSamples: [
      { lat, lng, t: now - 3000 },
      { lat: lat + 0.00001, lng: lng + 0.00001, t: now - 500 }
    ]
  };
}

async function publish(location, proofOfLocation, title) {
  const res = await fetch(`${baseUrl}/api/sculptures/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
    },
    body: JSON.stringify({
      title,
      description: 'Proof of Location integrity regression check.',
      termsAccepted: true,
      location,
      proofOfLocation,
      deviceProfile: { isMobile: true },
      voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
    })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('Proof of Location server-side evidence', () => {
  test('assessPolEvidence flags empty, stale, and off-location evidence', () => {
    const lat = 37.8;
    const lng = -122.4;
    assert.ok(assessPolEvidence({ lat, lng, gpsSamples: [] }).length > 0);
    const good = evidenceAt(lat, lng);
    assert.deepEqual(assessPolEvidence({ lat, lng, ...good }), []);
    const far = evidenceAt(lat + 0.05, lng);
    assert.match(assessPolEvidence({ lat, lng, ...far }).join(), /claimed location/);
    const stale = good.gpsSamples.map((s) => ({ ...s, t: s.t - 3 * 60 * 60 * 1000 }));
    assert.match(assessPolEvidence({ lat, lng, ...good, gpsSamples: stale }).join(), /stale/);
  });

  test('assessTravelFeasibility rejects impossible travel only', () => {
    const now = Date.now();
    const sf = { lat: 37.7749, lng: -122.4194, at: now - 60_000 };
    assert.equal(assessTravelFeasibility(sf, { lat: 35.6762, lng: 139.6503 }, now).ok, false);
    assert.equal(assessTravelFeasibility(sf, { lat: 37.776, lng: -122.42 }, now).ok, true);
    const yesterday = { ...sf, at: now - 24 * 60 * 60 * 1000 };
    assert.equal(assessTravelFeasibility(yesterday, { lat: 35.6762, lng: 139.6503 }, now).ok, true);
  });

  test('publish with no sensor evidence is rejected (previously scored 53/100 and passed)', async () => {
    const res = await publish({ lat: 48.8584, lng: 2.2945, accuracy: 5 }, {}, 'Empty Evidence');
    assert.equal(res.status, 422);
    assert.match(res.body.error, /GPS samples/);
  });

  test('publish then teleport across the world within a minute is rejected', async () => {
    const first = await publish(
      { lat: 37.7749, lng: -122.4194, accuracy: 5 },
      evidenceAt(37.7749, -122.4194),
      'Origin Piece'
    );
    assert.equal(first.status, 201);
    const second = await publish(
      { lat: 35.6762, lng: 139.6503, accuracy: 5 },
      evidenceAt(35.6762, 139.6503),
      'Teleport Piece'
    );
    assert.equal(second.status, 422);
    assert.match(second.body.error, /too fast/);
  });
});
