-- Least-privilege read role for the internal membership access-decision path.
-- A deployment may grant its dedicated LOGIN role membership here; no login
-- credential or production role switch is performed by this manifest.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ky_membership_access_reader') THEN
    CREATE ROLE ky_membership_access_reader NOLOGIN;
  END IF;
END
$roles$;

ALTER ROLE ky_membership_access_reader
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO ky_membership_access_reader;

GRANT SELECT ON TABLE
  ky_user_session,
  ky_membership,
  ky_membership_role,
  ky_role,
  ky_role_permission,
  ky_permission,
  ky_role_data_scope,
  ky_system_setting
TO ky_membership_access_reader;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  ky_user_session,
  ky_membership,
  ky_membership_role,
  ky_role,
  ky_role_permission,
  ky_permission,
  ky_role_data_scope,
  ky_system_setting
FROM ky_membership_access_reader;
