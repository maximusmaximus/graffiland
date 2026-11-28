import {
  extractSculptureBaseDimensions,
  extractSculptureScale,
  parcelLocalOffsetToWorldLatLng
} from '../../../shared/sculpturePlacement.mjs';
import { placeFloatingLabelRect } from './canvasLabelLayout.js';
import { buildSculptureShareUrl } from './clipboard.js';

/**
 * Shared 2D canvas overlay helper for 3D map wireframes.
 * Always called in Pass 2 (after all prism wireframes and gizmos are drawn)
 * so floating labels sit strictly on top of wireframes with a thin arrow
 * connecting cleanly to the exact top center of the land boundary.
 */

export function getPrismLabelAnchor(geom) {
  if (!geom || !Array.isArray(geom.bottom) || geom.bottom.length < 4) return null;
  const { bottom, top, topCenter } = geom;
  const baseCenter = {
    x: (bottom[0].x + bottom[1].x + bottom[2].x + bottom[3].x) / 4,
    y: (bottom[0].y + bottom[1].y + bottom[2].y + bottom[3].y) / 4
  };
  const roofCenter =
    topCenter && Number.isFinite(topCenter.x) && Number.isFinite(topCenter.y)
      ? topCenter
      : {
          x: (top[0].x + top[1].x + top[2].x + top[3].x) / 4,
          y: (top[0].y + top[1].y + top[2].y + top[3].y) / 4
        };
  const highestTopY = Math.min(
    roofCenter.y,
    ...top.map((pt) => (Number.isFinite(pt.y) ? pt.y : roofCenter.y))
  );
  const visible =
    (topCenter ? topCenter.visible !== false : true) &&
    Number.isFinite(baseCenter.x) &&
    Number.isFinite(baseCenter.y) &&
    Number.isFinite(roofCenter.x) &&
    Number.isFinite(highestTopY);

  return {
    visible,
    baseCenter,
    roofCenter,
    highestTopY
  };
}

/**
 * Draws only the thin glowing vertical arrow connecting a land's exact center
 * up to a target point (e.g. the bottom edge of a floating HTML label pin).
 */
export function drawFloatingCenterArrow(
  ctx,
  { fromX, fromY, toX, toY, color = '#00f5d4', dotColor = '#ffffff' }
) {
  if (!ctx) return;
  if (
    !Number.isFinite(fromX) ||
    !Number.isFinite(fromY) ||
    !Number.isFinite(toX) ||
    !Number.isFinite(toY)
  ) {
    return;
  }

  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;

  ctx.save();
  // Dark halo stroke for crisp contrast over bright map tiles or wireframes
  ctx.strokeStyle = 'rgba(4, 10, 20, 0.78)';
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Thin glowing leader stem
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Crisp small arrowhead pointing toward the land center (toX, toY)
  const angle = Math.atan2(dy, dx);
  const headLen = 5.5;
  const spread = 0.5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - spread),
    toY - headLen * Math.sin(angle - spread)
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + spread),
    toY - headLen * Math.sin(angle + spread)
  );
  ctx.closePath();
  ctx.fill();

  // Subtle center anchor dot
  ctx.shadowBlur = 4;
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(toX, toY, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Draws a floating pill label strictly above a 3D wireframe prism,
 * with a thin vertical arrow descending to the exact center of the land.
 */
export function drawFloatingLandLabel(
  ctx,
  geom,
  {
    label = '',
    outerColor = '#00f5d4',
    innerColor = '#eafffc',
    liftPx = 20,
    minY = 12,
    font = '',
    stageWidth = 0,
    stageHeight = 0,
    reservedRects = null,
    placedRects = null,
    isPrimary = false
  }
) {
  if (!ctx || !label) return null;
  const anchor = getPrismLabelAnchor(geom);
  if (!anchor || !anchor.visible) return null;

  const fontSizePx = isPrimary ? 12.5 : 10.5;
  const resolvedFont =
    font ||
    `${isPrimary ? 800 : 700} ${fontSizePx}px "JetBrains Mono", ui-monospace, monospace`;

  ctx.save();
  ctx.font = resolvedFont;
  const textW = ctx.measureText(label).width;
  const padX = isPrimary ? 11 : 8;
  const boxW = textW + padX * 2;
  const boxH = isPrimary ? 25 : 20;
  let bx = anchor.roofCenter.x - boxW / 2;
  let by = Math.max(minY, anchor.highestTopY - boxH - liftPx);

  if (
    stageWidth > 0 &&
    stageHeight > 0 &&
    (Array.isArray(reservedRects) || Array.isArray(placedRects))
  ) {
    const placed = placeFloatingLabelRect({
      desiredX: bx,
      desiredY: by,
      width: boxW,
      height: boxH,
      stageWidth,
      stageHeight,
      reservedRects: reservedRects || [],
      placedRects: placedRects || [],
      isPrimary,
      topMinY: minY
    });
    if (!placed) {
      ctx.restore();
      return null;
    }
    bx = placed.x;
    by = placed.y;
    if (Array.isArray(placedRects)) {
      placedRects.push({ x: bx, y: by, w: boxW, h: boxH });
    }
  }

  const pillCenterX = bx + boxW / 2;

  // Leader arrow from bottom of floating pill strictly to the top center of the land boundary
  drawFloatingCenterArrow(ctx, {
    fromX: pillCenterX,
    fromY: by + boxH,
    toX: anchor.roofCenter.x,
    toY: anchor.roofCenter.y,
    color: outerColor,
    dotColor: innerColor
  });

  // Floating pill container (drawn strictly on top of stem and all wireframes)
  ctx.fillStyle = isPrimary ? 'rgba(6, 10, 22, 0.96)' : 'rgba(6, 10, 20, 0.92)';
  ctx.strokeStyle = outerColor;
  ctx.lineWidth = isPrimary ? 1.75 : 1.15;
  ctx.shadowColor = isPrimary ? outerColor : 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = isPrimary ? 12 : 8;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bx, by, boxW, boxH, isPrimary ? 8 : 6);
  } else {
    ctx.rect(bx, by, boxW, boxH);
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();

  ctx.fillStyle = innerColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, pillCenterX, by + boxH / 2 + 0.5);
  ctx.restore();

  return { x: bx, y: by, width: boxW, height: boxH, fontSizePx, isPrimary, anchor };
}

