-- KyaiCRM Phase 1 AI provider and model configuration schema.
-- AI scope is limited to provider/model/default model configuration.

CREATE TABLE IF NOT EXISTS ky_ai_provider (
  id text PRIMARY KEY,
  name text NOT NULL,
  provider_type text NOT NULL,
  base_url text NOT NULL DEFAULT '',
  api_key_encrypted text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_provider_type_name_uidx ON ky_ai_provider(provider_type, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_ai_provider_status_idx ON ky_ai_provider(status);

CREATE TABLE IF NOT EXISTS ky_ai_model (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES ky_ai_provider(id),
  name text NOT NULL,
  model_key text NOT NULL,
  model_type text NOT NULL CHECK (model_type IN ('text_generation', 'embedding', 'vision', 'audio')),
  context_length integer NOT NULL DEFAULT 0,
  default_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  remark text NOT NULL DEFAULT '',
  created_by text REFERENCES ky_user(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_model_provider_key_uidx ON ky_ai_model(provider_id, model_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ky_ai_model_type_status_idx ON ky_ai_model(model_type, status);

CREATE TABLE IF NOT EXISTS ky_ai_model_setting (
  id text PRIMARY KEY,
  scope_type text NOT NULL DEFAULT 'platform' CHECK (scope_type IN ('platform', 'agency', 'enterprise')),
  scope_id text NOT NULL,
  setting_key text NOT NULL CHECK (setting_key IN ('default_chat_model', 'default_summary_model', 'default_embedding_model')),
  model_id text REFERENCES ky_ai_model(id),
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_model_setting_scope_key_uidx ON ky_ai_model_setting(scope_type, scope_id, setting_key);
