-- Agent Executor P1 task/fencing expansion.
--
-- ky_ai_executor_task, ky_ai_executor_task_event and
-- ky_ai_executor_task_raw_log remain the only physical execution truth.  A
-- Matrix generation run uses the same ID as the task; no second run table is
-- introduced here.

ALTER TABLE ky_ai_executor_task
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_task_type_check;

ALTER TABLE ky_ai_executor_task
  ADD CONSTRAINT ky_ai_executor_task_task_type_check
  CHECK (task_type IN (
    'credential_verify', 'model_catalog_refresh', 'readiness_check',
    'script_generate', 'script_repair', 'script_contract_test'
  ));

ALTER TABLE ky_ai_executor_task
  ADD COLUMN IF NOT EXISTS contract_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contract_revision bigint,
  ADD COLUMN IF NOT EXISTS effective_executor_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS effective_model_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS executor_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS model_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS executor_config_revision bigint,
  ADD COLUMN IF NOT EXISTS credential_binding_revision bigint,
  ADD COLUMN IF NOT EXISTS runtime_binding_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS runtime_binding_revision bigint,
  ADD COLUMN IF NOT EXISTS model_catalog_revision bigint,
  ADD COLUMN IF NOT EXISTS generation_engine text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operation_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_credential_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revocation_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS current_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS request_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS result_safe_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS failure_code text NOT NULL DEFAULT '';

-- The only allowed historical rewrite is the explicitly locked engine
-- backfill.  task_type and legacy binding fields are not inferred or changed.
UPDATE ky_ai_executor_task
SET generation_engine = 'legacy_provider'
WHERE task_type = 'script_repair'
  AND generation_engine = '';

UPDATE ky_ai_executor_task task
SET current_sequence = latest.max_sequence
FROM (
  SELECT task_id, MAX(sequence) AS max_sequence
  FROM ky_ai_executor_task_event
  GROUP BY task_id
) latest
WHERE task.id = latest.task_id
  AND task.current_sequence < latest.max_sequence;

ALTER TABLE ky_ai_executor_task
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_contract_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_executor_source_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_model_source_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_executor_config_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_credential_binding_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_runtime_binding_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_model_catalog_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_generation_engine_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_lease_epoch_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_source_credential_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_revocation_epoch_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_current_sequence_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_request_hash_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_result_safe_json_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_kind_shape_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_codex_binding_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_fencing_shape_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_waiting_scan_legacy_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_contract_test_shape_check;

