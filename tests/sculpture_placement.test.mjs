import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeItemLocalBox,
  computeMaxFeasibleScale,
  evaluateModelFitInParcel,
  latLngToParcelLocalMeters,
  parcelLocalMetersToWorldMeters,
  parcelLocalOffsetToWorldLatLng,
  parcelLocalYawToWorldYawRad,
  resolveParcelVolumeForPlacement,
  resolveSculpturePlacement
} from '../shared/sculpturePlacement.mjs';
import { computeSculptureMapTransform } from '../client/src/utils/map3dSculptureLayer.js';
import { buildSculptures3DGeoJson } from '../client/src/utils/sculpture3dGeoJson.js';

function assertAllInsideAndNonOverlapping(res, vol, gap = 0.08) {
  assert.equal(res.ok, true, `Expected placement ok, got: ${JSON.stringify(res)}`);
  const halfW = vol.widthMeters / 2;
  const halfD = vol.depthMeters / 2;
  const eps = 0.015;
  for (const item of res.allItems) {
    const b = item.box || computeItemLocalBox(item);
    assert.ok(b.minX >= -halfW - eps, `${item.id} minX ${b.minX} outside -${halfW}`);
    assert.ok(b.maxX <= halfW + eps, `${item.id} maxX ${b.maxX} outside +${halfW}`);
    assert.ok(b.minZ >= -halfD - eps, `${item.id} minZ ${b.minZ} outside -${halfD}`);
    assert.ok(b.maxZ <= halfD + eps, `${item.id} maxZ ${b.maxZ} outside +${halfD}`);
    assert.ok(b.minY >= -eps, `${item.id} minY ${b.minY} below ground`);
    assert.ok(b.maxY <= vol.heightMeters + eps, `${item.id} maxY ${b.maxY} above ${vol.heightMeters}`);
  }
  for (let i = 0; i < res.allItems.length; i += 1) {
    for (let j = i + 1; j < res.allItems.length; j += 1) {
      const a = res.allItems[i].box;
      const b = res.allItems[j].box;
      const ox = a.halfW + b.halfW + gap - Math.abs(a.cx - b.cx);
      const oz = a.halfD + b.halfD + gap - Math.abs(a.cz - b.cz);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + gap * 0.5;
      assert.equal(
        ox > 0.005 && oz > 0.005 && oy > 0.005,
        false,
        `Overlap detected between ${res.allItems[i].id} and ${res.allItems[j].id}`
      );
    }
  }
}

