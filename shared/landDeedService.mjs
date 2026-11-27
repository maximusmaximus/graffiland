import { ethers } from 'ethers';
import { TRANSACTION_FEES } from './constants.mjs';
import { resolveLandDisplayName } from './landVolume.mjs';
import {
  calculateFeeSplitBreakdown,
  getParcelQualifiedHumanContributors
} from './marketplaceService.mjs';
import {
  McpServiceError,
  resolvePreferredOwnerWallet,
  resolveUserWalletAddresses
} from './mcp/helpers.mjs';
import { buildLandTransferAuthMessage, ERC721_LAND_DEED_ABI } from './transferMessage.mjs';
import { resolvePublicUserHandle } from './userDisplay.mjs';

export const DEFAULT_SIMULATED_LAND_DEED_CONTRACT =
  '0x0000000000000000000000000000000051A9DEED';

function normalizeParcelId(raw) {
  return String(raw || '').trim().toUpperCase();
}

function safeJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObj(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function ensureLandDeedSchema(db) {
  await db.run(
    `CREATE TABLE IF NOT EXISTS land_deed_nfts (
      parcel_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      chain_name TEXT NOT NULL,
      owner_sub TEXT NOT NULL DEFAULT '',
      owner_address TEXT NOT NULL,
      original_steward_address TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL,
      metadata_uri TEXT NOT NULL DEFAULT '',
      simulated INTEGER NOT NULL DEFAULT 1,
      mint_trigger TEXT NOT NULL DEFAULT 'awakened',
      minted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS land_deed_transfers (
      id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      from_sub TEXT NOT NULL DEFAULT '',
      to_sub TEXT NOT NULL DEFAULT '',
      bundled_sculpture_ids_json TEXT NOT NULL DEFAULT '[]',
      tx_hash TEXT NOT NULL,
      simulated INTEGER NOT NULL DEFAULT 1,
      method TEXT NOT NULL,
      transferred_by_sub TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );
  await db.run(
    `CREATE TABLE IF NOT EXISTS land_marketplace_listings (
      id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      seller_sub TEXT NOT NULL,
      seller_name TEXT NOT NULL DEFAULT '',
      seller_address TEXT NOT NULL,
      price_eth REAL NOT NULL,
      price_wei TEXT NOT NULL,
      include_seller_artworks INTEGER NOT NULL DEFAULT 0,
      bundled_sculpture_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      buyer_sub TEXT NOT NULL DEFAULT '',
      buyer_address TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL DEFAULT '',
      split_breakdown_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sold_at TEXT NOT NULL DEFAULT ''
    )`
  );
}

/**
 * Evaluates whether a parcel is permanent/awakened and therefore eligible to hold
 * a transferable ERC-721 Land Deed NFT.
 *
 * Rules:
 * - Dormant 72h AI agent leases are NOT minted into NFTs until awakened by IRL human presence/art.
 * - Unvisited 28d map-drawn human lands are NOT minted until mobile AR art clears the timer.
 * - Mobile AR human-created lands, awakened agent lands, and existing active permanent lands ARE eligible.
 */
export function evaluateLandDeedEligibility({
  stewardRow = null,
  parcelRow = null,
  humanSculptureCount = 0
} = {}) {
  if (!stewardRow && !parcelRow) {
    return {
      eligible: false,
      status: 'not_found',
      reason: 'Virtual Land parcel not found.'
    };
  }
  const stStatus = String(stewardRow?.status || '').toLowerCase();
  if (stStatus === 'expired') {
    return {
      eligible: false,
      status: 'expired',
      reason: 'This dormant land lease expired and cannot be minted into a Land Deed NFT.'
    };
  }
  if (stStatus === 'dormant') {
    return {
      eligible: false,
      status: 'dormant',
      reason:
        'Awaken this land with an IRL mobile AR check-in or 3+ voxel artwork to mint its permanent Land Deed NFT.'
    };
  }

  // Map-drawn human land still on its 28-day countdown with zero IRL human art/interaction yet
  const isAgentSteward = String(stewardRow?.steward_type || '').toLowerCase() === 'agent';
  const hasTimer = Boolean(String(stewardRow?.inactivity_expires_at || '').trim());
  const hadHumanInteraction = Number(stewardRow?.had_human_interaction || 0) > 0;
  if (stewardRow && !isAgentSteward && hasTimer && !hadHumanInteraction && humanSculptureCount <= 0) {
    return {
      eligible: false,
      status: 'unawakened_map',
      reason:
        'Add mobile AR art on this land to clear the 28-day timer and mint its permanent Land Deed NFT.'
    };
  }

  return {
    eligible: true,
    status: 'permanent',
    reason: ''
  };
}

export function serializeLandDeedRow(row) {
  if (!row) return null;
  return {
    parcelId: row.parcel_id,
    tokenId: String(row.token_id),
    contractAddress: row.contract_address,
    chainId: Number(row.chain_id || 46630),
    chainName: row.chain_name || 'Robinhood Chain Testnet',
    ownerSub: row.owner_sub || '',
    ownerAddress: row.owner_address,
    originalStewardAddress: row.original_steward_address || row.owner_address,
    txHash: row.tx_hash,
    metadataUri: row.metadata_uri || '',
    simulated: Boolean(row.simulated),
    mintTrigger: row.mint_trigger || 'awakened',
    mintedAt: row.minted_at,
    updatedAt: row.updated_at,
    collectionName: 'SPRAY.LAND Virtual Land Deeds',
    collectionSymbol: 'SLAND',
    royaltySplit: '5% Platform · 3% Land Steward · 2% Human Pool'
  };
}

export function serializeLandTransferRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    parcelId: row.parcel_id,
    tokenId: String(row.token_id),
    fromAddress: row.from_address,
    toAddress: row.to_address,
    fromSub: row.from_sub || '',
    toSub: row.to_sub || '',
    bundledSculptureIds: safeJsonArray(row.bundled_sculpture_ids_json),
    txHash: row.tx_hash,
    simulated: Boolean(row.simulated),
    method: row.method || 'embedded',
    transferredBySub: row.transferred_by_sub || '',
    createdAt: row.created_at
  };
}

export function serializeLandListingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    parcelId: row.parcel_id,
    tokenId: String(row.token_id),
    sellerSub: row.seller_sub,
    sellerName: row.seller_name || 'Land Owner',
    sellerAddress: row.seller_address,
    priceEth: Number(row.price_eth || 0),
    priceWei: String(row.price_wei || '0'),
    includeSellerArtworks: Boolean(row.include_seller_artworks),
    bundledSculptureIds: safeJsonArray(row.bundled_sculpture_ids_json),
    status: row.status || 'active',
    buyerSub: row.buyer_sub || '',
    buyerAddress: row.buyer_address || '',
    txHash: row.tx_hash || '',
    splits: safeJsonObj(row.split_breakdown_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    soldAt: row.sold_at || ''
  };
}

function isLiveLandDeedContract(deedRow, chainCfg) {
  const addr = deedRow?.contract_address || chainCfg?.landDeedContractAddress || '';
  return Boolean(
    chainCfg?.rpcUrl &&
      addr &&
      ethers.isAddress(addr) &&
      addr.toLowerCase() !== DEFAULT_SIMULATED_LAND_DEED_CONTRACT.toLowerCase() &&
      !deedRow?.simulated
  );
}

async function resolveAccountByWallet(db, address) {
  if (!address || !ethers.isAddress(address)) return null;
  const clean = ethers.getAddress(address);
  const lower = clean.toLowerCase();

  const user = await db
    .get(
      `SELECT id, name, username, wallet_address, custom_payout_address
       FROM users
       WHERE LOWER(wallet_address) = ? OR LOWER(custom_payout_address) = ?
       LIMIT 1`,
      [lower, lower]
    )
    .catch(() => null);
  if (user) {
    return {
      sub: user.id,
      name: resolvePublicUserHandle(user, { fallback: 'Land Owner', includeAt: true }),
      type: 'human',
      address: clean
    };
  }

  const agent = await db
    .get(
      `SELECT agent_id, name, wallet_address
       FROM agent_accounts
       WHERE LOWER(wallet_address) = ?
       LIMIT 1`,
      [lower]
    )
    .catch(() => null);
  if (agent) {
    return {
      sub: agent.agent_id,
      name: agent.name || 'Autonomous Agent',
      type: 'agent',
      address: clean
    };
  }

  return null;
}

async function loadParcelOwnerContext(db, parcelId) {
  const cleanParcel = normalizeParcelId(parcelId);
  const [deedRow, stewardRow, curationRow, parcelRow, humanArtCountRow] = await Promise.all([
    db.get('SELECT * FROM land_deed_nfts WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db.get('SELECT * FROM parcel_curations WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [cleanParcel]).catch(() => null),
    db
      .get(
        `SELECT COUNT(*) AS c
         FROM sculptures
         WHERE parcel_id = ?
           AND hidden = 0
           AND COALESCE(creator_sub, '') NOT LIKE 'agent:%'`,
        [cleanParcel]
      )
      .catch(() => ({ c: 0 }))
  ]);
  const firstSculpture = await db
    .get(
      `SELECT id, title, creator_sub, creator_name, recipient_address, proof_hash, lat, lng
       FROM sculptures
       WHERE parcel_id = ? AND hidden = 0
       ORDER BY created_at ASC
       LIMIT 1`,
      [cleanParcel]
    )
    .catch(() => null);

  return {
    parcelId: cleanParcel,
    deedRow,
    stewardRow,
    curationRow,
    parcelRow,
    firstSculpture,
    humanSculptureCount: Number(humanArtCountRow?.c || 0)
  };
}

function resolveCanonicalParcelOwner(ctx) {
  const rawAddr =
    ctx.deedRow?.owner_address ||
    ctx.stewardRow?.steward_address ||
    ctx.curationRow?.owner_address ||
    ctx.parcelRow?.latest_claimant_address ||
    ctx.parcelRow?.first_claimant_address ||
    ctx.firstSculpture?.recipient_address ||
    '';
  const ownerAddress = rawAddr && ethers.isAddress(rawAddr) ? ethers.getAddress(rawAddr) : '';
  const ownerSub =
    ctx.deedRow?.owner_sub ||
    ctx.stewardRow?.steward_sub ||
    ctx.curationRow?.owner_sub ||
    ctx.parcelRow?.first_claimant_sub ||
    ctx.firstSculpture?.creator_sub ||
    '';
  const ownerName = ctx.stewardRow?.steward_name || ctx.firstSculpture?.creator_name || 'Land Owner';
  return { ownerAddress, ownerSub, ownerName };
}

export function doesUserOwnLandDeed(user, deedRow, stewardRow = null, curationRow = null) {
  if (!user) return false;
  if (user.is_admin) return true;
  const userWallets = resolveUserWalletAddresses(user);
  const ownerAddr = String(
    deedRow?.owner_address || stewardRow?.steward_address || curationRow?.owner_address || ''
  ).toLowerCase();
  if (ownerAddr && userWallets.some((w) => w.toLowerCase() === ownerAddr)) {
    return true;
  }
  const ownerSub = String(
    deedRow?.owner_sub || stewardRow?.steward_sub || curationRow?.owner_sub || ''
  );
  if (ownerSub && user.id && ownerSub === user.id) {
    return true;
  }
  return false;
}

/**
 * Mints a permanent Land Deed ERC-721 NFT for an eligible (permanent/awakened) parcel.
 * Safe to call repeatedly — idempotent if the parcel already has a minted Land Deed NFT.
 */
export async function ensureLandDeedMinted(
  db,
  {
    parcelId = '',
    ownerSub = '',
    ownerAddress = '',
    trigger = 'awakened',
    chainCfg = /** @type {any} */ ({}),
    publicUrl = 'https://spray.land',
    mintLandDeedFn = null
  } = /** @type {any} */ ({})
) {
  await ensureLandDeedSchema(db);
  const cleanParcel = normalizeParcelId(parcelId);
  if (!cleanParcel) return { minted: false, deed: null, eligible: false, reason: 'Invalid parcelId.' };

  const ctx = await loadParcelOwnerContext(db, cleanParcel);
  if (ctx.deedRow) {
    return {
      minted: false,
      alreadyMinted: true,
      eligible: true,
      status: 'permanent',
      deed: serializeLandDeedRow(ctx.deedRow)
    };
  }

  const eligibility = evaluateLandDeedEligibility(ctx);
  if (!eligibility.eligible) {
    return {
      minted: false,
      alreadyMinted: false,
      eligible: false,
      status: eligibility.status,
      reason: eligibility.reason,
      deed: null
    };
  }

  const canonical = resolveCanonicalParcelOwner(ctx);
  const resolvedAddr =
    ownerAddress && ethers.isAddress(ownerAddress)
      ? ethers.getAddress(ownerAddress)
      : canonical.ownerAddress;
  if (!resolvedAddr) {
    return {
      minted: false,
      alreadyMinted: false,
      eligible: false,
      status: 'missing_wallet',
      reason: 'Parcel has no valid owner EVM wallet address.',
      deed: null
    };
  }
  const resolvedSub = ownerSub || canonical.ownerSub || '';
  const metadataUri = `${String(publicUrl || 'https://spray.land').replace(/\/$/, '')}/api/lands/${encodeURIComponent(cleanParcel)}/deed.json`;

  const lat = Number(ctx.parcelRow?.center_lat ?? ctx.firstSculpture?.lat ?? 0);
  const lng = Number(ctx.parcelRow?.center_lng ?? ctx.firstSculpture?.lng ?? 0);
  const proofHash =
    ctx.firstSculpture?.proof_hash && /^0x[0-9a-fA-F]{64}$/.test(ctx.firstSculpture.proof_hash)
      ? ctx.firstSculpture.proof_hash
      : ethers.keccak256(ethers.toUtf8Bytes(`land-deed-proof:${cleanParcel}:${resolvedAddr}`));

  let tokenId = '';
  let txHash = '';
  let contractAddress =
    chainCfg?.landDeedContractAddress && ethers.isAddress(chainCfg.landDeedContractAddress)
      ? ethers.getAddress(chainCfg.landDeedContractAddress)
      : DEFAULT_SIMULATED_LAND_DEED_CONTRACT;
  let simulated = true;

  if (typeof mintLandDeedFn === 'function') {
    const res = await mintLandDeedFn({
      recipient: resolvedAddr,
      parcelId: cleanParcel,
      metadataUri,
      proofHash,
      lat,
      lng
    });
    if (res?.tokenId) {
      tokenId = String(res.tokenId);
      txHash = String(res.txHash || '');
      if (res.contractAddress && ethers.isAddress(res.contractAddress)) {
        contractAddress = ethers.getAddress(res.contractAddress);
      }
      simulated = Boolean(res.simulated);
    }
  }

  const now = new Date().toISOString();
  if (!tokenId) {
    const countRow = await db
      .get('SELECT COUNT(*) AS c FROM land_deed_nfts')
      .catch(() => ({ c: 0 }));
    tokenId = String(Number(countRow?.c || 0) + 1);
    txHash =
      txHash ||
      ethers.keccak256(
        ethers.toUtf8Bytes(`land-deed-mint:${cleanParcel}:${tokenId}:${resolvedAddr}:${now}`)
      );
    simulated = true;
  }

  await db.run(
    `INSERT INTO land_deed_nfts (
      parcel_id, token_id, contract_address, chain_id, chain_name,
      owner_sub, owner_address, original_steward_address,
      tx_hash, metadata_uri, simulated, mint_trigger, minted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parcel_id) DO NOTHING`,
    [
      cleanParcel,
      tokenId,
      contractAddress,
      Number(chainCfg?.chainId || 46630),
      chainCfg?.chainName || 'Robinhood Chain Testnet',
      resolvedSub,
      resolvedAddr,
      resolvedAddr,
      txHash,
      metadataUri,
      simulated ? 1 : 0,
      trigger || 'awakened',
      now,
      now
    ]
  );

  const inserted = await db.get('SELECT * FROM land_deed_nfts WHERE parcel_id = ?', [cleanParcel]);
  return {
    minted: true,
    alreadyMinted: false,
    eligible: true,
    status: 'permanent',
    deed: serializeLandDeedRow(inserted)
  };
}

/**
 * Lists non-hidden artworks on `parcelId` currently owned by `ownerAddress` (eligible for
 * optional 1-click Bundle Transfer or Land+Artworks Marketplace listing).
 * Third-party artworks owned by other creators/collectors are strictly excluded.
 */
export async function listOwnedArtworksOnParcel(db, { parcelId, ownerAddress }) {
  const cleanParcel = normalizeParcelId(parcelId);
  if (!cleanParcel || !ownerAddress || !ethers.isAddress(ownerAddress)) return [];
  const lower = ethers.getAddress(ownerAddress).toLowerCase();
  const rows = await db
    .all(
      `SELECT id, title, token_id, recipient_address, creator_sub, creator_name, voxel_count, created_at
       FROM sculptures
       WHERE parcel_id = ?
         AND hidden = 0
         AND LOWER(recipient_address) = ?
       ORDER BY created_at ASC`,
      [cleanParcel, lower]
    )
    .catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    title: r.title || '3D Artwork',
    tokenId: String(r.token_id || ''),
    ownerAddress: r.recipient_address,
    creatorSub: r.creator_sub || '',
    voxelCount: Number(r.voxel_count || 0),
    createdAt: r.created_at
  }));
}

/**
 * Atomically applies a Land Deed NFT ownership transfer across:
 * 1. `land_deed_nfts` (owner wallet + user/agent sub)
 * 2. `parcel_curations` (curation control, preserving custom name & description)
 * 3. `land_steward_state` (routes ALL future 3% Land Steward fees to the new owner; keeps 2% Human Pool intact)
 * 4. `land_parcels.latest_claimant_address`
 * 5. Clean Security Reset: auto-cancels previous owner's pending `land_signature_requests` AND stale active listings
 * 6. Audit log in `land_deed_transfers`
 */
async function applyLandOwnershipChange(
  db,
  {
    parcelId,
    deedRow,
    fromAddress,
    toAddress,
    fromSub = '',
    toAccount = null,
    txHash,
    simulated = true,
    method = 'embedded',
    transferredBySub = '',
    bundledSculptureIds = [],
    excludeListingId = '',
    now = new Date().toISOString()
  }
) {
  const cleanParcel = normalizeParcelId(parcelId);
  const resolvedTo = ethers.getAddress(toAddress);
  const resolvedFrom = ethers.getAddress(fromAddress);
  const recipient = toAccount || (await resolveAccountByWallet(db, resolvedTo));
  const nextOwnerSub = recipient?.sub || '';
  const nextOwnerName = recipient?.name || `${resolvedTo.slice(0, 6)}…${resolvedTo.slice(-4)}`;
  const nextOwnerType = recipient?.type || 'human';

  // 1. Update Land Deed NFT record
  await db.run(
    `UPDATE land_deed_nfts
     SET owner_address = ?, owner_sub = ?, updated_at = ?
     WHERE parcel_id = ?`,
    [resolvedTo, nextOwnerSub, now, cleanParcel]
  );

  // 2. Update curation ownership (preserving custom_name, curation_note, featured sculpture, public AR)
  await db.run(
    `INSERT INTO parcel_curations (
      parcel_id, owner_sub, owner_address, custom_name, curation_note,
      featured_sculpture_id, allow_public_ar, last_signed_tx_hash, updated_at
    ) VALUES (?, ?, ?, '', '', '', 1, ?, ?)
    ON CONFLICT(parcel_id) DO UPDATE SET
      owner_sub = excluded.owner_sub,
      owner_address = excluded.owner_address,
      last_signed_tx_hash = excluded.last_signed_tx_hash,
      updated_at = excluded.updated_at`,
    [cleanParcel, nextOwnerSub, resolvedTo, txHash, now]
  );

  // 3. Update land_steward_state so future 3% Land Steward fees route to the new Land Deed owner
  //    (first_human_sub and sculptures stay untouched so original IRL artists keep their 2% pool!)
  const existingSteward = await db
    .get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [cleanParcel])
    .catch(() => null);
  if (existingSteward) {
    await db.run(
      `UPDATE land_steward_state
       SET steward_sub = ?, steward_address = ?, steward_name = ?, steward_type = ?, updated_at = ?
       WHERE parcel_id = ?`,
      [nextOwnerSub, resolvedTo, nextOwnerName, nextOwnerType, now, cleanParcel]
    );
  } else {
    await db.run(
      `INSERT INTO land_steward_state (
        parcel_id, steward_sub, steward_address, steward_name, steward_type,
        status, claimed_at, lease_expires_at, awakened_at,
        last_human_interaction_at, last_human_interaction_type, last_human_interaction_sub,
        inactivity_expires_at, had_human_interaction,
        first_human_sub, first_human_address, human_contributor_count,
        total_tx_volume_eth, agent_royalties_eth, human_royalties_eth, platform_fees_eth, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'awakened', ?, '', ?, ?, 'deed_transfer', ?, '', 1, '', '', 0, 0, 0, 0, 0, ?)`,
      [cleanParcel, nextOwnerSub, resolvedTo, nextOwnerName, nextOwnerType, now, now, now, nextOwnerSub, now]
    );
  }

  // 4. Update land_parcels latest claimant address
  await db
    .run(
      `UPDATE land_parcels
       SET latest_claimant_address = ?, updated_at = ?
       WHERE parcel_id = ?`,
      [resolvedTo, now, cleanParcel]
    )
    .catch(() => {});

  // 5. Clean Security Reset: auto-cancel ALL pending agent signature/approval requests from previous owner
  const cancelResultJson = JSON.stringify({
    cancelledBy: 'land_deed_transfer',
    reason: 'Cancelled automatically after Land Deed NFT transfer.'
  });
  const cancelledApprovalsRes = await db
    .run(
      `UPDATE land_signature_requests
       SET status = 'cancelled',
           result_json = ?,
           updated_at = ?
       WHERE parcel_id = ? AND status = 'pending'`,
      [cancelResultJson, now, cleanParcel]
    )
    .catch(() => ({ changes: 0 }));

  // Cancel any stale active marketplace listings on this parcel (other than the listing just sold)
  if (excludeListingId) {
    await db
      .run(
        `UPDATE land_marketplace_listings
         SET status = 'cancelled', updated_at = ?
         WHERE parcel_id = ? AND status = 'active' AND id != ?`,
        [now, cleanParcel, excludeListingId]
      )
      .catch(() => {});
  } else {
    await db
      .run(
        `UPDATE land_marketplace_listings
         SET status = 'cancelled', updated_at = ?
         WHERE parcel_id = ? AND status = 'active'`,
        [now, cleanParcel]
      )
      .catch(() => {});
  }

  // 6. Record audit trail in land_deed_transfers
  const transferId = globalThis.crypto.randomUUID();
  await db.run(
    `INSERT INTO land_deed_transfers (
      id, parcel_id, token_id, from_address, to_address, from_sub, to_sub,
      bundled_sculpture_ids_json, tx_hash, simulated, method, transferred_by_sub, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transferId,
      cleanParcel,
      String(deedRow.token_id),
      resolvedFrom,
      resolvedTo,
      fromSub || deedRow.owner_sub || '',
      nextOwnerSub,
      JSON.stringify(bundledSculptureIds || []),
      txHash,
      simulated ? 1 : 0,
      method,
      transferredBySub || fromSub || 'system',
      now
    ]
  );

  const [updatedDeed, transferRow] = await Promise.all([
    db.get('SELECT * FROM land_deed_nfts WHERE parcel_id = ?', [cleanParcel]),
    db.get('SELECT * FROM land_deed_transfers WHERE id = ?', [transferId])
  ]);

  return {
    deed: serializeLandDeedRow(updatedDeed),
    transfer: serializeLandTransferRow(transferRow),
    cancelledPendingApprovals: Number(cancelledApprovalsRes?.changes || 0),
    nextOwner: {
      sub: nextOwnerSub,
      name: nextOwnerName,
      type: nextOwnerType,
      address: resolvedTo
    }
  };
}

/**
 * Transfers a permanent Land Deed NFT from its current owner (human or autonomous agent)
 * to `toAddress`, with optional 1-click bundle transfer of artworks owned by the sender on that parcel.
 */
export async function transferLandDeed(
  db,
  {
    parcelId,
    callerUser,
    toAddress,
    includeOwnedArtworks = false,
    externalTxHash = '',
    walletSignature = '',
    chainCfg = /** @type {any} */ ({}),
    publicUrl = 'https://spray.land',
    mintLandDeedFn = null,
    transferSculptureFn = null
  }
) {
  await ensureLandDeedSchema(db);
  const cleanParcel = normalizeParcelId(parcelId);
  if (!cleanParcel) throw new McpServiceError('parcelId is required.', 400);
  if (!callerUser) throw new McpServiceError('Authentication required.', 401);
  if (!toAddress || !ethers.isAddress(String(toAddress).trim())) {
    throw new McpServiceError('Please enter a valid destination 0x EVM wallet address.', 400);
  }
  const dest = ethers.getAddress(String(toAddress).trim());

  // Lazily backfill Land Deed NFT for existing permanent/awakened parcels (rejects dormant/unawakened)
  const mintStatus = await ensureLandDeedMinted(db, {
    parcelId: cleanParcel,
    trigger: 'transfer_backfill',
    chainCfg,
    publicUrl,
    mintLandDeedFn
  });
  if (!mintStatus.eligible || !mintStatus.deed) {
    throw new McpServiceError(
      mintStatus.reason || 'This land is not eligible for a transferable Land Deed NFT yet.',
      409,
      { code: 'LAND_DEED_NOT_MINTABLE', landStatus: mintStatus.status }
    );
  }

  const ctx = await loadParcelOwnerContext(db, cleanParcel);
  const deedRow = ctx.deedRow;
  if (!doesUserOwnLandDeed(callerUser, deedRow, ctx.stewardRow, ctx.curationRow)) {
    throw new McpServiceError('Only the current Land Deed NFT owner can transfer this land.', 403);
  }

  const fromAddress = ethers.getAddress(deedRow.owner_address);
  if (fromAddress.toLowerCase() === dest.toLowerCase()) {
    throw new McpServiceError('Destination wallet already owns this Land Deed NFT.', 400);
  }

  const liveChain = isLiveLandDeedContract(deedRow, chainCfg);
  const isAgentCaller = Boolean(callerUser.is_agent || String(callerUser.id || '').startsWith('agent:'));
  const embeddedAddr =
    callerUser.wallet_address && ethers.isAddress(callerUser.wallet_address)
      ? ethers.getAddress(callerUser.wallet_address)
      : '';
  const isEmbeddedHolder = Boolean(
    embeddedAddr && embeddedAddr.toLowerCase() === fromAddress.toLowerCase()
  );

  let finalTxHash = '';
  let simulated = !liveChain;
  let method = isAgentCaller ? 'agent_autonomous' : isEmbeddedHolder ? 'embedded' : 'external_wallet';
  const now = new Date().toISOString();

  if (externalTxHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(externalTxHash).trim())) {
      throw new McpServiceError('Invalid external transaction hash.', 400);
    }
    finalTxHash = String(externalTxHash).trim();
    method = 'external_wallet';
    if (liveChain) {
      const provider = new ethers.JsonRpcProvider(chainCfg.rpcUrl, chainCfg.chainId);
      const contract = new ethers.Contract(deedRow.contract_address, ERC721_LAND_DEED_ABI, provider);
      const onChainOwner = ethers.getAddress(await contract.ownerOf(deedRow.token_id));
      if (onChainOwner.toLowerCase() !== dest.toLowerCase()) {
        throw new McpServiceError(
          `On-chain ownerOf(#${deedRow.token_id}) is ${onChainOwner}, not ${dest}. Wait for confirmation and retry.`,
          409
        );
      }
      simulated = false;
    }
  } else if (liveChain && !isEmbeddedHolder) {
    throw new McpServiceError(
      'This Land Deed NFT is held in an external wallet. Submit the transfer in MetaMask/wallet first.',
      409,
      {
        requiresExternalWalletTx: true,
        contractAddress: deedRow.contract_address,
        tokenId: deedRow.token_id,
        chainId: deedRow.chain_id,
        fromAddress,
        toAddress: dest
      }
    );
  } else {
    if (!isEmbeddedHolder && !isAgentCaller && !callerUser.is_admin) {
      if (!walletSignature) {
        throw new McpServiceError(
          'External wallet signature is required to authorize this Land Deed transfer.',
          400
        );
      }
      const expectedMsg = buildLandTransferAuthMessage({
        parcelId: cleanParcel,
        tokenId: deedRow.token_id,
        fromAddress,
        toAddress: dest,
        contractAddress: deedRow.contract_address,
        chainId: deedRow.chain_id,
        includeOwnedArtworks: Boolean(includeOwnedArtworks)
      });
      const recovered = ethers.verifyMessage(expectedMsg, walletSignature);
      if (recovered.toLowerCase() !== fromAddress.toLowerCase()) {
        throw new McpServiceError('Wallet signature does not match current Land Deed owner.', 403);
      }
      method = 'external_wallet';
    }
    finalTxHash = ethers.keccak256(
      ethers.toUtf8Bytes(
        `land-deed-transfer:${cleanParcel}:${deedRow.token_id}:${fromAddress}:${dest}:${now}`
      )
    );
    simulated = true;
  }

  // Optional 1-click Bundle Transfer: move sender's OWN artworks on this parcel alongside the Land Deed
  const bundledSculptureIds = [];
  if (includeOwnedArtworks) {
    const ownedArtworks = await listOwnedArtworksOnParcel(db, {
      parcelId: cleanParcel,
      ownerAddress: fromAddress
    });
    for (const art of ownedArtworks) {
      if (typeof transferSculptureFn === 'function') {
        await transferSculptureFn({
          sculptureId: art.id,
          callerUser,
          toAddress: dest
        });
      } else {
        await db.run('UPDATE sculptures SET recipient_address = ? WHERE id = ?', [dest, art.id]);
        await db
          .run(
            `INSERT INTO sculpture_transfers (
              id, sculpture_id, from_address, to_address, token_id, tx_hash, simulated, method, transferred_by_sub, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'land_bundle', ?, ?)`,
            [
              globalThis.crypto.randomUUID(),
              art.id,
              fromAddress,
              dest,
              art.tokenId,
              finalTxHash,
              simulated ? 1 : 0,
              callerUser.id,
              now
            ]
          )
          .catch(() => {});
      }
      bundledSculptureIds.push(art.id);
    }
  }

  const applied = await applyLandOwnershipChange(db, {
    parcelId: cleanParcel,
    deedRow,
    fromAddress,
    toAddress: dest,
    fromSub: deedRow.owner_sub || callerUser.id,
    txHash: finalTxHash,
    simulated,
    method,
    transferredBySub: callerUser.id,
    bundledSculptureIds,
    now
  });

  return {
    transferred: true,
    parcelId: cleanParcel,
    deed: applied.deed,
    transfer: applied.transfer,
    bundledSculptureIds,
    cancelledPendingApprovals: applied.cancelledPendingApprovals,
    nextOwner: applied.nextOwner
  };
}

