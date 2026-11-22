-- 0003_notifications.sql: Persistent per-user notifications, preferences, and land title index

CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'land_activity',
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  parcel_id TEXT NOT NULL DEFAULT '',
  sculpture_id TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL DEFAULT '',
  action_label TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  read_at TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
  ON user_notifications (user_sub, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_dedupe
  ON user_notifications (user_sub, dedupe_key);

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_sub TEXT PRIMARY KEY,
  sculpture_on_land INTEGER NOT NULL DEFAULT 1,
  mint_slots_unlocked INTEGER NOT NULL DEFAULT 1,
  mint_limit_reached INTEGER NOT NULL DEFAULT 1,
  land_expiring INTEGER NOT NULL DEFAULT 1,
  land_activity INTEGER NOT NULL DEFAULT 1,
  browser_push_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parcel_curations_name_lower
  ON parcel_curations (LOWER(custom_name));
