import { ethers } from 'ethers';
import { STEWARD_DEFAULTS, TRANSACTION_FEES } from './constants.mjs';
import { resolveLandDisplayName } from './landVolume.mjs';
import { McpServiceError, checkSculptureOwnership, resolvePreferredOwnerWallet } from './mcp/helpers.mjs';
import { notifyLandMarketplaceSale } from './notificationService.mjs';

function weiToEthNumber(wei) {
  return Number(Number(ethers.formatEther(wei)).toFixed(8));
}

/**
 * Computes exact wei & ETH allocations on every transaction:
 * 5% Platform + 3% Agent Steward + 2% Pro-Rata Human Contributor Pool + 90% Seller Net.
 */
export function calculateFeeSplitBreakdown(
  grossAmountEth,
  { sellerAddress, platformAddress, agentStewardAddress = '', humanContributors = [] }
) {
  const numericGross = Number(grossAmountEth);
  if (!Number.isFinite(numericGross) || numericGross <= 0) {
    throw new McpServiceError('Listing/transaction amount in ETH must be greater than 0.', 400);
  }
  const normalizedGross = numericGross.toFixed(6).replace(/\.?0+$/, '') || '0';
  const grossWei = ethers.parseEther(normalizedGross);
  if (grossWei <= 0n) {
    throw new McpServiceError('Transaction wei amount must be positive.', 400);
  }

  const cleanPlatform = ethers.isAddress(platformAddress)
    ? ethers.getAddress(platformAddress)
    : '0x000000000000000000000000000000000000dEaD';
  const cleanSeller = ethers.isAddress(sellerAddress)
    ? ethers.getAddress(sellerAddress)
    : cleanPlatform;
  const cleanSteward = ethers.isAddress(agentStewardAddress)
    ? ethers.getAddress(agentStewardAddress)
    : cleanPlatform;

  const platformWei = (grossWei * BigInt(TRANSACTION_FEES.platformBps)) / 10000n;
  const agentStewardWei = (grossWei * BigInt(TRANSACTION_FEES.agentStewardBps)) / 10000n;
  const humanPoolWei = (grossWei * BigInt(TRANSACTION_FEES.humanContributorBps)) / 10000n;
  const sellerNetWei = grossWei - platformWei - agentStewardWei - humanPoolWei;

  const uniqueHumans = [];
  const seen = new Set();
  for (const h of humanContributors || []) {
    const addr = h?.address && ethers.isAddress(h.address) ? ethers.getAddress(h.address) : '';
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueHumans.push({
      userId: h.userId || '',
      name: h.name || 'IRL Artist',
      address: addr
    });
  }

  const perContributor = [];
  if (uniqueHumans.length > 0) {
    const baseShare = humanPoolWei / BigInt(uniqueHumans.length);
    let remainder = humanPoolWei - baseShare * BigInt(uniqueHumans.length);
    for (const contributor of uniqueHumans) {
      const shareWei = baseShare + (remainder > 0n ? 1n : 0n);
      if (remainder > 0n) remainder -= 1n;
      perContributor.push({
        userId: contributor.userId,
        name: contributor.name,
        address: contributor.address,
        bps: Math.round(TRANSACTION_FEES.humanContributorBps / uniqueHumans.length),
        amountWei: shareWei.toString(),
        amountEth: weiToEthNumber(shareWei)
      });
    }
  } else {
    perContributor.push({
      userId: '',
      name: 'Creator Fallback Pool',
      address: cleanSeller,
      bps: TRANSACTION_FEES.humanContributorBps,
      amountWei: humanPoolWei.toString(),
      amountEth: weiToEthNumber(humanPoolWei)
    });
  }

  return {
    grossEth: weiToEthNumber(grossWei),
    grossWei: grossWei.toString(),
    summary: '5% Platform · 3% Agent Steward · 2% Human Pool · 90% Seller',
    seller: {
      bps: TRANSACTION_FEES.sellerNetBps,
      percent: TRANSACTION_FEES.sellerNetBps / 100,
      address: cleanSeller,
      amountWei: sellerNetWei.toString(),
      amountEth: weiToEthNumber(sellerNetWei)
    },
    platform: {
      bps: TRANSACTION_FEES.platformBps,
      percent: TRANSACTION_FEES.platformBps / 100,
      address: cleanPlatform,
      amountWei: platformWei.toString(),
      amountEth: weiToEthNumber(platformWei)
    },
    agentSteward: {
      bps: TRANSACTION_FEES.agentStewardBps,
      percent: TRANSACTION_FEES.agentStewardBps / 100,
      address: cleanSteward,
      amountWei: agentStewardWei.toString(),
      amountEth: weiToEthNumber(agentStewardWei)
    },
    humanContributors: {
      bps: TRANSACTION_FEES.humanContributorBps,
      percent: TRANSACTION_FEES.humanContributorBps / 100,
      poolWei: humanPoolWei.toString(),
      poolEth: weiToEthNumber(humanPoolWei),
      contributorCount: perContributor.length,
      perContributor
    }
  };
}

