const TOKEN_KEY = 'graffiland_jwt';
// @ts-expect-error Vite statically replaces literal import.meta.env.VITE_API_BASE during builds
const VITE_API_BASE_VALUE = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_API_BASE : '';
export const API_BASE = String(VITE_API_BASE_VALUE || '').replace(/\/$/, '');

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
    /** @type {any} */
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
    if (params.includeVoxels !== undefined) {
      qs.set('includeVoxels', params.includeVoxels ? '1' : '0');
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/sculptures${suffix}`);
  },
  getSculpture: (id) => request(`/api/sculptures/${encodeURIComponent(id)}`),
  transferSculpture: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/transfer`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  syncSculptureOwnership: (id) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/sync-ownership`, {
      method: 'POST',
      body: JSON.stringify({})
    }),
  getContractMetadata: () => request('/api/contract/metadata.json'),
  listParcels: () => request('/api/parcels'),
  publishSculpture: (payload) =>
    request('/api/sculptures/publish', { method: 'POST', body: JSON.stringify(payload) }),
  adminListSculptures: () => request('/api/admin/sculptures'),
  adminSetVisibility: (id, hidden, reason) =>
    request(`/api/admin/sculptures/${encodeURIComponent(id)}/visibility`, {
      method: 'POST',
      body: JSON.stringify({ hidden, reason })
    }),
  initSculptureChat: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/init`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  updateSculptureChatClue: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/clue`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  enterSculptureChat: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/enter`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  requestSculptureChatGrant: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/request-grant`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  claimClueChatGrant: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/claim-grant`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  listPendingChatGrants: () => request('/api/chat/pending-grants'),
  listSculpturePendingGrants: (id) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/pending-grants`),
  submitSculptureChatGrant: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/grants`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  postSculptureChatMessage: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/chat/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getAgentSpec: () => request('/api/agent/spec'),
  createAgentSession: (payload) =>
    request('/api/agent/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  getAgentSession: (code) =>
    request(`/api/agent/sessions/${encodeURIComponent(code)}`),
  listDrafts: () => request('/api/drafts'),
  getDraft: (id) => request(`/api/drafts/${encodeURIComponent(id)}`),
  saveDraft: (payload) =>
    request('/api/drafts', { method: 'POST', body: JSON.stringify(payload) }),
  deleteDraft: (id) =>
    request(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getMcpSpec: () => request('/api/mcp/spec'),
  listMcpPairings: () => request('/api/mcp/pairings'),
  createMcpPairing: (payload = {}) =>
    request('/api/mcp/pairings', { method: 'POST', body: JSON.stringify(payload) }),
  connectMcpPairing: (payload = {}) =>
    request('/api/mcp/pairings/connect', { method: 'POST', body: JSON.stringify(payload) }),
  disconnectMcpPairing: (code) =>
    request(`/api/mcp/pairings/${encodeURIComponent(code)}/disconnect`, {
      method: 'POST',
      body: JSON.stringify({})
    }),
  updateSculpture: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  deleteSculpture: (id) =>
    request(`/api/sculptures/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateLandParcel: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/update`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  createSculptureOnLand: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/sculptures`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  listPendingSignatures: () => request('/api/signatures/pending'),
  createPublishSignatureRequest: (payload) =>
    request('/api/signatures/requests', { method: 'POST', body: JSON.stringify(payload) }),
  getSignatureRequest: (id, pairingCode = '') =>
    request(
      `/api/signatures/requests/${encodeURIComponent(id)}${
        pairingCode ? `?pairingCode=${encodeURIComponent(pairingCode)}` : ''
      }`
    ),
  mobileSignRequest: (id, payload = {}) =>
    request(`/api/signatures/requests/${encodeURIComponent(id)}/mobile-sign`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  rejectSignatureRequest: (id) =>
    request(`/api/signatures/requests/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({})
    }),
  getSculpturePinMeta: (id) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/pins/meta`),
  getOwnerPinSeal: (id) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/pins/owner-seal`, {
      method: 'POST',
      body: JSON.stringify({})
    }),
  saveEncryptedPinBatch: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/pins/batch`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  issueParcelPinChallenge: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/pins/challenge`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  unlockPinnedIpfsBatch: (id, payload) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/pins/unlock`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getMyLands: () => request('/api/lands/mine'),
  updateLandSettings: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/settings`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  listLandContributors: (parcelId) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/contributors`),
  addLandContributor: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/contributors`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  removeLandContributor: (parcelId, contributorSub) =>
    request(
      `/api/lands/${encodeURIComponent(parcelId)}/contributors/${encodeURIComponent(contributorSub)}`,
      { method: 'DELETE' }
    ),
  eraseLand: (parcelId, payload = {}) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/erase`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getSculptureRevisions: (id) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/revisions`),
  rollbackSculptureRevision: (id, revNum) =>
    request(`/api/sculptures/${encodeURIComponent(id)}/revisions/${Number(revNum)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({})
    }),
  saveParcelLandmarkPack: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/landmark-pack`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  fetchParcelLandmarkPack: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/landmark-pack/fetch`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  updateLandSecurityPolicy: (parcelId, payload) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/security`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getPasskeyStatus: () => request('/api/passkeys/status'),
  getPasskeyRegistrationOptions: () =>
    request('/api/passkeys/register/options', {
      method: 'POST',
      body: JSON.stringify({})
    }),
  verifyPasskeyRegistration: (payload) =>
    request('/api/passkeys/register/verify', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  deletePasskey: (id) =>
    request(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getAdminMetrics: () => request('/api/admin/metrics'),
  scoutLands: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.lat !== undefined && params.lng !== undefined) {
      qs.set('lat', String(params.lat));
      qs.set('lng', String(params.lng));
    }
    if (params.radiusMeters !== undefined) qs.set('radiusMeters', String(params.radiusMeters));
    if (params.status) qs.set('status', params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/lands/scout${suffix}`);
  },
  getNearbyQuests: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.lat !== undefined && params.lng !== undefined) {
      qs.set('lat', String(params.lat));
      qs.set('lng', String(params.lng));
    }
    if (params.radiusMeters !== undefined) qs.set('radiusMeters', String(params.radiusMeters));
    if (params.status) qs.set('status', params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/quests/nearby${suffix}`);
  },
  getLandTelemetry: (parcelId) =>
    request(`/api/lands/${encodeURIComponent(parcelId)}/telemetry`),
  listMarketplaceListings: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.parcel) qs.set('parcel', params.parcel);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/marketplace/listings${suffix}`);
  },
  createMarketplaceListing: (payload) =>
    request('/api/marketplace/listings', { method: 'POST', body: JSON.stringify(payload) }),
  buyMarketplaceListing: (listingId, payload = {}) =>
    request(`/api/marketplace/listings/${encodeURIComponent(listingId)}/buy`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  getAgentLeaderboard: (limit = 25) =>
    request(`/api/agents/leaderboard?limit=${encodeURIComponent(String(limit))}`),
  getEconomySplits: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.parcel) qs.set('parcel', params.parcel);
    if (params.address) qs.set('address', params.address);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request(`/api/economy/splits${suffix}`);
  }
};
