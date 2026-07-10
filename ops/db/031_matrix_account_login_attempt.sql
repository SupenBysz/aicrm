-- Matrix account v8: business login-attempt orchestration.
--
-- The attempt/event/command tables are the authoritative business projection
-- for account onboarding.  Browser credentials and QR payloads deliberately
-- stay in the trusted desktop runtime and are never stored here.

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_attempt (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  member_id text NOT NULL REFERENCES ky_membership(id),
  device_id text NOT NULL DEFAULT 'default',
  web_space_id text NOT NULL REFERENCES ky_matrix_account_web_space(id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed', 'cancelled', 'expired')),
  phase text NOT NULL DEFAULT 'created'
    CHECK (phase IN (
      'created', 'opening', 'qr_preparing', 'qr_ready', 'waiting_scan',
      'authenticating', 'authenticated', 'identifying', 'awaiting_confirmation',
      'snapshot_sealing', 'committing', 'ready', 'verification_required',
      'risk_controlled', 'qr_expired', 'cancelling', 'cleanup_pending', 'cancelled'
    )),
  activity text NOT NULL DEFAULT 'executing'
    CHECK (activity IN ('executing', 'waiting_user', 'repairing_adapter', 'retrying', 'none')),
  current_step text NOT NULL DEFAULT 'login.open.v1',
  blocked_method text NOT NULL DEFAULT '',
  qr_revision integer NOT NULL DEFAULT 0 CHECK (qr_revision >= 0),
  account_id text REFERENCES ky_matrix_account(id),
  snapshot_id text,
  repair_task_id text NOT NULL DEFAULT '',
  account_candidate jsonb NOT NULL DEFAULT '{}'::jsonb,
  binding_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot_fingerprint_hash text NOT NULL DEFAULT '',
  snapshot_content_hash text NOT NULL DEFAULT '',
  snapshot_verified boolean NOT NULL DEFAULT false,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  last_error_code text NOT NULL DEFAULT '',
  last_error_message text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_idempotency_uidx
  ON ky_matrix_account_login_attempt(workspace_type, workspace_id, member_id, idempotency_key)
  WHERE deleted_at IS NULL AND idempotency_key <> '';

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_workspace_idx
  ON ky_matrix_account_login_attempt(workspace_type, workspace_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_member_idx
  ON ky_matrix_account_login_attempt(member_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_web_space_idx
  ON ky_matrix_account_login_attempt(web_space_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_expiry_idx
  ON ky_matrix_account_login_attempt(status, expires_at)
  WHERE deleted_at IS NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_attempt_event (
  id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES ky_matrix_account_login_attempt(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  phase text NOT NULL,
  recoverable boolean NOT NULL DEFAULT false,
  next_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'desktop', 'system')),
  actor_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(attempt_id, sequence)
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_event_cursor_idx
  ON ky_matrix_account_login_attempt_event(attempt_id, sequence);

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_attempt_command (
  id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES ky_matrix_account_login_attempt(id),
  command_id text NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('refresh_qr', 'retry', 'cancel')),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('accepted', 'completed', 'rejected')),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(attempt_id, command_id)
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_attempt_command_attempt_idx
  ON ky_matrix_account_login_attempt_command(attempt_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_method_run (
  id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES ky_matrix_account_login_attempt(id),
  web_space_id text NOT NULL REFERENCES ky_matrix_account_web_space(id),
  operation_id text NOT NULL,
  attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  method_key text NOT NULL,
  script_id text REFERENCES ky_matrix_account_login_script(id),
  script_version_id text REFERENCES ky_matrix_account_login_script_version(id),
  status text NOT NULL CHECK (status IN ('success', 'failed', 'timeout', 'cancelled')),
  observed_phase text NOT NULL DEFAULT '',
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_sequence bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(attempt_id, operation_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_method_run_attempt_idx
  ON ky_matrix_account_login_method_run(attempt_id, created_at DESC);
