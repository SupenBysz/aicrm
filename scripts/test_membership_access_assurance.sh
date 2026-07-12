#!/usr/bin/env bash
# Destructive high-risk access-assurance contract test against disposable PostgreSQL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_MEMBERSHIP_ASSURANCE_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
ASSURANCE_GO_ROOT="/tmp/aicrm_membership_assurance_go_${RUN_ID}"
ASSURANCE_GOWORK="$ASSURANCE_GO_ROOT/scripts/testdata/membership-access-assurance/go.work"
TEST_DB="aicrm_access_assurance_${RUN_ID}"
BAD_DB="aicrm_access_assurance_bad_${RUN_ID}"
READER_LOGIN="ky_access_reader_test_${RUN_ID}"
FIXTURE_LOGIN="ky_access_fixture_test_${RUN_ID}"
READER_PASSWORD="AccessReader${RUN_ID}Only"
FIXTURE_PASSWORD="AccessFixture${RUN_ID}Only"

PSQL=(psql)
if [[ "$(id -un)" != "postgres" ]]; then
  PSQL=(sudo -u postgres psql)
fi

cleanup() {
  rm -rf "$ASSURANCE_GO_ROOT"
  for database in "$TEST_DB" "$BAD_DB"; do
    "${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$database" >/dev/null <<'SQL' || true
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname=:'db_name' AND pid<>pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
  done
  "${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 \
    -v reader_role="$READER_LOGIN" -v fixture_role="$FIXTURE_LOGIN" >/dev/null <<'SQL' || true
SELECT format('DROP ROLE IF EXISTS %I', :'reader_role') \gexec
SELECT format('DROP ROLE IF EXISTS %I', :'fixture_role') \gexec
SQL
}
trap cleanup EXIT

"${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 \
  -v test_db="$TEST_DB" -v bad_db="$BAD_DB" >/dev/null <<'SQL'
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'test_db') \gexec
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'bad_db') \gexec
SQL

for migration in "$ROOT_DIR"/ops/db/[0-9][0-9][0-9]_*.sql; do
  version="$(basename "$migration" | cut -c1-3)"
  if ((10#$version >= 44)); then
    continue
  fi
  "${PSQL[@]}" -X -d "$BAD_DB" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done
"${PSQL[@]}" -X -d "$BAD_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
UPDATE ky_system_setting
SET setting_value=jsonb_set(setting_value,'{mfaEnabled}','"invalid"'::jsonb,true)
WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security';
SQL
if "${PSQL[@]}" -X -d "$BAD_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/044_access_assurance.sql" >/dev/null 2>&1; then
  echo 'FAIL: migration 044 accepted a non-boolean pre-existing mfaEnabled value' >&2
  exit 1
fi

if [[ "$(id -un)" == "postgres" ]]; then
  KY_TENANT_DATABASE_URL="$TEST_DB" KY_EXECUTE_DATABASE_DEPLOY=1 \
    "$ROOT_DIR/scripts/deploy_database.sh" >/dev/null
else
  sudo -u postgres env KY_TENANT_DATABASE_URL="$TEST_DB" KY_EXECUTE_DATABASE_DEPLOY=1 \
    "$ROOT_DIR/scripts/deploy_database.sh" >/dev/null
fi
for _ in 1 2; do
  "${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/ops/db/044_access_assurance.sql" >/dev/null
done
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_membership_access_assurance_roles.sql" >/dev/null

"${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 \
  -v reader_role="$READER_LOGIN" -v reader_password="$READER_PASSWORD" \
  -v fixture_role="$FIXTURE_LOGIN" -v fixture_password="$FIXTURE_PASSWORD" >/dev/null <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ky_membership_access_reader',
  :'reader_role', :'reader_password'
) \gexec
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'fixture_role', :'fixture_password'
) \gexec
SQL
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 -v fixture_role="$FIXTURE_LOGIN" >/dev/null <<'SQL'
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'fixture_role') \gexec
SELECT format(
  'GRANT SELECT ON ky_user_session,ky_membership,ky_membership_role,ky_role,ky_role_permission,ky_permission,ky_role_data_scope,ky_system_setting TO %I',
  :'fixture_role'
) \gexec
SELECT format('GRANT INSERT,UPDATE ON ky_user_session TO %I', :'fixture_role') \gexec
SELECT format('GRANT UPDATE ON ky_system_setting TO %I', :'fixture_role') \gexec
SQL

"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO ky_user (id,display_name,status) VALUES
  ('user_assurance_owner','Assurance Owner','normal'),
  ('user_assurance_admin','Assurance Admin','normal'),
  ('user_assurance_cross','Assurance Cross Workspace','normal'),
  ('user_assurance_nonsystem','Assurance Non-system Owner','normal');

INSERT INTO ky_membership (id,user_id,workspace_type,workspace_id,display_name,status,joined_at) VALUES
  ('mem_assurance_owner','user_assurance_owner','platform','platform_root','Assurance Owner','active',now()),
  ('mem_assurance_admin','user_assurance_admin','platform','platform_root','Assurance Admin','active',now()),
  ('mem_assurance_cross','user_assurance_cross','agency','agency_assurance_target','Cross Workspace','active',now()),
  ('mem_assurance_nonsystem','user_assurance_nonsystem','agency','agency_assurance_target','Non-system Owner','active',now());

INSERT INTO ky_role (
  id,workspace_type,workspace_id,name,code,description,is_system,status
) VALUES (
  'role_assurance_fake_owner','agency','agency_assurance_target','Forged Owner','agency_owner',
  'Non-system same-name role must never satisfy owner assurance',false,'normal'
);

