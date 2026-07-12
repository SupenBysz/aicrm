-- Agent Executor v9.1 P2A: authorization, runtime, model and device contracts.
--
-- This migration only adds durable control-plane resources.  It does not
-- route public traffic to the new service and it does not make any executor
-- eligible for script maintenance.  Runtime secrets, authorization URLs,
-- device codes, credentials, filesystem paths and raw App Server output have
-- no columns in this schema.

ALTER TABLE ky_ai_executor_config
  ADD COLUMN IF NOT EXISTS catalog_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS readiness_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credential_revision_counter bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS runtime_binding_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS runtime_binding_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worker_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS queue_enabled boolean NOT NULL DEFAULT false;

UPDATE ky_ai_executor_config
SET max_concurrency = 1
WHERE max_concurrency <> 1;

ALTER TABLE ky_ai_executor_config
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_max_concurrency_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_default_model_key_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_catalog_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_readiness_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_credential_revision_counter_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_runtime_binding_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_config_current_binding_shape_check;

ALTER TABLE ky_ai_executor_config
  ADD CONSTRAINT ky_ai_executor_config_max_concurrency_check
    CHECK (max_concurrency = 1),
  ADD CONSTRAINT ky_ai_executor_config_default_model_key_check
    CHECK (default_model_key IS NULL OR (btrim(default_model_key) <> '' AND char_length(default_model_key) <= 160)),
  ADD CONSTRAINT ky_ai_executor_config_catalog_revision_check
    CHECK (catalog_revision >= 0),
  ADD CONSTRAINT ky_ai_executor_config_readiness_revision_check
    CHECK (readiness_revision >= 0),
  ADD CONSTRAINT ky_ai_executor_config_credential_revision_counter_check
    CHECK (credential_revision_counter >= 0),
  ADD CONSTRAINT ky_ai_executor_config_runtime_binding_revision_check
    CHECK (runtime_binding_revision >= 0),
  ADD CONSTRAINT ky_ai_executor_config_current_binding_shape_check
    CHECK (
      (current_credential_revision IS NULL AND runtime_binding_id = '' AND runtime_binding_revision = 0)
      OR
      (current_credential_revision IS NOT NULL AND runtime_binding_id <> '' AND runtime_binding_revision > 0)
    ) NOT VALID;

CREATE OR REPLACE FUNCTION ky_ai_executor_safe_metadata_at(payload jsonb, depth integer)
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
        normalized_key := regexp_replace(lower(item.key), '[^a-z0-9]', '', 'g');
        IF normalized_key ~ '(apikey|authorization|authurl|verificationurl|usercode|loginid|challenge|cookie|storage|indexeddb|token|password|passwd|credentialpath|secret|codexhome|filepath|filesystempath|rawoutput|rawjson|rawtext|stdout|stderr|prompt)'
           OR NOT ky_ai_executor_safe_metadata_at(item.value, depth + 1) THEN
          RETURN false;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      IF jsonb_array_length(payload) > 256 THEN
        RETURN false;
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(payload)
      LOOP
        IF NOT ky_ai_executor_safe_metadata_at(item.value, depth + 1) THEN
          RETURN false;
        END IF;
      END LOOP;
    WHEN 'string' THEN
      text_value := payload #>> '{}';
      IF char_length(text_value) > 4096
         OR text_value ~* '^data:'
         OR text_value ~* '-----BEGIN[[:space:]][A-Z0-9 ]+-----'
         OR text_value ~* '(^|[[:space:]"''])((/etc/|/root/|/home/|/data/)|[a-z]:[\\/])'
         OR text_value ~* '(^|[^a-z0-9])(access[_-]?token|refresh[_-]?token|sessionid|cookie)[[:space:]]*[:=]' THEN
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

