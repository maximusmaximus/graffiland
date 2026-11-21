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

  test('iOS touch-drag fallback (0 gyro) passes with >=4 camera frames + visualDHash, rejects weak fallback', () => {
    const lat = 37.8;
    const lng = -122.4;
    const good = evidenceAt(lat, lng);
    assert.deepEqual(
      assessPolEvidence({ lat, lng, ...good, gyroSamples: 0, cameraFrames: 4, visualDHash: 'abcdef0123456789' }),
      []
    );
    assert.ok(
      assessPolEvidence({ lat, lng, ...good, gyroSamples: 0, cameraFrames: 2, visualDHash: 'abcdef0123456789' }).length > 0
    );
    assert.ok(
      assessPolEvidence({ lat, lng, ...good, gyroSamples: 0, cameraFrames: 6, visualDHash: '' }).length > 0
    );
  });

  test('remote MCP/owner land placement in another city does not falsely trigger impossible travel for mobile publish', async () => {
    const ownerRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'pol-mcp-owner@graffiland.test', name: 'Owner' } })
    }).then((r) => r.json());
    const ownerToken = ownerRes.token;

    // Claim a Tokyo parcel from desktop and place a 3D item remotely (propertyAuthorized: true)
    const claim = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ lat: 35.6762, lng: 139.6503, customName: 'Tokyo Remote Lot' })
    }).then((r) => r.json());
    const parcelId = claim.parcelId;
    assert.ok(parcelId, JSON.stringify(claim));

    const remotePlace = await fetch(`${baseUrl}/api/lands/${parcelId}/sculptures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        title: 'Remote Tokyo Pedestal',
        description: 'Placed remotely by owner from desktop.',
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(remotePlace.status, 200);

    // Immediately publish an IRL mobile sculpture in San Francisco -> must NOT be falsely flagged as teleporting
    const sfRes = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'SF Real Mobile Piece',
        description: 'Published in person in San Francisco after remote Tokyo land edit.',
        termsAccepted: true,
        location: { lat: 37.7749, lng: -122.4194, accuracy: 5 },
        proofOfLocation: evidenceAt(37.7749, -122.4194),
        deviceProfile: { isMobile: true },
        voxels: [{ x: 0, y: 0, z: 0, color: '#ff3e7f', material: 'neon' }]
      })
    });
    assert.equal(sfRes.status, 201);
  });
});