/**
 * Computes screen placement for a clickable HTML land label floating strictly above
 * a 3D prism wireframe, clamped cleanly inside viewport bounds.
 */
export function computeFloatingLandLabelBox(
  geom,
  { viewportWidth = 400, liftPx = 22, minY = 52, pillHeight = 28, approxWidth = 170 } = {}
) {
  const anchor = getPrismLabelAnchor(geom);
  if (!anchor || !anchor.visible) return null;
  const halfW = approxWidth / 2;
  const minCenterX = Math.min(viewportWidth / 2, halfW + 10);
  const maxCenterX = Math.max(viewportWidth / 2, viewportWidth - halfW - 10);
  const centerX = Math.max(minCenterX, Math.min(maxCenterX, anchor.roofCenter.x));
  const y = Math.max(minY, anchor.highestTopY - pillHeight - liftPx);
  return {
    centerX,
    y,
    height: pillHeight,
    fromX: centerX,
    fromY: y + pillHeight,
    toX: anchor.roofCenter.x,
    toY: anchor.roofCenter.y,
    anchor
  };
}

function computeConvexHull2D(points) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const sorted = [...points]
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function pointInConvexPolygon(pt, hull) {
  if (!pt || !Array.isArray(hull) || hull.length < 3) return false;
  let hasPos = false;
  let hasNeg = false;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const c = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    if (c > 1e-4) hasPos = true;
    else if (c < -1e-4) hasNeg = true;
    if (hasPos && hasNeg) return false;
  }
  return true;
}

function intersectSegments2D(p1, p2, p3, p4) {
  const dx1 = p2.x - p1.x;
  const dy1 = p2.y - p1.y;
  const dx2 = p4.x - p3.x;
  const dy2 = p4.y - p3.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-7) return null;
  const t = ((p3.x - p1.x) * dy2 - (p3.y - p1.y) * dx2) / denom;
  const u = ((p3.x - p1.x) * dy1 - (p3.y - p1.y) * dx1) / denom;
  if (t >= -1e-4 && t <= 1 + 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) {
    const ct = Math.max(0, Math.min(1, t));
    return {
      x: p1.x + ct * dx1,
      y: p1.y + ct * dy1,
      t: ct
    };
  }
  return null;
}

/**
 * Builds screen-space convex hull & axis bounds for a projected 3D land prism
 * (`{ bottom, top }`) or 2D parcel polygon (`[{ x, y }, ...]` or `[[x, y], ...]`).
 */
