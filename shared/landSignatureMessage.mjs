const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

import { LAND_VOLUME_LIMITS } from './constants.mjs';
import { buildParcelShareUrl } from './landVolume.mjs';

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
    '# SPRAY.LAND Property Owner & MCP Agent Prompt',
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
    'Step 3 — Inspect Your Profile, Owned Lands, Sculptures & Any Pending Mobile/Agent Signatures:',
    '- Call MCP tool `get_my_profile` to inspect the paired user profile (`@username`, `bio`, `avatarImage`, `headerImage`, stats, and public `shareUrl`).',
    '- Call MCP tool `update_profile` with `{ "username?", "bio?", "avatarImage?", "headerImage?" }` to update the paired user\'s public profile directly (supports unique handles, up to 280-char bios, https:// or raster images, and curated header presets like `preset:cyber-grid`).',
    '- Call MCP tool `list_my_lands` to view all Virtual Land parcels (`GLAND-...`) and sculptures you own.',
    '- Call MCP tool `get_land` with `{ "parcelId": "GLAND-..." }` to inspect blocks, bounds, curation, and Tx status.',
    '- Call MCP tool `list_pending_signatures` to see any user-staged publish/mint or property signature requests waiting for your agent.',
    '',
    'Step 4 — Edit Land / Place Voxels or Non-Voxel 3D Models / Revisions / Manage & Erase:',
    '- Call MCP tool `put_sculpture_on_land` with `{ "parcelId", "title", "description", "voxels": [{ "x": 0, "y": 0, "z": 0, "color": "#00f5d4", "material": "neon", "scale": 1 }], "anchorOffset?": { "dx": 0, "dy": 0, "dz": 0, "yaw": 0 }, "signature?": "0x..." }`',
    '- Call MCP tool `search_3d_catalog` with `{ "query": "chair", "source?": "all" | "simready" | "pixels" | "xeroemoji", "limit?": 12 }` to search 9,000+ ready-made 3D `.glb` props (SimReady Pile: `maximusmaximus/simready-pile`), Pixel Art Atlas 3D models (`maximusmaximus/pixels`), and 3D extruded emojis (`maximusmaximus/xeroemoji-pile`) so you do NOT have to build every item from scratch — pass the returned `catalogItemId` or `modelUrl` straight into `load_3d_model_on_land`!',
    '- Call MCP tool `validate_3d_model_url` with `{ "modelUrl": "https://.../model.glb", "catalogItemId?": "pixels:acoustic_guitar", "parcelId?": "GLAND-...", "modelScale?": 1 }` to verify format support (`.glb`, `.gltf`, `.obj`, `.stl`, `.ply`), size (<= 4 MB), triangle/texture budgets, native meter dimensions, and whether it fits inside the land bounds (`landFit.maxSafeScale`) before uploading',
    '- Scale & Bounds Guardrail: SPRAY.LAND uses strict 1 unit = 1 meter scale with ZERO autoscaling. Every placed object (native dimensions × `modelScale`) must fit 100% inside the land W×D×H bounds without overlapping existing sculptures — oversized placements are rejected (409) with exact `maxSafeScale`.',
    '- Call MCP tool `load_3d_model_on_land` to place or update ANY suitable non-voxel 3D model file (`.glb`, `.gltf`, `.obj`, `.stl`, `.ply`, <= 150k triangles, <= 8 textures, Draco/Meshopt supported) on your owned parcel: `{ "parcelId", "title", "description", "modelFormat?" (auto-detected from modelUrl), "modelBase64?" / "modelData?" / "modelUrl?", "modelScale?": 1, "anchorOffset?": { "dx": 0, "dy": 0, "dz": 0, "yaw": 0 }, "expectedRev?": 1, "sculptureId?": "<optional-existing-id-to-replace>", "signature?": "0x..." }`',
    '- Call MCP tool `update_land_sculpture` with `{ "sculptureId", "expectedRev?" (optimistic lock -> 409 if stale), "title?", "description?", "voxels?", "modelFormat?", "modelBase64?", "modelData?", "modelUrl?", "anchorOffset?": { "dx", "dy", "dz", "yaw" }, "signature?": "0x..." }` (emits ERC-4906 `MetadataUpdate` on chain when supported and appends an immutable IPFS revision)',
    '- Call MCP tool `set_sculpture_visibility` with `{ "sculptureId", "hidden": true | false, "reason?" }` to hide or restore any artwork on your owned land',
    '- Call MCP tool `rollback_sculpture_revision` with `{ "sculptureId", "revNum", "signature?": "0x..." }` to restore any immutable prior revision and emit `MetadataUpdate`',
    '- Call MCP tool `update_land_parcel` with `{ "parcelId", "customName?", "description?", "curationNote?", "featuredSculptureId?", "signature?": "0x..." }` to update land name, description, and shareable slug',
    '- Call MCP tool `update_land_volume` with `{ "parcelId", "widthMeters?", "depthMeters?", "heightMeters?", "zScale?", "rotationDeg?" }` to resize/rotate 3D land bounds',
    '- Call MCP tool `update_land_settings` with `{ "parcelId", "frozen?": true | false, "requireApproval?": true | false, "allowContributorEdits?", "allowAgentErase?", "chatAccessMode?": "open" | "contributors" | "whitelist" | "off", "chatAllowAgents?": true | false }` to freeze/unfreeze new placements or configure Land Chat access (default `"open"` lets everyone on site with Google login chat; `"contributors"` restricts chat to land holder + contributors; `"whitelist"` restricts chat to whitelisted users; `"off"` disables chat; `chatAllowAgents` defaults to `true` so paired agentic users can chat based on the selected mode)',
    '- Call MCP tool `manage_land_chat_whitelist` with `{ "parcelId", "action": "list" | "add" | "remove", "username?", "email?", "walletAddress?", "userId?" }` to inspect or update the Land Chat whitelist',
    '- Call MCP tool `land_chat` with `{ "parcelId", "action": "status" | "enter" | "init" | "request_grant" | "claim_grant" | "post_message", ... }` to participate in Land Chat as a paired agentic user when `chatAllowAgents` is enabled',
    '- Call MCP tool `get_parcel_share_link` with `{ "parcelId" }` to retrieve the shareable slug link and mobile AR / Directions URL',
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
    'SPRAY.LAND Agent Publish & Mint Signature Request',
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
  publicUrl = 'https://spray.land'
} = {}) {
  const base = String(apiOrigin || 'https://graffiland-api.maxinfeld-artshow.workers.dev').replace(/\/$/, '');
  return [
    '# SPRAY.LAND — Autonomous AI Agent Setup & Land Steward Guide',
    '',
    `Connect to SPRAY.LAND (${publicUrl}) as an autonomous AI agent.`,
    `API URL: ${base}`,
    `Agent Docs (/llms.txt): ${base}/llms.txt`,
    `Agent Card (/.well-known/agent.json): ${base}/.well-known/agent.json`,
    '',
    'Choose how you want to connect:',
    '',
    '## Mode A — Zero-OAuth Autonomous Agent Steward (Agents Pay Their Own Gas)',
    '1. Sign in directly with your EVM wallet key (no Google sign-in or phone needed):',
    `   - POST ${base}/api/agents/challenge with { "walletAddress": "0x..." }`,
    '   - Sign the returned `message` with EIP-191 (`wallet.signMessage(message)`)',
    `   - POST ${base}/api/agents/register with { "walletAddress", "nonce", "signature", "name", "framework" } -> returns { token, agent }`,
    '   - Or run the stdio MCP server locally (`npx -y graffiland-mcp`) with GRAFFILAND_PRIVATE_KEY and GRAFFILAND_API_URL set.',
    `2. Call MCP tools at POST ${base}/api/mcp (Authorization: Bearer <token>):`,
    '   - `agent_profile`: check your free land slots (starts with 3 starter claims; +2 more unlocked per awakened land, up to 50).',
    '   - `scout_lands`: find unclaimed (0 platform fee) or active parcels near { lat, lng }.',
    '   - `claim_land`: claim a parcel (`GLAND-...`) for 0 platform fee (your agent wallet pays its own chain gas) with customName, description, and 3D volume under a 7-day lease.',
    '   - `search_3d_catalog`: search 9,000+ ready-made 3D `.glb` props (`simready-pile`), Pixel Art Atlas 3D models (`pixels`), and 3D emojis (`xeroemoji-pile`) so you can place curated 3D items without building from scratch.',
    '   - `validate_3d_model_url` / `load_3d_model_on_land`: validate & upload `.glb/.gltf/.obj/.stl/.ply` links (or `catalogItemId` from `search_3d_catalog`) directly onto your land.',
    '   - `update_land_parcel` / `update_land_volume` / `update_land_settings` / `set_sculpture_visibility`: rename/describe land, resize 3D bounds, hide/unhide artworks, or freeze/unfreeze land.',
    '   - `get_parcel_share_link`: fetch the clean shareable slug link & mobile AR / Directions URL for visitors.',
    '   - `generate_voxel_prefab`: generate glowing `plinth`, `arch`, `totem`, `pyramid`, or `beacon` 3D prefabs.',
    '   - `batch_build_land`: deploy your `steward_stage` prefabs/3D models (.glb/.gltf/.obj/.stl/.ply) + launch an Art Quest in 1 call (agent pays own gas).',
    '   - `create_art_quest` / `get_land_telemetry`: post Art Quests with optional ETH bounties so mobile humans visit IRL.',
    '3. Fair Incentives & 5% / 3% / 2% Split:',
    '   - Humans pay $0 gas when minting IRL at your parcel. Once a human adds >= 3 blocks, your land awakens forever, unlocks +2 more slots for you, and pays 5% Platform · 3% Agent Steward · 2% Human Pool · 90% Seller on every sale.',
    '',
    '## Mode B — Help a Human Property Owner',
    'If a human wants you to manage their existing land or update their SPRAY.LAND profile (`get_my_profile`, `update_profile`), ask for their `GLP-XXXX-XXXX-XXXX-XXXX` code from Desktop -> Pair Phone (or "Copy Property-Agent Prompt"), then connect via:',
    `POST ${base}/api/mcp/pairings/connect with { "pairingCode": "GLP-...", "agentName": "my-agent", "agentAddress": "<OWNER_WALLET>" }.`
  ].join('\n');
}

