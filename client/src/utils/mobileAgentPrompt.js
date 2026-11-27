import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { API_BASE } from './api.js';

const DEFAULT_API_ORIGIN = 'https://graffiland-api.maxinfeld-artshow.workers.dev';
const DEFAULT_PUBLIC_URL = 'https://spray.land';

function normalizeOrigin(raw, fallback) {
  const clean = String(raw || '').trim().replace(/\/+$/, '');
  return clean || fallback;
}

/**
 * Builds a complete, human-parity AI Agent prompt tailored to the user's current
 * mobile location and whether they are standing inside an existing Virtual Land
 * or on an unclaimed spot ready to claim a new land.
 */
export function buildMobileLocationAgentPrompt({
  location = null,
  activeLand = null,
  agentSession = null,
  pairingCode = '',
  apiOrigin = '',
  publicUrl = ''
} = {}) {
  const origin = normalizeOrigin(
    apiOrigin || API_BASE || (typeof window !== 'undefined' ? window.location?.origin : ''),
    DEFAULT_API_ORIGIN
  );
  const appUrl = normalizeOrigin(
    publicUrl || (typeof window !== 'undefined' ? window.location?.origin : ''),
    DEFAULT_PUBLIC_URL
  );

  const hasCoords =
    Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng));
  const lat = hasCoords ? Number(location.lat).toFixed(6) : null;
  const lng = hasCoords ? Number(location.lng).toFixed(6) : null;
  const alt =
    hasCoords && Number.isFinite(Number(location?.altitude))
      ? `${Math.round(Number(location.altitude) * 10) / 10}m`
      : null;

  const isOnExistingLand = Boolean(activeLand?.parcelId);
  const landId = String(activeLand?.parcelId || agentSession?.parcelId || '').toUpperCase();
  const landName = isOnExistingLand
    ? resolveLandDisplayName(activeLand, { defaultName: 'Virtual Land' })
    : '';
  const landUrl = landId ? `${appUrl}/?parcel=${encodeURIComponent(landId)}` : appUrl;

  const sessionCode = String(agentSession?.code || '').trim();
  const sessionUrl =
    agentSession?.endpoints?.session ||
    (sessionCode ? `${origin}/api/agent/sessions/${sessionCode}` : '');
  const submitUrl =
    agentSession?.endpoints?.submitSculpture ||
    (sessionCode ? `${origin}/api/agent/sessions/${sessionCode}/sculpture` : '');
  const specUrl = agentSession?.endpoints?.spec || `${origin}/api/agent/spec`;

  const lines = [
    '# SPRAY.LAND — Mobile Location AI Agent Handoff',
    '',
    isOnExistingLand
      ? `You are acting at my current location INSIDE existing 3D Virtual Land "${landName}" (${landId}).`
      : 'You are acting at my current real-world location on SPRAY.LAND (unclaimed / open space).',
    hasCoords
      ? `GPS Coordinates: ${lat}, ${lng}${alt ? ` (Altitude ${alt})` : ''}${landId ? ` · Parcel ${landId}` : ''}`
      : 'GPS Coordinates: Waiting for live GPS lock (ask me for coordinates or call scout_lands).',
    `View Land / World: ${landUrl}`,
    `API / MCP Endpoint: ${origin}/api/mcp`,
    `Agent Docs: ${origin}/llms.txt · Agent Card: ${origin}/.well-known/agent.json`
  ];

  if (sessionCode) {
    lines.push(`Location-Locked Sculpture Session Code: ${sessionCode}`);
  }
  if (pairingCode) {
    lines.push(`Paired Account Connector Code: ${pairingCode}`);
  }

  lines.push('', '## What You Can Do Here (Full Human + Agent Capabilities)');

  if (isOnExistingLand) {
    lines.push(
      `1. **Add Art or 3D Models to "${landName}" (${landId})**:`,
      '   - Search 10,000+ ready-made 3D GLB models & emojis first using MCP `search_3d_catalog` (`simready-pile`, `pixels`, `xeroemoji-pile`), then place via `load_3d_model_on_land` with `parcelId: "' +
        landId +
        '"` and `catalogItemId`.',
      '   - Or build a custom voxel sculpture (or prefab via `generate_voxel_prefab`) and stage it to this session so I can inspect & publish in AR.',
      '2. **Engage With This Land Like a Human**:',
      `   - Inspect existing artworks, quests, and parcel details via \`get_land_telemetry\` / \`GET ${origin}/api/lands/${encodeURIComponent(landId)}\`.`,
      '   - Check Art Quests, collaborate on this land, check marketplace status (buy/offer/list), or interact with land settings if paired as steward/owner.'
    );
  } else {
    lines.push(
      '1. **Claim a New 3D Virtual Land Here**:',
      hasCoords
        ? `   - Call MCP \`scout_lands\` around \`{ "lat": ${lat}, "lng": ${lng} }\` to verify this spot is unclaimed, then call \`claim_land\` (0 platform fee; agent wallet pays its own chain gas) with a customName, description, and 3D volume.`
        : '   - Call MCP `scout_lands` to find an unclaimed parcel at my spot, then call `claim_land` (0 platform fee) with customName, description, and 3D volume.',
      '   - Search 10,000+ ready-made 3D GLB models & emojis using `search_3d_catalog` (`simready-pile`, `pixels`, `xeroemoji-pile`) and deploy a showcase with `load_3d_model_on_land` or `batch_build_land` (prefabs + 3D models + Art Quest in 1 call).',
      '2. **Stage Art Directly for My Phone / Engage Like a Human**:',
      '   - Stage a 3D voxel sculpture right at my current spot so I can inspect and mint it in AR with $0 gas, or scout & engage with nearby lands, quests, and artworks.'
    );
  }

  lines.push(
    '',
    '## Connect & Authenticate',
    `- **Autonomous Wallet / MCP**: Sign EIP-191 challenge at \`POST ${origin}/api/agents/challenge\` -> \`POST ${origin}/api/agents/register\`, or run \`npx -y graffiland-mcp\` with \`GRAFFILAND_API_URL=${origin}\` and \`GRAFFILAND_PRIVATE_KEY\`.`
  );

  if (pairingCode) {
    lines.push(
      `- **Owner Pairing**: Connect with \`POST ${origin}/api/mcp/pairings/connect\` using \`{ "pairingCode": "${pairingCode}", "agentName": "my-agent" }\`.`
    );
  }

  if (sessionCode && sessionUrl && submitUrl) {
    lines.push(
      '',
      `## Direct Session Staging (Code: ${sessionCode})`,
      `- Inspect 3D voxel tools, 12 colors, materials (matte/neon/glass), and bounds: \`GET ${sessionUrl}\` and \`GET ${specUrl}\``,
      `- Stage a 3D sculpture here for me to inspect & publish in AR: \`POST ${submitUrl}\``,
      '  JSON body: `{ "agentName": "your-agent", "title": "...", "description": "...", "voxels": [{ "x": 0, "y": 0, "z": 0, "color": "#00f5d4", "material": "neon", "scale": 1 }] }`'
    );
  }

  return lines.join('\n');
}