/**
 * Lists a permanent Land Deed NFT for sale on the SPRAY.LAND Marketplace with the
 * deterministic 5% Platform + 3% Land Steward + 2% Human Pool + 90% Seller split.
 */
export async function listLandDeedForSale(
  db,
  {
    parcelId,
    sellerUser,
    priceEth,
    includeSellerArtworks = false,
    platformAddress = '',
    chainCfg = {},
    publicUrl = 'https://spray.land',
    mintLandDeedFn = null
  }
) {
  await ensureLandDeedSchema(db);
  const cleanParcel = normalizeParcelId(parcelId);
  if (!cleanParcel) throw new McpServiceError('parcelId is required.', 400);
  if (!sellerUser) throw new McpServiceError('Authentication required.', 401);

  const numericPrice = Number(priceEth);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new McpServiceError('Listing priceEth must be greater than 0.', 400);
  }

  const mintStatus = await ensureLandDeedMinted(db, {
    parcelId: cleanParcel,
    trigger: 'marketplace_backfill',
    chainCfg,
    publicUrl,
    mintLandDeedFn
  });
  if (!mintStatus.eligible || !mintStatus.deed) {
    throw new McpServiceError(
      mintStatus.reason || 'Only permanent/awakened lands with a Land Deed NFT can be listed for sale.',
      409
    );
  }

  const ctx = await loadParcelOwnerContext(db, cleanParcel);
  const deedRow = ctx.deedRow;
  if (!doesUserOwnLandDeed(sellerUser, deedRow, ctx.stewardRow, ctx.curationRow)) {
    throw new McpServiceError('Only the current Land Deed NFT owner can list this land for sale.', 403);
  }

  const existingActive = await db.get(
    "SELECT id FROM land_marketplace_listings WHERE parcel_id = ? AND status = 'active' LIMIT 1",
    [cleanParcel]
  );
  if (existingActive) {
    throw new McpServiceError('This Land Deed NFT already has an active marketplace listing.', 409);
  }

  const sellerAddress = ethers.getAddress(deedRow.owner_address);
  const contributors = await getParcelQualifiedHumanContributors(db, cleanParcel);
  const splits = calculateFeeSplitBreakdown(numericPrice, {
    sellerAddress,
    platformAddress: platformAddress || sellerAddress,
    agentStewardAddress: sellerAddress,
    humanContributors: contributors
  });

  const bundledArtworks = includeSellerArtworks
    ? await listOwnedArtworksOnParcel(db, { parcelId: cleanParcel, ownerAddress: sellerAddress })
    : [];
  const bundledIds = bundledArtworks.map((a) => a.id);

  const now = new Date().toISOString();
  const listingId = globalThis.crypto.randomUUID();
  const sellerName = resolvePublicUserHandle(sellerUser, {
    fallback: sellerUser.name || 'Land Owner',
    includeAt: true
  });

  await db.run(
    `INSERT INTO land_marketplace_listings (
      id, parcel_id, token_id, seller_sub, seller_name, seller_address,
      price_eth, price_wei, include_seller_artworks, bundled_sculpture_ids_json,
      status, buyer_sub, buyer_address, tx_hash, split_breakdown_json, created_at, updated_at, sold_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', '', '', ?, ?, ?, '')`,
    [
      listingId,
      cleanParcel,
      String(deedRow.token_id),
      sellerUser.id,
      sellerName,
      sellerAddress,
      splits.grossEth,
      splits.grossWei,
      includeSellerArtworks ? 1 : 0,
      JSON.stringify(bundledIds),
      JSON.stringify(splits),
      now,
      now
    ]
  );

  const row = await db.get('SELECT * FROM land_marketplace_listings WHERE id = ?', [listingId]);
  return {
    listed: true,
    listing: serializeLandListingRow(row),
    deed: serializeLandDeedRow(deedRow),
    splits
  };
}

