-- Agent Executor P2A trusted Desktop authorization proof and activation ACK.
--
-- Compact claim/activation JWS values, request bodies, signatures and local
-- credential paths are never persisted.  Only digests, frozen fence facts and
-- database-clock timestamps needed for exact replay are stored.

ALTER TABLE ky_ai_executor_desktop_authorization_proof
  ADD COLUMN IF NOT EXISTS claim_token_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_key_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS device_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_reference text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS response_session_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE ky_ai_executor_desktop_authorization_proof
  DROP CONSTRAINT IF EXISTS ky_ai_executor_desktop_proof_trust_shape_check;

ALTER TABLE ky_ai_executor_desktop_authorization_proof
  ADD CONSTRAINT ky_ai_executor_desktop_proof_trust_shape_check
  CHECK (
    (
      claim_token_hash = '' AND device_key_generation = 0 AND device_sequence = 0
      AND response_reference = '' AND response_session_revision = 0
    )
    OR
    (
      claim_token_hash ~ '^[0-9a-f]{64}$'
      AND device_key_generation > 0
      AND device_sequence > 0
      AND response_reference ~ '^desktop_proof_[A-Za-z0-9_-]{1,160}$'
      AND response_session_revision = session_revision + 1
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_desktop_proof_claim_token_uidx
  ON ky_ai_executor_desktop_authorization_proof(claim_token_hash)
  WHERE claim_token_hash <> '';

ALTER TABLE ky_ai_executor_credential_activation
  ADD COLUMN IF NOT EXISTS device_binding_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS activation_token_key_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS activation_token_nonce_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ack_device_key_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ack_device_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

ALTER TABLE ky_ai_executor_credential_activation
  DROP CONSTRAINT IF EXISTS ky_ai_executor_activation_token_shape_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_activation_ack_shape_check;

ALTER TABLE ky_ai_executor_credential_activation
  ADD CONSTRAINT ky_ai_executor_activation_token_shape_check
  CHECK (
    (
      device_binding_revision = 0
      AND activation_token_key_id = ''
      AND activation_token_nonce_hash = ''
    )
    OR
    (
      device_binding_revision > 0
      AND activation_token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
      AND activation_token_nonce_hash ~ '^[0-9a-f]{64}$'
      AND expires_at = issued_at + interval '10 minutes'
    )
  ) NOT VALID,
  ADD CONSTRAINT ky_ai_executor_activation_ack_shape_check
  CHECK (
    (
      status <> 'active'
      AND ack_request_hash = ''
      AND ack_device_key_generation = 0
      AND ack_device_sequence = 0
      AND acknowledged_at IS NULL
    )
    OR
    (
      status = 'active'
      AND ack_request_hash ~ '^[0-9a-f]{64}$'
      AND ack_device_key_generation > 0
      AND ack_device_sequence > 0
      AND acknowledged_at IS NOT NULL
      AND durable_barrier_completed_at IS NOT NULL
      AND activated_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE ky_ai_executor_credential_binding
  DROP CONSTRAINT IF EXISTS ky_ai_executor_desktop_binding_fence_check;

ALTER TABLE ky_ai_executor_credential_binding
  ADD CONSTRAINT ky_ai_executor_desktop_binding_fence_check
  CHECK (
    runtime_type <> 'desktop'
    OR status NOT IN ('prepared', 'committing', 'active')
    OR (status = 'active' AND authorization_session_id IS NULL)
    OR (
      operation_id = ''
      AND lease_epoch = 0
      AND source_credential_revision = 0
      AND digest_algorithm = ''
    )
    OR (
      device_id ~ '^[0-9a-f]{64}$'
      AND runtime_binding_id = device_id
      AND runtime_binding_revision > 0
      AND operation_id ~ '^[A-Za-z0-9_-]{1,120}$'
      AND lease_epoch > 0
      AND source_credential_revision >= 0
      AND digest_algorithm = 'aicrm-credential-tree-rfc8785-nfc-v1'
      AND binding_digest ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS ky_ai_executor_credential_activation_audit (
  activation_id text NOT NULL REFERENCES ky_ai_executor_credential_activation(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('prepared', 'activated')),
  session_id text NOT NULL REFERENCES ky_ai_executor_authorization_session(id) ON DELETE RESTRICT,
  proof_id text NOT NULL REFERENCES ky_ai_executor_desktop_authorization_proof(id) ON DELETE RESTRICT,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  device_id text NOT NULL REFERENCES ky_ai_executor_device(id) ON DELETE RESTRICT,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,120}$'),
  credential_revision bigint NOT NULL CHECK (credential_revision > 0),
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  source_credential_revision bigint NOT NULL CHECK (source_credential_revision >= 0),
  revocation_epoch bigint NOT NULL CHECK (revocation_epoch >= 0),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activation_id, sequence),
  CHECK ((event_type = 'prepared' AND sequence = 1) OR (event_type = 'activated' AND sequence = 2))
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_credential_activation_audit_executor_idx
  ON ky_ai_executor_credential_activation_audit(executor_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION ky_ai_executor_reject_activation_frozen_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(
    OLD.id, OLD.session_id, OLD.proof_id, OLD.executor_id, OLD.device_id,
    OLD.operation_id, OLD.credential_revision, OLD.lease_epoch,
    OLD.source_credential_revision, OLD.revocation_epoch,
    OLD.device_binding_revision, OLD.binding_digest,
    OLD.activation_token_hash, OLD.activation_token_key_id,
    OLD.activation_token_nonce_hash, OLD.request_hash,
    OLD.issued_at, OLD.expires_at, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.session_id, NEW.proof_id, NEW.executor_id, NEW.device_id,
    NEW.operation_id, NEW.credential_revision, NEW.lease_epoch,
    NEW.source_credential_revision, NEW.revocation_epoch,
    NEW.device_binding_revision, NEW.binding_digest,
    NEW.activation_token_hash, NEW.activation_token_key_id,
    NEW.activation_token_nonce_hash, NEW.request_hash,
    NEW.issued_at, NEW.expires_at, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'credential activation frozen target cannot be modified'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DO $desktop_activation_frozen_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='ky_ai_executor_credential_activation'::regclass
      AND tgname='ky_ai_executor_credential_activation_frozen_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_credential_activation_frozen_trg
      BEFORE UPDATE ON ky_ai_executor_credential_activation
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_activation_frozen_mutation();
  END IF;
END
$desktop_activation_frozen_trigger$;

DO $immutable_desktop_activation_audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='ky_ai_executor_credential_activation_audit'::regclass
      AND tgname='ky_ai_executor_credential_activation_audit_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_credential_activation_audit_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_credential_activation_audit
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_desktop_activation_audit$;

COMMENT ON COLUMN ky_ai_executor_credential_activation.activation_token_key_id IS
  'Public key identifier used to deterministically reconstruct the activation JWS; never key material.';
COMMENT ON COLUMN ky_ai_executor_credential_activation.activation_token_nonce_hash IS
  'SHA-256 of the deterministic activation nonce; the nonce itself is response-only.';
