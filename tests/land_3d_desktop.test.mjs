import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LAND_VOLUME_LIMITS } from '../shared/constants.mjs';
import {
  buildParcelShareUrl,
  computeCameraAlignedDraftBox,
  computeMaxHeightForFootprint,
  footprintsOverlap,
  resizeDraftFromEdge,
  scaleDraftFromCorner,
  scaleFootprintToLimit,
  validateAndNormalizeLandVolume
} from '../shared/landVolume.mjs';
import {
  buildLandAcquisitionAgentPrompt,
  buildLandAdd3DItemAgentPrompt
} from '../shared/landSignatureMessage.mjs';
import { buildSculptures3DGeoJson } from '../client/src/utils/sculpture3dGeoJson.js';

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
    assert.ok(out.geojson.features.some((f) => f.properties.sculptureId === 'sc-voxel-1' && f.properties.heightMeters > 0.5));
    assert.ok(out.geojson.features.some((f) => f.properties.sculptureId === 'sc-glb-2' && f.properties.heightMeters > 4));
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
});
