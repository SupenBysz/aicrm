-- Agent Executor v9.1 P2A public-control idempotency and audit references.
-- Only digests and opaque resource references are persisted here.

CREATE TABLE IF NOT EXISTS ky_ai_executor_api_idempotency (
  actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  scope_id text NOT NULL CHECK (btrim(scope_id) <> ''),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_type text NOT NULL CHECK (resource_type IN (
    'executor', 'authorization_session', 'workspace_grant', 'executor_task',
    'desktop_operation', 'credential_revocation', 'device', 'device_registration',
    'operation_confirmation'
  )),
  resource_id text NOT NULL CHECK (btrim(resource_id) <> ''),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, action, scope_id, idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_api_idempotency_resource_idx
  ON ky_ai_executor_api_idempotency(resource_type, resource_id);

DO $immutable_idempotency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_api_idempotency'::regclass
      AND tgname = 'ky_ai_executor_api_idempotency_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_api_idempotency_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_api_idempotency
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_idempotency$;

ALTER TABLE ky_ai_executor_control_outbox
  DROP CONSTRAINT IF EXISTS ky_ai_executor_control_outbox_aggregate_type_check;

ALTER TABLE ky_ai_executor_control_outbox
  ADD CONSTRAINT ky_ai_executor_control_outbox_aggregate_type_check
    CHECK (aggregate_type IN (
      'executor', 'authorization_session', 'credential_binding',
      'device', 'device_binding', 'operation_confirmation',
      'workspace_grant', 'model_catalog', 'readiness',
      'desktop_handoff', 'desktop_operation', 'credential_revocation'
    ));
