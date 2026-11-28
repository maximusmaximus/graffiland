import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildObjectFittedLandVolume,
  ensureLandVolumeFitsSculptures
} from '../shared/landVolume.mjs';
import { isPointInsideParcelFootprint } from '../client/src/utils/arLandHelpers.js';
import {
  directOwnerUpdateSculpture,
  listLandsWithCurations
} from '../shared/mcp/landMutations.mjs';
import {
  computeRotatedBoxDimensions,
  parcelLocalOffsetToWorldLatLng
} from '../shared/sculpturePlacement.mjs';
import { computeSculptureMapTransform } from '../client/src/utils/map3dSculptureLayer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.resolve(__dirname, '../worker/schema.sql'), 'utf8');

function createInMemoryDbAdapter() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
  return {
    get: async (sql, params = []) => sqlite.prepare(sql).get(...params) || null,
    all: async (sql, params = []) => sqlite.prepare(sql).all(...params) || [],
    run: async (sql, params = []) => {
      const res = sqlite.prepare(sql).run(...params);
      return { changes: Number(res?.changes || 0), lastInsertRowid: res?.lastInsertRowid };
    },
    close: () => sqlite.close()
  };
}

describe('Resized & Moved Artwork Stays Strictly Inside Its Land on the Whole 3D Map', () => {
  test('1. Exact "I scribbled" regression: resizing a voxel artwork to 0.263x + yaw 15deg + moving to corner never corrupts land volume or flings art outside on the map', () => {
    // Exact live dimensions of "I scribbled" (3.60 x 2.15 x 3.50m unscaled voxels) inside 4.32 x 4.20 x 2.58m land
    const voxels = [
      { x: -1.775, y: -1.15, z: -1.725, color: '#00f5d4' },
      { x: 1.775, y: 0.95, z: 1.725, color: '#ff3e7f' }
    ];
    const dbVolume = buildObjectFittedLandVolume({
      parcelId: 'GLAND-9R1652RS',
      lat: 39.728741,
      lng: -121.838755,
      voxels,
      paddingFraction: 0.1
    });
    assert.equal(dbVolume.widthMeters, 4.32);
    assert.equal(dbVolume.depthMeters, 4.2);
    assert.equal(dbVolume.rotationDeg, 0);

    // Raw SQL row shape returned by listLandsWithCurations (scale lives inside mesh_stats_json.transformScale!)
    const rawSqlRow = {
      id: 'sc-scribbled',
      parcel_id: 'GLAND-9R1652RS',
      lat: 39.7287409,
      lng: -121.8387547,
      voxels_json: JSON.stringify(voxels),
      anchor_dx: -1.59,
      anchor_dy: 0,
      anchor_dz: 1.502,
      anchor_yaw: 15,
      mesh_stats_json: JSON.stringify({
        bbox: { width: 3.598, height: 2.148, depth: 3.498 },
        transformScale: 0.263,
        transformPitch: 0,
        transformRoll: 0
      }),
      custom_model_scale: null
    };

    const checkedVol = ensureLandVolumeFitsSculptures(dbVolume, [rawSqlRow], {
      paddingFraction: 0.1
    });

    // Must return the exact DB land volume untouched (NO 2.2m center shift, NO 220.56deg spin!)
    assert.equal(checkedVol.centerLat, dbVolume.centerLat);
    assert.equal(checkedVol.centerLng, dbVolume.centerLng);
    assert.equal(checkedVol.widthMeters, dbVolume.widthMeters);
    assert.equal(checkedVol.depthMeters, dbVolume.depthMeters);
    assert.equal(checkedVol.rotationDeg, 0);

    // Map 3D layer transform must place the sculpture center AND all 4 footprint corners strictly INSIDE the land!
    const scForMap = {
      id: 'sc-scribbled',
      parcelId: 'GLAND-9R1652RS',
      lat: rawSqlRow.lat,
      lng: rawSqlRow.lng,
      scale: 0.263,
      anchorOffset: { dx: -1.59, dy: 0, dz: 1.502, yaw: 15, pitch: 0, roll: 0, scale: 0.263 },
      voxels
    };
    const mapXf = computeSculptureMapTransform(scForMap, checkedVol, {
      min: { x: -1.8, y: -1.175, z: -1.75 },
      max: { x: 1.8, y: 0.975, z: 1.75 }
    });
    assert.ok(mapXf);
    assert.equal(
      isPointInsideParcelFootprint(mapXf.worldLat, mapXf.worldLng, checkedVol),
      true,
      'Resized sculpture center on 3D map must lie strictly inside its land footprint'
    );

    const rotDims = computeRotatedBoxDimensions({
      width: 3.6,
      height: 2.15,
      depth: 3.5,
      yaw: 15,
      scale: 0.263
    });
    for (const [ox, oz] of [
      [-rotDims.effW / 2, -rotDims.effD / 2],
      [rotDims.effW / 2, -rotDims.effD / 2],
      [rotDims.effW / 2, rotDims.effD / 2],
      [-rotDims.effW / 2, rotDims.effD / 2]
    ]) {
      const cornerPos = parcelLocalOffsetToWorldLatLng(
        mapXf.worldLat,
        mapXf.worldLng,
        ox,
        oz,
        checkedVol.rotationDeg
      );
      assert.equal(
        isPointInsideParcelFootprint(cornerPos.lat, cornerPos.lng, checkedVol, 0.02),
        true,
        `Footprint corner (${ox.toFixed(2)}, ${oz.toFixed(2)}) must lie inside land on 3D map`
      );
    }
  });

  test('2. Full SQLite round-trip: updateSculptureProperties -> listLandsWithCurations preserves land bounds & keeps resized art inside on map', async () => {
    const db = createInMemoryDbAdapter();
    try {
      const now = new Date().toISOString();
      const parcelId = 'GLAND-9R1652RS';
      const geohash = '9r1652rs';
      const ownerSub = 'u-bigdog';
      const ownerAddr = '0x1111111111111111111111111111111111111111';
      const voxels = [
        { x: -1.775, y: -1.15, z: -1.725, color: '#00f5d4' },
        { x: 1.775, y: 0.95, z: 1.725, color: '#ff3e7f' }
      ];
      const baseVol = buildObjectFittedLandVolume({
        parcelId,
        geohash,
        lat: 39.728741,
        lng: -121.838755,
        voxels,
        paddingFraction: 0.1
      });

      await db.run(
        `INSERT INTO users (id, email, name, username, wallet_address, encrypted_wallet_json, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
        [ownerSub, 'bigdog@example.com', 'bigdog', 'bigdog', ownerAddr, now, now]
      );
      await db.run(
        `INSERT INTO land_parcels (parcel_id, geohash, center_lat, center_lng, first_claimant_sub, first_claimant_address, latest_claimant_address, sculpture_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?)`,
        [parcelId, geohash, baseVol.centerLat, baseVol.centerLng, ownerSub, ownerAddr, ownerAddr, now]
      );
      await db.run(
        `INSERT INTO land_volumes (parcel_id, center_lat, center_lng, width_meters, depth_meters, height_meters, z_scale, rotation_deg, base_altitude_m, footprint_area_sqm, volume_cubic_m, corners_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parcelId,
          baseVol.centerLat,
          baseVol.centerLng,
          baseVol.widthMeters,
          baseVol.depthMeters,
          baseVol.heightMeters,
          baseVol.zScale,
          0,
          0,
          baseVol.footprintAreaSqM,
          baseVol.volumeCubicM,
          JSON.stringify(baseVol.corners),
          now
        ]
      );
      const insertSculpture = async (id, title, desc, lat, lng, voxJson, voxCount) => {
        await db.run(
          `INSERT INTO sculptures (
             id, title, description, creator_sub, creator_name, creator_email, recipient_address,
             lat, lng, parcel_id, geohash, voxels_json, voxel_count, pol_score, pol_json, proof_hash,
             ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url,
             chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain,
             royalty_bps, royalty_receiver, hidden, terms_accepted_version, created_at
           ) VALUES (?, ?, ?, ?, 'bigdog', 'bigdog@example.com', ?, ?, ?, ?, ?, ?, ?, 97, '{}', '0xproof',
                     'bafymeta', 'bafymodel', 'bafyimg', 'https://example.com',
                     46630, 'Robinhood Chain', '0xcontract', ?, '0xtx', 1, 500, ?, 0, 'v1', ?)`,
          [id, title, desc, ownerSub, ownerAddr, lat, lng, parcelId, geohash, voxJson, voxCount, id, ownerAddr, now]
        );
      };
      await insertSculpture(
        'sc-1',
        'I scribbled',
        'In-person drawing',
        39.7287409,
        -121.8387547,
        JSON.stringify(voxels),
        voxels.length
      );
      await insertSculpture(
        'sc-mug',
        'Dishware Mug Coffee',
        '3D mug',
        39.728741,
        -121.838755,
        '[]',
        0
      );
      await db.run(
        `INSERT INTO sculpture_models (sculpture_id, parcel_id, model_format, mime_type, scale, rotation_y, byte_length, updated_at)
         VALUES (?, ?, 'glb', 'model/gltf-binary', 0.4, 0, 1024, ?)`,
        ['sc-mug', parcelId, now]
      );
      await db.run(
        `INSERT INTO sculpture_anchors (sculpture_id, parcel_id, dx, dy, dz, yaw, current_rev, mesh_stats_json, updated_at)
         VALUES (?, ?, 1.75, 0, -1.97, -121, 1, ?, ?)`,
        [
          'sc-mug',
          parcelId,
          JSON.stringify({ bbox: { width: 0.42, height: 0.41, depth: 0.31 }, transformScale: 0.4 }),
          now
        ]
      );

      // Resize & move "I scribbled" via the real backend mutation
      const updated = await directOwnerUpdateSculpture(db, {
        sculptureId: 'sc-1',
        user: { id: ownerSub, name: 'bigdog', walletAddress: ownerAddr },
        body: {
          scale: 0.263,
          anchorOffset: { dx: -1.59, dy: 0, dz: 1.502, yaw: 15, pitch: 0, roll: 0, scale: 0.263 }
        },
        pinSculptureFn: async () => ({
          metadataCid: 'bafymeta2',
          modelCid: 'bafymodel2',
          imageCid: 'bafyimg2',
          gatewayUrl: 'https://example.com/2'
        })
      });
      assert.equal(updated.sculpture.scale, 0.263);

      // Query whole map feed (/api/parcels -> listLandsWithCurations)
      const parcels = await listLandsWithCurations(db);
      const land = parcels.find((p) => p.parcelId === parcelId);
      assert.ok(land?.volume);
      assert.equal(land.volume.rotationDeg, 0, 'Land must NOT rotate when artwork yaw is edited');
      assert.equal(land.volume.centerLat, baseVol.centerLat, 'Land centerLat must NOT drift');
      assert.equal(land.volume.centerLng, baseVol.centerLng, 'Land centerLng must NOT drift');
      assert.equal(land.volume.widthMeters, baseVol.widthMeters);
      assert.equal(land.volume.depthMeters, baseVol.depthMeters);

      const mapXf = computeSculptureMapTransform(updated.sculpture, land.volume, {
        min: { x: -1.8, y: -1.175, z: -1.75 },
        max: { x: 1.8, y: 0.975, z: 1.75 }
      });
      assert.equal(isPointInsideParcelFootprint(mapXf.worldLat, mapXf.worldLng, land.volume), true);
    } finally {
      db.close();
    }
  });

  test('3. Rotated parcels preserve rotationDeg on both in-bounds resized art and legacy out-of-bounds expansion, and buildObjectFittedLandVolume converts degree yaw properly', () => {
    const voxels = [
      { x: -1, y: 0, z: -0.5, color: '#00f5d4' },
      { x: 1, y: 1.2, z: 0.5, color: '#ff3e7f' }
    ];

    // Degree yaw = 15 -> -15 deg clockwise = 345 deg (NEVER 220.56 deg from treating 15 as radians!)
    const fittedDeg = buildObjectFittedLandVolume({
      parcelId: 'GLAND-DEG15',
      lat: 39.73,
      lng: -121.84,
      voxels,
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 15 }
    });
    assert.equal(fittedDeg.rotationDeg, 345);

    // Rotated 20x12m parcel (rotationDeg = 310.3deg): sculpture at parcel-local dx=+7, dz=+3 fits cleanly!
    const rotParcel = {
      parcelId: 'GLAND-ROT310',
      centerLat: 39.729052,
      centerLng: -121.840711,
      widthMeters: 20,
      depthMeters: 12,
      heightMeters: 10,
      rotationDeg: 310.3
    };
    const inBoundsSc = {
      lat: rotParcel.centerLat,
      lng: rotParcel.centerLng,
      voxels,
      anchorOffset: { dx: 7.5, dy: 0, dz: 3.5, yaw: 30, pitch: 15, roll: 0 },
      mesh_stats_json: JSON.stringify({ transformScale: 0.8 })
    };
    const untouched = ensureLandVolumeFitsSculptures(rotParcel, [inBoundsSc]);
    assert.equal(untouched, rotParcel, 'In-bounds artwork in rotated parcel must leave volume untouched');

    // Legacy out-of-bounds sculpture expands the rotated parcel while strictly preserving rotationDeg = 310.3
    const outBoundsSc = {
      lat: rotParcel.centerLat,
      lng: rotParcel.centerLng,
      voxels,
      anchorOffset: { dx: 14, dy: 0, dz: 2, yaw: 15 }
    };
    const expanded = ensureLandVolumeFitsSculptures(rotParcel, [outBoundsSc]);
    assert.equal(expanded.rotationDeg, 310.3);
    const outWorld = parcelLocalOffsetToWorldLatLng(
      outBoundsSc.lat,
      outBoundsSc.lng,
      outBoundsSc.anchorOffset.dx,
      outBoundsSc.anchorOffset.dz,
      expanded.rotationDeg
    );
    assert.equal(isPointInsideParcelFootprint(outWorld.lat, outWorld.lng, expanded), true);
  });
});