/**
 * Fetches qualified IRL human artists on a parcel eligible for the pro-rata 2% Contributor Royalty Pool.
 */
export async function getParcelQualifiedHumanContributors(db, parcelId) {
  const cleanParcelId = String(parcelId || '').trim().toUpperCase();
  const rows = await db.all(
    `SELECT s.creator_sub AS userId,
            MAX(s.creator_name) AS name,
            MAX(COALESCE(NULLIF(u.custom_payout_address, ''), NULLIF(u.wallet_address, ''), s.recipient_address)) AS payoutAddress,
            MAX(s.voxel_count) AS maxVoxels,
            MAX(CASE WHEN m.sculpture_id IS NOT NULL THEN 1 ELSE 0 END) AS hasCustomModel,
            MAX(COALESCE(l.qual_contributor, 1)) AS qualFlag,
            MIN(s.created_at) AS firstContribAt
     FROM sculptures s
     LEFT JOIN users u ON u.id = s.creator_sub
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     WHERE s.parcel_id = ?
       AND s.hidden = 0
       AND s.creator_sub NOT LIKE 'agent:%'
       AND COALESCE(l.layer_role, 'artist_work') = 'artist_work'
     GROUP BY s.creator_sub
     ORDER BY firstContribAt ASC`,
    [cleanParcelId]
  );

  return (rows || [])
    .filter(
      (r) =>
        Number(r.qualFlag) === 1 &&
        (Number(r.hasCustomModel) === 1 || Number(r.maxVoxels || 0) >= STEWARD_DEFAULTS.minHumanPoolVoxels)
    )
    .map((r) => ({
      userId: r.userId,
      name: r.name || 'IRL Artist',
      address: r.payoutAddress || ''
    }))
    .filter((r) => ethers.isAddress(r.address));
}

async function resolveParcelStewardRecipient(db, parcelId, fallbackAddress) {
  const st = await db.get('SELECT * FROM land_steward_state WHERE parcel_id = ?', [parcelId]);
  if (st?.steward_address && ethers.isAddress(st.steward_address)) {
    return {
      stewardSub: st.steward_sub || '',
      stewardName: st.steward_name || 'Land Steward',
      stewardAddress: ethers.getAddress(st.steward_address),
      stewardType: st.steward_type || 'human'
    };
  }
  const lp = await db.get('SELECT * FROM land_parcels WHERE parcel_id = ?', [parcelId]);
  if (lp?.first_claimant_address && ethers.isAddress(lp.first_claimant_address)) {
    return {
      stewardSub: lp.first_claimant_sub || '',
      stewardName: 'Parcel Steward',
      stewardAddress: ethers.getAddress(lp.first_claimant_address),
      stewardType: String(lp.first_claimant_sub || '').startsWith('agent:') ? 'agent' : 'human'
    };
  }
  return {
    stewardSub: '',
    stewardName: 'Platform Steward',
    stewardAddress: fallbackAddress,
    stewardType: 'platform'
  };
}

/**
 * Lists an owned sculpture on the built-in Graffiland Marketplace with live 5%/3%/2% breakdown.
 */
