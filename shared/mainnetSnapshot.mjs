import { ethers } from 'ethers';
import { ROBINHOOD_NETWORKS, TRANSACTION_FEES } from './constants.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 'sprayland.mainnet-genesis.v1';

export const ELIGIBILITY_TIERS = {
  PERMANENT_IRL: 'permanent_irl',
  BUILT_ACTIVE: 'built_active',
  EMPTY_UNBUILT: 'empty_unbuilt',
  EXCLUDED: 'excluded'
};

const BYTES32_HEX_RE = /^0x[a-fA-F0-9]{64}$/;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export async function sha256HexUtf8(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeWalletAddress(addr) {
  const raw = String(addr || '').trim();
  if (!raw || !ethers.isAddress(raw)) return '';
  return ethers.getAddress(raw);
}

export function resolveParcelBytes32(parcelId) {
  const clean = String(parcelId || '').trim().toUpperCase();
  return ethers.keccak256(ethers.toUtf8Bytes(clean));
}

function isIsoExpired(iso, nowMs) {
  const clean = String(iso || '').trim();
  if (!clean) return false;
  const ts = Date.parse(clean);
  return Number.isFinite(ts) && ts <= nowMs;
}

/**
 * Classifies a testnet parcel into its mainnet genesis eligibility tier.
 */
export function classifyParcelForMainnet(parcel, visibleSculptures = [], { nowMs = Date.now() } = {}) {
  const status = String(parcel.stewardStatus || 'awakened').toLowerCase();
  if (status === 'archived' || status === 'reclaimed') {
    return {
      tier: ELIGIBILITY_TIERS.EXCLUDED,
      reason: `Parcel status is "${status}"`
    };
  }
  if (isIsoExpired(parcel.leaseExpiresAt, nowMs) || isIsoExpired(parcel.inactivityExpiresAt, nowMs)) {
    return {
      tier: ELIGIBILITY_TIERS.EXCLUDED,
      reason: 'Parcel lease/inactivity timer already expired'
    };
  }

  const artCount = Array.isArray(visibleSculptures) ? visibleSculptures.length : 0;
  const hadIrl = Boolean(parcel.hadHumanInteraction);
  const noExpiry = !String(parcel.inactivityExpiresAt || '').trim() && !String(parcel.leaseExpiresAt || '').trim();

  if (artCount > 0 && hadIrl && noExpiry) {
    return {
      tier: ELIGIBILITY_TIERS.PERMANENT_IRL,
      reason: 'Permanent IRL human art-minted parcel (no expiry timer)'
    };
  }

  if (artCount > 0) {
    return {
      tier: ELIGIBILITY_TIERS.BUILT_ACTIVE,
      reason: hadIrl
        ? 'Active parcel with built 3D artwork & verified IRL visit (28d timer active until IRL art)'
        : 'Active parcel with built on-chain 3D artwork (eligible in built genesis tier; add IRL AR art for permanent status)'
    };
  }

  return {
    tier: ELIGIBILITY_TIERS.EMPTY_UNBUILT,
    reason: 'Pre-claimed land with 0 visible artworks — add artwork before snapshot cutoff to include in built genesis mint'
  };
}

/**
 * Checks whether a parcel tier is included under the selected genesis inclusion mode.
 *  - 'permanent'  -> ONLY permanent_irl
 *  - 'built'      -> permanent_irl + built_active (default)
 *  - 'all-active' -> permanent_irl + built_active + empty_unbuilt
 */
export function isTierIncludedInMode(tier, inclusionMode = 'built') {
  const mode = String(inclusionMode || 'built').toLowerCase();
  if (mode === 'permanent') return tier === ELIGIBILITY_TIERS.PERMANENT_IRL;
  if (mode === 'all-active') {
    return (
      tier === ELIGIBILITY_TIERS.PERMANENT_IRL ||
      tier === ELIGIBILITY_TIERS.BUILT_ACTIVE ||
      tier === ELIGIBILITY_TIERS.EMPTY_UNBUILT
    );
  }
  return tier === ELIGIBILITY_TIERS.PERMANENT_IRL || tier === ELIGIBILITY_TIERS.BUILT_ACTIVE;
}

/**
 * Builds a deterministic, zero-PII, checksummed Testnet -> Mainnet Genesis Snapshot.
 */
export async function buildMainnetGenesisSnapshot({
  sourceNetwork = 'testnet',
  targetNetwork = 'mainnet',
  inclusionMode = 'built',
  capturedAt = new Date().toISOString(),
  nowMs = Date.now(),
  users = [],
  parcels = [],
  stewardStates = [],
  volumes = [],
  curations = [],
  settings = [],
  contributors = [],
  sculptures = [],
  sculptureModels = [],
  sculptureAnchors = []
}) {
  const userById = new Map();
  for (const u of users || []) {
    if (!u?.id) continue;
    const payoutWallet = normalizeWalletAddress(u.custom_payout_address || u.wallet_address);
    const embeddedWallet = normalizeWalletAddress(u.wallet_address);
    userById.set(String(u.id), {
      id: String(u.id),
      handle: u.username ? `@${String(u.username).trim()}` : '',
      userNumber: Number(u.user_number || 0),
      walletAddress: embeddedWallet,
      payoutAddress: payoutWallet || embeddedWallet,
      createdAt: String(u.created_at || '')
    });
  }

  const stewardByParcel = new Map((stewardStates || []).map((r) => [String(r.parcel_id).toUpperCase(), r]));
  const volumeByParcel = new Map((volumes || []).map((r) => [String(r.parcel_id).toUpperCase(), r]));
  const curationByParcel = new Map((curations || []).map((r) => [String(r.parcel_id).toUpperCase(), r]));
  const settingsByParcel = new Map((settings || []).map((r) => [String(r.parcel_id).toUpperCase(), r]));
  const modelBySculpture = new Map((sculptureModels || []).map((r) => [String(r.sculpture_id), r]));
  const anchorBySculpture = new Map((sculptureAnchors || []).map((r) => [String(r.sculpture_id), r]));

  const contributorsByParcel = new Map();
  for (const c of contributors || []) {
    const pid = String(c.parcel_id || '').toUpperCase();
    if (!pid) continue;
    if (!contributorsByParcel.has(pid)) contributorsByParcel.set(pid, []);
    const u = userById.get(String(c.contributor_sub || ''));
    contributorsByParcel.get(pid).push({
      handle: u?.handle || '',
      walletAddress: normalizeWalletAddress(c.contributor_address || u?.payoutAddress || ''),
      role: String(c.role || (Number(c.can_edit_sculptures ?? 1) ? 'contributor' : 'viewer')),
      addedAt: String(c.created_at || '')
    });
  }

  const sculpturesByParcel = new Map();
  for (const s of sculptures || []) {
    if (Number(s.hidden || 0) !== 0) continue;
    const pid = String(s.parcel_id || '').toUpperCase();
    if (!pid) continue;
    if (!sculpturesByParcel.has(pid)) sculpturesByParcel.set(pid, []);

    const creator = userById.get(String(s.creator_sub || ''));
    const recipientAddress = normalizeWalletAddress(s.recipient_address || creator?.payoutAddress || '');
    const model = modelBySculpture.get(String(s.id));
    const anchor = anchorBySculpture.get(String(s.id));
    const metadataCid = String(s.ipfs_metadata_cid || '').trim();
    const lat = Number(s.lat);
    const lng = Number(s.lng);

    sculpturesByParcel.get(pid).push({
      sculptureId: String(s.id),
      parcelId: pid,
      landParcelBytes32: resolveParcelBytes32(pid),
      title: String(s.title || ''),
      description: String(s.description || ''),
      artistHandle: creator?.handle || String(s.creator_name || ''),
      recipientAddress,
      lat,
      lng,
      latE6: Number.isFinite(lat) ? Math.round(lat * 1e6) : 0,
      lngE6: Number.isFinite(lng) ? Math.round(lng * 1e6) : 0,
      altitude: s.altitude != null ? Number(s.altitude) : null,
      geohash: String(s.geohash || ''),
      placeName: String(s.place_name || ''),
      country: String(s.country || ''),
      voxelCount: Number(s.voxel_count || 0),
      polScore: Number(s.pol_score || 0),
      proofHash: String(s.proof_hash || ''),
      ipfsMetadataCid: metadataCid,
      ipfsModelCid: String(s.ipfs_model_cid || '').trim(),
      ipfsImageCid: String(s.ipfs_image_cid || '').trim(),
      ipfsGatewayUrl: String(s.ipfs_gateway_url || '').trim(),
      metadataUri: metadataCid ? `ipfs://${metadataCid}` : '',
      previewUrl:
        String(s.preview_data_url || '').startsWith('http') ? String(s.preview_data_url) : '',
      customModel: model
        ? {
            format: String(model.model_format || 'glb'),
            mimeType: String(model.mime_type || 'model/gltf-binary'),
            modelCid: String(model.model_cid || ''),
            modelUrl: String(model.model_url || ''),
            byteLength: Number(model.byte_length || 0),
            scale: Number(model.scale ?? 1),
            rotationY: Number(model.rotation_y ?? 0)
          }
        : null,
      anchorOffset: anchor
        ? {
            dx: Number(anchor.dx ?? 0),
            dy: Number(anchor.dy ?? 0),
            dz: Number(anchor.dz ?? 0),
            yaw: Number(anchor.yaw ?? 0)
          }
        : null,
      testnet: {
        chainId: Number(s.chain_id || ROBINHOOD_NETWORKS.testnet.chainId),
        chainName: String(s.chain_name || ROBINHOOD_NETWORKS.testnet.name),
        contractAddress: String(s.contract_address || ''),
        tokenId: String(s.token_id || ''),
        txHash: String(s.tx_hash || ''),
        simulatedChain: Number(s.simulated_chain || 0) !== 0
      },
      royaltyBps: Number(s.royalty_bps ?? TRANSACTION_FEES.platformBps),
      royaltyReceiver: normalizeWalletAddress(s.royalty_receiver || ''),
      createdAt: String(s.created_at || '')
    });
  }

  for (const list of sculpturesByParcel.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sculptureId.localeCompare(b.sculptureId));
  }

  const allParcels = [];
  const sortedRawParcels = [...(parcels || [])].sort((a, b) =>
    String(a.parcel_id || '').localeCompare(String(b.parcel_id || ''))
  );

  for (const lp of sortedRawParcels) {
    const pid = String(lp.parcel_id || '').toUpperCase();
    if (!pid) continue;
    const st = stewardByParcel.get(pid) || null;
    const vol = volumeByParcel.get(pid) || null;
    const cur = curationByParcel.get(pid) || null;
    const set = settingsByParcel.get(pid) || null;
    const scList = sculpturesByParcel.get(pid) || [];

    const ownerSub = String(st?.steward_sub || cur?.owner_sub || lp.first_claimant_sub || '');
    const ownerUser = userById.get(ownerSub) || null;
    const ownerWallet = normalizeWalletAddress(
      st?.steward_address || ownerUser?.payoutAddress || lp.first_claimant_address || ''
    );
    const centerLat = Number(vol?.center_lat ?? lp.center_lat);
    const centerLng = Number(vol?.center_lng ?? lp.center_lng);

    const baseParcel = {
      parcelId: pid,
      landParcelBytes32: resolveParcelBytes32(pid),
      geohash: String(lp.geohash || ''),
      centerLat,
      centerLng,
      latE6: Number.isFinite(centerLat) ? Math.round(centerLat * 1e6) : 0,
      lngE6: Number.isFinite(centerLng) ? Math.round(centerLng * 1e6) : 0,
      customName: String(cur?.custom_name || ''),
      description: String(cur?.curation_note || ''),
      featuredSculptureId: String(cur?.featured_sculpture_id || ''),
      ownerHandle: ownerUser?.handle || '',
      ownerWalletAddress: ownerWallet,
      stewardType: String(st?.steward_type || 'human'),
      stewardStatus: String(st?.status || 'awakened'),
      hadHumanInteraction: Number(st?.had_human_interaction || 0) !== 0,
      lastHumanInteractionType: String(st?.last_human_interaction_type || ''),
      claimedAt: String(st?.claimed_at || lp.updated_at || ''),
      awakenedAt: String(st?.awakened_at || ''),
      inactivityExpiresAt: String(st?.inactivity_expires_at || ''),
      leaseExpiresAt: String(st?.lease_expires_at || ''),
      volume: vol
        ? {
            widthMeters: Number(vol.width_meters),
            depthMeters: Number(vol.depth_meters),
            heightMeters: Number(vol.height_meters),
            zScale: Number(vol.z_scale ?? 1),
            rotationDeg: Number(vol.rotation_deg ?? 0)
          }
        : null,
      settings: {
        frozen: Boolean(set?.freeze_placements),
        requireApproval: Boolean(set?.require_approval),
        allowContributorEdits: set ? Boolean(set.allow_contributor_edits) : true,
        allowAgentErase: set ? Boolean(set.allow_agent_erase) : true
      },
      contributors: contributorsByParcel.get(pid) || [],
      visibleSculptureCount: scList.length
    };

    const classification = classifyParcelForMainnet(baseParcel, scList, { nowMs });
    const includedForGenesis = isTierIncludedInMode(classification.tier, inclusionMode);

    allParcels.push({
      ...baseParcel,
      eligibilityTier: classification.tier,
      eligibilityReason: classification.reason,
      includedForGenesis,
      sculptures: scList
    });
  }

  const eligibleParcels = allParcels.filter((p) => p.includedForGenesis);
  const eligibleSculptures = eligibleParcels.flatMap((p) => p.sculptures);
  const tierCounts = {
    permanent_irl: allParcels.filter((p) => p.eligibilityTier === ELIGIBILITY_TIERS.PERMANENT_IRL).length,
    built_active: allParcels.filter((p) => p.eligibilityTier === ELIGIBILITY_TIERS.BUILT_ACTIVE).length,
    empty_unbuilt: allParcels.filter((p) => p.eligibilityTier === ELIGIBILITY_TIERS.EMPTY_UNBUILT).length,
    excluded: allParcels.filter((p) => p.eligibilityTier === ELIGIBILITY_TIERS.EXCLUDED).length
  };

  const uniqueWallets = new Set();
  for (const p of eligibleParcels) {
    if (p.ownerWalletAddress) uniqueWallets.add(p.ownerWalletAddress.toLowerCase());
    for (const s of p.sculptures) {
      if (s.recipientAddress) uniqueWallets.add(s.recipientAddress.toLowerCase());
    }
  }

  const canonicalCore = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sourceNetwork: ROBINHOOD_NETWORKS[sourceNetwork] || ROBINHOOD_NETWORKS.testnet,
    targetNetwork: ROBINHOOD_NETWORKS[targetNetwork] || ROBINHOOD_NETWORKS.mainnet,
    inclusionMode,
    parcels: allParcels
  };
  const manifestSha256 = await sha256HexUtf8(stableStringify(canonicalCore));

  const snapshot = {
    ...canonicalCore,
    capturedAt,
    manifestSha256,
    summary: {
      totalParcelsScanned: allParcels.length,
      eligibleParcelsCount: eligibleParcels.length,
      eligibleSculpturesCount: eligibleSculptures.length,
      uniqueRecipientWallets: uniqueWallets.size,
      tierCounts
    }
  };

  snapshot.readiness = evaluateMainnetReadiness(snapshot);
  return snapshot;
}

