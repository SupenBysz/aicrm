-- KyaiCRM Phase 1 access schema.

CREATE TABLE IF NOT EXISTS ky_role (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text,
  name text NOT NULL,
  code text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_role_workspace_code_uidx ON ky_role(workspace_type, COALESCE(workspace_id, ''), code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_role_workspace_status_idx ON ky_role(workspace_type, workspace_id, status);

CREATE TABLE IF NOT EXISTS ky_permission (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('menu', 'page', 'action')),
  resource text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT '',
  workspace_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_permission_code_uidx ON ky_permission(code);
CREATE INDEX IF NOT EXISTS ky_permission_category_idx ON ky_permission(category, status);

CREATE TABLE IF NOT EXISTS ky_role_permission (
  id text PRIMARY KEY,
  role_id text NOT NULL REFERENCES ky_role(id),
  permission_id text NOT NULL REFERENCES ky_permission(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_role_permission_uidx ON ky_role_permission(role_id, permission_id);
CREATE INDEX IF NOT EXISTS ky_role_permission_permission_idx ON ky_role_permission(permission_id);

CREATE TABLE IF NOT EXISTS ky_membership_role (
  id text PRIMARY KEY,
  membership_id text NOT NULL REFERENCES ky_membership(id),
  role_id text NOT NULL REFERENCES ky_role(id),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_membership_role_uidx ON ky_membership_role(membership_id, role_id);
CREATE INDEX IF NOT EXISTS ky_membership_role_workspace_idx ON ky_membership_role(workspace_type, workspace_id);

CREATE TABLE IF NOT EXISTS ky_role_data_scope (
  id text PRIMARY KEY,
  role_id text NOT NULL REFERENCES ky_role(id),
  scope_type text NOT NULL CHECK (scope_type IN ('all', 'current_agency', 'current_enterprise', 'specified_agency', 'specified_enterprise', 'department', 'department_tree', 'specified_department', 'team', 'specified_team', 'self', 'custom')),
  department_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  team_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  agency_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  enterprise_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_role_data_scope_role_idx ON ky_role_data_scope(role_id);
