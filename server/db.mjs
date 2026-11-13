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
  `);

  dbInstance = db;
  return dbInstance;
}
