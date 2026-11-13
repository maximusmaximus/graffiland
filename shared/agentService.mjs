import {
  AREA_HALF_SPAN_METERS,
  AREA_LIMIT_BLOCKS,
  GRAFFITI_PALETTE,
  POLICY,
  VOXEL_MATERIALS,
  VOXEL_RESOLUTION_SCALE,
  VOXEL_STEP
} from './constants.mjs';
import { sanitizeVoxels } from '../server/services/moderation.mjs';
import { encodeGeohash } from '../server/services/pol.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PALETTE_NAMES = {
  '#00f5d4': 'Cyber Mint / Cyan',
  '#ff3e7f': 'Neon Magenta',
  '#ffd166': 'Solar Gold',
  '#7b2cbf': 'Ultraviolet Purple',
  '#00bbf9': 'Electric Azure',
  '#ff6b35': 'Flare Orange',
  '#80ff72': 'Acid Lime',
  '#ffffff': 'Pure White',
  '#ff0054': 'Laser Crimson',
  '#3a86ff': 'Cobalt Blue',
  '#f15bb5': 'Plasma Pink',
  '#1b263b': 'Deep Obsidian'
};

class AgentServiceError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function generateSessionCode() {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = 'GRF-';
  for (let i = 0; i < bytes.length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function buildAgentSpec(apiOrigin = '') {
  const base = String(apiOrigin || '').replace(/\/$/, '');
  return {
    name: 'GRAFFILAND 3D Agent Sculptor Specification',
    version: '2026-11-12.v2',
    resolution: {
      scaleFactor: VOXEL_RESOLUTION_SCALE,
      voxelStepMeters: VOXEL_STEP,
      blockWidthMeters: Number((VOXEL_STEP * 0.96).toFixed(4)),
      coordinateUnit: 'meters',
      notes:
        '4x higher spatial resolution than original 0.2m blocks. Snap voxel coordinates to multiples of 0.05m (e.g. -0.1, 0, 0.05, 0.15). +X = East, +Y = Up, -Z = Forward/North relative to sculpture anchor.'
    },
    areaLimits: {
      maxBlocksPerAxis: [AREA_LIMIT_BLOCKS, AREA_LIMIT_BLOCKS, AREA_LIMIT_BLOCKS],
      maxSpanMetersPerAxis: AREA_LIMIT_BLOCKS * VOXEL_STEP,
      maxAbsCoordinateMeters: AREA_HALF_SPAN_METERS,
      minVoxelsPerSculpture: POLICY.minVoxels,
      maxVoxelsPerSculpture: POLICY.maxVoxels
    },
    availableColors: GRAFFITI_PALETTE.map((hex) => ({
      hex,
      name: PALETTE_NAMES[hex.toLowerCase()] || hex
    })),
    availableBlocks: VOXEL_MATERIALS.map((m) => ({
      material: m.id,
      label: m.label,
      roughness: m.roughness,
      metalness: m.metalness,
      ...(m.emissiveIntensity !== undefined ? { emissiveIntensity: m.emissiveIntensity } : {}),
      ...(m.opacity !== undefined ? { opacity: m.opacity } : {})
    })),
    tools: [
      { id: 'brush', description: 'Freehand 3D spatial voxel extrusion' },
      { id: 'stack', description: 'Face-snapping voxel stacking along block normals' },
      { id: 'erase', description: 'Remove an individual placed voxel' },
      { id: 'palette', description: 'Select any hex color + matte/neon/glass block finish' },
      { id: 'agent_stage', description: 'Submit structured 3D voxel geometry for human AR review & publishing' }
    ],
    voxelSchema: {
      x: 'number (meters, multiple of 0.05, |x| <= 250)',
      y: 'number (meters above ground anchor, multiple of 0.05, |y| <= 250)',
      z: 'number (meters, multiple of 0.05, |z| <= 250)',
      color: 'string (#rrggbb hex from availableColors)',
      material: "'matte' | 'neon' | 'glass'",
      scale: 'optional number 0.25..2.0 (default 1)'
    },
    limitedTermsPolicy: {
      titleChars: [POLICY.titleMin, POLICY.titleMax],
      descriptionChars: [POLICY.descriptionMin, POLICY.descriptionMax],
      descriptionMaxWords: POLICY.descriptionMaxWords,
      prohibitedTerms: POLICY.prohibitedTerms
    },
    rules: {
      agentCanStageOnly: true,
      userMustPublishOnDevice: true,
      note: 'Agents stage 3D sculptures at the anchored physical location using the session code. Only the physical mobile user can complete GPS/Camera Proof-of-Location and publish/mint.'
    },
    examplePayload: {
      agentName: 'grokbot',
      title: 'Orbital Neon Beacon',
      description: 'Four-times fine-grain glowing beacon staged for on-site AR publishing.',
      voxels: [
        { x: 0, y: 0, z: 0, color: '#00f5d4', material: 'matte', scale: 1 },
        { x: 0, y: 0.05, z: 0, color: '#ff3e7f', material: 'neon', scale: 1 },
        { x: 0, y: 0.1, z: 0, color: '#ffd166', material: 'glass', scale: 1 }
      ]
    },
    endpoints: {
      spec: `${base}/api/agent/spec`,
      getSession: `${base}/api/agent/sessions/{code}`,
      submitSculpture: `${base}/api/agent/sessions/{code}/sculpture`
    }
  };
}

export async function createAgentSession(db, { callerUser = null, location, apiOrigin = '' }) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new AgentServiceError(
      'Valid physical GPS coordinates (lat, lng) are required before creating an Agent Sculpture Code.',
      400
    );
  }

