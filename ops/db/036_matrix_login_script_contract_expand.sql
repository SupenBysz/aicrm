-- Matrix Account v9.1 P1: additive script binding and immutable contract schema.
--
-- This migration does not enable canonical generation/contract routes. Existing
-- scripts and versions remain legacy_provider, while every new contract head is
-- disabled until later rollout gates are explicitly opened.

ALTER TABLE ky_matrix_account_login_script
  ADD COLUMN IF NOT EXISTS executor_id text,
  ADD COLUMN IF NOT EXISTS model_key_override text,
  ADD COLUMN IF NOT EXISTS generation_engine text NOT NULL DEFAULT 'legacy_provider',
  ADD COLUMN IF NOT EXISTS config_revision bigint NOT NULL DEFAULT 1;

DO $matrix_script_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script'::regclass
      AND conname = 'ky_matrix_account_login_script_generation_engine_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script
      ADD CONSTRAINT ky_matrix_account_login_script_generation_engine_check
      CHECK (generation_engine IN ('legacy_provider', 'codex_executor')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script'::regclass
      AND conname = 'ky_matrix_account_login_script_config_revision_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script
      ADD CONSTRAINT ky_matrix_account_login_script_config_revision_check
      CHECK (config_revision > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script'::regclass
      AND conname = 'ky_matrix_account_login_script_executor_id_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script
      ADD CONSTRAINT ky_matrix_account_login_script_executor_id_check
      CHECK (executor_id IS NULL OR btrim(executor_id) <> '') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script'::regclass
      AND conname = 'ky_matrix_account_login_script_model_key_override_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script
      ADD CONSTRAINT ky_matrix_account_login_script_model_key_override_check
      CHECK (model_key_override IS NULL OR btrim(model_key_override) <> '') NOT VALID;
  END IF;
END
$matrix_script_constraints$;

ALTER TABLE ky_matrix_account_login_script_version
  ADD COLUMN IF NOT EXISTS effective_executor_id text,
  ADD COLUMN IF NOT EXISTS effective_model_key text,
  ADD COLUMN IF NOT EXISTS executor_source text,
  ADD COLUMN IF NOT EXISTS model_source text,
  ADD COLUMN IF NOT EXISTS executor_config_revision bigint,
  ADD COLUMN IF NOT EXISTS credential_binding_revision bigint,
  ADD COLUMN IF NOT EXISTS runtime_binding_id text,
  ADD COLUMN IF NOT EXISTS runtime_binding_revision bigint,
  ADD COLUMN IF NOT EXISTS model_catalog_revision bigint,
  ADD COLUMN IF NOT EXISTS generation_engine text NOT NULL DEFAULT 'legacy_provider',
  ADD COLUMN IF NOT EXISTS dsl_hash text;

-- ADD COLUMN defaults backfill all historical rows as legacy_provider without
-- rewriting any row that may already have been explicitly cut over.

CREATE OR REPLACE FUNCTION ky_matrix_account_set_login_script_dsl_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.dsl_hash := encode(sha256(convert_to(NEW.dsl_json::text, 'UTF8')), 'hex');
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_guard_login_script_version_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.script_id IS DISTINCT FROM OLD.script_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.dsl_json IS DISTINCT FROM OLD.dsl_json
     OR NEW.dsl_hash IS DISTINCT FROM OLD.dsl_hash
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.prompt_tokens IS DISTINCT FROM OLD.prompt_tokens
     OR NEW.completion_tokens IS DISTINCT FROM OLD.completion_tokens
     OR NEW.total_tokens IS DISTINCT FROM OLD.total_tokens
     OR NEW.usage_source IS DISTINCT FROM OLD.usage_source
     OR NEW.generation_reason IS DISTINCT FROM OLD.generation_reason
     OR NEW.effective_executor_id IS DISTINCT FROM OLD.effective_executor_id
     OR NEW.effective_model_key IS DISTINCT FROM OLD.effective_model_key
     OR NEW.executor_source IS DISTINCT FROM OLD.executor_source
     OR NEW.model_source IS DISTINCT FROM OLD.model_source
     OR NEW.executor_config_revision IS DISTINCT FROM OLD.executor_config_revision
     OR NEW.credential_binding_revision IS DISTINCT FROM OLD.credential_binding_revision
     OR NEW.runtime_binding_id IS DISTINCT FROM OLD.runtime_binding_id
     OR NEW.runtime_binding_revision IS DISTINCT FROM OLD.runtime_binding_revision
     OR NEW.model_catalog_revision IS DISTINCT FROM OLD.model_catalog_revision
     OR NEW.generation_engine IS DISTINCT FROM OLD.generation_engine
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'login script version frozen fields are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'candidate' AND NEW.status IN ('active', 'archived', 'failed'))
    OR (OLD.status = 'active' AND NEW.status = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid login script version status transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

UPDATE ky_matrix_account_login_script_version
SET dsl_hash = encode(sha256(convert_to(dsl_json::text, 'UTF8')), 'hex')
WHERE dsl_hash IS DISTINCT FROM encode(sha256(convert_to(dsl_json::text, 'UTF8')), 'hex');

ALTER TABLE ky_matrix_account_login_script_version
  ALTER COLUMN dsl_hash SET NOT NULL;

DO $matrix_script_version_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_version'::regclass
      AND tgname = 'ky_matrix_account_login_script_version_dsl_hash_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_version_dsl_hash_trg
      BEFORE INSERT OR UPDATE OF dsl_json
      ON ky_matrix_account_login_script_version
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_set_login_script_dsl_hash();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_version'::regclass
      AND tgname = 'ky_matrix_account_login_script_version_frozen_guard_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_version_frozen_guard_trg
      BEFORE UPDATE
      ON ky_matrix_account_login_script_version
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_guard_login_script_version_update();
  END IF;
END
$matrix_script_version_trigger$;

DO $matrix_script_version_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_engine_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_engine_check
      CHECK (generation_engine IN ('legacy_provider', 'codex_executor')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_executor_source_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_executor_source_check
      CHECK (executor_source IS NULL OR executor_source IN ('script_explicit', 'platform_default')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_model_source_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_model_source_check
      CHECK (model_source IS NULL OR model_source IN ('script_override', 'executor_default')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_dsl_hash_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_dsl_hash_check
      CHECK (dsl_hash ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_frozen_binding_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_frozen_binding_check
      CHECK (
        (
          generation_engine = 'legacy_provider'
          AND effective_executor_id IS NULL
          AND effective_model_key IS NULL
          AND executor_source IS NULL
          AND model_source IS NULL
          AND executor_config_revision IS NULL
          AND credential_binding_revision IS NULL
          AND runtime_binding_id IS NULL
          AND runtime_binding_revision IS NULL
          AND model_catalog_revision IS NULL
        )
        OR
        (
          generation_engine = 'codex_executor'
          AND model_id IS NULL
          AND effective_executor_id IS NOT NULL
          AND btrim(effective_executor_id) <> ''
          AND effective_model_key IS NOT NULL
          AND btrim(effective_model_key) <> ''
          AND executor_source IS NOT NULL
          AND executor_source IN ('script_explicit', 'platform_default')
          AND model_source IS NOT NULL
          AND model_source IN ('script_override', 'executor_default')
          AND executor_config_revision IS NOT NULL
          AND executor_config_revision > 0
          AND credential_binding_revision IS NOT NULL
          AND credential_binding_revision > 0
          AND runtime_binding_id IS NOT NULL
          AND btrim(runtime_binding_id) <> ''
          AND runtime_binding_revision IS NOT NULL
          AND runtime_binding_revision > 0
          AND model_catalog_revision IS NOT NULL
          AND model_catalog_revision > 0
        )
      ) NOT VALID;
  END IF;
END
$matrix_script_version_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_login_script_version_one_active_uidx
  ON ky_matrix_account_login_script_version(script_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  contract_code text NOT NULL CHECK (btrim(contract_code) <> ''),
  purpose_group text NOT NULL CHECK (btrim(purpose_group) <> ''),
  target text NOT NULL CHECK (btrim(target) <> ''),
  current_revision bigint NOT NULL CHECK (current_revision > 0),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled')),
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_login_script_contract_identity_uidx
  ON ky_matrix_account_login_script_contract(workspace_type, workspace_id, platform, contract_code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_contract_lookup_idx
  ON ky_matrix_account_login_script_contract(workspace_type, workspace_id, platform, purpose_group, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract_revision (
  contract_id text NOT NULL REFERENCES ky_matrix_account_login_script_contract(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  method_schema_json jsonb NOT NULL
    CHECK (jsonb_typeof(method_schema_json) = 'object' AND method_schema_json <> '{}'::jsonb),
  acceptance_schema_json jsonb NOT NULL
    CHECK (jsonb_typeof(acceptance_schema_json) = 'object' AND acceptance_schema_json <> '{}'::jsonb),
  schema_hash text NOT NULL CHECK (schema_hash ~ '^[a-f0-9]{64}$'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, revision)
);

CREATE OR REPLACE FUNCTION ky_matrix_account_set_login_script_contract_schema_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.schema_hash := encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'methodSchema', NEW.method_schema_json,
          'acceptanceSchema', NEW.acceptance_schema_json
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_reject_immutable_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable matrix account row cannot be modified: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_guard_login_script_contract_head()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_type IS DISTINCT FROM OLD.workspace_type
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.contract_code IS DISTINCT FROM OLD.contract_code
     OR NEW.purpose_group IS DISTINCT FROM OLD.purpose_group
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'contract head identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DO $matrix_contract_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_contract_revision'::regclass
      AND tgname = 'ky_matrix_account_login_script_contract_revision_hash_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_contract_revision_hash_trg
      BEFORE INSERT
      ON ky_matrix_account_login_script_contract_revision
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_set_login_script_contract_schema_hash();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_contract_revision'::regclass
      AND tgname = 'ky_matrix_account_login_script_contract_revision_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_contract_revision_immutable_trg
      BEFORE UPDATE OR DELETE
      ON ky_matrix_account_login_script_contract_revision
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_reject_immutable_row_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_contract'::regclass
      AND tgname = 'ky_matrix_account_login_script_contract_head_guard_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_contract_head_guard_trg
      BEFORE UPDATE
      ON ky_matrix_account_login_script_contract
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_guard_login_script_contract_head();
  END IF;
END
$matrix_contract_triggers$;

DO $matrix_contract_head_revision_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_contract'::regclass
      AND conname = 'ky_matrix_account_login_script_contract_current_revision_fk'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_contract
      ADD CONSTRAINT ky_matrix_account_login_script_contract_current_revision_fk
      FOREIGN KEY (id, current_revision)
      REFERENCES ky_matrix_account_login_script_contract_revision(contract_id, revision)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$matrix_contract_head_revision_fk$;

-- Contract GET/PATCH/test endpoints deliberately reuse the already locked
-- view/update/regenerate permissions from migration 026. Only executor/model
-- assignment introduces new independent AND permissions.
INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_matrix_login_scripts_assign_executor', 'platform.matrix_account_login_scripts.assign_executor', '平台登录脚本指定执行器', 'action', 'matrix_account_login_scripts', 'assign_executor', '["platform"]'::jsonb, 'Assign a granted executor to a Matrix login script', 'normal'),
  ('perm_platform_matrix_login_scripts_assign_model', 'platform.matrix_account_login_scripts.assign_model', '平台登录脚本指定模型', 'action', 'matrix_account_login_scripts', 'assign_model', '["platform"]'::jsonb, 'Assign a catalog model key to a Matrix login script', 'normal'),
  ('perm_agency_matrix_login_scripts_assign_executor', 'agency.matrix_account_login_scripts.assign_executor', '机构登录脚本指定执行器', 'action', 'matrix_account_login_scripts', 'assign_executor', '["agency"]'::jsonb, 'Assign a granted executor to a Matrix login script', 'normal'),
  ('perm_agency_matrix_login_scripts_assign_model', 'agency.matrix_account_login_scripts.assign_model', '机构登录脚本指定模型', 'action', 'matrix_account_login_scripts', 'assign_model', '["agency"]'::jsonb, 'Assign a catalog model key to a Matrix login script', 'normal'),
  ('perm_enterprise_matrix_login_scripts_assign_executor', 'enterprise.matrix_account_login_scripts.assign_executor', '企业登录脚本指定执行器', 'action', 'matrix_account_login_scripts', 'assign_executor', '["enterprise"]'::jsonb, 'Assign a granted executor to a Matrix login script', 'normal'),
  ('perm_enterprise_matrix_login_scripts_assign_model', 'enterprise.matrix_account_login_scripts.assign_model', '企业登录脚本指定模型', 'action', 'matrix_account_login_scripts', 'assign_model', '["enterprise"]'::jsonb, 'Assign a catalog model key to a Matrix login script', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || role_id || '_' || replace(permission.code, '.', '_'), role_id, permission.id
FROM ky_permission permission
CROSS JOIN (VALUES ('role_platform_owner'), ('role_platform_admin')) AS roles(role_id)
WHERE permission.code IN (
  'platform.matrix_account_login_scripts.assign_executor',
  'platform.matrix_account_login_scripts.assign_model'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || role_id || '_' || replace(permission.code, '.', '_'), role_id, permission.id
FROM ky_permission permission
CROSS JOIN (VALUES ('role_agency_owner_template'), ('role_agency_admin_template')) AS roles(role_id)
WHERE permission.code IN (
  'agency.matrix_account_login_scripts.assign_executor',
  'agency.matrix_account_login_scripts.assign_model'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_' || role_id || '_' || replace(permission.code, '.', '_'), role_id, permission.id
FROM ky_permission permission
CROSS JOIN (VALUES ('role_enterprise_owner_template'), ('role_enterprise_admin_template')) AS roles(role_id)
WHERE permission.code IN (
  'enterprise.matrix_account_login_scripts.assign_executor',
  'enterprise.matrix_account_login_scripts.assign_model'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
