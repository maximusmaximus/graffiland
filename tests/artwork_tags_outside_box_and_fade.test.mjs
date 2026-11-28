import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildProjectedLandBox,
  computeSideArtworkCallouts,
  drawArtworkCalloutLeader,
  findBoxEntryPoint,
  getHorizontalSpanForBand,
  planOutsideBoxArtworkTag
} from '../client/src/utils/map3dLabelOverlay.js';

// Tilted isometric 3D land prism centered in a 1200x600 desktop viewport
function makeTiltedDesktopPrism() {
  return {
    bottom: [
      { x: 340, y: 310, visible: true },
      { x: 520, y: 210, visible: true },
      { x: 780, y: 360, visible: true },
      { x: 600, y: 460, visible: true }
    ],
    top: [
      { x: 340, y: 220, visible: true },
      { x: 520, y: 120, visible: true },
      { x: 780, y: 270, visible: true },
      { x: 600, y: 370, visible: true }
    ]
  };
}

describe('Desktop Map Artwork Tags Outside Land Box & Faded Box-Entry Leaders', () => {
  test('1. buildProjectedLandBox computes tight convex hull & horizontal band span of a tilted 3D prism', () => {
    const box = buildProjectedLandBox(makeTiltedDesktopPrism());
    assert.ok(box);
    assert.equal(box.minX, 340);
    assert.equal(box.maxX, 780);
    assert.equal(box.minY, 120);
    assert.equal(box.maxY, 460);
    assert.ok(box.hull.length >= 6, `Expected 6-vertex isometric hexagon hull, got ${box.hull.length}`);

    // Near the top vertex (y=150..180), the tilted hull is much narrower than [340, 780]
    const topSpan = getHorizontalSpanForBand(box, 150, 180);
    assert.ok(topSpan.leftX > 380, `Expected tilted top left edge > 380, got ${topSpan.leftX}`);
    assert.ok(topSpan.rightX < 680, `Expected tilted top right edge < 680, got ${topSpan.rightX}`);
  });

  test('2. computeSideArtworkCallouts docks desktop tags slightly outside closest side of land box (not pinned to far screen edges)', () => {
    const landBox = buildProjectedLandBox(makeTiltedDesktopPrism());
    const sculptures = [
      { id: 'sc-left', title: 'Left Mural', modelType: 'custom-3d', customModel: { format: 'glb' }, lat: 39.73, lng: -121.84 },
      { id: 'sc-right', title: 'Cloud Sheep', modelType: 'custom-3d', customModel: { format: 'glb' }, lat: 39.73, lng: -121.84 }
    ];

    const callouts = computeSideArtworkCallouts({
      sculptures,
      volume: { centerLat: 39.73, centerLng: -121.84, heightMeters: 12 },
      viewportWidth: 1200,
      viewportHeight: 600,
      marginPx: 14,
      labelHeight: 40,
      gapPx: 8,
      landBox,
      dockOutsideBox: true,
      boxGapPx: 20,
      projectScreenPt: (_lng, _lat, _alt, sc) =>
        sc.id === 'sc-left'
          ? { x: 410, y: 290 } // Close to left wall (x=340)
          : { x: 690, y: 280 } // Close to right wall (x=780)
    });

    const leftTag = callouts.find((c) => c.sculptureId === 'sc-left');
    const rightTag = callouts.find((c) => c.sculptureId === 'sc-right');
    assert.ok(leftTag && rightTag);

    // Closest side selection
    assert.equal(leftTag.side, 'left');
    assert.equal(rightTag.side, 'right');

    // Docked SLIGHTLY outside the land box (~20px), NOT pinned way out at x=14 / x=1050!
    assert.ok(
      leftTag.x > 100 && leftTag.x + leftTag.width <= landBox.minX - 18,
      `Expected left tag hugging slightly outside left box edge (${landBox.minX}), got x=${leftTag.x}..${leftTag.x + leftTag.width}`
    );
    const rightBand = getHorizontalSpanForBand(landBox, rightTag.y, rightTag.y + rightTag.height);
    assert.ok(
      rightTag.x >= rightBand.rightX + 18 && rightTag.x < 920,
      `Expected right tag hugging slightly outside right box edge (${rightBand.rightX}), got x=${rightTag.x}`
    );

    // Both callouts have exact boxEntry points on the box hull before reaching target
    assert.ok(leftTag.boxEntry && !leftTag.boxEntry.fromInside);
    assert.ok(rightTag.boxEntry && !rightTag.boxEntry.fromInside);
    assert.equal(leftTag.fadeInsideBox, true);
    assert.equal(rightTag.fadeInsideBox, true);
    assert.ok(
      leftTag.boxEntry.x >= leftTag.fromX && leftTag.boxEntry.x <= leftTag.targetX,
      `Expected left boxEntry.x (${leftTag.boxEntry.x}) strictly between tag (${leftTag.fromX}) and target (${leftTag.targetX})`
    );
    assert.ok(
      rightTag.boxEntry.x <= rightTag.fromX && rightTag.boxEntry.x >= rightTag.targetX,
      `Expected right boxEntry.x (${rightTag.boxEntry.x}) strictly between tag (${rightTag.fromX}) and target (${rightTag.targetX})`
    );
  });

  test('3. drawArtworkCalloutLeader keeps exterior crisp and smoothly fades interior line after entering box wall', () => {
    const landBox = buildProjectedLandBox(makeTiltedDesktopPrism());
    const fromPt = { x: 320, y: 290 };
    const elbowPt = { x: 329, y: 290 };
    const targetPt = { x: 460, y: 290 };
    const boxEntry = findBoxEntryPoint(landBox, fromPt, elbowPt, targetPt);
    assert.ok(boxEntry && !boxEntry.fromInside);
    assert.ok(Math.abs(boxEntry.x - 340) <= 1.5, `Expected entry right on x=340 left wall, got ${boxEntry.x}`);

    const gradients = [];
    const strokes = [];
    const mockCtx = {
      save() {},
      restore() {},
      beginPath() {
        this._pts = [];
      },
      moveTo(x, y) {
        this._pts.push({ x, y });
      },
      lineTo(x, y) {
        this._pts.push({ x, y });
      },
      closePath() {},
      arc() {},
      fill() {},
      setLineDash() {},
      createLinearGradient(x0, y0, x1, y1) {
        const g = { x0, y0, x1, y1, stops: [] };
        g.addColorStop = (off, col) => g.stops.push({ off, col });
        gradients.push(g);
        return g;
      },
      stroke() {
        strokes.push({
          pts: [...(this._pts || [])],
          strokeStyle: this.strokeStyle,
          lineWidth: this.lineWidth
        });
      }
    };

    drawArtworkCalloutLeader(mockCtx, {
      fromX: fromPt.x,
      fromY: fromPt.y,
      elbowX: elbowPt.x,
      elbowY: elbowPt.y,
      targetX: targetPt.x,
      targetY: targetPt.y,
      boxEntry,
      fadeInsideBox: true,
      isSelected: false,
      isPendingPreview: false
    });

    // Should draw exterior halo + exterior stem + faded interior gradient segment
    assert.equal(strokes.length, 3);
    const interiorStroke = strokes[2];
    assert.ok(
      Math.abs(interiorStroke.pts[0].x - boxEntry.x) <= 1.5 &&
        Math.abs(interiorStroke.pts[1].x - targetPt.x) <= 1.5,
      'Interior faded stroke must begin at boxEntry and end at artwork target'
    );
    const interiorGrad = interiorStroke.strokeStyle;
    assert.ok(interiorGrad && Array.isArray(interiorGrad.stops) && interiorGrad.stops.length === 3);
    const extractAlpha = (rgba) => Number(String(rgba).match(/,\s*([0-9.]+)\)$/)?.[1] ?? 1);
    const a0 = extractAlpha(interiorGrad.stops[0].col);
    const a1 = extractAlpha(interiorGrad.stops[1].col);
    const a2 = extractAlpha(interiorGrad.stops[2].col);
    assert.ok(a0 > a1 && a1 > a2 && a2 <= 0.25, `Expected smooth fade inside box (${a0} -> ${a1} -> ${a2})`);

    // Exterior dark halo must fade out to alpha 0 right at the box border so it never cuts across box lines
    const haloGrad = strokes[0].strokeStyle;
    assert.equal(extractAlpha(haloGrad.stops[haloGrad.stops.length - 1].col), 0);
  });

  test('4. planOutsideBoxArtworkTag keeps desktop 3D map artwork tags outside parent & sibling boxes without overlap', () => {
    const parentBox = buildProjectedLandBox(makeTiltedDesktopPrism());
    const siblingBoxRect = { x: 820, y: 180, w: 180, h: 160 };

    const planRight = planOutsideBoxArtworkTag({
      targetPt: { x: 660, y: 290 },
      elWidth: 140,
      elHeight: 28,
      viewportWidth: 1200,
      viewportHeight: 600,
      parentBox,
      placedOverlayRects: [],
      avoidBoxRects: [siblingBoxRect],
      boxGapPx: 18
    });

    assert.equal(planRight.fadeInsideBox, true);
    assert.ok(planRight.boxEntry && !planRight.boxEntry.fromInside);

    // Second artwork stacked near same height must NOT overlap the first placed tag
    const planSecond = planOutsideBoxArtworkTag({
      targetPt: { x: 400, y: 295 },
      elWidth: 140,
      elHeight: 28,
      viewportWidth: 1200,
      viewportHeight: 600,
      parentBox,
      placedOverlayRects: [planRight.rect],
      avoidBoxRects: [siblingBoxRect],
      boxGapPx: 18
    });

    assert.equal(planSecond.side, 'left');
    assert.ok(
      planSecond.rect.x + planSecond.rect.w <= parentBox.minX - 16,
      `Expected left map3d tag strictly outside parent box (${parentBox.minX}), got right edge ${planSecond.rect.x + planSecond.rect.w}`
    );
    assert.ok(planSecond.boxEntry && !planSecond.boxEntry.fromInside);
  });
});
