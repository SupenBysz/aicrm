-- Matrix account v7: drawer tabs, script management, web-space debug and sensitive debug permissions.

ALTER TABLE ky_matrix_account_login_script
  DROP CONSTRAINT IF EXISTS ky_matrix_account_login_script_purpose_check;

ALTER TABLE ky_matrix_account_login_script
  ADD CONSTRAINT ky_matrix_account_login_script_purpose_check
  CHECK (purpose IN ('qr_login_prepare', 'qr_login_refresh', 'account_detect', 'session_check'));

ALTER TABLE ky_matrix_account_login_script_run
  DROP CONSTRAINT IF EXISTS ky_matrix_account_login_script_run_purpose_check;

ALTER TABLE ky_matrix_account_login_script_run
  ADD CONSTRAINT ky_matrix_account_login_script_run_purpose_check
  CHECK (purpose IN ('qr_login_prepare', 'qr_login_refresh', 'account_detect', 'session_check'));

ALTER TABLE ky_matrix_account_login_script_policy
  DROP CONSTRAINT IF EXISTS ky_matrix_account_login_script_policy_purpose_check;

ALTER TABLE ky_matrix_account_login_script_policy
  ADD CONSTRAINT ky_matrix_account_login_script_policy_purpose_check
  CHECK (purpose IN ('qr_login_prepare', 'qr_login_refresh', 'account_detect', 'session_check'));

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_matrix_account_scripts_view', 'platform.matrix_account_scripts.view', '平台矩阵账号脚本查看', 'page', 'matrix_account_scripts', 'view', '["platform"]'::jsonb, 'Matrix account script view', 'normal'),
  ('perm_platform_matrix_account_scripts_manage', 'platform.matrix_account_scripts.manage', '平台矩阵账号脚本管理', 'action', 'matrix_account_scripts', 'manage', '["platform"]'::jsonb, 'Matrix account script manage', 'normal'),
  ('perm_platform_matrix_account_web_spaces_debug', 'platform.matrix_account_web_spaces.debug', '平台矩阵账号登录空间调试', 'action', 'matrix_account_web_spaces', 'debug', '["platform"]'::jsonb, 'Matrix account web space debug', 'normal'),
  ('perm_platform_matrix_account_sensitive_debug_view', 'platform.matrix_account_sensitive_debug.view', '平台矩阵账号敏感调试查看', 'action', 'matrix_account_sensitive_debug', 'view', '["platform"]'::jsonb, 'Matrix account sensitive debug view', 'normal'),
  ('perm_platform_matrix_account_sensitive_debug_export', 'platform.matrix_account_sensitive_debug.export', '平台矩阵账号敏感调试导出', 'action', 'matrix_account_sensitive_debug', 'export', '["platform"]'::jsonb, 'Matrix account sensitive debug export', 'normal'),

  ('perm_agency_matrix_account_scripts_view', 'agency.matrix_account_scripts.view', '机构矩阵账号脚本查看', 'page', 'matrix_account_scripts', 'view', '["agency"]'::jsonb, 'Matrix account script view', 'normal'),
  ('perm_agency_matrix_account_scripts_manage', 'agency.matrix_account_scripts.manage', '机构矩阵账号脚本管理', 'action', 'matrix_account_scripts', 'manage', '["agency"]'::jsonb, 'Matrix account script manage', 'normal'),
  ('perm_agency_matrix_account_web_spaces_debug', 'agency.matrix_account_web_spaces.debug', '机构矩阵账号登录空间调试', 'action', 'matrix_account_web_spaces', 'debug', '["agency"]'::jsonb, 'Matrix account web space debug', 'normal'),
  ('perm_agency_matrix_account_sensitive_debug_view', 'agency.matrix_account_sensitive_debug.view', '机构矩阵账号敏感调试查看', 'action', 'matrix_account_sensitive_debug', 'view', '["agency"]'::jsonb, 'Matrix account sensitive debug view', 'normal'),
  ('perm_agency_matrix_account_sensitive_debug_export', 'agency.matrix_account_sensitive_debug.export', '机构矩阵账号敏感调试导出', 'action', 'matrix_account_sensitive_debug', 'export', '["agency"]'::jsonb, 'Matrix account sensitive debug export', 'normal'),

  ('perm_enterprise_matrix_account_scripts_view', 'enterprise.matrix_account_scripts.view', '企业矩阵账号脚本查看', 'page', 'matrix_account_scripts', 'view', '["enterprise"]'::jsonb, 'Matrix account script view', 'normal'),
  ('perm_enterprise_matrix_account_scripts_manage', 'enterprise.matrix_account_scripts.manage', '企业矩阵账号脚本管理', 'action', 'matrix_account_scripts', 'manage', '["enterprise"]'::jsonb, 'Matrix account script manage', 'normal'),
  ('perm_enterprise_matrix_account_web_spaces_debug', 'enterprise.matrix_account_web_spaces.debug', '企业矩阵账号登录空间调试', 'action', 'matrix_account_web_spaces', 'debug', '["enterprise"]'::jsonb, 'Matrix account web space debug', 'normal'),
  ('perm_enterprise_matrix_account_sensitive_debug_view', 'enterprise.matrix_account_sensitive_debug.view', '企业矩阵账号敏感调试查看', 'action', 'matrix_account_sensitive_debug', 'view', '["enterprise"]'::jsonb, 'Matrix account sensitive debug view', 'normal'),
  ('perm_enterprise_matrix_account_sensitive_debug_export', 'enterprise.matrix_account_sensitive_debug.export', '企业矩阵账号敏感调试导出', 'action', 'matrix_account_sensitive_debug', 'export', '["enterprise"]'::jsonb, 'Matrix account sensitive debug export', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.matrix_account_scripts.%'
   OR p.code LIKE 'platform.matrix_account_web_spaces.%'
   OR p.code LIKE 'platform.matrix_account_sensitive_debug.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p
WHERE p.code LIKE 'platform.matrix_account_scripts.%'
   OR p.code LIKE 'platform.matrix_account_web_spaces.%'
   OR p.code LIKE 'platform.matrix_account_sensitive_debug.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_agency_owner_template'), ('role_agency_admin_template')) AS rt(role_id)
WHERE p.code LIKE 'agency.matrix_account_scripts.%'
   OR p.code LIKE 'agency.matrix_account_web_spaces.%'
   OR p.code LIKE 'agency.matrix_account_sensitive_debug.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || rt.role_id || '_' || replace(p.code, '.', '_'), rt.role_id, p.id
FROM ky_permission p
CROSS JOIN (VALUES ('role_enterprise_owner_template'), ('role_enterprise_admin_template')) AS rt(role_id)
WHERE p.code LIKE 'enterprise.matrix_account_scripts.%'
   OR p.code LIKE 'enterprise.matrix_account_web_spaces.%'
   OR p.code LIKE 'enterprise.matrix_account_sensitive_debug.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;
