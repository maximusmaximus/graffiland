import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ethers } from 'ethers';
import {
  buildMainnetGenesisSnapshot,
  buildMainnetRemapSql,
  ELIGIBILITY_TIERS,
  renderMainnetReadinessMarkdown,
  verifySnapshotIntegrity
} from '../shared/mainnetSnapshot.mjs';

const PROOF_A = ethers.keccak256(ethers.toUtf8Bytes('proof-a'));
const PROOF_B = ethers.keccak256(ethers.toUtf8Bytes('proof-b'));
const WALLET_BIGDOG = '0x1111111111111111111111111111111111111111';
const WALLET_MUFFKOR = '0x2222222222222222222222222222222222222222';
const WALLET_MUFFKOR_PAYOUT = '0x3333333333333333333333333333333333333333';

function sampleTestnetTables() {
  const futureIso = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
  return {
    users: [
      {
        id: 'u-bigdog',
        username: 'bigdog',
        name: 'Big Dog',
        email: 'bigdog-private@gmail.com',
        encrypted_wallet_json: '{"secret":"MUST_NEVER_LEAK"}',
        wallet_address: WALLET_BIGDOG,
        custom_payout_address: '',
        user_number: 1,
        created_at: '2026-11-01T00:00:00.000Z'
      },
      {
        id: 'u-muffkor',
        username: 'muffkor',
        name: 'David Elvion',
        email: 'muffkor-private@gmail.com',
        encrypted_wallet_json: '{"secret":"MUST_NEVER_LEAK_2"}',
        wallet_address: WALLET_MUFFKOR,
        custom_payout_address: WALLET_MUFFKOR_PAYOUT,
        user_number: 2,
        created_at: '2026-11-02T00:00:00.000Z'
      }
    ],
    parcels: [
      {
        parcel_id: 'GLAND-PERM0001',
        geohash: '9r165834',
        center_lat: 39.7283,
        center_lng: -121.8369,
        first_claimant_sub: 'u-bigdog',
        first_claimant_address: WALLET_BIGDOG,
        latest_claimant_address: WALLET_BIGDOG,
        sculpture_count: 1,
        updated_at: '2026-11-20T00:00:00.000Z'
      },
      {
        parcel_id: 'GLAND-BUILT002',
        geohash: 'u34du8th',
        center_lat: 52.52,
        center_lng: 13.405,
        first_claimant_sub: 'u-muffkor',
        first_claimant_address: WALLET_MUFFKOR,
        latest_claimant_address: WALLET_MUFFKOR,
        sculpture_count: 1,
        updated_at: '2026-11-24T00:00:00.000Z'
      },
      {
        parcel_id: 'GLAND-EMPTY003',
        geohash: '9r1652zf',
        center_lat: 39.73,
        center_lng: -121.84,
        first_claimant_sub: 'u-bigdog',
        first_claimant_address: WALLET_BIGDOG,
        latest_claimant_address: WALLET_BIGDOG,
        sculpture_count: 0,
        updated_at: '2026-11-24T00:00:00.000Z'
      },
      {
        parcel_id: 'GLAND-EXPIR004',
        geohash: '9r165999',
        center_lat: 39.74,
        center_lng: -121.85,
        first_claimant_sub: 'u-bigdog',
        first_claimant_address: WALLET_BIGDOG,
        latest_claimant_address: WALLET_BIGDOG,
        sculpture_count: 0,
        updated_at: '2026-10-01T00:00:00.000Z'
      }
    ],
    stewardStates: [
      {
        parcel_id: 'GLAND-PERM0001',
        steward_sub: 'u-bigdog',
        steward_address: WALLET_BIGDOG,
        steward_type: 'human',
        status: 'awakened',
        claimed_at: '2026-11-20T00:00:00.000Z',
        inactivity_expires_at: '',
        lease_expires_at: '',
        had_human_interaction: 1,
        last_human_interaction_type: 'irl_publish'
      },
      {
        parcel_id: 'GLAND-BUILT002',
        steward_sub: 'u-muffkor',
        steward_address: WALLET_MUFFKOR_PAYOUT,
        steward_type: 'human',
        status: 'awakened',
        claimed_at: '2026-11-24T00:00:00.000Z',
        inactivity_expires_at: futureIso,
        lease_expires_at: '',
        had_human_interaction: 0,
        last_human_interaction_type: ''
      },
      {
        parcel_id: 'GLAND-EMPTY003',
        steward_sub: 'u-bigdog',
        steward_address: WALLET_BIGDOG,
        steward_type: 'human',
        status: 'awakened',
        claimed_at: '2026-11-24T00:00:00.000Z',
        inactivity_expires_at: futureIso,
        lease_expires_at: '',
        had_human_interaction: 0,
        last_human_interaction_type: ''
      },
      {
        parcel_id: 'GLAND-EXPIR004',
        steward_sub: 'u-bigdog',
        steward_address: WALLET_BIGDOG,
        steward_type: 'agent',
        status: 'dormant',
        claimed_at: '2026-10-01T00:00:00.000Z',
        inactivity_expires_at: '',
        lease_expires_at: pastIso,
        had_human_interaction: 0,
        last_human_interaction_type: ''
      }
    ],
    curations: [
      { parcel_id: 'GLAND-PERM0001', custom_name: 'Twin Palms', curation_note: 'IRL flagship' },
      { parcel_id: 'GLAND-BUILT002', custom_name: 'alone in the woods', curation_note: 'Forest grove' },
      { parcel_id: 'GLAND-EMPTY003', custom_name: 'VERY FUNNY', curation_note: '' }
    ],
    volumes: [
      { parcel_id: 'GLAND-PERM0001', center_lat: 39.7283, center_lng: -121.8369, width_meters: 14, depth_meters: 14, height_meters: 12, z_scale: 1, rotation_deg: 0 },
      { parcel_id: 'GLAND-BUILT002', center_lat: 52.52, center_lng: 13.405, width_meters: 18, depth_meters: 18, height_meters: 14, z_scale: 1, rotation_deg: 15 }
    ],
    settings: [
      { parcel_id: 'GLAND-BUILT002', allow_agent_erase: 1, allow_contributor_edits: 1, freeze_placements: 0, require_approval: 0 }
    ],
    sculptures: [
      {
        id: 'sc-perm-1',
        title: 'Solar Arch',
        description: 'IRL beacon sculpture',
        creator_sub: 'u-bigdog',
        creator_name: '@bigdog',
        recipient_address: WALLET_BIGDOG,
        lat: 39.7283,
        lng: -121.8369,
        geohash: '9r165834',
        parcel_id: 'GLAND-PERM0001',
        voxel_count: 142,
        pol_score: 94,
        proof_hash: PROOF_A,
        ipfs_metadata_cid: 'QmMetaPerm11111111111111111111',
        ipfs_model_cid: 'QmModelPerm1111111111111111111',
        ipfs_image_cid: 'QmImgPerm111111111111111111111',
        ipfs_gateway_url: 'https://gateway.pinata.cloud/ipfs/QmMetaPerm11111111111111111111',
        chain_id: 46630,
        chain_name: 'Robinhood Chain Testnet',
        contract_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        token_id: '1',
        tx_hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        simulated_chain: 0,
        royalty_bps: 500,
        royalty_receiver: WALLET_BIGDOG,
        hidden: 0,
        created_at: '2026-11-20T01:00:00.000Z'
      },
      {
        id: 'sc-built-1',
        title: 'Ghost Mushroom Nursery',
        description: 'Guest collaborative piece',
        creator_sub: 'u-bigdog',
        creator_name: '@bigdog',
        recipient_address: WALLET_BIGDOG,
        lat: 52.52,
        lng: 13.405,
        geohash: 'u34du8th',
        parcel_id: 'GLAND-BUILT002',
        voxel_count: 0,
        pol_score: 75,
        proof_hash: PROOF_B,
        ipfs_metadata_cid: 'QmMetaBuilt2222222222222222222',
        ipfs_model_cid: 'QmModelBuilt222222222222222222',
        ipfs_image_cid: 'QmImgBuilt22222222222222222222',
        ipfs_gateway_url: 'https://gateway.pinata.cloud/ipfs/QmMetaBuilt2222222222222222222',
        chain_id: 46630,
        chain_name: 'Robinhood Chain Testnet',
        contract_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        token_id: '2',
        tx_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        simulated_chain: 0,
        royalty_bps: 500,
        royalty_receiver: WALLET_BIGDOG,
        hidden: 0,
        created_at: '2026-11-24T02:00:00.000Z'
      }
    ],
    sculptureModels: [
      {
        sculpture_id: 'sc-built-1',
        parcel_id: 'GLAND-BUILT002',
        model_format: 'glb',
        mime_type: 'model/gltf-binary',
        model_cid: 'QmModelBuilt222222222222222222',
        model_url: '',
        inline_b64: 'SHOULD_NEVER_BE_IN_SNAPSHOT',
        byte_length: 250000,
        scale: 1.2,
        rotation_y: 0
      }
    ]
  };
}

