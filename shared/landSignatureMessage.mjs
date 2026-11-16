const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizePairingCode(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('GLP-')) return cleaned;
  const bare = cleaned.replace(/-/g, '');
  if (bare.startsWith('GLP') && bare.length >= 15) {
    const rest = bare.slice(3);
    const groups = rest.match(/.{1,4}/g) || [];
    return `GLP-${groups.join('-')}`;
  }
  return cleaned;
}

export function isValidPairingCodeFormat(code) {
  const norm = normalizePairingCode(code);
  return /^GLP-[A-Z2-9]{4}(-[A-Z2-9]{4}){2,3}$/.test(norm);
}

export function generateRobustPairingCode() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const segs = [];
  for (let s = 0; s < 4; s += 1) {
    let seg = '';
    for (let i = 0; i < 4; i += 1) {
      seg += PAIR_ALPHABET[bytes[s * 4 + i] % PAIR_ALPHABET.length];
    }
    segs.push(seg);
  }
  return `GLP-${segs.join('-')}`;
}

export function generateRandomNonceHex(byteLen = 16) {
  const bytes = new Uint8Array(byteLen);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildPairingHandshakeMessage({ pairingCode, ownerAddress, nonce }) {
  return [
    'GRAFFILAND Robust MCP Pairing Authorization',
    `Pairing Code: ${normalizePairingCode(pairingCode)}`,
    `Owner Wallet: ${ownerAddress}`,
    `Challenge Nonce: ${nonce}`
  ].join('\n');
}

export function buildLandActivityMessage({
  requestId,
  action,
  parcelId,
  sculptureId = '',
  ownerAddress,
  payloadHash,
  nonce,
  expiresAt
}) {
  return [
    'GRAFFILAND Property & Land Activity Authorization',
    `Request ID: ${requestId}`,
    `Action: ${action}`,
    `Virtual Land: ${parcelId}`,
    ...(sculptureId ? [`Sculpture ID: ${sculptureId}`] : []),
    `Owner Wallet: ${ownerAddress}`,
    `Payload Hash: ${payloadHash}`,
    `Nonce: ${nonce}`,
    `Expires At: ${expiresAt}`
  ].join('\n');
}

export function buildPublishOnBehalfMessage({
  requestId,
  ownerAddress,
  parcelId,
  title,
  payloadHash,
  nonce,
  expiresAt
}) {
  return [
    'GRAFFILAND Agent-Assisted Publish & Mint Authorization',
    `Request ID: ${requestId}`,
    `Virtual Land: ${parcelId}`,
    `Title: ${title}`,
    `Owner Wallet: ${ownerAddress}`,
    `Payload Hash: ${payloadHash}`,
    `Nonce: ${nonce}`,
    `Expires At: ${expiresAt}`
  ].join('\n');
}

export function buildPropertyOwnerPrompt({
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev',
  pairingCode = '<YOUR_GLP_PAIRING_CODE>',
  ownerAddress = '<YOUR_WALLET_ADDRESS>',
  parcelId = '<YOUR_PARCEL_ID_OPTIONAL>'
} = {}) {
  const base = String(apiOrigin || 'https://graffiland-api.maxinfeld-artshow.workers.dev').replace(/\/$/, '');
  return [
    '# GRAFFILAND Property Owner & MCP Agent Prompt',
    '',
    `API Base URL: ${base}`,
    `Robust Pairing Code: ${pairingCode}`,
    `Owner EVM Wallet: ${ownerAddress}`,
    ...(parcelId && parcelId !== '<YOUR_PARCEL_ID_OPTIONAL>' ? [`Target Virtual Land Parcel: ${parcelId}`] : []),
    '',
    'Step 1 — Activate the MCP Service for this user (REQUIRED: MCP stays inactive until pairing connects):',
    `POST ${base}/api/mcp/pairings/connect`,
    `JSON body: { "pairingCode": "${pairingCode}", "agentName": "my-agent", "agentAddress": "${ownerAddress}" }`,
    '(If holding the owner private key, also compute EIP-191 signature over the returned `handshakeMessage` so key custody is marked live on both sides.)',
    '',
    'Step 2 — Discover MCP Tools (passes X-Graffiland-Pairing-Code):',
    `POST ${base}/api/mcp`,
    `Header: X-Graffiland-Pairing-Code: ${pairingCode}`,
    'JSON-RPC body: { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }',
    '',
    'Step 3 — Inspect Your Owned Lands, Sculptures & Any Pending Mobile/Agent Signatures:',
    '- Call MCP tool `list_my_lands` to view all Virtual Land parcels (`GLAND-...`) and sculptures you own.',
    '- Call MCP tool `get_land` with `{ "parcelId": "GLAND-..." }` to inspect blocks, bounds, curation, and Tx status.',
    '- Call MCP tool `list_pending_signatures` to see any user-staged publish/mint or property signature requests waiting for your agent.',
    '',
    'Step 4 — Edit Land / Place or Update Sculptures (0.05m 4x Voxel Grid · matte/neon/glass · max 4096 blocks):',
    '- Call MCP tool `put_sculpture_on_land` with `{ "parcelId", "title", "description", "voxels": [{ "x": 0, "y": 0, "z": 0, "color": "#00f5d4", "material": "neon", "scale": 1 }], "signature?": "0x..." }`',
    '- Call MCP tool `update_land_sculpture` with `{ "sculptureId", "title?", "description?", "voxels?", "signature?": "0x..." }`',
    '- Call MCP tool `update_land_parcel` with `{ "parcelId", "customName?", "curationNote?", "featuredSculptureId?", "signature?": "0x..." }`',
    '- Call MCP tool `delete_land_sculpture` with `{ "sculptureId", "signature?": "0x..." }`',
    'Signing Rules: If you hold the owner private key, sign `canonicalMessage` directly with EIP-191 (`wallet.signMessage(...)`) or submit via `sign_and_execute_pending` / `POST /api/signatures/requests/{requestId}/agent-sign`. If you do NOT hold the key, omit `signature`—the user\'s mobile app automatically receives a signature notification to approve or reject!',
    '',
    'Step 5 — Agent-Signed Publish on Behalf of User:',
    'When the user taps "Copy Prompt for Agent to Sign & Publish" on mobile, read `list_pending_signatures` (or the pasted `requestId` & `canonicalMessage`), sign `canonicalMessage` with the owner private key, and execute via MCP `sign_and_execute_pending` (or `POST /api/signatures/requests/{requestId}/agent-sign`).'
  ].join('\n');
}

export function buildAgentSignPublishPrompt({
  apiOrigin = '',
  pairingCode,
  requestId,
  parcelId,
  title,
  ownerAddress,
  canonicalMessage
}) {
  const base = String(apiOrigin || '').replace(/\/$/, '');
  return [
    'GRAFFILAND Agent Publish & Mint Signature Request',
    `Pairing Code: ${pairingCode}`,
    `Request ID: ${requestId}`,
    `Virtual Land Parcel: ${parcelId}`,
    `Title: ${title}`,
    `Expected Signer Wallet: ${ownerAddress}`,
    '',
    'Sign this exact EIP-191 canonical message with the owner private key (`wallet.signMessage(canonicalMessage)`):',
    '--- BEGIN CANONICAL MESSAGE ---',
    canonicalMessage,
    '--- END CANONICAL MESSAGE ---',
    '',
    `Submit signature via HTTP POST ${base}/api/signatures/requests/${requestId}/agent-sign`,
    `JSON body: { "pairingCode": "${pairingCode}", "signature": "0x<EIP191_SIGNATURE>", "agentName": "your-agent" }`,
    `Or call MCP JSON-RPC (${base}/api/mcp) tool \`sign_and_execute_pending\` with { "requestId": "${requestId}", "signature": "0x..." }.`
  ].join('\n');
}
