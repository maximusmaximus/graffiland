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

function estimateArrowPillSize(label, distanceLabel, compact = false) {
  const fullChars = String(label || '').length + (distanceLabel ? distanceLabel.length + 1 : 0);
  const charW = compact ? 5.2 : 6.2;
  const arrowBadgeW = compact ? 20 : 24;
  const padX = compact ? 12 : 18;
  const maxW = compact ? 124 : 176;
  const minW = compact ? 64 : 84;
  const w = Math.max(minW, Math.min(maxW, Math.round(fullChars * charW + arrowBadgeW + padX)));
  const h = compact ? 23 : 28;
  return { w, h };
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
 * Computes clickable perimeter edge-arrow labels pointing from a focused land
 * toward selectable neighboring lands without drawing neighboring wireframe lines
 * and without overlapping map HUD buttons or sibling labels.
 */
export function computeNeighborEdgeArrows({
  focusedEntry = null,
  otherEntries = [],
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
  unitSystem = 'metric'
} = {}) {
  if (!focusedEntry?.volume || !Array.isArray(otherEntries) || otherEntries.length === 0) {
    return [];
  }
  const vw = Number(viewportWidth || 0);
  const vh = Number(viewportHeight || 0);
  if (vw < 140 || vh < 110) return [];

  const fLat = Number(focusedEntry.volume.centerLat);
  const fLng = Number(focusedEntry.volume.centerLng);
  if (!Number.isFinite(fLat) || !Number.isFinite(fLng)) return [];

  const compact = vw < 430 || vh < 250;
  const resolvedMax =
    Number.isFinite(Number(maxArrows)) && Number(maxArrows) > 0
      ? Math.floor(Number(maxArrows))
      : vw < 360 && vh < 250
        ? 2
        : compact
          ? 3
          : 4;

  const focusedPid = String(focusedEntry.parcel?.parcelId || focusedEntry.volume.parcelId || '');

  // Deduplicate and sort neighboring lands by real geographic proximity
  const seen = new Set([focusedPid]);
  const candidates = [];
  for (const entry of otherEntries) {
    const pid = String(entry?.parcel?.parcelId || entry?.volume?.parcelId || '');
    if (!pid || seen.has(pid)) continue;
    const lat = Number(entry?.volume?.centerLat);
    const lng = Number(entry?.volume?.centerLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    seen.add(pid);
    const distanceMeters = haversineMeters(fLat, fLng, lat, lng);
    candidates.push({ entry, pid, lat, lng, distanceMeters });
  }
  if (candidates.length === 0) return [];

  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);

  // Project focused origin if available (clamped softly near viewport center)
  let originX = vw / 2;
  let originY = vh / 2;
  if (typeof projectLngLat === 'function') {
    try {
      const p0 = projectLngLat(fLng, fLat);
      if (
        p0 &&
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
  const blockers = Array.isArray(reservedRects) ? [...reservedRects] : [];
  const results = [];

  for (const cand of candidates) {
    if (results.length >= resolvedMax) break;

    // 1) Mathematically exact geographic screen vector (immune to pitched 3D behind-camera flip)
    const geoBearing = computeGeoBearingRad(fLat, fLng, cand.lat, cand.lng);
    const relRad = geoBearing - bearingRad;
    let ux = Math.sin(relRad);
    let uy = -Math.cos(relRad);

    // 2) Refine using live map projection when projected point is well-behaved & forward-facing
    if (typeof projectLngLat === 'function') {
      try {
        const pt = projectLngLat(cand.lng, cand.lat);
        if (
          pt &&
          Number.isFinite(pt.x) &&
          Number.isFinite(pt.y) &&
          Math.abs(pt.x) < vw * 6 &&
          Math.abs(pt.y) < vh * 6
        ) {
          const pdx = pt.x - originX;
          const pdy = pt.y - originY;
          const pLen = Math.hypot(pdx, pdy);
          if (pLen > 12) {
            const pux = pdx / pLen;
            const puy = pdy / pLen;
            // Ensure projected direction agrees with true geographic hemisphere (dot > 0.35)
            if (pux * ux + puy * uy > 0.35) {
              ux = pux;
              uy = puy;
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

    const rawName = resolveLandDisplayName(cand.entry.parcel, { defaultName: 'Neighbor Land' });
    const maxChars = compact ? 13 : 19;
    const label =
      rawName.length > maxChars ? `${rawName.slice(0, maxChars - 1).trimEnd()}…` : rawName;
    const distanceLabel = formatCompactNeighborDistance(cand.distanceMeters, unitSystem);
    const { w: pillW, h: pillH } = estimateArrowPillSize(label, distanceLabel, compact);

    const minCenterX = edgeInsetX + pillW / 2;
    const maxCenterX = Math.max(minCenterX, vw - edgeInsetX - pillW / 2);
    const minCenterY = topInsetY + pillH / 2;
    const maxCenterY = Math.max(minCenterY, vh - bottomInsetY - pillH / 2);

    const hit = intersectRayWithBox(
      originX,
      originY,
      ux,
      uy,
      minCenterX,
      maxCenterX,
      minCenterY,
      maxCenterY
    );

    const placed = findNonOverlappingEdgePosition({
      idealX: hit.x,
      idealY: hit.y,
      side: hit.side,
      ux,
      uy,
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
    if (!placed) continue;

    blockers.push(placed.rect);
    const arrowDeg = Math.round(Math.atan2(uy, ux) * RAD_TO_DEG);

    results.push({
      parcelId: cand.pid,
      parcel: cand.entry.parcel,
      label,
      fullLabel: rawName,
      distanceMeters: Math.round(cand.distanceMeters),
      distanceLabel,
      x: placed.centerX,
      y: placed.centerY,
      edgeInsetX,
      width: pillW,
      height: pillH,
      side: placed.side,
      arrowDeg
    });
  }

  return results;
}

/**
 * Produces a lightweight string signature for edge-arrow state deduplication
 * so 60fps MapLibre render loops only trigger React re-renders when positions visibly move.
 */
export function buildNeighborArrowsSignature(arrows = []) {
  if (!Array.isArray(arrows) || arrows.length === 0) return '';
  return arrows
    .map(
      (a) =>
        `${a.parcelId}:${Math.round(a.x / 2)}:${Math.round(a.y / 2)}:${a.side}:${Math.round(
          a.arrowDeg / 3
        )}:${a.label}`
    )
    .join('|');
}
