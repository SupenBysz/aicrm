-- Agent Executor P1 control-plane expansion.
--
-- This migration is deliberately additive and fail-closed.  Legacy
-- auth_status/auth_method fields remain compatibility data only; no value from
-- those columns is promoted into the canonical credential/readiness state.
-- Cross-service identifiers (actor/workspace) are opaque text references and
-- therefore have no foreign keys outside the executor-owned table family.

ALTER TABLE ky_ai_executor_config
  ADD COLUMN IF NOT EXISTS default_model_key text,
  ADD COLUMN IF NOT EXISTS config_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS credential_status text,
  ADD COLUMN IF NOT EXISTS current_credential_revision bigint,
  ADD COLUMN IF NOT EXISTS readiness_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS readiness_reason_code text NOT NULL DEFAULT 'shadow_read_only',
  ADD COLUMN IF NOT EXISTS revocation_epoch bigint NOT NULL DEFAULT 0;

-- Existing executors are intentionally unknown.  Newly-created executors are
-- explicitly not authorized.  In particular, do not derive either value from
-- the legacy auth_status column.
UPDATE ky_ai_executor_config
SET credential_status = 'unknown'
WHERE credential_status IS NULL;

ALTER TABLE ky_ai_executor_config
  ALTER COLUMN credential_status SET DEFAULT 'not_authorized',
  ALTER COLUMN credential_status SET NOT NULL;

ALTER TABLE ky_ai_executor_config
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_config_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_credential_status_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_current_credential_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_readiness_status_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_revocation_epoch_check;

ALTER TABLE ky_ai_executor_config
  ADD CONSTRAINT ky_ai_executor_config_config_revision_check
    CHECK (config_revision > 0),
  ADD CONSTRAINT ky_ai_executor_config_credential_status_check
    CHECK (credential_status IN ('unknown', 'not_authorized', 'authorized', 'expired', 'revoked')),
  ADD CONSTRAINT ky_ai_executor_config_current_credential_revision_check
    CHECK (current_credential_revision IS NULL OR current_credential_revision > 0),
  ADD CONSTRAINT ky_ai_executor_config_readiness_status_check
    CHECK (readiness_status IN ('unknown', 'checking', 'ready', 'degraded', 'unavailable')),
  ADD CONSTRAINT ky_ai_executor_config_revocation_epoch_check
    CHECK (revocation_epoch >= 0);

CREATE TABLE IF NOT EXISTS ky_ai_executor_workspace_grant (
  id text PRIMARY KEY,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE CASCADE,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL CHECK (workspace_id <> ''),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (executor_id, workspace_type, workspace_id)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_workspace_grant_lookup_idx
  ON ky_ai_executor_workspace_grant(workspace_type, workspace_id, status, executor_id);

CREATE TABLE IF NOT EXISTS ky_ai_executor_model_catalog (
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE CASCADE,
  catalog_revision bigint NOT NULL CHECK (catalog_revision > 0),
  model_key text NOT NULL CHECK (model_key <> ''),
  display_name text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_json) = 'object'),
  account_fingerprint text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (executor_id, catalog_revision, model_key)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_model_catalog_current_idx
  ON ky_ai_executor_model_catalog(executor_id, catalog_revision DESC, status, model_key);

