import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { rectsOverlap } from './canvasLabelLayout.js';
import { FEET_PER_METER, METERS_PER_MILE, normalizeUnitSystem } from './measurementUnits.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Formats a compact geographic distance string for neighbor edge-arrow labels.
 * @param {number} meters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 */
export function formatCompactNeighborDistance(meters, unitSystem = 'metric') {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (normalizeUnitSystem(unitSystem) === 'imperial') {
    const feet = meters * FEET_PER_METER;
    if (feet < 1000) return `${Math.max(1, Math.round(feet))}ft`;
    const miles = meters / METERS_PER_MILE;
    if (miles < 10) return `${miles.toFixed(1)}mi`;
    return `${Math.round(miles).toLocaleString()}mi`;
  }
  if (meters < 1000) return `${Math.max(1, Math.round(meters))}m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)}km`;
  if (meters < 100000) return `${Math.round(meters / 1000)}km`;
  return `${Math.round(meters / 1000).toLocaleString()}km`;
}

/**
 * Computes clockwise geographic bearing in radians (0 = North, +PI/2 = East)
 * from (lat1, lng1) to (lat2, lng2).
 */
export function computeGeoBearingRad(lat1, lng1, lat2, lng2) {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dLambda = (lng2 - lng1) * DEG_TO_RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return Math.atan2(y, x);
}

function estimateArrowPillSize(label, distanceLabel, compact = false, isOnScreen = false) {
  const fullChars = String(label || '').length + (distanceLabel ? distanceLabel.length + 1 : 0);
  const charW = compact ? 5.2 : 6.2;
  const arrowBadgeW = isOnScreen ? (compact ? 14 : 18) : compact ? 20 : 24;
  const padX = compact ? 12 : 18;
  const maxW = compact ? 124 : 176;
  const minW = compact ? 60 : 78;
  const w = Math.max(minW, Math.min(maxW, Math.round(fullChars * charW + arrowBadgeW + padX)));
  const h = compact ? 23 : 28;
  return { w, h };
}

/**
 * Resolves a consistent tag + leader-line color theme for a land or sculpture tag
 * so every on-screen pointer line and off-screen edge tag share the exact same color.
 */
export function resolveNeighborTagTheme({
  kind = 'land',
  defaultLandColor = '',
  isSelected = false,
  isPendingPreview = false,
  frozen = false,
  dormant = false
} = {}) {
  if (kind === 'sculpture') {
    if (isSelected || isPendingPreview) {
      return {
        accentColor: '#ffd166',
        dotColor: '#fff8dc',
        textColor: '#fff8dc'
      };
    }
    return {
      accentColor: '#00f5d4',
      dotColor: '#eafffc',
      textColor: '#d9fff9'
    };
  }

  if (isSelected) {
    return {
      accentColor: '#ffd166',
      dotColor: '#fff8dc',
      textColor: '#fff3c4'
    };
  }
  if (frozen) {
    return {
      accentColor: '#7dd3fc',
      dotColor: '#e0f2fe',
      textColor: '#e0f2fe'
    };
  }
  const baseColor = String(defaultLandColor || '').trim();
  if (baseColor) {
    const resolved = dormant ? '#ff4da6' : baseColor;
    const lower = resolved.toLowerCase();
    const isPink = lower === '#ff1f8f' || lower === '#ff4da6' || lower === '#ff0099';
    const isTeal = lower === '#00f5d4';
    const isBlue = lower === '#7dd3fc';
    return {
      accentColor: resolved,
      dotColor: isPink ? '#ffd6ec' : isTeal ? '#eafffc' : isBlue ? '#e0f2fe' : '#fff3c4',
      textColor: isPink ? '#ffe8f4' : isTeal ? '#d9fff9' : isBlue ? '#e0f2fe' : '#fff3c4'
    };
  }
  return {
    accentColor: '#ffb703',
    dotColor: '#fff3c4',
    textColor: '#fff3c4'
  };
}

/**
 * Computes the exact exit point on a pill's rectangular border along the ray
 * from the pill center (cx, cy) toward (targetX, targetY).
 */
