import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-no-nested-land-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'no-nested-land.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');
const { encodeGeohash } = await import('../server/services/pol.mjs');
const {
  computeOrientedFootprintLngLat,
  distanceToLandFootprintMeters,
  isPointInLandFootprint
} = await import('../shared/landVolume.mjs');
const { claimDormantLand } = await import('../shared/agentQuestService.mjs');

let server;
let baseUrl;
let ownerToken = '';
let guestToken = '';
let guest2Token = '';
let ownerUser = null;
let guestUser = null;

function makePolPayload(lat, lng) {
  const now = Date.now();
  return {
    gpsSamples: [
      { lat, lng, t: now - 5000 },
      { lat: lat + 0.000005, lng: lng + 0.000005, t: now - 1000 }
    ],
    gyroSamples: 24,
    cameraFrames: 12,
    opticalFlowCorrelation: 0.91,
    horizonLuminance: 145,
    ambientPalette: ['#00f5d4', '#ffd166', '#10182b'],
    visualDHash: 'a1b2c3d4e5f60718',
    cameraFacingMode: 'environment',
    cameraResolution: '1920x1080',
    sculptDurationMs: 11000,
    sceneCoveragePct: 100,
    scannedSectors: 10,
    placementPrecisionMeters: 0.1
  };
}

async function apiJson(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function wrapDb(rawDb) {
  return {
    get: async (sql, params = []) => rawDb.prepare(sql).get(...params),
    all: async (sql, params = []) => rawDb.prepare(sql).all(...params),
    run: async (sql, params = []) => rawDb.prepare(sql).run(...params)
  };
}

before(async () => {
  const { server: srv } = createAppServer({ publishRateLimit: 100, mcpRateLimit: 300 });
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  for (const [email, name, assign] of [
    [
      'dukenukem@graffiland.test',
      'Duke Nukem',
      (res) => {
        ownerToken = res.token;
        ownerUser = res.user;
      }
    ],
    [
      'scribble@graffiland.test',
      'Scribble Artist',
      (res) => {
        guestToken = res.token;
        guestUser = res.user;
      }
    ],
    [
      'wanderer@graffiland.test',
      'Street Wanderer',
      (res) => {
        guest2Token = res.token;
      }
    ]
  ]) {
    const res = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ devProfile: { email, name } })
    });
    assert.equal(res.status, 200);
    assign(res.body);
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore Windows sqlite lock
  }
});

