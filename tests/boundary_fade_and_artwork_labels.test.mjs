import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  colorWithAlpha,
  computeGizmoDepthProfile,
  computePrismCornerFadeAlphas,
  computePrismVisibility,
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

  test('drawDepthFadedPrismEdges supports includeBottomEdges=false so ground edges render strictly behind 3D models', () => {
    const bottom = [
      { x: 180, y: 80, depth: 20 },
      { x: 240, y: 115, depth: 15 },
      { x: 180, y: 150, depth: 10 },
      { x: 120, y: 115, depth: 15 }
    ];
    const top = bottom.map((p) => ({ ...p, y: p.y - 60 }));

    let strokesNoBottom = 0;
    const mockCtx = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {
        strokesNoBottom += 1;
      },
      createLinearGradient() {
        return { addColorStop() {} };
      }
    };

    drawDepthFadedPrismEdges(mockCtx, { bottom, top }, {
      outerColor: '#ff1f8f',
      innerColor: '#ffd6ec',
      lineWidth: 2.2,
      glowBlur: 12,
      includeBottomEdges: false
    });
    assert.equal(
      strokesNoBottom,
      24,
      'With includeBottomEdges=false, only the 8 elevated vertical+top edges (x3 passes = 24 strokes) should draw on the foreground canvas'
    );
  });

  test('All 3D MapLibre map views render the pink land bottom floor strictly BEHIND 3D models (never in the foreground)', () => {
    const mapFiles = [
      {
        file: 'client/src/components/MapView3D.jsx',
        floorFillId: 'owned-lands-floor-fill',
        floorOutlineId: 'owned-lands-floor-outline',
        threeLayerId: 'sculptures-three-3d',
        forbiddenExtrusions: ['owned-lands-extrusion']
      },
      {
        file: 'client/src/components/studio/MobileIsometricMap.jsx',
        floorFillId: 'mobile-iso-lands-floor-fill',
        floorOutlineId: 'mobile-iso-lands-floor-outline',
        threeLayerId: 'mobile-iso-sculptures-three-3d',
        forbiddenExtrusions: ['mobile-iso-lands-extrusion']
      },
      {
        file: 'client/src/components/LandIsometricPreview.jsx',
        floorFillId: 'preview-selected-land-floor-fill',
        floorOutlineId: 'preview-selected-land-floor-outline',
        threeLayerId: 'preview-sculptures-three-3d',
        forbiddenExtrusions: ['preview-selected-land-extrusion', 'preview-other-lands-extrusion']
      }
    ];

    for (const cfg of mapFiles) {
      const src = fs.readFileSync(path.resolve(process.cwd(), cfg.file), 'utf8');

      const fillIdx = src.indexOf(`id: '${cfg.floorFillId}'`);
      const outlineIdx = src.indexOf(`id: '${cfg.floorOutlineId}'`);
      const threeIdx = src.indexOf(`id: '${cfg.threeLayerId}'`);

      assert.ok(fillIdx > 0, `${cfg.file} must define ground floor fill layer '${cfg.floorFillId}'`);
      assert.ok(outlineIdx > 0, `${cfg.file} must define ground floor outline layer '${cfg.floorOutlineId}'`);
      assert.ok(threeIdx > 0, `${cfg.file} must define Three.js 3D sculpture layer '${cfg.threeLayerId}'`);
      assert.ok(
        fillIdx < threeIdx && outlineIdx < threeIdx,
        `${cfg.file} must mount ground floor fill/outline layers BEFORE Three.js 3D sculptures`
      );
      assert.match(
        src,
        /map\.addLayer\(threeLayer\);/,
        `${cfg.file} must add threeLayer AFTER the ground land floor layers (never beforeId behind a pink land layer)`
      );
      assert.equal(
        /ctx\.fillStyle\s*=\s*['"]rgba\(255,\s*31,\s*143/.test(src),
        false,
        `${cfg.file} must NOT paint a foreground pink floor polygon on the 2D overlay canvas`
      );
      for (const badLayer of cfg.forbiddenExtrusions) {
        assert.equal(
          src.includes(badLayer),
          false,
          `${cfg.file} must NOT mount foreground pink fill-extrusion layer '${badLayer}' over 3D models`
        );
      }
    }
  });

  test('computePrismVisibility detects occluded bottom edges behind overhanging top faces regardless of CW/CCW winding', () => {
    // Perspective projection facing one front wall (side 2 visible; back/left/right occluded inside top face overhang)
    const top = [
      { x: 100, y: 130, depth: 18 },
      { x: 750, y: 20, depth: 18 },
      { x: 920, y: 580, depth: 10 },
      { x: 200, y: 760, depth: 10 }
    ];
    const bottom = [
      { x: 190, y: 400, depth: 20 },
      { x: 750, y: 270, depth: 20 },
      { x: 900, y: 800, depth: 12 },
      { x: 290, y: 960, depth: 12 }
    ];

    const vis = computePrismVisibility(bottom, top);
    assert.equal(vis.is3DProjected, true);
    assert.deepEqual(
      vis.bottomEdgeVisible,
      [false, false, true, false],
      'Back, right, and left bottom bars under the overhanging top face must be classified occluded; front bar visible'
    );
    assert.deepEqual(
      vis.columnVisible,
      [false, false, true, true],
      'Back-left and back-right bottom corners/columns must be occluded; front columns visible'
    );

    // Reverse winding order (CCW) must yield the exact same physical visibility on reversed edge indices
    const topRev = [top[0], top[3], top[2], top[1]];
    const bottomRev = [bottom[0], bottom[3], bottom[2], bottom[1]];
    const visRev = computePrismVisibility(bottomRev, topRev);
    assert.equal(visRev.is3DProjected, true);
    assert.deepEqual(
      visRev.bottomEdgeVisible,
      [false, true, false, false],
      'Reversed (CCW) winding must still identify only the front wall (edge 1 in reversed order) as visible'
    );

    // Classic 45° isometric view: 2 front walls visible (1->2, 2->3), 2 back walls occluded (0->1, 3->0)
    const isoBottom = [
      { x: 180, y: 80, depth: 20 },
      { x: 240, y: 115, depth: 15 },
      { x: 180, y: 150, depth: 10 },
      { x: 120, y: 115, depth: 15 }
    ];
    const isoTop = isoBottom.map((p) => ({ ...p, y: p.y - 60 }));
    const isoVis = computePrismVisibility(isoBottom, isoTop);
    assert.deepEqual(isoVis.bottomEdgeVisible, [false, true, true, false]);
    assert.deepEqual(isoVis.columnVisible, [false, true, true, true]);

    // Flat 2D top-down (top === bottom): must NOT mark edges occluded
    const flatVis = computePrismVisibility(isoBottom, isoBottom);
    assert.equal(flatVis.is3DProjected, false);
    assert.deepEqual(flatVis.bottomEdgeVisible, [true, true, true, true]);
  });

  test('computeGizmoDepthProfile strongly fades occluded bottom bars beneath top rim bars and promotes hovered handles', () => {
    const top = [
      { x: 100, y: 130, depth: 18 },
      { x: 750, y: 20, depth: 18 },
      { x: 920, y: 580, depth: 10 },
      { x: 200, y: 760, depth: 10 }
    ];
    const bottom = [
      { x: 190, y: 400, depth: 20 },
      { x: 750, y: 270, depth: 20 },
      { x: 900, y: 800, depth: 12 },
      { x: 290, y: 960, depth: 12 }
    ];

    const profile = computeGizmoDepthProfile(bottom, top);
    const backBottom = profile.bottomBars.find((b) => b.index === 0);
    const frontBottom = profile.bottomBars.find((b) => b.index === 2);
    const minTopBarAlpha = Math.min(...profile.topBars.map((b) => b.alpha));
    const minTopBarWidth = Math.min(...profile.topBars.map((b) => b.width));

    assert.equal(backBottom.isOccluded, true, 'Back-bottom bar behind top face must be marked occluded');
    assert.ok(backBottom.alpha <= 0.25, `Occluded bottom bar must fade heavily, got alpha=${backBottom.alpha}`);
    assert.ok(backBottom.haloAlpha <= 0.12, `Occluded bottom bar dark halo must stay subtle, got ${backBottom.haloAlpha}`);
    assert.ok(backBottom.coreAlpha <= 0.15, `Occluded bottom bar white core must stay subtle, got ${backBottom.coreAlpha}`);

    assert.equal(frontBottom.isOccluded, false, 'Front-bottom exterior bar must be unoccluded');
    assert.ok(
      frontBottom.alpha > backBottom.alpha + 0.25,
      'Visible front-bottom bar must read clearer than occluded back-bottom bars'
    );
    assert.ok(
      frontBottom.alpha < minTopBarAlpha,
      `Front-bottom bar (${frontBottom.alpha}) must remain softer than top rim bars (${minTopBarAlpha})`
    );
    assert.ok(
      frontBottom.width < minTopBarWidth,
      `Front-bottom bar (${frontBottom.width}) must be slimmer than top rim bars (${minTopBarWidth})`
    );

    // Painter ordering: occluded bottom bars draw strictly before visible front-bottom bar
    const backIdx = profile.bottomBars.findIndex((b) => b.index === 0);
    const frontIdx = profile.bottomBars.findIndex((b) => b.index === 2);
    assert.ok(backIdx < frontIdx, 'Occluded bottom bars must sort ahead of visible bottom bars');

    // Bottom corner balls must stay smaller & softer than top corner balls
    const maxBotCornerR = Math.max(...profile.bottomCorners.map((c) => c.radius));
    const minTopCornerR = Math.min(...profile.topCorners.map((c) => c.radius));
    assert.ok(maxBotCornerR < minTopCornerR, 'Bottom corner balls must stay smaller than top corner balls');

    // Hovering/dragging an occluded bottom bar restores ONLY that bar to full highlight
    const activeProfile = computeGizmoDepthProfile(bottom, top, { activeHandle: 'edge-0' });
    const activeBack = activeProfile.bottomBars.find((b) => b.index === 0);
    const inactiveSide = activeProfile.bottomBars.find((b) => b.index === 1);
    assert.equal(activeBack.isActive, true);
    assert.equal(activeBack.alpha, 1);
    assert.equal(inactiveSide.isActive, false);
    assert.ok(inactiveSide.alpha <= 0.25);
  });
});
