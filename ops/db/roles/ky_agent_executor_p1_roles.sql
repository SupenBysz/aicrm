-- Agent Executor P1 database role manifest.
--
-- This file is intentionally outside ops/db/[0-9][0-9][0-9]_*.sql and is not
-- applied by deploy_database.sh.  P1 production stays shadow-read-only until a
-- separately approved cutover.  Operators create a LOGIN role out of band and
-- grant it membership in ky_agent_executor_reader; no password is stored here.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ky_agent_executor_reader') THEN
    CREATE ROLE ky_agent_executor_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ky_agent_executor_writer') THEN
    CREATE ROLE ky_agent_executor_writer NOLOGIN;
  END IF;
END
$roles$;

ALTER ROLE ky_agent_executor_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ky_agent_executor_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO ky_agent_executor_reader;
GRANT USAGE ON SCHEMA public TO ky_agent_executor_writer;

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
  ky_ai_executor_task_outbox
TO ky_agent_executor_reader;

-- Deliberately keep the future writer group unable to read or mutate business
-- tables during P1.  Cutover must replace this explicit deny with a reviewed,
-- table-specific grant in the same maintenance window as writer ownership and
-- route switching.
REVOKE ALL PRIVILEGES ON TABLE
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
  ky_ai_executor_task_outbox
FROM ky_agent_executor_writer;
