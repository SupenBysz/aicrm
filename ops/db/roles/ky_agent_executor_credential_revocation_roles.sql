-- Least-privilege supplement for the credential-revocation trust core.
-- Apply after ky_agent_executor_p2a_roles.sql and migration 047.

GRANT SELECT, INSERT, UPDATE ON TABLE
  ky_ai_executor_credential_revocation,
  ky_ai_executor_desktop_command_operation
TO ky_agent_executor_writer;

GRANT SELECT, INSERT ON TABLE
  ky_ai_executor_credential_revocation_audit
TO ky_agent_executor_writer;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  ky_ai_executor_credential_revocation_audit
FROM ky_agent_executor_writer;
