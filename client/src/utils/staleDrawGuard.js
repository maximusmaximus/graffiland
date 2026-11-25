import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import {
  STALE_DRAW_ERASE_DISTANCE_FEET,
  STALE_DRAW_ERASE_DISTANCE_METERS,
  STALE_DRAW_ERASE_IDLE_MS
} from '../../../shared/constants.mjs';

const METERS_PER_FOOT = 0.3048;

/**
 * Normalizes a GPS location object to a clean finite `{ lat, lng }` pair (plus optional
 * positive `accuracy`), returning `null` if coordinates are missing or out of range.
 *
 * @param {{ lat?: any, lng?: any, accuracy?: any } | null | undefined} loc
 * @returns {{ lat: number, lng: number, accuracy?: number } | null}
 */
export function normalizeDrawLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  if (loc.lat === null || loc.lat === undefined || loc.lat === '') return null;
  if (loc.lng === null || loc.lng === undefined || loc.lng === '') return null;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const out = { lat, lng };
  const acc = Number(loc.accuracy);
  if (Number.isFinite(acc) && acc > 0) {
    out.accuracy = acc;
  }
  return out;
}

/**
 * Resolves the initial draw activity timestamp & GPS anchor from a restored local draft.
 * Supports both new drafts (`lastDrawAt` + `drawLocation`) and legacy drafts (`updatedAt`).
 *
 * @param {Record<string, any> | null | undefined} initialDraft
 * @param {number} [nowMs]
 * @returns {{ lastDrawAt: number | null, drawLocation: { lat: number, lng: number, accuracy?: number } | null }}
 */
export function resolveInitialDrawActivity(initialDraft, nowMs = Date.now()) {
  if (!initialDraft || typeof initialDraft !== 'object') {
    return { lastDrawAt: null, drawLocation: null };
  }
  const hasDrawnContent = Boolean(
    (Array.isArray(initialDraft.voxels) && initialDraft.voxels.length > 0) ||
      initialDraft.surfaceAnchor
  );
  if (!hasDrawnContent) {
    return { lastDrawAt: null, drawLocation: null };
  }

  let lastDrawAt = null;
  const rawLastDraw = Number(initialDraft.lastDrawAt);
  if (Number.isFinite(rawLastDraw) && rawLastDraw > 0) {
    lastDrawAt = rawLastDraw;
  } else if (typeof initialDraft.updatedAt === 'string' && initialDraft.updatedAt) {
    const parsed = Date.parse(initialDraft.updatedAt);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastDrawAt = parsed;
    }
  }
  if (lastDrawAt === null) {
    lastDrawAt = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  }

  const drawLocation = normalizeDrawLocation(
    initialDraft.drawLocation || initialDraft.location || null
  );
  return { lastDrawAt, drawLocation };
}

/**
 * Evaluates whether the user's drawn in-view canvas content should be automatically erased
 * because they changed locations by strictly more than 20 ft (6.096 m) and have not
 * drawn/painted more in the last 5 minutes (300,000 ms).
 */
export function evaluateStaleDrawErase({
  hasDrawnContent = false,
  isActivelyDrawing = false,
  isPublishing = false,
  lastDrawAt = null,
  drawLocation = null,
  currentLocation = null,
  nowMs = Date.now(),
  distanceThresholdMeters = STALE_DRAW_ERASE_DISTANCE_METERS,
  idleThresholdMs = STALE_DRAW_ERASE_IDLE_MS
} = {}) {
  if (!hasDrawnContent) {
    return {
      shouldErase: false,
      reason: 'empty',
      distanceMeters: null,
      distanceFeet: null,
      idleMs: 0
    };
  }
  if (isActivelyDrawing) {
    return {
      shouldErase: false,
      reason: 'drawing',
      distanceMeters: null,
      distanceFeet: null,
      idleMs: 0
    };
  }
  if (isPublishing) {
    return {
      shouldErase: false,
      reason: 'publishing',
      distanceMeters: null,
      distanceFeet: null,
      idleMs: 0
    };
  }

  const origin = normalizeDrawLocation(drawLocation);
  const current = normalizeDrawLocation(currentLocation);
  if (!origin || !current) {
    return {
      shouldErase: false,
      reason: 'no_location',
      distanceMeters: null,
      distanceFeet: null,
      idleMs: 0
    };
  }

  const distanceMeters = haversineMeters(origin.lat, origin.lng, current.lat, current.lng);
  const distanceFeet = distanceMeters / METERS_PER_FOOT;

  const drawTs = Number(lastDrawAt);
  if (!Number.isFinite(drawTs) || drawTs <= 0) {
    return {
      shouldErase: false,
      reason: 'no_timestamp',
      distanceMeters,
      distanceFeet,
      idleMs: 0
    };
  }

  const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const idleMs = Math.max(0, safeNow - drawTs);

  const movedBeyondThreshold = distanceMeters > distanceThresholdMeters;
  const idleBeyondThreshold = idleMs >= idleThresholdMs;

  if (movedBeyondThreshold && idleBeyondThreshold) {
    return {
      shouldErase: true,
      reason: 'moved_and_idle',
      distanceMeters,
      distanceFeet,
      idleMs,
      thresholdFeet: STALE_DRAW_ERASE_DISTANCE_FEET
    };
  }

  return {
    shouldErase: false,
    reason: !movedBeyondThreshold ? 'within_distance' : 'recent_draw',
    distanceMeters,
    distanceFeet,
    idleMs
  };
}
