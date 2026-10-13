-- 公共 JavaScript 源码资源：仅提供 workspace 隔离的 CRUD，不参与版本、发布或运行时注入。
CREATE TABLE IF NOT EXISTS ky_matrix_account_public_script (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform','agency','enterprise')),
  workspace_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  identifier text NOT NULL CHECK (identifier ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  description text NOT NULL DEFAULT '',
  source_content text NOT NULL DEFAULT '',
  source_chars integer NOT NULL DEFAULT 0 CHECK (source_chars >= 0),
  source_bytes integer NOT NULL DEFAULT 0 CHECK (source_bytes >= 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_command_key text NOT NULL DEFAULT '',
  last_command_hash text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_public_script_identifier_uidx
  ON ky_matrix_account_public_script(workspace_type, workspace_id, lower(identifier))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_matrix_account_public_script_list_idx
  ON ky_matrix_account_public_script(workspace_type, workspace_id, enabled, updated_at DESC)
  WHERE deleted_at IS NULL;