export function computePillBorderAnchor(cx, cy, pillW, pillH, targetX, targetY) {
  const dx = targetX - cx;
  const dy = targetY - cy;
  if (Math.hypot(dx, dy) < 1e-3) {
    return { x: Math.round(cx), y: Math.round(cy + pillH / 2) };
  }
  const hw = Math.max(4, pillW / 2);
  const hh = Math.max(4, pillH / 2);
  const tx = Math.abs(dx) > 1e-5 ? hw / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-5 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return {
    x: Math.round(cx + dx * t),
    y: Math.round(cy + dy * t)
  };
}

function findNonOverlappingOnScreenPosition({
  targetX,
  targetY,
  originX,
  originY,
  pillW,
  pillH,
  minCenterX,
  maxCenterX,
  minCenterY,
  maxCenterY,
  blockers,
  softBlockers = [],
  gapPx = 6
}) {
  const clampX = (x) => Math.max(minCenterX, Math.min(maxCenterX, x));
  const clampY = (y) => Math.max(minCenterY, Math.min(maxCenterY, y));

  const targetDotRect = { x: targetX - 7, y: targetY - 7, w: 14, h: 14 };

  const fitsHard = (cx, cy) => {
    const rect = {
      x: cx - pillW / 2,
      y: cy - pillH / 2,
      w: pillW,
      h: pillH
    };
    if (rectsOverlap(rect, targetDotRect, 4)) return false;
    return !blockers.some((b) => rectsOverlap(rect, b, gapPx));
  };

  const fitsSoft = (cx, cy) => {
    if (!softBlockers || softBlockers.length === 0) return true;
    const rect = {
      x: cx - pillW / 2,
      y: cy - pillH / 2,
      w: pillW,
      h: pillH
    };
    return !softBlockers.some((b) => rectsOverlap(rect, b, 4));
  };

  let outX = targetX - originX;
  let outY = targetY - originY;
  const outLen = Math.hypot(outX, outY);
  if (outLen > 6) {
    outX /= outLen;
    outY /= outLen;
  } else {
    outX = 0;
    outY = -1;
  }

  const lift1 = pillH / 2 + 24;
  const lift2 = pillH * 1.5 + 32;
  const lift3 = pillH * 2.5 + 40;
  const shiftX1 = pillW * 0.52 + 22;
  const shiftX2 = pillW * 0.85 + 34;

  const rawCandidates = [
    { cx: targetX, cy: targetY - lift1 },
    { cx: targetX + outX * shiftX1 * 0.72, cy: targetY - lift1 },
    { cx: targetX + outX * shiftX1, cy: targetY + outY * (pillH * 0.55 + 24) },
    { cx: targetX, cy: targetY - lift2 },
    { cx: targetX + shiftX1, cy: targetY - lift1 * 0.7 },
    { cx: targetX - shiftX1, cy: targetY - lift1 * 0.7 },
    { cx: targetX + shiftX1, cy: targetY },
    { cx: targetX - shiftX1, cy: targetY },
    { cx: targetX, cy: targetY + lift1 },
    { cx: targetX + shiftX1, cy: targetY + lift1 * 0.7 },
    { cx: targetX - shiftX1, cy: targetY + lift1 * 0.7 },
    { cx: targetX + outX * shiftX2, cy: targetY + outY * (pillH * 1.1 + 36) },
    { cx: targetX, cy: targetY - lift3 },
    { cx: targetX, cy: targetY + lift2 },
    { cx: targetX + shiftX2, cy: targetY - lift1 },
    { cx: targetX - shiftX2, cy: targetY - lift1 },
    { cx: targetX + shiftX2, cy: targetY + lift1 },
    { cx: targetX - shiftX2, cy: targetY + lift1 }
  ];

  for (const enforceSoft of [true, false]) {
    if (enforceSoft && (!softBlockers || softBlockers.length === 0)) continue;
    for (const cand of rawCandidates) {
      const cx = clampX(cand.cx);
      const cy = clampY(cand.cy);
      if (fitsHard(cx, cy) && (!enforceSoft || fitsSoft(cx, cy))) {
        return {
          centerX: Math.round(cx),
          centerY: Math.round(cy),
          rect: {
            x: cx - pillW / 2,
            y: cy - pillH / 2,
            w: pillW,
            h: pillH
          }
        };
      }
    }
  }

  return null;
}

