-- AI executor: Codex repair executor configuration, task logs, and dual-mode event streams.

CREATE TABLE IF NOT EXISTS ky_ai_executor_config (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT 'Codex 执行器',
  scope_type text NOT NULL DEFAULT 'platform' CHECK (scope_type IN ('platform')),
  scope_id text NOT NULL DEFAULT 'platform_root',
  executor_type text NOT NULL CHECK (executor_type IN ('codex')),
  runtime_type text NOT NULL DEFAULT 'server' CHECK (runtime_type IN ('desktop', 'server', 'remote')),
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  is_default boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100,
  auto_repair_enabled boolean NOT NULL DEFAULT true,
  trigger_failure_count integer NOT NULL DEFAULT 1 CHECK (trigger_failure_count >= 1 AND trigger_failure_count <= 10),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts >= 1 AND max_attempts <= 10),
  task_timeout_seconds integer NOT NULL DEFAULT 180 CHECK (task_timeout_seconds >= 30 AND task_timeout_seconds <= 3600),
  max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1 AND max_concurrency <= 20),
  allow_page_actions boolean NOT NULL DEFAULT true,
  allow_storage_read boolean NOT NULL DEFAULT true,
  allow_cdp_runtime boolean NOT NULL DEFAULT true,
  allow_script_save boolean NOT NULL DEFAULT true,
  allow_auto_activate boolean NOT NULL DEFAULT false,
  app_server_listen text NOT NULL DEFAULT 'stdio://',
  auth_status text NOT NULL DEFAULT 'not_authorized' CHECK (auth_status IN ('not_authorized', 'authorizing', 'authorized', 'expired', 'error')),
  auth_method text NOT NULL DEFAULT '',
  auth_account_label text NOT NULL DEFAULT '',
  bound_device_id text NOT NULL DEFAULT '',
  codex_version text NOT NULL DEFAULT '',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at timestamptz,
  last_auth_checked_at timestamptz,
  remark text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ky_ai_executor_config
  ALTER COLUMN status SET DEFAULT 'enabled';

ALTER TABLE ky_ai_executor_config
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Codex 执行器',
  ADD COLUMN IF NOT EXISTS runtime_type text NOT NULL DEFAULT 'server',
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS auth_status text NOT NULL DEFAULT 'not_authorized',
  ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS auth_account_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bound_device_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS codex_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_auth_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by text REFERENCES ky_user(id);

ALTER TABLE ky_ai_executor_config
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_scope_type_scope_id_executor_type_key;

UPDATE ky_ai_executor_config
SET name = CASE WHEN name = '' THEN '平台默认 Codex' ELSE name END,
    runtime_type = CASE WHEN runtime_type = '' THEN 'server' ELSE runtime_type END,
    is_default = true,
    priority = CASE WHEN priority <= 0 THEN 100 ELSE priority END
WHERE id='aiexec_platform_codex';