  const geohash = encodeGeohash(lat, lng, 8);
  const parcelId = `GLAND-${geohash.toUpperCase()}`;
  const code = generateSessionCode();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const locSnapshot = {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    altitude: Number.isFinite(Number(location?.altitude)) ? Number(location.altitude) : null,
    accuracy: Number.isFinite(Number(location?.accuracy)) ? Number(location.accuracy) : null,
    heading: Number.isFinite(Number(location?.heading)) ? Number(location.heading) : null,
    timezone: String(location?.timezone || '')
  };

  await db.run(
    `INSERT INTO agent_sessions (
      code, creator_sub, location_json, parcel_id, geohash, status,
      agent_name, draft_title, draft_description, draft_voxels_json, voxel_count,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'waiting', '', '', '', '[]', 0, ?, ?, ?)`,
    [
      code,
      callerUser?.id || '',
      JSON.stringify(locSnapshot),
      parcelId,
      geohash,
      createdAt,
      createdAt,
      expiresAt
    ]
  );

  const base = String(apiOrigin || '').replace(/\/$/, '');
  const sessionUrl = `${base}/api/agent/sessions/${code}`;
  const submitUrl = `${base}/api/agent/sessions/${code}/sculpture`;
  const specUrl = `${base}/api/agent/spec`;
  const altLabel =
    locSnapshot.altitude !== null ? ` · Alt ${Math.round(locSnapshot.altitude * 10) / 10}m` : '';

  const clipboardText = [
    'GRAFFILAND 3D Agent Sculpture Request',
    `Code: ${code}`,
    `Location: ${locSnapshot.lat}, ${locSnapshot.lng} (Parcel ${parcelId}${altLabel})`,
    '',
    '1. Read all available 3D sculpting tools, colors, block materials (matte/neon/glass), 4x voxel grid (0.05m step), and 10000x10000x10000 block bounds:',
    `GET ${sessionUrl}`,
    `GET ${specUrl}`,
    '',
    '2. Build a 3D voxel sculpture at this location and stage it for me to inspect & publish from my phone:',
    `POST ${submitUrl}`,
    'JSON body: { "agentName": "your-agent", "title": "...", "description": "...", "voxels": [{ "x": 0, "y": 0, "z": 0, "color": "#00f5d4", "material": "neon", "scale": 1 }] }'
  ].join('\n');