export function buildProjectedLandBox(geomOrPoints) {
  if (!geomOrPoints) return null;
  const rawPts = [];
  const pushPt = (pt) => {
    if (!pt) return;
    if (Array.isArray(pt) && pt.length >= 2) {
      const x = Number(pt[0]);
      const y = Number(pt[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) rawPts.push({ x, y });
      return;
    }
    const x = Number(pt.x);
    const y = Number(pt.y);
    if (Number.isFinite(x) && Number.isFinite(y) && pt.visible !== false) {
      rawPts.push({ x, y });
    }
  };

  if (Array.isArray(geomOrPoints)) {
    for (const p of geomOrPoints) pushPt(p);
  } else {
    if (Array.isArray(geomOrPoints.bottom)) {
      for (const p of geomOrPoints.bottom) pushPt(p);
    }
    if (Array.isArray(geomOrPoints.top)) {
      for (const p of geomOrPoints.top) pushPt(p);
    }
  }

  if (rawPts.length < 3) return null;
  const hull = computeConvexHull2D(rawPts);
  if (hull.length < 3) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;

  return {
    hull,
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

/**
 * Returns the exact outermost `[leftX, rightX]` horizontal span of a projected land box's
 * convex hull across the vertical band `[yTop, yBottom]`, so tags hugging the tilted 3D
 * prism stay tightly outside without ever overlapping a corner or edge.
 */
export function getHorizontalSpanForBand(landBox, yTop, yBottom) {
  if (!landBox || !Array.isArray(landBox.hull) || landBox.hull.length < 3) {
    return null;
  }
  const top = Math.min(yTop, yBottom);
  const bot = Math.max(yTop, yBottom);
  const mid = (top + bot) / 2;
  const hull = landBox.hull;
  const xs = [];

  for (const v of hull) {
    if (v.y >= top - 0.5 && v.y <= bot + 0.5) {
      xs.push(v.x);
    }
  }

  const sampleYs = [top, mid, bot];
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-6) {
      if (a.y >= top - 0.5 && a.y <= bot + 0.5) {
        xs.push(a.x, b.x);
      }
      continue;
    }
    for (const sy of sampleYs) {
      const t = (sy - a.y) / dy;
      if (t >= -1e-4 && t <= 1 + 1e-4) {
        const ct = Math.max(0, Math.min(1, t));
        xs.push(a.x + ct * (b.x - a.x));
      }
    }
  }

  if (xs.length === 0) {
    return { leftX: landBox.minX, rightX: landBox.maxX };
  }
  return {
    leftX: Math.min(...xs),
    rightX: Math.max(...xs)
  };
}

/**
 * Finds the exact screen coordinate where a polyline `fromPt -> elbowPt -> targetPt`
 * first enters a projected land box's outer convex hull.
 * Returns `{ x, y, segment: 'stub' | 'main', t, fromInside }` or `null`.
 */
export function findBoxEntryPoint(landBox, fromPt, elbowPt, targetPt) {
  if (!landBox || !Array.isArray(landBox.hull) || landBox.hull.length < 3) return null;
  if (!fromPt || !targetPt) return null;

  const hull = landBox.hull;
  const fromInside = pointInConvexPolygon(fromPt, hull);
  if (fromInside) {
    return { x: fromPt.x, y: fromPt.y, segment: 'inside', t: 0, fromInside: true };
  }

  const findFirstHit = (a, b) => {
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 1e-3) return null;
    let best = null;
    for (let i = 0; i < hull.length; i += 1) {
      const hit = intersectSegments2D(a, b, hull[i], hull[(i + 1) % hull.length]);
      if (!hit || hit.t <= 0.002 || hit.t >= 0.998) continue;
      if (!best || hit.t < best.t) best = hit;
    }
    return best;
  };

  if (elbowPt && Math.hypot(elbowPt.x - fromPt.x, elbowPt.y - fromPt.y) >= 1) {
    const stubHit = findFirstHit(fromPt, elbowPt);
    if (stubHit) {
      return {
        x: Math.round(stubHit.x * 10) / 10,
        y: Math.round(stubHit.y * 10) / 10,
        segment: 'stub',
        t: stubHit.t,
        fromInside: false
      };
    }
    const mainHit = findFirstHit(elbowPt, targetPt);
    if (mainHit) {
      return {
        x: Math.round(mainHit.x * 10) / 10,
        y: Math.round(mainHit.y * 10) / 10,
        segment: 'main',
        t: mainHit.t,
        fromInside: false
      };
    }
  } else {
    const directHit = findFirstHit(fromPt, targetPt);
    if (directHit) {
      return {
        x: Math.round(directHit.x * 10) / 10,
        y: Math.round(directHit.y * 10) / 10,
        segment: 'main',
        t: directHit.t,
        fromInside: false
      };
    }
  }
  return null;
}

function rectOverlapArea(a, b, pad = 0) {
  const ox = Math.max(0, Math.min(a.x + a.w + pad, b.x + b.w) - Math.max(a.x - pad, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h + pad, b.y + b.h) - Math.max(a.y - pad, b.y));
  return ox * oy;
}

/**
 * Computes outside-the-box placement + closest-side box-entry leader geometry for a
 * floating artwork tag on the desktop 3D world map (`MapView3D.jsx`), avoiding overlap
 * with the parent land box, sibling land boxes, and already-placed labels.
 */