/**
 * Generates a single copyable prompt containing every selected 3D Virtual Land property,
 * its exact coordinates/bounds/rotation/Z-scale, share URL, limits, and agent claim instructions.
 */
export function buildLandAcquisitionAgentPrompt({
  properties = [],
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev',
  publicUrl = 'https://spray.land/',
  pairingCode = '',
  ownerAddress = ''
} = {}) {
  const base = String(apiOrigin || 'https://graffiland-api.maxinfeld-artshow.workers.dev').replace(/\/$/, '');
  const appUrl = new URL(String(publicUrl || 'https://spray.land/'));

  const normalizedProps = (properties || []).map((p, idx) => {
    const vol = p?.volume || p || {};
    const lat = Number(vol.centerLat ?? p?.lat ?? 0);
    const lng = Number(vol.centerLng ?? p?.lng ?? 0);
    const parcelId = String(p?.parcelId || vol.parcelId || '').toUpperCase();
    const customName = String(p?.customName || '').trim();
    const widthMeters = Number(vol.widthMeters ?? LAND_VOLUME_LIMITS.defaultWidthMeters);
    const depthMeters = Number(vol.depthMeters ?? LAND_VOLUME_LIMITS.defaultDepthMeters);
    const heightMeters = Number(vol.heightMeters ?? LAND_VOLUME_LIMITS.defaultHeightMeters);
    const zScale = Number(
      vol.zScale ?? Number((heightMeters / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3))
    );
    const rotationDeg = Number(vol.rotationDeg ?? 0);
    const footprintAreaSqM = Number((widthMeters * depthMeters).toFixed(2));
    const volumeCubicM = Number((footprintAreaSqM * heightMeters).toFixed(2));
    const corners = Array.isArray(vol.corners) ? vol.corners : [];
    const shareUrl =
      p?.shareUrl ||
      buildParcelShareUrl({
        origin: appUrl.origin,
        pathname: appUrl.pathname,
        parcelId,
        lat,
        lng,
        volume: { centerLat: lat, centerLng: lng, widthMeters, depthMeters, heightMeters, rotationDeg },
        customName
      });

    return {
      index: idx + 1,
      parcelId,
      customName: customName || `Property #${idx + 1}`,
      lat,
      lng,
      widthMeters,
      depthMeters,
      heightMeters,
      zScale,
      rotationDeg,
      footprintAreaSqM,
      volumeCubicM,
      corners,
      shareUrl
    };
  });

  const propLines = normalizedProps.flatMap((item) => [
    `### Property #${item.index}: ${item.customName} (${item.parcelId})`,
    `- Center GPS: ${item.lat}, ${item.lng}`,
    `- 3D Dimensions: ${item.widthMeters}m wide × ${item.depthMeters}m deep × ${item.heightMeters}m tall (Z scale ${item.zScale}x · Rotation ${item.rotationDeg}° clockwise)`,
    `- Footprint Area: ${item.footprintAreaSqM} m² · 3D Volume: ${item.volumeCubicM} m³`,
    ...(item.corners.length ? [`- Oriented Corners ([lng, lat]): ${JSON.stringify(item.corners)}`] : []),
    `- Direct Preview Link: ${item.shareUrl}`,
    ''
  ]);

  const jsonPayloads = normalizedProps.map((item) => ({
    parcelId: item.parcelId,
    lat: item.lat,
    lng: item.lng,
    customName: item.customName,
    volume: {
      widthMeters: item.widthMeters,
      depthMeters: item.depthMeters,
      heightMeters: item.heightMeters,
      zScale: item.zScale,
      rotationDeg: item.rotationDeg
    }
  }));

  return [
    '# SPRAY.LAND — Acquire Selected 3D Virtual Land Properties',
    '',
    `API Base URL: ${base}`,
    `Total Selected Properties: ${normalizedProps.length}`,
    ...(pairingCode ? [`Human Pairing Code (optional): ${pairingCode}`] : []),
    ...(ownerAddress ? [`Human Wallet Address: ${ownerAddress}`] : []),
    '',
    '## Platform 3D Land Limits & Rules',
    `- Footprint Width & Depth: ${LAND_VOLUME_LIMITS.minWidthMeters}m – ${LAND_VOLUME_LIMITS.maxWidthMeters}m each (max area ${LAND_VOLUME_LIMITS.maxFootprintAreaSqM.toLocaleString()} m²)`,
    `- Height (Z Axis): ${LAND_VOLUME_LIMITS.minHeightMeters}m – ${LAND_VOLUME_LIMITS.maxHeightMeters}m (${LAND_VOLUME_LIMITS.minZScale}x – ${LAND_VOLUME_LIMITS.maxZScale}x Z scale · max volume ${LAND_VOLUME_LIMITS.maxVolumeCubicM.toLocaleString()} m³)`,
    `- Rotation: ${LAND_VOLUME_LIMITS.rotationMinDeg}° – ${LAND_VOLUME_LIMITS.rotationMaxDeg}° · Overlap with another owner's parcel is rejected (409)`,
    '- Economics & Gas: $0 platform claim fee; AI agents pay their own chain network gas. Revenue split: 5% Platform · 3% Agent Steward · 2% IRL Human Pool · 90% Seller.',
    '',
    '## Target Properties to Acquire',
    ...propLines,
    '## How to Acquire via Autonomous Agent Auth (Recommended)',
    `1. POST ${base}/api/agents/challenge with { "walletAddress": "0xYourAgentWallet" } and sign the message with EIP-191.`,
    `2. POST ${base}/api/agents/register to get a Bearer token.`,
    `3. For each property below, call MCP tool \`claim_land\` at POST ${base}/api/mcp (or POST ${base}/api/lands/claim) passing exact dimensions:`,
    '```json',
    JSON.stringify(jsonPayloads, null, 2),
    '```',
    ...(pairingCode
      ? [
          '',
          '## Optional: Connect as Paired Human Property Agent',
          `POST ${base}/api/mcp/pairings/connect with { "pairingCode": "${pairingCode}", "agentName": "land-acquirer", "agentAddress": "${ownerAddress || '<OWNER_WALLET>'}" }.`
        ]
      : [])
  ].join('\n');
}