describe('Testnet-to-Mainnet Genesis Snapshot & Readiness Pipeline', () => {
  test('classifies tiers accurately, excludes PII/secrets, verifies SHA-256 integrity, and generates readiness report & SQL remap', async () => {
    const tables = sampleTestnetTables();
    const snap = await buildMainnetGenesisSnapshot({
      inclusionMode: 'built',
      ...tables
    });

    assert.equal(snap.targetNetwork.chainId, 4663);
    assert.equal(snap.summary.totalParcelsScanned, 4);
    assert.equal(snap.summary.tierCounts.permanent_irl, 1);
    assert.equal(snap.summary.tierCounts.built_active, 1);
    assert.equal(snap.summary.tierCounts.empty_unbuilt, 1);
    assert.equal(snap.summary.tierCounts.excluded, 1);
    assert.equal(snap.summary.eligibleParcelsCount, 2);
    assert.equal(snap.summary.eligibleSculpturesCount, 2);
    assert.equal(snap.readiness.readyForMainnetGenesis, true);
    assert.equal(snap.readiness.blockers.length, 0);

    // Strictly zero PII, encrypted wallets, or inline base64 blobs anywhere in serialized JSON
    const serialized = JSON.stringify(snap);
    assert.equal(serialized.includes('MUST_NEVER_LEAK'), false);
    assert.equal(serialized.includes('bigdog-private@gmail.com'), false);
    assert.equal(serialized.includes('SHOULD_NEVER_BE_IN_SNAPSHOT'), false);

    // Integrity check passes on pristine snapshot and fails on tamper
    const okCheck = await verifySnapshotIntegrity(snap);
    assert.equal(okCheck.valid, true);
    const tampered = structuredClone(snap);
    tampered.parcels[0].ownerWalletAddress = '0x9999999999999999999999999999999999999999';
    const badCheck = await verifySnapshotIntegrity(tampered);
    assert.equal(badCheck.valid, false);

    // Permanent-only inclusion mode includes ONLY permanent_irl
    const permSnap = await buildMainnetGenesisSnapshot({
      inclusionMode: 'permanent',
      ...tables
    });
    assert.equal(permSnap.summary.eligibleParcelsCount, 1);
    assert.equal(permSnap.parcels.find((p) => p.parcelId === 'GLAND-PERM0001').eligibilityTier, ELIGIBILITY_TIERS.PERMANENT_IRL);
    assert.equal(permSnap.parcels.find((p) => p.parcelId === 'GLAND-BUILT002').includedForGenesis, false);

    // Markdown report & SQL remap generation
    const md = renderMainnetReadinessMarkdown(snap);
    assert.match(md, /READY \(0 blockers\)/);
    assert.match(md, /GLAND-PERM0001/);
    assert.match(md, /GLAND-EMPTY003/);

    const sql = buildMainnetRemapSql({
      contractAddress: '0x4444444444444444444444444444444444444444',
      chainId: 4663,
      chainName: 'Robinhood Chain',
      mintedRecords: [
        {
          sculptureId: 'sc-perm-1',
          mainnetTokenId: '1',
          mainnetTxHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
        }
      ]
    });
    assert.match(sql, /SET chain_id = 4663/);
    assert.match(sql, /WHERE id = 'sc-perm-1'/);
  });
});
