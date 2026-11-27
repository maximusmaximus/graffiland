-- Add public profile visibility setting (default 1 = public, 0 = private to owner only)
ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1;