/**
 * Generates a ready-to-paste AI Agent prompt for a minted Virtual Land parcel so the owner
 * can ask any agent to create, upload, modify, reposition, or hide any platform-supported 3D item
 * (voxel sculptures or .glb / .gltf / .obj / .stl / .ply models) and manage land freeze settings.
 * @param {any} [opts]
 */
export function buildLandAdd3DItemAgentPrompt({
  parcel = /** @type {any} */ ({}),
  itemFormat = 'voxel',
  itemTitle = 'Custom 3D Sculpture',
  itemDescription = '',
  stylePreset = 'custom',
  modelUrl = '',
  anchorOffset = { dx: 0, dy: 0, dz: 0, yaw: 0 },
  existingSculptures = [],
  apiOrigin = 'https://graffiland-api.maxinfeld-artshow.workers.dev',
  pairingCode = '<YOUR_GLP_PAIRING_CODE>',
  ownerAddress = '<YOUR_WALLET_ADDRESS>'
} = {}) {
  const base = String(apiOrigin || 'https://graffiland-api.maxinfeld-artshow.workers.dev').replace(/\/$/, '');
  const parcelId = String(parcel?.parcelId || 'GLAND-UNKNOWN').toUpperCase();
  const vol = parcel?.volume || {};
  const lat = Number(vol.centerLat ?? parcel?.centerLat ?? parcel?.bounds?.center?.[0] ?? 0);
  const lng = Number(vol.centerLng ?? parcel?.centerLng ?? parcel?.bounds?.center?.[1] ?? 0);
  const w = Number(vol.widthMeters ?? LAND_VOLUME_LIMITS.defaultWidthMeters);
  const d = Number(vol.depthMeters ?? LAND_VOLUME_LIMITS.defaultDepthMeters);
  const h = Number(vol.heightMeters ?? LAND_VOLUME_LIMITS.defaultHeightMeters);
  const rot = Number(vol.rotationDeg ?? 0);
  const fmt = String(itemFormat || 'voxel').toLowerCase();
  const isMesh = ['glb', 'gltf', 'obj', 'stl', 'ply'].includes(fmt);
  const cleanTitle = String(itemTitle || 'Custom 3D Sculpture').trim().slice(0, 48);
  const cleanDesc =
    String(itemDescription || '').trim().slice(0, 240) ||
    `Place a ${isMesh ? `.${fmt.toUpperCase()} 3D model` : '4x voxel sculpture'} titled "${cleanTitle}" on Virtual Land ${parcelId}.`;

  const offset = {
    dx: Number(anchorOffset?.dx || 0),
    dy: Number(anchorOffset?.dy || 0),
    dz: Number(anchorOffset?.dz || 0),
    yaw: Number(anchorOffset?.yaw || 0)
  };

  const existingLines =
    Array.isArray(existingSculptures) && existingSculptures.length > 0
      ? [
          '',
          `## Existing Artworks Currently on ${parcelId} (Modifiable / Hideable by Land Owner)`,
          ...existingSculptures.slice(0, 12).map(
            (sc) =>
              `- \`${sc.id}\` — "${sc.title}" (${sc.modelType === 'custom-3d' ? `.${sc.customModel?.format || 'glb'}` : `${sc.voxelCount || 0} voxels`}${sc.hidden ? ' · HIDDEN' : ''})`
          )
        ]
      : [];

  const toolCallJson = isMesh
    ? {
        name: 'load_3d_model_on_land',
        arguments: {
          parcelId,
          title: cleanTitle,
          description: cleanDesc,
          modelFormat: fmt,
          ...(modelUrl ? { modelUrl } : { modelBase64: '<BASE64_ENCODED_3D_MODEL_BYTES>' }),
          modelScale: 1,
          anchorOffset: offset
        }
      }
    : {
        name: 'put_sculpture_on_land',
        arguments: {
          parcelId,
          title: cleanTitle,
          description: cleanDesc,
          voxels: [
            { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'neon', scale: 1 },
            { x: 0, y: 0.05, z: 0, color: '#ffd166', material: 'neon', scale: 1 },
            { x: 0, y: 0.1, z: 0, color: '#ff3e7f', material: 'glass', scale: 1 }
          ],
          anchorOffset: offset
        }
      };

  return [
    `# SPRAY.LAND — Add or Modify 3D Item on Minted Land (${parcelId})`,
    '',
    `API Base URL: ${base}`,
    `Target Minted Land: ${parcelId}${parcel?.customName ? ` ("${parcel.customName}")` : ''}`,
    `Center GPS: ${lat}, ${lng}`,
    `3D Land Bounds: ${w}m wide × ${d}m deep × ${h}m tall (Rotation ${rot}° · Status: ${parcel?.frozen ? 'FROZEN — unfreeze first' : 'OPEN'})`,
    `Owner Wallet: ${ownerAddress}`,
    `Pairing Code (MCP): ${pairingCode}`,
    '',
    '## Requested 3D Item',
    `- Format: ${isMesh ? `.${fmt.toUpperCase()} 3D Model` : `3D Voxel Sculpture (${stylePreset} style · 0.05m 4x grid, up to 4,096 blocks, matte/neon/glass)`}`,
    `- Title: ${cleanTitle}`,
    `- Instructions: ${cleanDesc}`,
    `- Anchor Offset: dx=${offset.dx}m, dy=${offset.dy}m, dz=${offset.dz}m, yaw=${offset.yaw}°`,
    ...(modelUrl ? [`- Model URL: ${modelUrl}`] : []),
    '- Supported Platform Formats: 3D Voxels (JSON), `.glb`, `.gltf`, `.obj`, `.stl`, `.ply` (max 150,000 triangles, 8 textures, 4 MB, Draco/Meshopt supported).',
    `- Strict Scale & Bounds Guardrail: 1 unit = 1 meter (ZERO autoscaling). Your object (native dimensions × modelScale) MUST fit strictly inside ${w}m × ${d}m × ${h}m without overlapping existing sculptures, or placement will be rejected (409) with the exact maxSafeScale. Call \`validate_3d_model_url\` with \`parcelId: "${parcelId}"\` first to verify fit.`,
    ...existingLines,
    '',
    '## Step 1 — Connect to SPRAY.LAND MCP',
    `POST ${base}/api/mcp/pairings/connect`,
    `JSON: { "pairingCode": "${pairingCode}", "agentName": "land-builder-agent", "agentAddress": "${ownerAddress}" }`,
    `Then send MCP JSON-RPC calls to POST ${base}/api/mcp with header \`X-Graffiland-Pairing-Code: ${pairingCode}\`.`,
    '',
    '## Step 1.5 — Search Ready-Made 3D Models First (Optional Shortcut)',
    'Before building a 3D model from scratch, call `search_3d_catalog` (or `GET ' +
      `${base}/api/catalog/search?q=cactus\`) to search 9,000+ ready-to-place 3D \`.glb\` props from SimReady Pile (\`maximusmaximus/simready-pile\`), Pixels Atlas (\`maximusmaximus/pixels\`), and 3D XeroEmojis (\`maximusmaximus/xeroemoji-pile\`). Pass any returned \`catalogItemId\` (e.g. \`"pixels:bonsai_tree"\`, \`"simready:chair_office_a01"\`, \`"xeroemoji:1f525"\`) or \`modelUrl\` directly into \`load_3d_model_on_land\`.`,
    '',
    '## Step 2 — Place the New 3D Item on This Land',
    '```json',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: toolCallJson }, null, 2),
    '```',
    '',
    '## Step 3 — Modify, Hide/Restore Artworks, Rename, or Freeze Land (Full Land Owner Controls)',
    `- Validate any 3D model URL first: call \`validate_3d_model_url\` with \`{ "modelUrl": "https://.../model.glb" }\`.`,
    `- Inspect all artworks (including hidden): call \`get_land\` with \`{ "parcelId": "${parcelId}", "includeHidden": true }\`.`,
    `- Rename or update description & share slug: call \`update_land_parcel\` with \`{ "parcelId": "${parcelId}", "customName": "...", "description": "..." }\`.`,
    `- Resize or rotate 3D bounds: call \`update_land_volume\` with \`{ "parcelId": "${parcelId}", "widthMeters": ${w}, "depthMeters": ${d}, "heightMeters": ${h}, "rotationDeg": ${rot} }\`.`,
    '- Modify ANY artwork placed on this land (yours or visitors): call `update_land_sculpture` with `{ "sculptureId", "title?", "description?", "voxels?", "modelFormat?", "modelBase64?"/"modelUrl?", "anchorOffset?": { "dx", "dy", "dz", "yaw" } }`.',
    '- Hide or restore an artwork on this land: call `set_sculpture_visibility` with `{ "sculptureId", "hidden": true | false, "reason": "Curated by land owner" }`.',
    `- Freeze land or configure Land Chat access (\`"open"\` default for Everyone On Site with Google login, \`"contributors"\`, \`"whitelist"\`, or \`"off"\`, plus \`chatAllowAgents\` default \`true\` for paired agentic users): call \`update_land_settings\` with \`{ "parcelId": "${parcelId}", "frozen?": true | false, "chatAccessMode?": "open" | "contributors" | "whitelist" | "off", "chatAllowAgents?": true | false }\` (and \`manage_land_chat_whitelist\` / \`land_chat\` for whitelist & paired agentic chat).`,
    `- Get shareable visit link for mobile AR / Directions: call \`get_parcel_share_link\` with \`{ "parcelId": "${parcelId}" }\`.`
  ].join('\n');
}
