import { ethers } from 'ethers';
import { POLICY } from '../constants.mjs';
import { decodeGeohashBounds } from '../../server/services/pol.mjs';

export class McpServiceError extends Error {
  constructor(message, statusCode = 400, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export function resolvePreferredOwnerWallet(user) {
  if (user?.custom_payout_address && ethers.isAddress(user.custom_payout_address)) {
    return ethers.getAddress(user.custom_payout_address);
  }
  if (user?.wallet_address && ethers.isAddress(user.wallet_address)) {
    return ethers.getAddress(user.wallet_address);
  }
  return '';
}

export function resolveUserWalletAddresses(user) {
  const out = [];
  for (const raw of [user?.wallet_address, user?.custom_payout_address]) {
    if (raw && ethers.isAddress(raw)) {
      const addr = ethers.getAddress(raw).toLowerCase();
      if (!out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

export function hashPayloadCanonical(obj) {
  const json = JSON.stringify(obj || {});
  return ethers.keccak256(ethers.toUtf8Bytes(json));
}

export function normalizeParcelId(raw) {
  return String(raw || '').trim().toUpperCase();
}

export function validateEditableTitleAndDescription({ title, description }) {
  const errors = [];
  const cleanTitle = String(title || '').trim().replace(/[\r\n]+/g, ' ');
  const cleanDesc = String(description || '').trim();

  if (cleanTitle.length < POLICY.titleMin || cleanTitle.length > POLICY.titleMax) {
    errors.push(`Title must be between ${POLICY.titleMin} and ${POLICY.titleMax} characters.`);
  }
  const words = cleanDesc ? cleanDesc.split(/\s+/).filter(Boolean) : [];
  if (cleanDesc.length < POLICY.descriptionMin || cleanDesc.length > POLICY.descriptionMax) {
    errors.push(
      `Description must be between ${POLICY.descriptionMin} and ${POLICY.descriptionMax} characters.`
    );
  }
  if (words.length > POLICY.descriptionMaxWords) {
    errors.push(`Description cannot exceed ${POLICY.descriptionMaxWords} words.`);
  }
  const combined = `${cleanTitle} ${cleanDesc}`.toLowerCase();
  for (const term of POLICY.prohibitedTerms) {
    if (combined.includes(term)) {
      errors.push(`Content violates Limited Terms Policy (restricted phrase: "${term}").`);
      break;
    }
  }
  if (errors.length > 0) {
    throw new McpServiceError(errors[0], 400, { errors });
  }
  return { title: cleanTitle, description: cleanDesc };
}

export async function isUserLandOwner(db, { parcelId, user = null, signerAddress = '' }) {
  const cleanParcelId = normalizeParcelId(parcelId);
  if (!cleanParcelId) return false;

  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }
  const userId = user?.id ? String(user.id) : '';
  if (!userId && allowed.size === 0) return false;

  const stewardRow = await db
    .get('SELECT steward_sub, steward_address FROM land_steward_state WHERE parcel_id = ?', [
      cleanParcelId
    ])
    .catch(() => null);
  if (stewardRow) {
    if (userId && stewardRow.steward_sub === userId) return true;
    if (stewardRow.steward_address && allowed.has(String(stewardRow.steward_address).toLowerCase())) {
      return true;
    }
  }

  const parcelRow = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcelId]);
  if (parcelRow) {
    if (userId && parcelRow.first_claimant_sub === userId) return true;
    if (
      parcelRow.first_claimant_address &&
      allowed.has(String(parcelRow.first_claimant_address).toLowerCase())
    ) {
      return true;
    }
  }

  const firstVisible = await db.get(
    'SELECT recipient_address, creator_sub FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 1',
    [cleanParcelId]
  );
  if (firstVisible) {
    if (
      firstVisible.recipient_address &&
      allowed.has(String(firstVisible.recipient_address).toLowerCase())
    ) {
      return true;
    }
  } else if (
    parcelRow?.latest_claimant_address &&
    allowed.has(String(parcelRow.latest_claimant_address).toLowerCase())
  ) {
    return true;
  }

  return false;
}

export async function checkSculptureOwnership(
  db,
  { sculptureId, user = null, signerAddress = '', allowHidden = false }
) {
  const row = await db.get('SELECT * FROM sculptures WHERE id = ?', [String(sculptureId || '')]);
  if (!row || (!allowHidden && row.hidden)) {
    throw new McpServiceError('Sculpture not found.', 404);
  }
  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }
  const currentOwner = String(row.recipient_address || '').toLowerCase();
  if (!currentOwner || !allowed.has(currentOwner)) {
    throw new McpServiceError(
      `Only the property owner (${row.recipient_address}) can edit this sculpture.`,
      403
    );
  }
  return row;
}

export async function checkSculptureOrLandOwnership(
  db,
  { sculptureId, user = null, signerAddress = '', allowHidden = false }
) {
  const row = await db.get('SELECT * FROM sculptures WHERE id = ?', [String(sculptureId || '')]);
  if (!row || (!allowHidden && row.hidden)) {
    throw new McpServiceError('Sculpture not found.', 404);
  }
  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }
  const currentOwner = String(row.recipient_address || '').toLowerCase();
  if (currentOwner && allowed.has(currentOwner)) {
    return { row, role: 'owner', ownerAddress: row.recipient_address };
  }
  const isAutonomousAgent =
    user?.actorType === 'agent' || String(user?.id || '').startsWith('agent:');
  if (!isAutonomousAgent && (await isUserLandOwner(db, { parcelId: row.parcel_id, user, signerAddress }))) {
    return {
      row,
      role: 'land-owner',
      ownerAddress: resolvePreferredOwnerWallet(user) || signerAddress || row.recipient_address
    };
  }
  throw new McpServiceError(
    `Only the sculpture owner (${row.recipient_address}) or the human Virtual Land owner (${row.parcel_id}) can manage this sculpture.`,
    403
  );
}

export async function checkParcelOwnership(db, { parcelId, user = null, signerAddress = '' }) {
  const cleanParcelId = normalizeParcelId(parcelId);
  if (!cleanParcelId) {
    throw new McpServiceError('Virtual Land parcelId is required.', 400);
  }
  const parcelRow = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcelId]);
  const visibleRows = await db.all(
    'SELECT * FROM sculptures WHERE parcel_id = ? AND hidden = 0 ORDER BY created_at ASC',
    [cleanParcelId]
  );

  if (!parcelRow && (!visibleRows || visibleRows.length === 0)) {
    throw new McpServiceError(
      `Virtual Land parcel ${cleanParcelId} was not found. Publish a sculpture here first to claim it.`,
      404
    );
  }

  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }

  const ownsVisibleSculpture = (visibleRows || []).some((s) =>
    allowed.has(String(s.recipient_address || '').toLowerCase())
  );
  const ownsParcelDirect = await isUserLandOwner(db, {
    parcelId: cleanParcelId,
    user,
    signerAddress
  });

  if (!ownsVisibleSculpture && !ownsParcelDirect) {
    throw new McpServiceError(
      `You do not hold property ownership on Virtual Land ${cleanParcelId}.`,
      403
    );
  }

  const geohash =
    parcelRow?.geohash ||
    visibleRows[0]?.geohash ||
    cleanParcelId.replace(/^GLAND-/, '').toLowerCase();
  const bounds = decodeGeohashBounds(geohash);

  return {
    parcelId: cleanParcelId,
    geohash,
    bounds,
    parcelRow: parcelRow || {
      parcel_id: cleanParcelId,
      geohash,
      center_lat: bounds.center[0],
      center_lng: bounds.center[1],
      first_claimant_sub: user?.id || visibleRows[0]?.creator_sub || '',
      first_claimant_address: visibleRows[0]?.recipient_address || '',
      latest_claimant_address: visibleRows[0]?.recipient_address || ''
    },
    visibleRows: visibleRows || []
  };
}