export async function createMarketplaceListing(
  db,
  { sculptureId, sellerUser, priceEth, platformAddress }
) {
  const numericPrice = Number(priceEth);
  if (!Number.isFinite(numericPrice) || numericPrice < 0.0001 || numericPrice > 100000) {
    throw new McpServiceError('Price must be between 0.0001 and 100000 ETH.', 400);
  }
  const scRow = await checkSculptureOwnership(db, { sculptureId, user: sellerUser });
  const sellerAddress = resolvePreferredOwnerWallet(sellerUser) || scRow.recipient_address;

  const steward = await resolveParcelStewardRecipient(db, scRow.parcel_id, platformAddress);
  const contributors = await getParcelQualifiedHumanContributors(db, scRow.parcel_id);
  const splits = calculateFeeSplitBreakdown(numericPrice, {
    sellerAddress,
    platformAddress,
    agentStewardAddress: steward.stewardAddress,
    humanContributors: contributors
  });

  const now = new Date().toISOString();
  await db.run(
    `UPDATE marketplace_listings SET status = 'cancelled' WHERE sculpture_id = ? AND status = 'active'`,
    [scRow.id]
  );

  const listingId = `lst_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await db.run(
    `INSERT INTO marketplace_listings (
      id, sculpture_id, parcel_id, seller_sub, seller_name, seller_address,
      price_eth, price_wei, status, buyer_sub, buyer_address, tx_hash,
      split_breakdown_json, created_at, sold_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '', '', '', ?, ?, '')`,
    [
      listingId,
      scRow.id,
      scRow.parcel_id,
      sellerUser.id,
      sellerUser.name || scRow.creator_name || 'Seller',
      sellerAddress,
      splits.grossEth,
      splits.grossWei,
      JSON.stringify(splits),
      now
    ]
  );

  const listing = await db.get('SELECT * FROM marketplace_listings WHERE id = ?', [listingId]);
  return serializeListingRow(listing, scRow, steward);
}

function serializeListingRow(row, sculptureRow = null, steward = null) {
  const splits = row.split_breakdown_json ? JSON.parse(row.split_breakdown_json) : null;
  return {
    id: row.id,
    sculptureId: row.sculpture_id,
    parcelId: row.parcel_id,
    sellerSub: row.seller_sub,
    sellerName: row.seller_name,
    sellerAddress: row.seller_address,
    priceEth: Number(row.price_eth),
    priceWei: row.price_wei,
    status: row.status,
    buyerSub: row.buyer_sub || '',
    buyerAddress: row.buyer_address || '',
    txHash: row.tx_hash || '',
    splits,
    createdAt: row.created_at,
    soldAt: row.sold_at || '',
    ...(sculptureRow
      ? {
          sculptureTitle: sculptureRow.title,
          sculptureDescription: sculptureRow.description,
          previewDataUrl: sculptureRow.preview_data_url || '',
          tokenId: sculptureRow.token_id,
          layerRole: sculptureRow.layer_role || 'artist_work'
        }
      : {}),
    ...(steward
      ? {
          stewardName: steward.stewardName,
          stewardType: steward.stewardType,
          stewardAddress: steward.stewardAddress
        }
      : {})
  };
}

export async function listMarketplaceItems(db, { status = 'active', parcelId = '', limit = 60 } = {}) {
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    clauses.push('ml.status = ?');
    params.push(status);
  }
  if (parcelId) {
    clauses.push('ml.parcel_id = ?');
    params.push(String(parcelId).trim().toUpperCase());
  }
  clauses.push('s.hidden = 0');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.all(
    `SELECT ml.*, s.title AS sculpture_title, s.description AS sculpture_description,
            s.preview_data_url AS preview_data_url, s.token_id AS token_id, s.place_name AS place_name,
            COALESCE(pc.custom_name, '') AS parcel_custom_name,
            COALESCE(l.layer_role, 'artist_work') AS layer_role,
            st.steward_name, st.steward_type, st.steward_address,
            st.human_contributor_count
     FROM marketplace_listings ml
     JOIN sculptures s ON s.id = ml.sculpture_id
     LEFT JOIN parcel_curations pc ON pc.parcel_id = ml.parcel_id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     LEFT JOIN land_steward_state st ON st.parcel_id = ml.parcel_id
     ${where}
     ORDER BY ml.created_at DESC
     LIMIT ?`,
    [...params, Math.min(100, Math.max(1, Number(limit || 60)))]
  );

  return (rows || []).map((r) => ({
    ...serializeListingRow(r, {
      title: r.sculpture_title,
      description: r.sculpture_description,
      preview_data_url: r.preview_data_url,
      token_id: r.token_id,
      layer_role: r.layer_role
    }),
    parcelName: String(r.parcel_custom_name || '').trim(),
    landDisplayName: resolveLandDisplayName({
      customName: r.parcel_custom_name || '',
      firstSculptureTitle: r.sculpture_title || '',
      placeName: r.place_name || ''
    }),
    stewardName: r.steward_name || 'Parcel Steward',
    stewardType: r.steward_type || 'human',
    stewardAddress: r.steward_address || '',
    humanContributorCount: Number(r.human_contributor_count || 0)
  }));
}

export async function recordFeeLedgerSplit(
  db,
  { txType, parcelId, sculptureId = '', listingId = '', txHash = '', splits, stewardSub = '', stewardName = '' }
) {
  const now = new Date().toISOString();
  const entries = [
    ...(Number(splits.seller?.amountEth || 0) > 0 && splits.seller?.bps > 0
      ? [
          {
            role: 'seller',
            sub: '',
            name: 'Seller Net (90%)',
            address: splits.seller.address,
            bps: splits.seller.bps,
            amountEth: splits.seller.amountEth,
            amountWei: splits.seller.amountWei
          }
        ]
      : []),
    {
      role: 'platform',
      sub: 'platform:treasury',
      name: 'GRAFFILAND Treasury (5%)',
      address: splits.platform.address,
      bps: splits.platform.bps,
      amountEth: splits.platform.amountEth,
      amountWei: splits.platform.amountWei
    },
    {
      role: 'agent_steward',
      sub: stewardSub,
      name: stewardName || 'Land Steward (3%)',
      address: splits.agentSteward.address,
      bps: splits.agentSteward.bps,
      amountEth: splits.agentSteward.amountEth,
      amountWei: splits.agentSteward.amountWei
    },
    ...(splits.humanContributors?.perContributor || []).map((c) => ({
      role: 'human_contributor',
      sub: c.userId || '',
      name: `${c.name || 'IRL Contributor'} (2% Pool)`,
      address: c.address,
      bps: c.bps,
      amountEth: c.amountEth,
      amountWei: c.amountWei
    }))
  ];

  for (const e of entries) {
    await db.run(
      `INSERT INTO fee_ledger_entries (
        id, tx_type, parcel_id, sculpture_id, listing_id, recipient_role,
        recipient_sub, recipient_name, recipient_address, bps, amount_eth, amount_wei, tx_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        globalThis.crypto.randomUUID(),
        txType,
        parcelId,
        sculptureId,
        listingId,
        e.role,
        e.sub,
        e.name,
        e.address,
        e.bps,
        e.amountEth,
        e.amountWei,
        txHash,
        now
      ]
    );
  }
}