CREATE TABLE IF NOT EXISTS ky_ai_executor_authorization_session (
  id text PRIMARY KEY,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  runtime_type text NOT NULL CHECK (runtime_type IN ('desktop', 'server', 'remote')),
  flow_type text NOT NULL CHECK (flow_type IN ('browser', 'device_code')),
  intent text NOT NULL CHECK (intent IN ('authorize', 'change_account')),
  status text NOT NULL DEFAULT 'starting' CHECK (status IN (
    'starting', 'waiting_user', 'verifying', 'succeeded', 'failed',
    'cancelled', 'expired', 'interrupted', 'superseded'
  )),
  requested_by text NOT NULL CHECK (requested_by <> ''),
  bound_device_id text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  session_deadline_at timestamptz NOT NULL,
  failure_code text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by, executor_id, idempotency_key_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_authorization_session_active_uidx
  ON ky_ai_executor_authorization_session(executor_id)
  WHERE status IN ('starting', 'waiting_user', 'verifying');

CREATE INDEX IF NOT EXISTS ky_ai_executor_authorization_session_requester_idx
  ON ky_ai_executor_authorization_session(requested_by, created_at DESC);

CREATE TABLE IF NOT EXISTS ky_ai_executor_authorization_session_event (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ky_ai_executor_authorization_session(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type <> ''),
  safe_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_payload_json) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_authorization_session_event_idx
  ON ky_ai_executor_authorization_session_event(session_id, sequence);

CREATE TABLE IF NOT EXISTS ky_ai_executor_credential_binding (
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('prepared', 'committing', 'active', 'quarantined', 'revoked')),
  authorization_session_id text REFERENCES ky_ai_executor_authorization_session(id) ON DELETE SET NULL,
  runtime_type text NOT NULL CHECK (runtime_type IN ('desktop', 'server', 'remote')),
  runtime_binding_id text NOT NULL CHECK (runtime_binding_id <> ''),
  runtime_binding_revision bigint NOT NULL CHECK (runtime_binding_revision > 0),
  device_id text NOT NULL DEFAULT '',
  account_fingerprint text NOT NULL CHECK (account_fingerprint <> ''),
  auth_mode text NOT NULL CHECK (auth_mode IN ('browser', 'device_code')),
  plan_type text NOT NULL DEFAULT '',
  binding_digest text NOT NULL DEFAULT '' CHECK (binding_digest = '' OR binding_digest ~ '^[0-9a-f]{64}$'),
  revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (executor_id, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_credential_binding_active_uidx
  ON ky_ai_executor_credential_binding(executor_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ky_ai_executor_credential_binding_session_idx
  ON ky_ai_executor_credential_binding(authorization_session_id);

CREATE TABLE IF NOT EXISTS ky_ai_executor_device (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  label text NOT NULL DEFAULT '',
  app_version text NOT NULL DEFAULT '',
  registered_by text NOT NULL CHECK (registered_by <> ''),
  workspace_type text NOT NULL DEFAULT 'platform' CHECK (workspace_type = 'platform'),
  workspace_id text NOT NULL DEFAULT 'platform_root' CHECK (workspace_id <> ''),
  key_generation bigint NOT NULL DEFAULT 1 CHECK (key_generation > 0),
  last_accepted_sequence bigint NOT NULL DEFAULT 0 CHECK (last_accepted_sequence >= 0),
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_key)
);

-- Registration challenges store only a digest.  The challenge text returned
-- to Desktop is never persisted.
CREATE TABLE IF NOT EXISTS ky_ai_executor_device_registration_challenge (
  id text PRIMARY KEY,
  public_key_digest text NOT NULL CHECK (public_key_digest ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (actor_id <> ''),
  workspace_type text NOT NULL DEFAULT 'platform' CHECK (workspace_type = 'platform'),
  workspace_id text NOT NULL DEFAULT 'platform_root' CHECK (workspace_id <> ''),
  challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_device_registration_challenge_expiry_idx
  ON ky_ai_executor_device_registration_challenge(expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_ai_executor_device_request_ledger (
  device_id text NOT NULL REFERENCES ky_ai_executor_device(id) ON DELETE RESTRICT,
  key_generation bigint NOT NULL CHECK (key_generation > 0),
  sequence bigint NOT NULL CHECK (sequence > 0),
  nonce text NOT NULL CHECK (nonce <> ''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  authorization_token_hash text NOT NULL DEFAULT '' CHECK (
    authorization_token_hash = '' OR authorization_token_hash ~ '^[0-9a-f]{64}$'
  ),
  response_reference text NOT NULL DEFAULT '',
  accepted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, key_generation, sequence),
  UNIQUE (device_id, key_generation, nonce)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_device_request_ledger_expiry_idx
  ON ky_ai_executor_device_request_ledger(expires_at);

CREATE TABLE IF NOT EXISTS ky_ai_executor_device_binding (
  executor_id text PRIMARY KEY REFERENCES ky_ai_executor_config(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES ky_ai_executor_device(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  bound_by text NOT NULL CHECK (bound_by <> ''),
  bound_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_device_binding_device_idx
  ON ky_ai_executor_device_binding(device_id, status);

-- Confirmation challenge/token material is digest-only and single-use.
CREATE TABLE IF NOT EXISTS ky_ai_executor_operation_confirmation (
  id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('force_revoke', 'rebind_device', 'unbind_device')),
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (actor_id <> ''),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  from_device_id text NOT NULL DEFAULT '',
  target_device_id text NOT NULL DEFAULT '',
  challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  confirmation_token_hash text NOT NULL DEFAULT '' CHECK (
    confirmation_token_hash = '' OR confirmation_token_hash ~ '^[0-9a-f]{64}$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'consumed', 'expired')),
  expires_at timestamptz NOT NULL,
  token_expires_at timestamptz,
  confirmed_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_operation_confirmation_token_uidx
  ON ky_ai_executor_operation_confirmation(confirmation_token_hash)
  WHERE confirmation_token_hash <> '';

CREATE INDEX IF NOT EXISTS ky_ai_executor_operation_confirmation_lookup_idx
  ON ky_ai_executor_operation_confirmation(actor_id, executor_id, status, expires_at);

-- Transactional control-plane outbox.  Only safe references are allowed in
-- safe_reference_json; credentials, paths, authorization challenges and raw
-- runtime output have no columns in this table.
CREATE TABLE IF NOT EXISTS ky_ai_executor_control_outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN (
    'executor', 'authorization_session', 'credential_binding',
    'device', 'device_binding', 'operation_confirmation'
  )),
  aggregate_id text NOT NULL CHECK (aggregate_id <> ''),
  aggregate_revision bigint NOT NULL DEFAULT 0 CHECK (aggregate_revision >= 0),
  event_type text NOT NULL CHECK (event_type <> ''),
  safe_reference_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_reference_json) = 'object'),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'published', 'dead_letter')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  occurred_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, aggregate_revision, event_type)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_control_outbox_delivery_idx
  ON ky_ai_executor_control_outbox(delivery_status, next_attempt_at, created_at)
  WHERE delivery_status = 'pending';