export async function isUserParcelContributor(db, { parcelId, user }) {
  if (!user?.id || !parcelId) return false;
  const cleanParcelId = normalizeParcelId(parcelId);
  const settings = await db.get('SELECT allow_contributor_edits FROM land_settings WHERE parcel_id = ?', [
    cleanParcelId
  ]);
  if (settings && Number(settings.allow_contributor_edits) === 0) {
    return false;
  }
  const row = await db.get(
    `SELECT * FROM land_contributors
     WHERE parcel_id = ? AND contributor_sub = ? AND can_edit_sculptures = 1`,
    [cleanParcelId, user.id]
  );
  return Boolean(row);
}

export async function checkSculptureEditPermission(
  db,
  { sculptureId, user = null, signerAddress = '', allowHidden = false }
) {
  const row = await db.get('SELECT * FROM sculptures WHERE id = ?', [String(sculptureId || '')]);
  if (!row || (!allowHidden && row.hidden)) {
    throw new McpServiceError('Sculpture not found.', 404);
  }
  const allowed = new Set(resolveUserWalletAddresses(user));
  if (signerAddress && ethers.isAddress(signerAddress)) {
    allowed.add(ethers.getAddress(signerAddress).toLowerCase());
  }
  const currentOwner = String(row.recipient_address || '').toLowerCase();
  if (currentOwner && allowed.has(currentOwner)) {
    return { row, role: 'owner', ownerAddress: row.recipient_address };
  }
  const isAutonomousAgent =
    user?.actorType === 'agent' || String(user?.id || '').startsWith('agent:');
  if (!isAutonomousAgent && (await isUserLandOwner(db, { parcelId: row.parcel_id, user, signerAddress }))) {
    return {
      row,
      role: 'land-owner',
      ownerAddress: resolvePreferredOwnerWallet(user) || signerAddress || row.recipient_address
    };
  }
  if (user && (await isUserParcelContributor(db, { parcelId: row.parcel_id, user }))) {
    const layer = await db.get('SELECT layer_role FROM sculpture_layers WHERE sculpture_id = ?', [row.id]);
    if (layer?.layer_role === 'steward_stage') {
      throw new McpServiceError(
        'Steward stage items (steward_stage) are protected from contributor edits. Add or edit your own artist_work sculptures on this land.',
        403
      );
    }
    return { row, role: 'contributor', ownerAddress: row.recipient_address };
  }
  throw new McpServiceError(
    `Only the property owner, Virtual Land holder, or an authorized IRL Contributor on ${row.parcel_id} can modify this sculpture.`,
    403
  );
}

