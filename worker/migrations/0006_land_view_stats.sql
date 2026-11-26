-- Migration 0006: Persistent Land Page & In-Person AR View Counters
CREATE TABLE IF NOT EXISTS land_view_stats (
  parcel_id TEXT PRIMARY KEY,
  page_views INTEGER NOT NULL DEFAULT 0,
  in_person_views INTEGER NOT NULL DEFAULT 0,
  last_page_view_at TEXT NOT NULL DEFAULT '',
  last_in_person_view_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS land_view_events (
  parcel_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  view_type TEXT NOT NULL,
  last_counted_at TEXT NOT NULL,
  PRIMARY KEY (parcel_id, viewer_key, view_type)
);

CREATE INDEX IF NOT EXISTS idx_land_view_events_parcel
  ON land_view_events (parcel_id, view_type, last_counted_at);
