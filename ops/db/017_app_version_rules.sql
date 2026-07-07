-- P3 App 版本设置: per platform/channel version rules + public version check.

CREATE TABLE IF NOT EXISTS ky_app_version_rule (
  id text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  channel text NOT NULL DEFAULT 'default',
  latest_version_code integer NOT NULL DEFAULT 0,
  latest_version_name text NOT NULL DEFAULT '',
  min_supported_version_code integer NOT NULL DEFAULT 0,
  force_update boolean NOT NULL DEFAULT false,
  update_title text NOT NULL DEFAULT '',
  update_notes text NOT NULL DEFAULT '',
  update_url text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  internal_remark text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_app_version_rule_platform_channel_uidx ON ky_app_version_rule(platform, channel);

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_app_version_view', 'platform.app_version.view', 'App 版本查看', 'page', 'app_version', 'view', '["platform"]'::jsonb, 'System settings - app version', 'normal'),
  ('perm_platform_app_version_create', 'platform.app_version.create', '新增版本规则', 'action', 'app_version', 'create', '["platform"]'::jsonb, 'System settings - app version', 'normal'),
  ('perm_platform_app_version_update', 'platform.app_version.update', '编辑版本规则', 'action', 'app_version', 'update', '["platform"]'::jsonb, 'System settings - app version', 'normal'),
  ('perm_platform_app_version_delete', 'platform.app_version.delete', '删除版本规则', 'action', 'app_version', 'delete', '["platform"]'::jsonb, 'System settings - app version', 'normal'),
  ('perm_menu_platform_app_version', 'menu.platform.app_version', 'App 版本菜单', 'menu', 'app_version', 'view', '["platform"]'::jsonb, 'System settings - app version menu', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.app_version.%' OR p.code = 'menu.platform.app_version'
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.app_version.%' OR p.code = 'menu.platform.app_version'
ON CONFLICT (id) DO NOTHING;
