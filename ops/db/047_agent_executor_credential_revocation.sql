-- Agent Executor v9.1 credential-revocation trust core.
--
-- Legacy revocation/desktop-command rows remain readable but are never
-- promoted into this contract. New rows freeze every ticket target and retain
-- only deterministic reconstruction metadata and SHA-256 digests.

ALTER TABLE ky_ai_executor_credential_revocation
  ADD COLUMN IF NOT EXISTS actor_session_id text,
  ADD COLUMN IF NOT EXISTS runtime_type text,
  ADD COLUMN IF NOT EXISTS confirmation_id text,
  ADD COLUMN IF NOT EXISTS runtime_binding_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS runtime_binding_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_key_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS token_nonce_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS token_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS ack_request_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS security_contract_verified boolean NOT NULL DEFAULT false;

UPDATE ky_ai_executor_credential_revocation
SET actor_session_id = 'legacy_' || substr(md5(id), 1, 32)
WHERE actor_session_id IS NULL OR actor_session_id = '';

UPDATE ky_ai_executor_credential_revocation
SET runtime_type = CASE WHEN device_id = '' THEN 'server' ELSE 'desktop' END
WHERE runtime_type IS NULL OR runtime_type = '';

ALTER TABLE ky_ai_executor_credential_revocation
  ALTER COLUMN actor_session_id SET NOT NULL,
  ALTER COLUMN runtime_type SET NOT NULL,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_credential_revocation_security_contract_check;

ALTER TABLE ky_ai_executor_credential_revocation
  ADD CONSTRAINT ky_ai_executor_credential_revocation_security_contract_check
  CHECK (
    NOT security_contract_verified OR (
      actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'
      AND runtime_type IN ('server', 'desktop')
      AND runtime_binding_id ~ '^[A-Za-z0-9_-]{1,160}$'
      AND runtime_binding_revision > 0
      AND ((force AND confirmation_id ~ '^[A-Za-z0-9_-]{1,160}$') OR (NOT force AND confirmation_id IS NULL))
      AND (
        (
          runtime_type = 'server'
          AND device_id = ''
          AND command_ticket_hash = ''
          AND token_key_id = ''
          AND token_nonce_hash = ''
          AND token_issued_at IS NULL
          AND token_expires_at IS NULL
          AND ack_request_hash = ''
          AND device_completed_at IS NULL
          AND status = 'completed'
          AND completed_at IS NOT NULL
        )
        OR
        (
          runtime_type = 'desktop'
          AND device_id ~ '^[0-9a-f]{64}$'
          AND command_ticket_hash ~ '^[0-9a-f]{64}$'
          AND token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
          AND token_nonce_hash ~ '^[0-9a-f]{64}$'
          AND token_issued_at IS NOT NULL
          AND token_expires_at = token_issued_at + interval '120 seconds'
          AND (
            (status = 'awaiting_device'
              AND ack_request_hash = ''
              AND device_completed_at IS NULL
              AND completed_at IS NULL)
            OR
            (status IN ('completed', 'failed', 'stale_target')
              AND ack_request_hash ~ '^[0-9a-f]{64}$'
              AND device_completed_at IS NOT NULL
              AND completed_at IS NOT NULL)
          )
        )
      )
    )
  );

CREATE INDEX IF NOT EXISTS ky_ai_executor_credential_revocation_pending_idx
  ON ky_ai_executor_credential_revocation(device_id, status, token_expires_at)
  WHERE security_contract_verified AND status = 'awaiting_device';

ALTER TABLE ky_ai_executor_desktop_command_operation
  ADD COLUMN IF NOT EXISTS token_nonce_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ack_request_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS security_contract_verified boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_desktop_command_logout_security_check;

ALTER TABLE ky_ai_executor_desktop_command_operation
  ADD CONSTRAINT ky_ai_executor_desktop_command_logout_security_check
  CHECK (
    NOT security_contract_verified OR purpose <> 'credential_logout' OR (
      device_id ~ '^[0-9a-f]{64}$'
      AND requested_by ~ '^[A-Za-z0-9_-]{1,160}$'
      AND expected_credential_revision > 0
      AND revocation_id ~ '^[A-Za-z0-9_-]{1,160}$'
      AND revocation_epoch > 0
      AND command_ticket_hash ~ '^[0-9a-f]{64}$'
      AND token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
      AND token_nonce_hash ~ '^[0-9a-f]{64}$'
      AND expires_at = issued_at + interval '120 seconds'
      AND (
        (status = 'pending' AND ack_request_hash = '')
        OR (status IN ('succeeded', 'failed', 'stale_target', 'expired')
            AND ack_request_hash ~ '^[0-9a-f]{64}$')
      )
    )
  );