export async function fetchSculptureWithModelRow(db, sculptureId) {
  return db.get(
    `SELECT s.*,
      m.model_format AS custom_model_format,
      m.mime_type AS custom_model_mime,
      m.source_type AS custom_model_source_type,
      m.model_url AS custom_model_url,
      m.model_cid AS custom_model_cid,
      m.model_uri AS custom_model_uri,
      m.scale AS custom_model_scale,
      m.rotation_y AS custom_model_rotation_y,
      m.byte_length AS custom_model_bytes,
      a.dx AS anchor_dx,
      a.dy AS anchor_dy,
      a.dz AS anchor_dz,
      a.yaw AS anchor_yaw,
      a.current_rev AS current_rev,
      a.last_erc4906_tx_hash AS last_erc4906_tx_hash,
      a.mesh_stats_json AS mesh_stats_json,
      COALESCE(l.layer_role, 'artist_work') AS layer_role,
      COALESCE(l.quest_id, '') AS layer_quest_id,
      COALESCE(l.plinth_slot_id, '') AS layer_plinth_slot_id,
      COALESCE(l.qual_contributor, 1) AS qual_contributor
     FROM sculptures s
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     WHERE s.id = ?`,
    [sculptureId]
  );
}

export async function upsertAnchorAndRevision(
  db,
  {
    sculptureId,
    parcelId,
    revNum,
    anchorOffset = { dx: 0, dy: 0, dz: 0, yaw: 0 },
    erc4906TxHash = '',
    meshStats = null,
    editorUser,
    editorRole = 'owner',
    modelType = 'voxel',
    voxels = [],
    title = '',
    description = '',
    ipfsMetadataCid = '',
    ipfsModelCid = '',
    ipfsImageCid = '',
    changeSummary = 'Initial publish',
    customModelSnapshot = null
  }
) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO sculpture_anchors (
      sculpture_id, parcel_id, dx, dy, dz, yaw, current_rev, last_erc4906_tx_hash, mesh_stats_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sculpture_id) DO UPDATE SET
      dx = excluded.dx,
      dy = excluded.dy,
      dz = excluded.dz,
      yaw = excluded.yaw,
      current_rev = excluded.current_rev,
      last_erc4906_tx_hash = CASE
        WHEN excluded.last_erc4906_tx_hash != '' THEN excluded.last_erc4906_tx_hash
        ELSE sculpture_anchors.last_erc4906_tx_hash
      END,
      mesh_stats_json = CASE
        WHEN excluded.mesh_stats_json != '{}' THEN excluded.mesh_stats_json
        ELSE sculpture_anchors.mesh_stats_json
      END,
      updated_at = excluded.updated_at`,
    [
      sculptureId,
      parcelId,
      Number(anchorOffset?.dx || 0),
      Number(anchorOffset?.dy || 0),
      Number(anchorOffset?.dz || 0),
      Number(anchorOffset?.yaw || 0),
      Number(revNum),
      String(erc4906TxHash || ''),
      meshStats ? JSON.stringify(meshStats) : '{}',
      now
    ]
  );

  await db.run(
    `INSERT OR IGNORE INTO sculpture_revisions (
      id, sculpture_id, rev_num, editor_sub, editor_name, editor_role,
      model_type, voxels_json, voxel_count, title, description,
      ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid,
      change_summary, custom_model_json, anchor_offset_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      globalThis.crypto.randomUUID(),
      sculptureId,
      Number(revNum),
      editorUser?.id || '',
      editorUser?.name || 'Artist',
      editorRole,
      modelType,
      JSON.stringify(voxels || []),
      Array.isArray(voxels) ? voxels.length : 0,
      title,
      description,
      ipfsMetadataCid || '',
      ipfsModelCid || '',
      ipfsImageCid || '',
      String(changeSummary || '').slice(0, 160),
      customModelSnapshot ? JSON.stringify(customModelSnapshot) : '',
      JSON.stringify(anchorOffset || { dx: 0, dy: 0, dz: 0, yaw: 0 }),
      now
    ]
  );
}
