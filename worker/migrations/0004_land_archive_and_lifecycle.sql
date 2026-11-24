-- 0004_land_archive_and_lifecycle.sql:
-- Adds 72h agent reclaim / 28d human-inactivity tracking, non-reopening forfeited slots, and permanent Land Archive table.

ALTER TABLE agent_accounts ADD COLUMN forfeited_slots INTEGER NOT NULL DEFAULT 0;

ALTER TABLE land_steward_state ADD COLUMN last_human_interaction_at TEXT NOT NULL DEFAULT '';
ALTER TABLE land_steward_state ADD COLUMN last_human_interaction_type TEXT NOT NULL DEFAULT '';
ALTER TABLE land_steward_state ADD COLUMN last_human_interaction_sub TEXT NOT NULL DEFAULT '';
ALTER TABLE land_steward_state ADD COLUMN inactivity_expires_at TEXT NOT NULL DEFAULT '';
ALTER TABLE land_steward_state ADD COLUMN had_human_interaction INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_land_steward_inactivity
  ON land_steward_state (status, inactivity_expires_at);

CREATE TABLE IF NOT EXISTS land_archives (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL,
  geohash TEXT NOT NULL,
  land_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  steward_sub TEXT NOT NULL DEFAULT '',
  steward_name TEXT NOT NULL DEFAULT '',
  steward_address TEXT NOT NULL DEFAULT '',
  steward_type TEXT NOT NULL DEFAULT 'agent',
  archive_reason TEXT NOT NULL,
  archive_reason_label TEXT NOT NULL DEFAULT '',
  center_lat REAL NOT NULL DEFAULT 0,
  center_lng REAL NOT NULL DEFAULT 0,
  volume_json TEXT NOT NULL DEFAULT '{}',
  sculpture_count INTEGER NOT NULL DEFAULT 0,
  sculptures_snapshot_json TEXT NOT NULL DEFAULT '[]',
  human_contributor_count INTEGER NOT NULL DEFAULT 0,
  had_human_interaction INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT NOT NULL DEFAULT '',
  awakened_at TEXT NOT NULL DEFAULT '',
  last_human_interaction_at TEXT NOT NULL DEFAULT '',
  expired_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_land_archives_archived_at
  ON land_archives (archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_land_archives_parcel
  ON land_archives (parcel_id, archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_land_archives_steward
  ON land_archives (steward_sub, had_human_interaction);

-- Safe grace-period backfill: existing active lands start a fresh 28-day window from migration time.
UPDATE land_steward_state
SET last_human_interaction_at = COALESCE(NULLIF(last_human_interaction_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    inactivity_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+28 days'),
    had_human_interaction = CASE
      WHEN had_human_interaction = 1 OR steward_type = 'human' OR human_contributor_count > 0 THEN 1
      ELSE had_human_interaction
    END
WHERE status = 'awakened' AND COALESCE(inactivity_expires_at, '') = '';
