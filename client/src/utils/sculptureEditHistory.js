import {
  extractSculptureRotation,
  extractSculptureScale,
  tiltToDegrees
} from '../../../shared/sculpturePlacement.mjs';

const NUM_EPS = 1e-4;

export function createSculptureEditSnapshot({
  title = '',
  description = '',
  scale = 1,
  offset = null
} = {}) {
  const o = offset || {};
  return {
    title: String(title ?? ''),
    description: String(description ?? ''),
    scale: Number.isFinite(Number(scale)) ? Number(scale) : 1,
    offset: {
      dx: Number.isFinite(Number(o.dx)) ? Number(o.dx) : 0,
      dy: Number.isFinite(Number(o.dy)) ? Math.max(0, Number(o.dy)) : 0,
      dz: Number.isFinite(Number(o.dz)) ? Number(o.dz) : 0,
      yaw: Number.isFinite(Number(o.yaw)) ? Number(o.yaw) : 0,
      pitch: tiltToDegrees(o.pitch || 0),
      roll: tiltToDegrees(o.roll || 0)
    }
  };
}

export function createSnapshotFromSculpture(sc) {
  if (!sc) return createSculptureEditSnapshot();
  const rot = extractSculptureRotation(sc);
  return createSculptureEditSnapshot({
    title: sc.title || '',
    description: sc.description || '',
    scale: extractSculptureScale(sc),
    offset: {
      dx: Number(sc.anchorOffset?.dx || 0),
      dy: Math.max(0, Number(sc.anchorOffset?.dy || 0)),
      dz: Number(sc.anchorOffset?.dz || 0),
      yaw: rot.yaw,
      pitch: rot.pitch,
      roll: rot.roll
    }
  });
}

export function sculptureSnapshotsEqual(a, b) {
  if (!a || !b) return false;
  if (String(a.title ?? '') !== String(b.title ?? '')) return false;
  if (String(a.description ?? '') !== String(b.description ?? '')) return false;
  if (Math.abs(Number(a.scale || 1) - Number(b.scale || 1)) > NUM_EPS) return false;
  const oa = a.offset || {};
  const ob = b.offset || {};
  for (const k of ['dx', 'dy', 'dz', 'yaw', 'pitch', 'roll']) {
    if (Math.abs(Number(oa[k] || 0) - Number(ob[k] || 0)) > NUM_EPS) return false;
  }
  return true;
}

export function hasUnsavedSculptureEdits(current, baseline) {
  if (!current || !baseline) return false;
  return !sculptureSnapshotsEqual(current, baseline);
}

export function pushSculptureUndoSnapshot(stack, snapshot, { label = 'Edit', maxDepth = 50 } = {}) {
  const list = Array.isArray(stack) ? stack : [];
  const clean = createSculptureEditSnapshot(snapshot);
  const top = list[list.length - 1];
  if (top && sculptureSnapshotsEqual(top.snapshot, clean)) {
    return list;
  }
  const next = [...list, { snapshot: clean, label: String(label || 'Edit') }];
  return next.length > maxDepth ? next.slice(next.length - maxDepth) : next;
}

export function applySculptureUndo(undoStack, redoStack, currentSnapshot) {
  const past = Array.isArray(undoStack) ? undoStack : [];
  if (past.length === 0) return null;
  const targetEntry = past[past.length - 1];
  const nextUndo = past.slice(0, -1);
  const nextRedo = pushSculptureUndoSnapshot(redoStack, currentSnapshot, {
    label: targetEntry.label
  });
  return {
    restored: createSculptureEditSnapshot(targetEntry.snapshot),
    label: targetEntry.label,
    undoStack: nextUndo,
    redoStack: nextRedo
  };
}

export function applySculptureRedo(undoStack, redoStack, currentSnapshot) {
  const future = Array.isArray(redoStack) ? redoStack : [];
  if (future.length === 0) return null;
  const targetEntry = future[future.length - 1];
  const nextRedo = future.slice(0, -1);
  const nextUndo = pushSculptureUndoSnapshot(undoStack, currentSnapshot, {
    label: targetEntry.label
  });
  return {
    restored: createSculptureEditSnapshot(targetEntry.snapshot),
    label: targetEntry.label,
    undoStack: nextUndo,
    redoStack: nextRedo
  };
}

/**
 * Determines whether the signed-in user can edit a given sibling sculpture on the same land.
 * Mirrors SculptureModal's exact permission rules (creator/NFT owner, land owner, or contributor).
 */
export function canUserModifySiblingSculpture(
  targetSc,
  { user = null, parcelDetail = null, allParcels = [], fallbackContributor = false } = {}
) {
  if (!user?.id || !targetSc?.id || targetSc.isPendingPreview) return false;
  const uid = String(user.id);
  const ownerAddr = String(targetSc.recipientAddress || targetSc.ownerAddress || '').toLowerCase();
  const userWallets = [user.walletAddress, user.customPayoutAddress, user.activeMintRecipient]
    .filter(Boolean)
    .map((a) => String(a).toLowerCase());

  const isCreatorOwner = Boolean(targetSc.creatorSub && String(targetSc.creatorSub) === uid);
  const isPropertyOwner = Boolean(isCreatorOwner || (ownerAddr && userWallets.includes(ownerAddr)));
  if (isPropertyOwner) return true;

  const pid = String(targetSc.parcelId || parcelDetail?.parcelId || '').toUpperCase();
  const matchedParcel =
    parcelDetail ||
    (Array.isArray(allParcels)
      ? allParcels.find((p) => String(p?.parcelId || '').toUpperCase() === pid)
      : null);

  const isLandOwner = Boolean(
    targetSc.viewerIsLandOwner ||
      (matchedParcel?.ownerSub && String(matchedParcel.ownerSub) === uid) ||
      (matchedParcel?.claimedBy && String(matchedParcel.claimedBy) === uid) ||
      (matchedParcel?.landDeed?.ownerSub && String(matchedParcel.landDeed.ownerSub) === uid)
  );
  if (isLandOwner) return true;

  const isContributor = Boolean(targetSc.viewerCanContribute || fallbackContributor);
  return isContributor;
}
