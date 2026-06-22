-- KyaiCRM Phase 1 membership schema.

CREATE TABLE IF NOT EXISTS ky_membership (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES ky_user(id),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  display_name text NOT NULL,
  employee_no text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled', 'left')),
  joined_at timestamptz,
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_membership_user_workspace_uidx ON ky_membership(user_id, workspace_type, workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_membership_workspace_status_idx ON ky_membership(workspace_type, workspace_id, status);

CREATE TABLE IF NOT EXISTS ky_membership_department (
  id text PRIMARY KEY,
  membership_id text NOT NULL REFERENCES ky_membership(id),
  department_id text NOT NULL REFERENCES ky_department(id),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_membership_department_uidx ON ky_membership_department(membership_id, department_id);
CREATE INDEX IF NOT EXISTS ky_membership_department_department_idx ON ky_membership_department(department_id);

CREATE TABLE IF NOT EXISTS ky_membership_team (
  id text PRIMARY KEY,
  membership_id text NOT NULL REFERENCES ky_membership(id),
  team_id text NOT NULL REFERENCES ky_team(id),
  role_in_team text NOT NULL DEFAULT 'member' CHECK (role_in_team IN ('leader', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_membership_team_uidx ON ky_membership_team(membership_id, team_id);
CREATE INDEX IF NOT EXISTS ky_membership_team_team_idx ON ky_membership_team(team_id);

CREATE TABLE IF NOT EXISTS ky_invitation (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  invitation_type text NOT NULL DEFAULT 'member' CHECK (invitation_type IN ('member', 'agency_admin', 'enterprise_admin')),
  invitee_email text,
  invitee_phone text,
  invited_by_membership_id text NOT NULL REFERENCES ky_membership(id),
  token text NOT NULL,
  preset_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  preset_department_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  preset_team_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  accepted_user_id text REFERENCES ky_user(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_invitation_token_uidx ON ky_invitation(token);
CREATE INDEX IF NOT EXISTS ky_invitation_workspace_status_idx ON ky_invitation(workspace_type, workspace_id, status);
CREATE INDEX IF NOT EXISTS ky_invitation_email_status_idx ON ky_invitation(invitee_email, status) WHERE invitee_email IS NOT NULL;
