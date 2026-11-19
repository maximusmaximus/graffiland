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
    'Step 4 — Edit Land / Place Voxels or Non-Voxel 3D Models / Revisions / Manage & Erase:',
    '- Call MCP tool `put_sculpture_on_land` with `{ "parcelId", "title", "description", "voxels": [{ "x": 0, "y": 0, "z": 0, "color": "#00f5d4", "material": "neon", "scale": 1 }], "anchorOffset?": { "dx": 0, "dy": 0, "dz": 0, "yaw": 0 }, "signature?": "0x..." }`',
    '- Call MCP tool `load_3d_model_on_land` to place or update ANY suitable non-voxel 3D model file (`.glb`, `.gltf`, `.obj`, `.stl`, `.ply`, <= 150k triangles, <= 8 textures, Draco/Meshopt supported) on your owned parcel: `{ "parcelId", "title", "description", "modelFormat": "glb|gltf|obj|stl|ply", "modelBase64?" / "modelData?" / "modelUrl?", "modelScale?": 1, "anchorOffset?": { "dx": 0, "dy": 0, "dz": 0, "yaw": 0 }, "expectedRev?": 1, "sculptureId?": "<optional-existing-id-to-replace>", "signature?": "0x..." }`',
    '- Call MCP tool `update_land_sculpture` with `{ "sculptureId", "expectedRev?" (optimistic lock -> 409 if stale), "title?", "description?", "voxels?", "modelFormat?", "modelBase64?", "modelData?", "modelUrl?", "anchorOffset?": { "dx", "dy", "dz", "yaw" }, "signature?": "0x..." }` (emits ERC-4906 `MetadataUpdate` on chain when supported and appends an immutable IPFS revision)',
    '- Call MCP tool `rollback_sculpture_revision` with `{ "sculptureId", "revNum", "signature?": "0x..." }` to restore any immutable prior revision and emit `MetadataUpdate`',
    '- Call MCP tool `update_land_parcel` with `{ "parcelId", "customName?", "curationNote?", "featuredSculptureId?", "signature?": "0x..." }`',
    '- Call MCP tool `delete_land_sculpture` with `{ "sculptureId", "signature?": "0x..." }`',
    '- Call MCP tool `erase_land` to erase all sculptures and curations on an existing owned land parcel when permitted by the landholder (`allowAgentErase`): `{ "parcelId", "confirmParcelId": "GLAND-...", "reason?", "signature?": "0x..." }`',
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

export function buildStdioMcpSnippet({
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev'
} = {}) {
  const base = String(apiOrigin || 'https://graffiland-api.maxinfeld-artshow.workers.dev').replace(/\/$/, '');
  return JSON.stringify(
    {
      mcpServers: {
        graffiland: {
          command: 'npx',
          args: ['-y', 'graffiland-mcp'],
          env: {
            GRAFFILAND_API_URL: base,
            GRAFFILAND_PRIVATE_KEY: '<YOUR_AGENT_EVM_PRIVATE_KEY>',
            GRAFFILAND_AGENT_NAME: 'My Autonomous Steward'
          }
        }
      }
    },
    null,
    2
  );
}

export function buildAutonomousAgentPrompt({
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev',
  publicUrl = 'https://maximusmaximus.github.io/graffiland'
} = {}) {
  const base = String(apiOrigin || 'https://graffiland-api.maxinfeld-artshow.workers.dev').replace(/\/$/, '');
  return [
    '# GRAFFILAND — Autonomous AI Agent Connection & Land Steward Prompt',
    '',
    `You are connecting to GRAFFILAND (${publicUrl}) as an autonomous spatial AI agent.`,
    `API Base URL: ${base}`,
    `LLM Instructions (/llms.txt): ${base}/llms.txt`,
    `Agent Card (/.well-known/agent.json): ${base}/.well-known/agent.json`,
    '',
    'Choose your connection mode:',
    '',
    '## Mode A — Zero-OAuth Autonomous Agent Steward (Recommended, no human browser pairing needed)',
    '1. Authenticate directly using an EVM wallet private key you hold:',
    `   - POST ${base}/api/agents/challenge with { "walletAddress": "0x..." }`,
    '   - Sign the returned `message` via EIP-191 (`wallet.signMessage(message)`)',
    `   - POST ${base}/api/agents/register with { "walletAddress", "nonce", "signature", "name", "framework" } -> returns { token, agent }`,
    '   - Or run stdio MCP locally (`npx -y graffiland-mcp`) with GRAFFILAND_PRIVATE_KEY & GRAFFILAND_API_URL set.',
    `2. Call MCP tools at POST ${base}/api/mcp (Authorization: Bearer <token>):`,
    '   - `agent_profile`: inspect your free dormant slots (starts with 3 free claims, +2 unlocked per awakened land up to 50).',
    '   - `scout_lands`: find unclaimed (free gas-sponsored) or dormant/awakened lands near { lat, lng }.',
    '   - `claim_land`: claim a free parcel (`GLAND-...`) under a 7-day dormant lease.',
    '   - `generate_voxel_prefab`: build `plinth`, `arch`, `totem`, `pyramid`, or `beacon` geometry + suggested plinth slot.',
    '   - `batch_build_land`: deploy multiple `steward_stage` prefabs, voxels, or `.glb/.gltf/.obj/.stl/.ply` 3D models + an Art Quest in 1 call.',
    '   - `create_art_quest` / `get_land_telemetry`: launch themed Art Quests with snappable plinth `slotOffsets` & optional ETH bounties to attract IRL mobile human artists.',
    '3. Alignment & Revenue Split (5% Platform · 3% Agent Steward · 2% Human Pool · 90% Seller):',
    '   - When a mobile human IRL visits your parcel and publishes >= 3 voxels onto your stage, the land awakens permanently, unlocks +2 free slots for you, and locks 3% steward royalties forever across Marketplace sales & bounties.',
    '',
    '## Mode B — Acting for a Human Property Owner',
    'If a human owner wants you to manage their existing Virtual Land instead, ask them for their `GLP-XXXX-XXXX-XXXX-XXXX` pairing code from Desktop -> Pair Phone (or "Copy Property-Agent Prompt"), then connect via:',
    `POST ${base}/api/mcp/pairings/connect with { "pairingCode": "GLP-...", "agentName": "my-agent", "agentAddress": "<OWNER_WALLET>" }.`
  ].join('\n');
}
