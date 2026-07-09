-- Matrix account v2: Web-space driven account onboarding.
-- New accounts are created from detected platform identity, not manual profile forms.

ALTER TABLE ky_matrix_account
  ADD COLUMN IF NOT EXISTS platform_identity_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_source text NOT NULL DEFAULT 'manual';

UPDATE ky_matrix_account
SET platform_identity_key = platform_uid
WHERE platform_identity_key = '' AND platform_uid <> '';

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_workspace_platform_identity_uidx
  ON ky_matrix_account(workspace_type, workspace_id, platform, platform_identity_key)
  WHERE deleted_at IS NULL AND platform_identity_key <> '';

CREATE TABLE IF NOT EXISTS ky_matrix_account_web_space (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  member_id text NOT NULL REFERENCES ky_membership(id),
  device_id text NOT NULL DEFAULT 'default',
  browser_partition text NOT NULL,
  account_id text REFERENCES ky_matrix_account(id),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'opening', 'waiting_login', 'detected', 'bound', 'detect_failed', 'abandoned', 'cleared')),
  detected_identity_key text NOT NULL DEFAULT '',
  detected_platform_uid text NOT NULL DEFAULT '',
  detected_nickname text NOT NULL DEFAULT '',
  detected_avatar_url text NOT NULL DEFAULT '',
  detected_home_url text NOT NULL DEFAULT '',
  last_opened_at timestamptz,
  detected_at timestamptz,
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_web_space_workspace_idx
  ON ky_matrix_account_web_space(workspace_type, workspace_id, platform, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_web_space_member_idx
  ON ky_matrix_account_web_space(member_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_web_space_account_idx
  ON ky_matrix_account_web_space(account_id)
  WHERE deleted_at IS NULL AND account_id IS NOT NULL;
