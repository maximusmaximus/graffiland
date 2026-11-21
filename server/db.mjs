import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from './config.mjs';

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(CONFIG.dbPath), { recursive: true });
  const db = new DatabaseSync(CONFIG.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT DEFAULT '',
      wallet_address TEXT NOT NULL,
      encrypted_wallet_json TEXT NOT NULL,
      custom_payout_address TEXT DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sculptures (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      creator_sub TEXT NOT NULL,
      creator_name TEXT NOT NULL,
      creator_email TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      altitude REAL,
      accuracy REAL,
      heading REAL,
      parcel_id TEXT NOT NULL,
      geohash TEXT NOT NULL,
      place_name TEXT DEFAULT '',
      country TEXT DEFAULT '',
      timezone TEXT DEFAULT '',
      voxels_json TEXT NOT NULL,
      voxel_count INTEGER NOT NULL,
      pol_score INTEGER NOT NULL,
      pol_json TEXT NOT NULL,
      proof_hash TEXT NOT NULL,
      preview_data_url TEXT DEFAULT '',
      ipfs_metadata_cid TEXT NOT NULL,
      ipfs_model_cid TEXT NOT NULL,
      ipfs_image_cid TEXT NOT NULL,
      ipfs_gateway_url TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      chain_name TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      token_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      simulated_chain INTEGER NOT NULL DEFAULT 0,
      royalty_bps INTEGER NOT NULL DEFAULT 500,
      royalty_receiver TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_reason TEXT DEFAULT '',
      hidden_by TEXT DEFAULT '',
      terms_accepted_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (creator_sub) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sculptures_parcel ON sculptures(parcel_id);
    CREATE INDEX IF NOT EXISTS idx_sculptures_hidden ON sculptures(hidden);
    CREATE INDEX IF NOT EXISTS idx_sculptures_lat_lng ON sculptures(lat, lng);

    CREATE TABLE IF NOT EXISTS land_parcels (
      parcel_id TEXT PRIMARY KEY,
      geohash TEXT NOT NULL,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      first_claimant_sub TEXT NOT NULL,
      first_claimant_address TEXT NOT NULL,
      latest_claimant_address TEXT NOT NULL,
      sculpture_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sculpture_chat_boards (
      sculpture_id TEXT PRIMARY KEY,
      creator_sub TEXT NOT NULL,
      key_epoch INTEGER NOT NULL DEFAULT 1,
      room_key_commit TEXT NOT NULL,
      clue_prompt TEXT DEFAULT '',
      clue_wrapped_json TEXT DEFAULT '',
      auto_grant_pol INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sculpture_chat_grants (
      id TEXT PRIMARY KEY,
      sculpture_id TEXT NOT NULL,
      key_epoch INTEGER NOT NULL DEFAULT 1,
      requester_sub TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      requester_ecdh_pub_jwk TEXT NOT NULL,
      requester_sign_pub_jwk TEXT NOT NULL,
      requester_pub_fp TEXT NOT NULL,
      sight_proof_json TEXT NOT NULL,
      sight_score INTEGER NOT NULL,
      sight_distance_m REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      grantor_sub TEXT DEFAULT '',
      grantor_ecdh_pub_jwk TEXT DEFAULT '',
      grantor_sign_pub_jwk TEXT DEFAULT '',
      wrapped_key_json TEXT DEFAULT '',
      grant_sig TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(sculpture_id, key_epoch, requester_pub_fp)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_grants_sculpture_status ON sculpture_chat_grants(sculpture_id, key_epoch, status);
    CREATE INDEX IF NOT EXISTS idx_chat_grants_requester ON sculpture_chat_grants(requester_sub, status);

    CREATE TABLE IF NOT EXISTS sculpture_chat_messages (
      id TEXT PRIMARY KEY,
      sculpture_id TEXT NOT NULL,
      key_epoch INTEGER NOT NULL DEFAULT 1,
      sender_sub TEXT NOT NULL,
      sender_pub_fp TEXT NOT NULL,
      sender_sign_pub_jwk TEXT NOT NULL,
      iv_b64 TEXT NOT NULL,
      ciphertext_b64 TEXT NOT NULL,
      aad_json TEXT NOT NULL,
      signature_b64 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_msgs_sculpture_time ON sculpture_chat_messages(sculpture_id, key_epoch, created_at);

    CREATE TABLE IF NOT EXISTS sculpture_transfers (
      id TEXT PRIMARY KEY,
      sculpture_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      token_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      simulated INTEGER NOT NULL DEFAULT 0,
      method TEXT NOT NULL,
      transferred_by_sub TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_sculpture_time ON sculpture_transfers(sculpture_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      code TEXT PRIMARY KEY,
      creator_sub TEXT DEFAULT '',
      location_json TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      geohash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      agent_name TEXT DEFAULT '',
      draft_title TEXT DEFAULT '',
      draft_description TEXT DEFAULT '',
      draft_voxels_json TEXT DEFAULT '[]',
      voxel_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_expires ON agent_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS sculpture_drafts (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      altitude REAL,
      parcel_id TEXT DEFAULT '',
      geohash TEXT DEFAULT '',
      voxels_json TEXT NOT NULL,
      voxel_count INTEGER NOT NULL DEFAULT 0,
      surface_anchor_json TEXT DEFAULT '',
      preview_data_url TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_owner_updated ON sculpture_drafts(owner_sub, updated_at DESC);

    CREATE TABLE IF NOT EXISTS mcp_pairings (
      code TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      agent_name TEXT DEFAULT '',
      agent_address TEXT DEFAULT '',
      key_connected INTEGER NOT NULL DEFAULT 0,
      challenge_nonce TEXT NOT NULL,
      connected_at TEXT DEFAULT '',
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_pairings_owner_status ON mcp_pairings(owner_sub, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS land_signature_requests (
      id TEXT PRIMARY KEY,
      pairing_code TEXT DEFAULT '',
      owner_sub TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      action TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      sculpture_id TEXT DEFAULT '',
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      canonical_message TEXT NOT NULL,
      nonce TEXT NOT NULL,
      requested_by TEXT NOT NULL DEFAULT 'agent',
      agent_name TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      signed_by TEXT DEFAULT '',
      signer_address TEXT DEFAULT '',
      signature TEXT DEFAULT '',
      tx_hash TEXT DEFAULT '',
      result_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sigreq_owner_status ON land_signature_requests(owner_sub, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS parcel_curations (
      parcel_id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      custom_name TEXT DEFAULT '',
      curation_note TEXT DEFAULT '',
      featured_sculpture_id TEXT DEFAULT '',
      allow_public_ar INTEGER NOT NULL DEFAULT 1,
      last_signed_tx_hash TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sculpture_pin_batches (
      sculpture_id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      geohash TEXT NOT NULL,
      batch_seq INTEGER NOT NULL DEFAULT 0,
      pin_count INTEGER NOT NULL DEFAULT 0,
      seal_secret_b64 TEXT NOT NULL,
      key_commitment TEXT NOT NULL,
      ipfs_cid TEXT DEFAULT '',
      ipfs_uri TEXT DEFAULT '',
      ipfs_gateway_url TEXT DEFAULT '',
      encrypted_batch_json TEXT NOT NULL DEFAULT '{}',
      updated_by_sub TEXT DEFAULT '',
      updated_by_address TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pin_batches_parcel
      ON sculpture_pin_batches (parcel_id, updated_at);

    CREATE TABLE IF NOT EXISTS parcel_presence_challenges (
      id TEXT PRIMARY KEY,
      sculpture_id TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      geohash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      requester_pub_fp TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_parcel_challenges_user
      ON parcel_presence_challenges (sculpture_id, user_id, consumed);

    CREATE TABLE IF NOT EXISTS sculpture_models (
      sculpture_id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      model_format TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'ipfs',
      model_url TEXT DEFAULT '',
      model_cid TEXT DEFAULT '',
      model_uri TEXT DEFAULT '',
      gateway_url TEXT DEFAULT '',
      inline_b64 TEXT DEFAULT '',
      byte_length INTEGER NOT NULL DEFAULT 0,
      scale REAL NOT NULL DEFAULT 1,
      rotation_y REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sculpture_models_parcel
      ON sculpture_models (parcel_id);

    CREATE TABLE IF NOT EXISTS land_settings (
      parcel_id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      allow_agent_erase INTEGER NOT NULL DEFAULT 1,
      allow_contributor_edits INTEGER NOT NULL DEFAULT 1,
      freeze_placements INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS land_contributors (
      id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      contributor_sub TEXT NOT NULL,
      contributor_email TEXT DEFAULT '',
      contributor_name TEXT DEFAULT '',
      contributor_address TEXT DEFAULT '',
      can_edit_sculptures INTEGER NOT NULL DEFAULT 1,
      added_by_sub TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(parcel_id, contributor_sub)
    );

    CREATE INDEX IF NOT EXISTS idx_land_contributors_parcel
      ON land_contributors (parcel_id, contributor_sub);

    CREATE TABLE IF NOT EXISTS relayer_usage (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      op_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, day_key)
    );

    CREATE TABLE IF NOT EXISTS parcel_landmark_anchors (
      parcel_id TEXT PRIMARY KEY,
      geohash TEXT NOT NULL,
      anchor_cid TEXT DEFAULT '',
      anchor_uri TEXT DEFAULT '',
      descriptor_digest TEXT NOT NULL,
      keyframe_count INTEGER NOT NULL DEFAULT 0,
      feature_count INTEGER NOT NULL DEFAULT 0,
      anchor_pack_json TEXT NOT NULL,
      creator_sub TEXT NOT NULL,
      updated_by_sub TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sculpture_anchors (
      sculpture_id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      dx REAL NOT NULL DEFAULT 0,
      dy REAL NOT NULL DEFAULT 0,
      dz REAL NOT NULL DEFAULT 0,
      yaw REAL NOT NULL DEFAULT 0,
      current_rev INTEGER NOT NULL DEFAULT 1,
      last_erc4906_tx_hash TEXT DEFAULT '',
      mesh_stats_json TEXT DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sculpture_anchors_parcel
      ON sculpture_anchors (parcel_id);

    CREATE TABLE IF NOT EXISTS sculpture_revisions (
      id TEXT PRIMARY KEY,
      sculpture_id TEXT NOT NULL,
      rev_num INTEGER NOT NULL,
      editor_sub TEXT NOT NULL,
      editor_name TEXT DEFAULT '',
      editor_role TEXT NOT NULL DEFAULT 'owner',
      model_type TEXT NOT NULL DEFAULT 'voxel',
      voxels_json TEXT NOT NULL DEFAULT '[]',
      voxel_count INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      ipfs_metadata_cid TEXT NOT NULL,
      ipfs_model_cid TEXT NOT NULL,
      ipfs_image_cid TEXT NOT NULL,
      change_summary TEXT DEFAULT '',
      custom_model_json TEXT DEFAULT '',
      anchor_offset_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(sculpture_id, rev_num)
    );

    CREATE INDEX IF NOT EXISTS idx_sculpture_revisions_lookup
      ON sculpture_revisions (sculpture_id, rev_num DESC);

    CREATE TABLE IF NOT EXISTS user_passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key_spki_b64 TEXT NOT NULL,
      alg INTEGER NOT NULL DEFAULT -7,
      sign_count INTEGER NOT NULL DEFAULT 0,
      rp_id TEXT DEFAULT '',
      device_label TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      last_used_at TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_user_passkeys_user
      ON user_passkeys (user_id);

    CREATE TABLE IF NOT EXISTS land_security_policies (
      parcel_id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      require_passkey_unlock INTEGER NOT NULL DEFAULT 0,
      require_orb_unlock INTEGER NOT NULL DEFAULT 0,
      min_orb_inliers INTEGER NOT NULL DEFAULT 8,
      max_reproj_err_px REAL NOT NULL DEFAULT 6.5,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_rate_limits (
      bucket_key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      req_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bucket_key, window_start)
    );

    CREATE TABLE IF NOT EXISTS ops_events (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      actor_id TEXT DEFAULT '',
      parcel_id TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      metric_value REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ops_events_time
      ON ops_events (created_at DESC);

    CREATE TABLE IF NOT EXISTS webauthn_reg_challenges (
      challenge TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS webauthn_auth_challenges (
      challenge TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'wallet_export',
      rp_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sculptures_hidden_lat_lng
      ON sculptures (hidden, lat, lng);

    CREATE INDEX IF NOT EXISTS idx_sculptures_geohash
      ON sculptures (geohash);

    CREATE TABLE IF NOT EXISTS agent_accounts (
      agent_id TEXT PRIMARY KEY,
      wallet_lower TEXT NOT NULL UNIQUE,
      wallet_address TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Autonomous Steward',
      framework TEXT NOT NULL DEFAULT 'custom',
      description TEXT NOT NULL DEFAULT '',
      endpoint_url TEXT NOT NULL DEFAULT '',
      max_slots INTEGER NOT NULL DEFAULT 3,
      used_slots INTEGER NOT NULL DEFAULT 0,
      activated_lands_count INTEGER NOT NULL DEFAULT 0,
      total_xp INTEGER NOT NULL DEFAULT 0,
      reputation_score INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_auth_challenges (
      nonce TEXT PRIMARY KEY,
      wallet_lower TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_agent_auth_challenges_wallet
      ON agent_auth_challenges (wallet_lower, used);

    CREATE TABLE IF NOT EXISTS land_steward_state (
      parcel_id TEXT PRIMARY KEY,
      steward_sub TEXT NOT NULL DEFAULT '',
      steward_address TEXT NOT NULL DEFAULT '',
      steward_name TEXT NOT NULL DEFAULT '',
      steward_type TEXT NOT NULL DEFAULT 'human',
      status TEXT NOT NULL DEFAULT 'awakened',
      claimed_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL DEFAULT '',
      awakened_at TEXT NOT NULL DEFAULT '',
      first_human_sub TEXT NOT NULL DEFAULT '',
      first_human_address TEXT NOT NULL DEFAULT '',
      human_contributor_count INTEGER NOT NULL DEFAULT 0,
      total_tx_volume_eth REAL NOT NULL DEFAULT 0,
      agent_royalties_eth REAL NOT NULL DEFAULT 0,
      human_royalties_eth REAL NOT NULL DEFAULT 0,
      platform_fees_eth REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_land_steward_status_lease
      ON land_steward_state (status, lease_expires_at);

    CREATE INDEX IF NOT EXISTS idx_land_steward_sub
      ON land_steward_state (steward_sub, status);

    CREATE TABLE IF NOT EXISTS land_quests (
      id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      steward_sub TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      theme TEXT NOT NULL DEFAULT 'open',
      bounty_wei TEXT NOT NULL DEFAULT '0',
      bounty_eth REAL NOT NULL DEFAULT 0,
      slot_offsets_json TEXT NOT NULL DEFAULT '[]',
      max_completions INTEGER NOT NULL DEFAULT 10,
      completions_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_land_quests_parcel_status
      ON land_quests (parcel_id, status);

    CREATE TABLE IF NOT EXISTS land_quest_completions (
      id TEXT PRIMARY KEY,
      quest_id TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      sculpture_id TEXT NOT NULL,
      artist_sub TEXT NOT NULL,
      artist_name TEXT NOT NULL DEFAULT '',
      artist_address TEXT NOT NULL DEFAULT '',
      plinth_slot_id TEXT NOT NULL DEFAULT '',
      voxel_count INTEGER NOT NULL DEFAULT 0,
      qualifies_for_pool INTEGER NOT NULL DEFAULT 0,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      awakened_parcel INTEGER NOT NULL DEFAULT 0,
      bounty_paid_eth REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_quest_completions_parcel_artist
      ON land_quest_completions (parcel_id, artist_sub);

    CREATE TABLE IF NOT EXISTS sculpture_layers (
      sculpture_id TEXT PRIMARY KEY,
      parcel_id TEXT NOT NULL,
      layer_role TEXT NOT NULL DEFAULT 'artist_work',
      quest_id TEXT NOT NULL DEFAULT '',
      plinth_slot_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      qual_contributor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sculpture_layers_parcel_role
      ON sculpture_layers (parcel_id, layer_role);

    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id TEXT PRIMARY KEY,
      sculpture_id TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      seller_sub TEXT NOT NULL,
      seller_name TEXT NOT NULL DEFAULT '',
      seller_address TEXT NOT NULL,
      price_eth REAL NOT NULL,
      price_wei TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      buyer_sub TEXT NOT NULL DEFAULT '',
      buyer_address TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL DEFAULT '',
      split_breakdown_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      sold_at TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status_parcel
      ON marketplace_listings (status, parcel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS fee_ledger_entries (
      id TEXT PRIMARY KEY,
      tx_type TEXT NOT NULL,
      parcel_id TEXT NOT NULL,
      sculpture_id TEXT NOT NULL DEFAULT '',
      listing_id TEXT NOT NULL DEFAULT '',
      recipient_role TEXT NOT NULL,
      recipient_sub TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL DEFAULT '',
      recipient_address TEXT NOT NULL,
      bps INTEGER NOT NULL,
      amount_eth REAL NOT NULL,
      amount_wei TEXT NOT NULL,
      tx_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fee_ledger_recipient
      ON fee_ledger_entries (recipient_address, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_fee_ledger_parcel
      ON fee_ledger_entries (parcel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS land_volumes (
      parcel_id TEXT PRIMARY KEY,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      width_meters REAL NOT NULL DEFAULT 14,
      depth_meters REAL NOT NULL DEFAULT 14,
      height_meters REAL NOT NULL DEFAULT 18,
      z_scale REAL NOT NULL DEFAULT 1,
      rotation_deg REAL NOT NULL DEFAULT 0,
      base_altitude_m REAL NOT NULL DEFAULT 0,
      footprint_area_sqm REAL NOT NULL DEFAULT 196,
      volume_cubic_m REAL NOT NULL DEFAULT 3528,
      corners_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `);

  try {
    db.exec('ALTER TABLE land_settings ADD COLUMN freeze_placements INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists on upgraded SQLite DBs
  }

  dbInstance = db;
  return dbInstance;
}
