-- High-risk access assurance truth source.
--
-- authenticated_at is the successful primary-authentication instant for this
-- concrete session. mfa_verified_at is intentionally nullable until an MFA
-- step-up write path exists; enabling MFA therefore fails closed.

ALTER TABLE ky_user_session
  ADD COLUMN IF NOT EXISTS authenticated_at timestamptz,
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

UPDATE ky_user_session
SET authenticated_at = created_at
WHERE authenticated_at IS NULL;

ALTER TABLE ky_user_session
  ALTER COLUMN authenticated_at SET DEFAULT now(),
  ALTER COLUMN authenticated_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS ky_user_session_authentication_time_check,
  DROP CONSTRAINT IF EXISTS ky_user_session_mfa_time_check;

ALTER TABLE ky_user_session
  ADD CONSTRAINT ky_user_session_authentication_time_check
    CHECK (authenticated_at <= created_at),
  ADD CONSTRAINT ky_user_session_mfa_time_check
    CHECK (
      mfa_verified_at IS NULL OR
      (mfa_verified_at >= authenticated_at AND mfa_verified_at <= expires_at)
    );

CREATE INDEX IF NOT EXISTS ky_user_session_assurance_idx
  ON ky_user_session(id, user_id, status, expires_at, authenticated_at, mfa_verified_at);

CREATE OR REPLACE FUNCTION ky_user_session_reject_authenticated_at_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at THEN
    RAISE EXCEPTION 'ky_user_session.authenticated_at is immutable';
  END IF;
  RETURN NEW;
END
$function$;

DO $authenticated_at_immutable$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='ky_user_session'::regclass
      AND tgname='ky_user_session_authenticated_at_immutable_trg'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ky_user_session_authenticated_at_immutable_trg
      BEFORE UPDATE OF authenticated_at ON ky_user_session
      FOR EACH ROW EXECUTE FUNCTION ky_user_session_reject_authenticated_at_change();
  END IF;
END
$authenticated_at_immutable$;

-- Existing installations did not have an MFA switch. Absence means disabled,
-- and this migration makes that default explicit without overriding a prior
-- true/false operator choice.
UPDATE ky_system_setting
SET setting_value = jsonb_set(setting_value, '{mfaEnabled}', 'false'::jsonb, true),
    updated_at = now()
WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security'
  AND NOT (setting_value ? 'mfaEnabled');

ALTER TABLE ky_system_setting
  DROP CONSTRAINT IF EXISTS ky_system_setting_platform_mfa_type_check;

ALTER TABLE ky_system_setting
  ADD CONSTRAINT ky_system_setting_platform_mfa_type_check
    CHECK (
      scope_type <> 'platform' OR scope_id <> 'platform_root' OR setting_key <> 'security' OR
      NOT (setting_value ? 'mfaEnabled') OR
      jsonb_typeof(setting_value->'mfaEnabled') = 'boolean'
    );