export async function verifySnapshotIntegrity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { valid: false, reason: 'Missing snapshot object' };
  }
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return { valid: false, reason: `Unsupported schemaVersion: ${snapshot.schemaVersion}` };
  }
  const core = {
    schemaVersion: snapshot.schemaVersion,
    sourceNetwork: snapshot.sourceNetwork,
    targetNetwork: snapshot.targetNetwork,
    inclusionMode: snapshot.inclusionMode,
    parcels: snapshot.parcels
  };
  const computed = await sha256HexUtf8(stableStringify(core));
  if (computed !== snapshot.manifestSha256) {
    return {
      valid: false,
      reason: `Checksum mismatch (expected ${snapshot.manifestSha256}, computed ${computed})`
    };
  }
  return { valid: true, manifestSha256: computed };
}

/**
 * Audits snapshot data for mainnet cutover blockers, warnings, and estimated gas budget.
 */
export function evaluateMainnetReadiness(snapshot) {
  const blockers = [];
  const warnings = [];
  const parcels = Array.isArray(snapshot?.parcels) ? snapshot.parcels : [];
  const eligible = parcels.filter((p) => p.includedForGenesis);
  const emptyUnbuilt = parcels.filter((p) => p.eligibilityTier === ELIGIBILITY_TIERS.EMPTY_UNBUILT);

  let mintTxCount = 0;
  let awakenTxCount = 0;
  let simulatedCount = 0;
  let customModelCount = 0;

  for (const p of eligible) {
    if (!p.ownerWalletAddress || !ethers.isAddress(p.ownerWalletAddress)) {
      blockers.push(`Parcel ${p.parcelId} ("${p.customName || 'Unnamed'}") has invalid ownerWalletAddress`);
    }
    if (p.eligibilityTier === ELIGIBILITY_TIERS.PERMANENT_IRL) {
      awakenTxCount += 1;
    }
    for (const s of p.sculptures || []) {
      mintTxCount += 1;
      if (s.customModel) customModelCount += 1;
      if (!s.recipientAddress || !ethers.isAddress(s.recipientAddress)) {
        blockers.push(`Sculpture ${s.sculptureId} ("${s.title}") has invalid recipientAddress`);
      }
      if (!s.ipfsMetadataCid || !s.metadataUri.startsWith('ipfs://')) {
        blockers.push(`Sculpture ${s.sculptureId} ("${s.title}") is missing a pinned ipfsMetadataCid`);
      }
      if (!BYTES32_HEX_RE.test(String(s.proofHash || ''))) {
        blockers.push(`Sculpture ${s.sculptureId} ("${s.title}") has invalid bytes32 proofHash`);
      }
      if (s.testnet?.simulatedChain) {
        simulatedCount += 1;
        warnings.push(`Sculpture ${s.sculptureId} ("${s.title}") was simulated on testnet (will mint real on mainnet)`);
      }
    }
  }

  for (const p of emptyUnbuilt) {
    warnings.push(
      `Empty unbuilt land ${p.parcelId} ("${p.customName || 'Unnamed'}", ${p.ownerHandle || 'owner'}) has 0 artworks — excluded from "${snapshot.inclusionMode}" genesis mint unless art is placed before cutoff`
    );
  }

  // Conservative Arbitrum/OP-style L2 gas budgeting (260k gas per ERC-721 mint + 140k per land awaken)
  const estimatedGasUnits = mintTxCount * 260000 + awakenTxCount * 140000 + 3_200_000; // +3.2M contract deploy
  const estimatedEthAt1Gwei = Number(((estimatedGasUnits * 1e-9) * 1.5).toFixed(6));

  return {
    readyForMainnetGenesis: blockers.length === 0 && eligible.length > 0,
    blockers,
    warnings,
    metrics: {
      eligibleParcels: eligible.length,
      eligibleSculptures: mintTxCount,
      permanentIrlParcels: awakenTxCount,
      custom3dModelSculptures: customModelCount,
      simulatedTestnetSculptures: simulatedCount,
      emptyUnbuiltParcels: emptyUnbuilt.length,
      estimatedGasUnits,
      recommendedRelayerEthBuffer: Math.max(0.02, estimatedEthAt1Gwei)
    }
  };
}