INSERT INTO ky_ai_executor_config (id, name, scope_type, scope_id, executor_type, runtime_type, status, is_default, updated_by)
VALUES ('aiexec_platform_codex', '平台默认 Codex', 'platform', 'platform_root', 'codex', 'server', 'enabled', true, 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

UPDATE ky_ai_executor_config
SET status='enabled', updated_at=now()
WHERE id='aiexec_platform_codex'
  AND status='disabled'
  AND COALESCE(updated_by, 'user_platform_owner')='user_platform_owner';

CREATE INDEX IF NOT EXISTS ky_ai_executor_config_lookup_idx
  ON ky_ai_executor_config(scope_type, scope_id, executor_type, runtime_type, status, priority, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_config_default_uidx
  ON ky_ai_executor_config(scope_type, scope_id, executor_type)
  WHERE is_default;

CREATE TABLE IF NOT EXISTS ky_ai_executor_task (
  id text PRIMARY KEY,
  workspace_type text NOT NULL,
  workspace_id text NOT NULL,
  executor_id text NOT NULL DEFAULT '',
  executor_type text NOT NULL CHECK (executor_type IN ('codex')),
  task_type text NOT NULL DEFAULT 'script_repair' CHECK (task_type IN ('script_repair')),
  purpose text NOT NULL DEFAULT '' CHECK (purpose IN ('', 'qr_login_prepare', 'qr_login_refresh', 'account_detect', 'session_check')),
  trigger_reason text NOT NULL DEFAULT '',
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  web_space_id text NOT NULL DEFAULT '',
  script_id text NOT NULL DEFAULT '',
  script_version_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'waiting_executor', 'running', 'waiting_user_scan', 'completed', 'failed', 'cancelled', 'timeout')),
  codex_thread_id text NOT NULL DEFAULT '',
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ky_ai_executor_task
  ADD COLUMN IF NOT EXISTS executor_id text NOT NULL DEFAULT '';

ALTER TABLE ky_ai_executor_task
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_status_check;

ALTER TABLE ky_ai_executor_task
  ADD CONSTRAINT ky_ai_executor_task_status_check
  CHECK (status IN ('pending', 'waiting_executor', 'running', 'waiting_user_scan', 'completed', 'failed', 'cancelled', 'timeout'));

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_workspace_idx
  ON ky_ai_executor_task(workspace_type, workspace_id, executor_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_executor_idx
  ON ky_ai_executor_task(executor_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_target_idx
  ON ky_ai_executor_task(target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_web_space_idx
  ON ky_ai_executor_task(web_space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ky_ai_executor_task_event (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES ky_ai_executor_task(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'success', 'warning', 'error')),
  message text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, sequence)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_event_task_idx
  ON ky_ai_executor_task_event(task_id, sequence);

CREATE TABLE IF NOT EXISTS ky_ai_executor_task_raw_log (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES ky_ai_executor_task(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  source text NOT NULL DEFAULT 'executor' CHECK (source IN ('codex', 'executor', 'mcp', 'electron', 'system')),
  direction text NOT NULL DEFAULT 'internal' CHECK (direction IN ('in', 'out', 'internal')),
  raw_text text NOT NULL DEFAULT '',
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  terminal_line text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, sequence)
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_task_raw_log_task_idx
  ON ky_ai_executor_task_raw_log(task_id, sequence);

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_ai_executors_view', 'platform.ai_executors.view', 'AI 执行器配置查看', 'page', 'ai_executors', 'view', '["platform"]'::jsonb, 'AI executor configuration view', 'normal'),
  ('perm_platform_ai_executors_create', 'platform.ai_executors.create', 'AI 执行器创建', 'action', 'ai_executors', 'create', '["platform"]'::jsonb, 'AI executor create', 'normal'),
  ('perm_platform_ai_executors_update', 'platform.ai_executors.update', 'AI 执行器配置维护', 'action', 'ai_executors', 'update', '["platform"]'::jsonb, 'AI executor configuration update', 'normal'),
  ('perm_platform_ai_executors_authorize', 'platform.ai_executors.authorize', 'AI 执行器授权', 'action', 'ai_executors', 'authorize', '["platform"]'::jsonb, 'AI executor authorize', 'normal'),
  ('perm_platform_ai_executor_tasks_view', 'platform.ai_executor_tasks.view', 'AI 执行器任务查看', 'page', 'ai_executor_tasks', 'view', '["platform"]'::jsonb, 'AI executor task view', 'normal'),
  ('perm_platform_ai_executor_tasks_create', 'platform.ai_executor_tasks.create', 'AI 执行器任务创建', 'action', 'ai_executor_tasks', 'create', '["platform"]'::jsonb, 'AI executor task create', 'normal'),
  ('perm_platform_ai_executor_tasks_cancel', 'platform.ai_executor_tasks.cancel', 'AI 执行器任务取消', 'action', 'ai_executor_tasks', 'cancel', '["platform"]'::jsonb, 'AI executor task cancel', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.ai_executor%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.ai_executor%'
ON CONFLICT (role_id, permission_id) DO NOTHING;
