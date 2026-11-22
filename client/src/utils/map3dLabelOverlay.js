/**
 * Shared 2D canvas overlay helper for 3D map wireframes.
 * Always called in Pass 2 (after all prism wireframes and gizmos are drawn)
 * so floating labels sit strictly on top of wireframes with a thin arrow
 * connecting from the exact center of the land prism.
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
    font = '700 10.5px "JetBrains Mono", ui-monospace, monospace'
  }
) {
  if (!ctx || !label) return null;
  const anchor = getPrismLabelAnchor(geom);
  if (!anchor || !anchor.visible) return null;

  ctx.save();
  ctx.font = font;
  const textW = ctx.measureText(label).width;
  const padX = 8;
  const boxW = textW + padX * 2;
  const boxH = 20;
  const pillCenterX = anchor.roofCenter.x;
  const bx = pillCenterX - boxW / 2;
  const by = Math.max(minY, anchor.highestTopY - boxH - liftPx);

  // Leader arrow from bottom of floating pill down to the exact land center
  drawFloatingCenterArrow(ctx, {
    fromX: pillCenterX,
    fromY: by + boxH,
    toX: anchor.baseCenter.x,
    toY: anchor.baseCenter.y,
    color: outerColor,
    dotColor: innerColor
  });

  // Floating pill container (drawn strictly on top of stem and all wireframes)
  ctx.fillStyle = 'rgba(6, 10, 20, 0.94)';
  ctx.strokeStyle = outerColor;
  ctx.lineWidth = 1.15;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bx, by, boxW, boxH, 6);
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

  return { x: bx, y: by, width: boxW, height: boxH, anchor };
}
