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
    font = '700 10.5px "JetBrains Mono", ui-monospace, monospace',
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

  ctx.save();
  ctx.font = font;
  const textW = ctx.measureText(label).width;
  const padX = 8;
  const boxW = textW + padX * 2;
  const boxH = 20;
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

/**
 * Computes balanced, non-overlapping Left & Right side callout label positions
 * with sleek elbow pointer coordinates aimed directly at each 3D artwork on a plot,
 * along with each sculpture's direct shareable link URL.
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
  gapPx = 8
} = {}) {
  const visible = (sculptures || []).filter((sc) => sc && !sc.hidden && sc.id);
  if (visible.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return [];

  const isNarrow = viewportWidth < 520;
  const labelWidth = isNarrow
    ? Math.min(136, Math.max(104, Math.round(viewportWidth * 0.31)))
    : Math.min(184, Math.max(136, Math.round(viewportWidth * 0.22)));
  const elbowStub = isNarrow ? 10 : 18;

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

  // Sort left-to-right by projected X so splitting into left & right columns avoids crossing pointers
  const byX = [...projected].sort((a, b) => a.targetX - b.targetX || a.targetY - b.targetY);
  const leftItems = [];
  const rightItems = [];

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
      const x = side === 'left' ? marginPx : Math.max(marginPx, viewportWidth - marginPx - labelWidth);
      const fromX = side === 'left' ? x + labelWidth : x;
      const fromY = item.y + labelHeight / 2;
      const elbowX = side === 'left' ? fromX + elbowStub : fromX - elbowStub;
      const elbowY = fromY;
      return {
        ...item,
        x: Math.round(x),
        y: Math.round(item.y),
        width: labelWidth,
        height: labelHeight,
        fromX: Math.round(fromX),
        fromY: Math.round(fromY),
        elbowX: Math.round(elbowX),
        elbowY: Math.round(elbowY),
        targetX: Math.round(item.targetX),
        targetY: Math.round(item.targetY)
      };
    });
  };

  return [...placeColumn(leftItems, 'left'), ...placeColumn(rightItems, 'right')];
}

/**
 * Draws a sleek glowing elbow pointer line + arrowhead from a side artwork callout label
 * directly onto its 3D sculpture on the isometric map.
 */
export function drawArtworkCalloutLeader(ctx, callout) {
  if (!ctx || !callout) return;
  const { fromX, fromY, elbowX, elbowY, targetX, targetY, isSelected, isPendingPreview } = callout;
  if (
    !Number.isFinite(fromX) ||
    !Number.isFinite(fromY) ||
    !Number.isFinite(targetX) ||
    !Number.isFinite(targetY)
  ) {
    return;
  }

  const color = isPendingPreview ? '#ffd166' : isSelected ? '#ffd166' : '#00f5d4';
  const dotColor = isPendingPreview ? '#fff3c4' : isSelected ? '#ffffff' : '#eafffc';

  ctx.save();
  // Dark halo for sharp readability over bright basemap tiles
  ctx.strokeStyle = 'rgba(4, 10, 20, 0.82)';
  ctx.lineWidth = isSelected || isPendingPreview ? 3.4 : 2.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (isPendingPreview) ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(targetX, targetY);
  ctx.stroke();

  // Glowing thin pointer stroke
  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected || isPendingPreview ? 1.8 : 1.2;
  ctx.shadowColor = color;
  ctx.shadowBlur = isSelected || isPendingPreview ? 10 : 6;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(targetX, targetY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Crisp arrowhead pointing at the artwork center
  const dx = targetX - elbowX;
  const dy = targetY - elbowY;
  if (Math.hypot(dx, dy) >= 6) {
    const angle = Math.atan2(dy, dx);
    const headLen = isSelected ? 7 : 5.5;
    const spread = 0.48;
    ctx.fillStyle = color;
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
  ctx.beginPath();
  ctx.arc(targetX, targetY, isSelected ? 3.2 : 2.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
