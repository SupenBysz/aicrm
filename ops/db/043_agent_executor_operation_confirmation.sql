-- Agent Executor v9.1 P2A operation-confirmation hardening.
--
-- Challenge text and compact JWS values intentionally have no plaintext
-- columns.  Only digests and the immutable claims needed to reconstruct and
-- audit a deterministic token are persisted.

ALTER TABLE ky_ai_executor_operation_confirmation
  ADD COLUMN IF NOT EXISTS actor_session_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS security_facts_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS login_authenticated_at timestamptz,
  ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS token_key_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS token_nonce_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS token_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumption_reference text NOT NULL DEFAULT '';

-- Rows created before this contract did not freeze the browser login session.
-- Keep them readable for audit, but never make them eligible for confirmation
-- or token consumption under the hardened store.
UPDATE ky_ai_executor_operation_confirmation
SET actor_session_id = 'legacy_' || substr(md5(id), 1, 32)
WHERE actor_session_id = '';

ALTER TABLE ky_ai_executor_operation_confirmation
  ALTER COLUMN actor_session_id DROP DEFAULT,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_confirmation_actor_session_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_confirmation_security_facts_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_confirmation_target_shape_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_confirmation_token_shape_check;

ALTER TABLE ky_ai_executor_operation_confirmation
  ADD CONSTRAINT ky_ai_executor_confirmation_actor_session_check
    CHECK (actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  ADD CONSTRAINT ky_ai_executor_confirmation_security_facts_check
    CHECK (
      NOT security_facts_verified OR (
        owner_verified
        AND login_authenticated_at IS NOT NULL
        AND (NOT mfa_required OR mfa_verified)
        AND expires_at = created_at + interval '5 minutes'
      )
    ),
  ADD CONSTRAINT ky_ai_executor_confirmation_target_shape_check
    CHECK (
      NOT security_facts_verified OR
      (action = 'force_revoke' AND from_device_id = '' AND target_device_id = '') OR
      (action = 'rebind_device'
        AND from_device_id ~ '^[0-9a-f]{64}$'
        AND target_device_id ~ '^[0-9a-f]{64}$'
        AND from_device_id <> target_device_id) OR
      (action = 'unbind_device'
        AND from_device_id ~ '^[0-9a-f]{64}$'
        AND target_device_id = '')
    ),
  ADD CONSTRAINT ky_ai_executor_confirmation_token_shape_check
    CHECK (
      NOT security_facts_verified OR (
        (status = 'pending'
          AND confirmation_token_hash = ''
          AND token_key_id = ''
          AND token_nonce_hash = ''
          AND token_issued_at IS NULL
          AND token_expires_at IS NULL
          AND confirmed_at IS NULL
          AND consumed_at IS NULL
          AND consumption_reference = '')
        OR
        (status = 'confirmed'
          AND confirmation_token_hash ~ '^[0-9a-f]{64}$'
          AND token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
          AND token_nonce_hash ~ '^[0-9a-f]{64}$'
          AND token_issued_at IS NOT NULL
          AND token_expires_at = token_issued_at + interval '5 minutes'
          AND confirmed_at = token_issued_at
          AND consumed_at IS NULL
          AND consumption_reference = '')
        OR
        (status = 'consumed'
          AND confirmation_token_hash ~ '^[0-9a-f]{64}$'
          AND token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
          AND token_nonce_hash ~ '^[0-9a-f]{64}$'
          AND token_issued_at IS NOT NULL
          AND token_expires_at = token_issued_at + interval '5 minutes'
          AND confirmed_at = token_issued_at
          AND consumed_at IS NOT NULL
          AND consumption_reference ~ '^[A-Za-z0-9_-]{1,160}$')
        OR
        (status = 'expired'
          AND consumed_at IS NULL
          AND consumption_reference = ''
          AND (
            (confirmation_token_hash = ''
              AND token_key_id = ''
              AND token_nonce_hash = ''
              AND token_issued_at IS NULL
              AND token_expires_at IS NULL
              AND confirmed_at IS NULL)
            OR
            (confirmation_token_hash ~ '^[0-9a-f]{64}$'
              AND token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
              AND token_nonce_hash ~ '^[0-9a-f]{64}$'
              AND token_issued_at IS NOT NULL
              AND token_expires_at = token_issued_at + interval '5 minutes'
              AND confirmed_at = token_issued_at)
          ))
      )
    );

CREATE TABLE IF NOT EXISTS ky_ai_executor_operation_confirmation_audit (
  confirmation_id text NOT NULL REFERENCES ky_ai_executor_operation_confirmation(id) ON DELETE RESTRICT,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'confirmed', 'consumed', 'challenge_expired', 'token_expired'
  )),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  actor_session_id text NOT NULL CHECK (actor_session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  action text NOT NULL CHECK (action IN ('force_revoke', 'rebind_device', 'unbind_device')),
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  from_device_id text NOT NULL DEFAULT '',
  target_device_id text NOT NULL DEFAULT '',
  owner_verified boolean NOT NULL,
  login_authenticated_at timestamptz NOT NULL,
  mfa_required boolean NOT NULL,
  mfa_verified boolean NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  consumption_reference text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (confirmation_id, sequence),
  CHECK (NOT mfa_required OR mfa_verified),
  CHECK (
    (action = 'force_revoke' AND from_device_id = '' AND target_device_id = '') OR
    (action = 'rebind_device'
      AND from_device_id ~ '^[0-9a-f]{64}$'
      AND target_device_id ~ '^[0-9a-f]{64}$'
      AND from_device_id <> target_device_id) OR
    (action = 'unbind_device'
      AND from_device_id ~ '^[0-9a-f]{64}$'
      AND target_device_id = '')
  ),
  CHECK (consumption_reference = '' OR consumption_reference ~ '^[A-Za-z0-9_-]{1,160}$')
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_operation_confirmation_audit_actor_idx
  ON ky_ai_executor_operation_confirmation_audit(actor_id, occurred_at DESC);

DO $immutable_confirmation_audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_operation_confirmation_audit'::regclass
      AND tgname = 'ky_ai_executor_operation_confirmation_audit_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_operation_confirmation_audit_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_operation_confirmation_audit
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_confirmation_audit$;
