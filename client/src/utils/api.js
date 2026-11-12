const TOKEN_KEY = 'graffiland_jwt';
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export function resolveApiUrl(pathOrUrl) {
  if (!pathOrUrl) return '';
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE}${pathOrUrl}`;
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(url, options = {}) {
  const token = getStoredToken();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(resolveApiUrl(url), { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  getConfig: () => request('/api/config'),
  loginWithGoogle: (payload) =>
    request('/api/auth/google', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => request('/api/auth/me'),
  setPayoutAddress: (address) =>
    request('/api/wallet/payout', { method: 'POST', body: JSON.stringify({ address }) }),
  exportWalletKey: () => request('/api/wallet/export'),
  listSculptures: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.lat !== undefined && params.lng !== undefined) {
      qs.set('lat', String(params.lat));
      qs.set('lng', String(params.lng));
    }
    if (params.radiusMeters !== undefined) qs.set('radiusMeters', String(params.radiusMeters));
    if (params.parcel) qs.set('parcel', params.parcel);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/sculptures${suffix}`);
  },
  getSculpture: (id) => request(`/api/sculptures/${encodeURIComponent(id)}`),
  listParcels: () => request('/api/parcels'),
  publishSculpture: (payload) =>
    request('/api/sculptures/publish', { method: 'POST', body: JSON.stringify(payload) }),
  adminListSculptures: () => request('/api/admin/sculptures'),
  adminSetVisibility: (id, hidden, reason) =>
    request(`/api/admin/sculptures/${encodeURIComponent(id)}/visibility`, {
      method: 'POST',
      body: JSON.stringify({ hidden, reason })
    })
};
