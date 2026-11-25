import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import {
  footprintsOverlap,
  normalizeRotationDeg,
  validateAndNormalizeLandVolume
} from '../../../shared/landVolume.mjs';

export const MAX_DRAFT_HISTORY_ENTRIES = 50;
export const DRAFT_EDIT_COALESCE_MS = 650;
const METERS_PER_DEG_LAT = 111320;
const MAX_TITLE_LENGTH = 48;

export function cloneDraft(draft) {
  if (!draft || typeof draft !== 'object') return null;
  return {
    id: String(draft.id || ''),
    ...(draft.parcelId ? { parcelId: String(draft.parcelId) } : {}),
    centerLat: Number(draft.centerLat ?? draft.lat),
    centerLng: Number(draft.centerLng ?? draft.lng),
    widthMeters: Number(draft.widthMeters ?? LAND_VOLUME_LIMITS.defaultWidthMeters),
    depthMeters: Number(draft.depthMeters ?? LAND_VOLUME_LIMITS.defaultDepthMeters),
    heightMeters: Number(draft.heightMeters ?? LAND_VOLUME_LIMITS.defaultHeightMeters),
    zScale: Number(
      draft.zScale ??
        Number(draft.heightMeters ?? LAND_VOLUME_LIMITS.defaultHeightMeters) /
          LAND_VOLUME_LIMITS.defaultHeightMeters
    ),
    rotationDeg: Number(draft.rotationDeg || 0),
    customName: String(draft.customName || ''),
    ...(draft.description !== undefined ? { description: String(draft.description || '') } : {})
  };
}

export function cloneDrafts(drafts) {
  if (!Array.isArray(drafts)) return [];
  return drafts.map(cloneDraft).filter(Boolean);
}

export function draftSnapshotsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      Number(x.centerLat ?? x.lat) !== Number(y.centerLat ?? y.lat) ||
      Number(x.centerLng ?? x.lng) !== Number(y.centerLng ?? y.lng) ||
      Number(x.widthMeters) !== Number(y.widthMeters) ||
      Number(x.depthMeters) !== Number(y.depthMeters) ||
      Number(x.heightMeters) !== Number(y.heightMeters) ||
      Number(x.rotationDeg || 0) !== Number(y.rotationDeg || 0) ||
      String(x.customName || '') !== String(y.customName || '') ||
      String(x.description || '') !== String(y.description || '')
    ) {
      return false;
    }
  }
  return true;
}

export function pushDraftHistoryEntry(
  pastStack,
  { drafts, selectedDraftId = '', label = 'Land edit' },
  maxEntries = MAX_DRAFT_HISTORY_ENTRIES
) {
  const nextEntry = {
    drafts: cloneDrafts(drafts),
    selectedDraftId: String(selectedDraftId || ''),
    label: String(label || 'Land edit')
  };
  const list = Array.isArray(pastStack) ? [...pastStack, nextEntry] : [nextEntry];
  if (list.length > maxEntries) {
    return list.slice(list.length - maxEntries);
  }
  return list;
}

/**
 * Removes minted draft IDs from undo/redo history stacks so undoing later edits
 * can never resurrect an already-minted land as an unminted draft.
 */
export function pruneDraftIdsFromHistory(stack, removedIds) {
  if (!Array.isArray(stack) || stack.length === 0) return [];
  const removeSet = removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  if (removeSet.size === 0) return stack;

  const cleaned = [];
  for (const entry of stack) {
    const filteredDrafts = cloneDrafts(entry.drafts).filter((d) => !removeSet.has(d.id));
    const nextSelected = removeSet.has(entry.selectedDraftId) ? '' : entry.selectedDraftId || '';
    const prev = cleaned[cleaned.length - 1];
    if (prev && draftSnapshotsEqual(prev.drafts, filteredDrafts) && prev.selectedDraftId === nextSelected) {
      continue;
    }
    cleaned.push({
      ...entry,
      drafts: filteredDrafts,
      selectedDraftId: nextSelected
    });
  }
  return cleaned;
}

export function getDraftUpdateFieldGroup(patch) {
  if (!patch || typeof patch !== 'object') return 'other';
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === 'customName') return 'title';
  if (keys.length === 1 && keys[0] === 'description') return 'description';
  if (
    keys.some((k) =>
      ['centerLat', 'centerLng', 'lat', 'lng', 'widthMeters', 'depthMeters', 'heightMeters', 'zScale', 'rotationDeg'].includes(k)
    )
  ) {
    return 'geometry';
  }
  return 'other';
}

export function isEditableKeyboardTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (typeof target.getAttribute === 'function') {
    const role = String(target.getAttribute('role') || '').toLowerCase();
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  }
  if (typeof target.closest === 'function') {
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) {
      return true;
    }
  }
  return false;
}

export function hasActiveTextSelection(win = typeof window !== 'undefined' ? window : null) {
  try {
    const sel = win?.getSelection?.();
    return Boolean(sel && String(sel.toString() || '').trim().length > 0);
  } catch {
    return false;
  }
}

