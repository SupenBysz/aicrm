-- Add configurable text logo fields to the singleton platform profile.

ALTER TABLE ky_platform_profile
  ADD COLUMN IF NOT EXISTS brand_logo_text_long text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS brand_logo_text_short text NOT NULL DEFAULT '';
