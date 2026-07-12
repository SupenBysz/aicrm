-- Trusted Desktop authorization cancel/reopen command operations.
--
-- Compact JWS command tickets are never persisted.  The database retains
-- only frozen target claims, hashes, database-clock timestamps and signed
-- ACK ledger references.  Existing credential_logout rows from migration 047
-- remain valid and keep their executor-scoped idempotency contract.

ALTER TABLE ky_ai_executor_desktop_command_operation
  ADD COLUMN IF NOT EXISTS actor_session_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ack_device_key_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ack_device_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS device_completed_at timestamptz;

-- The original table-level UNIQUE was wider than the locked authorization
-- command scope.  Replace it with purpose-specific partial indexes: session
-- commands scope keys to the authorization session, while credential logout
-- and all other executor commands retain the original executor scope.
DO $drop_legacy_command_unique$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'ky_ai_executor_desktop_command_operation'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE
        'UNIQUE (requested_by, executor_id, purpose, idempotency_key_hash)%'
  LOOP
    EXECUTE format(
      'ALTER TABLE ky_ai_executor_desktop_command_operation DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$drop_legacy_command_unique$;

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_exec_desktop_session_command_idem_uidx
  ON ky_ai_executor_desktop_command_operation(
    requested_by, session_id, purpose, idempotency_key_hash
  )
  WHERE purpose IN ('authorization_cancel', 'authorization_reopen');

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_exec_desktop_executor_command_idem_uidx
  ON ky_ai_executor_desktop_command_operation(
    requested_by, executor_id, purpose, idempotency_key_hash
  )
  WHERE purpose NOT IN ('authorization_cancel', 'authorization_reopen');

ALTER TABLE ky_ai_executor_desktop_command_operation
  DROP CONSTRAINT IF EXISTS ky_ai_exec_desktop_authorization_command_security_check;

ALTER TABLE ky_ai_executor_desktop_command_operation
  ADD CONSTRAINT ky_ai_exec_desktop_authorization_command_security_check
  CHECK (
    NOT security_contract_verified
    OR purpose NOT IN ('authorization_cancel', 'authorization_reopen')
    OR (
      session_id IS NOT NULL
      AND session_id ~ '^[A-Za-z0-9_-]{1,160}$'
      AND executor_id ~ '^[A-Za-z0-9_-]{1,160}$'
      AND device_id ~ '^[0-9a-f]{64}$'
      AND requested_by ~ '^[A-Za-z0-9_-]{1,160}$'
      AND actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'
      AND expected_session_revision > 0
      AND expected_executor_revision IS NULL
      AND expected_credential_revision IS NULL
      AND expected_catalog_revision IS NULL
      AND revocation_id = ''
      AND revocation_epoch = 0
      AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_hash ~ '^[0-9a-f]{64}$'
      AND command_ticket_hash ~ '^[0-9a-f]{64}$'
      AND token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
      AND token_nonce_hash ~ '^[0-9a-f]{64}$'
      AND expires_at = issued_at + interval '120 seconds'
      AND (
        (
          status = 'pending'
          AND failure_code = ''
          AND ack_request_hash = ''
          AND ack_device_key_generation = 0
          AND ack_device_sequence = 0
          AND device_completed_at IS NULL
          AND completed_at IS NULL
        )
        OR
        (
          status IN ('succeeded', 'stale_target')
          AND failure_code = ''
          AND ack_request_hash ~ '^[0-9a-f]{64}$'
          AND ack_device_key_generation > 0
          AND ack_device_sequence > 0
          AND device_completed_at IS NOT NULL
          AND completed_at IS NOT NULL
        )
        OR
        (
          status = 'failed'
          AND failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
          AND ack_request_hash ~ '^[0-9a-f]{64}$'
          AND ack_device_key_generation > 0
          AND ack_device_sequence > 0
          AND device_completed_at IS NOT NULL
          AND completed_at IS NOT NULL
        )
        OR
        (
          status = 'expired'
          AND failure_code = 'command_ticket_expired'
          AND ack_request_hash = ''
          AND ack_device_key_generation = 0
          AND ack_device_sequence = 0
          AND device_completed_at IS NULL
          AND completed_at IS NOT NULL
        )
      )
    )
  );

CREATE TABLE IF NOT EXISTS ky_ai_executor_desktop_command_audit (
  operation_id text NOT NULL REFERENCES ky_ai_executor_desktop_command_operation(id) ON DELETE RESTRICT,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 2),
  event_type text NOT NULL CHECK (event_type IN ('created', 'succeeded', 'failed', 'stale_target')),
  session_id text NOT NULL REFERENCES ky_ai_executor_authorization_session(id) ON DELETE RESTRICT,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  device_id text NOT NULL CHECK (device_id ~ '^[0-9a-f]{64}$'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  actor_session_id text NOT NULL CHECK (actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  purpose text NOT NULL CHECK (purpose IN ('authorization_cancel', 'authorization_reopen')),
  expected_session_revision bigint NOT NULL CHECK (expected_session_revision > 0),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'stale_target')),
  failure_code text NOT NULL DEFAULT '' CHECK (failure_code ~ '^[a-z0-9_]{0,64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ack_request_hash text NOT NULL DEFAULT '' CHECK (
    ack_request_hash = '' OR ack_request_hash ~ '^[0-9a-f]{64}$'
  ),
  proof_key_generation bigint NOT NULL DEFAULT 0 CHECK (proof_key_generation >= 0),
  proof_sequence bigint NOT NULL DEFAULT 0 CHECK (proof_sequence >= 0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (operation_id, sequence),
  CHECK (
    (sequence = 1 AND event_type = 'created' AND status = 'pending'
      AND ack_request_hash = '' AND proof_key_generation = 0 AND proof_sequence = 0)
    OR
    (sequence = 2 AND event_type = status AND status IN ('succeeded', 'failed', 'stale_target')
      AND ack_request_hash ~ '^[0-9a-f]{64}$'
      AND proof_key_generation > 0 AND proof_sequence > 0)
  )
);

CREATE INDEX IF NOT EXISTS ky_ai_exec_desktop_command_audit_session_idx
  ON ky_ai_executor_desktop_command_audit(session_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION ky_ai_exec_desktop_authorization_command_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.security_contract_verified
     AND OLD.purpose IN ('authorization_cancel', 'authorization_reopen')
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.executor_id IS DISTINCT FROM OLD.executor_id
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.device_id IS DISTINCT FROM OLD.device_id
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.actor_session_id IS DISTINCT FROM OLD.actor_session_id
       OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.expected_executor_revision IS DISTINCT FROM OLD.expected_executor_revision
       OR NEW.expected_session_revision IS DISTINCT FROM OLD.expected_session_revision
       OR NEW.expected_credential_revision IS DISTINCT FROM OLD.expected_credential_revision
       OR NEW.expected_catalog_revision IS DISTINCT FROM OLD.expected_catalog_revision
       OR NEW.revocation_id IS DISTINCT FROM OLD.revocation_id
       OR NEW.revocation_epoch IS DISTINCT FROM OLD.revocation_epoch
       OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.command_ticket_hash IS DISTINCT FROM OLD.command_ticket_hash
       OR NEW.token_key_id IS DISTINCT FROM OLD.token_key_id
       OR NEW.token_nonce_hash IS DISTINCT FROM OLD.token_nonce_hash
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.security_contract_verified IS DISTINCT FROM OLD.security_contract_verified
     ) THEN
    RAISE EXCEPTION 'desktop authorization command frozen target is immutable';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS ky_ai_exec_desktop_authorization_command_frozen_trg
  ON ky_ai_executor_desktop_command_operation;

CREATE TRIGGER ky_ai_exec_desktop_authorization_command_frozen_trg
  BEFORE UPDATE ON ky_ai_executor_desktop_command_operation
  FOR EACH ROW EXECUTE FUNCTION ky_ai_exec_desktop_authorization_command_frozen();

DO $immutable_command_audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_desktop_command_audit'::regclass
      AND tgname = 'ky_ai_exec_desktop_command_audit_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_exec_desktop_command_audit_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_desktop_command_audit
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_command_audit$;
