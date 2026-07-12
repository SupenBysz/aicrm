-- AiCRM migration ledger bootstrap.
--
-- This file is deliberately migration 034. Migrations 001-033 predate the
-- ledger and are registered only after this validation succeeds. The deploy
-- runner owns checksum verification and the PostgreSQL advisory lock.

DO $migration_baseline$
DECLARE
  required_table text;
  missing_tables text[] := ARRAY[]::text[];
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'ky_user',
    'ky_user_credential',
    'ky_user_session',
    'ky_login_log',
    'ky_agency',
    'ky_enterprise',
    'ky_agency_enterprise_relation',
    'ky_department',
    'ky_team',
    'ky_membership',
    'ky_membership_department',
    'ky_membership_team',
    'ky_invitation',
    'ky_role',
    'ky_permission',
    'ky_role_permission',
    'ky_membership_role',
    'ky_role_data_scope',
    'ky_audit_log',
    'ky_notification',
    'ky_notification_read',
    'ky_system_announcement',
    'ky_system_setting',
    'ky_dictionary',
    'ky_dictionary_item',
    'ky_ai_provider',
    'ky_ai_model',
    'ky_ai_model_setting',
    'ky_qualification',
    'ky_platform_profile',
    'ky_notification_template',
    'ky_app_version_rule',
    'ky_storage_setting',
    'ky_sms_account',
    'ky_sms_signature',
    'ky_sms_template',
    'ky_email_account',
    'ky_email_identity',
    'ky_email_template',
    'ky_matrix_account',
    'ky_matrix_account_client_session',
    'ky_matrix_account_login_task',
    'ky_matrix_account_web_space',
    'ky_matrix_account_login_script',
    'ky_matrix_account_login_script_version',
    'ky_matrix_account_login_script_run',
    'ky_matrix_account_login_script_policy',
    'ky_ai_executor_config',
    'ky_ai_executor_task',
    'ky_ai_executor_task_event',
    'ky_ai_executor_task_raw_log',
    'ky_matrix_account_login_attempt',
    'ky_matrix_account_login_attempt_event',
    'ky_matrix_account_login_attempt_command',
    'ky_matrix_account_login_method_run',
    'ky_matrix_account_session_snapshot'
  ]
  LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      missing_tables := array_append(missing_tables, required_table);
    END IF;
  END LOOP;

  IF cardinality(missing_tables) > 0 THEN
    RAISE EXCEPTION 'cannot baseline migrations 001-033; missing tables: %', array_to_string(missing_tables, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ky_matrix_account_client_session'
      AND column_name = 'active_snapshot_id'
  ) THEN
    RAISE EXCEPTION 'cannot baseline migrations 001-033; missing column ky_matrix_account_client_session.active_snapshot_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ky_ai_executor_config'
      AND column_name = 'app_server_listen'
  ) THEN
    RAISE EXCEPTION 'cannot baseline migrations 001-033; missing column ky_ai_executor_config.app_server_listen';
  END IF;
END
$migration_baseline$;

CREATE TABLE IF NOT EXISTS ky_schema_migration (
  version integer PRIMARY KEY CHECK (version > 0),
  filename text NOT NULL UNIQUE CHECK (filename ~ '^[0-9]{3}_[a-z0-9_]+[.]sql$'),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_mode text NOT NULL CHECK (applied_mode IN ('baseline', 'bootstrap', 'migrate')),
  applied_by text NOT NULL DEFAULT current_user,
  applied_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ky_schema_migration IS
  'Immutable migration filename/checksum ledger. Managed only by scripts/deploy_database.sh.';
