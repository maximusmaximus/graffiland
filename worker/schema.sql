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
