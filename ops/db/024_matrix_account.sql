-- Matrix account Web login-state management.
-- Phase 1 stores account metadata and local-client profile metadata only.

CREATE TABLE IF NOT EXISTS ky_matrix_account (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  display_name text NOT NULL,
  platform_uid text NOT NULL DEFAULT '',
  nickname text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  home_url text NOT NULL DEFAULT '',
  owner_member_id text REFERENCES ky_membership(id),
  department_id text,
  team_id text,
  login_status text NOT NULL DEFAULT 'not_logged_in'
    CHECK (login_status IN ('not_logged_in', 'login_pending', 'online', 'expired', 'verify_required', 'risk')),
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  remark text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_workspace_platform_uid_uidx
  ON ky_matrix_account(workspace_type, workspace_id, platform, platform_uid)
  WHERE deleted_at IS NULL AND platform_uid <> '';
CREATE INDEX IF NOT EXISTS ky_matrix_account_workspace_platform_idx
  ON ky_matrix_account(workspace_type, workspace_id, platform, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_matrix_account_owner_idx
  ON ky_matrix_account(owner_member_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_matrix_account_client_session (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ky_matrix_account(id),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  member_id text NOT NULL REFERENCES ky_membership(id),
  device_id text NOT NULL DEFAULT 'default',
  browser_partition text NOT NULL,
  login_status text NOT NULL DEFAULT 'unknown'
    CHECK (login_status IN ('not_logged_in', 'login_pending', 'online', 'expired', 'verify_required', 'risk', 'unknown')),
  last_login_at timestamptz,
  last_check_at timestamptz,
  expires_at timestamptz,
  fingerprint_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_client_session_uidx
  ON ky_matrix_account_client_session(account_id, member_id, device_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_matrix_account_client_session_workspace_idx
  ON ky_matrix_account_client_session(workspace_type, workspace_id, login_status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_task (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ky_matrix_account(id),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  member_id text NOT NULL REFERENCES ky_membership(id),
  device_id text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'opening', 'waiting_login', 'completed', 'failed', 'cancelled', 'expired')),
  platform_login_url text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expired_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_task_account_idx
  ON ky_matrix_account_login_task(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ky_matrix_account_login_task_workspace_idx
  ON ky_matrix_account_login_task(workspace_type, workspace_id, status);

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_menu_platform_matrix_accounts', 'menu.platform.matrix_accounts', '平台矩阵账号菜单', 'menu', 'matrix_accounts', 'view', '["platform"]'::jsonb, 'Matrix account workbench menu', 'normal'),
  ('perm_menu_agency_matrix_accounts', 'menu.agency.matrix_accounts', '机构矩阵账号菜单', 'menu', 'matrix_accounts', 'view', '["agency"]'::jsonb, 'Matrix account workbench menu', 'normal'),
  ('perm_menu_enterprise_matrix_accounts', 'menu.enterprise.matrix_accounts', '企业矩阵账号菜单', 'menu', 'matrix_accounts', 'view', '["enterprise"]'::jsonb, 'Matrix account workbench menu', 'normal'),

  ('perm_platform_matrix_accounts_view', 'platform.matrix_accounts.view', '平台矩阵账号查看', 'page', 'matrix_accounts', 'view', '["platform"]'::jsonb, 'Matrix account view', 'normal'),
  ('perm_platform_matrix_accounts_create', 'platform.matrix_accounts.create', '平台矩阵账号新增', 'action', 'matrix_accounts', 'create', '["platform"]'::jsonb, 'Matrix account create', 'normal'),
  ('perm_platform_matrix_accounts_update', 'platform.matrix_accounts.update', '平台矩阵账号编辑', 'action', 'matrix_accounts', 'update', '["platform"]'::jsonb, 'Matrix account update', 'normal'),
  ('perm_platform_matrix_accounts_update_status', 'platform.matrix_accounts.update_status', '平台矩阵账号启停', 'action', 'matrix_accounts', 'update_status', '["platform"]'::jsonb, 'Matrix account status', 'normal'),
  ('perm_platform_matrix_accounts_delete', 'platform.matrix_accounts.delete', '平台矩阵账号删除', 'action', 'matrix_accounts', 'delete', '["platform"]'::jsonb, 'Matrix account delete', 'normal'),
  ('perm_platform_matrix_accounts_login', 'platform.matrix_accounts.login', '平台矩阵账号登录', 'action', 'matrix_accounts', 'login', '["platform"]'::jsonb, 'Matrix account login', 'normal'),
  ('perm_platform_matrix_accounts_open', 'platform.matrix_accounts.open', '平台矩阵账号打开', 'action', 'matrix_accounts', 'open', '["platform"]'::jsonb, 'Matrix account open', 'normal'),
  ('perm_platform_matrix_accounts_check', 'platform.matrix_accounts.check', '平台矩阵账号检测', 'action', 'matrix_accounts', 'check', '["platform"]'::jsonb, 'Matrix account check', 'normal'),
  ('perm_platform_matrix_accounts_clear_session', 'platform.matrix_accounts.clear_session', '平台矩阵账号清理登录态', 'action', 'matrix_accounts', 'clear_session', '["platform"]'::jsonb, 'Matrix account clear local session', 'normal'),

  ('perm_agency_matrix_accounts_view', 'agency.matrix_accounts.view', '机构矩阵账号查看', 'page', 'matrix_accounts', 'view', '["agency"]'::jsonb, 'Matrix account view', 'normal'),
  ('perm_agency_matrix_accounts_create', 'agency.matrix_accounts.create', '机构矩阵账号新增', 'action', 'matrix_accounts', 'create', '["agency"]'::jsonb, 'Matrix account create', 'normal'),
  ('perm_agency_matrix_accounts_update', 'agency.matrix_accounts.update', '机构矩阵账号编辑', 'action', 'matrix_accounts', 'update', '["agency"]'::jsonb, 'Matrix account update', 'normal'),
  ('perm_agency_matrix_accounts_update_status', 'agency.matrix_accounts.update_status', '机构矩阵账号启停', 'action', 'matrix_accounts', 'update_status', '["agency"]'::jsonb, 'Matrix account status', 'normal'),
  ('perm_agency_matrix_accounts_delete', 'agency.matrix_accounts.delete', '机构矩阵账号删除', 'action', 'matrix_accounts', 'delete', '["agency"]'::jsonb, 'Matrix account delete', 'normal'),
  ('perm_agency_matrix_accounts_login', 'agency.matrix_accounts.login', '机构矩阵账号登录', 'action', 'matrix_accounts', 'login', '["agency"]'::jsonb, 'Matrix account login', 'normal'),
  ('perm_agency_matrix_accounts_open', 'agency.matrix_accounts.open', '机构矩阵账号打开', 'action', 'matrix_accounts', 'open', '["agency"]'::jsonb, 'Matrix account open', 'normal'),
  ('perm_agency_matrix_accounts_check', 'agency.matrix_accounts.check', '机构矩阵账号检测', 'action', 'matrix_accounts', 'check', '["agency"]'::jsonb, 'Matrix account check', 'normal'),
  ('perm_agency_matrix_accounts_clear_session', 'agency.matrix_accounts.clear_session', '机构矩阵账号清理登录态', 'action', 'matrix_accounts', 'clear_session', '["agency"]'::jsonb, 'Matrix account clear local session', 'normal'),

  ('perm_enterprise_matrix_accounts_view', 'enterprise.matrix_accounts.view', '企业矩阵账号查看', 'page', 'matrix_accounts', 'view', '["enterprise"]'::jsonb, 'Matrix account view', 'normal'),
  ('perm_enterprise_matrix_accounts_create', 'enterprise.matrix_accounts.create', '企业矩阵账号新增', 'action', 'matrix_accounts', 'create', '["enterprise"]'::jsonb, 'Matrix account create', 'normal'),
  ('perm_enterprise_matrix_accounts_update', 'enterprise.matrix_accounts.update', '企业矩阵账号编辑', 'action', 'matrix_accounts', 'update', '["enterprise"]'::jsonb, 'Matrix account update', 'normal'),
  ('perm_enterprise_matrix_accounts_update_status', 'enterprise.matrix_accounts.update_status', '企业矩阵账号启停', 'action', 'matrix_accounts', 'update_status', '["enterprise"]'::jsonb, 'Matrix account status', 'normal'),
  ('perm_enterprise_matrix_accounts_delete', 'enterprise.matrix_accounts.delete', '企业矩阵账号删除', 'action', 'matrix_accounts', 'delete', '["enterprise"]'::jsonb, 'Matrix account delete', 'normal'),
  ('perm_enterprise_matrix_accounts_login', 'enterprise.matrix_accounts.login', '企业矩阵账号登录', 'action', 'matrix_accounts', 'login', '["enterprise"]'::jsonb, 'Matrix account login', 'normal'),
  ('perm_enterprise_matrix_accounts_open', 'enterprise.matrix_accounts.open', '企业矩阵账号打开', 'action', 'matrix_accounts', 'open', '["enterprise"]'::jsonb, 'Matrix account open', 'normal'),
  ('perm_enterprise_matrix_accounts_check', 'enterprise.matrix_accounts.check', '企业矩阵账号检测', 'action', 'matrix_accounts', 'check', '["enterprise"]'::jsonb, 'Matrix account check', 'normal'),
  ('perm_enterprise_matrix_accounts_clear_session', 'enterprise.matrix_accounts.clear_session', '企业矩阵账号清理登录态', 'action', 'matrix_accounts', 'clear_session', '["enterprise"]'::jsonb, 'Matrix account clear local session', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.matrix_accounts.%' OR p.code = 'menu.platform.matrix_accounts'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.matrix_accounts.%' OR p.code = 'menu.platform.matrix_accounts'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_agency_owner_template'), ('role_agency_admin_template')) AS rt(role_id)
WHERE p.code LIKE 'agency.matrix_accounts.%' OR p.code = 'menu.agency.matrix_accounts'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_enterprise_owner_template'), ('role_enterprise_admin_template')) AS rt(role_id)
WHERE p.code LIKE 'enterprise.matrix_accounts.%' OR p.code = 'menu.enterprise.matrix_accounts'
ON CONFLICT (role_id, permission_id) DO NOTHING;

