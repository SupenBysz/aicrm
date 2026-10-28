\set ON_ERROR_STOP on
\getenv migrator_password MIGRATOR_PASSWORD
\getenv runtime_password RUNTIME_PASSWORD
SELECT format('CREATE ROLE kycrm_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kycrm_migrator') \gexec
SELECT format('CREATE ROLE kycrm_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kycrm_runtime') \gexec
SELECT 'CREATE DATABASE kycrm OWNER kycrm_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='kycrm') \gexec
REVOKE ALL ON DATABASE kycrm FROM PUBLIC;
GRANT CONNECT ON DATABASE kycrm TO kycrm_runtime;
\connect kycrm
ALTER SCHEMA public OWNER TO kycrm_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kycrm_runtime;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
