-- Matrix Account v9.1 P1: additive safe context and asynchronous generation
-- resources. Intake, Desktop proof, internal snapshot read and generation write
-- routes remain disabled until their later P2/P4 gates pass.

ALTER TABLE ky_matrix_account_web_space
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;

DO $matrix_web_space_revision_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_web_space'::regclass
      AND conname = 'ky_matrix_account_web_space_revision_check'
  ) THEN
    ALTER TABLE ky_matrix_account_web_space
      ADD CONSTRAINT ky_matrix_account_web_space_revision_check
      CHECK (revision > 0) NOT VALID;
  END IF;
END
$matrix_web_space_revision_constraint$;

CREATE OR REPLACE FUNCTION ky_matrix_account_context_safe_text(value text, maximum_length integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT char_length(value) <= maximum_length
     AND value !~* '^data:'
     AND value !~* '-----BEGIN[[:space:]][A-Z0-9 ]+-----'
     AND value !~* '<[[:space:]]*(html|script|iframe|form|input)([[:space:]>]|$)'
     AND value !~* '(^|[^a-z0-9])(access[_-]?token|refresh[_-]?token|sessionid|uid[_-]?tt|cookie)[[:space:]]*[:=]'
     AND value !~* '(^|[[:space:]"''])((/etc/|/root/|/home/|/data/)|[a-z]:[\\/])';
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_context_payload_is_safe(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  item jsonb;
  rect jsonb;
BEGIN
  IF jsonb_typeof(payload) <> 'object'
     OR payload = '{}'::jsonb
     OR octet_length(payload::text) > 262144
     OR payload - ARRAY['title', 'visibleText', 'landmarks', 'elements'] <> '{}'::jsonb THEN
    RETURN false;
  END IF;

  IF payload ? 'title' AND (
    jsonb_typeof(payload->'title') <> 'string'
    OR NOT ky_matrix_account_context_safe_text(payload->>'title', 512)
  ) THEN
    RETURN false;
  END IF;

  IF payload ? 'visibleText' THEN
    IF jsonb_typeof(payload->'visibleText') <> 'array'
       OR jsonb_array_length(payload->'visibleText') > 200 THEN
      RETURN false;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'visibleText')
    LOOP
      IF jsonb_typeof(item) <> 'string'
         OR NOT ky_matrix_account_context_safe_text(item #>> '{}', 512) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  IF payload ? 'landmarks' THEN
    IF jsonb_typeof(payload->'landmarks') <> 'array'
       OR jsonb_array_length(payload->'landmarks') > 64 THEN
      RETURN false;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'landmarks')
    LOOP
      IF jsonb_typeof(item) <> 'object'
         OR item - ARRAY['role', 'accessibleName'] <> '{}'::jsonb
         OR NOT (item ? 'role')
         OR jsonb_typeof(item->'role') <> 'string'
         OR NOT ky_matrix_account_context_safe_text(item->>'role', 80)
         OR (item ? 'accessibleName' AND (
           jsonb_typeof(item->'accessibleName') <> 'string'
           OR NOT ky_matrix_account_context_safe_text(item->>'accessibleName', 256)
         )) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  IF payload ? 'elements' THEN
    IF jsonb_typeof(payload->'elements') <> 'array'
       OR jsonb_array_length(payload->'elements') > 200 THEN
      RETURN false;
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'elements')
    LOOP
      IF jsonb_typeof(item) <> 'object'
         OR item - ARRAY[
           'elementKey', 'keySource', 'stability', 'role', 'accessibleName',
           'landmark', 'normalizedText', 'rect'
         ] <> '{}'::jsonb
         OR NOT (item ?& ARRAY['elementKey', 'keySource', 'stability', 'rect'])
         OR jsonb_typeof(item->'elementKey') <> 'string'
         OR NOT ky_matrix_account_context_safe_text(item->>'elementKey', 512)
         OR jsonb_typeof(item->'keySource') <> 'string'
         OR item->>'keySource' NOT IN (
           'platform_semantic', 'a11y_role_name', 'stable_id_name', 'scoped_text', 'structural_selector'
         )
         OR jsonb_typeof(item->'stability') <> 'string'
         OR item->>'stability' NOT IN ('high', 'medium', 'low')
         OR (item ? 'role' AND (
           jsonb_typeof(item->'role') <> 'string'
           OR NOT ky_matrix_account_context_safe_text(item->>'role', 80)
         ))
         OR (item ? 'accessibleName' AND (
           jsonb_typeof(item->'accessibleName') <> 'string'
           OR NOT ky_matrix_account_context_safe_text(item->>'accessibleName', 256)
         ))
         OR (item ? 'landmark' AND (
           jsonb_typeof(item->'landmark') <> 'string'
           OR NOT ky_matrix_account_context_safe_text(item->>'landmark', 160)
         ))
         OR (item ? 'normalizedText' AND (
           jsonb_typeof(item->'normalizedText') <> 'string'
           OR NOT ky_matrix_account_context_safe_text(item->>'normalizedText', 512)
         )) THEN
        RETURN false;
      END IF;

      rect := item->'rect';
      IF jsonb_typeof(rect) <> 'object'
         OR rect - ARRAY['x', 'y', 'width', 'height'] <> '{}'::jsonb
         OR NOT (rect ?& ARRAY['x', 'y', 'width', 'height'])
         OR jsonb_typeof(rect->'x') <> 'number'
         OR jsonb_typeof(rect->'y') <> 'number'
         OR jsonb_typeof(rect->'width') <> 'number'
         OR jsonb_typeof(rect->'height') <> 'number'
         OR (rect->>'x')::numeric NOT BETWEEN -1000000 AND 1000000
         OR (rect->>'y')::numeric NOT BETWEEN -1000000 AND 1000000
         OR (rect->>'width')::numeric NOT BETWEEN 0 AND 1000000
         OR (rect->>'height')::numeric NOT BETWEEN 0 AND 1000000 THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_safe_metadata_at(payload jsonb, depth integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  item record;
  normalized_key text;
  text_value text;
BEGIN
  IF depth > 12 OR octet_length(payload::text) > 65536 THEN
    RETURN false;
  END IF;
  CASE jsonb_typeof(payload)
    WHEN 'object' THEN
      FOR item IN SELECT key, value FROM jsonb_each(payload)
      LOOP
        normalized_key := lower(regexp_replace(item.key, '[^a-z0-9]', '', 'g'));
        IF normalized_key ~ '(cookie|storage|indexeddb|token|password|passwd|credential|secret|proof|receipt|authorization|ticket|challenge|sessionid|uidtt|screenshot|dataurl|rawdom|rawhtml|rawoutput|prompt|javascript|xpath|filepath|filesystempath)'
           OR NOT ky_matrix_account_safe_metadata_at(item.value, depth + 1) THEN
          RETURN false;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      IF jsonb_array_length(payload) > 256 THEN
        RETURN false;
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(payload)
      LOOP
        IF NOT ky_matrix_account_safe_metadata_at(item.value, depth + 1) THEN
          RETURN false;
        END IF;
      END LOOP;
    WHEN 'string' THEN
      text_value := payload #>> '{}';
      IF NOT ky_matrix_account_context_safe_text(text_value, 4096) THEN
        RETURN false;
      END IF;
    WHEN 'number', 'boolean', 'null' THEN
      NULL;
    ELSE
      RETURN false;
  END CASE;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_safe_metadata(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT ky_matrix_account_safe_metadata_at(payload, 0);
$function$;

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_context_snapshot (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('douyin', 'kuaishou', 'xiaohongshu')),
  web_space_id text REFERENCES ky_matrix_account_web_space(id) ON DELETE RESTRICT,
  script_id text REFERENCES ky_matrix_account_login_script(id) ON DELETE RESTRICT,
  attempt_id text REFERENCES ky_matrix_account_login_attempt(id) ON DELETE RESTRICT,
  script_purpose text NOT NULL
    CHECK (script_purpose IN ('qr_login_prepare', 'qr_login_refresh', 'account_detect', 'session_check')),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  sanitizer_version text NOT NULL CHECK (btrim(sanitizer_version) <> '' AND char_length(sanitizer_version) <= 64),
  page_origin text NOT NULL
    CHECK (char_length(page_origin) <= 512 AND page_origin ~ '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$'),
  page_path text NOT NULL
    CHECK (char_length(page_path) <= 2048 AND page_path ~ '^/' AND page_path !~ '[?#]'),
  page_fingerprint text NOT NULL CHECK (page_fingerprint ~ '^[a-f0-9]{64}$'),
  safe_payload_json jsonb NOT NULL CHECK (ky_matrix_account_context_payload_is_safe(safe_payload_json)),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'expired', 'deleted')),
  expires_at timestamptz NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT ky_matrix_account_login_script_context_target_check
    CHECK (
      num_nonnulls(web_space_id, script_id) = 1
      AND (script_id IS NULL OR attempt_id IS NULL)
    ),
  CONSTRAINT ky_matrix_account_login_script_context_ttl_check
    CHECK (expires_at = created_at + interval '30 minutes'),
  CONSTRAINT ky_matrix_account_login_script_context_deleted_check
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_context_ready_idx
  ON ky_matrix_account_login_script_context_snapshot(workspace_type, workspace_id, platform, expires_at)
  WHERE status = 'ready' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_context_web_space_idx
  ON ky_matrix_account_login_script_context_snapshot(web_space_id, created_at DESC)
  WHERE web_space_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ky_matrix_account_login_script_context_script_idx
  ON ky_matrix_account_login_script_context_snapshot(script_id, created_at DESC)
  WHERE script_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ky_matrix_account_set_context_snapshot_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.content_hash := encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'schemaVersion', NEW.schema_version,
          'sanitizerVersion', NEW.sanitizer_version,
          'pageOrigin', NEW.page_origin,
          'pagePath', NEW.page_path,
          'pageFingerprint', NEW.page_fingerprint,
          'safePayload', NEW.safe_payload_json
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION ky_matrix_account_guard_context_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_type IS DISTINCT FROM OLD.workspace_type
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.web_space_id IS DISTINCT FROM OLD.web_space_id
     OR NEW.script_id IS DISTINCT FROM OLD.script_id
     OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.script_purpose IS DISTINCT FROM OLD.script_purpose
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.sanitizer_version IS DISTINCT FROM OLD.sanitizer_version
     OR NEW.page_origin IS DISTINCT FROM OLD.page_origin
     OR NEW.page_path IS DISTINCT FROM OLD.page_path
     OR NEW.page_fingerprint IS DISTINCT FROM OLD.page_fingerprint
     OR NEW.safe_payload_json IS DISTINCT FROM OLD.safe_payload_json
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'script context snapshot content is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'ready' AND NEW.status IN ('expired', 'deleted'))
    OR (OLD.status = 'expired' AND NEW.status = 'deleted')
  ) THEN
    RAISE EXCEPTION 'invalid script context snapshot status transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DO $matrix_context_snapshot_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_context_snapshot'::regclass
      AND tgname = 'ky_matrix_account_login_script_context_hash_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_context_hash_trg
      BEFORE INSERT
      ON ky_matrix_account_login_script_context_snapshot
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_set_context_snapshot_hash();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_context_snapshot'::regclass
      AND tgname = 'ky_matrix_account_login_script_context_update_guard_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_context_update_guard_trg
      BEFORE UPDATE
      ON ky_matrix_account_login_script_context_snapshot
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_guard_context_snapshot_update();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_context_snapshot'::regclass
      AND tgname = 'ky_matrix_account_login_script_context_no_delete_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_context_no_delete_trg
      BEFORE DELETE
      ON ky_matrix_account_login_script_context_snapshot
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_reject_immutable_row_mutation();
  END IF;