/**
 * Executes a marketplace buy with exact 5% Platform / 3% Agent Steward / 2% Pro-Rata Human Contributor settlement
 * and transfers NFT ownership to buyerAddress.
 */
export async function executeMarketplacePurchase(
  db,
  { listingId, buyerUser, buyerAddress = '', txHash = '', platformAddress }
) {
  const listing = await db.get('SELECT * FROM marketplace_listings WHERE id = ?', [listingId]);
  if (!listing) {
    throw new McpServiceError('Marketplace listing not found.', 404);
  }
  if (listing.status !== 'active') {
    throw new McpServiceError(`Marketplace listing is no longer active (${listing.status}).`, 409);
  }
  const scRow = await db.get('SELECT * FROM sculptures WHERE id = ?', [listing.sculpture_id]);
  if (!scRow || scRow.hidden) {
    throw new McpServiceError('Sculpture is unavailable.', 404);
  }

  const resolvedBuyer =
    buyerAddress && ethers.isAddress(buyerAddress)
      ? ethers.getAddress(buyerAddress)
      : resolvePreferredOwnerWallet(buyerUser);
  if (!resolvedBuyer) {
    throw new McpServiceError('A valid buyer EVM address is required.', 400);
  }
  if (resolvedBuyer.toLowerCase() === String(scRow.recipient_address || '').toLowerCase()) {
    throw new McpServiceError('Buyer already owns this sculpture.', 400);
  }

  const steward = await resolveParcelStewardRecipient(db, listing.parcel_id, platformAddress);
  const contributors = await getParcelQualifiedHumanContributors(db, listing.parcel_id);
  const splits = calculateFeeSplitBreakdown(listing.price_eth, {
    sellerAddress: listing.seller_address,
    platformAddress,
    agentStewardAddress: steward.stewardAddress,
    humanContributors: contributors
  });

  const now = new Date().toISOString();
  const effectiveTxHash =
    txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)
      ? txHash
      : ethers.keccak256(
          ethers.toUtf8Bytes(`market-buy:${listing.id}:${resolvedBuyer}:${now}`)
        );

  await db.run(
    `UPDATE marketplace_listings
     SET status = 'sold', buyer_sub = ?, buyer_address = ?, tx_hash = ?, split_breakdown_json = ?, sold_at = ?
     WHERE id = ?`,
    [buyerUser.id, resolvedBuyer, effectiveTxHash, JSON.stringify(splits), now, listing.id]
  );

  await db.run('UPDATE sculptures SET recipient_address = ? WHERE id = ?', [
    resolvedBuyer,
    scRow.id
  ]);

  await db.run(
    `INSERT INTO sculpture_transfers (
      id, sculpture_id, from_address, to_address, token_id, tx_hash, simulated, method, transferred_by_sub, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'marketplace_sale', ?, ?)`,
    [
      globalThis.crypto.randomUUID(),
      scRow.id,
      scRow.recipient_address,
      resolvedBuyer,
      scRow.token_id,
      effectiveTxHash,
      buyerUser.id,
      now
    ]
  );

  await recordFeeLedgerSplit(db, {
    txType: 'marketplace_sale',
    parcelId: listing.parcel_id,
    sculptureId: scRow.id,
    listingId: listing.id,
    txHash: effectiveTxHash,
    splits,
    stewardSub: steward.stewardSub,
    stewardName: steward.stewardName
  });

  await db.run(
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
  );

  if (steward.stewardSub && steward.stewardSub.startsWith('agent:')) {
    await db.run(
      'UPDATE agent_accounts SET total_xp = total_xp + 50, last_seen_at = ? WHERE agent_id = ?',
      [now, steward.stewardSub]
    );
  }

  try {
    await notifyLandMarketplaceSale(db, {
      parcelId: listing.parcel_id,
      sculptureId: scRow.id,
      sculptureTitle: scRow.title || 'Sculpture',
      buyerName: buyerUser?.name || 'A collector',
      sellerSub: listing.seller_sub || '',
      stewardSub: steward.stewardSub || '',
      priceEth: Number(listing.price_eth || 0)
    });
  } catch {
    // Non-fatal notification failure
  }

  return {
    purchased: true,
    listingId: listing.id,
    sculptureId: scRow.id,
    parcelId: listing.parcel_id,
    buyerAddress: resolvedBuyer,
    txHash: effectiveTxHash,
    splits
  };
}