export function planOutsideBoxArtworkTag({
  targetPt,
  elWidth = 124,
  elHeight = 28,
  viewportWidth = 900,
  viewportHeight = 600,
  parentBox = null,
  placedOverlayRects = [],
  avoidBoxRects = [],
  boxGapPx = 18,
  marginPx = 10
}) {
  const w = viewportWidth;
  const h = viewportHeight;
  const minCx = Math.min(w / 2, elWidth / 2 + marginPx);
  const maxCx = Math.max(w / 2, w - elWidth / 2 - marginPx);
  const minBy = elHeight + 12;
  const maxBy = Math.max(minBy, h - 14);
  const clampCx = (v) => Math.max(minCx, Math.min(maxCx, v));
  const clampBy = (v) => Math.max(minBy, Math.min(maxBy, v));

  const candidates = [];
  const stepY = elHeight + 8;

  if (parentBox) {
    const targetSpan = getHorizontalSpanForBand(
      parentBox,
      targetPt.y - elHeight / 2,
      targetPt.y + elHeight / 2
    ) || { leftX: parentBox.minX, rightX: parentBox.maxX };
    const distLeft = Math.max(0, targetPt.x - targetSpan.leftX);
    const distRight = Math.max(0, targetSpan.rightX - targetPt.x);
    const primarySide = distLeft <= distRight ? 'left' : 'right';
    const secondarySide = primarySide === 'left' ? 'right' : 'left';

    const pushSideCandidates = (side, yOffsets) => {
      for (const dy of yOffsets) {
        const by = clampBy(targetPt.y + elHeight / 2 + dy);
        const span = getHorizontalSpanForBand(parentBox, by - elHeight, by) || targetSpan;
        const rawCx =
          side === 'left'
            ? span.leftX - boxGapPx - elWidth / 2
            : span.rightX + boxGapPx + elWidth / 2;
        candidates.push({
          cx: clampCx(rawCx),
          by,
          side,
          edgeShift: Math.abs(clampCx(rawCx) - rawCx)
        });
      }
    };

    pushSideCandidates(primarySide, [0, -stepY, stepY, -stepY * 2, stepY * 2]);
    pushSideCandidates(secondarySide, [0, -stepY, stepY, -stepY * 2]);
    // Above / below box fallback if both horizontal margins are completely full
    candidates.push(
      { cx: clampCx(targetPt.x), by: clampBy(parentBox.minY - boxGapPx), side: 'top', edgeShift: 0 },
      { cx: clampCx(targetPt.x), by: clampBy(parentBox.maxY + boxGapPx + elHeight), side: 'bottom', edgeShift: 0 }
    );
  } else {
    const baseCx = clampCx(targetPt.x);
    const baseBy = clampBy(targetPt.y - 18);
    const stepX = Math.max(elWidth * 0.92 + 14, 128);
    candidates.push(
      { cx: baseCx, by: baseBy, side: 'top', edgeShift: 0 },
      { cx: baseCx, by: clampBy(baseBy - stepY), side: 'top', edgeShift: 0 },
      { cx: clampCx(baseCx + stepX), by: baseBy, side: 'right', edgeShift: 0 },
      { cx: clampCx(baseCx - stepX), by: baseBy, side: 'left', edgeShift: 0 },
      { cx: baseCx, by: clampBy(targetPt.y + elHeight + 18), side: 'bottom', edgeShift: 0 }
    );
  }

  let chosen = candidates[0];
  let bestScore = Infinity;
  const parentRect = parentBox
    ? { x: parentBox.minX, y: parentBox.minY, w: parentBox.width, h: parentBox.height }
    : null;

  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    const rect = { x: cand.cx - elWidth / 2, y: cand.by - elHeight, w: elWidth, h: elHeight };
    let labelOverlap = 0;
    for (const r of placedOverlayRects || []) {
      labelOverlap += rectOverlapArea(rect, r, 5);
    }
    let boxOverlap = 0;
    if (parentRect) {
      boxOverlap += rectOverlapArea(rect, parentRect, 4) * 3;
    }
    for (const br of avoidBoxRects || []) {
      boxOverlap += rectOverlapArea(rect, br, 2);
    }
    // Prefer zero label overlap AND zero land-box overlap; small tie-break preserves closest side & vertical alignment
    const score = labelOverlap * 20 + boxOverlap * 4 + (cand.edgeShift || 0) * 6 + i * 18;
    if (score < bestScore) {
      bestScore = score;
      chosen = cand;
    }
    if (labelOverlap === 0 && boxOverlap === 0 && (cand.edgeShift || 0) < 1) {
      chosen = cand;
      break;
    }
  }

  const stub = Math.min(10, Math.max(6, Math.round(boxGapPx * 0.45)));
  let fromX;
  let fromY;
  let elbowX;
  let elbowY;
  if (chosen.side === 'left') {
    fromX = chosen.cx + elWidth / 2;
    fromY = chosen.by - elHeight / 2;
    elbowX = fromX + stub;
    elbowY = fromY;
  } else if (chosen.side === 'right') {
    fromX = chosen.cx - elWidth / 2;
    fromY = chosen.by - elHeight / 2;
    elbowX = fromX - stub;
    elbowY = fromY;
  } else {
    fromX = chosen.cx;
    fromY = chosen.by < targetPt.y ? chosen.by : chosen.by - elHeight;
    elbowX = fromX;
    elbowY = fromY;
  }

  const boxEntry = parentBox
    ? findBoxEntryPoint(
        parentBox,
        { x: fromX, y: fromY },
        { x: elbowX, y: elbowY },
        { x: targetPt.x, y: targetPt.y }
      )
    : null;

  return {
    cx: chosen.cx,
    by: chosen.by,
    side: chosen.side,
    rect: { x: chosen.cx - elWidth / 2, y: chosen.by - elHeight, w: elWidth, h: elHeight },
    fromX: Math.round(fromX),
    fromY: Math.round(fromY),
    elbowX: Math.round(elbowX),
    elbowY: Math.round(elbowY),
    targetX: Math.round(targetPt.x),
    targetY: Math.round(targetPt.y),
    boxEntry,
    fadeInsideBox: Boolean(parentBox)
  };
}