export async function cancelLandDeedListing(db, { listingId, callerUser }) {
  await ensureLandDeedSchema(db);
  if (!callerUser) throw new McpServiceError('Authentication required.', 401);
  const row = await db.get('SELECT * FROM land_marketplace_listings WHERE id = ?', [listingId]);
  if (!row) throw new McpServiceError('Land listing not found.', 404);
  if (row.status !== 'active') {
    throw new McpServiceError(`Listing is already ${row.status}.`, 409);
  }
  const userWallets = resolveUserWalletAddresses(callerUser).map((w) => w.toLowerCase());
  const isOwner =
    callerUser.is_admin ||
    row.seller_sub === callerUser.id ||
    userWallets.includes(String(row.seller_address || '').toLowerCase());
  if (!isOwner) {
    throw new McpServiceError('Only the seller can cancel this Land Deed listing.', 403);
  }
  const now = new Date().toISOString();
  await db.run(
    "UPDATE land_marketplace_listings SET status = 'cancelled', updated_at = ? WHERE id = ?",
    [now, listingId]
  );
  const updated = await db.get('SELECT * FROM land_marketplace_listings WHERE id = ?', [listingId]);
  return { cancelled: true, listing: serializeLandListingRow(updated) };
}

/**
 * Buys an active Land Deed NFT listing (human or autonomous AI agent), settles the
 * deterministic 5% Platform + 3% Land Steward + 2% Human Pool + 90% Seller split,
 * transfers the Land Deed (+ bundled seller artworks if included), and runs the Clean Security Reset.
 */
