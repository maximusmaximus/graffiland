import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LAND_VOLUME_LIMITS } from '../shared/constants.mjs';
import {
  buildMultiObjectFittedLandVolume,
  buildObjectFittedLandVolume,
  buildParcelShareUrl,
  computeCameraAlignedDraftBox,
  computeMaxHeightForFootprint,
  computeObjectVoxelBoundsMeters,
  footprintsOverlap,
  isInternalParcelCode,
  resizeDraftFromEdge,
  resolveLandDisplayName,
  scaleDraftFromCorner,
  scaleFootprintToLimit,
  validateAndNormalizeLandVolume
} from '../shared/landVolume.mjs';
import {
  buildLandAcquisitionAgentPrompt,
  buildLandAdd3DItemAgentPrompt
} from '../shared/landSignatureMessage.mjs';
import { buildSculptures3DGeoJson } from '../client/src/utils/sculpture3dGeoJson.js';
import { computeSculptureMapTransform } from '../client/src/utils/map3dSculptureLayer.js';
import { enforceCrispTexturesAndShading } from '../client/src/utils/customModelLoader.js';
import * as THREE from 'three';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-3d-land-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'land3d.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.GRAFFILAND_ALLOW_PRIVATE_MODEL_HOSTS = '1';
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

  test('computeCameraAlignedDraftBox aligns with Isometric bearing (-45 deg) and caps cleanly to 5,000 m² limit', () => {
    const isoBox = computeCameraAlignedDraftBox({
      startLat: 37.7749,
      startLng: -122.4194,
      endLat: 37.7752,
      endLng: -122.419,
      bearingDeg: -45
    });
    assert.equal(isoBox.rotationDeg, 315);
    assert.ok(isoBox.widthMeters >= LAND_VOLUME_LIMITS.minWidthMeters);
    assert.ok(isoBox.depthMeters >= LAND_VOLUME_LIMITS.minDepthMeters);
    assert.ok(isoBox.footprintAreaSqM <= LAND_VOLUME_LIMITS.maxFootprintAreaSqM);
    assert.equal(isoBox.corners.length, 4);

    // Drag along world East at -45 deg Isometric projects equally onto localX & localY (~373m x 373m) -> caps cleanly at 5,000 m²!
    const hugeSquare = computeCameraAlignedDraftBox({
      startLat: 37.7749,
      startLng: -122.4194,
      endLat: 37.7749,
      endLng: -122.4134,
      bearingDeg: -45
    });
    assert.equal(hugeSquare.rotationDeg, 315);
    assert.equal(hugeSquare.hitLimit, true);
    assert.ok(
      hugeSquare.footprintAreaSqM > 4900 && hugeSquare.footprintAreaSqM <= 5000,
      `Expected ~5000 m² cap, got ${hugeSquare.footprintAreaSqM}`
    );
    const validation = validateAndNormalizeLandVolume(hugeSquare);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));

    // Drag along NE (parallel to screen X-axis at -45 deg) hits maxWidthMeters (120m) cleanly
    const wideStrip = computeCameraAlignedDraftBox({
      startLat: 37.7749,
      startLng: -122.4194,
      endLat: 37.7795,
      endLng: -122.414,
      bearingDeg: -45
    });
    assert.equal(wideStrip.rotationDeg, 315);
    assert.equal(wideStrip.widthMeters, LAND_VOLUME_LIMITS.maxWidthMeters);
    assert.equal(wideStrip.hitLimit, true);
    assert.equal(validateAndNormalizeLandVolume(wideStrip).ok, true);
  });

  test('scaleFootprintToLimit & computeMaxHeightForFootprint scale cleanly to exact platform limits', () => {
    const maxRect = scaleFootprintToLimit({
      widthMeters: 28,
      depthMeters: 14,
      heightMeters: 180,
      ratio: 1
    });
    assert.equal(maxRect.widthMeters, 100);
    assert.equal(maxRect.depthMeters, 50);
    assert.equal(maxRect.footprintAreaSqM, 5000);
    // At 5,000 m², height must auto-clamp from 180m -> 100m so volume stays <= 500,000 m³
    assert.equal(maxRect.heightMeters, 100);
    assert.equal(maxRect.volumeCubicM, 500000);

    const maxSq = scaleFootprintToLimit({
      widthMeters: 14,
      depthMeters: 14,
      heightMeters: 18,
      ratio: 1
    });
    assert.ok(maxSq.footprintAreaSqM > 4980 && maxSq.footprintAreaSqM <= 5000);

    const smallPlotH = computeMaxHeightForFootprint({ widthMeters: 20, depthMeters: 16 });
    assert.equal(smallPlotH.heightMeters, 250);
    const largePlotH = computeMaxHeightForFootprint({ widthMeters: 100, depthMeters: 50 });
    assert.equal(largePlotH.heightMeters, 100);
  });

  test('scaleDraftFromCorner & resizeDraftFromEdge anchor opposite side, preserve rotation & cap to 5,000 m²', () => {
    const base = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 20,
      depthMeters: 20,
      heightMeters: 18,
      rotationDeg: 315
    }).volume;

    // Pull corner 0 (NW in local frame) far outward -> scales cleanly & caps <= 5,000 m²
    const scaled = scaleDraftFromCorner({
      draft: base,
      cornerIndex: 0,
      pointerLat: 37.777,
      pointerLng: -122.423
    });
    assert.ok(scaled);
    assert.equal(scaled.rotationDeg, 315);
    assert.ok(scaled.widthMeters * scaled.depthMeters <= LAND_VOLUME_LIMITS.maxFootprintAreaSqM);
    assert.ok(scaled.widthMeters * scaled.depthMeters > 400);
    // Opposite corner (index 2) remains anchored in place
    const scaledVol = validateAndNormalizeLandVolume(scaled).volume;
    assert.ok(Math.abs(scaledVol.corners[2][0] - base.corners[2][0]) < 1e-4);
    assert.ok(Math.abs(scaledVol.corners[2][1] - base.corners[2][1]) < 1e-4);

    // Pull North edge (edgeIndex=0) outward on an axis-aligned plot -> changes ONLY depthMeters!
    const aligned = validateAndNormalizeLandVolume({
      lat: 37.7749,
      lng: -122.4194,
      widthMeters: 24,
      depthMeters: 16,
      heightMeters: 18,
      rotationDeg: 0
    }).volume;
    const stretchedNorth = resizeDraftFromEdge({
      draft: aligned,
      edgeIndex: 0,
      pointerLat: 37.7753,
      pointerLng: -122.4194
    });
    assert.ok(stretchedNorth);
    assert.equal(stretchedNorth.widthMeters, 24);
    assert.ok(stretchedNorth.depthMeters > 30 && stretchedNorth.depthMeters <= LAND_VOLUME_LIMITS.maxDepthMeters);

    // Pull East edge (edgeIndex=1) outward -> changes ONLY widthMeters!
    const stretchedEast = resizeDraftFromEdge({
      draft: aligned,
      edgeIndex: 1,
      pointerLat: 37.7749,
      pointerLng: -122.4188
    });
    assert.ok(stretchedEast);
    assert.equal(stretchedEast.depthMeters, 16);
    assert.ok(stretchedEast.widthMeters > 35 && stretchedEast.widthMeters <= LAND_VOLUME_LIMITS.maxWidthMeters);
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

  test('Requires unique human land titles, enforces 21 free starter claims (22nd -> 429 + notification), and manages notification APIs', async () => {
    // Missing title rejected (400)
    const missingTitleRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        lat: 37.791,
        lng: -122.411,
        volume: { centerLat: 37.791, centerLng: -122.411, widthMeters: 12, depthMeters: 12 }
      })
    });
    const missingBody = await missingTitleRes.json();
    assert.equal(missingTitleRes.status, 400);
    assert.equal(missingBody.code, 'LAND_TITLE_REQUIRED');

    // Duplicate title rejected (409) & check-name reports unavailable
    const dupCheck = await fetch(
      `${baseUrl}/api/lands/check-name?name=${encodeURIComponent('civic 3d prism')}`
    ).then((r) => r.json());
    assert.equal(dupCheck.ok, true);
    assert.equal(dupCheck.available, false);

    const dupRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        lat: 37.791,
        lng: -122.411,
        customName: 'civic 3d prism',
        volume: { centerLat: 37.791, centerLng: -122.411, widthMeters: 12, depthMeters: 12 }
      })
    });
    const dupBody = await dupRes.json();
    assert.equal(dupRes.status, 409);
    assert.equal(dupBody.code, 'LAND_TITLE_TAKEN');

    // Available title check passes
    const availCheck = await fetch(
      `${baseUrl}/api/lands/check-name?name=${encodeURIComponent('Harbor Sculpture Deck')}`
    ).then((r) => r.json());
    assert.equal(availCheck.ok, true);
    assert.equal(availCheck.available, true);

    const maxStarterClaims = LAND_VOLUME_LIMITS.starterFreeHumanClaims;
    assert.equal(maxStarterClaims, 21);

    // 1 starter land ("Civic 3D Prism") was already claimed above; claim remaining 20 to reach 21/21
    for (let idx = 2; idx <= maxStarterClaims; idx += 1) {
      const lat = Number((37.791 + (idx - 2) * 0.004).toFixed(5));
      const lng = Number((-122.411 + (idx - 2) * 0.004).toFixed(5));
      const customName =
        idx === 2
          ? 'Harbor Sculpture Deck'
          : idx === 3
          ? 'Skyline Mosaic Roof'
          : `Starter Desktop Plot ${idx}`;
      const okRes = await fetch(`${baseUrl}/api/lands/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({
          lat,
          lng,
          customName,
          volume: { centerLat: lat, centerLng: lng, widthMeters: 12, depthMeters: 12 }
        })
      });
      assert.equal(okRes.status, 201, `Expected free starter claim #${idx} to succeed`);
    }

    // 22nd free Desktop claim -> 429 with structured guidance + unbuilt parcels + mobile IRL option + persisted notification
    const overLimitRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        lat: 37.885,
        lng: -122.315,
        customName: 'Over Limit Plot Denied',
        volume: { centerLat: 37.885, centerLng: -122.315, widthMeters: 12, depthMeters: 12 }
      })
    });
    const overLimitBody = await overLimitRes.json();
    assert.equal(overLimitRes.status, 429);
    assert.equal(overLimitBody.code, 'STARTER_FREE_LAND_LIMIT_REACHED');
    assert.equal(overLimitBody.usedSlots, 21);
    assert.equal(overLimitBody.maxSlots, 21);
    assert.equal(overLimitBody.canClaimInPersonMobile, true);
    assert.ok(
      Array.isArray(overLimitBody.unbuiltParcels) && overLimitBody.unbuiltParcels.length === 21
    );

    // Notifications inbox contains the mint_limit_reached alert & live mintStatus
    const notifRes = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${humanToken}` }
    });
    const notifBody = await notifRes.json();
    assert.equal(notifRes.status, 200);
    assert.ok(notifBody.unreadCount >= 1);
    assert.equal(notifBody.mintStatus.canMintDesktop, false);
    assert.equal(notifBody.mintStatus.remainingSlots, 0);
    const limitAlert = notifBody.notifications.find((n) => n.category === 'mint_limit_reached');
    assert.ok(limitAlert, 'Expected mint_limit_reached notification in inbox');
    assert.equal(limitAlert.actionType, 'open_pair_mobile');

    // Notification preferences & browser push toggle persist cleanly
    const prefRes = await fetch(`${baseUrl}/api/notifications/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ browser_push_enabled: true, land_expiring: false })
    });
    const prefBody = await prefRes.json();
    assert.equal(prefRes.status, 200);
    assert.equal(prefBody.preferences.browser_push_enabled, true);
    assert.equal(prefBody.preferences.land_expiring, false);

    // Mark all read & delete notification
    const readRes = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ markAll: true })
    });
    assert.equal((await readRes.json()).unreadCount, 0);

    const delRes = await fetch(`${baseUrl}/api/notifications/${encodeURIComponent(limitAlert.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${humanToken}` }
    });
    assert.equal(delRes.status, 200);

    // Another user publishes a sculpture on human's first land -> fires sculpture_on_land + mint_slots_unlocked!
    const nowPub = Date.now();
    const pubRes = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherHumanToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'Awakening Beacon',
        description: 'IRL beacon on Civic 3D Prism',
        termsAccepted: true,
        location: { lat: 37.7749, lng: -122.4194, accuracy: 5, altitude: 10 },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 1, y: 0, z: 0, color: '#ff3e7f', material: 'neon' },
          { x: 0, y: 1, z: 0, color: '#ffd166', material: 'neon' }
        ],
        proofOfLocation: {
          gpsSamples: [
            { lat: 37.7749, lng: -122.4194, t: nowPub - 4000 },
            { lat: 37.774905, lng: -122.419395, t: nowPub - 1000 }
          ],
          gyroSamples: 20,
          cameraFrames: 10,
          opticalFlowCorrelation: 0.9,
          horizonLuminance: 140,
          ambientPalette: ['#00f5d4', '#1a2b4c'],
          visualDHash: 'a1b2c3d4e5f60718',
          cameraFacingMode: 'environment',
          cameraResolution: '1920x1080',
          sculptDurationMs: 12000,
          sceneCoveragePct: 100
        },
        deviceProfile: { isMobile: true, screenWidth: 390, screenHeight: 844, hasCamera: true }
      })
    });
    const pubBody = await pubRes.json();
    assert.equal(pubRes.status, 201, JSON.stringify(pubBody));

    const afterPubNotifs = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${humanToken}` }
    }).then((r) => r.json());
    assert.equal(afterPubNotifs.mintStatus.canMintDesktop, true);
    assert.equal(afterPubNotifs.mintStatus.remainingSlots, 1);
    const ownerArtNotif = afterPubNotifs.notifications.find(
      (n) => n.category === 'sculpture_on_land' && n.sculptureId === pubBody.sculpture.id
    );
    assert.ok(ownerArtNotif, 'Expected sculpture_on_land notification for land owner');
    assert.equal(ownerArtNotif.actionType, 'open_sculpture');
    assert.equal(
      ownerArtNotif.meta?.sculptureUrl,
      `?sculpture=${encodeURIComponent(pubBody.sculpture.id)}`
    );
    assert.ok(
      afterPubNotifs.notifications.some((n) => n.category === 'mint_slots_unlocked'),
      'Expected mint_slots_unlocked notification when unbuilt land gets first sculpture'
    );

    // A third artist mints new art on the same land -> BOTH owner AND prior contributor (otherToken)
    // receive sculpture_on_land notifications with direct links to the newly minted art!
    const thirdLogin = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: {
          email: 'third-contributor-alert@graffiland.test',
          name: 'Third Artist'
        }
      })
    }).then((r) => r.json());
    const thirdToken = thirdLogin.token;

    const nowPub2 = Date.now() + 5000;
    const pub2Res = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${thirdToken}`,
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      },
      body: JSON.stringify({
        title: 'Contributor Alert Beacon',
        description: 'Second sculpture minted on the same land to notify owner and prior contributors.',
        termsAccepted: true,
        voxels: [
          { x: 0.4, y: 0, z: 0.4, color: '#ff006e', material: 'neon' },
          { x: 0.4, y: 0.2, z: 0.4, color: '#00f5d4', material: 'neon' },
          { x: 0.4, y: 0.4, z: 0.4, color: '#ffd166', material: 'neon' }
        ],
        location: { lat: 37.7749, lng: -122.4194, altitude: 10, accuracy: 5, heading: 90 },
        proofOfLocation: {
          gpsSamples: [
            { lat: 37.7749, lng: -122.4194, t: nowPub2 - 4000 },
            { lat: 37.774905, lng: -122.419395, t: nowPub2 - 1000 }
          ],
          gyroSamples: 20,
          cameraFrames: 10,
          opticalFlowCorrelation: 0.9,
          horizonLuminance: 145,
          ambientPalette: ['#ff006e', '#00f5d4'],
          visualDHash: 'f1e2d3c4b5a69788',
          cameraFacingMode: 'environment',
          cameraResolution: '1920x1080',
          sculptDurationMs: 12000,
          sceneCoveragePct: 100
        },
        deviceProfile: { isMobile: true, screenWidth: 390, screenHeight: 844, hasCamera: true }
      })
    });
    const pub2Body = await pub2Res.json();
    assert.equal(pub2Res.status, 201, JSON.stringify(pub2Body));

    const [ownerNotifs2, contribNotifs2, actorNotifs2] = await Promise.all([
      fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${humanToken}` }
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${otherHumanToken}` }
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${thirdToken}` }
      }).then((r) => r.json())
    ]);

    const ownerSecondArt = ownerNotifs2.notifications.find(
      (n) => n.category === 'sculpture_on_land' && n.sculptureId === pub2Body.sculpture.id
    );
    const contribSecondArt = contribNotifs2.notifications.find(
      (n) => n.category === 'sculpture_on_land' && n.sculptureId === pub2Body.sculpture.id
    );
    const actorSelfArt = actorNotifs2.notifications.find(
      (n) => n.category === 'sculpture_on_land' && n.sculptureId === pub2Body.sculpture.id
    );

    assert.ok(ownerSecondArt, 'Expected land owner to be notified of new art');
    assert.equal(ownerSecondArt.actionType, 'open_sculpture');
    assert.equal(
      ownerSecondArt.meta?.sculptureUrl,
      `?sculpture=${encodeURIComponent(pub2Body.sculpture.id)}`
    );
    assert.ok(contribSecondArt, 'Expected prior land contributor to be notified of new art');
    assert.equal(contribSecondArt.actionType, 'open_sculpture');
    assert.equal(contribSecondArt.meta?.recipientRole, 'contributor');
    assert.equal(
      contribSecondArt.meta?.sculptureUrl,
      `?sculpture=${encodeURIComponent(pub2Body.sculpture.id)}`
    );
    assert.equal(actorSelfArt, undefined, 'Artist who just minted should not get a self-alert');
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

  test('buildSculptures3DGeoJson converts voxel sculptures and custom 3D models into MapLibre 3D extrusions', () => {
    const out = buildSculptures3DGeoJson(
      [
        {
          id: 'sc-voxel-1',
          title: 'Neon Tower',
          parcelId: 'GLAND-9Q8YYK8Y',
          lat: 37.7749,
          lng: -122.4194,
          modelType: 'voxel',
          voxels: [
            { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
            { x: 0, y: 0.05, z: 0, color: '#00f5d4', material: 'neon' },
            { x: 0.05, y: 0, z: 0, color: '#ff3e7f', material: 'matte' }
          ],
          anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 15 }
        },
        {
          id: 'sc-glb-2',
          title: 'Cyber Statue',
          parcelId: 'GLAND-9Q8YYK8Y',
          lat: 37.775,
          lng: -122.4193,
          modelType: 'custom-3d',
          customModel: { format: 'glb', scale: 1.2 },
          voxels: []
        },
        {
          id: 'sc-hidden-3',
          title: 'Hidden Piece',
          lat: 37.775,
          lng: -122.4193,
          hidden: true,
          voxels: [{ x: 0, y: 0, z: 0, color: '#ffffff' }]
        }
      ],
      'sc-voxel-1'
    );
    assert.equal(out.renderedCount, 2);
    // True 1:1 un-autoscaled sizes: 2-block voxel (0.05m step -> 0.10m + small base pad) and 1.4m × 1.2 scale custom model (1.68m)
    const voxelMaxH = Math.max(
      ...out.geojson.features
        .filter((f) => f.properties.sculptureId === 'sc-voxel-1')
        .map((f) => Number(f.properties.heightMeters || 0))
    );
    assert.ok(voxelMaxH > 0.08 && voxelMaxH < 0.25, `Expected un-autoscaled voxel height ~0.12m, got ${voxelMaxH}`);
    const glbMaxH = Math.max(
      ...out.geojson.features
        .filter((f) => f.properties.sculptureId === 'sc-glb-2')
        .map((f) => Number(f.properties.heightMeters || 0))
    );
    assert.ok(glbMaxH > 1.5 && glbMaxH < 2.0, `Expected un-autoscaled 1.2x custom model height ~1.68m, got ${glbMaxH}`);
    assert.equal(out.geojson.features.some((f) => f.properties.sculptureId === 'sc-hidden-3'), false);

    const prompt = buildLandAdd3DItemAgentPrompt({
      parcel: { parcelId: firstClaimedParcelId, volume: { widthMeters: 30, depthMeters: 20, heightMeters: 27, rotationDeg: 90 } },
      itemFormat: 'glb',
      itemTitle: 'Dragon Portal',
      existingSculptures: [{ id: 'sc-voxel-1', title: 'Neon Tower', voxelCount: 3 }],
      pairingCode: 'GLP-1234-5678-ABCD-EFGH'
    });
    assert.ok(prompt.includes('load_3d_model_on_land'));
    assert.ok(prompt.includes('update_land_sculpture'));
    assert.ok(prompt.includes('set_sculpture_visibility'));
    assert.ok(prompt.includes('update_land_settings'));
    assert.ok(prompt.includes('Dragon Portal'));
  });

  test('Land Owner can modify & hide/unhide another artist artwork on their land, and freeze/unfreeze land placements', async () => {
    assert.ok(firstClaimedParcelId);

    // 1) Newly minted empty parcel appears immediately in Owner A's /api/lands/mine workspace
    const mineBefore = await fetch(`${baseUrl}/api/lands/mine`, {
      headers: { Authorization: `Bearer ${humanToken}` }
    }).then((r) => r.json());
    assert.ok(
      mineBefore.parcels.some((p) => p.parcelId === firstClaimedParcelId),
      'Expected minted desktop land to appear in /api/lands/mine immediately'
    );

    // 2) Visitor B places an IRL artwork onto Owner A's land while it is open
    const visitorPub = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherHumanToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'Visitor Street Piece',
        description: 'Colorful outdoor 3D voxel tag placed on someone else land parcel.',
        termsAccepted: true,
        deviceProfile: { isMobile: true },
        location: { lat: 37.7749, lng: -122.4194, altitude: 14, accuracy: 8, heading: 40, timezone: 'America/Los_Angeles' },
        proofOfLocation: {
          cameraFrames: 8,
          gyroSamples: 12,
          opticalFlowCorrelation: 0.9,
          horizonLuminance: 135,
          visualDHash: 'ab12cd34ef567890',
          ambientPalette: ['#00f5d4', '#ff3e7f'],
          gpsSamples: [
            { lat: 37.7749, lng: -122.4194, ts: Date.now() - 2500 },
            { lat: 37.77491, lng: -122.41941, ts: Date.now() }
          ]
        },
        voxels: [
          { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' },
          { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'matte' },
          { x: 0.05, y: 0.05, z: 0, color: '#ffd166', material: 'glass' }
        ]
      })
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(visitorPub.status, 201, JSON.stringify(visitorPub.body));
    const visitorSculptureId = visitorPub.body.sculpture.id;
    assert.equal(visitorPub.body.sculpture.parcelId, firstClaimedParcelId);

    // 3) Land Owner A modifies Visitor B's artwork placed on Owner A's land (title, description & anchorOffset)
    const ownerEditRes = await fetch(`${baseUrl}/api/sculptures/${visitorSculptureId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        title: 'Curated Street Piece',
        description: 'Repositioned and curated cleanly by the Virtual Land owner.',
        anchorOffset: { dx: 1.5, dy: 0.5, dz: -1.0, yaw: 45 }
      })
    });
    const ownerEditBody = await ownerEditRes.json();
    assert.equal(ownerEditRes.status, 200, JSON.stringify(ownerEditBody));
    assert.equal(ownerEditBody.editorRole, 'land-owner');
    assert.equal(ownerEditBody.sculpture.title, 'Curated Street Piece');
    assert.equal(ownerEditBody.sculpture.anchorOffset.dx, 1.5);
    assert.equal(ownerEditBody.sculpture.anchorOffset.yaw, 45);

    // 4) Land Owner A hides Visitor B's artwork -> disappears from public feed, stays manageable for owner, then unhides cleanly
    const hideRes = await fetch(`${baseUrl}/api/sculptures/${visitorSculptureId}/visibility`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ hidden: true, reason: 'Temporary curation hold' })
    });
    const hideBody = await hideRes.json();
    assert.equal(hideRes.status, 200, JSON.stringify(hideBody));
    assert.equal(hideBody.hidden, true);

    const publicAfterHide = await fetch(`${baseUrl}/api/sculptures`).then((r) => r.json());
    assert.equal(publicAfterHide.sculptures.some((s) => s.id === visitorSculptureId), false);

    const mineHidden = await fetch(`${baseUrl}/api/lands/mine`, {
      headers: { Authorization: `Bearer ${humanToken}` }
    }).then((r) => r.json());
    const ownedParcel = mineHidden.parcels.find((p) => p.parcelId === firstClaimedParcelId);
    assert.ok(ownedParcel.sculptures.some((s) => s.id === visitorSculptureId && s.hidden === true));

    const unhideRes = await fetch(`${baseUrl}/api/sculptures/${visitorSculptureId}/visibility`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ hidden: false })
    });
    assert.equal(unhideRes.status, 200);
    const publicAfterUnhide = await fetch(`${baseUrl}/api/sculptures`).then((r) => r.json());
    assert.equal(publicAfterUnhide.sculptures.some((s) => s.id === visitorSculptureId), true);

    // 5) Land Owner A freezes the land -> blocks both public mobile publishes AND direct land placements (403)
    const freezeRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ frozen: true })
    });
    const freezeBody = await freezeRes.json();
    assert.equal(freezeRes.status, 200, JSON.stringify(freezeBody));
    assert.equal(freezeBody.settings.frozen, true);

    const landsCheck = await fetch(`${baseUrl}/api/lands`).then((r) => r.json());
    assert.equal(landsCheck.parcels.find((p) => p.parcelId === firstClaimedParcelId)?.frozen, true);

    const blockedPublish = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${otherHumanToken}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'
      },
      body: JSON.stringify({
        title: 'Blocked While Frozen',
        description: 'Attempting to place a sculpture on a frozen Virtual Land parcel.',
        termsAccepted: true,
        deviceProfile: { isMobile: true },
        location: { lat: 37.7749, lng: -122.4194, altitude: 14, accuracy: 8, heading: 40, timezone: 'America/Los_Angeles' },
        proofOfLocation: {
          cameraFrames: 8,
          gyroSamples: 12,
          opticalFlowCorrelation: 0.9,
          horizonLuminance: 135,
          visualDHash: 'ab12cd34ef567890',
          ambientPalette: ['#00f5d4'],
          gpsSamples: [
            { lat: 37.7749, lng: -122.4194, ts: Date.now() - 2500 },
            { lat: 37.77491, lng: -122.41941, ts: Date.now() }
          ]
        },
        voxels: [{ x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon' }]
      })
    });
    assert.equal(blockedPublish.status, 403);

    const blockedDirectCreate = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/sculptures`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        title: 'Blocked Direct Item',
        description: 'Cannot place directly while land is frozen.',
        voxels: [{ x: 0, y: 0, z: 0, color: '#ffd166', material: 'neon' }]
      })
    });
    assert.equal(blockedDirectCreate.status, 403);

    // 6) Unfreezing restores normal placements cleanly
    const unfreezeRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({ frozen: false })
    });
    assert.equal(unfreezeRes.status, 200);
    const allowedDirectCreate = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/sculptures`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        title: 'Unfrozen Sculpture OK',
        description: 'Placed cleanly right after owner unfroze this Virtual Land.',
        voxels: [{ x: 0, y: 0, z: 0, color: '#ffd166', material: 'neon' }]
      })
    });
    assert.equal(allowedDirectCreate.status, 200);
  });

  test('Direct 3D model URL validation & upload, land name/description update, and public slug lookup', async () => {
    const http = await import('node:http');
    const sampleObj = [
      'o PyramidMesh',
      'v 0 0 0',
      'v 1 0 0',
      'v 0.5 1 0',
      'v 0.5 0 1',
      'f 1 2 3',
      'f 1 2 4',
      'f 2 3 4',
      'f 3 1 4'
    ].join('\n');

    const assetServer = http.createServer((req, res) => {
      if (req.url === '/models/neon-pyramid.obj') {
        res.writeHead(200, { 'Content-Type': 'model/obj' });
        res.end(sampleObj);
        return;
      }
      if (req.url === '/models/bad.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('just plain text not a 3d mesh');
        return;
      }
      if (req.url === '/models/giant-tower.obj') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(
          [
            '# Giant 120m tower',
            'v 0 0 0',
            'v 80 0 0',
            'v 40 120 80',
            'f 1 2 3'
          ].join('\n')
        );
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise((r) => assetServer.listen(0, '127.0.0.1', r));
    const assetBase = `http://127.0.0.1:${assetServer.address().port}`;

    try {
      // 1) Validate valid .obj URL -> 200 valid: true
      const okValRes = await fetch(`${baseUrl}/api/models/validate-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({ modelUrl: `${assetBase}/models/neon-pyramid.obj` })
      });
      const okVal = await okValRes.json();
      assert.equal(okValRes.status, 200, JSON.stringify(okVal));
      assert.equal(okVal.valid, true);
      assert.equal(okVal.format, 'obj');
      assert.equal(okVal.stats.triangleCount, 4);
      assert.equal(okVal.suggestedTitle, 'neon pyramid');

      // 2) Reject unsupported plain text link -> 400 valid: false
      const badValRes = await fetch(`${baseUrl}/api/models/validate-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({ modelUrl: `${assetBase}/models/bad.txt` })
      });
      const badVal = await badValRes.json();
      assert.equal(badValRes.status, 400);
      assert.equal(badVal.valid, false);

      // 2b) Pre-flight validate oversized URL against target parcelId -> returns landFit.fits === false + exact maxSafeScale
      const giantValRes = await fetch(`${baseUrl}/api/models/validate-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({
          modelUrl: `${assetBase}/models/giant-tower.obj`,
          parcelId: firstClaimedParcelId,
          modelScale: 1
        })
      });
      const giantVal = await giantValRes.json();
      assert.equal(giantValRes.status, 200, JSON.stringify(giantVal));
      assert.equal(giantVal.valid, true);
      assert.equal(giantVal.stats.bboxUnits, 'native-meters');
      assert.equal(giantVal.landFit?.fits, false);
      assert.equal(giantVal.landFit?.reason, 'exceeds_land_bounds');
      assert.ok(giantVal.landFit?.maxSafeScale > 0 && giantVal.landFit?.maxSafeScale < 1);

      // 2c) Direct REST upload of oversized model onto parcel -> hard-rejected 409 with exact maxSafeScale
      const oversizedUpRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/sculptures`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({
          title: 'Oversized Tower',
          description: 'Oversized 120m tower should be blocked by land boundary guardrail.',
          modelUrl: `${assetBase}/models/giant-tower.obj`,
          modelScale: 1
        })
      });
      const oversizedUp = await oversizedUpRes.json();
      assert.equal(oversizedUpRes.status, 409, JSON.stringify(oversizedUp));
      assert.equal(oversizedUp.code, 'exceeds_land_bounds');
      assert.ok(oversizedUp.maxSafeScale > 0 && oversizedUp.maxSafeScale < 1);

      // 3) Upload validated URL directly onto owned parcel (without requiring manual modelFormat)
      const upRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/sculptures`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({
          title: 'URL Pyramid Statue',
          description: 'Directly uploaded from validated Wavefront OBJ model URL.',
          modelUrl: `${assetBase}/models/neon-pyramid.obj`
        })
      });
      const upBody = await upRes.json();
      assert.equal(upRes.status, 200, JSON.stringify(upBody));
      assert.equal(upBody.sculpture.modelType, 'custom-3d');
      assert.equal(upBody.sculpture.customModel.format, 'obj');

      // 4) Update Land Name & Description under Land Management -> resolves by parcelId AND slug
      const updRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${humanToken}`
        },
        body: JSON.stringify({
          customName: 'Sunset Neon Courtyard',
          description: 'Open rooftop plaza for glowing AR voxel art and custom 3D statues.'
        })
      });
      const updBody = await updRes.json();
      assert.equal(updRes.status, 200, JSON.stringify(updBody));
      assert.equal(updBody.parcel.customName, 'Sunset Neon Courtyard');
      assert.equal(
        updBody.parcel.description,
        'Open rooftop plaza for glowing AR voxel art and custom 3D statues.'
      );
      assert.equal(updBody.parcel.slug, 'sunset-neon-courtyard');
      assert.ok(updBody.parcel.shareUrl.includes('slug=sunset-neon-courtyard'));

      // Public lookup by slug
      const bySlugRes = await fetch(`${baseUrl}/api/lands/sunset-neon-courtyard`);
      const bySlug = await bySlugRes.json();
      assert.equal(bySlugRes.status, 200, JSON.stringify(bySlug));
      assert.equal(bySlug.parcel.parcelId, firstClaimedParcelId);
      assert.equal(bySlug.parcel.customName, 'Sunset Neon Courtyard');
      assert.equal(
        bySlug.parcel.description,
        'Open rooftop plaza for glowing AR voxel art and custom 3D statues.'
      );
      assert.ok(bySlug.sculptures.some((s) => s.title === 'URL Pyramid Statue'));
    } finally {
      await new Promise((r) => assetServer.close(r));
    }
  });

  test('buildObjectFittedLandVolume centers land around drawn object with exact 10% padding in all 3 dimensions and 3D voxels stay inside', async () => {
    // 1) Pure geometry check matching live drawn sculpture bounds (X=[-2.15..0.15], Y=[0.45..2.0], Z=[0.1..2.5])
    const magnoliaVoxels = [
      { x: -2.15, y: 0.45, z: 0.1, color: '#ff3e7f' },
      { x: -1.0, y: 1.2, z: 1.3, color: '#00f5d4' },
      { x: 0.15, y: 2.0, z: 2.5, color: '#ffd166' }
    ];
    const bounds = computeObjectVoxelBoundsMeters(magnoliaVoxels);
    assert.ok(bounds);
    // Including VOXEL_STEP=0.05 half-block thickness on each face:
    // W = (0.15 - (-2.15)) + 0.05 = 2.35 m, D = (2.5 - 0.1) + 0.05 = 2.45 m, H = (2.0 - 0.45) + 0.05 = 1.60 m
    assert.equal(bounds.widthMeters, 2.35);
    assert.equal(bounds.depthMeters, 2.45);
    assert.equal(bounds.heightMeters, 1.6);

    const fitted = buildObjectFittedLandVolume({
      parcelId: 'GLAND-9R16561P',
      geohash: '9r16561p',
      lat: 39.738873,
      lng: -121.847904,
      voxels: magnoliaVoxels,
      paddingFraction: 0.1
    });
    assert.ok(fitted);
    // Centered directly on the object anchor (never offset onto a geohash edge!)
    assert.equal(fitted.centerLat, 39.738873);
    assert.equal(fitted.centerLng, -121.847904);
    // Exact 10% padding on EVERY side => 1.20x total span in W, D, and H
    assert.equal(fitted.widthMeters, 2.82);
    assert.equal(fitted.depthMeters, 2.94);
    assert.equal(fitted.heightMeters, 1.92);
    assert.equal(fitted.corners.length, 4);

    // Corners must be strictly symmetric around object center (object is dead center, NOT on edge)
    const avgLng = fitted.corners.reduce((s, c) => s + c[0], 0) / 4;
    const avgLat = fitted.corners.reduce((s, c) => s + c[1], 0) / 4;
    assert.ok(Math.abs(avgLat - 39.738873) < 1e-6);
    assert.ok(Math.abs(avgLng - -121.847904) < 1e-6);

    // 2) Multi-object fallback wraps both sculptures centered with 10% padding
    const multiFit = buildMultiObjectFittedLandVolume({
      parcelId: 'GLAND-MULTI',
      sculptures: [
        { lat: 37.775, lng: -122.419, voxels: magnoliaVoxels },
        { lat: 37.77504, lng: -122.41895, voxels: magnoliaVoxels }
      ],
      paddingFraction: 0.1
    });
    assert.ok(multiFit);
    assert.ok(multiFit.widthMeters > fitted.widthMeters);
    assert.ok(multiFit.depthMeters > fitted.depthMeters);
    assert.equal(multiFit.heightMeters, 1.92);

    // 3) 3D voxel extrusion GeoJSON keeps EVERY voxel inside the 10%-padded parcel prism in X, Z, and Y
    const sc3d = buildSculptures3DGeoJson(
      [
        {
          id: 'sc-mag',
          title: 'Magnolia',
          parcelId: 'GLAND-9R16561P',
          lat: 39.738873,
          lng: -121.847904,
          voxels: magnoliaVoxels
        }
      ],
      'sc-mag',
      [{ parcelId: 'GLAND-9R16561P', volume: fitted }]
    );
    assert.equal(sc3d.renderedCount, 1);
    const parcelMinLng = Math.min(...fitted.corners.map((c) => c[0]));
    const parcelMaxLng = Math.max(...fitted.corners.map((c) => c[0]));
    const parcelMinLat = Math.min(...fitted.corners.map((c) => c[1]));
    const parcelMaxLat = Math.max(...fitted.corners.map((c) => c[1]));
    const voxelFeats = sc3d.geojson.features.filter((f) => f.properties.part === 'voxel');
    assert.ok(voxelFeats.length >= 3);
    for (const f of voxelFeats) {
      assert.ok(f.properties.baseMeters > 0, 'Bottom 10% padding keeps voxels above 0m floor');
      assert.ok(
        f.properties.heightMeters < fitted.heightMeters,
        `Top voxel (${f.properties.heightMeters}m) must stay inside padded land height (${fitted.heightMeters}m)`
      );
      for (const [lng, lat] of f.geometry.coordinates[0]) {
        assert.ok(lng > parcelMinLng && lng < parcelMaxLng, 'Voxel lng must stay strictly inside padded land');
        assert.ok(lat > parcelMinLat && lat < parcelMaxLat, 'Voxel lat must stay strictly inside padded land');
      }
    }

    // 4) End-to-end POST /api/sculptures/publish persists centered 10%-padded land volume
    const drawLat = 37.781234;
    const drawLng = -122.405678;
    const drawVoxels = [
      { x: 0, y: 0, z: 0, color: '#00f5d4' },
      { x: 1.95, y: 0.95, z: 1.45, color: '#ff3e7f' },
      { x: 1.0, y: 0.5, z: 0.75, color: '#ffd166' }
    ];
    // Raw size = 2.00 x 1.50 x 1.00 m -> 10% padding per side => 2.40 x 1.80 x 1.20 m
    const now = Date.now();
    const pubRes = await fetch(`${baseUrl}/api/sculptures/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        title: 'Centered Padded Cube',
        description: 'Drawn object that should center its own 10%-padded land',
        termsAccepted: true,
        voxels: drawVoxels,
        location: { lat: drawLat, lng: drawLng, accuracy: 5, altitude: 10 },
        proofOfLocation: {
          gpsSamples: [
            { lat: drawLat, lng: drawLng, t: now - 4000 },
            { lat: drawLat + 0.00001, lng: drawLng - 0.00001, t: now - 1000 }
          ],
          gyroSamples: 20,
          cameraFrames: 10,
          opticalFlowCorrelation: 0.9,
          horizonLuminance: 140,
          ambientPalette: ['#00f5d4', '#1a2b4c'],
          visualDHash: 'f0e1d2c3b4a59687',
          cameraFacingMode: 'environment',
          cameraResolution: '1920x1080',
          sculptDurationMs: 12000,
          sceneCoveragePct: 100
        },
        deviceProfile: { isMobile: true, screenWidth: 390, screenHeight: 844, hasCamera: true }
      })
    });
    const pubBody = await pubRes.json();
    assert.equal(pubRes.status, 201, JSON.stringify(pubBody));
    const drawnParcelId = pubBody.sculpture.parcelId;

    const landRes = await fetch(`${baseUrl}/api/lands/${drawnParcelId}`);
    const landBody = await landRes.json();
    assert.equal(landRes.status, 200, JSON.stringify(landBody));
    // Published voxels are centered on (0, 0) in XZ and the land center matches the shifted sculpture world center!
    const pubBounds = computeObjectVoxelBoundsMeters(pubBody.sculpture.voxels || []);
    assert.ok(pubBounds && Math.abs(pubBounds.midX) < 1e-3 && Math.abs(pubBounds.midZ) < 1e-3);
    assert.equal(landBody.parcel.volume.centerLat, Number(pubBody.sculpture.lat.toFixed(6)));
    assert.equal(landBody.parcel.volume.centerLng, Number(pubBody.sculpture.lng.toFixed(6)));
    assert.equal(landBody.parcel.volume.widthMeters, 2.4);
    assert.equal(landBody.parcel.volume.depthMeters, 1.8);
    assert.equal(landBody.parcel.volume.heightMeters, 1.2);
  });

  test('Renaming a land immediately propagates the latest owner name across lands, sculptures, profiles, and notifications without GLAND codes', async () => {
    assert.ok(firstClaimedParcelId);

    // Rename the land via update endpoint
    const renameRes = await fetch(`${baseUrl}/api/lands/${firstClaimedParcelId}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${humanToken}`
      },
      body: JSON.stringify({
        customName: 'Sunset Palm Sanctuary',
        description: 'Latest owner-renamed virtual sculpture garden.'
      })
    });
    const renameBody = await renameRes.json();
    assert.equal(renameRes.status, 200, JSON.stringify(renameBody));
    assert.equal(renameBody.parcel.customName, 'Sunset Palm Sanctuary');
    assert.equal(renameBody.parcel.displayName, 'Sunset Palm Sanctuary');

    // /api/parcels and /api/lands expose the latest name
    const parcelsRes = await fetch(`${baseUrl}/api/parcels`).then((r) => r.json());
    const foundParcel = (parcelsRes.parcels || []).find((p) => p.parcelId === firstClaimedParcelId);
    assert.ok(foundParcel);
    assert.equal(foundParcel.customName, 'Sunset Palm Sanctuary');
    assert.equal(foundParcel.displayName, 'Sunset Palm Sanctuary');

    // /api/sculptures joins parcel_curations so every sculpture carries the latest owner land name
    const scListRes = await fetch(`${baseUrl}/api/sculptures?parcel=${firstClaimedParcelId}`).then((r) =>
      r.json()
    );
    assert.ok((scListRes.sculptures || []).length >= 1);
    for (const sc of scListRes.sculptures) {
      assert.equal(sc.parcelName, 'Sunset Palm Sanctuary');
      assert.equal(sc.landDisplayName, 'Sunset Palm Sanctuary');
    }

    // Pure helpers never treat GLAND-... as a display name
    assert.equal(isInternalParcelCode('GLAND-9R16561P'), true);
    assert.equal(isInternalParcelCode('Twin Palms'), false);
    assert.equal(
      resolveLandDisplayName({ parcelId: 'GLAND-9R16561P', customName: 'GLAND-9R16561P', firstSculptureTitle: 'Magnolia' }),
      'Magnolia Land'
    );
  });

  test('HD 3D map transform preserves exact 1:1 un-autoscaled object size, full-resolution voxel GeoJSON, and crisp linear texture enforcement', () => {
    // 1) Custom 3D model (.glb) inside a large land is NEVER autoscaled — preserves exact 1:1 native size × user scale
    const glbTransform = computeSculptureMapTransform(
      {
        id: 'sc-tree',
        lat: 39.728365,
        lng: -121.838894,
        modelType: 'custom-3d',
        customModel: { format: 'glb', scale: 1, rotationY: 0 }
      },
      {
        centerLat: 39.728305,
        centerLng: -121.838863,
        widthMeters: 67.7,
        depthMeters: 73.7,
        heightMeters: 100.2,
        baseAltitudeM: 0
      },
      { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1.4, z: 0.5 } }
    );
    assert.ok(glbTransform);
    assert.equal(glbTransform.scale, 1, 'Objects placed into lands must NOT be autoscaled');
    assert.equal(glbTransform.renderedSize.x, 1);
    assert.equal(glbTransform.renderedSize.y, 1.4);
    assert.equal(glbTransform.renderedSize.z, 1);
    assert.equal(glbTransform.altitudeMeters, 0);

    // 1b) Explicit user scale is respected directly without shrinking/clamping to a smaller parcel
    const scaledTransform = computeSculptureMapTransform(
      {
        id: 'sc-big',
        lat: 39.728365,
        lng: -121.838894,
        modelType: 'custom-3d',
        customModel: { format: 'glb', scale: 2.5, rotationY: 0 }
      },
      {
        centerLat: 39.728305,
        centerLng: -121.838863,
        widthMeters: 3,
        depthMeters: 3,
        heightMeters: 3,
        baseAltitudeM: 0
      },
      { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } }
    );
    assert.ok(scaledTransform);
    assert.equal(scaledTransform.scale, 2.5);
    assert.equal(scaledTransform.renderedSize.x, 5);
    assert.equal(scaledTransform.renderedSize.y, 5);

    // 2) Small object-fitted parcel preserves exact 10%-padded vertical centering with scale === 1 (zero autoscaling)
    const tightTransform = computeSculptureMapTransform(
      { id: 'sc-tight', lat: 37.78, lng: -122.4 },
      {
        centerLat: 37.78,
        centerLng: -122.4,
        widthMeters: 2.4,
        depthMeters: 2.4,
        heightMeters: 2.4,
        baseAltitudeM: 0
      },
      { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } }
    );
    assert.ok(tightTransform);
    assert.equal(tightTransform.scale, 1);
    assert.equal(tightTransform.renderedSize.x, 2);
    assert.equal(tightTransform.renderedSize.y, 2);
    assert.equal(tightTransform.altitudeMeters, 0.2);

    // 3) 268-block voxel sculpture is NOT downsampled/pixelated (stride stays 1, all unique XZ columns preserved)
    const voxels268 = [];
    for (let i = 0; i < 268; i++) {
      voxels268.push({
        x: (i % 19) * 0.05,
        y: Math.floor(i / 19) * 0.05,
        z: Math.floor(i / 14) * 0.05,
        color: '#00f5d4',
        material: 'matte'
      });
    }
    const hdGeo = buildSculptures3DGeoJson(
      [{ id: 'sc-268', parcelId: 'GLAND-9R16561P', lat: 39.7388, lng: -121.8479, voxels: voxels268 }],
      '',
      [{ parcelId: 'GLAND-9R16561P', volume: { widthMeters: 14, depthMeters: 14, heightMeters: 18 } }]
    );
    const voxelFeatureCount = hdGeo.geojson.features.filter((f) => f.properties.part === 'voxel').length;
    assert.ok(
      voxelFeatureCount >= 240,
      `Expected full-resolution voxel columns (>=240) without pixelating downsampling, got ${voxelFeatureCount}`
    );

    // 4) enforceCrispTexturesAndShading overrides NearestFilter pixelation to smooth Linear / LinearMipmapLinear + anisotropy
    const mipTex = new THREE.DataTexture(new Uint8Array([255, 0, 128, 255]), 1, 1);
    mipTex.generateMipmaps = true;
    mipTex.magFilter = THREE.NearestFilter;
    mipTex.minFilter = THREE.NearestFilter;
    mipTex.anisotropy = 1;
    const flatTex = new THREE.DataTexture(new Uint8Array([0, 245, 212, 255]), 1, 1);
    flatTex.generateMipmaps = false;
    flatTex.magFilter = THREE.NearestFilter;
    flatTex.minFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ map: mipTex, emissiveMap: flatTex })
    );
    enforceCrispTexturesAndShading(mesh, 8);
    assert.equal(mipTex.magFilter, THREE.LinearFilter);
    assert.equal(mipTex.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(mipTex.anisotropy, 8);
    assert.equal(flatTex.magFilter, THREE.LinearFilter);
    assert.equal(flatTex.minFilter, THREE.LinearFilter);
  });

  test('PUT /api/sculptures/:id persists scale & move, atomically pushes neighboring artworks inside land bounds, and rejects out-of-bounds scale with 409', async () => {
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'scale-push-owner@graffiland.test', name: 'Scale Push Owner' } })
    }).then((r) => r.json());
    const tok = authRes.token;
    assert.ok(tok);

    const claim = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        lat: 37.7815,
        lng: -122.4125,
        customName: 'Collision Push Plaza',
        volume: {
          centerLat: 37.7815,
          centerLng: -122.4125,
          widthMeters: 10,
          depthMeters: 10,
          heightMeters: 12,
          rotationDeg: 0
        }
      })
    }).then((r) => r.json());
    const pid = claim.parcelId;
    assert.ok(pid);

    const mkSc = async (title, dx) => {
      const r = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(pid)}/sculptures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          title,
          description: `${title} placed on Collision Push Plaza`,
          anchorOffset: { dx, dy: 0, dz: 0, yaw: 0 },
          voxels: [
            { x: -0.5, y: 0, z: -0.5, color: '#00f5d4', material: 'matte' },
            { x: 0.5, y: 1.0, z: 0.5, color: '#ffd166', material: 'neon' }
          ]
        })
      }).then((res) => res.json());
      return r.sculpture;
    };

    const artA = await mkSc('Centerpiece Tree', 0);
    const artB = await mkSc('Adjacent Gift', 1.4);
    assert.ok(artA?.id && artB?.id);

    // Scale Art A up to 3.2x (~3.4m wide -> spans -1.7..+1.7m) -> pushes Adjacent Gift cleanly inside [-5, +5]m bounds
    const scaleRes = await fetch(`${baseUrl}/api/sculptures/${encodeURIComponent(artA.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        scale: 3.2,
        anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 3.2 }
      })
    });
    const scaleBody = await scaleRes.json();
    assert.equal(scaleRes.status, 200, JSON.stringify(scaleBody));
    assert.equal(scaleBody.sculpture.scale, 3.2);
    assert.equal(scaleBody.sculpture.anchorOffset.scale, 3.2);
    assert.equal(scaleBody.pushedSiblings.length, 1);
    assert.equal(scaleBody.pushedSiblings[0].id, artB.id);
    assert.ok(scaleBody.pushedSiblings[0].dx > 2.0, `Expected sibling pushed right, got dx=${scaleBody.pushedSiblings[0].dx}`);
    assert.ok(scaleBody.pushedSiblings[0].dx <= 4.5, 'Pushed sibling must remain strictly inside land bounds');

    // Verify sibling persistence in DB
    const sibAfter = await fetch(`${baseUrl}/api/sculptures/${encodeURIComponent(artB.id)}`).then((r) => r.json());
    assert.equal(sibAfter.sculpture.anchorOffset.dx, scaleBody.pushedSiblings[0].dx);

    // Trying to scale Art A beyond land bounds (15x on a 10m plot) is rejected with 409 + maxSafeScale
    const badRes = await fetch(`${baseUrl}/api/sculptures/${encodeURIComponent(artA.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ scale: 15, anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 15 } })
    });
    const badBody = await badRes.json();
    assert.equal(badRes.status, 409, JSON.stringify(badBody));
    assert.ok(Number(badBody.maxSafeScale) > 0 && Number(badBody.maxSafeScale) < 15);
  });

  test('MapLibre v6 3D projection culls behind-camera lands, artwork labels sit strictly above lines, land leaders point to top center, and same-owner land overlap is rejected', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { projectLngLatAltToScreen, computePrismScreenGeometry } = await import(
      '../client/src/utils/map3dProjection.js'
    );

    // 1) MapLibre v6 matrix resolution (`map._camera.projectedCamera.mercatorMatrix`, no `map.transform`)
    // Column-major matrix where clip w = 1 - 10 * y (so y < 0.1 is in front of camera, y >= 0.1 is behind camera!)
    const mercatorMatrix = [
      1, 0, 0, 0,
      0, 1, 0, -10,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
    let projectFallbackCalled = 0;
    const mockMapV6 = {
      _camera: { projectedCamera: { mercatorMatrix } },
      getCanvas: () => ({ clientWidth: 1000, clientHeight: 600 }),
      project: () => {
        projectFallbackCalled += 1;
        return { x: 500, y: 700 };
      }
    };
    const mockMapLibre = {
      MercatorCoordinate: {
        fromLngLat: ([lng, lat], alt = 0) => ({
          x: lng,
          y: lat,
          z: alt * 0.001
        })
      }
    };

    const inFront = projectLngLatAltToScreen(mockMapV6, mockMapLibre, 0.02, 0.02, 10);
    assert.equal(inFront.visible, true);
    assert.ok(inFront.depth > 0.5);
    assert.equal(projectFallbackCalled, 0, 'Must use MapLibre v6 mercatorMatrix without falling back to map.project');

    const behindCamera = projectLngLatAltToScreen(mockMapV6, mockMapLibre, 0.02, 0.25, 100);
    assert.equal(behindCamera.visible, false, 'Points behind camera (cw <= 0) must be strictly culled');
    assert.equal(projectFallbackCalled, 0, 'Behind-camera points must NEVER fall back to 2D map.project');

    const behindPrism = computePrismScreenGeometry(mockMapV6, mockMapLibre, {
      centerLng: 0.02,
      centerLat: 0.25,
      heightMeters: 100,
      corners: [
        [0.01, 0.24],
        [0.03, 0.24],
        [0.03, 0.26],
        [0.01, 0.26]
      ]
    });
    assert.equal(behindPrism, null, 'Behind-camera land prisms must return null so they never overlap foreground lands');

    const frontPrism = computePrismScreenGeometry(mockMapV6, mockMapLibre, {
      centerLng: 0.02,
      centerLat: 0.02,
      heightMeters: 18,
      corners: [
        [0.01, 0.01],
        [0.03, 0.01],
        [0.03, 0.03],
        [0.01, 0.03]
      ]
    });
    assert.ok(frontPrism && frontPrism.topCenter?.visible);
    assert.ok(Number.isFinite(frontPrism.avgDepth) && frontPrism.avgDepth > 0);

    // 2) Verify MapView3D land label leader targets exact top center (roofCenter) and artwork labels sit in z-index 10 layer above wireframes (z-index 5)
    const map3dSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/components/MapView3D.jsx'),
      'utf8'
    );
    assert.match(
      map3dSrc,
      /drawFloatingCenterArrow\(ctx,\s*\{\s*fromX:\s*anchor\.roofCenter\.x,\s*fromY:\s*pinBottomY,\s*toX:\s*anchor\.roofCenter\.x,\s*toY:\s*anchor\.roofCenter\.y,/
    );
    assert.match(map3dSrc, /className="map3d-floating-artwork-layer"/);

    const cssSrc = fs.readFileSync(path.resolve(process.cwd(), 'client/src/styles.css'), 'utf8');
    const wireZ = Number(cssSrc.match(/\.map3d-wireframe-canvas\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1] || 0);
    const pinZ = Number(cssSrc.match(/\.map3d-floating-pins-layer\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1] || 0);
    const artZ = Number(cssSrc.match(/\.map3d-floating-artwork-layer\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1] || 0);
    assert.ok(artZ > wireZ && artZ > pinZ, `Expected artwork label layer z-index (${artZ}) > pins (${pinZ}) > wireframes (${wireZ})`);

    // 3) Same owner cannot claim a second land whose boundary overlaps their own existing land (409)
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devProfile: { email: 'no-self-overlap@graffiland.test', name: 'No Overlap Owner' } })
    }).then((r) => r.json());
    const tok = authRes.token;
    assert.ok(tok);

    const firstClaim = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        lat: 37.7855,
        lng: -122.4165,
        customName: 'North Boundary Plaza',
        volume: {
          centerLat: 37.7855,
          centerLng: -122.4165,
          widthMeters: 20,
          depthMeters: 20,
          heightMeters: 18,
          rotationDeg: 0
        }
      })
    });
    assert.equal(firstClaim.status, 201);

    const overlapClaim = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        lat: 37.78564,
        lng: -122.4165,
        customName: 'Overlapping Neighbor Plot',
        volume: {
          centerLat: 37.78564,
          centerLng: -122.4165,
          widthMeters: 20,
          depthMeters: 20,
          heightMeters: 18,
          rotationDeg: 0
        }
      })
    });
    const overlapBody = await overlapClaim.json();
    assert.equal(overlapClaim.status, 409, `Same-owner overlapping boundary must be rejected with 409: ${JSON.stringify(overlapBody)}`);
    assert.match(String(overlapBody.error || ''), /overlaps existing Virtual Land/i);
  });

  test('PUT /api/sculptures/:id persists vertical pitch/roll rotation and pushes multi-sibling sculptures without intersection', async () => {
    const authRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devProfile: { email: 'vertical-tilt-owner@graffiland.test', name: 'Tilt Tester' }
      })
    }).then((r) => r.json());
    const tok = authRes.token;
    assert.ok(tok);

    const claimRes = await fetch(`${baseUrl}/api/lands/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        lat: 37.7681,
        lng: -122.4312,
        customName: 'Vertical Measure Lot',
        volume: {
          centerLat: 37.7681,
          centerLng: -122.4312,
          widthMeters: 12,
          depthMeters: 12,
          heightMeters: 14,
          rotationDeg: 0
        }
      })
    });
    const claimBody = await claimRes.json();
    assert.equal(claimRes.status, 201, JSON.stringify(claimBody));
    const parcelId = claimBody.parcelId;

    // Place 3 sculptures inside the 12m × 12m × 14m land
    const mkVoxelBar = (lenX, lenY, lenZ) => {
      const pts = [];
      for (let ix = 0; ix <= lenX; ix += 2) {
        for (let iy = 0; iy <= lenY; iy += 2) {
          for (let iz = 0; iz <= lenZ; iz += 2) {
            pts.push({ x: ix * 0.25, y: iy * 0.25, z: iz * 0.25, color: '#00f5d4', material: 'matte' });
          }
        }
      }
      return pts;
    };

    const s1Res = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/sculptures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        title: 'Flat Beam',
        description: 'Long flat sculpture to stand vertically',
        voxels: mkVoxelBar(10, 2, 16), // ~2.5m × 0.5m × 4m
        anchorOffset: { dx: -2.5, dy: 0, dz: 0, yaw: 0 }
      })
    });
    const s1 = (await s1Res.json()).sculpture;
    assert.ok(s1Res.ok && s1?.id);

    const s2Res = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/sculptures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        title: 'Center Cube',
        description: 'Neighboring artwork',
        voxels: mkVoxelBar(8, 8, 8),
        anchorOffset: { dx: 0.8, dy: 0, dz: 0, yaw: 0 }
      })
    });
    const s2 = (await s2Res.json()).sculpture;
    assert.ok(s2Res.ok && s2?.id);

    const s3Res = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}/sculptures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        title: 'Right Cube',
        description: 'Third artwork behind Center Cube',
        voxels: mkVoxelBar(8, 8, 8),
        anchorOffset: { dx: 3.4, dy: 0, dz: 0, yaw: 0 }
      })
    });
    const s3 = (await s3Res.json()).sculpture;
    assert.ok(s3Res.ok && s3?.id);

    // Rotate Flat Beam vertically (pitch = 90°, roll = -15°) AND move it right into Center Cube
    const updRes = await fetch(`${baseUrl}/api/sculptures/${encodeURIComponent(s1.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        title: 'Flat Beam',
        description: 'Stood upright vertically',
        scale: 1,
        anchorOffset: { dx: 0.8, dy: 0, dz: 0, yaw: 10, pitch: 90, roll: -15 }
      })
    });
    const updBody = await updRes.json();
    assert.equal(updRes.status, 200, JSON.stringify(updBody));
    assert.equal(updBody.sculpture.anchorOffset.pitch, 90);
    assert.equal(updBody.sculpture.anchorOffset.roll, -15);
    assert.equal(updBody.sculpture.meshStats?.transformPitch, 90);
    assert.equal(updBody.sculpture.meshStats?.transformRoll, -15);
    assert.ok(Array.isArray(updBody.pushedSiblings) && updBody.pushedSiblings.length >= 1);

    // Reload sculpture from DB -> pitch & roll persist cleanly
    const reloaded = await fetch(`${baseUrl}/api/sculptures/${encodeURIComponent(s1.id)}`).then((r) => r.json());
    assert.equal(reloaded.sculpture.anchorOffset.pitch, 90);
    assert.equal(reloaded.sculpture.anchorOffset.roll, -15);

    // Verify zero pairwise bounding-box overlap among all 3 sculptures persisted on the land
    const detail = await fetch(`${baseUrl}/api/lands/${encodeURIComponent(parcelId)}`).then((r) => r.json());
    const all3 = (detail.sculptures || []).filter((x) => [s1.id, s2.id, s3.id].includes(x.id));
    assert.equal(all3.length, 3);
    const { buildPlacementItemFromSculpture, computeItemLocalBox } = await import(
      '../shared/sculpturePlacement.mjs'
    );
    const boxes = all3.map((sc) =>
      computeItemLocalBox(buildPlacementItemFromSculpture(sc, detail.parcel.volume))
    );
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        assert.equal(
          ox > 0.005 && oz > 0.005 && oy > 0.005,
          false,
          `Persisted sculptures ${i} and ${j} must NOT intersect after push`
        );
      }
    }
  });
});
