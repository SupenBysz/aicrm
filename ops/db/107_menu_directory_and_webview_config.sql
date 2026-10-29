-- Generic management/workbench menu directories and non-secret WebView configuration.
-- Existing plugin routes remain valid while directory entries are introduced.
BEGIN;

ALTER TABLE ky_role ADD COLUMN IF NOT EXISTS permission_revision bigint NOT NULL DEFAULT 1 CHECK (permission_revision > 0);

CREATE TABLE IF NOT EXISTS ky_menu_directory (
  directory_type text NOT NULL CHECK (directory_type IN ('management','workbench')),
  menu_key text NOT NULL CHECK (menu_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  node_type text NOT NULL CHECK (node_type IN ('group','leaf')),
  parent_key text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  icon text NOT NULL DEFAULT '',
  permission_code text NOT NULL,
  workspace_types jsonb NOT NULL DEFAULT '["platform","agency","enterprise"]'::jsonb,
  route_key text,
  route_path text,
  page_type text NOT NULL DEFAULT 'internal' CHECK (page_type IN ('internal','webview')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (directory_type, menu_key),
  FOREIGN KEY (directory_type, parent_key) REFERENCES ky_menu_directory(directory_type, menu_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((node_type = 'group' AND route_key IS NULL AND route_path IS NULL AND page_type = 'internal') OR node_type = 'leaf'),
  CHECK (page_type <> 'webview' OR (node_type = 'leaf' AND route_path IS NULL))
);
CREATE INDEX IF NOT EXISTS ky_menu_directory_visible_idx ON ky_menu_directory(directory_type, status, sort_order, menu_key);
CREATE INDEX IF NOT EXISTS ky_menu_directory_permission_idx ON ky_menu_directory(permission_code);

CREATE TABLE IF NOT EXISTS ky_menu_webview_config (
  directory_type text NOT NULL,
  menu_key text NOT NULL,
  config_scope text NOT NULL CHECK (config_scope IN ('common','workspace')),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform','agency','enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL DEFAULT 'web' CHECK (platform ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  default_url text NOT NULL CHECK (length(btrim(default_url)) BETWEEN 1 AND 4096),
  open_mode text NOT NULL DEFAULT 'embedded' CHECK (open_mode IN ('embedded','window')),
  navigation_protocols jsonb NOT NULL DEFAULT '["https"]'::jsonb,
  script_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  style_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule_mode text NOT NULL DEFAULT 'page_first' CHECK (schedule_mode IN ('page_first','strict_document_start')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (directory_type, menu_key, config_scope, workspace_type, workspace_id),
  FOREIGN KEY (directory_type, menu_key) REFERENCES ky_menu_directory(directory_type, menu_key) ON DELETE CASCADE,
  CHECK ((config_scope = 'common' AND workspace_type = 'platform' AND workspace_id = '*') OR config_scope = 'workspace')
);
CREATE INDEX IF NOT EXISTS ky_menu_webview_workspace_idx ON ky_menu_webview_config(workspace_type, workspace_id, menu_key);
ALTER TABLE ky_menu_webview_config ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'web';
DO $$ BEGIN
  ALTER TABLE ky_menu_webview_config ADD CONSTRAINT ky_menu_webview_platform_check CHECK (platform ~ '^[a-z0-9][a-z0-9_-]{0,31}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status)
VALUES
 ('permission.platform.menu_catalog.view','platform.menu_catalog.view','查看菜单目录','action','menu_catalog','view','["platform"]','查看通用管理中心与工作台菜单目录','normal'),
 ('permission.platform.menu_catalog.manage','platform.menu_catalog.manage','管理菜单目录','action','menu_catalog','manage','["platform"]','维护通用菜单目录及 WebView 配置','normal')
ON CONFLICT (code) DO NOTHING;

-- Menu catalog is an administrative capability, granted to the built-in
-- platform owner/admin roles only. Tenant users can still receive the actual
-- menu permission keys through role assignment and runtime visibility checks.
INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || role.id || '_' || permission.id, role.id, permission.id
FROM ky_role role
JOIN ky_permission permission ON permission.code IN ('platform.menu_catalog.view','platform.menu_catalog.manage')
WHERE role.id IN ('role_platform_owner','role_platform_admin')
  AND role.code IN ('platform_owner','platform_admin')
  AND role.workspace_type='platform' AND role.workspace_id='platform_root'
  AND role.is_system=true AND role.deleted_at IS NULL AND role.status='normal'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;

-- Rollback (only after application code is rolled back and custom menu data is backed up):
-- DROP TABLE ky_menu_webview_config;
-- DROP TABLE ky_menu_directory;
-- DELETE FROM ky_permission WHERE code IN ('platform.menu_catalog.view','platform.menu_catalog.manage');
