-- Add Land & Sculpture OG share preview settings and freshly generated snapshot tracking.
ALTER TABLE land_settings ADD COLUMN og_image_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE land_settings ADD COLUMN og_custom_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE land_settings ADD COLUMN og_preview_image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE land_settings ADD COLUMN og_preview_sig TEXT NOT NULL DEFAULT '';
ALTER TABLE land_settings ADD COLUMN og_preview_updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE sculptures ADD COLUMN og_preview_url TEXT NOT NULL DEFAULT '';
