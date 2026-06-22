-- KyaiCRM Phase 1 audit and notification schema.

CREATE TABLE IF NOT EXISTS ky_audit_log (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES ky_user(id),
  actor_membership_id text REFERENCES ky_membership(id),
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  agency_id text,
  enterprise_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL DEFAULT '',
  result text NOT NULL CHECK (result IN ('success', 'failed')),
  request_id text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  remark text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_audit_log_workspace_created_idx ON ky_audit_log(workspace_type, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ky_audit_log_actor_created_idx ON ky_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ky_audit_log_resource_idx ON ky_audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS ky_audit_log_actor_membership_idx ON ky_audit_log(workspace_type, workspace_id, actor_membership_id);

CREATE TABLE IF NOT EXISTS ky_notification (
  id text PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'platform', 'agency', 'enterprise')),
  scope_id text NOT NULL,
  recipient_user_id text REFERENCES ky_user(id),
  recipient_membership_id text REFERENCES ky_membership(id),
  title text NOT NULL,
  content text NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('invite', 'security', 'system', 'permission', 'organization')),
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_notification_recipient_created_idx ON ky_notification(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ky_notification_membership_created_idx ON ky_notification(recipient_membership_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ky_notification_scope_created_idx ON ky_notification(scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ky_notification_read (
  id text PRIMARY KEY,
  notification_id text NOT NULL REFERENCES ky_notification(id),
  user_id text NOT NULL REFERENCES ky_user(id),
  read_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_notification_read_uidx ON ky_notification_read(notification_id, user_id);

CREATE TABLE IF NOT EXISTS ky_system_announcement (
  id text PRIMARY KEY,
  title text NOT NULL,
  content text NOT NULL,
  target_scope text NOT NULL CHECK (target_scope IN ('all', 'agency', 'enterprise', 'user')),
  target_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_system_announcement_status_created_idx ON ky_system_announcement(status, created_at DESC);
