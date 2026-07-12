-- Agent Executor P2A trusted Desktop authorization handoff/claim metadata.
--
-- Handoff and claim compact JWS values remain memory-only. PostgreSQL stores
-- only hashes, key identifiers, deterministic nonce hashes, frozen claims and
-- database-clock issuance times so exact retries can fail closed or rebuild
-- the byte-identical token with the original signing key.

ALTER TABLE ky_ai_executor_desktop_handoff
  ADD COLUMN IF NOT EXISTS claim_token_key_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claim_token_nonce_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claim_token_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_session_revision bigint;

ALTER TABLE ky_ai_executor_desktop_handoff
  DROP CONSTRAINT IF EXISTS ky_ai_executor_handoff_ticket_key_id_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_handoff_claim_key_id_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_handoff_claim_nonce_hash_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_handoff_claim_session_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_handoff_claim_metadata_check;

ALTER TABLE ky_ai_executor_desktop_handoff
  ADD CONSTRAINT ky_ai_executor_handoff_ticket_key_id_check
    CHECK (token_key_id ~ '^[A-Za-z0-9_-]{1,64}$') NOT VALID,
  ADD CONSTRAINT ky_ai_executor_handoff_claim_key_id_check
    CHECK (claim_token_key_id = '' OR claim_token_key_id ~ '^[A-Za-z0-9_-]{1,64}$') NOT VALID,
  ADD CONSTRAINT ky_ai_executor_handoff_claim_nonce_hash_check
    CHECK (claim_token_nonce_hash = '' OR claim_token_nonce_hash ~ '^[0-9a-f]{64}$') NOT VALID,
  ADD CONSTRAINT ky_ai_executor_handoff_claim_session_revision_check
    CHECK (claimed_session_revision IS NULL OR claimed_session_revision > 0) NOT VALID,
  ADD CONSTRAINT ky_ai_executor_handoff_claim_metadata_check
    CHECK (
      (
        claim_token_hash = ''
        AND claim_token_key_id = ''
        AND claim_token_nonce_hash = ''
        AND claim_token_issued_at IS NULL
        AND claim_expires_at IS NULL
        AND claimed_session_revision IS NULL
      )
      OR
      (
        claim_token_hash ~ '^[0-9a-f]{64}$'
        AND claim_token_key_id ~ '^[A-Za-z0-9_-]{1,64}$'
        AND claim_token_nonce_hash ~ '^[0-9a-f]{64}$'
        AND claim_token_issued_at IS NOT NULL
        AND claim_expires_at = claim_token_issued_at + interval '5 minutes'
        AND claimed_session_revision = expected_session_revision + 1
        AND status IN ('claimed', 'proof_submitted', 'expired', 'cancelled')
      )
    ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_desktop_handoff_ticket_hash_uidx
  ON ky_ai_executor_desktop_handoff(ticket_hash);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_desktop_handoff_claim_token_hash_uidx
  ON ky_ai_executor_desktop_handoff(claim_token_hash)
  WHERE claim_token_hash <> '';
