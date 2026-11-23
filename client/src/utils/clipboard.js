import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';

export const LOCAL_DRAFT_KEY = 'graffiland_studio_draft_v1';
export const TUTORIAL_SEEN_KEY = 'graffiland_studio_tutorial_v1';
export const QUICK_SCULPT_KEY = 'graffiland_quick_sculpt_v1';
export const WELCOME_OVERLAY_SEEN_KEY = 'graffiland_first_visit_welcome_seen_v1';
export const DIRECT_LINK_INTRO_SEEN_KEY = 'graffiland_direct_link_intro_seen_v1';

export function loadLocalDraft() {
  try {
    const raw = localStorage.getItem(LOCAL_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLocalDraft(draft) {
  try {
    localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // ignore storage quota errors on restricted modes
  }
}

export function clearLocalDraft() {
  try {
    localStorage.removeItem(LOCAL_DRAFT_KEY);
  } catch {
    // ignore
  }
}

export function loadBoolPreference(key, defaultValue = false) {
  try {
    const val = localStorage.getItem(key);
    if (val === '1') return true;
    if (val === '0') return false;
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

export function saveBoolPreference(key, val) {
  try {
    localStorage.setItem(key, val ? '1' : '0');
  } catch {
    // ignore
  }
}

export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function buildSculptureShareUrl(sculptureId) {
  if (typeof window === 'undefined' || !sculptureId) return '';
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('sculpture', sculptureId);
  return url.toString();
}

export function buildShareToXUrl({
  title = '3D Sculpture',
  landName = '',
  parcelName = '',
  sculptureId = ''
} = {}) {
  const shareUrl = buildSculptureShareUrl(sculptureId);
  const resolvedLand = resolveLandDisplayName(
    { customName: landName || parcelName || '' },
    { defaultName: 'GRAFFILAND' }
  );
  const text = `Check out "${title}" anchored on "${resolvedLand}" in 3D AR on GRAFFILAND!`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`;
}
