export function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches;
  const shortestSide = Math.min(window.innerWidth || 0, window.innerHeight || window.innerWidth || 0);
  const narrowTouch = navigator.maxTouchPoints > 0 && shortestSide <= 1024;
  return Boolean(mobileUa || (coarsePointer && narrowTouch));
}

export function getWsUrl() {
  // @ts-expect-error Vite statically replaces literal import.meta.env.VITE_API_BASE during builds
  const rawApiBase = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_API_BASE : '';
  const apiBase = String(rawApiBase || '').trim();
  if (apiBase) {
    const parsed = new URL(apiBase);
    const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${parsed.host}/ws`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function getMobileLaunchUrl(pairCode = '') {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  if (pairCode) {
    url.searchParams.set('pair', pairCode);
  }
  return url.toString();
}
