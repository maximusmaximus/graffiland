import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VOXEL_STEP } from '../shared/constants.mjs';
import {
  advanceFluidSprayPoint,
  areVoxelsFaceConnected,
  BLOCK_SIZE_PRESETS,
  buildConnectedVoxelPath,
  computeAdjacentCandidateSlots,
  findBestAdjacentVoxelSlot,
  getVoxelCellStep,
  STANDARD_COLOR_PRESETS
} from '../shared/voxelStroke.mjs';

describe('Connected 3D Voxel Stroke Interpolation & Presets', () => {
  test('Straight and diagonal 3D lines produce strictly 6-connected face-adjacent voxels', () => {
    const start = { x: 0, y: 0, z: 0 };
    const end = { x: VOXEL_STEP * 7, y: VOXEL_STEP * 5, z: -VOXEL_STEP * 4 };
    const { path, lastPoint } = buildConnectedVoxelPath(start, end, {
      step: VOXEL_STEP,
      blockScale: 1
    });

    // Exact Manhattan steps: 7 + 5 + 4 = 16 face-connected steps
    assert.equal(path.length, 16);
    assert.deepEqual(
      { x: lastPoint.x, y: lastPoint.y, z: lastPoint.z },
      { x: 0.35, y: 0.25, z: -0.2 }
    );

    let prev = start;
    for (const v of path) {
      assert.equal(
        areVoxelsFaceConnected(prev, v, { step: VOXEL_STEP, blockScale: 1 }),
        true,
        `Expected ${JSON.stringify(prev)} and ${JSON.stringify(v)} to share a face`
      );
      prev = v;
    }
  });

  test('Multi-frame 3D curve stays 100% face-connected with zero diagonal gaps', () => {
    let cursor = null;
    const allPlaced = [];
    for (let i = 0; i <= 24; i += 1) {
      const theta = (i / 24) * Math.PI * 1.5;
      const target = {
        x: Math.cos(theta) * 0.65,
        y: Math.sin(theta * 2) * 0.3,
        z: Math.sin(theta) * 0.65
      };
      const res = buildConnectedVoxelPath(cursor, target, {
        step: VOXEL_STEP,
        blockScale: 1,
        maxSteps: 64
      });
      if (res.path.length > 0) {
        for (const v of res.path) allPlaced.push(v);
      }
      cursor = res.lastPoint;
    }

    assert.ok(allPlaced.length > 40, `Expected rich 3D curve, got ${allPlaced.length} voxels`);
    for (let i = 1; i < allPlaced.length; i += 1) {
      assert.equal(
        areVoxelsFaceConnected(allPlaced[i - 1], allPlaced[i], {
          step: VOXEL_STEP,
          blockScale: 1
        }),
        true,
        `Curve broke between #${i - 1} and #${i}`
      );
    }
  });

  test('All Block Size presets (S/M/L/XL) connect face-to-face on their scaled lattice and continue cleanly across maxSteps cap', () => {
    assert.equal(BLOCK_SIZE_PRESETS.length, 4);
    assert.equal(STANDARD_COLOR_PRESETS.length, 12);

    for (const preset of BLOCK_SIZE_PRESETS) {
      const cell = getVoxelCellStep(VOXEL_STEP, preset.scale);
      const start = { x: 0, y: 0, z: 0 };
      const target = { x: cell * 10, y: cell * 6, z: cell * 4 };

      // Deliberately cap maxSteps to 8 per frame and verify continuation stays connected!
      let cur = start;
      const combined = [];
      for (let frame = 0; frame < 4; frame += 1) {
        const res = buildConnectedVoxelPath(cur, target, {
          step: VOXEL_STEP,
          blockScale: preset.scale,
          maxSteps: 8
        });
        combined.push(...res.path);
        cur = res.lastPoint;
      }

      assert.equal(combined.length, 20, `Expected 20 total steps for scale ${preset.scale}`);
      let prev = start;
      for (const v of combined) {
        assert.equal(v.scale, preset.scale);
        assert.equal(
          areVoxelsFaceConnected(prev, v, { step: VOXEL_STEP, blockScale: preset.scale }),
          true
        );
        prev = v;
      }
    }
  });

  test('computeAdjacentCandidateSlots & findBestAdjacentVoxelSlot let moving phone up/sideways select potential stacking spaces around placed blocks', () => {
    const placed = [{ x: 0, y: 0, z: 0.4, scale: 1 }];
    const slots = computeAdjacentCandidateSlots(placed, { step: VOXEL_STEP, blockScale: 1 });
    assert.equal(slots.length, 6);
    assert.ok(slots.some((s) => s.face === 'top' && s.y === VOXEL_STEP && s.x === 0 && s.z === 0.4));

    // Camera at (0, 0, 2.2) tilting slightly UP to aim right above the placed block at (0, 0.05, 0.4)
    const camPos = { x: 0, y: 0, z: 2.2 };
    const upDir = { x: 0, y: VOXEL_STEP, z: 0.4 - 2.2 };
    const topPick = findBestAdjacentVoxelSlot({
      rayOrigin: camPos,
      rayDir: upDir,
      voxels: placed,
      step: VOXEL_STEP,
      blockScale: 1
    });
    assert.ok(topPick);
    assert.equal(topPick.face, 'top');
    assert.deepEqual({ x: topPick.x, y: topPick.y, z: topPick.z }, { x: 0, y: VOXEL_STEP, z: 0.4 });
    assert.equal(topPick.nearbySlots.length, 5);

    // Moving phone slightly right selects the right neighbor space
    const rightDir = { x: VOXEL_STEP, y: 0, z: 0.4 - 2.2 };
    const rightPick = findBestAdjacentVoxelSlot({
      rayOrigin: camPos,
      rayDir: rightDir,
      voxels: placed,
      step: VOXEL_STEP,
      blockScale: 1
    });
    assert.ok(rightPick);
    assert.equal(rightPick.face, 'right');
    assert.deepEqual({ x: rightPick.x, y: rightPick.y, z: rightPick.z }, { x: VOXEL_STEP, y: 0, z: 0.4 });

    // Once top slot is occupied, moving further up selects the next slot above block 2 (y = 0.10)
    const stacked = [
      { x: 0, y: 0, z: 0.4, scale: 1 },
      { x: 0, y: VOXEL_STEP, z: 0.4, scale: 1 }
    ];
    const higherDir = { x: 0, y: VOXEL_STEP * 2, z: 0.4 - 2.2 };
    const thirdPick = findBestAdjacentVoxelSlot({
      rayOrigin: camPos,
      rayDir: higherDir,
      voxels: stacked,
      step: VOXEL_STEP,
      blockScale: 1
    });
    assert.ok(thirdPick);
    assert.equal(thirdPick.face, 'top');
    assert.equal(thirdPick.y, VOXEL_STEP * 2);

    // Aiming far into open air returns null so free-space placement works normally
    const farAway = findBestAdjacentVoxelSlot({
      rayOrigin: camPos,
      rayDir: { x: 1.5, y: 1.2, z: -1.8 },
      voxels: stacked,
      step: VOXEL_STEP,
      blockScale: 1
    });
    assert.equal(farAway, null);
  });

  test('advanceFluidSprayPoint starts immediately, filters slow tremor, and tracks fast spray-can sweeps smoothly', () => {
    const first = advanceFluidSprayPoint(null, { x: 0.1, y: 0.2, z: -1.5 });
    assert.deepEqual(first, { x: 0.1, y: 0.2, z: -1.5 });

    // Slow micro-movement is smoothed cleanly (< 50% step per 60Hz frame)
    const slow = advanceFluidSprayPoint(
      { x: 0, y: 0, z: 0 },
      { x: VOXEL_STEP * 0.4, y: 0, z: 0 },
      { dtMs: 16.67, cellStep: VOXEL_STEP }
    );
    assert.ok(slow.x > 0 && slow.x < VOXEL_STEP * 0.2);

    // Fast spray-can sweep responds rapidly (> 75% catch-up per 60Hz frame)
    const fast = advanceFluidSprayPoint(
      { x: 0, y: 0, z: 0 },
      { x: VOXEL_STEP * 4, y: 0, z: 0 },
      { dtMs: 16.67, cellStep: VOXEL_STEP }
    );
    assert.ok(fast.x > VOXEL_STEP * 3.0 && fast.x <= VOXEL_STEP * 4);
  });
});