function intersectRayWithBox(cx, cy, ux, uy, minX, maxX, minY, maxY) {
  let bestT = Infinity;
  let side = 'right';

  if (ux > 1e-5) {
    const t = (maxX - cx) / ux;
    if (t >= 0 && t < bestT) {
      bestT = t;
      side = 'right';
    }
  } else if (ux < -1e-5) {
    const t = (minX - cx) / ux;
    if (t >= 0 && t < bestT) {
      bestT = t;
      side = 'left';
    }
  }

  if (uy > 1e-5) {
    const t = (maxY - cy) / uy;
    if (t >= 0 && t < bestT) {
      bestT = t;
      side = 'bottom';
    }
  } else if (uy < -1e-5) {
    const t = (minY - cy) / uy;
    if (t >= 0 && t < bestT) {
      bestT = t;
      side = 'top';
    }
  }

  if (!Number.isFinite(bestT)) {
    return { x: maxX, y: cy, side: 'right' };
  }

  const hitX = Math.max(minX, Math.min(maxX, cx + ux * bestT));
  const hitY = Math.max(minY, Math.min(maxY, cy + uy * bestT));
  return { x: hitX, y: hitY, side };
}

function findNonOverlappingEdgePosition({
  idealX,
  idealY,
  side,
  ux = 0,
  uy = 0,
  pillW,
  pillH,
  minCenterX,
  maxCenterX,
  minCenterY,
  maxCenterY,
  blockers,
  softBlockers = [],
  gapPx = 6
}) {
  const clampX = (x) => Math.max(minCenterX, Math.min(maxCenterX, x));
  const clampY = (y) => Math.max(minCenterY, Math.min(maxCenterY, y));

  const fitsHard = (cx, cy) => {
    const rect = {
      x: cx - pillW / 2,
      y: cy - pillH / 2,
      w: pillW,
      h: pillH
    };
    return !blockers.some((b) => rectsOverlap(rect, b, gapPx));
  };

  const fitsSoft = (cx, cy) => {
    if (!softBlockers || softBlockers.length === 0) return true;
    const rect = {
      x: cx - pillW / 2,
      y: cy - pillH / 2,
      w: pillW,
      h: pillH
    };
    return !softBlockers.some((b) => rectsOverlap(rect, b, 4));
  };

  // Candidate edges ordered by primary hit side, then the matching quadrant adjacent side first
  const sideOrder =
    side === 'right'
      ? uy < 0
        ? ['right', 'top', 'bottom']
        : ['right', 'bottom', 'top']
      : side === 'left'
        ? uy < 0
          ? ['left', 'top', 'bottom']
          : ['left', 'bottom', 'top']
        : side === 'top'
          ? ux < 0
            ? ['top', 'left', 'right']
            : ['top', 'right', 'left']
          : ux < 0
            ? ['bottom', 'left', 'right']
            : ['bottom', 'right', 'left'];

  const steps = [0, 20, -20, 42, -42, 66, -66, 92, -92, 120, -120, 152, -152];

  // Pass 1: Prefer spots that clear BOTH hard HUD blockers AND the focused land's 3D prism!
  // Pass 2: Fall back to spots that strictly clear all hard HUD blockers & sibling arrows.
  for (const enforceSoft of [true, false]) {
    if (enforceSoft && (!softBlockers || softBlockers.length === 0)) continue;
    for (const candSide of sideOrder) {
      const baseX =
        candSide === 'left'
          ? minCenterX
          : candSide === 'right'
            ? maxCenterX
            : clampX(idealX);
      const baseY =
        candSide === 'top'
          ? minCenterY
          : candSide === 'bottom'
            ? maxCenterY
            : clampY(idealY);

      for (const delta of steps) {
        const testX = candSide === 'top' || candSide === 'bottom' ? clampX(baseX + delta) : baseX;
        const testY = candSide === 'left' || candSide === 'right' ? clampY(baseY + delta) : baseY;
        if (fitsHard(testX, testY) && (!enforceSoft || fitsSoft(testX, testY))) {
          return {
            centerX: Math.round(testX),
            centerY: Math.round(testY),
            side: candSide,
            rect: {
              x: testX - pillW / 2,
              y: testY - pillH / 2,
              w: pillW,
              h: pillH
            }
          };
        }
      }
    }
  }

  return null;
}