/**
 * Generates a human-readable Markdown readiness report for mainnet launch sign-off.
 */
export function renderMainnetReadinessMarkdown(snapshot) {
  const s = snapshot.summary;
  const r = snapshot.readiness || evaluateMainnetReadiness(snapshot);
  const lines = [
    '# SPRAY.LAND — Testnet-to-Mainnet Genesis Snapshot Report',
    '',
    `- **Captured At**: \`${snapshot.capturedAt}\``,
    `- **Source Network**: ${snapshot.sourceNetwork.name} (\`chainId: ${snapshot.sourceNetwork.chainId}\`)`,
    `- **Target Network**: ${snapshot.targetNetwork.name} (\`chainId: ${snapshot.targetNetwork.chainId}\`)`,
    `- **Inclusion Mode**: \`${snapshot.inclusionMode}\``,
    `- **Integrity SHA-256**: \`${snapshot.manifestSha256}\``,
    `- **Mainnet Readiness**: ${r.readyForMainnetGenesis ? '✅ **READY (0 blockers)**' : `❌ **BLOCKED (${r.blockers.length} blockers)**`}`,
    '',
    '## Summary',
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Total Active Parcels Scanned | ${s.totalParcelsScanned} |`,
    `| Tier A — Permanent IRL Art-Minted Parcels | ${s.tierCounts.permanent_irl} |`,
    `| Tier B — Built Active Parcels (≥1 On-Chain Art) | ${s.tierCounts.built_active} |`,
    `| Tier C — Empty Pre-Claimed Parcels (0 Art) | ${s.tierCounts.empty_unbuilt} |`,
    `| Excluded / Archived / Expired | ${s.tierCounts.excluded} |`,
    `| **Eligible Genesis Parcels** | **${s.eligibleParcelsCount}** |`,
    `| **Eligible Genesis Sculptures to Mint** | **${s.eligibleSculpturesCount}** |`,
    `| Unique Artist / Land Holder Wallets | ${s.uniqueRecipientWallets} |`,
    `| Recommended Relayer ETH Buffer (Deploy + Genesis) | ${r.metrics.recommendedRelayerEthBuffer} ETH |`,
    '',
    '## Parcel Eligibility Breakdown',
    '',
    '| Parcel ID | Name | Owner | Tier | Artworks | Included | Notes |',
    '|---|---|---|---|---:|:---:|---|'
  ];

  for (const p of snapshot.parcels) {
    const label = p.customName || '(Unnamed)';
    lines.push(
      `| \`${p.parcelId}\` | ${label} | ${p.ownerHandle || p.ownerWalletAddress.slice(0, 10)} | \`${p.eligibilityTier}\` | ${p.visibleSculptureCount} | ${p.includedForGenesis ? '✅' : '⏭️'} | ${p.eligibilityReason} |`
    );
  }

  if (r.blockers.length > 0) {
    lines.push('', '## ❌ Blockers (Must Fix Before Mainnet Cutover)', '');
    for (const b of r.blockers) lines.push(`- ${b}`);
  }
  if (r.warnings.length > 0) {
    lines.push('', '## ⚠️ Pre-Cutover Notes & Warnings', '');
    for (const w of r.warnings) lines.push(`- ${w}`);
  }

  lines.push(
    '',
    '## Mainnet Cutover Runbook',
    '',
    '1. Fund relayer wallet on **Robinhood Chain Mainnet (`chainId: 4663`)** with at least `0.05 ETH`.',
    '2. Deploy contracts to mainnet: `ROBINHOOD_NETWORK=mainnet npm run contract:deploy`.',
    '3. Verify dry-run replay: `ROBINHOOD_NETWORK=mainnet ROBINHOOD_CONTRACT_ADDRESS=0x... npm run mainnet:replay:dry`.',
    '4. Execute idempotent genesis replay: `ROBINHOOD_NETWORK=mainnet ROBINHOOD_CONTRACT_ADDRESS=0x... node scripts/replay-mainnet-genesis.mjs --execute --confirm-mainnet-chain-4663`.',
    '5. Apply generated `snapshots/mainnet-db-remap.sql` to D1 and flip `ROBINHOOD_NETWORK = "mainnet"` + `ROBINHOOD_CONTRACT_ADDRESS` on the Cloudflare Worker.',
    ''
  );
  return lines.join('\n');
}

function sqlEscape(val) {
  return String(val ?? '').replace(/'/g, "''");
}

/**
 * Generates idempotent D1 SQL statements to update replayed sculptures to Mainnet coordinates.
 */
export function buildMainnetRemapSql({ contractAddress, chainId = 4663, chainName = 'Robinhood Chain', mintedRecords = [] }) {
  const lines = [
    '-- SPRAY.LAND Mainnet Genesis D1 Remap SQL',
    `-- Target Contract: ${contractAddress} (chainId ${chainId})`,
    `-- Generated At: ${new Date().toISOString()}`,
    ''
  ];
  for (const rec of mintedRecords) {
    lines.push(
      `UPDATE sculptures SET chain_id = ${Number(chainId)}, chain_name = '${sqlEscape(chainName)}', contract_address = '${sqlEscape(contractAddress)}', token_id = '${sqlEscape(rec.mainnetTokenId)}', tx_hash = '${sqlEscape(rec.mainnetTxHash)}', simulated_chain = 0 WHERE id = '${sqlEscape(rec.sculptureId)}';`
    );
  }
  return `${lines.join('\n')}\n`;
}