CREATE OR REPLACE FUNCTION ky_ai_executor_safe_metadata(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT ky_ai_executor_safe_metadata_at(payload, 0);
$function$;

CREATE OR REPLACE FUNCTION ky_ai_executor_account_summary_is_safe(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT jsonb_typeof(payload) = 'object'
     AND payload - ARRAY['planType', 'emailDomainHash', 'accountFingerprint'] = '{}'::jsonb
     AND (NOT (payload ? 'planType') OR (
       jsonb_typeof(payload->'planType') = 'string'
       AND payload->>'planType' IN (
         'free', 'go', 'plus', 'pro', 'prolite', 'team',
         'self_serve_business_usage_based', 'business',
         'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown'
       )
     ))
     AND (NOT (payload ? 'emailDomainHash') OR (
       jsonb_typeof(payload->'emailDomainHash') = 'string'
       AND payload->>'emailDomainHash' ~ '^[0-9a-f]{64}$'
     ))
     AND (NOT (payload ? 'accountFingerprint') OR (
       jsonb_typeof(payload->'accountFingerprint') = 'string'
       AND payload->>'accountFingerprint' ~ '^[0-9a-f]{64}$'
     ));
$function$;

CREATE OR REPLACE FUNCTION ky_ai_executor_modalities_are_safe(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  modality text;
BEGIN
  IF jsonb_typeof(payload) <> 'array'
     OR jsonb_array_length(payload) < 1
     OR jsonb_array_length(payload) > 8 THEN
    RETURN false;
  END IF;
  FOR modality IN SELECT value FROM jsonb_array_elements_text(payload)
  LOOP
    IF modality NOT IN ('text', 'image') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION ky_ai_executor_reasoning_efforts_are_safe(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $function$
DECLARE
  effort text;
BEGIN
  IF jsonb_typeof(payload) <> 'array' OR jsonb_array_length(payload) > 32 THEN
    RETURN false;
  END IF;
  FOR effort IN SELECT value FROM jsonb_array_elements_text(payload)
  LOOP
    IF effort NOT IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh') THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION ky_ai_executor_reject_immutable_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable Agent Executor row cannot be modified: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;

ALTER TABLE ky_ai_executor_authorization_session
  ADD COLUMN IF NOT EXISTS login_id_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_owner_instance_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS prepared_credential_revision bigint,
  ADD COLUMN IF NOT EXISTS operation_id text NOT NULL DEFAULT '';

ALTER TABLE ky_ai_executor_authorization_session
  DROP CONSTRAINT IF EXISTS ky_ai_executor_authorization_session_flow_runtime_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_authorization_session_login_id_hash_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_authorization_session_account_summary_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_authorization_session_prepared_revision_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_authorization_session_terminal_check;

ALTER TABLE ky_ai_executor_authorization_session
  ADD CONSTRAINT ky_ai_executor_authorization_session_flow_runtime_check
    CHECK (
      (runtime_type = 'desktop' AND flow_type = 'browser')
      OR (runtime_type = 'server' AND flow_type = 'device_code')
    ),
  ADD CONSTRAINT ky_ai_executor_authorization_session_login_id_hash_check
    CHECK (login_id_hash = '' OR login_id_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ky_ai_executor_authorization_session_account_summary_check
    CHECK (ky_ai_executor_account_summary_is_safe(account_summary_json)),
  ADD CONSTRAINT ky_ai_executor_authorization_session_prepared_revision_check
    CHECK (prepared_credential_revision IS NULL OR prepared_credential_revision > 0),
  ADD CONSTRAINT ky_ai_executor_authorization_session_terminal_check
    CHECK (
      (status IN ('succeeded', 'failed', 'cancelled', 'expired', 'interrupted', 'superseded') AND finished_at IS NOT NULL)
      OR
      (status IN ('starting', 'waiting_user', 'verifying') AND finished_at IS NULL)
    ) NOT VALID;

ALTER TABLE ky_ai_executor_authorization_session_event
  DROP CONSTRAINT IF EXISTS ky_ai_executor_authorization_session_event_safe_payload_check;

ALTER TABLE ky_ai_executor_authorization_session_event
  ADD CONSTRAINT ky_ai_executor_authorization_session_event_safe_payload_check
    CHECK (ky_ai_executor_safe_metadata(safe_payload_json));

ALTER TABLE ky_ai_executor_task
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_result_safe_metadata_check;

ALTER TABLE ky_ai_executor_task
  ADD CONSTRAINT ky_ai_executor_task_result_safe_metadata_check
    CHECK (ky_ai_executor_safe_metadata(result_safe_json)) NOT VALID;

ALTER TABLE ky_ai_executor_task_event
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_event_safe_metadata_check;

ALTER TABLE ky_ai_executor_task_event
  ADD CONSTRAINT ky_ai_executor_task_event_safe_metadata_check
    CHECK (ky_ai_executor_safe_metadata(safe_payload_json)) NOT VALID;

ALTER TABLE ky_ai_executor_task_outbox
  DROP CONSTRAINT IF EXISTS ky_ai_executor_task_outbox_safe_metadata_check;

ALTER TABLE ky_ai_executor_task_outbox
  ADD CONSTRAINT ky_ai_executor_task_outbox_safe_metadata_check
    CHECK (ky_ai_executor_safe_metadata(safe_reference_json)) NOT VALID;

ALTER TABLE ky_ai_executor_control_outbox
  DROP CONSTRAINT IF EXISTS ky_ai_executor_control_outbox_safe_metadata_check;

ALTER TABLE ky_ai_executor_control_outbox
  ADD CONSTRAINT ky_ai_executor_control_outbox_safe_metadata_check
    CHECK (ky_ai_executor_safe_metadata(safe_reference_json)) NOT VALID;

ALTER TABLE ky_ai_executor_model_catalog
  ADD COLUMN IF NOT EXISTS catalog_item_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS input_modalities_json jsonb NOT NULL DEFAULT '["text"]'::jsonb,
  ADD COLUMN IF NOT EXISTS supported_reasoning_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS upgrade_model_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS codex_version text NOT NULL DEFAULT '';

ALTER TABLE ky_ai_executor_model_catalog
  DROP CONSTRAINT IF EXISTS ky_ai_executor_model_catalog_metadata_safe_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_model_catalog_input_modalities_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_model_catalog_reasoning_check,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_model_catalog_upgrade_key_check;

ALTER TABLE ky_ai_executor_model_catalog
  ADD CONSTRAINT ky_ai_executor_model_catalog_metadata_safe_check
    CHECK (ky_ai_executor_safe_metadata(metadata_json)),
  ADD CONSTRAINT ky_ai_executor_model_catalog_input_modalities_check
    CHECK (ky_ai_executor_modalities_are_safe(input_modalities_json)),
  ADD CONSTRAINT ky_ai_executor_model_catalog_reasoning_check
    CHECK (ky_ai_executor_reasoning_efforts_are_safe(supported_reasoning_json)),
  ADD CONSTRAINT ky_ai_executor_model_catalog_upgrade_key_check
    CHECK (upgrade_model_key = '' OR (btrim(upgrade_model_key) <> '' AND char_length(upgrade_model_key) <= 160));

CREATE TABLE IF NOT EXISTS ky_ai_executor_runtime_worker (
  executor_id text PRIMARY KEY REFERENCES ky_ai_executor_config(id) ON DELETE CASCADE,
  runtime_binding_id text NOT NULL CHECK (btrim(runtime_binding_id) <> ''),
  runtime_binding_revision bigint NOT NULL CHECK (runtime_binding_revision > 0),
  owner_instance_id text NOT NULL CHECK (btrim(owner_instance_id) <> ''),
  codex_version text NOT NULL CHECK (btrim(codex_version) <> ''),
  queue_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'draining', 'offline', 'fenced')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  heartbeat_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_runtime_worker_heartbeat_idx
  ON ky_ai_executor_runtime_worker(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS ky_ai_executor_desktop_handoff (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ky_ai_executor_authorization_session(id) ON DELETE RESTRICT,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  device_id text NOT NULL REFERENCES ky_ai_executor_device(id) ON DELETE RESTRICT,
  requested_by text NOT NULL CHECK (btrim(requested_by) <> ''),
  expected_session_revision bigint NOT NULL CHECK (expected_session_revision > 0),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ticket_hash text NOT NULL CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  ticket_nonce_hash text NOT NULL CHECK (ticket_nonce_hash ~ '^[0-9a-f]{64}$'),
  token_key_id text NOT NULL CHECK (btrim(token_key_id) <> ''),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'proof_submitted', 'expired', 'cancelled')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_token_hash text NOT NULL DEFAULT '' CHECK (claim_token_hash = '' OR claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_expires_at timestamptz,
  claim_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by, session_id, device_id, idempotency_key_hash),
  CHECK (expires_at = issued_at + interval '120 seconds'),
  CHECK (
    (status IN ('claimed', 'proof_submitted') AND claimed_at IS NOT NULL)
    OR status IN ('pending', 'expired', 'cancelled')
  ),
  CHECK ((claim_token_hash = '') = (claim_expires_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_desktop_handoff_active_uidx
  ON ky_ai_executor_desktop_handoff(session_id)
  WHERE status IN ('pending', 'claimed', 'proof_submitted');

CREATE TABLE IF NOT EXISTS ky_ai_executor_desktop_authorization_proof (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ky_ai_executor_authorization_session(id) ON DELETE RESTRICT,
  handoff_id text NOT NULL UNIQUE REFERENCES ky_ai_executor_desktop_handoff(id) ON DELETE RESTRICT,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  device_id text NOT NULL REFERENCES ky_ai_executor_device(id) ON DELETE RESTRICT,
  session_revision bigint NOT NULL CHECK (session_revision > 0),
  login_id_hash text NOT NULL CHECK (login_id_hash ~ '^[0-9a-f]{64}$'),
  result text NOT NULL CHECK (result IN ('succeeded', 'failed', 'cancelled')),
  account_fingerprint text NOT NULL DEFAULT '' CHECK (
    account_fingerprint = '' OR account_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  candidate_binding_digest text NOT NULL DEFAULT '' CHECK (
    candidate_binding_digest = '' OR candidate_binding_digest ~ '^[0-9a-f]{64}$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (result = 'succeeded' AND account_fingerprint <> '' AND candidate_binding_digest <> '')
    OR (result <> 'succeeded' AND account_fingerprint = '' AND candidate_binding_digest = '')
  )
);

CREATE TABLE IF NOT EXISTS ky_ai_executor_credential_activation (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ky_ai_executor_authorization_session(id) ON DELETE RESTRICT,
  proof_id text NOT NULL UNIQUE REFERENCES ky_ai_executor_desktop_authorization_proof(id) ON DELETE RESTRICT,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  device_id text NOT NULL REFERENCES ky_ai_executor_device(id) ON DELETE RESTRICT,
  operation_id text NOT NULL UNIQUE,
  credential_revision bigint NOT NULL CHECK (credential_revision > 0),
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  source_credential_revision bigint NOT NULL CHECK (source_credential_revision >= 0),
  revocation_epoch bigint NOT NULL CHECK (revocation_epoch >= 0),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  activation_token_hash text NOT NULL UNIQUE CHECK (activation_token_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ack_request_hash text NOT NULL DEFAULT '' CHECK (ack_request_hash = '' OR ack_request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'expired', 'quarantined', 'fenced')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  durable_barrier_completed_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at = issued_at + interval '10 minutes'),
  CHECK ((status = 'active') = (activated_at IS NOT NULL)),
  CHECK (status <> 'active' OR (
    ack_request_hash <> '' AND durable_barrier_completed_at IS NOT NULL
  ))
);

CREATE TABLE IF NOT EXISTS ky_ai_executor_desktop_command_operation (
  id text PRIMARY KEY,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  session_id text REFERENCES ky_ai_executor_authorization_session(id) ON DELETE RESTRICT,
  device_id text NOT NULL DEFAULT '',
  requested_by text NOT NULL DEFAULT '',
  purpose text NOT NULL CHECK (purpose IN (
    'authorization_cancel', 'authorization_reopen', 'credential_verify',
    'model_catalog_refresh', 'readiness_check', 'credential_logout'
  )),
  expected_executor_revision bigint,
  expected_session_revision bigint,
  expected_credential_revision bigint,
  expected_catalog_revision bigint,
  revocation_id text NOT NULL DEFAULT '',
  revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  command_ticket_hash text NOT NULL UNIQUE CHECK (command_ticket_hash ~ '^[0-9a-f]{64}$'),
  token_key_id text NOT NULL CHECK (btrim(token_key_id) <> ''),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'stale_target', 'expired')),
  failure_code text NOT NULL DEFAULT '' CHECK (failure_code ~ '^[a-z0-9_]{0,64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by, executor_id, purpose, idempotency_key_hash),
  CHECK (expires_at = issued_at + interval '120 seconds'),
  CHECK (
    (status = 'pending' AND completed_at IS NULL AND failure_code = '')
    OR (status IN ('succeeded', 'stale_target') AND completed_at IS NOT NULL AND failure_code = '')
    OR (status IN ('failed', 'expired') AND completed_at IS NOT NULL AND failure_code <> '')
  )
);

CREATE INDEX IF NOT EXISTS ky_ai_executor_desktop_command_pending_idx
  ON ky_ai_executor_desktop_command_operation(device_id, status, expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ky_ai_executor_credential_revocation (
  id text PRIMARY KEY,
  executor_id text NOT NULL REFERENCES ky_ai_executor_config(id) ON DELETE RESTRICT,
  device_id text NOT NULL DEFAULT '',
  credential_revision bigint NOT NULL CHECK (credential_revision > 0),
  revocation_epoch bigint NOT NULL CHECK (revocation_epoch > 0),
  operation_id text NOT NULL UNIQUE,
  requested_by text NOT NULL CHECK (btrim(requested_by) <> ''),
  force boolean NOT NULL DEFAULT false,
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  command_ticket_hash text NOT NULL DEFAULT '' CHECK (
    command_ticket_hash = '' OR command_ticket_hash ~ '^[0-9a-f]{64}$'
  ),
  status text NOT NULL CHECK (status IN ('awaiting_device', 'completed', 'failed', 'stale_target')),
  failure_code text NOT NULL DEFAULT '' CHECK (failure_code ~ '^[a-z0-9_]{0,64}$'),
  quarantine_digest text NOT NULL DEFAULT '' CHECK (
    quarantine_digest = '' OR quarantine_digest ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (requested_by, executor_id, credential_revision, force, idempotency_key_hash),
  CHECK (
    (status = 'awaiting_device' AND device_id <> '' AND command_ticket_hash <> '' AND completed_at IS NULL)
    OR (status IN ('completed', 'stale_target') AND completed_at IS NOT NULL AND failure_code = '')
    OR (status = 'failed' AND completed_at IS NOT NULL AND failure_code <> '')
  )
);

ALTER TABLE ky_ai_executor_device_registration_challenge
  ADD COLUMN IF NOT EXISTS idempotency_key_hash text,
  ADD COLUMN IF NOT EXISTS device_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS app_version text NOT NULL DEFAULT '';

UPDATE ky_ai_executor_device_registration_challenge
SET idempotency_key_hash = repeat(md5('legacy-registration:' || id), 2)
WHERE idempotency_key_hash IS NULL OR idempotency_key_hash = repeat('0', 64);

ALTER TABLE ky_ai_executor_device_registration_challenge
  ALTER COLUMN idempotency_key_hash SET NOT NULL,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_registration_idempotency_hash_check;

ALTER TABLE ky_ai_executor_device_registration_challenge
  ADD CONSTRAINT ky_ai_executor_registration_idempotency_hash_check
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_registration_idempotency_uidx
  ON ky_ai_executor_device_registration_challenge(actor_id, public_key_digest, idempotency_key_hash);

ALTER TABLE ky_ai_executor_operation_confirmation
  ADD COLUMN IF NOT EXISTS idempotency_key_hash text;

UPDATE ky_ai_executor_operation_confirmation
SET idempotency_key_hash = repeat(md5('legacy-confirmation:' || id), 2)
WHERE idempotency_key_hash IS NULL OR idempotency_key_hash = repeat('0', 64);

ALTER TABLE ky_ai_executor_operation_confirmation
  ALTER COLUMN idempotency_key_hash SET NOT NULL,
  DROP CONSTRAINT IF EXISTS ky_ai_executor_confirmation_idempotency_hash_check;

ALTER TABLE ky_ai_executor_operation_confirmation
  ADD CONSTRAINT ky_ai_executor_confirmation_idempotency_hash_check
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS ky_ai_executor_confirmation_idempotency_uidx
  ON ky_ai_executor_operation_confirmation(actor_id, executor_id, action, idempotency_key_hash);

DO $immutable_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_authorization_session_event'::regclass
      AND tgname = 'ky_ai_executor_authorization_session_event_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_authorization_session_event_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_authorization_session_event
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_device_request_ledger'::regclass
      AND tgname = 'ky_ai_executor_device_request_ledger_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_device_request_ledger_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_device_request_ledger
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_desktop_authorization_proof'::regclass
      AND tgname = 'ky_ai_executor_desktop_authorization_proof_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_desktop_authorization_proof_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_desktop_authorization_proof
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ky_ai_executor_model_catalog'::regclass
      AND tgname = 'ky_ai_executor_model_catalog_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_ai_executor_model_catalog_immutable_trg
      BEFORE UPDATE OR DELETE ON ky_ai_executor_model_catalog
      FOR EACH ROW EXECUTE FUNCTION ky_ai_executor_reject_immutable_row_mutation();
  END IF;
END
$immutable_triggers$;

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
  ('perm_platform_ai_executors_change_account', 'platform.ai_executors.change_account', 'AI 执行器更换账号', 'action', 'ai_executors', 'change_account', '["platform"]'::jsonb, 'Change the authorized Codex account', 'normal'),
  ('perm_platform_ai_executors_force_revoke', 'platform.ai_executors.force_revoke', 'AI 执行器强制注销', 'action', 'ai_executors', 'force_revoke', '["platform"]'::jsonb, 'Force revoke an executor credential', 'normal'),
  ('perm_platform_ai_executors_bind_device', 'platform.ai_executors.bind_device', 'AI 执行器绑定客户端', 'action', 'ai_executors', 'bind_device', '["platform"]'::jsonb, 'Bind a trusted Desktop device', 'normal'),
  ('perm_platform_ai_executors_rebind_device', 'platform.ai_executors.rebind_device', 'AI 执行器重新绑定客户端', 'action', 'ai_executors', 'rebind_device', '["platform"]'::jsonb, 'Rebind or unbind a trusted Desktop device', 'normal')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_owner_' || replace(permission.code, '.', '_'), 'role_platform_owner', permission.id
FROM ky_permission permission
WHERE permission.code IN (
  'platform.ai_executors.change_account',
  'platform.ai_executors.force_revoke',
  'platform.ai_executors.bind_device',
  'platform.ai_executors.rebind_device'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_admin_' || replace(permission.code, '.', '_'), 'role_platform_admin', permission.id
FROM ky_permission permission
WHERE permission.code IN (
  'platform.ai_executors.change_account',
  'platform.ai_executors.bind_device'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_platform_operator_' || replace(permission.code, '.', '_'), 'role_platform_operator', permission.id
FROM ky_permission permission
WHERE permission.code IN (
  'platform.ai_executors.view',
  'platform.ai_executor_tasks.view'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
