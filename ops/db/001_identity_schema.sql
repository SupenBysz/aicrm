-- KyaiCRM Phase 1 identity schema.

CREATE TABLE IF NOT EXISTS ky_user (
  id text PRIMARY KEY,
  username text,
  display_name text NOT NULL,
  avatar_url text NOT NULL DEFAULT '',
  phone text,
  email text,
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'unverified', 'disabled', 'closed')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_user_username_uidx ON ky_user(username) WHERE username IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ky_user_phone_uidx ON ky_user(phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ky_user_email_uidx ON ky_user(email) WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_user_credential (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES ky_user(id),
  credential_type text NOT NULL CHECK (credential_type IN ('password', 'phone', 'email', 'oauth')),
  identifier text NOT NULL,
  password_hash text,
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_user_credential_identifier_uidx ON ky_user_credential(credential_type, identifier);
CREATE INDEX IF NOT EXISTS ky_user_credential_user_idx ON ky_user_credential(user_id);

CREATE TABLE IF NOT EXISTS ky_user_session (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES ky_user(id),
  token_id text NOT NULL,
  user_agent text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_user_session_token_uidx ON ky_user_session(token_id);
CREATE INDEX IF NOT EXISTS ky_user_session_user_status_idx ON ky_user_session(user_id, status);

CREATE TABLE IF NOT EXISTS ky_login_log (
  id text PRIMARY KEY,
  user_id text REFERENCES ky_user(id),
  login_account text NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'failed')),
  fail_reason text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_login_log_user_created_idx ON ky_login_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ky_login_log_result_created_idx ON ky_login_log(result, created_at DESC);
