-- Matrix account v4: AI-assisted login scripts.
-- Scripts drive QR login preparation and account detection. They store DSL,
-- versions, run history and token usage, but never third-party credentials.

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  purpose text NOT NULL CHECK (purpose IN ('qr_login_prepare', 'account_detect', 'session_check')),
  url_pattern text NOT NULL DEFAULT '',
  page_fingerprint text NOT NULL DEFAULT '',
  active_version_id text,
  model_id text REFERENCES ky_ai_model(id),
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled', 'learning', 'failed')),
  failure_threshold integer NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 10),
  success_count bigint NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0,
  consecutive_failure_count bigint NOT NULL DEFAULT 0,
  generation_count bigint NOT NULL DEFAULT 0,
  total_prompt_tokens bigint NOT NULL DEFAULT 0,
  total_completion_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failed_at timestamptz,
  last_failure_reason text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_login_script_identity_uidx
  ON ky_matrix_account_login_script(workspace_type, workspace_id, platform, purpose, page_fingerprint)
  WHERE deleted_at IS NULL AND page_fingerprint <> '';

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_lookup_idx
  ON ky_matrix_account_login_script(workspace_type, workspace_id, platform, purpose, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_version (
  id text PRIMARY KEY,
  script_id text NOT NULL REFERENCES ky_matrix_account_login_script(id),
  version integer NOT NULL,
  model_id text REFERENCES ky_ai_model(id),
  dsl_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'ai_generated' CHECK (source IN ('ai_generated', 'manual', 'imported')),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'archived', 'failed')),
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  usage_source text NOT NULL DEFAULT 'unknown' CHECK (usage_source IN ('provider', 'estimated', 'unknown')),
  generation_reason text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(script_id, version)
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_version_script_idx
  ON ky_matrix_account_login_script_version(script_id, status, version DESC);

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_run (
  id text PRIMARY KEY,
  script_id text REFERENCES ky_matrix_account_login_script(id),
  script_version_id text REFERENCES ky_matrix_account_login_script_version(id),
  web_space_id text REFERENCES ky_matrix_account_web_space(id),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  purpose text NOT NULL CHECK (purpose IN ('qr_login_prepare', 'account_detect', 'session_check')),
  status text NOT NULL CHECK (status IN ('success', 'failed', 'timeout', 'cancelled')),
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  duration_ms bigint NOT NULL DEFAULT 0,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_run_script_idx
  ON ky_matrix_account_login_script_run(script_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_run_web_space_idx
  ON ky_matrix_account_login_script_run(web_space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_policy (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  purpose text NOT NULL CHECK (purpose IN ('qr_login_prepare', 'account_detect', 'session_check')),
  model_id text REFERENCES ky_ai_model(id),
  failure_threshold integer NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_type, workspace_id, platform, purpose)
);

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_matrix_account_login_scripts_view', 'platform.matrix_account_login_scripts.view', '平台矩阵账号登录脚本查看', 'page', 'matrix_account_login_scripts', 'view', '["platform"]'::jsonb, 'Matrix account login script view', 'normal'),
  ('perm_platform_matrix_account_login_scripts_update', 'platform.matrix_account_login_scripts.update', '平台矩阵账号登录脚本维护', 'action', 'matrix_account_login_scripts', 'update', '["platform"]'::jsonb, 'Matrix account login script update', 'normal'),
  ('perm_platform_matrix_account_login_scripts_regenerate', 'platform.matrix_account_login_scripts.regenerate', '平台矩阵账号登录脚本重新生成', 'action', 'matrix_account_login_scripts', 'regenerate', '["platform"]'::jsonb, 'Matrix account login script regenerate', 'normal'),
  ('perm_platform_matrix_account_login_scripts_activate_version', 'platform.matrix_account_login_scripts.activate_version', '平台矩阵账号登录脚本激活版本', 'action', 'matrix_account_login_scripts', 'activate_version', '["platform"]'::jsonb, 'Matrix account login script activate version', 'normal'),
  ('perm_platform_matrix_account_login_script_policies_view', 'platform.matrix_account_login_script_policies.view', '平台矩阵账号登录脚本策略查看', 'page', 'matrix_account_login_script_policies', 'view', '["platform"]'::jsonb, 'Matrix account login script policy view', 'normal'),
  ('perm_platform_matrix_account_login_script_policies_update', 'platform.matrix_account_login_script_policies.update', '平台矩阵账号登录脚本策略维护', 'action', 'matrix_account_login_script_policies', 'update', '["platform"]'::jsonb, 'Matrix account login script policy update', 'normal'),

  ('perm_agency_matrix_account_login_scripts_view', 'agency.matrix_account_login_scripts.view', '机构矩阵账号登录脚本查看', 'page', 'matrix_account_login_scripts', 'view', '["agency"]'::jsonb, 'Matrix account login script view', 'normal'),
  ('perm_agency_matrix_account_login_scripts_update', 'agency.matrix_account_login_scripts.update', '机构矩阵账号登录脚本维护', 'action', 'matrix_account_login_scripts', 'update', '["agency"]'::jsonb, 'Matrix account login script update', 'normal'),
  ('perm_agency_matrix_account_login_scripts_regenerate', 'agency.matrix_account_login_scripts.regenerate', '机构矩阵账号登录脚本重新生成', 'action', 'matrix_account_login_scripts', 'regenerate', '["agency"]'::jsonb, 'Matrix account login script regenerate', 'normal'),
  ('perm_agency_matrix_account_login_scripts_activate_version', 'agency.matrix_account_login_scripts.activate_version', '机构矩阵账号登录脚本激活版本', 'action', 'matrix_account_login_scripts', 'activate_version', '["agency"]'::jsonb, 'Matrix account login script activate version', 'normal'),
  ('perm_agency_matrix_account_login_script_policies_view', 'agency.matrix_account_login_script_policies.view', '机构矩阵账号登录脚本策略查看', 'page', 'matrix_account_login_script_policies', 'view', '["agency"]'::jsonb, 'Matrix account login script policy view', 'normal'),
  ('perm_agency_matrix_account_login_script_policies_update', 'agency.matrix_account_login_script_policies.update', '机构矩阵账号登录脚本策略维护', 'action', 'matrix_account_login_script_policies', 'update', '["agency"]'::jsonb, 'Matrix account login script policy update', 'normal'),

  ('perm_enterprise_matrix_account_login_scripts_view', 'enterprise.matrix_account_login_scripts.view', '企业矩阵账号登录脚本查看', 'page', 'matrix_account_login_scripts', 'view', '["enterprise"]'::jsonb, 'Matrix account login script view', 'normal'),
  ('perm_enterprise_matrix_account_login_scripts_update', 'enterprise.matrix_account_login_scripts.update', '企业矩阵账号登录脚本维护', 'action', 'matrix_account_login_scripts', 'update', '["enterprise"]'::jsonb, 'Matrix account login script update', 'normal'),
  ('perm_enterprise_matrix_account_login_scripts_regenerate', 'enterprise.matrix_account_login_scripts.regenerate', '企业矩阵账号登录脚本重新生成', 'action', 'matrix_account_login_scripts', 'regenerate', '["enterprise"]'::jsonb, 'Matrix account login script regenerate', 'normal'),
  ('perm_enterprise_matrix_account_login_scripts_activate_version', 'enterprise.matrix_account_login_scripts.activate_version', '企业矩阵账号登录脚本激活版本', 'action', 'matrix_account_login_scripts', 'activate_version', '["enterprise"]'::jsonb, 'Matrix account login script activate version', 'normal'),
  ('perm_enterprise_matrix_account_login_script_policies_view', 'enterprise.matrix_account_login_script_policies.view', '企业矩阵账号登录脚本策略查看', 'page', 'matrix_account_login_script_policies', 'view', '["enterprise"]'::jsonb, 'Matrix account login script policy view', 'normal'),
  ('perm_enterprise_matrix_account_login_script_policies_update', 'enterprise.matrix_account_login_script_policies.update', '企业矩阵账号登录脚本策略维护', 'action', 'matrix_account_login_script_policies', 'update', '["enterprise"]'::jsonb, 'Matrix account login script policy update', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.matrix_account_login_script%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.matrix_account_login_script%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_agency_owner_template'), ('role_agency_admin_template')) AS rt(role_id)
WHERE p.code LIKE 'agency.matrix_account_login_script%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_enterprise_owner_template'), ('role_enterprise_admin_template')) AS rt(role_id)
WHERE p.code LIKE 'enterprise.matrix_account_login_script%'
ON CONFLICT (role_id, permission_id) DO NOTHING;
