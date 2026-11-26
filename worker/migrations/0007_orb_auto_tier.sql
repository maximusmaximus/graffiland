-- Migration 0007: Hybrid ORB Auto-Calibration, Environment Tier, Origin Source & Dual-Lighting Policy
ALTER TABLE land_security_policies ADD COLUMN origin_source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE land_security_policies ADD COLUMN env_tier TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE land_security_policies ADD COLUMN auto_min_orb_inliers INTEGER;
ALTER TABLE land_security_policies ADD COLUMN auto_max_reproj_err_px REAL;
ALTER TABLE land_security_policies ADD COLUMN override_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE land_security_policies ADD COLUMN lighting_adaptive INTEGER NOT NULL DEFAULT 1;
