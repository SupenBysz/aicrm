-- P2A Desktop authorization proof/activation least-privilege add-on.
-- Apply after ky_agent_executor_p2a_roles.sql and migration 048.

GRANT SELECT ON TABLE
  ky_ai_executor_config,
  ky_ai_executor_authorization_session,
  ky_ai_executor_authorization_session_event,
  ky_ai_executor_credential_binding,
  ky_ai_executor_device,
  ky_ai_executor_device_binding,
  ky_ai_executor_device_request_ledger,
  ky_ai_executor_desktop_handoff,
  ky_ai_executor_desktop_authorization_proof,
  ky_ai_executor_credential_activation,
  ky_ai_executor_credential_activation_audit,
  ky_ai_executor_operation_lease,
  ky_ai_executor_control_outbox
TO ky_agent_executor_reader, ky_agent_executor_writer;

GRANT INSERT, UPDATE ON TABLE
  ky_ai_executor_config,
  ky_ai_executor_authorization_session,
  ky_ai_executor_credential_binding,
  ky_ai_executor_device,
  ky_ai_executor_desktop_handoff,
  ky_ai_executor_credential_activation,
  ky_ai_executor_operation_lease
TO ky_agent_executor_writer;

GRANT INSERT ON TABLE
  ky_ai_executor_authorization_session_event,
  ky_ai_executor_device_request_ledger,
  ky_ai_executor_desktop_authorization_proof,
  ky_ai_executor_credential_activation_audit,
  ky_ai_executor_control_outbox
TO ky_agent_executor_writer;

REVOKE UPDATE, DELETE ON TABLE
  ky_ai_executor_authorization_session_event,
  ky_ai_executor_device_request_ledger,
  ky_ai_executor_desktop_authorization_proof,
  ky_ai_executor_credential_activation_audit
FROM ky_agent_executor_writer;

REVOKE ALL PRIVILEGES ON TABLE
  ky_user,
  ky_user_session,
  ky_membership,
  ky_role,
  ky_role_permission,
  ky_permission
FROM ky_agent_executor_reader, ky_agent_executor_writer;
