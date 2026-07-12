ALTER TABLE ky_ai_executor_credential_binding
  ADD COLUMN IF NOT EXISTS operation_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_credential_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS digest_algorithm text NOT NULL DEFAULT '';

DO $credential_digest_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ky_ai_executor_credential_binding
    WHERE runtime_type = 'server'
      AND status IN ('prepared', 'committing', 'active')
      AND (
        operation_id = '' OR lease_epoch <= 0 OR source_credential_revision < 0
        OR digest_algorithm <> 'aicrm-credential-tree-rfc8785-nfc-v1'
      )
  ) THEN
    RAISE EXCEPTION 'legacy server credential binding requires offline re-verification before recovery cutover';
  END IF;
END
$credential_digest_cutover$;

ALTER TABLE ky_ai_executor_credential_binding
  DROP CONSTRAINT IF EXISTS ky_ai_executor_credential_binding_recovery_fence_check;

ALTER TABLE ky_ai_executor_credential_binding
  ADD CONSTRAINT ky_ai_executor_credential_binding_recovery_fence_check
  CHECK (
    runtime_type <> 'server'
    OR status NOT IN ('prepared', 'committing', 'active')
    OR (
      operation_id <> ''
      AND operation_id ~ '^[A-Za-z0-9_-]{1,120}$'
      AND lease_epoch > 0
      AND source_credential_revision >= 0
      AND digest_algorithm = 'aicrm-credential-tree-rfc8785-nfc-v1'
      AND binding_digest ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS ky_ai_executor_credential_binding_recovery_idx
  ON ky_ai_executor_credential_binding(status, runtime_type, executor_id, revision)
  WHERE runtime_type = 'server' AND status IN ('prepared', 'committing', 'quarantined');

COMMENT ON COLUMN ky_ai_executor_credential_binding.operation_id IS
  'Persistent server credential operation fence; opaque and non-secret.';
COMMENT ON COLUMN ky_ai_executor_credential_binding.lease_epoch IS
  'Lease epoch frozen when this credential candidate is prepared.';
COMMENT ON COLUMN ky_ai_executor_credential_binding.source_credential_revision IS
  'Active credential revision observed when this candidate was prepared; zero means none.';
COMMENT ON COLUMN ky_ai_executor_credential_binding.digest_algorithm IS
  'Credential tree digest algorithm identifier; never contains credential material.';
