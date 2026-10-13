-- 抖店页面脚本资产：仅维护版本配置，不参与登录脚本 DSL、注入或执行。
CREATE TABLE IF NOT EXISTS ky_matrix_account_douyin_script (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type = 'platform'),
  workspace_id text NOT NULL,
  name text NOT NULL,
  platform text NOT NULL DEFAULT 'douyin' CHECK (platform = 'douyin'),
  match_type text NOT NULL CHECK (match_type IN ('exact','wildcard')),
  match_url text NOT NULL,
  latest_version_id text,
  effective_version_id text,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_command_key text NOT NULL DEFAULT '',
  last_command_hash text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_douyin_script_name_uidx
  ON ky_matrix_account_douyin_script(workspace_type, workspace_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_matrix_account_douyin_script_list_idx
  ON ky_matrix_account_douyin_script(workspace_type, workspace_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_matrix_account_douyin_script_version (
  id text PRIMARY KEY,
  script_id text NOT NULL REFERENCES ky_matrix_account_douyin_script(id),
  version text NOT NULL,
  js_content text NOT NULL DEFAULT '',
  css_content text NOT NULL DEFAULT '',
  js_bytes integer NOT NULL DEFAULT 0 CHECK (js_bytes >= 0),
  css_bytes integer NOT NULL DEFAULT 0 CHECK (css_bytes >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','released','active','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_command_key text NOT NULL DEFAULT '',
  last_command_hash text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(script_id, version)
);
CREATE INDEX IF NOT EXISTS ky_matrix_account_douyin_script_version_list_idx
  ON ky_matrix_account_douyin_script_version(script_id, version DESC, status);

INSERT INTO ky_permission(id, code, name, category, resource, action, workspace_types, description, status) VALUES
 ('perm_platform_matrix_account_douyin_scripts_view','platform.matrix_account_douyin_scripts.view','抖店脚本查看','page','matrix_account_douyin_scripts','view','["platform"]'::jsonb,'抖店页面脚本配置查看','normal'),
 ('perm_platform_matrix_account_douyin_scripts_content_view','platform.matrix_account_douyin_scripts.content_view','抖店脚本源码查看','action','matrix_account_douyin_scripts','content_view','["platform"]'::jsonb,'抖店页面脚本源码查看','normal'),
 ('perm_platform_matrix_account_douyin_scripts_create','platform.matrix_account_douyin_scripts.create','抖店脚本创建','action','matrix_account_douyin_scripts','create','["platform"]'::jsonb,'抖店页面脚本创建','normal'),
 ('perm_platform_matrix_account_douyin_scripts_update','platform.matrix_account_douyin_scripts.update','抖店脚本编辑','action','matrix_account_douyin_scripts','update','["platform"]'::jsonb,'抖店页面脚本编辑','normal'),
 ('perm_platform_matrix_account_douyin_scripts_release','platform.matrix_account_douyin_scripts.release','抖店脚本发布','action','matrix_account_douyin_scripts','release','["platform"]'::jsonb,'抖店页面脚本发布','normal'),
 ('perm_platform_matrix_account_douyin_scripts_activate','platform.matrix_account_douyin_scripts.activate','抖店脚本生效','action','matrix_account_douyin_scripts','activate','["platform"]'::jsonb,'抖店页面脚本生效','normal'),
 ('perm_platform_matrix_account_douyin_scripts_archive','platform.matrix_account_douyin_scripts.archive','抖店脚本归档','action','matrix_account_douyin_scripts','archive','["platform"]'::jsonb,'抖店页面脚本归档','normal'),
 ('perm_platform_matrix_account_douyin_scripts_menu','menu.platform.matrix_account_douyin_scripts','脚本管理','menu','matrix_account_douyin_scripts','menu','["platform"]'::jsonb,'脚本管理菜单','normal')
ON CONFLICT(code) DO NOTHING;

INSERT INTO ky_role_permission(id, role_id, permission_id)
SELECT 'rp_' || r.id || '_' || replace(p.code,'.','_'), r.id, p.id
FROM ky_role r CROSS JOIN ky_permission p
WHERE r.id IN ('role_platform_owner','role_platform_admin')
  AND r.workspace_type='platform' AND r.workspace_id='platform_root' AND r.status='normal' AND r.deleted_at IS NULL
  AND p.code IN (
   'platform.matrix_account_douyin_scripts.view','platform.matrix_account_douyin_scripts.content_view',
   'platform.matrix_account_douyin_scripts.create','platform.matrix_account_douyin_scripts.update',
   'platform.matrix_account_douyin_scripts.release','platform.matrix_account_douyin_scripts.activate',
   'platform.matrix_account_douyin_scripts.archive','menu.platform.matrix_account_douyin_scripts')
ON CONFLICT(role_id, permission_id) DO NOTHING;
