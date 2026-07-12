-- Agent Executor P2A Desktop credential activation recovery.
--
-- Recovery terminalizes only the frozen activation tuple.  It never stores
-- activation tokens, device signatures, credential paths or account fields.

ALTER TABLE ky_ai_executor_credential_activation_audit
  DROP CONSTRAINT IF EXISTS ky_ai_executor_credential_activation_audit_event_type_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_credential_activation_audit_check,
  DROP CONSTRAINT IF EXISTS ky_ai_exec_activation_audit_event_check,
  DROP CONSTRAINT IF EXISTS ky_ai_exec_activation_audit_sequence_check;

ALTER TABLE ky_ai_executor_credential_activation_audit
  ADD CONSTRAINT ky_ai_exec_activation_audit_event_check
    CHECK (event_type IN ('prepared', 'activated', 'expired', 'fenced', 'quarantined')),
  ADD CONSTRAINT ky_ai_exec_activation_audit_sequence_check
    CHECK (
      (sequence = 1 AND event_type = 'prepared')
      OR
      (sequence = 2 AND event_type IN ('activated', 'expired', 'fenced', 'quarantined'))
    );

CREATE INDEX IF NOT EXISTS ky_ai_exec_credential_activation_pending_recovery_idx
  ON ky_ai_executor_credential_activation(expires_at, issued_at, id)
  INCLUDE (
    executor_id, session_id, operation_id, device_id, credential_revision,
    lease_epoch, source_credential_revision, revocation_epoch
  )
  WHERE status = 'pending';

COMMENT ON INDEX ky_ai_exec_credential_activation_pending_recovery_idx IS
  'Bounded scan support for pending Desktop activation expiry and fencing recovery.';