export function extractLandCopyTemplate(source, limits = LAND_VOLUME_LIMITS) {
  if (!source || typeof source !== 'object') return null;
  const vol = source.volume && typeof source.volume === 'object' ? source.volume : source;
  const centerLat = Number(vol.centerLat ?? source.centerLat ?? source.lat);
  const centerLng = Number(vol.centerLng ?? source.centerLng ?? source.lng);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) return null;

  const heightMeters = Number(vol.heightMeters ?? source.heightMeters ?? limits.defaultHeightMeters);
  return {
    centerLat,
    centerLng,
    widthMeters: Number(vol.widthMeters ?? source.widthMeters ?? limits.defaultWidthMeters),
    depthMeters: Number(vol.depthMeters ?? source.depthMeters ?? limits.defaultDepthMeters),
    heightMeters,
    zScale: Number(
      (
        Number(vol.zScale ?? source.zScale ?? heightMeters / limits.defaultHeightMeters) || 1
      ).toFixed(3)
    ),
    rotationDeg: normalizeRotationDeg(vol.rotationDeg ?? source.rotationDeg ?? 0),
    customName: String(source.customName || '').trim(),
    description: String(source.description || source.curationNote || '')
  };
}

export function buildUniqueCopyName(baseName, existingNames = []) {
  const cleaned = String(baseName || '').trim();
  if (!cleaned) return '';

  const taken = new Set(
    (existingNames || [])
      .map((n) => String(n || '').trim().toLowerCase())
      .filter(Boolean)
  );

  // Strip an existing trailing " Copy" or " Copy 2" so repeated copies stay tidy
  const root = cleaned.replace(/\s+copy(?:\s+\d+)?$/i, '').trim() || cleaned;

  for (let n = 1; n <= 99; n += 1) {
    const suffix = n === 1 ? ' Copy' : ` Copy ${n}`;
    const maxRootLen = Math.max(2, MAX_TITLE_LENGTH - suffix.length);
    const candidate = `${root.slice(0, maxRootLen).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${root.slice(0, MAX_TITLE_LENGTH - 5).trimEnd()} Copy`;
}

export function createPastedDraftFromTemplate(
  template,
  {
    existingParcels = [],
    existingDrafts = [],
    limits = LAND_VOLUME_LIMITS,
    idFactory = null
  } = {}
) {
  const base = extractLandCopyTemplate(template, limits);
  if (!base) return null;

  const takenVols = [
    ...(existingParcels || []).map((p) => p?.volume || null).filter(Boolean),
    ...(existingDrafts || [])
      .map((d) => {
        if (d?.ring && d?.corners) return d;
        const res = validateAndNormalizeLandVolume({
          lat: Number(d?.centerLat ?? d?.lat),
          lng: Number(d?.centerLng ?? d?.lng),
          widthMeters: d?.widthMeters,
          depthMeters: d?.depthMeters,
          heightMeters: d?.heightMeters,
          zScale: d?.zScale,
          rotationDeg: d?.rotationDeg
        });
        return res.ok ? res.volume : null;
      })
      .filter(Boolean)
  ];

  const rotRad = (base.rotationDeg * Math.PI) / 180;
  const gapMeters = 4;
  const stepX = Math.max(8, base.widthMeters + gapMeters);
  const stepY = Math.max(8, base.depthMeters + gapMeters);
  const mPerDegLng =
    METERS_PER_DEG_LAT * Math.max(0.08, Math.cos((base.centerLat * Math.PI) / 180));

  // Search expanding adjacent slots aligned to the copied land's orientation:
  // right (+X), front (+Y), left (-X), back (-Y), diagonals, then further rings.
  const gridOffsets = [];
  for (let ring = 1; ring <= 6; ring += 1) {
    gridOffsets.push([ring, 0], [0, ring], [-ring, 0], [0, -ring]);
    gridOffsets.push([ring, ring], [-ring, ring], [ring, -ring], [-ring, -ring]);
    for (let k = 1; k < ring; k += 1) {
      gridOffsets.push([ring, k], [ring, -k], [-ring, k], [-ring, -k], [k, ring], [-k, ring], [k, -ring], [-k, -ring]);
    }
  }

  let chosenLat = Number(
    (base.centerLat + (-stepX * Math.sin(rotRad)) / METERS_PER_DEG_LAT).toFixed(7)
  );
  let chosenLng = Number(
    (base.centerLng + (stepX * Math.cos(rotRad)) / mPerDegLng).toFixed(7)
  );

  for (const [gx, gy] of gridOffsets) {
    const localX = gx * stepX;
    const localY = gy * stepY;
    // Rotate local (east=+X, north=+Y) by clockwise rotationDeg
    const eastM = localX * Math.cos(rotRad) + localY * Math.sin(rotRad);
    const northM = -localX * Math.sin(rotRad) + localY * Math.cos(rotRad);
    const candLat = Number((base.centerLat + northM / METERS_PER_DEG_LAT).toFixed(7));
    const candLng = Number((base.centerLng + eastM / mPerDegLng).toFixed(7));

    const probe = validateAndNormalizeLandVolume({
      lat: candLat,
      lng: candLng,
      widthMeters: base.widthMeters,
      depthMeters: base.depthMeters,
      heightMeters: base.heightMeters,
      zScale: base.zScale,
      rotationDeg: base.rotationDeg
    });
    if (probe.ok && probe.volume && !takenVols.some((tv) => footprintsOverlap(probe.volume, tv))) {
      chosenLat = candLat;
      chosenLng = candLng;
      break;
    }
  }

  const existingNames = [
    ...(existingDrafts || []).map((d) => d?.customName),
    ...(existingParcels || []).map((p) => p?.customName)
  ];

  const nextId =
    typeof idFactory === 'function'
      ? idFactory()
      : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  return {
    id: nextId,
    centerLat: chosenLat,
    centerLng: chosenLng,
    widthMeters: base.widthMeters,
    depthMeters: base.depthMeters,
    heightMeters: base.heightMeters,
    zScale: base.zScale,
    rotationDeg: base.rotationDeg,
    customName: buildUniqueCopyName(base.customName, existingNames),
    ...(base.description ? { description: base.description } : {})
  };
}