CREATE TABLE IF NOT EXISTS ky_ai_executor_credential_revocation_audit (
  revocation_id text NOT NULL REFERENCES ky_ai_executor_credential_revocation(id) ON DELETE RESTRICT,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 2),
  event_type text NOT NULL CHECK (event_type IN ('created', 'completed', 'failed', 'stale_target')),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  actor_session_id text NOT NULL CHECK (actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  runtime_type text NOT NULL CHECK (runtime_type IN ('server', 'desktop')),
  device_id text NOT NULL DEFAULT '',
  credential_revision bigint NOT NULL CHECK (credential_revision > 0),
  revocation_epoch bigint NOT NULL CHECK (revocation_epoch > 0),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  force boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_device', 'completed', 'failed', 'stale_target')),
  failure_code text NOT NULL DEFAULT '' CHECK (failure_code ~ '^[a-z0-9_]{0,64}$'),
  quarantine_digest text NOT NULL DEFAULT '' CHECK (
    quarantine_digest = '' OR quarantine_digest ~ '^[0-9a-f]{64}$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmation_id text,
  runtime_binding_id text NOT NULL CHECK (runtime_binding_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  runtime_binding_revision bigint NOT NULL CHECK (runtime_binding_revision > 0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (revocation_id, sequence)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_credential_revocation_audit_actor_idx
  ON ky_ai_executor_credential_revocation_audit(actor_id, occurred_at DESC);

ALTER TABLE ky_ai_executor_credential_revocation_audit
  ADD COLUMN IF NOT EXISTS confirmation_id text,
  ADD COLUMN IF NOT EXISTS runtime_binding_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS runtime_binding_revision bigint NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_credential_revocation_audit_confirmation_shape_c,
  DROP CONSTRAINT IF EXISTS ky_ai_exec_revocation_audit_confirmation_check;

ALTER TABLE ky_ai_executor_credential_revocation_audit
  ADD CONSTRAINT ky_ai_exec_revocation_audit_confirmation_check
  CHECK (
    (force AND confirmation_id ~ '^[A-Za-z0-9_-]{1,160}$')
    OR (NOT force AND confirmation_id IS NULL)
  );

ALTER TABLE ky_ai_executor_credential_revocation_audit
  DROP CONSTRAINT IF EXISTS ky_ai_exec_revocation_audit_runtime_check;

ALTER TABLE ky_ai_executor_credential_revocation_audit
  ADD CONSTRAINT ky_ai_exec_revocation_audit_runtime_check
  CHECK (
    runtime_binding_id ~ '^[A-Za-z0-9_-]{1,160}$'
    AND runtime_binding_revision > 0
  );

DO $confirmation_foreign_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='ky_ai_executor_credential_revocation'::regclass
      AND conname='ky_ai_executor_credential_revocation_confirmation_fk'
  ) THEN
    ALTER TABLE ky_ai_executor_credential_revocation
      ADD CONSTRAINT ky_ai_executor_credential_revocation_confirmation_fk
      FOREIGN KEY (confirmation_id) REFERENCES ky_ai_executor_operation_confirmation(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='ky_ai_executor_credential_revocation_audit'::regclass
      AND conname='ky_ai_executor_credential_revocation_audit_confirmation_fk'
  ) THEN
    ALTER TABLE ky_ai_executor_credential_revocation_audit
      ADD CONSTRAINT ky_ai_executor_credential_revocation_audit_confirmation_fk
      FOREIGN KEY (confirmation_id) REFERENCES ky_ai_executor_operation_confirmation(id) ON DELETE RESTRICT;
  END IF;
END
$confirmation_foreign_keys$;

CREATE OR REPLACE FUNCTION ky_ai_executor_credential_revocation_reject_frozen_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.executor_id IS DISTINCT FROM OLD.executor_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.credential_revision IS DISTINCT FROM OLD.credential_revision
     OR NEW.revocation_epoch IS DISTINCT FROM OLD.revocation_epoch
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.actor_session_id IS DISTINCT FROM OLD.actor_session_id
     OR NEW.runtime_type IS DISTINCT FROM OLD.runtime_type
     OR NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id
     OR NEW.runtime_binding_id IS DISTINCT FROM OLD.runtime_binding_id
     OR NEW.runtime_binding_revision IS DISTINCT FROM OLD.runtime_binding_revision
     OR NEW.force IS DISTINCT FROM OLD.force
     OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.command_ticket_hash IS DISTINCT FROM OLD.command_ticket_hash
     OR NEW.token_key_id IS DISTINCT FROM OLD.token_key_id
     OR NEW.token_nonce_hash IS DISTINCT FROM OLD.token_nonce_hash
     OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at
     OR NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.security_contract_verified IS DISTINCT FROM OLD.security_contract_verified THEN
    RAISE EXCEPTION 'credential revocation frozen target is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION ky_ai_executor_logout_command_reject_frozen_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.purpose = 'credential_logout' AND OLD.security_contract_verified AND (
     NEW.id IS DISTINCT FROM OLD.id
     OR NEW.executor_id IS DISTINCT FROM OLD.executor_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.expected_credential_revision IS DISTINCT FROM OLD.expected_credential_revision
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
     OR NEW.security_contract_verified IS DISTINCT FROM OLD.security_contract_verified) THEN
    RAISE EXCEPTION 'credential logout command frozen target is immutable';
  END IF;
  RETURN NEW;
END
$function$;

DO $immutable_revocation_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='ky_ai_executor_credential_revocation'::regclass
      AND tgname='ky_ai_executor_credential_revocation_frozen_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_credential_revocation_frozen_trg
      BEFORE UPDATE ON ky_ai_executor_credential_revocation
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_credential_revocation_reject_frozen_change();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='ky_ai_executor_desktop_command_operation'::regclass
      AND tgname='ky_ai_executor_logout_command_frozen_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_logout_command_frozen_trg
      BEFORE UPDATE ON ky_ai_executor_desktop_command_operation
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_logout_command_reject_frozen_change();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='ky_ai_executor_credential_revocation_audit'::regclass
      AND tgname='ky_ai_executor_credential_revocation_audit_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_credential_revocation_audit_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_credential_revocation_audit
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_revocation_contract$;
