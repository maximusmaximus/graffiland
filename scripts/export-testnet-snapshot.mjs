#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildMainnetGenesisSnapshot,
  renderMainnetReadinessMarkdown
} from '../shared/mainnetSnapshot.mjs';

function parseArgs(argv) {
  const args = {
    tier: 'built', // 'built' | 'permanent' | 'all-active'
    sqlite: '',
    outDir: path.resolve('snapshots'),
    uploadR2: false,
    r2Bucket: 'graffiland-media',
    wranglerConfig: path.resolve('worker/wrangler.toml'),
    d1Name: 'graffiland-db'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tier' && argv[i + 1]) args.tier = String(argv[++i]);
    else if (a === '--sqlite' && argv[i + 1]) args.sqlite = path.resolve(argv[++i]);
    else if (a === '--out-dir' && argv[i + 1]) args.outDir = path.resolve(argv[++i]);
    else if (a === '--upload-r2') args.uploadR2 = true;
    else if (a === '--r2-bucket' && argv[i + 1]) args.r2Bucket = String(argv[++i]);
    else if (a === '--d1-name' && argv[i + 1]) args.d1Name = String(argv[++i]);
  }
  return args;
}

function runWrangler(wranglerArgs) {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const out = execFileSync(cmd, ['wrangler', ...wranglerArgs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
  return out;
}

function queryRemoteD1(sql, args) {
  const raw = runWrangler([
    'd1',
    'execute',
    args.d1Name,
    '--remote',
    '--config',
    args.wranglerConfig,
    '--json',
    '--command',
    sql
  ]);
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) && parsed[0]?.results ? parsed[0].results : [];
}

function queryAllTablesFromRemoteD1(args) {
  // Strictly project ONLY public/non-PII columns — NEVER export encrypted_wallet_json or email!
  return {
    users: queryRemoteD1(
      'SELECT id, username, name, wallet_address, custom_payout_address, user_number, created_at FROM users;',
      args
    ),
    parcels: queryRemoteD1(
      'SELECT parcel_id, geohash, center_lat, center_lng, first_claimant_sub, first_claimant_address, latest_claimant_address, sculpture_count, updated_at FROM land_parcels;',
      args
    ),
    stewardStates: queryRemoteD1(
      'SELECT parcel_id, steward_sub, steward_address, steward_name, steward_type, status, claimed_at, lease_expires_at, awakened_at, last_human_interaction_at, last_human_interaction_type, inactivity_expires_at, had_human_interaction FROM land_steward_state;',
      args
    ),
    volumes: queryRemoteD1(
      'SELECT parcel_id, center_lat, center_lng, width_meters, depth_meters, height_meters, z_scale, rotation_deg FROM land_volumes;',
      args
    ),
    curations: queryRemoteD1(
      'SELECT parcel_id, owner_sub, custom_name, curation_note, featured_sculpture_id FROM parcel_curations;',
      args
    ),
    settings: queryRemoteD1(
      'SELECT parcel_id, allow_agent_erase, allow_contributor_edits, freeze_placements, require_approval FROM land_settings;',
      args
    ),
    contributors: queryRemoteD1(
      'SELECT parcel_id, contributor_sub, contributor_address, role, created_at FROM land_contributors;',
      args
    ),
    sculptures: queryRemoteD1(
      'SELECT id, title, description, creator_sub, creator_name, recipient_address, lat, lng, altitude, geohash, place_name, country, voxel_count, pol_score, proof_hash, preview_data_url, ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url, chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain, royalty_bps, royalty_receiver, hidden, created_at FROM sculptures WHERE hidden = 0;',
      args
    ),
    sculptureModels: queryRemoteD1(
      'SELECT sculpture_id, parcel_id, model_format, mime_type, model_url, model_cid, byte_length, scale, rotation_y FROM sculpture_models;',
      args
    ),
    sculptureAnchors: queryRemoteD1(
      'SELECT sculpture_id, dx, dy, dz, yaw FROM sculpture_anchors;',
      args
    )
  };
}

function queryAllTablesFromSqlite(sqlitePath) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const safeAll = (sql) => {
    try {
      return db.prepare(sql).all();
    } catch {
      return [];
    }
  };
  try {
    return {
      users: safeAll(
        'SELECT id, username, name, wallet_address, custom_payout_address, user_number, created_at FROM users'
      ),
      parcels: safeAll(
        'SELECT parcel_id, geohash, center_lat, center_lng, first_claimant_sub, first_claimant_address, latest_claimant_address, sculpture_count, updated_at FROM land_parcels'
      ),
      stewardStates: safeAll(
        'SELECT parcel_id, steward_sub, steward_address, steward_name, steward_type, status, claimed_at, lease_expires_at, awakened_at, last_human_interaction_at, last_human_interaction_type, inactivity_expires_at, had_human_interaction FROM land_steward_state'
      ),
      volumes: safeAll(
        'SELECT parcel_id, center_lat, center_lng, width_meters, depth_meters, height_meters, z_scale, rotation_deg FROM land_volumes'
      ),
      curations: safeAll(
        'SELECT parcel_id, owner_sub, custom_name, curation_note, featured_sculpture_id FROM parcel_curations'
      ),
      settings: safeAll(
        'SELECT parcel_id, allow_agent_erase, allow_contributor_edits, freeze_placements, require_approval FROM land_settings'
      ),
      contributors: safeAll(
        'SELECT parcel_id, contributor_sub, contributor_address, role, created_at FROM land_contributors'
      ),
      sculptures: safeAll(
        'SELECT id, title, description, creator_sub, creator_name, recipient_address, lat, lng, altitude, geohash, place_name, country, voxel_count, pol_score, proof_hash, preview_data_url, ipfs_metadata_cid, ipfs_model_cid, ipfs_image_cid, ipfs_gateway_url, chain_id, chain_name, contract_address, token_id, tx_hash, simulated_chain, royalty_bps, royalty_receiver, hidden, created_at FROM sculptures WHERE hidden = 0'
      ),
      sculptureModels: safeAll(
        'SELECT sculpture_id, parcel_id, model_format, mime_type, model_url, model_cid, byte_length, scale, rotation_y FROM sculpture_models'
      ),
      sculptureAnchors: safeAll('SELECT sculpture_id, dx, dy, dz, yaw FROM sculpture_anchors')
    };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[snapshot] Exporting ${args.sqlite ? `local SQLite (${args.sqlite})` : `remote D1 (${args.d1Name})`} with inclusion tier "${args.tier}"...`
  );

  const tables = args.sqlite
    ? queryAllTablesFromSqlite(args.sqlite)
    : queryAllTablesFromRemoteD1(args);

  const snapshot = await buildMainnetGenesisSnapshot({
    sourceNetwork: 'testnet',
    targetNetwork: 'mainnet',
    inclusionMode: args.tier,
    ...tables
  });

  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = snapshot.capturedAt.replace(/[:.]/g, '-');
  const versionedJsonPath = path.join(args.outDir, `mainnet-genesis-snapshot-${stamp}.json`);
  const latestJsonPath = path.join(args.outDir, 'mainnet-genesis-latest.json');
  const reportMdPath = path.join(args.outDir, 'mainnet-genesis-report.md');

  const jsonBody = `${JSON.stringify(snapshot, null, 2)}\n`;
  const mdBody = renderMainnetReadinessMarkdown(snapshot);

  fs.writeFileSync(versionedJsonPath, jsonBody, 'utf8');
  fs.writeFileSync(latestJsonPath, jsonBody, 'utf8');
  fs.writeFileSync(reportMdPath, mdBody, 'utf8');

  console.log(`[snapshot] Wrote ${versionedJsonPath}`);
  console.log(`[snapshot] Wrote ${latestJsonPath}`);
  console.log(`[snapshot] Wrote ${reportMdPath}`);
  console.log(
    `[snapshot] Summary: ${snapshot.summary.eligibleParcelsCount}/${snapshot.summary.totalParcelsScanned} parcels eligible, ${snapshot.summary.eligibleSculpturesCount} sculptures, ${snapshot.summary.uniqueRecipientWallets} unique wallets, SHA-256=${snapshot.manifestSha256}`
  );
  console.log(
    `[snapshot] Mainnet readiness: ${snapshot.readiness.readyForMainnetGenesis ? 'READY (0 blockers)' : `BLOCKED (${snapshot.readiness.blockers.length} blockers)`}`
  );

  if (args.uploadR2) {
    const r2Key = `snapshots/mainnet-genesis-snapshot-${stamp}.json`;
    const r2LatestKey = 'snapshots/mainnet-genesis-latest.json';
    console.log(`[snapshot] Archiving private snapshot to R2 ${args.r2Bucket}/${r2Key}...`);
    runWrangler([
      'r2',
      'object',
      'put',
      `${args.r2Bucket}/${r2Key}`,
      '--remote',
      '--file',
      versionedJsonPath,
      '--content-type',
      'application/json'
    ]);
    runWrangler([
      'r2',
      'object',
      'put',
      `${args.r2Bucket}/${r2LatestKey}`,
      '--remote',
      '--file',
      latestJsonPath,
      '--content-type',
      'application/json'
    ]);
    console.log(`[snapshot] Archived to R2: ${args.r2Bucket}/${r2Key} and ${r2LatestKey}`);
  }
}

main().catch((err) => {
  console.error('[snapshot] Failed:', err?.message || err);
  process.exit(1);
});
