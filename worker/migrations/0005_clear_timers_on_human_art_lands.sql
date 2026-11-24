-- 0005_clear_timers_on_human_art_lands.sql:
-- Lands minted from manual human Mobile AR art (or that already have manual human voxel art)
-- are permanently owned with NO expiry timer and never recycle.
-- Lands created first on the map without manual human AR art keep their countdown timer
-- with had_human_interaction = 0 until a human visits in person and adds art.

-- 1) Clear expiry timers on any land that already has manual human-drawn AR voxel art
UPDATE land_steward_state
SET lease_expires_at = '',
    inactivity_expires_at = '',
    had_human_interaction = 1,
    status = 'awakened',
    last_human_interaction_type = COALESCE(NULLIF(last_human_interaction_type, ''), 'irl_publish'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IN ('awakened', 'dormant')
  AND EXISTS (
    SELECT 1
    FROM sculptures s
    LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
    WHERE s.parcel_id = land_steward_state.parcel_id
      AND s.hidden = 0
      AND s.creator_sub NOT LIKE 'agent:%'
      AND m.model_format IS NULL
  );

-- 2) Mark map-created-first lands with zero physical human interaction/art so the UI clearly
--    explains that a human must visit in person on Mobile AR and add art to fully mint & own them.
UPDATE land_steward_state
SET had_human_interaction = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'awakened'
  AND inactivity_expires_at != ''
  AND COALESCE(last_human_interaction_type, '') = ''
  AND NOT EXISTS (
    SELECT 1
    FROM sculptures s
    LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
    WHERE s.parcel_id = land_steward_state.parcel_id
      AND s.hidden = 0
      AND s.creator_sub NOT LIKE 'agent:%'
      AND m.model_format IS NULL
  );
