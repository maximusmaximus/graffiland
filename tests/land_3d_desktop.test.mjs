import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LAND_VOLUME_LIMITS } from '../shared/constants.mjs';
import {
  buildParcelShareUrl,
  footprintsOverlap,
  validateAndNormalizeLandVolume
} from '../shared/landVolume.mjs';
import { buildLandAcquisitionAgentPrompt } from '../shared/landSignatureMessage.mjs';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-3d-land-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'land3d.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');

let server;
let baseUrl;
let humanToken = '';
let otherHumanToken = '';
let firstClaimedParcelId = '';

before(async () => {
  const { server: srv } = createAppServer({ publishRateLimit: 100, mcpRateLimit: 200 });
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const login1 = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devProfile: { email: 'land3d-owner@graffiland.test', name: 'Land3D Owner' } })
  }).then((r) => r.json());
  humanToken = login1.token;

  const login2 = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devProfile: { email: 'land3d-other@graffiland.test', name: 'Other User' } })
  }).then((r) => r.json());
  otherHumanToken = login2.token;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore Windows file lock cleanup
  }
});

describe('3D Land Volume Geometry & Prompt Unit Tests', () => {
  test('validateAndNormalizeLandVolume normalizes valid 3D prism and computes corners', () => {
    const res = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 24,
      depthMeters: 16,
      zScale: 2,
      rotationDeg: 405
    });
    assert.equal(res.ok, true);
    assert.equal(res.volume.widthMeters, 24);
    assert.equal(res.volume.depthMeters, 16);
    assert.equal(res.volume.heightMeters, 36);
    assert.equal(res.volume.zScale, 2);
    assert.equal(res.volume.rotationDeg, 45);
    assert.equal(res.volume.footprintAreaSqM, 384);
    assert.equal(res.volume.volumeCubicM, 13824);
    assert.equal(res.volume.corners.length, 4);
    assert.equal(res.volume.ring.length, 5);
  });

  test('validateAndNormalizeLandVolume rejects over-limit footprint & volume dimensions', () => {
    const tooSmall = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 2,
      depthMeters: 14,
      heightMeters: 18
    });
    assert.equal(tooSmall.ok, false);
    assert.ok(tooSmall.errors.some((e) => /Width must be between/i.test(e)));

    const tooWideArea = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 90,
      depthMeters: 80,
      heightMeters: 18
    });
    assert.equal(tooWideArea.ok, false);
    assert.ok(tooWideArea.errors.some((e) => /Footprint area/i.test(e)));

    const tooTallVolume = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 50,
      depthMeters: 50,
      heightMeters: 220
    });
    assert.equal(tooTallVolume.ok, false);
    assert.ok(tooTallVolume.errors.some((e) => /3D volume/i.test(e)));
  });

  test('footprintsOverlap detects overlapping / rotated boxes vs separated boxes', () => {
    const a = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 20,
      depthMeters: 20,
      rotationDeg: 35
    }).volume;

    const overlappingB = validateAndNormalizeLandVolume({
      lat: 37.77498,
      lng: -122.41935,
      widthMeters: 14,
      depthMeters: 14,
      rotationDeg: 15
    }).volume;
    assert.equal(footprintsOverlap(a, overlappingB), true);

    const separateC = validateAndNormalizeLandVolume({
      lat: 37.7755,
      lng: -122.4194,
      widthMeters: 14,
      depthMeters: 14,
      rotationDeg: 0
    }).volume;
    assert.equal(footprintsOverlap(a, separateC), false);
  });

  test('buildParcelShareUrl and buildLandAcquisitionAgentPrompt encode all multi-property specs', () => {
    const p1 = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 22,
      depthMeters: 18,
      heightMeters: 27,
      rotationDeg: 30
    }).volume;
    const url = buildParcelShareUrl({
      origin: 'https://maximusmaximus.github.io',
      pathname: '/graffiland/',
      parcelId: p1.parcelId,
      lat: p1.centerLat,
      lng: p1.centerLng,
      volume: p1,
      customName: 'Corner Plaza'
    });
    assert.ok(url.includes(`parcel=${p1.parcelId}`));
    assert.ok(url.includes('w=22'));
    assert.ok(url.includes('h=27'));
    assert.ok(url.includes('rot=30'));

    const prompt = buildLandAcquisitionAgentPrompt({
      properties: [
        { ...p1, customName: 'Corner Plaza', shareUrl: url },
        {
          ...validateAndNormalizeLandVolume({
            lat: 37.776,
            lng: -122.418,
            widthMeters: 14,
            depthMeters: 14,
            heightMeters: 18,
            rotationDeg: 0
          }).volume,
          customName: 'North Annex'
        }
      ],
      apiOrigin: 'https://graffiland-api.maxinfeld-artshow.workers.dev',
      publicUrl: 'https://maximusmaximus.github.io/graffiland',
      pairingCode: 'GLP-1111-2222-3333-4444'
    });
    assert.ok(prompt.includes('Total Selected Properties: 2'));
    assert.ok(prompt.includes('Corner Plaza'));
    assert.ok(prompt.includes('North Annex'));
    assert.ok(prompt.includes('GLP-1111-2222-3333-4444'));
    assert.ok(prompt.includes(`max area ${LAND_VOLUME_LIMITS.maxFootprintAreaSqM.toLocaleString()} m²`));
  });
});