describe('3D Artwork Transform, Scaling & Non-Intersecting Push Solver', () => {
  test('Scaling pushes nearby artwork smoothly inside land bounds without affecting distant items', () => {
    const vol = { widthMeters: 14, depthMeters: 14, heightMeters: 18, centerLat: 39.72, centerLng: -121.84 };
    const items = [
      { id: 'tree', title: 'Christmas Tree', baseX: 0, baseZ: 0, dx: 0, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 3, baseDepth: 2 },
      { id: 'gift', title: 'Gift Box', baseX: 0, baseZ: 0, dx: 2.3, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'lamp', title: 'Corner Lamp', baseX: 0, baseZ: 0, dx: -5.2, dy: 0, dz: -5.2, yaw: 0, scale: 1, baseWidth: 1.4, baseHeight: 2, baseDepth: 1.4 }
    ];

    const res = resolveSculpturePlacement({
      parcelVolume: vol,
      targetId: 'tree',
      targetTransform: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 3 },
      items
    });

    assertAllInsideAndNonOverlapping(res, vol);
    assert.equal(res.target.scale, 3);
    assert.equal(res.pushedSiblings.length, 1);
    assert.equal(res.pushedSiblings[0].id, 'gift');
    assert.ok(res.pushedSiblings[0].dx >= 4.07, `Gift Box should shift clear of 6m tree, got dx=${res.pushedSiblings[0].dx}`);
    const lampItem = res.allItems.find((i) => i.id === 'lamp');
    assert.equal(lampItem.dx, -5.2, 'Distant untouched artwork must not move');
    assert.equal(lampItem.dz, -5.2, 'Distant untouched artwork must not move');
    assert.equal(lampItem.wasPushed, false);
  });

  test('Chain-pushes multiple adjacent artworks while clamping all strictly inside land bounds', () => {
    const vol = { widthMeters: 16, depthMeters: 16, heightMeters: 18 };
    const items = [
      { id: 'a', title: 'Center A', baseX: 0, baseZ: 0, dx: 0, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'b', title: 'Mid B', baseX: 0, baseZ: 0, dx: 2.2, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'c', title: 'Outer C', baseX: 0, baseZ: 0, dx: 4.4, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 }
    ];

    const res = resolveSculpturePlacement({
      parcelVolume: vol,
      targetId: 'a',
      targetTransform: { dx: 1.2, dy: 0, dz: 0, yaw: 0, scale: 2.2 },
      items
    });

    assertAllInsideAndNonOverlapping(res, vol);
    assert.ok(res.pushedSiblings.some((p) => p.id === 'b'));
    assert.ok(res.pushedSiblings.some((p) => p.id === 'c'));
  });

  test('Refuses scale/move that would push another artwork outside the land bounds and computes exact max safe scale', () => {
    const vol = { widthMeters: 6.4, depthMeters: 6.4, heightMeters: 12 };
    const items = [
      { id: 'center', title: 'Statue', baseX: 0, baseZ: 0, dx: 0, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'east', title: 'East Pillar', baseX: 0, baseZ: 0, dx: 2.1, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'west', title: 'West Pillar', baseX: 0, baseZ: 0, dx: -2.1, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'north', title: 'North Pillar', baseX: 0, baseZ: 0, dx: 0, dy: 0, dz: -2.1, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 },
      { id: 'south', title: 'South Pillar', baseX: 0, baseZ: 0, dx: 0, dy: 0, dz: 2.1, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 }
    ];

    const blocked = resolveSculpturePlacement({
      parcelVolume: vol,
      targetId: 'center',
      targetTransform: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 2.6 },
      items
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'collision_out_of_bounds');

    const maxSafe = computeMaxFeasibleScale({
      parcelVolume: vol,
      targetId: 'center',
      targetTransform: { dx: 0, dy: 0, dz: 0, yaw: 0 },
      items
    });
    assert.ok(maxSafe >= 0.5 && maxSafe < 2.6, `Expected bounded max safe scale, got ${maxSafe}`);

    const verified = resolveSculpturePlacement({
      parcelVolume: vol,
      targetId: 'center',
      targetTransform: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: maxSafe },
      items
    });
    assertAllInsideAndNonOverlapping(verified, vol);
  });

  test('Vertical elevation clearance avoids needlessly pushing items below and map transform honors user scale monotonically', () => {
    const vol = { widthMeters: 14, depthMeters: 14, heightMeters: 18, centerLat: 39.72, centerLng: -121.84 };
    const items = [
      { id: 'float', title: 'Floating Star', baseX: 0, baseZ: 0, dx: 0, dy: 3, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 1.5, baseDepth: 2 },
      { id: 'base', title: 'Pedestal', baseX: 0, baseZ: 0, dx: 0, dy: 0, dz: 0, yaw: 0, scale: 1, baseWidth: 2, baseHeight: 2, baseDepth: 2 }
    ];

    const res = resolveSculpturePlacement({
      parcelVolume: vol,
      targetId: 'float',
      targetTransform: { dx: 0, dy: 2.5, dz: 0, yaw: 0, scale: 1.8 },
      items
    });
    assertAllInsideAndNonOverlapping(res, vol);
    assert.equal(res.pushedSiblings.length, 0, 'Elevated artwork with vertical clearance should not push item below');

    const tHalf = computeSculptureMapTransform(
      { id: 's', lat: 39.72, lng: -121.84, scale: 0.5, anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 0.5 } },
      vol,
      { min: { x: -0.7, y: 0, z: -0.7 }, max: { x: 0.7, y: 1.4, z: 0.7 } }
    );
    const tOne = computeSculptureMapTransform(
      { id: 's', lat: 39.72, lng: -121.84, scale: 1, anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 1 } },
      vol,
      { min: { x: -0.7, y: 0, z: -0.7 }, max: { x: 0.7, y: 1.4, z: 0.7 } }
    );
    const tTwo = computeSculptureMapTransform(
      { id: 's', lat: 39.72, lng: -121.84, scale: 2, anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 2 } },
      vol,
      { min: { x: -0.7, y: 0, z: -0.7 }, max: { x: 0.7, y: 1.4, z: 0.7 } }
    );
    assert.ok(tHalf.scale < tOne.scale && tOne.scale < tTwo.scale, 'Map scale must increase monotonically with user scale');
    assert.ok(tTwo.renderedSize.x <= vol.widthMeters + 0.01 && tTwo.renderedSize.y <= vol.heightMeters + 0.01);
  });

  test('evaluateModelFitInParcel rejects oversized cm-unit models with exact sub-0.1 maxSafeScale and enforces sibling spacing', () => {
    const vol = { widthMeters: 10, depthMeters: 10, heightMeters: 8, centerLat: 37.77, centerLng: -122.42 };
    // Model exported in centimeters (180×200×160 units -> 200m tall at 1x) inside 10×10×8m land
    const cmFit = evaluateModelFitInParcel({
      parcelVolume: vol,
      bbox: { width: 180, height: 200, depth: 160 },
      modelScale: 1
    });
    assert.equal(cmFit.fits, false);
    assert.equal(cmFit.reason, 'exceeds_land_bounds');
    assert.ok(cmFit.maxSafeScale >= 0.035 && cmFit.maxSafeScale <= 0.04, `Expected maxSafeScale ~0.0399, got ${cmFit.maxSafeScale}`);

    // Applying suggested maxSafeScale fits strictly inside the land
    const fixedFit = evaluateModelFitInParcel({
      parcelVolume: vol,
      bbox: { width: 180, height: 200, depth: 160 },
      modelScale: cmFit.maxSafeScale
    });
    assert.equal(fixedFit.fits, true);
  });

  test('Parcel-local to world coordinate transforms are exact inverses across rotated lands (49° and 318°)', () => {
    for (const rotDeg of [0, 49, 135, 318]) {
      const vol = {
        centerLat: 39.730741,
        centerLng: -121.83832,
        widthMeters: 28.1,
        depthMeters: 97,
        heightMeters: 18,
        rotationDeg: rotDeg
      };
      const localSamples = [
        [0, 0],
        [5, -10],
        [-7.23, 38.64],
        [18, 8]
      ];
      for (const [dx, dz] of localSamples) {
        const worldPos = parcelLocalOffsetToWorldLatLng(vol.centerLat, vol.centerLng, dx, dz, rotDeg);
        const worldVec = parcelLocalMetersToWorldMeters(dx, dz, rotDeg);
        assert.ok(Math.abs(worldPos.worldDx - worldVec.east) < 1e-4);
        assert.ok(Math.abs(worldPos.worldDz - worldVec.south) < 1e-4);

        const roundTrip = latLngToParcelLocalMeters(worldPos.lat, worldPos.lng, vol);
        assert.ok(
          Math.abs(roundTrip.baseX - dx) < 0.02,
          `rot=${rotDeg} dx=${dx} roundTrip.baseX=${roundTrip.baseX}`
        );
        assert.ok(
          Math.abs(roundTrip.baseZ - dz) < 0.02,
          `rot=${rotDeg} dz=${dz} roundTrip.baseZ=${roundTrip.baseZ}`
        );
      }
    }
  });

  test('Map 3D transform & GeoJSON footprint match Edit View orientation and scale inside rotated parcel (Veggie Row in 49° parcel)', () => {
    const farmersMarketVol = {
      centerLat: 39.730741,
      centerLng: -121.83832,
      widthMeters: 28.1,
      depthMeters: 97,
      heightMeters: 18,
      rotationDeg: 49,
      baseAltitudeM: 0
    };
    const farmersMarketParcel = {
      parcelId: 'GLAND-9R1658B0',
      volume: farmersMarketVol
    };

    // resolveParcelVolumeForPlacement works identically whether passed { parcel } or a direct parcel object
    const resolvedWrapped = resolveParcelVolumeForPlacement({ parcel: farmersMarketParcel });
    const resolvedDirect = resolveParcelVolumeForPlacement(farmersMarketParcel);
    assert.equal(resolvedWrapped.widthMeters, 28.1);
    assert.equal(resolvedWrapped.depthMeters, 97);
    assert.equal(resolvedWrapped.rotationDeg, 49);
    assert.deepEqual(resolvedDirect, resolvedWrapped);

    const veggieRow = {
      id: 'b92ee380-9057-44d3-aa7a-e3cfed12754b',
      parcelId: 'GLAND-9R1658B0',
      modelType: 'custom-3d',
      lat: 39.730741,
      lng: -121.83832,
      scale: 55.201,
      anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 0, scale: 55.201 },
      customModel: { format: 'glb', scale: 55.201, rotationY: 0 },
      meshStats: { bbox: { width: 0.262, height: 0.2436, depth: 1.4 } }
    };
    const normalizedBounds = {
      min: { x: -0.131, y: 0, z: -0.7 },
      max: { x: 0.131, y: 0.2436, z: 0.7 }
    };

    const t = computeSculptureMapTransform(veggieRow, farmersMarketVol, normalizedBounds);
    assert.ok(Math.abs(t.worldYawRad - (-49 * Math.PI) / 180) < 1e-6);
    assert.ok(Math.abs(t.renderedSize.x - 14.4627) < 0.02);
    assert.ok(Math.abs(t.renderedSize.y - 13.447) < 0.02);
    assert.ok(Math.abs(t.renderedSize.z - 77.2814) < 0.02);

    // Every world corner of the Three.js model must project back inside the 28.1m x 97m parcel box
    const hw = t.renderedSize.x / 2;
    const hd = t.renderedSize.z / 2;
    const R = (farmersMarketVol.rotationDeg * Math.PI) / 180;
    for (const [cx, cz] of [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd]
    ]) {
      const east = cx * Math.cos(t.worldYawRad) + cz * Math.sin(t.worldYawRad) + t.worldDx;
      const south = -cx * Math.sin(t.worldYawRad) + cz * Math.cos(t.worldYawRad) + t.worldDz;
      const localX = east * Math.cos(R) + south * Math.sin(R);
      const localZ = -east * Math.sin(R) + south * Math.cos(R);
      assert.ok(Math.abs(localX) <= 7.25 && Math.abs(localX) <= farmersMarketVol.widthMeters / 2);
      assert.ok(Math.abs(localZ) <= 38.66 && Math.abs(localZ) <= farmersMarketVol.depthMeters / 2);
    }

    // Offset + yaw test: dx=5, dz=-10, yaw=90 in 49° parcel
    const shifted = {
      ...veggieRow,
      anchorOffset: { dx: 5, dy: 0, dz: -10, yaw: 90, scale: 1 }
    };
    const tShift = computeSculptureMapTransform(shifted, farmersMarketVol, normalizedBounds);
    assert.ok(Math.abs(tShift.worldYawRad - parcelLocalYawToWorldYawRad(90, 49)) < 1e-6);
    assert.ok(Math.abs(tShift.worldYawRad - ((90 - 49) * Math.PI) / 180) < 1e-6);
    const shiftBack = latLngToParcelLocalMeters(tShift.worldLat, tShift.worldLng, farmersMarketVol);
    assert.ok(Math.abs(shiftBack.baseX - 5) < 0.02);
    assert.ok(Math.abs(shiftBack.baseZ - -10) < 0.02);

    // GeoJSON fallback footprint for Veggie Row must also sit strictly aligned inside the 49° parcel
    const geo = buildSculptures3DGeoJson([veggieRow], '', [farmersMarketParcel]);
    assert.equal(geo.renderedCount, 1);
    const ring = geo.geojson.features[0]?.geometry?.coordinates?.[0] || [];
    assert.ok(ring.length >= 4);
    for (const [lng, lat] of ring) {
      const local = latLngToParcelLocalMeters(lat, lng, farmersMarketVol);
      assert.ok(
        Math.abs(local.baseX) <= 7.35,
        `GeoJSON corner localX=${local.baseX} expected within ±7.35m`
      );
      assert.ok(
        Math.abs(local.baseZ) <= 38.75,
        `GeoJSON corner localZ=${local.baseZ} expected within ±38.75m`
      );
    }
  });
});