  return {
    code,
    parcelId,
    geohash,
    location: locSnapshot,
    status: 'waiting',
    createdAt,
    expiresAt,
    endpoints: {
      spec: specUrl,
      session: sessionUrl,
      submitSculpture: submitUrl
    },
    clipboardText,
    spec: buildAgentSpec(apiOrigin)
  };
}

function formatSessionRow(row) {
  return {
    code: row.code,
    parcelId: row.parcel_id,
    geohash: row.geohash,
    location: JSON.parse(row.location_json || '{}'),
    status: row.status,
    agentName: row.agent_name || '',
    draftTitle: row.draft_title || '',
    draftDescription: row.draft_description || '',
    draftVoxels: JSON.parse(row.draft_voxels_json || '[]'),
    voxelCount: Number(row.voxel_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

export async function getAgentSession(db, { code, apiOrigin = '' }) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!/^GRF-[A-Z2-9]{6,16}$/.test(cleanCode)) {
    throw new AgentServiceError('Invalid agent session code.', 400);
  }
  const row = await db.get('SELECT * FROM agent_sessions WHERE code = ?', [cleanCode]);
  if (!row) {
    throw new AgentServiceError('Agent session code not found.', 404);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AgentServiceError('Agent session code has expired.', 410);
  }
  return {
    session: formatSessionRow(row),
    spec: buildAgentSpec(apiOrigin)
  };
}

export async function submitAgentSculpture(db, { code, body, apiOrigin = '' }) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!/^GRF-[A-Z2-9]{6,16}$/.test(cleanCode)) {
    throw new AgentServiceError('Invalid agent session code.', 400);
  }
  const row = await db.get('SELECT * FROM agent_sessions WHERE code = ?', [cleanCode]);
  if (!row) {
    throw new AgentServiceError('Agent session code not found.', 404);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new AgentServiceError('Agent session code has expired.', 410);
  }

  const { errors, cleanVoxels } = sanitizeVoxels(body?.voxels);
  if (errors.length > 0) {
    throw new AgentServiceError(errors[0], 400, { errors });
  }

  const rawTitle = String(body?.title || '').trim().replace(/[\r\n]+/g, ' ');
  const rawDesc = String(body?.description || '').trim();
  const combined = `${rawTitle} ${rawDesc}`.toLowerCase();
  for (const term of POLICY.prohibitedTerms) {
    if (combined.includes(term)) {
      throw new AgentServiceError(
        `Draft text violates Limited Terms Policy (restricted phrase: "${term}").`,
        400
      );
    }
  }

  const draftTitle = rawTitle.slice(0, POLICY.titleMax);
  const draftDescription = rawDesc.slice(0, POLICY.descriptionMax);
  const agentName = String(body?.agentName || 'external-agent').trim().slice(0, 64);
  const now = new Date().toISOString();

  await db.run(
    `UPDATE agent_sessions
     SET status = 'ready',
         agent_name = ?,
         draft_title = ?,
         draft_description = ?,
         draft_voxels_json = ?,
         voxel_count = ?,
         updated_at = ?
     WHERE code = ?`,
    [
      agentName,
      draftTitle,
      draftDescription,
      JSON.stringify(cleanVoxels),
      cleanVoxels.length,
      now,
      cleanCode
    ]
  );

  const updated = await db.get('SELECT * FROM agent_sessions WHERE code = ?', [cleanCode]);
  return {
    ok: true,
    session: formatSessionRow(updated),
    spec: buildAgentSpec(apiOrigin),
    nextStep:
      'Sculpture draft is staged at this location. The user must review it in mobile AR and tap Publish on their phone to complete Proof-of-Location and mint.'
  };
}
