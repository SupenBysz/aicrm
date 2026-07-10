-- Matrix account v9: durable metadata for encrypted local/cloud session snapshots.
-- Raw credentials and encryption keys never enter PostgreSQL.

CREATE TABLE IF NOT EXISTS ky_matrix_account_session_snapshot (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  attempt_id text NOT NULL REFERENCES ky_matrix_account_login_attempt(id),
  web_space_id text NOT NULL REFERENCES ky_matrix_account_web_space(id),
  account_id text REFERENCES ky_matrix_account(id),
  member_id text NOT NULL REFERENCES ky_membership(id),
  device_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('verified', 'active', 'restoring', 'restored', 'failed', 'deleted')),
  storage_provider text NOT NULL DEFAULT 'local_encrypted'
    CHECK (storage_provider IN ('local_encrypted', 'object_storage_encrypted')),
  object_key text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  fingerprint_hash text NOT NULL CHECK (fingerprint_hash ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  source_bytes bigint NOT NULL DEFAULT 0 CHECK (source_bytes >= 0),
  file_count bigint NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  created_by text REFERENCES ky_user(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(attempt_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_session_snapshot_attempt_active_uidx
  ON ky_matrix_account_session_snapshot(attempt_id)
  WHERE deleted_at IS NULL AND status IN ('verified', 'active', 'restoring', 'restored');

CREATE INDEX IF NOT EXISTS ky_matrix_account_session_snapshot_account_idx
  ON ky_matrix_account_session_snapshot(account_id, created_at DESC)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ky_matrix_account_login_attempt_snapshot_fk'
  ) THEN
    ALTER TABLE ky_matrix_account_login_attempt
      ADD CONSTRAINT ky_matrix_account_login_attempt_snapshot_fk
      FOREIGN KEY (snapshot_id) REFERENCES ky_matrix_account_session_snapshot(id);
  END IF;
END $$;

ALTER TABLE ky_matrix_account_client_session
  ADD COLUMN IF NOT EXISTS active_snapshot_id text REFERENCES ky_matrix_account_session_snapshot(id);

CREATE INDEX IF NOT EXISTS ky_matrix_account_client_session_snapshot_idx
  ON ky_matrix_account_client_session(active_snapshot_id)
  WHERE deleted_at IS NULL AND active_snapshot_id IS NOT NULL;