/**
 * Computes balanced, non-overlapping Left & Right side callout label positions
 * with sleek elbow pointer coordinates aimed directly at each 3D artwork on a plot,
 * along with each sculpture's direct shareable link URL.
 *
 * When `landBox` + `dockOutsideBox` are supplied (Desktop map views), each tag sits
 * slightly outside the closest side of the projected land box and computes the exact
 * `boxEntry` point where its leader line crosses the box edge so the interior fades cleanly.
 */
export function computeSideArtworkCallouts({
  sculptures = [],
  volume = null,
  viewportWidth = 400,
  viewportHeight = 300,
  projectScreenPt = null,
  getSculptureTransform = null,
  selectedSculptureId = '',
  topInsetPx = 62,
  bottomInsetPx = 46,
  marginPx = 10,
  labelHeight = 36,
  gapPx = 8,
  landBox = null,
  dockOutsideBox = false,
  boxGapPx = 20
} = {}) {
  const visible = (sculptures || []).filter((sc) => sc && !sc.hidden && sc.id);
  if (visible.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return [];

  const isNarrow = viewportWidth < 520;
  const minLabelWidth = isNarrow ? 112 : 132;
  const elbowStub = isNarrow ? 10 : dockOutsideBox && landBox ? Math.max(8, Math.round(boxGapPx * 0.45)) : 18;
  const estimateCalloutWidth = (item, maxAllowed) => {
    const titleStr = String(item?.title || '');
    const subStr = String(item?.subtitle || '');
    const previewPad = item?.isPendingPreview ? 52 : 0;
    // Bold 11.5px title (~7.1px avg char width) + 9.5px mono meta (~5.9px avg char) + padding & 26px ↗ button
    const chromePx = isNarrow ? 42 : 48;
    const neededTitle = Math.ceil(titleStr.length * (isNarrow ? 6.6 : 7.2)) + previewPad;
    const neededSub = Math.ceil(subStr.length * 6.0);
    const desired = Math.max(neededTitle, neededSub) + chromePx;
    return Math.max(minLabelWidth, Math.min(maxAllowed, desired));
  };

  const baseAlt = Number(volume?.baseAltitudeM || 0);
  const volH = Number(volume?.heightMeters || 0);
  const volLat = Number(volume?.centerLat);
  const volLng = Number(volume?.centerLng);
  const volRotDeg = Number(volume?.rotationDeg || 0);

  const projected = visible.map((sc, idx) => {
    const liveTransform =
      typeof getSculptureTransform === 'function' ? getSculptureTransform(sc.id) : null;

    let lat;
    let lng;
    let targetAlt;
    if (liveTransform && Number.isFinite(Number(liveTransform.lat)) && Number.isFinite(Number(liveTransform.lng))) {
      if (Number.isFinite(Number(liveTransform.worldLat)) && Number.isFinite(Number(liveTransform.worldLng))) {
        lat = Number(liveTransform.worldLat);
        lng = Number(liveTransform.worldLng);
      } else {
        const wPos = parcelLocalOffsetToWorldLatLng(
          Number(liveTransform.lat),
          Number(liveTransform.lng),
          Number(liveTransform.anchorDx || 0),
          Number(liveTransform.anchorDz || 0),
          Number(liveTransform.parcelRotationDeg ?? volRotDeg)
        );
        lat = wPos.lat;
        lng = wPos.lng;
      }
      const renderedH = Math.max(0.1, Number(liveTransform.renderedSize?.y || 1));
      targetAlt = Number(liveTransform.altitudeMeters || 0) + renderedH * 0.5;
    } else {
      const rawLat = Number(sc.lat);
      const rawLng = Number(sc.lng);
      const dxM = Number(sc.anchorOffset?.dx || 0);
      const dyM = Math.max(0, Number(sc.anchorOffset?.dy || 0));
      const dzM = Number(sc.anchorOffset?.dz || 0);
      const wPos = parcelLocalOffsetToWorldLatLng(
        Number.isFinite(rawLat) ? rawLat : volLat,
        Number.isFinite(rawLng) ? rawLng : volLng,
        dxM,
        dzM,
        volRotDeg
      );
      lat = wPos.lat;
      lng = wPos.lng;

      // Aim pointer squarely at the true un-autoscaled vertical center of the 3D sculpture
      const userScale = extractSculptureScale(sc);
      const baseDims = extractSculptureBaseDimensions(sc);
      const renderedH = Math.max(0.1, baseDims.height * userScale);
      const isObjectFitted =
        volH > renderedH &&
        volH <= renderedH * 1.45 &&
        Math.abs(userScale - 1) <= 1e-4 &&
        dyM === 0;
      const baseLift = isObjectFitted ? baseAlt + (volH - renderedH) / 2 : baseAlt + dyM;
      targetAlt = baseLift + renderedH * 0.5;
    }

    let pt = null;
    if (typeof projectScreenPt === 'function' && Number.isFinite(lat) && Number.isFinite(lng)) {
      pt = projectScreenPt(lng, lat, targetAlt, sc, idx, visible.length);
    }
    const targetX =
      pt && Number.isFinite(pt.x) ? pt.x : viewportWidth * 0.5 + (idx % 2 === 0 ? -12 : 12);
    const targetY =
      pt && Number.isFinite(pt.y)
        ? pt.y
        : viewportHeight * 0.52 + (idx - (visible.length - 1) / 2) * 14;

    const isOffScreen = Boolean(
      pt &&
        (pt.visible === false ||
          !Number.isFinite(pt.x) ||
          !Number.isFinite(pt.y) ||
          pt.x < 8 ||
          pt.x > viewportWidth - 8 ||
          pt.y < 8 ||
          pt.y > viewportHeight - 8)
    );

    const isPendingPreview = Boolean(sc.isPendingPreview);
    const baseSub =
      sc.modelType === 'custom-3d'
        ? `${String(sc.customModel?.format || '3D').toUpperCase()} 3D`
        : `${Number(sc.voxelCount || sc.voxels?.length || 0)} blocks`;
    const subtitle = isPendingPreview ? `Preview · Needs Approval` : baseSub;
    const sculptureUrl = isPendingPreview
      ? ''
      : buildSculptureShareUrl(sc.id) || `?sculpture=${encodeURIComponent(String(sc.id))}`;

    return {
      sculpture: sc,
      sculptureId: String(sc.id),
      isPendingPreview,
      pendingRequestId: sc.pendingRequestId || '',
      title: String(sc.title || '3D Artwork'),
      subtitle,
      sculptureUrl,
      lat,
      lng,
      alt: targetAlt,
      isOffScreen,
      targetX,
      targetY,
      isSelected: Boolean(selectedSculptureId && String(selectedSculptureId) === String(sc.id))
    };
  });

  const leftItems = [];
  const rightItems = [];

  if (dockOutsideBox && landBox) {
    // Route each artwork tag to the CLOSEST side of the projected land box so lines enter cleanly
    const availH = Math.max(labelHeight, viewportHeight - topInsetPx - bottomInsetPx);
    const maxPerCol = Math.max(1, Math.floor((availH + gapPx) / (labelHeight + gapPx)));
    const scored = projected.map((item) => {
      const span = getHorizontalSpanForBand(landBox, item.targetY - 2, item.targetY + 2) || {
        leftX: landBox.minX,
        rightX: landBox.maxX
      };
      const distLeft = Math.max(0, item.targetX - span.leftX);
      const distRight = Math.max(0, span.rightX - item.targetX);
      return { item, distLeft, distRight, bias: distLeft - distRight };
    });

    for (const entry of scored) {
      if (Math.abs(entry.bias) < 10) {
        if (leftItems.length <= rightItems.length) leftItems.push(entry);
        else rightItems.push(entry);
      } else if (entry.distLeft < entry.distRight) {
        leftItems.push(entry);
      } else {
        rightItems.push(entry);
      }
    }

    // Rebalance only if one column would overflow available viewport height while the other has room
    while (leftItems.length > maxPerCol && rightItems.length < maxPerCol) {
      leftItems.sort((a, b) => b.bias - a.bias); // closest to centerline first
      rightItems.push(leftItems.shift());
    }
    while (rightItems.length > maxPerCol && leftItems.length < maxPerCol) {
      rightItems.sort((a, b) => a.bias - b.bias); // closest to centerline first
      leftItems.push(rightItems.shift());
    }

    const unwrappedLeft = leftItems.map((e) => e.item);
    const unwrappedRight = rightItems.map((e) => e.item);
    leftItems.length = 0;
    rightItems.length = 0;
    leftItems.push(...unwrappedLeft);
    rightItems.push(...unwrappedRight);
  } else {
    // Sort left-to-right by projected X so splitting into left & right columns avoids crossing pointers
    const byX = [...projected].sort((a, b) => a.targetX - b.targetX || a.targetY - b.targetY);
    if (byX.length === 1) {
      if (byX[0].targetX < viewportWidth * 0.45) {
        leftItems.push(byX[0]);
      } else {
        rightItems.push(byX[0]);
      }
    } else {
      const leftCount = Math.floor(byX.length / 2);
      for (let i = 0; i < byX.length; i++) {
        if (i < leftCount) leftItems.push(byX[i]);
        else rightItems.push(byX[i]);
      }
    }
  }

  const hasBothSides = leftItems.length > 0 && rightItems.length > 0;
  const maxLabelWidth = isNarrow
    ? Math.min(hasBothSides ? 168 : 210, Math.max(120, Math.round(viewportWidth * (hasBothSides ? 0.39 : 0.48))))
    : Math.min(hasBothSides ? 256 : 292, Math.max(168, Math.round(viewportWidth * (hasBothSides ? 0.31 : 0.38))));

  const placeColumn = (items, side) => {
    const sorted = [...items].sort((a, b) => a.targetY - b.targetY);
    const minTop = topInsetPx;
    const maxBottom = Math.max(minTop + labelHeight, viewportHeight - bottomInsetPx);
    const placed = sorted.map((item) => {
      const idealY = item.targetY - labelHeight / 2;
      return {
        ...item,
        side,
        y: Math.max(minTop, Math.min(maxBottom - labelHeight, idealY))
      };
    });

    // Forward pass: push overlapping cards downward
    for (let i = 1; i < placed.length; i++) {
      const prevBottom = placed[i - 1].y + labelHeight + gapPx;
      if (placed[i].y < prevBottom) {
        placed[i].y = prevBottom;
      }
    }
    // Backward pass: pull back upward if bottom overflowed
    if (placed.length > 0) {
      const overflow = placed[placed.length - 1].y + labelHeight - maxBottom;
      if (overflow > 0) {
        for (let i = placed.length - 1; i >= 0; i--) {
          placed[i].y = Math.max(minTop, placed[i].y - overflow);
          if (i < placed.length - 1) {
            const maxAllowed = placed[i + 1].y - labelHeight - gapPx;
            if (placed[i].y > maxAllowed) placed[i].y = Math.max(minTop, maxAllowed);
          }
        }
      }
    }

    return placed.map((item) => {
      const itemWidth = estimateCalloutWidth(item, maxLabelWidth);
      let x;
      if (dockOutsideBox && landBox) {
        const bandSpan = getHorizontalSpanForBand(landBox, item.y, item.y + labelHeight) || {
          leftX: landBox.minX,
          rightX: landBox.maxX
        };
        const idealX =
          side === 'left'
            ? bandSpan.leftX - boxGapPx - itemWidth
            : bandSpan.rightX + boxGapPx;
        x = Math.max(marginPx, Math.min(viewportWidth - marginPx - itemWidth, idealX));
      } else {
        x = side === 'left' ? marginPx : Math.max(marginPx, viewportWidth - marginPx - itemWidth);
      }

      const fromX = side === 'left' ? x + itemWidth : x;
      const fromY = item.y + labelHeight / 2;
      const elbowX = side === 'left' ? fromX + elbowStub : fromX - elbowStub;
      const elbowY = fromY;
      const boxEntry = landBox
        ? findBoxEntryPoint(
            landBox,
            { x: fromX, y: fromY },
            { x: elbowX, y: elbowY },
            { x: item.targetX, y: item.targetY }
          )
        : null;

      return {
        ...item,
        x: Math.round(x),
        y: Math.round(item.y),
        width: itemWidth,
        height: labelHeight,
        fromX: Math.round(fromX),
        fromY: Math.round(fromY),
        elbowX: Math.round(elbowX),
        elbowY: Math.round(elbowY),
        targetX: Math.round(item.targetX),
        targetY: Math.round(item.targetY),
        boxEntry,
        fadeInsideBox: Boolean(landBox)
      };
    });
  };

  return [...placeColumn(leftItems, 'left'), ...placeColumn(rightItems, 'right')];
}

function hexToRgbTriplet(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `${r}, ${g}, ${b}`;
    }
  }
  return '0, 245, 212';
}