export async function getEconomySplitsSummary(db, { parcelId = '', address = '' } = {}) {
  const cleanParcel = parcelId ? String(parcelId).trim().toUpperCase() : '';
  const cleanAddress = address && ethers.isAddress(address) ? ethers.getAddress(address) : '';

  const roleTotals = await db.all(
    `SELECT recipient_role AS role,
            COUNT(*) AS entryCount,
            COALESCE(SUM(amount_eth), 0) AS totalEth
     FROM fee_ledger_entries
     ${cleanParcel ? 'WHERE parcel_id = ?' : ''}
     GROUP BY recipient_role`,
    cleanParcel ? [cleanParcel] : []
  );

  const recentEntries = await db.all(
    `SELECT * FROM fee_ledger_entries
     ${
       cleanParcel && cleanAddress
         ? 'WHERE parcel_id = ? AND LOWER(recipient_address) = LOWER(?)'
         : cleanParcel
         ? 'WHERE parcel_id = ?'
         : cleanAddress
         ? 'WHERE LOWER(recipient_address) = LOWER(?)'
         : ''
     }
     ORDER BY created_at DESC
     LIMIT 50`,
    [...(cleanParcel ? [cleanParcel] : []), ...(cleanAddress ? [cleanAddress] : [])]
  );

  const byRole = Object.fromEntries(
    (roleTotals || []).map((r) => [
      r.role,
      { entryCount: Number(r.entryCount || 0), totalEth: Number(Number(r.totalEth || 0).toFixed(8)) }
    ])
  );

  return {
    policy: TRANSACTION_FEES,
    totalsByRole: {
      platform: byRole.platform || { entryCount: 0, totalEth: 0 },
      agentSteward: byRole.agent_steward || { entryCount: 0, totalEth: 0 },
      humanContributors: byRole.human_contributor || { entryCount: 0, totalEth: 0 },
      sellerNet: byRole.seller || { entryCount: 0, totalEth: 0 }
    },
    recentEntries: (recentEntries || []).map((e) => ({
      id: e.id,
      txType: e.tx_type,
      parcelId: e.parcel_id,
      sculptureId: e.sculpture_id,
      listingId: e.listing_id,
      role: e.recipient_role,
      recipientName: e.recipient_name,
      recipientAddress: e.recipient_address,
      bps: Number(e.bps),
      amountEth: Number(e.amount_eth),
      txHash: e.tx_hash,
      createdAt: e.created_at
    }))
  };
}