export async function buyLandDeed(
  db,
  {
    listingId,
    buyerUser,
    buyerAddress = '',
    txHash = '',
    platformAddress = '',
    transferSculptureFn = null
  }
) {
  await ensureLandDeedSchema(db);
  if (!buyerUser) throw new McpServiceError('Authentication required.', 401);
  const listing = await db.get('SELECT * FROM land_marketplace_listings WHERE id = ?', [listingId]);
  if (!listing) throw new McpServiceError('Land marketplace listing not found.', 404);
  if (listing.status !== 'active') {
    throw new McpServiceError(`Land listing is no longer active (${listing.status}).`, 409);
  }

  const ctx = await loadParcelOwnerContext(db, listing.parcel_id);
  const deedRow = ctx.deedRow;
  if (!deedRow) {
    throw new McpServiceError('Land Deed NFT record is missing for this listing.', 404);
  }

  const resolvedBuyer =
    buyerAddress && ethers.isAddress(buyerAddress)
      ? ethers.getAddress(buyerAddress)
      : resolvePreferredOwnerWallet(buyerUser);
  if (!resolvedBuyer) {
    throw new McpServiceError('A valid buyer EVM wallet address is required.', 400);
  }
  const sellerAddr = ethers.getAddress(deedRow.owner_address);
  if (resolvedBuyer.toLowerCase() === sellerAddr.toLowerCase()) {
    throw new McpServiceError('Buyer already owns this Land Deed NFT.', 400);
  }

  const contributors = await getParcelQualifiedHumanContributors(db, listing.parcel_id);
  const splits = calculateFeeSplitBreakdown(listing.price_eth, {
    sellerAddress: sellerAddr,
    platformAddress: platformAddress || sellerAddr,
    agentStewardAddress: sellerAddr,
    humanContributors: contributors
  });

  const now = new Date().toISOString();
  const effectiveTxHash =
    txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)
      ? txHash
      : ethers.keccak256(
          ethers.toUtf8Bytes(`land-market-buy:${listing.id}:${resolvedBuyer}:${now}`)
        );

  // Transfer bundled seller-owned artworks if the seller opted into Land + Artworks bundle
  const bundledIds = [];
  if (listing.include_seller_artworks) {
    const allowedIds = new Set(safeJsonArray(listing.bundled_sculpture_ids_json));
    const sellerArtworks = await listOwnedArtworksOnParcel(db, {
      parcelId: listing.parcel_id,
      ownerAddress: sellerAddr
    });
    for (const art of sellerArtworks) {
      if (allowedIds.size > 0 && !allowedIds.has(art.id)) continue;
      if (typeof transferSculptureFn === 'function') {
        await transferSculptureFn({
          sculptureId: art.id,
          callerUser: { id: listing.seller_sub, wallet_address: sellerAddr, is_admin: true },
          toAddress: resolvedBuyer
        });
      } else {
        await db.run('UPDATE sculptures SET recipient_address = ? WHERE id = ?', [
          resolvedBuyer,
          art.id
        ]);
        await db
          .run(
            `INSERT INTO sculpture_transfers (
              id, sculpture_id, from_address, to_address, token_id, tx_hash, simulated, method, transferred_by_sub, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 'land_marketplace_bundle', ?, ?)`,
            [
              globalThis.crypto.randomUUID(),
              art.id,
              sellerAddr,
              resolvedBuyer,
              art.tokenId,
              effectiveTxHash,
              buyerUser.id,
              now
            ]
          )
          .catch(() => {});
      }
      bundledIds.push(art.id);
    }
  }

  // Mark listing sold
  await db.run(
    `UPDATE land_marketplace_listings
     SET status = 'sold', buyer_sub = ?, buyer_address = ?, tx_hash = ?,
         bundled_sculpture_ids_json = ?, split_breakdown_json = ?, updated_at = ?, sold_at = ?
     WHERE id = ?`,
    [
      buyerUser.id,
      resolvedBuyer,
      effectiveTxHash,
      JSON.stringify(bundledIds),
      JSON.stringify(splits),
      now,
      now,
      listing.id
    ]
  );

  // Record 5%/3%/2%/90% fee split in economy_fee_ledger
  const ledgerRows = [
    {
      role: 'platform',
      sub: 'platform',
      name: 'SPRAY.LAND Platform Treasury',
      address: splits.platform.address,
      bps: splits.platform.bps,
      amountEth: splits.platform.amountEth,
      amountWei: splits.platform.amountWei
    },
    {
      role: 'agent_steward',
      sub: listing.seller_sub || deedRow.owner_sub || '',
      name: listing.seller_name || 'Land Steward',
      address: splits.agentSteward.address,
      bps: splits.agentSteward.bps,
      amountEth: splits.agentSteward.amountEth,
      amountWei: splits.agentSteward.amountWei
    },
    ...splits.humanContributors.perContributor.map((c) => ({
      role: 'human_contributor',
      sub: c.userId || '',
      name: c.name || 'IRL Human Artist',
      address: c.address,
      bps: c.bps,
      amountEth: c.amountEth,
      amountWei: c.amountWei
    }))
  ];

  for (const entry of ledgerRows) {
    await db
      .run(
        `INSERT INTO fee_ledger_entries (
          id, tx_type, parcel_id, sculpture_id, listing_id, recipient_role,
          recipient_sub, recipient_name, recipient_address, bps, amount_eth, amount_wei, tx_hash, created_at
        ) VALUES (?, 'land_marketplace_sale', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          globalThis.crypto.randomUUID(),
          listing.parcel_id,
          listing.id,
          entry.role,
          entry.sub,
          entry.name,
          entry.address,
          entry.bps,
          entry.amountEth,
          entry.amountWei,
          effectiveTxHash,
          now
        ]
      )
      .catch(() => {});
  }

  // Accumulate parcel economic telemetry
  await db
    .run(
      `UPDATE land_steward_state
       SET total_tx_volume_eth = total_tx_volume_eth + ?,
           agent_royalties_eth = agent_royalties_eth + ?,
           human_royalties_eth = human_royalties_eth + ?,
           platform_fees_eth = platform_fees_eth + ?,
           updated_at = ?
       WHERE parcel_id = ?`,
      [
        splits.grossEth,
        splits.agentSteward.amountEth,
        splits.humanContributors.poolEth,
        splits.platform.amountEth,
        now,
        listing.parcel_id
      ]
    )
    .catch(() => {});

  // Apply Land Deed ownership transfer + future 3% steward routing + Clean Security Reset
  const buyerAccount = {
    sub: buyerUser.id,
    name: resolvePublicUserHandle(buyerUser, {
      fallback: buyerUser.name || (buyerUser.is_agent ? 'Autonomous Agent' : 'Land Owner'),
      includeAt: !buyerUser.is_agent
    }),
    type: buyerUser.is_agent || String(buyerUser.id || '').startsWith('agent:') ? 'agent' : 'human',
    address: resolvedBuyer
  };

  const applied = await applyLandOwnershipChange(db, {
    parcelId: listing.parcel_id,
    deedRow,
    fromAddress: sellerAddr,
    toAddress: resolvedBuyer,
    fromSub: listing.seller_sub,
    toAccount: buyerAccount,
    txHash: effectiveTxHash,
    simulated: true,
    method: 'land_marketplace_sale',
    transferredBySub: buyerUser.id,
    bundledSculptureIds: bundledIds,
    excludeListingId: listing.id,
    now
  });

  const soldRow = await db.get('SELECT * FROM land_marketplace_listings WHERE id = ?', [listing.id]);
  return {
    purchased: true,
    listingId: listing.id,
    parcelId: listing.parcel_id,
    deed: applied.deed,
    listing: serializeLandListingRow(soldRow),
    transfer: applied.transfer,
    bundledSculptureIds: bundledIds,
    cancelledPendingApprovals: applied.cancelledPendingApprovals,
    buyerAddress: resolvedBuyer,
    txHash: effectiveTxHash,
    splits
  };
}

export async function syncLandDeedOwnership(
  db,
  { parcelId = '', chainCfg = /** @type {any} */ ({}), callerUser = null } = /** @type {any} */ ({})
) {
  await ensureLandDeedSchema(db);
  const cleanParcel = normalizeParcelId(parcelId);
  const deedRow = await db.get('SELECT * FROM land_deed_nfts WHERE parcel_id = ?', [cleanParcel]);
  if (!deedRow) {
    throw new McpServiceError('Land Deed NFT not found for this parcel.', 404);
  }
  const currentRecorded = ethers.getAddress(deedRow.owner_address);
  if (!isLiveLandDeedContract(deedRow, chainCfg)) {
    return {
      synced: false,
      simulated: true,
      changed: false,
      ownerAddress: currentRecorded,
      deed: serializeLandDeedRow(deedRow)
    };
  }
  const provider = new ethers.JsonRpcProvider(chainCfg.rpcUrl, chainCfg.chainId);
  const contract = new ethers.Contract(deedRow.contract_address, ERC721_LAND_DEED_ABI, provider);
  const onChainOwner = ethers.getAddress(await contract.ownerOf(deedRow.token_id));
  if (onChainOwner.toLowerCase() === currentRecorded.toLowerCase()) {
    return {
      synced: true,
      simulated: false,
      changed: false,
      ownerAddress: onChainOwner,
      deed: serializeLandDeedRow(deedRow)
    };
  }

  const now = new Date().toISOString();
  const txHash = ethers.keccak256(
    ethers.toUtf8Bytes(`land-deed-sync:${cleanParcel}:${deedRow.token_id}:${onChainOwner}:${now}`)
  );
  const applied = await applyLandOwnershipChange(db, {
    parcelId: cleanParcel,
    deedRow,
    fromAddress: currentRecorded,
    toAddress: onChainOwner,
    fromSub: deedRow.owner_sub,
    txHash,
    simulated: false,
    method: 'chain-sync',
    transferredBySub: callerUser?.id || 'system-sync',
    now
  });
  return {
    synced: true,
    simulated: false,
    changed: true,
    ownerAddress: onChainOwner,
    deed: applied.deed,
    transfer: applied.transfer,
    cancelledPendingApprovals: applied.cancelledPendingApprovals
  };
}

export async function listActiveLandMarketplaceListings(db, { parcelId = '', limit = 60 } = {}) {
  await ensureLandDeedSchema(db);
  const clauses = ["l.status = 'active'"];
  const params = [];
  if (parcelId) {
    clauses.push('l.parcel_id = ?');
    params.push(normalizeParcelId(parcelId));
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 60)));
  const rows = await db
    .all(
      `SELECT l.*,
              COALESCE(pc.custom_name, '') AS parcel_custom_name,
              lp.center_lat, lp.center_lng, lp.sculpture_count
       FROM land_marketplace_listings l
       LEFT JOIN parcel_curations pc ON pc.parcel_id = l.parcel_id
       LEFT JOIN land_parcels lp ON lp.parcel_id = l.parcel_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY l.created_at DESC
       LIMIT ?`,
      params
    )
    .catch(() => []);
  return rows.map((r) => ({
    ...serializeLandListingRow(r),
    parcelName: String(r.parcel_custom_name || '').trim(),
    landDisplayName: resolveLandDisplayName({
      customName: r.parcel_custom_name || '',
      parcelId: r.parcel_id
    }),
    lat: Number.isFinite(Number(r.center_lat)) ? Number(r.center_lat) : null,
    lng: Number.isFinite(Number(r.center_lng)) ? Number(r.center_lng) : null,
    sculptureCount: Number(r.sculpture_count || 0)
  }));
}

export async function getLandDeedSummary(
  db,
  {
    parcelId,
    callerUser = null,
    chainCfg = {},
    publicUrl = 'https://spray.land',
    mintLandDeedFn = null,
    autoBackfill = true
  }
) {
  await ensureLandDeedSchema(db);
  const cleanParcel = normalizeParcelId(parcelId);
  if (!cleanParcel) throw new McpServiceError('parcelId is required.', 400);

  let mintRes = null;
  if (autoBackfill) {
    mintRes = await ensureLandDeedMinted(db, {
      parcelId: cleanParcel,
      trigger: 'backfill',
      chainCfg,
      publicUrl,
      mintLandDeedFn
    });
  }

  const ctx = await loadParcelOwnerContext(db, cleanParcel);
  const eligibility = evaluateLandDeedEligibility(ctx);
  const deed = serializeLandDeedRow(ctx.deedRow);

  const [transferRows, activeListingRow, volume] = await Promise.all([
    db
      .all(
        `SELECT * FROM land_deed_transfers
         WHERE parcel_id = ?
         ORDER BY created_at DESC
         LIMIT 25`,
        [cleanParcel]
      )
      .catch(() => []),
    db
      .get(
        "SELECT * FROM land_marketplace_listings WHERE parcel_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        [cleanParcel]
      )
      .catch(() => null),
    db
      .get('SELECT * FROM land_volumes WHERE parcel_id = ?', [cleanParcel])
      .then((v) =>
        v
          ? {
              parcelId: v.parcel_id,
              centerLat: Number(v.center_lat || 0),
              centerLng: Number(v.center_lng || 0),
              widthMeters: Number(v.width_meters || 14),
              depthMeters: Number(v.depth_meters || 14),
              heightMeters: Number(v.height_meters || 18),
              footprintAreaSqm: Number(v.footprint_area_sqm || 196),
              volumeCubicM: Number(v.volume_cubic_m || 3528)
            }
          : null
      )
      .catch(() => null)
  ]);

  const ownerAddress = deed?.ownerAddress || resolveCanonicalParcelOwner(ctx).ownerAddress || '';
  const ownedArtworks = ownerAddress
    ? await listOwnedArtworksOnParcel(db, { parcelId: cleanParcel, ownerAddress })
    : [];
  const totalArtRow = await db
    .get('SELECT COUNT(*) AS c FROM sculptures WHERE parcel_id = ? AND hidden = 0', [cleanParcel])
    .catch(() => ({ c: 0 }));

  const isCallerOwner = doesUserOwnLandDeed(callerUser, ctx.deedRow, ctx.stewardRow, ctx.curationRow);

  return {
    parcelId: cleanParcel,
    displayName: resolveLandDisplayName({
      customName: ctx.curationRow?.custom_name || '',
      firstSculptureTitle: ctx.firstSculpture?.title || '',
      parcelId: cleanParcel
    }),
    eligible: eligibility.eligible,
    eligibilityStatus: eligibility.status,
    eligibilityReason: eligibility.reason,
    minted: Boolean(deed),
    justBackfilled: Boolean(mintRes?.minted),
    deed,
    isOwner: isCallerOwner,
    activeListing: serializeLandListingRow(activeListingRow),
    transfers: transferRows.map(serializeLandTransferRow),
    ownerOwnedArtworks: ownedArtworks,
    ownerOwnedArtworkCount: ownedArtworks.length,
    totalArtworkCount: Number(totalArtRow?.c || 0),
    thirdPartyArtworkCount: Math.max(0, Number(totalArtRow?.c || 0) - ownedArtworks.length),
    volume: volume || null
  };
}

export function buildLandDeedMetadata({ parcelId, displayName, description = '', deed, volume = null, artworkCount = 0, publicUrl = 'https://spray.land' }) {
  const cleanUrl = String(publicUrl || 'https://spray.land').replace(/\/$/, '');
  const encodedParcel = encodeURIComponent(parcelId);
  const attrs = [
    { trait_type: 'Parcel ID', value: parcelId },
    { trait_type: 'Collection', value: 'SPRAY.LAND Virtual Land Deeds' },
    { trait_type: 'Artworks Placed', display_type: 'number', value: Number(artworkCount || 0) },
    { trait_type: 'Land Steward Royalty', value: `${TRANSACTION_FEES.agentStewardBps / 100}%` },
    { trait_type: 'Human Contributor Pool', value: `${TRANSACTION_FEES.humanContributorBps / 100}%` },
    { trait_type: 'Platform Fee', value: `${TRANSACTION_FEES.platformBps / 100}%` }
  ];
  if (volume) {
    attrs.push(
      { trait_type: 'Width (m)', display_type: 'number', value: Number(volume.widthMeters || 0) },
      { trait_type: 'Length (m)', display_type: 'number', value: Number(volume.lengthMeters || 0) },
      { trait_type: 'Height (m)', display_type: 'number', value: Number(volume.heightMeters || 0) }
    );
  }
  return {
    name: `${displayName || parcelId} — Land Deed #${deed?.tokenId || '1'}`,
    description:
      description ||
      `Permanent SPRAY.LAND Virtual Land Deed NFT (${parcelId}). Grants curation ownership and future 3% Land Steward royalties on Robinhood Chain.`,
    image: `${cleanUrl}/api/lands/${encodedParcel}/og-image.svg`,
    external_url: `${cleanUrl}/?parcel=${encodedParcel}`,
    seller_fee_basis_points: TRANSACTION_FEES.totalFeeBps,
    owner: deed?.ownerAddress || '',
    token_id: deed?.tokenId || '',
    contract_address: deed?.contractAddress || '',
    chain_id: deed?.chainId || 46630,
    virtual_land_deed: {
      parcel_id: parcelId,
      owner: deed?.ownerAddress || '',
      original_steward: deed?.originalStewardAddress || '',
      mint_trigger: deed?.mintTrigger || 'awakened',
      minted_at: deed?.mintedAt || ''
    },
    attributes: attrs
  };
}
