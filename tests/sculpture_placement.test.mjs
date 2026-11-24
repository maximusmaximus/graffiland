import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeItemLocalBox,
  computeMaxFeasibleScale,
  evaluateModelFitInParcel,
  resolveSculpturePlacement
} from '../shared/sculpturePlacement.mjs';
import { computeSculptureMapTransform } from '../client/src/utils/map3dSculptureLayer.js';

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
});
