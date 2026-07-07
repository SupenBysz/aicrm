-- P6 邮件服务: SMTP accounts + sender identities + scene templates. Password encrypted.

CREATE TABLE IF NOT EXISTS ky_email_account (
  id text PRIMARY KEY,
  account_name text NOT NULL,
  provider_key text NOT NULL DEFAULT 'smtp',
  host text NOT NULL DEFAULT '',
  port integer NOT NULL DEFAULT 465,
  encryption text NOT NULL DEFAULT 'ssl' CHECK (encryption IN ('none', 'ssl', 'tls')),
  username text NOT NULL DEFAULT '',
  password_encrypted text NOT NULL DEFAULT '',
  from_email text NOT NULL DEFAULT '',
  from_name text NOT NULL DEFAULT '',
  reply_to_email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  last_test_at timestamptz,
  last_test_status text NOT NULL DEFAULT '',
  last_test_message text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ky_email_identity (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ky_email_account(id) ON DELETE CASCADE,
  identity_name text NOT NULL,
  from_email text NOT NULL DEFAULT '',
  from_name text NOT NULL DEFAULT '',
  reply_to_email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ky_email_template (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES ky_email_account(id) ON DELETE CASCADE,
  identity_id text REFERENCES ky_email_identity(id) ON DELETE SET NULL,
  scene text NOT NULL,
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
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
  ('perm_platform_email_view', 'platform.email.view', '邮件服务查看', 'page', 'email', 'view', '["platform"]'::jsonb, 'System settings - email', 'normal'),
  ('perm_platform_email_update', 'platform.email.update', '配置邮件服务', 'action', 'email', 'update', '["platform"]'::jsonb, 'System settings - email', 'normal'),
  ('perm_platform_email_test', 'platform.email.test', '测试邮件发送', 'action', 'email', 'test', '["platform"]'::jsonb, 'System settings - email', 'normal'),
  ('perm_menu_platform_email', 'menu.platform.email', '邮件服务菜单', 'menu', 'email', 'view', '["platform"]'::jsonb, 'System settings - email menu', 'normal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(p.code, '.', '_'), 'role_platform_owner', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.email.%' OR p.code = 'menu.platform.email'
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(p.code, '.', '_'), 'role_platform_admin', p.id
FROM ky_permission p WHERE p.code LIKE 'platform.email.%' OR p.code = 'menu.platform.email'
ON CONFLICT (id) DO NOTHING;
