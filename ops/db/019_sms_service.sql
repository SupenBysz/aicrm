-- P5 短信服务: provider accounts + signatures + scene templates. Secret encrypted.

CREATE TABLE IF NOT EXISTS ky_sms_account (
  id text PRIMARY KEY,
  account_name text NOT NULL,
  provider_key text NOT NULL DEFAULT 'aliyun',
  region text NOT NULL DEFAULT '',
  access_key_id text NOT NULL DEFAULT '',
  access_key_secret_encrypted text NOT NULL DEFAULT '',
  default_signature_id text DEFAULT '',
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  last_test_at timestamptz,
  last_test_status text NOT NULL DEFAULT '',
  last_test_message text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ky_sms_signature (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ky_sms_account(id) ON DELETE CASCADE,
  signature_name text NOT NULL,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ky_sms_template (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ky_sms_account(id) ON DELETE CASCADE,
  scene text NOT NULL,
  template_code text NOT NULL DEFAULT '',
  code_variable text NOT NULL DEFAULT 'code',
  code_ttl_seconds integer NOT NULL DEFAULT 300,
  daily_limit integer NOT NULL DEFAULT 10,
  interval_seconds integer NOT NULL DEFAULT 60,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  last_test_at timestamptz,
  last_test_status text NOT NULL DEFAULT '',
  last_test_message text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_sms_view', 'platform.sms.view', '短信服务查看', 'page', 'sms', 'view', '["platform"]'::jsonb, 'System settings - sms', 'normal'),
  ('perm_platform_sms_update', 'platform.sms.update', '配置短信服务', 'action', 'sms', 'update', '["platform"]'::jsonb, 'System settings - sms', 'normal'),
  ('perm_platform_sms_test', 'platform.sms.test', '测试短信发送', 'action', 'sms', 'test', '["platform"]'::jsonb, 'System settings - sms', 'normal'),
  ('perm_menu_platform_sms', 'menu.platform.sms', '短信服务菜单', 'menu', 'sms', 'view', '["platform"]'::jsonb, 'System settings - sms menu', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.sms.%' OR p.code = 'menu.platform.sms'
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.sms.%' OR p.code = 'menu.platform.sms'
ON CONFLICT (id) DO NOTHING;
