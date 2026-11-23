import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  colorWithAlpha,
  computePrismCornerFadeAlphas,
  computeThreeCornersDepthAlphas,
  createDepthFadedThreeBoxWireframe,
  drawDepthFadedPrismEdges,
  updateThreeWireframeDepthFade
} from '../client/src/utils/prismDepthFade.js';

describe('Depth-Faded 3D Boundaries (>=25% Far-Side Fade Across MapLibre, Viewer & AR)', () => {
  test('computePrismCornerFadeAlphas keeps near lines clear (1.0) and fades far-side lines by at least 25% in back-to-front painter order', () => {
    // Isometric corners: corner 2 is closest (depth 10), corner 0 is farthest away across the figure (depth 20)
    const bottom = [
      { x: 180, y: 80, depth: 20 },
      { x: 240, y: 115, depth: 15 },
      { x: 180, y: 150, depth: 10 },
      { x: 120, y: 115, depth: 15 }
    ];
    const top = bottom.map((p) => ({ ...p, y: p.y - 60 }));

    const fade = computePrismCornerFadeAlphas(bottom, top);
    assert.equal(fade.columnAlphas[2], 1.0, 'Closest corner to user must be 100% clear');
    assert.ok(
      fade.columnAlphas[0] <= 0.75,
      `Farthest corner away from user must be faded by >=25%, got alpha=${fade.columnAlphas[0]}`
    );
    assert.ok(
      fade.columnAlphas[2] - fade.columnAlphas[0] >= 0.25,
      'Near-to-far alpha drop must be at least 0.25'
    );
    assert.equal(fade.edges.length, 12, 'Expected all 12 prism edges');

    // Painter's order: farthest edges drawn first, clearest front edges drawn last
    for (let i = 1; i < fade.edges.length; i++) {
      assert.ok(
        fade.edges[i - 1].depthT >= fade.edges[i].depthT - 1e-6,
        'Edges must be sorted strictly back-to-front'
      );
    }

    // Even if a caller passes farAlpha=0.92, invariant clamps far-side fade to >=25%
    const clamped = computePrismCornerFadeAlphas(bottom, top, { nearAlpha: 1.0, farAlpha: 0.92 });
    assert.ok(
      clamped.columnAlphas[0] <= 0.75,
      `Minimum 25% far fade must be enforced even when farAlpha=0.92, got ${clamped.columnAlphas[0]}`
    );
  });

  test('drawDepthFadedPrismEdges emits linear depth gradients and lower opacity on far-side edges', () => {
    const bottom = [
      { x: 180, y: 80, depth: 20 },
      { x: 240, y: 115, depth: 15 },
      { x: 180, y: 150, depth: 10 },
      { x: 120, y: 115, depth: 15 }
    ];
    const top = bottom.map((p) => ({ ...p, y: p.y - 60 }));

    let strokes = 0;
    let gradients = 0;
    const mockCtx = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {
        strokes += 1;
      },
      createLinearGradient() {
        gradients += 1;
        return { addColorStop() {} };
      }
    };

    const res = drawDepthFadedPrismEdges(mockCtx, { bottom, top }, {
      outerColor: '#00f5d4',
      innerColor: '#eafffc',
      lineWidth: 2.2,
      glowBlur: 12
    });
    assert.ok(res);
    assert.equal(strokes, 36, 'Expected 12 edges x 3 layered passes (dark halo + outer glow + inner core)');
    assert.ok(gradients >= 16, 'Expected front-to-back diagonal edges to stroke with smooth linear gradients');
    assert.equal(colorWithAlpha('#00f5d4', 0.5), 'rgba(0, 245, 212, 0.500)');
  });

  test('Three.js depth-faded wireframe keeps near corners crisp, fades opposite corners >=25%, and adapts when camera orbits 180°', () => {
    // Tall 4x18x4 boundary box (verifying horizontal plan depth never inverts on tall figures!)
    const wire = createDepthFadedThreeBoxWireframe(4, 18, 4, 0x00f5d4, {
      nearOpacity: 0.96,
      farOpacity: 0.4
    });

    // Camera on +Z/+X front-right looking at box
    const camFront = new THREE.Vector3(6, 12, 6);
    updateThreeWireframeDepthFade(wire, camFront);
    const alphasFront = Array.from(wire.geometry.attributes.aAlpha.array);
    const maxA = Math.max(...alphasFront);
    const minA = Math.min(...alphasFront);
    assert.ok(maxA >= 0.95, `Expected near corner opacity >= 0.95, got ${maxA}`);
    assert.ok(minA <= maxA * 0.75, `Expected far corner opacity <= 75% of near (${maxA * 0.75}), got ${minA}`);

    // Direct corner check: corner (+2, 0, +2) is closest to (6, 12, 6); corner (-2, 0, -2) is farthest!
    const corners = [
      new THREE.Vector3(-2, 0, -2),
      new THREE.Vector3(2, 0, -2),
      new THREE.Vector3(2, 0, 2),
      new THREE.Vector3(-2, 0, 2)
    ];
    const fromFront = computeThreeCornersDepthAlphas(corners, camFront);
    assert.ok(fromFront[2] > fromFront[0] + 0.4, 'Front corner (+2,+2) must be much clearer than far corner (-2,-2)');

    // Orbit camera 180° to opposite side (-6, 12, -6): now (-2,-2) is crisp and (+2,+2) fades >=25%!
    const camBack = new THREE.Vector3(-6, 12, -6);
    const fromBack = computeThreeCornersDepthAlphas(corners, camBack);
    assert.ok(fromBack[0] > fromBack[2] + 0.4, 'After 180° orbit, (-2,-2) must be crisp and (+2,+2) must fade');
    assert.ok(fromBack[2] <= fromBack[0] * 0.75);
  });
});