describe('No nested or overlapping land minting when adding art inside an existing land', () => {
  test('distanceToLandFootprintMeters & isPointInLandFootprint handle oriented rectangles accurately', () => {
    const centerLat = 39.7302;
    const centerLng = -121.8406;
    const { corners } = computeOrientedFootprintLngLat({
      lat: centerLat,
      lng: centerLng,
      widthMeters: 54.25,
      depthMeters: 35.66,
      rotationDeg: 25
    });
    const vol = {
      centerLat,
      centerLng,
      widthMeters: 54.25,
      depthMeters: 35.66,
      rotationDeg: 25,
      corners
    };

    assert.equal(distanceToLandFootprintMeters(centerLat, centerLng, vol), 0);
    assert.equal(isPointInLandFootprint(centerLat, centerLng, vol), true);

    // Offset ~15m east and ~8m north — well inside 54.25m x 35.66m footprint
    const insideLat = centerLat + 8 / 111320;
    const insideLng = centerLng + 15 / (111320 * Math.cos((centerLat * Math.PI) / 180));
    assert.equal(distanceToLandFootprintMeters(insideLat, insideLng, vol), 0);
    assert.equal(isPointInLandFootprint(insideLat, insideLng, vol), true);

    // Offset ~60m north — well outside footprint
    const outsideLat = centerLat + 60 / 111320;
    const distOut = distanceToLandFootprintMeters(outsideLat, centerLng, vol);
    assert.ok(distOut > 30, `Expected outside point >30m from edge, got ${distOut}`);
    assert.equal(isPointInLandFootprint(outsideLat, centerLng, vol), false);
  });

  test('Mobile AR publish inside a large multi-geohash custom land attaches art to that land and NEVER mints a nested land', async () => {
    const centerLat = 39.7302;
    const centerLng = -121.8406;
    const centerGeohash = encodeGeohash(centerLat, centerLng, 8);
    const stibblezParcelId = `GLAND-${centerGeohash.toUpperCase()}`;

    // 1) Owner claims a large custom land "Stibblez Land" (178 x 117 ft ~= 54.25m x 35.66m)
    const claimRes = await apiJson('/api/lands/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        parcelId: stibblezParcelId,
        lat: centerLat,
        lng: centerLng,
        customName: 'Stibblez Land',
        volume: {
          centerLat,
          centerLng,
          widthMeters: 54.25,
          depthMeters: 35.66,
          heightMeters: 11,
          rotationDeg: 0
        }
      })
    });
    assert.equal(claimRes.status, 201, `Claim failed: ${JSON.stringify(claimRes.body)}`);

    // 2) Pick an offset point INSIDE Stibblez Land (20m east, 12m north) whose 8-char geohash DIFFERS from center!
    const mPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
    const innerLat = centerLat + 12 / 111320;
    const innerLng = centerLng + 20 / mPerDegLng;
    const innerGeohash = encodeGeohash(innerLat, innerLng, 8);
    assert.notEqual(
      innerGeohash,
      centerGeohash,
      'Test setup requires inner point to land in a different 8-char geohash cell'
    );

    const rawDb = new DatabaseSync(process.env.GRAFFILAND_DB_PATH);
    try {
      const beforeParcel = rawDb
        .prepare('SELECT * FROM land_parcels WHERE parcel_id = ?')
        .get(stibblezParcelId);
      const beforeLandCount = rawDb.prepare('SELECT COUNT(*) AS cnt FROM land_parcels').get().cnt;
      const beforeVolCount = rawDb.prepare('SELECT COUNT(*) AS cnt FROM land_volumes').get().cnt;

      // 3) Guest draws "Scribble" inside Stibblez Land WITHOUT even passing targetParcelId
      //    (proving server enforces geometric containment even if a client omits targetParcelId!)
      const pubRes = await apiJson('/api/sculptures/publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guestToken}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
        },
        body: JSON.stringify({
          title: 'Scribble',
          description: 'Quick mobile AR scribble drawn inside Stibblez Land.',
          termsAccepted: true,
          voxels: [
            { x: 0, y: 0, z: 0, color: '#ff2e93', material: 'neon', scale: 1 },
            { x: 0.2, y: 0.2, z: 0, color: '#00f5d4', material: 'neon', scale: 1 },
            { x: 0.4, y: 0.4, z: 0, color: '#ffd166', material: 'neon', scale: 1 }
          ],
          location: { lat: innerLat, lng: innerLng, accuracy: 4, altitude: 62 },
          proofOfLocation: makePolPayload(innerLat, innerLng),
          deviceProfile: { isMobile: true }
        })
      });

      assert.equal(pubRes.status, 201, `Publish failed: ${JSON.stringify(pubRes.body)}`);
      assert.equal(pubRes.body.sculpture.parcelId, stibblezParcelId);
      assert.equal(pubRes.body.addedToExistingLand, true);
      assert.equal(pubRes.body.mintedNewLand, false);
      assert.equal(pubRes.body.landDisplayName, 'Stibblez Land');

      // Verify ZERO new land_parcels or land_volumes rows were created!
      const afterLandCount = rawDb.prepare('SELECT COUNT(*) AS cnt FROM land_parcels').get().cnt;
      const afterVolCount = rawDb.prepare('SELECT COUNT(*) AS cnt FROM land_volumes').get().cnt;
      assert.equal(afterLandCount, beforeLandCount, 'Must NEVER create a nested land_parcels row');
      assert.equal(afterVolCount, beforeVolCount, 'Must NEVER create a nested land_volumes row');

      // Verify original owner and dimensions of Stibblez Land were preserved intact!
      const afterParcel = rawDb
        .prepare('SELECT * FROM land_parcels WHERE parcel_id = ?')
        .get(stibblezParcelId);
      assert.equal(afterParcel.first_claimant_sub, beforeParcel.first_claimant_sub);
      assert.equal(afterParcel.latest_claimant_address, beforeParcel.latest_claimant_address);
      const afterVol = rawDb
        .prepare('SELECT * FROM land_volumes WHERE parcel_id = ?')
        .get(stibblezParcelId);
      assert.equal(Number(afterVol.width_meters), 54.25);
      assert.equal(Number(afterVol.depth_meters), 35.66);

      // 4) Freeze Stibblez Land and try publishing again from the DIFFERENT geohash inside it -> 403!
      rawDb
        .prepare(
          `INSERT INTO land_settings (parcel_id, owner_sub, owner_address, freeze_placements, updated_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(parcel_id) DO UPDATE SET freeze_placements = 1, updated_at = excluded.updated_at`
        )
        .run(
          stibblezParcelId,
          beforeParcel.first_claimant_sub,
          beforeParcel.first_claimant_address,
          new Date().toISOString()
        );

      const frozenRes = await apiJson('/api/sculptures/publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guest2Token}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
        },
        body: JSON.stringify({
          title: 'Frozen Attempt',
          description: 'Trying to paint inside frozen Stibblez Land from an offset geohash.',
          termsAccepted: true,
          voxels: [
            { x: 0, y: 0, z: 0, color: '#ffffff', material: 'matte', scale: 1 },
            { x: 0.2, y: 0, z: 0, color: '#ffffff', material: 'matte', scale: 1 },
            { x: 0.4, y: 0, z: 0, color: '#ffffff', material: 'matte', scale: 1 }
          ],
          location: { lat: innerLat, lng: innerLng, accuracy: 4, altitude: 62 },
          proofOfLocation: makePolPayload(innerLat, innerLng),
          deviceProfile: { isMobile: true }
        })
      });
      assert.equal(frozenRes.status, 403);
      assert.match(frozenRes.body.error || '', /frozen/i);
      assert.equal(
        rawDb.prepare('SELECT COUNT(*) AS cnt FROM land_parcels').get().cnt,
        beforeLandCount
      );

      // Unfreeze Stibblez Land for remaining tests
      rawDb
        .prepare('UPDATE land_settings SET freeze_placements = 0 WHERE parcel_id = ?')
        .run(stibblezParcelId);

      // 5) Default-volume POST /api/lands/claim on the inner geohash inside Stibblez Land MUST be rejected with 409!
      const nestedClaimRes = await apiJson('/api/lands/claim', {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify({
          lat: innerLat,
          lng: innerLng,
          customName: 'Nested Default Claim'
        })
      });
      assert.equal(
        nestedClaimRes.status,
        409,
        `Expected 409 for default-volume claim inside Stibblez Land, got ${nestedClaimRes.status}: ${JSON.stringify(nestedClaimRes.body)}`
      );
      assert.match(nestedClaimRes.body.error || '', /overlaps/i);

      // Also verify direct service call claimDormantLand without custom volume rejects with 409!
      const wrappedDb = wrapDb(rawDb);
      const guestDbRow = rawDb.prepare('SELECT * FROM users WHERE id = ?').get(guestUser.id);
      await assert.rejects(
        () =>
          claimDormantLand(wrappedDb, {
            agentUser: guestDbRow,
            lat: innerLat,
            lng: innerLng,
            customName: 'Nested Service Claim'
          }),
        (err) => err?.statusCode === 409 && /overlaps/i.test(err?.message || '')
      );

      // 6) Large sculpture published ~5m outside Stibblez Land's edge whose footprint overlaps Stibblez Land -> 409 Conflict!
      const outsideNearLat = centerLat + (35.66 / 2 + 5.2) / 111320;
      const wideVoxels = [];
      for (let x = -7; x <= 7; x += 2) {
        for (let z = -7; z <= 7; z += 2) {
          wideVoxels.push({ x, y: 0, z, color: '#00f5d4', material: 'matte', scale: 1 });
        }
      }
      const overlapRes = await apiJson('/api/sculptures/publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guest2Token}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
        },
        body: JSON.stringify({
          title: 'Wide Overlapping Wall',
          description: 'Starts outside Stibblez Land but spans across its boundary.',
          termsAccepted: true,
          voxels: wideVoxels,
          location: { lat: outsideNearLat, lng: centerLng, accuracy: 4, altitude: 62 },
          proofOfLocation: makePolPayload(outsideNearLat, centerLng),
          deviceProfile: { isMobile: true }
        })
      });
      assert.equal(overlapRes.status, 409, `Expected 409 overlap block, got ${overlapRes.status}: ${JSON.stringify(overlapRes.body)}`);
      assert.equal(overlapRes.body.conflictingParcelId, stibblezParcelId);

      // 7) Publishing in genuinely open unclaimed space (~180m north) DOES mint a brand-new Mobile AR land!
      const openLat = centerLat + 180 / 111320;
      const openLng = centerLng;
      const openRes = await apiJson('/api/sculptures/publish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guest2Token}`,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'
        },
        body: JSON.stringify({
          title: 'Open Plaza Totem',
          description: 'Drawn well outside any existing land parcel.',
          termsAccepted: true,
          voxels: [
            { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon', scale: 1 },
            { x: 0, y: 0.4, z: 0, color: '#ffd166', material: 'neon', scale: 1 },
            { x: 0, y: 0.8, z: 0, color: '#ff2e93', material: 'neon', scale: 1 }
          ],
          location: { lat: openLat, lng: openLng, accuracy: 4, altitude: 62 },
          proofOfLocation: makePolPayload(openLat, openLng),
          deviceProfile: { isMobile: true }
        })
      });
      assert.equal(openRes.status, 201, `Open publish failed: ${JSON.stringify(openRes.body)}`);
      assert.equal(openRes.body.mintedNewLand, true);
      assert.equal(openRes.body.addedToExistingLand, false);
      assert.notEqual(openRes.body.sculpture.parcelId, stibblezParcelId);
      assert.equal(
        rawDb.prepare('SELECT COUNT(*) AS cnt FROM land_parcels').get().cnt,
        beforeLandCount + 1
      );
      assert.ok(ownerUser && guestUser);
    } finally {
      rawDb.close();
    }
  });
});
