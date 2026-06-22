-- KyaiCRM Phase 1 organization schema.
-- Platform is represented by workspace_type = platform and workspace_id = platform_root.
-- Do not create ky_platform, ky_organization, ky_organization_setting, or ky_team_member.

CREATE TABLE IF NOT EXISTS ky_agency (
  id text PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL,
  logo_url text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  owner_user_id text REFERENCES ky_user(id),
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('pending', 'normal', 'disabled', 'frozen')),
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_agency_code_uidx ON ky_agency(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_agency_status_idx ON ky_agency(status);

CREATE TABLE IF NOT EXISTS ky_enterprise (
  id text PRIMARY KEY,
  agency_id text REFERENCES ky_agency(id),
  name text NOT NULL,
  code text NOT NULL,
  logo_url text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  owner_user_id text REFERENCES ky_user(id),
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('pending', 'normal', 'disabled', 'frozen')),
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_enterprise_code_uidx ON ky_enterprise(code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_enterprise_agency_status_idx ON ky_enterprise(agency_id, status);

CREATE TABLE IF NOT EXISTS ky_agency_enterprise_relation (
  id text PRIMARY KEY,
  agency_id text NOT NULL REFERENCES ky_agency(id),
  enterprise_id text NOT NULL REFERENCES ky_enterprise(id),
  relation_type text NOT NULL DEFAULT 'owner' CHECK (relation_type IN ('owner', 'service', 'cooperation')),
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('pending', 'normal', 'disabled', 'ended')),
  started_at timestamptz,
  ended_at timestamptz,
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_agency_enterprise_relation_uidx ON ky_agency_enterprise_relation(agency_id, enterprise_id, relation_type) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS ky_agency_enterprise_relation_enterprise_idx ON ky_agency_enterprise_relation(enterprise_id, status);

CREATE TABLE IF NOT EXISTS ky_department (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('agency', 'enterprise')),
  workspace_id text NOT NULL,
  parent_id text REFERENCES ky_department(id),
  name text NOT NULL,
  code text NOT NULL,
  leader_membership_id text,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_department_workspace_code_uidx ON ky_department(workspace_type, workspace_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_department_parent_idx ON ky_department(workspace_type, workspace_id, parent_id);

CREATE TABLE IF NOT EXISTS ky_team (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('agency', 'enterprise')),
  workspace_id text NOT NULL,
  department_id text REFERENCES ky_department(id),
  name text NOT NULL,
  code text NOT NULL,
  leader_membership_id text,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled', 'archived')),
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_team_workspace_code_uidx ON ky_team(workspace_type, workspace_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_team_department_idx ON ky_team(workspace_type, workspace_id, department_id);
