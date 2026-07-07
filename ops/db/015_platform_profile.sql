-- P1 基础信息: platform identity (company name + ICP record). Singleton row.

CREATE TABLE IF NOT EXISTS ky_platform_profile (
  id text PRIMARY KEY DEFAULT 'default',
  company_name text NOT NULL DEFAULT '',
  icp_record text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ky_platform_profile (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- Permissions
INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_basic_info_view', 'platform.basic_info.view', '基础信息查看', 'page', 'basic_info', 'view', '["platform"]'::jsonb, 'System settings - basic info', 'normal'),
  ('perm_platform_basic_info_update', 'platform.basic_info.update', '编辑基础信息', 'action', 'basic_info', 'update', '["platform"]'::jsonb, 'System settings - basic info', 'normal'),
  ('perm_menu_platform_basic_info', 'menu.platform.basic_info', '基础信息菜单', 'menu', 'basic_info', 'view', '["platform"]'::jsonb, 'System settings - basic info menu', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code IN ('platform.basic_info.view', 'platform.basic_info.update', 'menu.platform.basic_info')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code IN ('platform.basic_info.view', 'platform.basic_info.update', 'menu.platform.basic_info')
ON CONFLICT (id) DO NOTHING;