/**
 * Computes clickable map tags for other lands and sculptures:
 * - When `onScreenPointers` is true (desktop views), targets projected inside the
 *   visible map viewport are placed cleanly near their screen location with a
 *   same-color leader line (`placement: 'on-screen'`), while off-screen or
 *   behind-camera targets stay pinned on the viewport edges (`placement: 'edge'`).
 * - When `edgeOnly` is true, on-screen targets are skipped so only off-screen
 *   targets render on the viewport edges (used where on-screen tags already have
 *   their own leader lines, such as MapView3D).
 * - When `onScreenPointers` is false (default / mobile), all targets stay pinned
 *   on the viewport edges, preserving existing mobile behavior.
 */
export function computeNeighborEdgeArrows({
  focusedEntry = null,
  originCoords = null,
  otherEntries = [],
  otherSculptures = [],
  projectLngLat = null,
  viewportWidth = 600,
  viewportHeight = 260,
  bearingDeg = 0,
  reservedRects = [],
  avoidRects = [],
  maxArrows = null,
  edgeInsetX = 6,
  topInsetY = 42,
  bottomInsetY = 38,
  unitSystem = 'metric',
  onScreenPointers = false,
  edgeOnly = false,
  defaultLandColor = '',
  onScreenMargin = 14
} = {}) {
  const hasLands = Array.isArray(otherEntries) && otherEntries.length > 0;
  const hasSculptures = Array.isArray(otherSculptures) && otherSculptures.length > 0;
  if (!hasLands && !hasSculptures) {
    return [];
  }
  const vw = Number(viewportWidth || 0);
  const vh = Number(viewportHeight || 0);
  if (vw < 140 || vh < 110) return [];

  const fLat = Number(focusedEntry?.volume?.centerLat ?? originCoords?.lat);
  const fLng = Number(focusedEntry?.volume?.centerLng ?? originCoords?.lng);
  if (!Number.isFinite(fLat) || !Number.isFinite(fLng)) return [];

  const compact = vw < 430 || vh < 250;
  const resolvedMax =
    Number.isFinite(Number(maxArrows)) && Number(maxArrows) > 0
      ? Math.floor(Number(maxArrows))
      : vw < 360 && vh < 250
        ? 2
        : compact
          ? 3
          : onScreenPointers
            ? 6
            : 4;

  const focusedPid = String(focusedEntry?.parcel?.parcelId || focusedEntry?.volume?.parcelId || '');

  // Deduplicate and sort neighboring lands & sculptures by real geographic proximity
  const seenLands = new Set(focusedPid ? [focusedPid] : []);
  const seenSculptures = new Set();
  const rawCandidates = [];

  if (hasLands) {
    for (const entry of otherEntries) {
      const pid = String(entry?.parcel?.parcelId || entry?.volume?.parcelId || '');
      if (!pid || seenLands.has(pid)) continue;
      const lat = Number(entry?.volume?.centerLat);
      const lng = Number(entry?.volume?.centerLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      seenLands.add(pid);
      const baseAlt = Number(entry?.volume?.baseAltitudeM || 0);
      const heightM = Number(entry?.volume?.heightMeters || 0);
      const alt = Number.isFinite(baseAlt) && Number.isFinite(heightM) ? baseAlt + heightM : 0;
      const distanceMeters = haversineMeters(fLat, fLng, lat, lng);
      const frozen = Boolean(entry?.parcel?.frozen || entry?.parcel?.settings?.frozen);
      const dormant = String(entry?.parcel?.stewardStatus || '').toLowerCase() === 'dormant';
      const isSelected = Boolean(entry?.isSelected);
      const theme = resolveNeighborTagTheme({
        kind: 'land',
        defaultLandColor: entry?.accentColor || defaultLandColor,
        isSelected,
        frozen,
        dormant
      });
      rawCandidates.push({
        id: `land:${pid}`,
        kind: 'land',
        entry,
        pid,
        sculptureId: '',
        sculpture: null,
        lat,
        lng,
        alt,
        distanceMeters,
        rawName: resolveLandDisplayName(entry.parcel, { defaultName: 'Neighbor Land' }),
        isSelected,
        isPendingPreview: false,
        ...theme
      });
    }
  }

  if (hasSculptures) {
    for (const item of otherSculptures) {
      const sc = item?.sculpture || item;
      const scId = String(item?.sculptureId || item?.id || sc?.id || '');
      if (!scId || seenSculptures.has(scId)) continue;
      const lat = Number(item?.lat ?? sc?.lat);
      const lng = Number(item?.lng ?? sc?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      seenSculptures.add(scId);
      const alt = Number.isFinite(Number(item?.alt)) ? Number(item.alt) : 0;
      const distanceMeters = haversineMeters(fLat, fLng, lat, lng);
      const isSelected = Boolean(item?.isSelected);
      const isPendingPreview = Boolean(item?.isPendingPreview ?? sc?.isPendingPreview);
      const theme = resolveNeighborTagTheme({
        kind: 'sculpture',
        isSelected,
        isPendingPreview
      });
      rawCandidates.push({
        id: `sculpture:${scId}`,
        kind: 'sculpture',
        entry: null,
        pid: '',
        sculptureId: scId,
        sculpture: sc,
        lat,
        lng,
        alt,
        distanceMeters,
        rawName: String(item?.title || sc?.title || '3D Artwork').trim() || '3D Artwork',
        isSelected,
        isPendingPreview,
        ...theme
      });
    }
  }

  if (rawCandidates.length === 0) return [];

  rawCandidates.sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    return a.distanceMeters - b.distanceMeters;
  });

  // Project focused origin if available (clamped softly near viewport center)
  let originX = vw / 2;
  let originY = vh / 2;
  if (typeof projectLngLat === 'function') {
    try {
      const p0 = projectLngLat(fLng, fLat, 0);
      if (
        p0 &&
        p0.visible !== false &&
        Number.isFinite(p0.x) &&
        Number.isFinite(p0.y) &&
        p0.x >= -vw * 0.5 &&
        p0.x <= vw * 1.5 &&
        p0.y >= -vh * 0.5 &&
        p0.y <= vh * 1.5
      ) {
        originX = Math.max(vw * 0.18, Math.min(vw * 0.82, p0.x));
        originY = Math.max(vh * 0.2, Math.min(vh * 0.8, p0.y));
      }
    } catch {
      // fall back to viewport center
    }
  }

  const bearingRad = Number(bearingDeg || 0) * DEG_TO_RAD;
  const margin = Math.max(4, Number(onScreenMargin) || 14);
  const checkProjection = typeof projectLngLat === 'function';

  // Project each candidate once to determine forward-facing screen vector and on-screen visibility
  const evaluated = [];
  for (const cand of rawCandidates) {
    const geoBearing = computeGeoBearingRad(fLat, fLng, cand.lat, cand.lng);
    const relRad = geoBearing - bearingRad;
    const geoUx = Math.sin(relRad);
    const geoUy = -Math.cos(relRad);
    let ux = geoUx;
    let uy = geoUy;
    let projectedPt = null;
    let isOnScreen = false;

    if (checkProjection) {
      try {
        const pt = projectLngLat(cand.lng, cand.lat, cand.alt);
        if (pt && pt.visible !== false && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
          const withinBounds = Math.abs(pt.x) < vw * 6 && Math.abs(pt.y) < vh * 6;
          if (withinBounds) {
            const pdx = pt.x - originX;
            const pdy = pt.y - originY;
            const pLen = Math.hypot(pdx, pdy);
            let forwardValid = pt.visible === true;
            if (!forwardValid) {
              if (pLen <= 12 || cand.distanceMeters < 15) {
                forwardValid = true;
              } else {
                const pux = pdx / pLen;
                const puy = pdy / pLen;
                // Ensure projected direction agrees with true geographic hemisphere (dot > 0.35)
                forwardValid = pux * geoUx + puy * geoUy > 0.35;
              }
            }
            if (forwardValid) {
              projectedPt = { x: pt.x, y: pt.y };
              if (pLen > 12) {
                ux = pdx / pLen;
                uy = pdy / pLen;
              }
              if (
                pt.x >= margin &&
                pt.x <= vw - margin &&
                pt.y >= margin &&
                pt.y <= vh - margin
              ) {
                isOnScreen = true;
              }
            }
          }
        }
      } catch {
        // keep exact geographic vector
      }
    }

    const norm = Math.hypot(ux, uy) || 1;
    ux /= norm;
    uy /= norm;

    if (edgeOnly && isOnScreen) continue;

    evaluated.push({
      ...cand,
      ux,
      uy,
      projectedPt,
      isOnScreen: Boolean(onScreenPointers && !edgeOnly && isOnScreen && projectedPt)
    });
  }

  if (evaluated.length === 0) return [];

  const blockers = Array.isArray(reservedRects) ? [...reservedRects] : [];
  const results = [];
  const maxChars = compact ? 13 : 19;

  const placeCandidate = (cand) => {
    const label =
      cand.rawName.length > maxChars
        ? `${cand.rawName.slice(0, maxChars - 1).trimEnd()}…`
        : cand.rawName;
    const distanceLabel =
      cand.kind === 'sculpture' && cand.distanceMeters < 2
        ? ''
        : formatCompactNeighborDistance(cand.distanceMeters, unitSystem);
    const { w: pillW, h: pillH } = estimateArrowPillSize(
      label,
      distanceLabel,
      compact,
      cand.isOnScreen
    );

    const minCenterX = edgeInsetX + pillW / 2;
    const maxCenterX = Math.max(minCenterX, vw - edgeInsetX - pillW / 2);
    const minCenterY = topInsetY + pillH / 2;
    const maxCenterY = Math.max(minCenterY, vh - bottomInsetY - pillH / 2);

    if (cand.isOnScreen && cand.projectedPt) {
      const targetX = cand.projectedPt.x;
      const targetY = cand.projectedPt.y;
      let placed = findNonOverlappingOnScreenPosition({
        targetX,
        targetY,
        originX,
        originY,
        pillW,
        pillH,
        minCenterX,
        maxCenterX,
        minCenterY,
        maxCenterY,
        blockers,
        softBlockers: avoidRects,
        gapPx: 6
      });
      if (!placed) {
        const hit = intersectRayWithBox(
          originX,
          originY,
          cand.ux,
          cand.uy,
          minCenterX,
          maxCenterX,
          minCenterY,
          maxCenterY
        );
        placed = findNonOverlappingEdgePosition({
          idealX: hit.x,
          idealY: hit.y,
          side: hit.side,
          ux: cand.ux,
          uy: cand.uy,
          pillW,
          pillH,
          minCenterX,
          maxCenterX,
          minCenterY,
          maxCenterY,
          blockers,
          softBlockers: avoidRects,
          gapPx: 6
        });
      }
      if (!placed) return false;

      blockers.push(placed.rect);
      const anchor = computePillBorderAnchor(
        placed.centerX,
        placed.centerY,
        pillW,
        pillH,
        targetX,
        targetY
      );
      const roundedTargetX = Math.round(targetX);
      const roundedTargetY = Math.round(targetY);
      const arrowDeg = Math.round(
        Math.atan2(roundedTargetY - anchor.y, roundedTargetX - anchor.x) * RAD_TO_DEG
      );

      results.push({
        id: cand.id,
        kind: cand.kind,
        parcelId: cand.pid,
        parcel: cand.entry?.parcel || null,
        sculptureId: cand.sculptureId,
        sculpture: cand.sculpture,
        label,
        fullLabel: cand.rawName,
        distanceMeters: Math.round(cand.distanceMeters),
        distanceLabel,
        x: placed.centerX,
        y: placed.centerY,
        edgeInsetX,
        width: pillW,
        height: pillH,
        side: 'on-screen',
        placement: 'on-screen',
        arrowDeg,
        targetX: roundedTargetX,
        targetY: roundedTargetY,
        fromX: anchor.x,
        fromY: anchor.y,
        accentColor: cand.accentColor,
        dotColor: cand.dotColor,
        textColor: cand.textColor,
        isPendingPreview: cand.isPendingPreview
      });
      return true;
    }

    const hit = intersectRayWithBox(
      originX,
      originY,
      cand.ux,
      cand.uy,
      minCenterX,
      maxCenterX,
      minCenterY,
      maxCenterY
    );

    const placed = findNonOverlappingEdgePosition({
      idealX: hit.x,
      idealY: hit.y,
      side: hit.side,
      ux: cand.ux,
      uy: cand.uy,
      pillW,
      pillH,
      minCenterX,
      maxCenterX,
      minCenterY,
      maxCenterY,
      blockers,
      softBlockers: avoidRects,
      gapPx: 6
    });
    if (!placed) return false;

    blockers.push(placed.rect);
    const arrowDeg = Math.round(Math.atan2(cand.uy, cand.ux) * RAD_TO_DEG);

    results.push({
      id: cand.id,
      kind: cand.kind,
      parcelId: cand.pid,
      parcel: cand.entry?.parcel || null,
      sculptureId: cand.sculptureId,
      sculpture: cand.sculpture,
      label,
      fullLabel: cand.rawName,
      distanceMeters: Math.round(cand.distanceMeters),
      distanceLabel,
      x: placed.centerX,
      y: placed.centerY,
      edgeInsetX,
      width: pillW,
      height: pillH,
      side: placed.side,
      placement: 'edge',
      arrowDeg,
      targetX: null,
      targetY: null,
      fromX: null,
      fromY: null,
      accentColor: cand.accentColor,
      dotColor: cand.dotColor,
      textColor: cand.textColor,
      isPendingPreview: cand.isPendingPreview
    });
    return true;
  };

  if (onScreenPointers && !edgeOnly) {
    const onScreenBucket = evaluated.filter((c) => c.isOnScreen);
    const edgeBucket = evaluated.filter((c) => !c.isOnScreen);
    const edgeReserve =
      onScreenBucket.length > 0 && edgeBucket.length > 0
        ? Math.min(edgeBucket.length, Math.max(2, Math.floor(resolvedMax / 3)))
        : 0;
    const onScreenQuota = Math.max(0, resolvedMax - edgeReserve);

    const remainingOnScreen = [];
    let placedOnScreen = 0;
    for (const cand of onScreenBucket) {
      if (placedOnScreen < onScreenQuota && results.length < resolvedMax) {
        if (placeCandidate(cand)) placedOnScreen++;
      } else {
        remainingOnScreen.push(cand);
      }
    }
    for (const cand of edgeBucket) {
      if (results.length >= resolvedMax) break;
      placeCandidate(cand);
    }
    for (const cand of remainingOnScreen) {
      if (results.length >= resolvedMax) break;
      placeCandidate(cand);
    }
  } else {
    for (const cand of evaluated) {
      if (results.length >= resolvedMax) break;
      placeCandidate(cand);
    }
  }

  return results;
}

/**
 * Produces a lightweight string signature for tag/arrow state deduplication
 * so 60fps MapLibre render loops only trigger React re-renders when positions visibly move.
 */
export function buildNeighborArrowsSignature(arrows = []) {
  if (!Array.isArray(arrows) || arrows.length === 0) return '';
  return arrows
    .map(
      (a) =>
        `${a.id || a.parcelId}:${a.placement || 'edge'}:${Math.round(a.x / 2)}:${Math.round(
          a.y / 2
        )}:${a.side}:${Math.round(a.arrowDeg / 3)}:${
          a.targetX != null ? Math.round(a.targetX / 2) : ''
        }:${a.targetY != null ? Math.round(a.targetY / 2) : ''}:${a.accentColor || ''}:${a.label}`
    )
    .join('|');
}
