-- KyaiCRM Phase 1 system setting schema.

CREATE TABLE IF NOT EXISTS ky_system_setting (
  id text PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('platform', 'agency', 'enterprise')),
  scope_id text NOT NULL,
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text NOT NULL DEFAULT '',
  updated_by text REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_system_setting_scope_key_uidx ON ky_system_setting(scope_type, scope_id, setting_key);

CREATE TABLE IF NOT EXISTS ky_dictionary (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('platform', 'agency', 'enterprise')),
  scope_id text NOT NULL,
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_dictionary_scope_code_uidx ON ky_dictionary(scope_type, scope_id, code);

CREATE TABLE IF NOT EXISTS ky_dictionary_item (
  id text PRIMARY KEY,
  dictionary_id text NOT NULL REFERENCES ky_dictionary(id),
  label text NOT NULL,
  value text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_dictionary_item_value_uidx ON ky_dictionary_item(dictionary_id, value);
CREATE INDEX IF NOT EXISTS ky_dictionary_item_sort_idx ON ky_dictionary_item(dictionary_id, sort_order);
