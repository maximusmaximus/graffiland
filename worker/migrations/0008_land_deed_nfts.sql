-- Migration 0008: Dedicated Transferable Virtual Land Deed NFTs, Transfer History & Land Marketplace Listings

CREATE TABLE IF NOT EXISTS land_deed_nfts (
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
);

CREATE INDEX IF NOT EXISTS idx_land_deed_nfts_owner_addr ON land_deed_nfts(owner_address);
CREATE INDEX IF NOT EXISTS idx_land_deed_nfts_owner_sub ON land_deed_nfts(owner_sub);
CREATE INDEX IF NOT EXISTS idx_land_deed_nfts_token_id ON land_deed_nfts(token_id);

CREATE TABLE IF NOT EXISTS land_deed_transfers (
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
);

CREATE INDEX IF NOT EXISTS idx_land_deed_transfers_parcel ON land_deed_transfers(parcel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS land_marketplace_listings (
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
);

CREATE INDEX IF NOT EXISTS idx_land_market_listings_parcel_status ON land_marketplace_listings(parcel_id, status);
CREATE INDEX IF NOT EXISTS idx_land_market_listings_status_created ON land_marketplace_listings(status, created_at DESC);
