-- P0 security boundary for AI executor repair tasks.
--
-- Historical repair tasks were allowed to persist browser credential context.
-- Keep task/audit metadata, but remove payloads that may contain Cookie,
-- Storage, Token or other login material. New writes are also sanitized in the
-- AI model service before they reach this table.

UPDATE ky_ai_executor_task
SET result_summary = (
      result_summary
      - 'sensitiveContext'
      - 'browserPartition'
      - 'cookies'
      - 'cookie'
      - 'localStorage'
      - 'sessionStorage'
      - 'indexedDB'
      - 'storage'
      - 'token'
      - 'tokens'
      - 'credentials'
      - 'scriptResult'
    )
    #- '{snapshot,sensitiveContext}'
    #- '{snapshot,browserPartition}'
    #- '{snapshot,cookies}'
    #- '{snapshot,cookie}'
    #- '{snapshot,localStorage}'
    #- '{snapshot,sessionStorage}'
    #- '{snapshot,indexedDB}'
    #- '{snapshot,storage}'
    #- '{snapshot,token}'
    #- '{snapshot,tokens}'
WHERE task_type = 'script_repair'
  AND (
    result_summary ?| ARRAY[
      'sensitiveContext', 'browserPartition', 'cookies', 'cookie',
      'localStorage', 'sessionStorage', 'indexedDB', 'storage',
      'token', 'tokens', 'credentials', 'scriptResult'
    ]
    OR result_summary #> '{snapshot,sensitiveContext}' IS NOT NULL
    OR result_summary #> '{snapshot,browserPartition}' IS NOT NULL
    OR result_summary #> '{snapshot,cookies}' IS NOT NULL
    OR result_summary #> '{snapshot,cookie}' IS NOT NULL
    OR result_summary #> '{snapshot,localStorage}' IS NOT NULL
    OR result_summary #> '{snapshot,sessionStorage}' IS NOT NULL
    OR result_summary #> '{snapshot,indexedDB}' IS NOT NULL
    OR result_summary #> '{snapshot,storage}' IS NOT NULL
    OR result_summary #> '{snapshot,token}' IS NOT NULL
    OR result_summary #> '{snapshot,tokens}' IS NOT NULL
  );

UPDATE ky_ai_executor_task_event
SET payload_json = '{}'::jsonb
WHERE task_id IN (
  SELECT id FROM ky_ai_executor_task WHERE task_type = 'script_repair'
)
AND event_type IN ('codex.output', 'codex.context_prepared')
AND payload_json <> '{}'::jsonb;

UPDATE ky_ai_executor_task_raw_log
SET raw_text = '[REDACTED_LEGACY_REPAIR_LOG]',
    raw_json = '{}'::jsonb,
    terminal_line = '[REDACTED_LEGACY_REPAIR_LOG]'
WHERE task_id IN (
  SELECT id FROM ky_ai_executor_task WHERE task_type = 'script_repair'
)
AND (
  raw_text <> '[REDACTED_LEGACY_REPAIR_LOG]'
  OR raw_json <> '{}'::jsonb
  OR terminal_line <> '[REDACTED_LEGACY_REPAIR_LOG]'
);
