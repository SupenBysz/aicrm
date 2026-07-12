-- Agent Executor P2A least-privilege role manifest.
-- Apply only in a non-production P2A environment or the reviewed cutover
-- window. P1 production continues to apply ky_agent_executor_p1_roles.sql.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ky_agent_executor_reader') THEN
    CREATE ROLE ky_agent_executor_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ky_agent_executor_writer') THEN
    CREATE ROLE ky_agent_executor_writer NOLOGIN;
  END IF;
END
$roles$;

ALTER ROLE ky_agent_executor_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ky_agent_executor_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO ky_agent_executor_reader, ky_agent_executor_writer;

GRANT SELECT ON TABLE
  ky_ai_executor_config,
  ky_ai_executor_workspace_grant,
  ky_ai_executor_model_catalog,
  ky_ai_executor_authorization_session,
  ky_ai_executor_authorization_session_event,
  ky_ai_executor_credential_binding,
  ky_ai_executor_device,
  ky_ai_executor_device_registration_challenge,
  ky_ai_executor_device_request_ledger,
  ky_ai_executor_device_binding,
  ky_ai_executor_operation_confirmation,
  ky_ai_executor_control_outbox,
  ky_ai_executor_task,
  ky_ai_executor_task_event,
  ky_ai_executor_task_raw_log,
  ky_ai_executor_operation_lease,
  ky_ai_executor_task_cancellation_tombstone,
  ky_ai_executor_task_request_registry,
  ky_ai_executor_task_outbox,
  ky_ai_executor_runtime_worker,
  ky_ai_executor_desktop_handoff,
  ky_ai_executor_desktop_authorization_proof,
  ky_ai_executor_credential_activation,
  ky_ai_executor_desktop_command_operation,
  ky_ai_executor_credential_revocation,
  ky_ai_executor_api_idempotency
TO ky_agent_executor_reader, ky_agent_executor_writer;

GRANT INSERT, UPDATE ON TABLE
  ky_ai_executor_config,
  ky_ai_executor_workspace_grant,
  ky_ai_executor_authorization_session,
  ky_ai_executor_credential_binding,
  ky_ai_executor_device,
  ky_ai_executor_device_registration_challenge,
  ky_ai_executor_device_binding,
  ky_ai_executor_operation_confirmation,
  ky_ai_executor_control_outbox,
  ky_ai_executor_task,
  ky_ai_executor_operation_lease,
  ky_ai_executor_task_cancellation_tombstone,
  ky_ai_executor_task_request_registry,
  ky_ai_executor_task_outbox,
  ky_ai_executor_runtime_worker,
  ky_ai_executor_desktop_handoff,
  ky_ai_executor_credential_activation,
  ky_ai_executor_desktop_command_operation,
  ky_ai_executor_credential_revocation
TO ky_agent_executor_writer;

GRANT INSERT ON TABLE
  ky_ai_executor_model_catalog,
  ky_ai_executor_authorization_session_event,
  ky_ai_executor_device_request_ledger,
  ky_ai_executor_task_event,
  ky_ai_executor_task_raw_log,
  ky_ai_executor_desktop_authorization_proof,
  ky_ai_executor_api_idempotency
TO ky_agent_executor_writer;

-- Cross-service private tables and secret-bearing identity data stay denied.
REVOKE ALL PRIVILEGES ON TABLE
  ky_user,
  ky_user_session,
  ky_membership,
  ky_role,
  ky_role_permission,
  ky_permission,
  ky_matrix_account,
  ky_matrix_account_web_space,
  ky_matrix_account_login_script,
  ky_matrix_account_login_script_version
FROM ky_agent_executor_writer;
