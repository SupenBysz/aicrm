-- P4 对象存储设置: S3-compatible object storage config (singleton). SK encrypted.

CREATE TABLE IF NOT EXISTS ky_storage_setting (
  id text PRIMARY KEY DEFAULT 'default',
  provider_key text NOT NULL DEFAULT 's3',
  endpoint text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  bucket text NOT NULL DEFAULT '',
  bucket_private boolean NOT NULL DEFAULT true,
  force_path_style boolean NOT NULL DEFAULT false,
  prefix text NOT NULL DEFAULT '',
  public_domain text NOT NULL DEFAULT '',
  access_key_id text NOT NULL DEFAULT '',
  secret_access_key_encrypted text NOT NULL DEFAULT '',
  last_test_at timestamptz,
  last_test_status text NOT NULL DEFAULT '',
  last_test_message text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ky_storage_setting (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_storage_view', 'platform.storage.view', '对象存储查看', 'page', 'storage', 'view', '["platform"]'::jsonb, 'System settings - storage', 'normal'),
  ('perm_platform_storage_update', 'platform.storage.update', '编辑对象存储', 'action', 'storage', 'update', '["platform"]'::jsonb, 'System settings - storage', 'normal'),
  ('perm_platform_storage_test', 'platform.storage.test', '测试对象存储', 'action', 'storage', 'test', '["platform"]'::jsonb, 'System settings - storage', 'normal'),
  ('perm_menu_platform_storage', 'menu.platform.storage', '对象存储菜单', 'menu', 'storage', 'view', '["platform"]'::jsonb, 'System settings - storage menu', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.storage.%' OR p.code = 'menu.platform.storage'
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.storage.%' OR p.code = 'menu.platform.storage'
ON CONFLICT (id) DO NOTHING;
