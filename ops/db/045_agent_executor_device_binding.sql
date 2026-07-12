-- Agent Executor P2A trusted Desktop binding mutation audit.
--
-- Device proofs stay in the immutable request ledger. This table records only
-- the safe, digest-only business facts required to reconstruct an idempotent
-- binding response and audit initial bind, rebind, normal unbind, and the
-- high-risk force-unbind exception.

CREATE TABLE IF NOT EXISTS ky_ai_executor_device_binding_audit (
  operation_reference text PRIMARY KEY CHECK (operation_reference ~ '^[A-Za-z0-9_-]{1,160}$'),
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  binding_revision bigint NOT NULL CHECK (binding_revision > 0),
  event_type text NOT NULL CHECK (event_type IN ('bound', 'rebound', 'unbound', 'force_unbound')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  actor_session_id text NOT NULL CHECK (actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  workspace_type text NOT NULL CHECK (workspace_type = 'platform'),
  workspace_id text NOT NULL CHECK (workspace_id = 'platform_root'),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  from_device_id text NOT NULL DEFAULT '',
  target_device_id text NOT NULL DEFAULT '',
  proof_device_id text NOT NULL DEFAULT '',
  proof_key_generation bigint NOT NULL DEFAULT 0 CHECK (proof_key_generation >= 0),
  proof_sequence bigint NOT NULL DEFAULT 0 CHECK (proof_sequence >= 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmation_id text REFERENCES ky_ai_executor_operation_confirmation(id) ON DELETE RESTRICT,
  force boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  UNIQUE (executor_id, binding_revision),
  CHECK (binding_revision = expected_revision + 1),
  CHECK (
    (event_type = 'bound'
      AND from_device_id = ''
      AND target_device_id ~ '^[0-9a-f]{64}$'
      AND proof_device_id = target_device_id
      AND proof_key_generation > 0
      AND proof_sequence > 0
      AND confirmation_id IS NULL
      AND NOT force)
    OR
    (event_type = 'rebound'
      AND expected_revision > 0
      AND from_device_id ~ '^[0-9a-f]{64}$'
      AND target_device_id ~ '^[0-9a-f]{64}$'
      AND from_device_id <> target_device_id
      AND proof_device_id = target_device_id
      AND proof_key_generation > 0
      AND proof_sequence > 0
      AND confirmation_id IS NOT NULL
      AND NOT force)
    OR
    (event_type = 'unbound'
      AND expected_revision > 0
      AND from_device_id ~ '^[0-9a-f]{64}$'
      AND target_device_id = ''
      AND proof_device_id = from_device_id
      AND proof_key_generation > 0
      AND proof_sequence > 0
      AND confirmation_id IS NOT NULL
      AND NOT force)
    OR
    (event_type = 'force_unbound'
      AND expected_revision > 0
      AND from_device_id ~ '^[0-9a-f]{64}$'
      AND target_device_id = ''
      AND proof_device_id = ''
      AND proof_key_generation = 0
      AND proof_sequence = 0
      AND confirmation_id IS NOT NULL
      AND force)
  )
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_device_binding_audit_actor_idx
  ON ky_ai_executor_device_binding_audit(actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ky_ai_executor_device_binding_audit_device_idx
  ON ky_ai_executor_device_binding_audit(proof_device_id, proof_key_generation, proof_sequence)
  WHERE proof_device_id <> '';

DO $immutable_device_binding_audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_device_binding_audit'::regclass
      AND tgname = 'ky_ai_executor_device_binding_audit_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_device_binding_audit_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_device_binding_audit
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_device_binding_audit$;