END
$matrix_context_snapshot_triggers$;

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_generation_run (
  id text PRIMARY KEY,
  workspace_type text NOT NULL CHECK (workspace_type IN ('platform', 'agency', 'enterprise')),
  workspace_id text NOT NULL,
  web_space_id text REFERENCES ky_matrix_account_web_space(id) ON DELETE RESTRICT,
  script_id text REFERENCES ky_matrix_account_login_script(id) ON DELETE RESTRICT,
  script_purpose text NOT NULL
    CHECK (script_purpose IN ('qr_login_prepare', 'qr_login_refresh', 'account_detect', 'session_check')),
  operation text NOT NULL CHECK (operation IN ('generate', 'repair', 'contract_test')),
  generation_reason text NOT NULL CHECK (generation_reason IN (
    'no_active_script', 'script_disabled', 'no_active_version', 'page_fingerprint_changed',
    'script_run_failed', 'consecutive_failures', 'qr_not_found', 'refresh_script_missing',
    'refresh_script_failed', 'manual_retry', 'detect_script_missing', 'detect_script_failed',
    'login_completed_detect_missing', 'account_identity_not_found', 'contract_validation'
  )),
  generation_engine text NOT NULL CHECK (generation_engine IN ('legacy_provider', 'codex_executor')),
  contract_id text NOT NULL,
  contract_revision bigint NOT NULL CHECK (contract_revision > 0),
  target_version_id text REFERENCES ky_matrix_account_login_script_version(id) ON DELETE RESTRICT,
  context_snapshot_id text REFERENCES ky_matrix_account_login_script_context_snapshot(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'materializing', 'succeeded', 'failed', 'cancelled')),
  dispatch_status text NOT NULL DEFAULT 'pending'
    CHECK (dispatch_status IN ('pending', 'dispatching', 'dispatched', 'cancelled', 'failed')),
  dispatch_attempt integer NOT NULL DEFAULT 0 CHECK (dispatch_attempt >= 0),
  dispatch_lease_expires_at timestamptz,
  candidate_version_id text REFERENCES ky_matrix_account_login_script_version(id) ON DELETE RESTRICT,
  expected_script_revision bigint CHECK (expected_script_revision > 0),
  expected_web_space_revision bigint CHECK (expected_web_space_revision > 0),
  effective_executor_id text,
  effective_model_key text,
  executor_source text CHECK (executor_source IS NULL OR executor_source IN ('script_explicit', 'platform_default')),
  model_source text CHECK (model_source IS NULL OR model_source IN ('script_override', 'executor_default')),
  executor_config_revision bigint CHECK (executor_config_revision > 0),
  credential_binding_revision bigint CHECK (credential_binding_revision > 0),
  runtime_binding_id text,
  runtime_binding_revision bigint CHECK (runtime_binding_revision > 0),
  model_catalog_revision bigint CHECK (model_catalog_revision > 0),
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  failure_code text NOT NULL DEFAULT '' CHECK (failure_code ~ '^[a-z0-9_]{0,64}$'),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT ky_matrix_account_generation_contract_revision_fk
    FOREIGN KEY (contract_id, contract_revision)
    REFERENCES ky_matrix_account_login_script_contract_revision(contract_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT ky_matrix_account_generation_target_check CHECK (
    (operation IN ('generate', 'repair') AND target_version_id IS NULL AND generation_reason <> 'contract_validation')
    OR
    (operation = 'contract_test' AND script_id IS NOT NULL AND target_version_id IS NOT NULL
      AND expected_script_revision IS NOT NULL AND generation_reason = 'contract_validation')
  ),
  CONSTRAINT ky_matrix_account_generation_resource_check CHECK (
    web_space_id IS NOT NULL OR script_id IS NOT NULL
  ),
  CONSTRAINT ky_matrix_account_generation_expected_revision_check CHECK (
    (script_id IS NULL OR expected_script_revision IS NOT NULL)
    AND (web_space_id IS NULL OR expected_web_space_revision IS NOT NULL)
  ),
  CONSTRAINT ky_matrix_account_generation_candidate_check CHECK (
    (operation = 'contract_test' AND candidate_version_id IS NULL)
    OR
    (operation IN ('generate', 'repair') AND (
      (status = 'succeeded' AND candidate_version_id IS NOT NULL)
      OR (status <> 'succeeded' AND candidate_version_id IS NULL)
    ))
  ),
  CONSTRAINT ky_matrix_account_generation_finished_check CHECK (
    (status IN ('succeeded', 'failed', 'cancelled') AND finished_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed', 'cancelled') AND finished_at IS NULL)
  ),
  CONSTRAINT ky_matrix_account_generation_dispatch_lease_check CHECK (
    (dispatch_status = 'dispatching' AND dispatch_lease_expires_at IS NOT NULL)
    OR (dispatch_status <> 'dispatching' AND dispatch_lease_expires_at IS NULL)
  ),
  CONSTRAINT ky_matrix_account_generation_binding_check CHECK (
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
      AND effective_executor_id IS NOT NULL AND btrim(effective_executor_id) <> ''
      AND effective_model_key IS NOT NULL AND btrim(effective_model_key) <> ''
      AND executor_source IS NOT NULL
      AND executor_source IN ('script_explicit', 'platform_default')
      AND model_source IS NOT NULL
      AND model_source IN ('script_override', 'executor_default')
      AND executor_config_revision IS NOT NULL
      AND credential_binding_revision IS NOT NULL
      AND runtime_binding_id IS NOT NULL AND btrim(runtime_binding_id) <> ''
      AND runtime_binding_revision IS NOT NULL
      AND model_catalog_revision IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_generation_run_workspace_idx
  ON ky_matrix_account_login_script_generation_run(workspace_type, workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ky_matrix_account_generation_run_dispatch_idx
  ON ky_matrix_account_login_script_generation_run(dispatch_status, dispatch_lease_expires_at, created_at)
  WHERE dispatch_status IN ('pending', 'dispatching');

CREATE INDEX IF NOT EXISTS ky_matrix_account_generation_run_context_idx
  ON ky_matrix_account_login_script_generation_run(context_snapshot_id)
  WHERE context_snapshot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_generation_run_web_space_idempotency_uidx
  ON ky_matrix_account_login_script_generation_run(created_by, web_space_id, idempotency_key_hash)
  WHERE web_space_id IS NOT NULL AND operation IN ('generate', 'repair');

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_generation_run_script_idempotency_uidx
  ON ky_matrix_account_login_script_generation_run(created_by, script_id, idempotency_key_hash)
  WHERE web_space_id IS NULL AND script_id IS NOT NULL AND operation IN ('generate', 'repair');

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_generation_run_contract_idempotency_uidx
  ON ky_matrix_account_login_script_generation_run(created_by, contract_id, idempotency_key_hash)
  WHERE operation = 'contract_test';

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_generation_run_event (
  id text PRIMARY KEY,
  generation_run_id text NOT NULL
    REFERENCES ky_matrix_account_login_script_generation_run(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (btrim(event_type) <> '' AND char_length(event_type) <= 120),
  safe_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_payload_json) = 'object' AND ky_matrix_account_safe_metadata(safe_payload_json)),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (generation_run_id, sequence)
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_generation_event_cursor_idx
  ON ky_matrix_account_login_script_generation_run_event(generation_run_id, sequence);

CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract_test_result (
  id text PRIMARY KEY,
  generation_run_id text NOT NULL UNIQUE
    REFERENCES ky_matrix_account_login_script_generation_run(id) ON DELETE RESTRICT,
  script_id text NOT NULL REFERENCES ky_matrix_account_login_script(id) ON DELETE RESTRICT,
  candidate_version_id text NOT NULL
    REFERENCES ky_matrix_account_login_script_version(id) ON DELETE RESTRICT,
  contract_id text NOT NULL,
  contract_revision bigint NOT NULL CHECK (contract_revision > 0),
  script_revision bigint NOT NULL CHECK (script_revision > 0),
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  assertions_json jsonb NOT NULL
    CHECK (jsonb_typeof(assertions_json) = 'object' AND assertions_json <> '{}'::jsonb
      AND ky_matrix_account_safe_metadata(assertions_json)),
  stability_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(stability_summary_json) = 'object'
      AND ky_matrix_account_safe_metadata(stability_summary_json)),
  failure_code text NOT NULL DEFAULT '' CHECK (failure_code ~ '^[a-z0-9_]{0,64}$'),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ky_matrix_account_contract_test_result_contract_fk
    FOREIGN KEY (contract_id, contract_revision)
    REFERENCES ky_matrix_account_login_script_contract_revision(contract_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT ky_matrix_account_contract_test_result_failure_check
    CHECK ((status = 'passed' AND failure_code = '') OR (status = 'failed' AND failure_code <> ''))
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_contract_test_result_latest_idx
  ON ky_matrix_account_login_script_contract_test_result(
    candidate_version_id, contract_id, contract_revision, created_at DESC
  );

CREATE OR REPLACE FUNCTION ky_matrix_account_validate_contract_test_result()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  generation ky_matrix_account_login_script_generation_run%ROWTYPE;
  version_script_id text;
  version_status text;
BEGIN
  SELECT * INTO generation
  FROM ky_matrix_account_login_script_generation_run
  WHERE id = NEW.generation_run_id
  FOR KEY SHARE;

  IF NOT FOUND
     OR generation.operation <> 'contract_test'
     OR generation.status NOT IN ('materializing', 'succeeded')
     OR generation.script_id IS DISTINCT FROM NEW.script_id
     OR generation.target_version_id IS DISTINCT FROM NEW.candidate_version_id
     OR generation.contract_id IS DISTINCT FROM NEW.contract_id
     OR generation.contract_revision IS DISTINCT FROM NEW.contract_revision
     OR generation.expected_script_revision IS DISTINCT FROM NEW.script_revision THEN
    RAISE EXCEPTION 'contract test result does not match its generation run'
      USING ERRCODE = '23514';
  END IF;

  SELECT script_id, status INTO version_script_id, version_status
  FROM ky_matrix_account_login_script_version
  WHERE id = NEW.candidate_version_id
  FOR KEY SHARE;

  IF NOT FOUND OR version_script_id <> NEW.script_id OR version_status <> 'candidate' THEN
    RAISE EXCEPTION 'contract test target is not a matching candidate'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TABLE IF NOT EXISTS ky_matrix_account_outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL
    CHECK (aggregate_type IN ('script_generation_run', 'script_context_snapshot', 'login_script_contract')),
  aggregate_id text NOT NULL CHECK (btrim(aggregate_id) <> ''),
  event_type text NOT NULL CHECK (btrim(event_type) <> '' AND char_length(event_type) <= 120),
  dedupe_key text NOT NULL UNIQUE CHECK (btrim(dedupe_key) <> '' AND char_length(dedupe_key) <= 256),
  safe_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_payload_json) = 'object' AND ky_matrix_account_safe_metadata(safe_payload_json)),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatching', 'published', 'failed', 'cancelled')),
  dispatch_attempt integer NOT NULL DEFAULT 0 CHECK (dispatch_attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_failure_code text NOT NULL DEFAULT '' CHECK (last_failure_code ~ '^[a-z0-9_]{0,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ky_matrix_account_outbox_lease_check CHECK (
    (status = 'dispatching' AND lease_expires_at IS NOT NULL)
    OR (status <> 'dispatching' AND lease_expires_at IS NULL)
  ),
  CONSTRAINT ky_matrix_account_outbox_published_check CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ky_matrix_account_outbox_pending_idx
  ON ky_matrix_account_outbox(status, available_at, lease_expires_at, created_at)
  WHERE status IN ('pending', 'dispatching');

DO $matrix_generation_immutable_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_generation_run_event'::regclass
      AND tgname = 'ky_matrix_account_generation_event_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_generation_event_immutable_trg
      BEFORE UPDATE OR DELETE
      ON ky_matrix_account_login_script_generation_run_event
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_reject_immutable_row_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_contract_test_result'::regclass
      AND tgname = 'ky_matrix_account_contract_test_result_validate_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_contract_test_result_validate_trg
      BEFORE INSERT
      ON ky_matrix_account_login_script_contract_test_result
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_validate_contract_test_result();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_contract_test_result'::regclass
      AND tgname = 'ky_matrix_account_contract_test_result_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_contract_test_result_immutable_trg
      BEFORE UPDATE OR DELETE
      ON ky_matrix_account_login_script_contract_test_result
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_reject_immutable_row_mutation();
  END IF;
END
$matrix_generation_immutable_triggers$;

ALTER TABLE ky_matrix_account_login_script_version
  ADD COLUMN IF NOT EXISTS generation_run_id text;

CREATE OR REPLACE FUNCTION ky_matrix_account_reject_login_script_generation_run_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.generation_run_id IS DISTINCT FROM OLD.generation_run_id THEN
    RAISE EXCEPTION 'login script version generation run binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DO $matrix_version_generation_run_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_generation_run_fk'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_generation_run_fk
      FOREIGN KEY (generation_run_id)
      REFERENCES ky_matrix_account_login_script_generation_run(id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ky_matrix_account_login_script_version'::regclass
      AND conname = 'ky_matrix_account_login_script_version_generation_run_check'
  ) THEN
    ALTER TABLE ky_matrix_account_login_script_version
      ADD CONSTRAINT ky_matrix_account_login_script_version_generation_run_check
      CHECK (
        generation_run_id IS NULL
        OR (source = 'ai_generated' AND generation_engine = 'codex_executor')
      ) NOT VALID;
  END IF;
END
$matrix_version_generation_run_constraints$;

DO $matrix_version_generation_run_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_matrix_account_login_script_version'::regclass
      AND tgname = 'ky_matrix_account_login_script_version_generation_run_guard_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_matrix_account_login_script_version_generation_run_guard_trg
      BEFORE UPDATE OF generation_run_id
      ON ky_matrix_account_login_script_version
      FOR EACH ROW
      EXECUTE FUNCTION ky_matrix_account_reject_login_script_generation_run_rewrite();
  END IF;
END
$matrix_version_generation_run_guard$;

CREATE UNIQUE INDEX IF NOT EXISTS ky_matrix_account_login_script_version_generation_run_uidx
  ON ky_matrix_account_login_script_version(generation_run_id)
  WHERE generation_run_id IS NOT NULL;