ALTER TABLE ky_ai_executor_task
  ADD CONSTRAINT ky_ai_executor_task_contract_revision_check
    CHECK (contract_revision IS NULL OR contract_revision > 0),
  ADD CONSTRAINT ky_ai_executor_task_executor_source_check
    CHECK (executor_source IN ('', 'script_explicit', 'platform_default')),
  ADD CONSTRAINT ky_ai_executor_task_model_source_check
    CHECK (model_source IN ('', 'script_override', 'executor_default')),
  ADD CONSTRAINT ky_ai_executor_task_executor_config_revision_check
    CHECK (executor_config_revision IS NULL OR executor_config_revision > 0),
  ADD CONSTRAINT ky_ai_executor_task_credential_binding_revision_check
    CHECK (credential_binding_revision IS NULL OR credential_binding_revision > 0),
  ADD CONSTRAINT ky_ai_executor_task_runtime_binding_revision_check
    CHECK (runtime_binding_revision IS NULL OR runtime_binding_revision > 0),
  ADD CONSTRAINT ky_ai_executor_task_model_catalog_revision_check
    CHECK (model_catalog_revision IS NULL OR model_catalog_revision > 0),
  ADD CONSTRAINT ky_ai_executor_task_generation_engine_check
    CHECK (generation_engine IN ('', 'legacy_provider', 'codex_executor')),
  ADD CONSTRAINT ky_ai_executor_task_lease_epoch_check
    CHECK (lease_epoch >= 0),
  ADD CONSTRAINT ky_ai_executor_task_source_credential_revision_check
    CHECK (source_credential_revision >= 0),
  ADD CONSTRAINT ky_ai_executor_task_revocation_epoch_check
    CHECK (revocation_epoch >= 0),
  ADD CONSTRAINT ky_ai_executor_task_revision_check
    CHECK (revision > 0),
  ADD CONSTRAINT ky_ai_executor_task_current_sequence_check
    CHECK (current_sequence >= 0),
  ADD CONSTRAINT ky_ai_executor_task_request_hash_check
    CHECK (request_hash = '' OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ky_ai_executor_task_result_safe_json_check
    CHECK (jsonb_typeof(result_safe_json) = 'object'),
  ADD CONSTRAINT ky_ai_executor_task_kind_shape_check
    CHECK (
      (
        task_type IN ('credential_verify', 'model_catalog_refresh', 'readiness_check')
        AND purpose = ''
        AND web_space_id = ''
        AND script_id = ''
        AND script_version_id = ''
        AND contract_id = ''
        AND contract_revision IS NULL
        AND generation_engine = ''
      )
      OR
      (
        task_type IN ('script_generate', 'script_repair', 'script_contract_test')
        AND generation_engine IN ('legacy_provider', 'codex_executor')
      )
    ),
  ADD CONSTRAINT ky_ai_executor_task_codex_binding_check
    CHECK (
      generation_engine <> 'codex_executor'
      OR (
        purpose <> ''
        AND effective_executor_id <> ''
        AND effective_model_key <> ''
        AND executor_source IN ('script_explicit', 'platform_default')
        AND model_source IN ('script_override', 'executor_default')
        AND executor_config_revision IS NOT NULL
        AND credential_binding_revision IS NOT NULL
        AND runtime_binding_id <> ''
        AND runtime_binding_revision IS NOT NULL
        AND model_catalog_revision IS NOT NULL
      )
    ),
  ADD CONSTRAINT ky_ai_executor_task_fencing_shape_check
    CHECK (
      lease_epoch = 0
      OR (
        operation_id <> ''
        AND source_credential_revision > 0
        AND revocation_epoch >= 0
      )
    ),
  ADD CONSTRAINT ky_ai_executor_task_waiting_scan_legacy_check
    CHECK (status <> 'waiting_user_scan' OR generation_engine = 'legacy_provider'),
  ADD CONSTRAINT ky_ai_executor_task_contract_test_shape_check
    CHECK (
      task_type <> 'script_contract_test'
      OR (
        contract_id <> ''
        AND contract_revision IS NOT NULL
        AND script_version_id <> ''
      )
    );

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_binding_idx
  ON ky_ai_executor_task(effective_executor_id, generation_engine, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_operation_idx
  ON ky_ai_executor_task(operation_id)
  WHERE operation_id <> '';

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_request_hash_idx
  ON ky_ai_executor_task(request_hash)
  WHERE request_hash <> '';

ALTER TABLE ky_ai_executor_task_event
  ADD COLUMN IF NOT EXISTS safe_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ky_ai_executor_task_event
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_event_safe_payload_json_check;

ALTER TABLE ky_ai_executor_task_event
  ADD CONSTRAINT ky_ai_executor_task_event_safe_payload_json_check
    CHECK (jsonb_typeof(safe_payload_json) = 'object');

CREATE TABLE IF NOT EXISTS ky_ai_executor_operation_lease (
  executor_id text PRIMARY KEY REFERENCES ky_ai_executor_config(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id <> ''),
  owner_instance_id text NOT NULL CHECK (owner_instance_id <> ''),
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  lease_expires_at timestamptz NOT NULL,
  source_credential_revision bigint NOT NULL DEFAULT 0 CHECK (source_credential_revision >= 0),
  revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired', 'fenced')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_operation_lease_expiry_idx
  ON ky_ai_executor_operation_lease(status, lease_expires_at)
  WHERE status = 'active';

-- A tombstone may exist before its task, so task_id intentionally has no FK.
-- expires_at must remain NULL until cancellation has been materialized.
CREATE TABLE IF NOT EXISTS ky_ai_executor_task_cancellation_tombstone (
  task_id text PRIMARY KEY,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL DEFAULT 'user_requested' CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  materialized_at timestamptz,
  expires_at timestamptz,
  CHECK (expires_at IS NULL OR materialized_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_cancellation_tombstone_pending_idx
  ON ky_ai_executor_task_cancellation_tombstone(created_at)
  WHERE materialized_at IS NULL;

-- Permanent task-ID registry.  Rows are never TTL-deleted and prevent a
-- cancelled/pre-reserved runId from ever being reused with another hash.
CREATE TABLE IF NOT EXISTS ky_ai_executor_task_request_registry (
  task_id text PRIMARY KEY,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  materialized_status text NOT NULL DEFAULT 'reserved' CHECK (materialized_status IN (
    'reserved', 'pending', 'waiting_executor', 'running', 'completed',
    'failed', 'cancelled', 'timeout'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  materialized_at timestamptz,
  finalized_at timestamptz
);

CREATE TABLE IF NOT EXISTS ky_ai_executor_task_outbox (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES ky_ai_executor_task(id) ON DELETE RESTRICT,
  task_sequence bigint NOT NULL CHECK (task_sequence > 0),
  event_type text NOT NULL CHECK (event_type <> ''),
  task_status text NOT NULL CHECK (task_status IN (
    'pending', 'waiting_executor', 'running', 'completed',
    'failed', 'cancelled', 'timeout'
  )),
  executor_id text NOT NULL DEFAULT '',
  workspace_type text NOT NULL CHECK (workspace_type <> ''),
  workspace_id text NOT NULL CHECK (workspace_id <> ''),
  safe_reference_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_reference_json) = 'object'),
  operation_id text NOT NULL DEFAULT '',
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  source_credential_revision bigint NOT NULL DEFAULT 0 CHECK (source_credential_revision >= 0),
  revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'published', 'dead_letter')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  occurred_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, task_sequence, event_type),
  CHECK (
    lease_epoch = 0
    OR (operation_id <> '' AND source_credential_revision > 0)
  )
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_outbox_delivery_idx
  ON ky_ai_executor_task_outbox(delivery_status, next_attempt_at, created_at)
  WHERE delivery_status = 'pending';

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_outbox_task_idx
  ON ky_ai_executor_task_outbox(task_id, task_sequence);
