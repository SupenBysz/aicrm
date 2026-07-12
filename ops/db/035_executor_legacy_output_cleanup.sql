-- Retire the legacy public executor task/TUI runtime without changing schema.
--
-- This migration is intentionally idempotent. It stores only fixed safety
-- codes and never copies legacy subprocess output, credential paths, or
-- authorization challenge material into the replacement state.

WITH sanitized AS (
  SELECT config.id,
         COALESCE(
           (
             SELECT jsonb_object_agg(item.key, item.value)
             FROM jsonb_each(
               CASE
                 WHEN jsonb_typeof(config.capabilities) = 'object' THEN config.capabilities
                 ELSE '{}'::jsonb
               END
             ) AS item(key, value)
             WHERE item.key IN (
               'supportsAppServerAuth',
               'supportsDeviceCodeAuth',
               'supportsDesktopAuth',
               'supportsModelCatalog',
               'supportsReadiness',
               'supportsTaskTransport',
               'supportsCredentialVerification',
               'supportsScriptMaintenance'
             )
               AND jsonb_typeof(item.value) = 'boolean'
           ),
           '{}'::jsonb
         ) AS safe_capabilities
  FROM ky_ai_executor_config config
  WHERE config.executor_type = 'codex'
)
UPDATE ky_ai_executor_config config
SET capabilities = sanitized.safe_capabilities,
    auth_status = 'not_authorized',
    auth_method = '',
    auth_account_label = '',
    bound_device_id = '',
    last_auth_checked_at = NULL,
    last_heartbeat_at = NULL,
    auto_repair_enabled = false,
    allow_page_actions = false,
    allow_storage_read = false,
    allow_cdp_runtime = false,
    allow_script_save = false,
    allow_auto_activate = false,
    app_server_listen = 'stdio://',
    updated_at = now()
FROM sanitized
WHERE config.id = sanitized.id
  AND (
    config.capabilities IS DISTINCT FROM sanitized.safe_capabilities
    OR config.auth_status <> 'not_authorized'
    OR config.auth_method <> ''
    OR config.auth_account_label <> ''
    OR config.bound_device_id <> ''
    OR config.last_auth_checked_at IS NOT NULL
    OR config.last_heartbeat_at IS NOT NULL
    OR config.auto_repair_enabled
    OR config.allow_page_actions
    OR config.allow_storage_read
    OR config.allow_cdp_runtime
    OR config.allow_script_save
    OR config.allow_auto_activate
    OR config.app_server_listen <> 'stdio://'
  );

UPDATE ky_ai_executor_task_raw_log raw
SET raw_text = 'legacy_executor_output_redacted',
    raw_json = jsonb_build_object('failureCode', 'legacy_executor_output_redacted'),
    terminal_line = 'legacy_executor_output_redacted'
WHERE EXISTS (
  SELECT 1
  FROM ky_ai_executor_task task
  WHERE task.id = raw.task_id
    AND task.executor_type = 'codex'
    AND task.task_type = 'script_repair'
)
AND (
  raw.raw_text <> 'legacy_executor_output_redacted'
  OR raw.raw_json <> jsonb_build_object('failureCode', 'legacy_executor_output_redacted')
  OR raw.terminal_line <> 'legacy_executor_output_redacted'
);

UPDATE ky_ai_executor_task_event event
SET message = 'legacy_executor_output_redacted',
    payload_json = jsonb_build_object('failureCode', 'legacy_executor_output_redacted')
WHERE event.event_type LIKE 'codex.%'
  AND EXISTS (
    SELECT 1
    FROM ky_ai_executor_task task
    WHERE task.id = event.task_id
      AND task.executor_type = 'codex'
      AND task.task_type = 'script_repair'
  )
  AND (
    event.message <> 'legacy_executor_output_redacted'
    OR event.payload_json <> jsonb_build_object('failureCode', 'legacy_executor_output_redacted')
  );

UPDATE ky_ai_executor_task
SET result_summary = jsonb_build_object('failureCode', 'legacy_executor_result_redacted'),
    codex_thread_id = '',
    updated_at = now()
WHERE executor_type = 'codex'
  AND task_type = 'script_repair'
  AND (
    result_summary <> jsonb_build_object('failureCode', 'legacy_executor_result_redacted')
    OR codex_thread_id <> ''
  );

UPDATE ky_ai_executor_task
SET error_message = 'legacy_executor_error_redacted',
    updated_at = now()
WHERE executor_type = 'codex'
  AND task_type = 'script_repair'
  AND status IN ('completed', 'failed', 'cancelled', 'timeout')
  AND error_message <> ''
  AND error_message NOT IN (
    'legacy_executor_error_redacted',
    'legacy_executor_runtime_disabled'
  );

UPDATE ky_ai_executor_task
SET status = 'failed',
    error_message = 'legacy_executor_runtime_disabled',
    completed_at = COALESCE(completed_at, now()),
    updated_at = now()
WHERE executor_type = 'codex'
  AND task_type = 'script_repair'
  AND status IN ('pending', 'waiting_executor', 'running', 'waiting_user_scan');
