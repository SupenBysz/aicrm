-- Platform branding keeps existing text and typography as compatibility fallbacks.
ALTER TABLE ky_platform_profile ADD COLUMN IF NOT EXISTS brand_config jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS ky_platform_brand_asset (
 id text PRIMARY KEY,
 digest text NOT NULL UNIQUE,
 content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