INSERT INTO ky_membership_role (id,membership_id,role_id,workspace_type,workspace_id) VALUES
  ('mr_assurance_owner','mem_assurance_owner','role_platform_owner','platform','platform_root'),
  ('mr_assurance_admin','mem_assurance_admin','role_platform_admin','platform','platform_root'),
  ('mr_assurance_cross','mem_assurance_cross','role_agency_owner_template','agency','agency_assurance_other'),
  ('mr_assurance_nonsystem','mem_assurance_nonsystem','role_assurance_fake_owner','agency','agency_assurance_target');

INSERT INTO ky_user_session (
  id,user_id,token_id,status,expires_at,created_at,updated_at,authenticated_at,mfa_verified_at
) VALUES
  ('session_assurance_owner_fresh','user_assurance_owner','token_assurance_owner_fresh','active',now()+interval '1 hour',now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute',NULL),
  ('session_assurance_owner_old','user_assurance_owner','token_assurance_owner_old','active',now()+interval '1 hour',now()-interval '601 seconds',now()-interval '601 seconds',now()-interval '601 seconds',NULL),
  ('session_assurance_owner_future','user_assurance_owner','token_assurance_owner_future','active',now()+interval '1 hour',now()+interval '1 minute',now()+interval '1 minute',now()+interval '1 minute',NULL),
  ('session_assurance_admin_fresh','user_assurance_admin','token_assurance_admin_fresh','active',now()+interval '1 hour',now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute',NULL),
  ('session_assurance_cross_fresh','user_assurance_cross','token_assurance_cross_fresh','active',now()+interval '1 hour',now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute',NULL),
  ('session_assurance_nonsystem_fresh','user_assurance_nonsystem','token_assurance_nonsystem_fresh','active',now()+interval '1 hour',now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute',NULL),
  ('session_assurance_owner_mfa','user_assurance_owner','token_assurance_owner_mfa','active',now()+interval '1 hour',now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute',now()-interval '30 seconds'),
  ('session_assurance_owner_mfa_future','user_assurance_owner','token_assurance_owner_mfa_future','active',now()+interval '1 hour',now()-interval '1 minute',now()-interval '1 minute',now()-interval '1 minute',now()+interval '1 minute');
SQL

assert_scalar() {
  local sql="$1" expected="$2" description="$3" actual
  actual="$("${PSQL[@]}" -X -d "$TEST_DB" -Atqc "$sql")"
  [[ "$actual" == "$expected" ]] || {
    echo "FAIL: $description (expected=$expected actual=$actual)" >&2
    exit 1
  }
}

assert_scalar "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ky_user_session' AND column_name IN ('authenticated_at','mfa_verified_at')" "2" "session assurance columns exist"
assert_scalar "SELECT (setting_value->>'mfaEnabled') FROM ky_system_setting WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security'" "false" "default MFA remains disabled"
assert_scalar "SELECT has_table_privilege('ky_membership_access_reader','ky_user_session','SELECT')::int" "1" "access reader can read sessions"
assert_scalar "SELECT has_table_privilege('ky_membership_access_reader','ky_system_setting','SELECT')::int" "1" "access reader can read platform security setting"
assert_scalar "SELECT has_table_privilege('ky_membership_access_reader','ky_user_session','UPDATE')::int" "0" "access reader cannot refresh authentication time"
assert_scalar "SELECT has_table_privilege('ky_membership_access_reader','ky_system_setting','UPDATE')::int" "0" "access reader cannot forge MFA policy"
assert_scalar "SELECT count(*) FROM pg_trigger WHERE tgrelid='ky_user_session'::regclass AND tgname='ky_user_session_authenticated_at_immutable_trg' AND NOT tgisinternal" "1" "authenticated_at immutable trigger exists once"

if "${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
UPDATE ky_system_setting
SET setting_value=jsonb_set(setting_value,'{mfaEnabled}','"invalid"'::jsonb,true)
WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security';
SQL
then
  echo 'FAIL: platform security setting accepted non-boolean mfaEnabled' >&2
  exit 1
fi

READER_URL="postgresql://${READER_LOGIN}:${READER_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
FIXTURE_URL="postgresql://${FIXTURE_LOGIN}:${FIXTURE_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
mkdir -p "$ASSURANCE_GO_ROOT/scripts/testdata/membership-access-assurance"
ln -s "$ROOT_DIR/services" "$ASSURANCE_GO_ROOT/services"
ln -s "$ROOT_DIR/shared" "$ASSURANCE_GO_ROOT/shared"
cp "$ROOT_DIR/scripts/testdata/membership-access-assurance/go.work" "$ASSURANCE_GOWORK"
cp "$ROOT_DIR/scripts/testdata/membership-access-assurance/go.work.sum" "${ASSURANCE_GOWORK}.sum"
(cd "$ASSURANCE_GO_ROOT/services/ky-membership-service" && \
  GOWORK="$ASSURANCE_GOWORK" GOFLAGS=-mod=readonly \
  KY_MEMBERSHIP_ASSURANCE_TEST_DATABASE_URL="$READER_URL" \
  KY_MEMBERSHIP_ASSURANCE_FIXTURE_DATABASE_URL="$FIXTURE_URL" \
  go test -race -run '^TestAccessAssuranceAgainstPostgres$' -v ./internal/store)
(cd "$ASSURANCE_GO_ROOT/services/ky-membership-service" && \
  GOWORK="$ASSURANCE_GOWORK" GOFLAGS=-mod=readonly \
  KY_MEMBERSHIP_ASSURANCE_TEST_DATABASE_URL="$READER_URL" \
  go test -race -run '^TestInternalAccessDecisionAssuranceAgainstPostgres$' -v ./internal/server)

echo 'Membership high-risk access assurance contract passed'
