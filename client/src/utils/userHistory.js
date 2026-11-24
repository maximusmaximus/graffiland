const HISTORY_STORAGE_PREFIX = 'graffiland_user_history_v1:';
const LEGACY_DESKTOP_SESSION_KEY = 'graffiland_desktop_session_v1';
const USER_HISTORY_EVENT = 'graffiland:user-history-updated';
const MAX_LAST_VIEWED = 25;
const MAX_ACTION_HISTORY = 60;

function normalizeScopeKey(userId) {
  const raw = String(userId || '').trim();
  return raw ? raw : 'guest';
}

function getStorageKey(userId) {
  return `${HISTORY_STORAGE_PREFIX}${normalizeScopeKey(userId)}`;
}

function readLegacyLastSculpture() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LEGACY_DESKTOP_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const snap = parsed?.lastSculptureSnapshot;
    if (!snap || !snap.id) return null;
    return {
      key: `sculpture:${snap.id}`,
      id: String(snap.id),
      kind: 'sculpture',
      title: String(snap.title || 'Sculpture'),
      subtitle: String(snap.landDisplayName || snap.parcelName || snap.parcelId || ''),
      parcelId: String(snap.parcelId || ''),
      sculptureId: String(snap.id),
      viewedAt: String(parsed?.updatedAt || snap.createdAt || new Date().toISOString()),
      snapshot: snap
    };
  } catch {
    return null;
  }
}

function readStore(userId) {
  const empty = { lastViewed: [], actions: [] };
  try {
    if (typeof localStorage === 'undefined') return empty;
    const raw = localStorage.getItem(getStorageKey(userId));
    if (!raw) {
      const legacy = readLegacyLastSculpture();
      return legacy ? { lastViewed: [legacy], actions: [] } : empty;
    }
    const parsed = JSON.parse(raw);
    const lastViewed = Array.isArray(parsed?.lastViewed) ? parsed.lastViewed : [];
    const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
    return { lastViewed, actions };
  } catch {
    return empty;
  }
}

function writeStore(userId, nextStore) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getStorageKey(userId), JSON.stringify(nextStore));
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      const CustomEvt = window.CustomEvent || globalThis.CustomEvent;
      if (typeof CustomEvt === 'function') {
        window.dispatchEvent(
          new CustomEvt(USER_HISTORY_EVENT, {
            detail: { scope: normalizeScopeKey(userId) }
          })
        );
      }
    }
  } catch {
    // ignore storage quota errors
  }
}

/**
 * Record a sculpture or virtual land viewed by the user.
 * Deduplicates by kind + id and bubbles the latest view to the top.
 */
export function recordLastViewedItem(userId, item) {
  if (!item) return [];
  const kind = item.kind === 'land' ? 'land' : 'sculpture';
  const rawId =
    kind === 'land'
      ? String(item.parcelId || item.id || '').trim()
      : String(item.sculptureId || item.id || '').trim();
  if (!rawId) return loadLastViewedItems(userId);

  const key = `${kind}:${rawId}`;
  const nowIso = item.viewedAt ? String(item.viewedAt) : new Date().toISOString();
  const entry = {
    key,
    id: rawId,
    kind,
    title: String(item.title || (kind === 'land' ? 'Virtual Land' : 'Sculpture')).slice(0, 80),
    subtitle: String(item.subtitle || '').slice(0, 120),
    parcelId: String(item.parcelId || (kind === 'land' ? rawId : '')),
    sculptureId: String(item.sculptureId || (kind === 'sculpture' ? rawId : '')),
    viewedAt: nowIso,
    snapshot: item.snapshot || null
  };

  const store = readStore(userId);
  const filtered = store.lastViewed.filter((existing) => existing?.key !== key);
  const nextViewed = [entry, ...filtered].slice(0, MAX_LAST_VIEWED);
  writeStore(userId, { ...store, lastViewed: nextViewed });
  return nextViewed;
}

/**
 * Record an interactive user action (minting, editing, sharing, viewing, buying, etc.)
 * into the user's chronological Action History.
 */
export function recordUserAction(userId, action) {
  if (!action || !action.title) return loadUserActionHistory(userId);
  const nowIso = action.createdAt ? String(action.createdAt) : new Date().toISOString();
  const type = String(action.type || 'action');
  const title = String(action.title).slice(0, 120);
  const detail = String(action.detail || '').slice(0, 200);
  const parcelId = String(action.parcelId || '');
  const sculptureId = String(action.sculptureId || '');

  const store = readStore(userId);
  // Avoid noisy duplicate back-to-back entries within 5 seconds for the exact same action
  const latest = store.actions[0];
  if (
    latest &&
    latest.type === type &&
    latest.title === title &&
    latest.parcelId === parcelId &&
    latest.sculptureId === sculptureId
  ) {
    const prevMs = Date.parse(String(latest.createdAt || ''));
    const curMs = Date.parse(nowIso);
    if (Number.isFinite(prevMs) && Number.isFinite(curMs) && Math.abs(curMs - prevMs) < 5000) {
      return store.actions;
    }
  }

  const entry = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    icon: String(action.icon || '⚡'),
    title,
    detail,
    parcelId,
    sculptureId,
    linkLabel: String(action.linkLabel || ''),
    createdAt: nowIso,
    source: 'local'
  };

  const nextActions = [entry, ...store.actions].slice(0, MAX_ACTION_HISTORY);
  writeStore(userId, { ...store, actions: nextActions });
  return nextActions;
}

export function loadLastViewedItems(userId) {
  return readStore(userId).lastViewed;
}

export function loadUserActionHistory(userId) {
  return readStore(userId).actions;
}

export function clearLastViewedItems(userId) {
  const store = readStore(userId);
  writeStore(userId, { ...store, lastViewed: [] });
}

export function clearUserActionHistory(userId) {
  const store = readStore(userId);
  writeStore(userId, { ...store, actions: [] });
}

export function subscribeUserHistory(listener) {
  if (typeof window === 'undefined' || typeof listener !== 'function') {
    return () => {};
  }
  const handler = () => listener();
  window.addEventListener(USER_HISTORY_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(USER_HISTORY_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