describe('3D Land Minting, Volume Editing, Overlap Checks & Location Search API', () => {
  test('Human starter 3D land claim succeeds with gas sponsorship and normalized volume', async () => {
    const res = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        lat: 37.7749,
        lng: -122.4194,
        customName: 'Civic 3D Prism',
        volume: {
          centerLat: 37.7749,
          centerLng: -122.4194,
          widthMeters: 24,
          depthMeters: 16,
          zScale: 2,
          rotationDeg: 35
        }
      })
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.status, 'awakened');
    assert.equal(body.gasSponsored, true);
    assert.equal(body.gasPaidBy, 'platform-relayer');
    assert.equal(body.volume.widthMeters, 24);
    assert.equal(body.volume.depthMeters, 16);
    assert.equal(body.volume.heightMeters, 36);
    assert.equal(body.volume.rotationDeg, 35);
    assert.equal(body.volume.corners.length, 4);
    firstClaimedParcelId = body.parcelId;
  });

  test('Rejects overlapping 3D footprint (409) and oversized volume (400)', async () => {
    const overlapRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherHumanToken}`
      },
      body: JSON.stringify({
        lat: 37.77495,
        lng: -122.41938,
        volume: {
          centerLat: 37.77495,
          centerLng: -122.41938,
          widthMeters: 14,
          depthMeters: 14,
          heightMeters: 18,
          rotationDeg: 10
        }
      })
    });
    assert.equal(overlapRes.status, 409);

    const oversizedRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherHumanToken}`
      },
      body: JSON.stringify({
        lat: 37.785,
        lng: -122.405,
        volume: {
          centerLat: 37.785,
          centerLng: -122.405,
          widthMeters: 100,
          depthMeters: 80,
          heightMeters: 20
        }
      })
    });
    assert.equal(oversizedRes.status, 400);
  });

  test('Owner can update 3D volume & rotation while non-owner is rejected (403)', async () => {
    assert.ok(firstClaimedParcelId);
    const nonOwnerRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/volume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherHumanToken}`
      },
      body: JSON.stringify({ widthMeters: 20, depthMeters: 20, zScale: 1.5, rotationDeg: 90 })
    });
    assert.equal(nonOwnerRes.status, 403);

    const ownerRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/volume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ widthMeters: 30, depthMeters: 20, zScale: 1.5, rotationDeg: 90 })
    });
    const ownerBody = await ownerRes.json();
    assert.equal(ownerRes.status, 200, JSON.stringify(ownerBody));
    assert.equal(ownerBody.volume.widthMeters, 30);
    assert.equal(ownerBody.volume.heightMeters, 27);
    assert.equal(ownerBody.volume.rotationDeg, 90);

    const listRes = await fetch(`${baseUrl}/api/lands`).then((r) => r.json());
    const found = listRes.parcels.find((p) => p.parcelId === firstClaimedParcelId);
    assert.ok(found?.volume);
    assert.equal(found.volume.rotationDeg, 90);
  });

  test('Enforces 3 free starter human claims per user (4th -> 429)', async () => {
    for (const [lat, lng] of [
      [37.791, -122.411],
      [37.796, -122.406]
    ]) {
      const okRes = await fetch(`${baseUrl}/api/lands/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({ lat, lng, volume: { centerLat: lat, centerLng: lng, widthMeters: 12, depthMeters: 12 } })
      });
      assert.equal(okRes.status, 201);
    }

    const fourthRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        lat: 37.801,
        lng: -122.401,
        volume: { centerLat: 37.801, centerLng: -122.401, widthMeters: 12, depthMeters: 12 }
      })
    });
    assert.equal(fourthRes.status, 429);
  });

  test('Location search supports coords, GLAND parcel IDs, and query validation', async () => {
    const shortRes = await fetch(`${baseUrl}/api/geocode/search?q=a`);
    const shortBody = await shortRes.json();
    assert.equal(shortRes.status, 200);
    assert.deepEqual(shortBody.results, []);

    const coordRes = await fetch(`${baseUrl}/api/geocode/search?q=37.7749,-122.4194`);
    const coordBody = await coordRes.json();
    assert.equal(coordRes.status, 200);
    assert.ok(coordBody.results.some((r) => r.category === 'coordinates'));

    const parcelRes = await fetch(`${baseUrl}/api/geocode/search?q=${encodeURIComponent(firstClaimedParcelId)}`);
    const parcelBody = await parcelRes.json();
    assert.equal(parcelRes.status, 200);
    assert.ok(parcelBody.results.some((r) => r.parcelId === firstClaimedParcelId));
  });
});