/**
 * Draws a sleek glowing elbow pointer line + anchor dot from an artwork callout tag
 * onto its 3D sculpture. When `boxEntry` / `fadeInsideBox` is active, the segment outside
 * the land box stays crisp up to the closest wall, then smoothly fades as it enters the box
 * so it never visually clashes with the box border or neighboring panel lines.
 */
export function drawArtworkCalloutLeader(ctx, callout) {
  if (!ctx || !callout) return;
  const {
    fromX,
    fromY,
    elbowX,
    elbowY,
    targetX,
    targetY,
    isSelected,
    isPendingPreview,
    boxEntry = null,
    fadeInsideBox = false
  } = callout;
  if (
    !Number.isFinite(fromX) ||
    !Number.isFinite(fromY) ||
    !Number.isFinite(targetX) ||
    !Number.isFinite(targetY)
  ) {
    return;
  }

  const color = isPendingPreview ? '#ffd166' : isSelected ? '#ffd166' : '#00f5d4';
  const rgb = hexToRgbTriplet(color);
  const dotColor = isPendingPreview ? '#fff3c4' : isSelected ? '#ffffff' : '#eafffc';
  const hasElbow =
    Number.isFinite(elbowX) &&
    Number.isFinite(elbowY) &&
    Math.hypot(elbowX - fromX, elbowY - fromY) >= 1;
  const effElbowX = hasElbow ? elbowX : fromX;
  const effElbowY = hasElbow ? elbowY : fromY;

  const drawFadedInteriorSegment = (pts) => {
    if (!pts || pts.length < 2) return;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const startAlpha = isSelected || isPendingPreview ? 0.68 : 0.56;
    const midAlpha = isSelected || isPendingPreview ? 0.38 : 0.28;
    const endAlpha = isSelected || isPendingPreview ? 0.28 : 0.2;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (isPendingPreview) ctx.setLineDash([5, 4]);
    let strokeStyle = `rgba(${rgb}, ${midAlpha})`;
    if (
      typeof ctx.createLinearGradient === 'function' &&
      Math.hypot(end.x - start.x, end.y - start.y) >= 2
    ) {
      const grad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      grad.addColorStop(0, `rgba(${rgb}, ${startAlpha})`);
      grad.addColorStop(0.55, `rgba(${rgb}, ${midAlpha})`);
      grad.addColorStop(1, `rgba(${rgb}, ${endAlpha})`);
      strokeStyle = grad;
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = isSelected || isPendingPreview ? 1.45 : 1.05;
    ctx.shadowColor = `rgba(${rgb}, 0.25)`;
    ctx.shadowBlur = isSelected || isPendingPreview ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };

  const drawCrispOutsideSegment = (pts) => {
    if (!pts || pts.length < 2) return;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const segLen = Math.hypot(end.x - start.x, end.y - start.y);
    if (segLen < 1) return;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (isPendingPreview) ctx.setLineDash([5, 4]);

    // Contrast halo outside the box only — fades out right before touching the box border
    let haloStyle = 'rgba(4, 10, 20, 0.72)';
    if (fadeInsideBox && typeof ctx.createLinearGradient === 'function' && segLen >= 4) {
      const hGrad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      hGrad.addColorStop(0, 'rgba(4, 10, 20, 0.75)');
      hGrad.addColorStop(0.75, 'rgba(4, 10, 20, 0.45)');
      hGrad.addColorStop(1, 'rgba(4, 10, 20, 0)');
      haloStyle = hGrad;
    }
    ctx.strokeStyle = haloStyle;
    ctx.lineWidth = isSelected || isPendingPreview ? 3.0 : 2.3;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();

    // Crisp glowing exterior leader stem
    let stemStyle = color;
    if (fadeInsideBox && typeof ctx.createLinearGradient === 'function' && segLen >= 4) {
      const sGrad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      sGrad.addColorStop(0, `rgba(${rgb}, 0.96)`);
      sGrad.addColorStop(0.8, `rgba(${rgb}, 0.88)`);
      sGrad.addColorStop(1, `rgba(${rgb}, ${isSelected || isPendingPreview ? 0.68 : 0.56})`);
      stemStyle = sGrad;
    }
    ctx.strokeStyle = stemStyle;
    ctx.lineWidth = isSelected || isPendingPreview ? 1.7 : 1.2;
    ctx.shadowColor = color;
    ctx.shadowBlur = isSelected || isPendingPreview ? 8 : 5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };

  ctx.save();
  if (fadeInsideBox) {
    if (boxEntry && !boxEntry.fromInside && Number.isFinite(boxEntry.x) && Number.isFinite(boxEntry.y)) {
      const entryPt = { x: boxEntry.x, y: boxEntry.y };
      if (boxEntry.segment === 'stub' && hasElbow) {
        drawCrispOutsideSegment([
          { x: fromX, y: fromY },
          entryPt
        ]);
        drawFadedInteriorSegment([
          entryPt,
          { x: effElbowX, y: effElbowY },
          { x: targetX, y: targetY }
        ]);
      } else {
        const outsidePts = hasElbow
          ? [
              { x: fromX, y: fromY },
              { x: effElbowX, y: effElbowY },
              entryPt
            ]
          : [
              { x: fromX, y: fromY },
              entryPt
            ];
        drawCrispOutsideSegment(outsidePts);
        drawFadedInteriorSegment([entryPt, { x: targetX, y: targetY }]);
      }
    } else {
      // Tag clamped inside or directly on box boundary -> smoothly fade entire stem without harsh halo
      const allPts = hasElbow
        ? [
            { x: fromX, y: fromY },
            { x: effElbowX, y: effElbowY },
            { x: targetX, y: targetY }
          ]
        : [
            { x: fromX, y: fromY },
            { x: targetX, y: targetY }
          ];
      drawFadedInteriorSegment(allPts);
    }
  } else {
    // Legacy solid glowing leader when no land box context is provided
    const fullPts = hasElbow
      ? [
          { x: fromX, y: fromY },
          { x: effElbowX, y: effElbowY },
          { x: targetX, y: targetY }
        ]
      : [
          { x: fromX, y: fromY },
          { x: targetX, y: targetY }
        ];
    drawCrispOutsideSegment(fullPts);
  }

  // Subtle arrowhead pointing at the artwork center (softened when fading inside box)
  const dx = targetX - (boxEntry && !boxEntry.fromInside ? boxEntry.x : effElbowX);
  const dy = targetY - (boxEntry && !boxEntry.fromInside ? boxEntry.y : effElbowY);
  if (Math.hypot(dx, dy) >= 6) {
    const angle = Math.atan2(dy, dx);
    const headLen = isSelected ? 6.5 : 5;
    const spread = 0.48;
    ctx.fillStyle = fadeInsideBox
      ? `rgba(${rgb}, ${isSelected || isPendingPreview ? 0.62 : 0.48})`
      : color;
    ctx.beginPath();
    ctx.moveTo(targetX, targetY);
    ctx.lineTo(
      targetX - headLen * Math.cos(angle - spread),
      targetY - headLen * Math.sin(angle - spread)
    );
    ctx.lineTo(
      targetX - headLen * Math.cos(angle + spread),
      targetY - headLen * Math.sin(angle + spread)
    );
    ctx.closePath();
    ctx.fill();
  }

  // Glowing anchor dot right on the 3D artwork
  ctx.fillStyle = dotColor;
  ctx.globalAlpha = fadeInsideBox ? (isSelected || isPendingPreview ? 0.92 : 0.78) : 1;
  ctx.beginPath();
  ctx.arc(targetX, targetY, isSelected ? 3.0 : 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
