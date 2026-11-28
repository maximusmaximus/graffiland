-- Add Land Chat Access Mode (default: 'contributors') and Chat Whitelist table
ALTER TABLE land_settings ADD COLUMN chat_access_mode TEXT NOT NULL DEFAULT 'contributors';

CREATE TABLE IF NOT EXISTS land_chat_whitelist (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,
  username TEXT DEFAULT '',
  email TEXT DEFAULT '',
  wallet_address TEXT DEFAULT '',
  added_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(parcel_id, user_sub)
);

CREATE INDEX IF NOT EXISTS idx_land_chat_whitelist_parcel
  ON land_chat_whitelist (parcel_id, user_sub);
