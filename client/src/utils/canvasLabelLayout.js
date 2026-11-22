/**
 * Collision-free 2D placement helper for floating map labels drawn on canvas overlays.
 * Prevents floating land labels from overlapping top/bottom HUD buttons (mode switchers,
 * compass pills, 90° rotate chips, scale bars, refit chips) or other floating land labels.
 */

export function rectsOverlap(a, b, pad = 4) {
  if (!a || !b) return false;
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

/**
 * Builds standard HUD exclusion zones for a map stage of `(stageWidth, stageHeight)`
 * when exact DOM measurements are unavailable, or merges DOM-measured rects.
 */
export function buildDefaultHudReservedRects({
  stageWidth,
  stageHeight,
  topLeftWidth = 188,
  topRightWidth = 148,
  topHeight = 46,
  bottomLeftWidth = 110,
  bottomRightWidth = 88,
  bottomHeight = 42,
  measuredRects = []
}) {
  if (Array.isArray(measuredRects) && measuredRects.length > 0) {
    return measuredRects.filter(
      (r) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0
    );
  }
  const w = Math.max(160, Number(stageWidth || 0));
  const h = Math.max(120, Number(stageHeight || 0));
  return [
    { x: 0, y: 0, w: Math.min(w, topLeftWidth), h: topHeight },
    { x: Math.max(0, w - topRightWidth), y: 0, w: Math.min(w, topRightWidth), h: topHeight },
    { x: 0, y: Math.max(0, h - bottomHeight), w: Math.min(w, bottomLeftWidth), h: bottomHeight },
    {
      x: Math.max(0, w - bottomRightWidth),
      y: Math.max(0, h - bottomHeight),
      w: Math.min(w, bottomRightWidth),
      h: bottomHeight
    }
  ];
}

/**
 * Finds a collision-free `(x, y)` box position for a floating canvas label pill.
 * Returns `{ x, y, w, h, nudged: boolean }` or `null` if a secondary label cannot
 * fit cleanly without colliding with HUD controls or higher-priority labels.
 */
export function placeFloatingLabelRect({
  desiredX,
  desiredY,
  width,
  height,
  stageWidth,
  stageHeight,
  reservedRects = [],
  placedRects = [],
  isPrimary = false,
  edgeMargin = 8,
  topMinY = 48,
  bottomMargin = 42,
  gapPx = 5
}) {
  const sw = Number(stageWidth || 0);
  const sh = Number(stageHeight || 0);
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (sw <= 0 || sh <= 0 || w <= 0 || h <= 0) return null;

  const minX = edgeMargin;
  const maxX = Math.max(minX, sw - w - edgeMargin);
  const minY = Math.min(Math.max(edgeMargin, topMinY), Math.max(edgeMargin, sh - h - edgeMargin));
  const maxY = Math.max(minY, sh - h - bottomMargin);

  const clampX = (x) => Math.max(minX, Math.min(maxX, x));
  const clampY = (y) => Math.max(minY, Math.min(maxY, y));

  const collides = (rect) => {
    for (const r of reservedRects) {
      if (rectsOverlap(rect, r, gapPx)) return true;
    }
    for (const p of placedRects) {
      if (rectsOverlap(rect, p, gapPx)) return true;
    }
    return false;
  };

  // For secondary labels whose anchor is way off-stage or deep inside top/bottom HUD band, reject early
  if (!isPrimary) {
    if (desiredX + w < 0 || desiredX > sw || desiredY + h < -8 || desiredY > sh + 8) {
      return null;
    }
  }

  const baseX = clampX(desiredX);
  const baseY = clampY(desiredY);

  // Try desired position first, then clean vertical/horizontal nudge offsets
  const candidates = [
    { x: baseX, y: baseY, nudged: Math.abs(baseX - desiredX) > 1 || Math.abs(baseY - desiredY) > 1 },
    { x: baseX, y: clampY(baseY + h + 8), nudged: true },
    { x: baseX, y: clampY(baseY - h - 8), nudged: true },
    { x: clampX(baseX - 36), y: baseY, nudged: true },
    { x: clampX(baseX + 36), y: baseY, nudged: true },
    { x: baseX, y: clampY(minY + 4), nudged: true }
  ];

  for (const cand of candidates) {
    const rect = { x: cand.x, y: cand.y, w, h };
    if (!collides(rect)) {
      return { ...rect, nudged: cand.nudged };
    }
  }

  if (isPrimary) {
    // Primary label always renders in the center-safe band below the top HUD
    const safeRect = {
      x: clampX((sw - w) / 2),
      y: clampY(Math.max(minY + 4, Math.min(maxY, baseY))),
      w,
      h,
      nudged: true
    };
    return safeRect;
  }

  // Secondary neighbor label couldn't fit without colliding with HUD or another label — suppress cleanly
  return null;
}
