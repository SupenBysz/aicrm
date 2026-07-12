-- Least-privilege supplement for migration 049 trusted Desktop commands.

GRANT SELECT, INSERT, UPDATE ON TABLE
  ky_ai_executor_desktop_command_operation
TO ky_agent_executor_writer;

GRANT SELECT, INSERT ON TABLE
  ky_ai_executor_desktop_command_audit
TO ky_agent_executor_writer;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  ky_ai_executor_desktop_command_audit
FROM ky_agent_executor_writer;
