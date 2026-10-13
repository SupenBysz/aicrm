-- 公共 CSS 样式资源；与公共 JavaScript 脚本完全独立。
CREATE TABLE IF NOT EXISTS ky_matrix_account_public_style (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform','agency','enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL DEFAULT 'douyin',
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  identifier text NOT NULL CHECK (identifier ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  description text NOT NULL DEFAULT '',
  match_type text NOT NULL DEFAULT 'wildcard' CHECK (match_type IN ('exact','wildcard')),
  match_url text NOT NULL DEFAULT 'https://example.com/*',
  source_content text NOT NULL DEFAULT '',
  source_chars integer NOT NULL DEFAULT 0 CHECK (source_chars >= 0),
  source_bytes integer NOT NULL DEFAULT 0 CHECK (source_bytes >= 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  run_at text NOT NULL DEFAULT 'document_start' CHECK (run_at IN ('document_start','dom_content_loaded','document_idle','spa_route_change')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10000 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
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
CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_public_style_identifier_uidx
  ON ky_matrix_account_public_style(workspace_type, workspace_id, platform, lower(identifier))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_matrix_account_public_style_list_idx
  ON ky_matrix_account_public_style(workspace_type, workspace_id, platform, enabled, updated_at DESC)
  WHERE deleted_at IS NULL;
INSERT INTO ky_permission(id, code, name, category, resource, action, workspace_types, description, status) VALUES
 ('perm_platform_matrix_account_public_styles_view','platform.matrix_account_public_styles.view','公共样式查看','page','matrix_account_public_styles','view','["platform","agency","enterprise"]'::jsonb,'公共 CSS 样式查看','normal'),
 ('perm_platform_matrix_account_public_styles_manage','platform.matrix_account_public_styles.manage','公共样式管理','action','matrix_account_public_styles','manage','["platform","agency","enterprise"]'::jsonb,'公共 CSS 样式管理','normal')
ON CONFLICT(code) DO NOTHING;
INSERT INTO ky_role_permission(id, role_id, permission_id)
SELECT 'rp_' || r.id || '_' || replace(p.code,'.','_'), r.id, p.id
FROM ky_role r CROSS JOIN ky_permission p
WHERE r.id IN ('role_platform_owner','role_platform_admin')
  AND r.status='normal' AND r.deleted_at IS NULL
  AND p.code IN ('platform.matrix_account_public_styles.view','platform.matrix_account_public_styles.manage')
ON CONFLICT(role_id, permission_id) DO NOTHING;
