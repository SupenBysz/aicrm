#!/usr/bin/env bash
# Destructive trusted Desktop authorization-command test against disposable PostgreSQL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
TEST_DB="aicrm_desktop_command_${RUN_ID}"
LOGIN_ROLE="ky_desktop_command_test_${RUN_ID}"
LOGIN_PASSWORD="DesktopCommandTest${RUN_ID}Only"

PSQL=(psql)
if [[ "$(id -un)" != "postgres" ]]; then
  PSQL=(sudo -u postgres psql)
fi

cleanup() {
  "${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$TEST_DB" >/dev/null <<'SQL' || true
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname=:'db_name' AND pid<>pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
  "${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v role_name="$LOGIN_ROLE" >/dev/null <<'SQL' || true
SELECT format('DROP ROLE IF EXISTS %I', :'role_name') \gexec
SQL
}
trap cleanup EXIT

"${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$TEST_DB" >/dev/null <<'SQL'
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'db_name') \gexec
SQL

if [[ "$(id -un)" == "postgres" ]]; then
  KY_TENANT_DATABASE_URL="$TEST_DB" KY_EXECUTE_DATABASE_DEPLOY=1 \
    "$ROOT_DIR/scripts/deploy_database.sh" >/dev/null
else
  sudo -u postgres env KY_TENANT_DATABASE_URL="$TEST_DB" KY_EXECUTE_DATABASE_DEPLOY=1 \
    "$ROOT_DIR/scripts/deploy_database.sh" >/dev/null
fi
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 --single-transaction \
  -f "$ROOT_DIR/ops/db/049_agent_executor_desktop_authorization_commands.sql" >/dev/null
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_p2a_roles.sql" >/dev/null
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_desktop_authorization_command_roles.sql" >/dev/null
"${PSQL[@]}" -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 \
  -v role_name="$LOGIN_ROLE" -v password="$LOGIN_PASSWORD" >/dev/null <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ky_agent_executor_writer',
  :'role_name', :'password'
) \gexec
SQL

assert_scalar() {
  local sql="$1" expected="$2" description="$3" actual
  actual="$("${PSQL[@]}" -X -d "$TEST_DB" -Atqc "$sql")"
  [[ "$actual" == "$expected" ]] || {
    echo "FAIL: $description (expected=$expected actual=$actual)" >&2
    exit 1
  }
}

assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_operation','SELECT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_operation','INSERT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_operation','UPDATE'))::int" "1" "writer owns command state"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_audit','SELECT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_audit','INSERT'))::int" "1" "writer appends command audit"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_audit','UPDATE') OR has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_command_audit','DELETE'))::int" "0" "writer cannot mutate command audit"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','SELECT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','INSERT'))::int" "1" "authorization cancel appends activation terminal audit"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','UPDATE') OR has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','DELETE'))::int" "0" "authorization cancel cannot mutate activation audit"
assert_scalar "SELECT count(*) FROM pg_indexes WHERE indexname IN ('ky_ai_exec_desktop_session_command_idem_uidx','ky_ai_exec_desktop_executor_command_idem_uidx')" "2" "purpose-specific idempotency indexes exist"
assert_scalar "SELECT count(*) FROM pg_trigger WHERE tgrelid='ky_ai_executor_desktop_command_operation'::regclass AND tgname='ky_ai_exec_desktop_authorization_command_frozen_trg' AND NOT tgisinternal" "1" "frozen target trigger exists"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_user','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_user_session','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_membership','SELECT'))::int" "0" "writer cannot read identity tables"

CONTROL_URL="postgresql://${LOGIN_ROLE}:${LOGIN_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
(cd "$ROOT_DIR/services/ky-agent-executor-service" && \
  GOWORK=off GOFLAGS=-mod=readonly \
  KY_AGENT_EXECUTOR_DESKTOP_COMMAND_TEST_DATABASE_URL="$CONTROL_URL" \
  go test -race -run '^TestDesktopAuthorizationCommandAgainstPostgres$' -v ./internal/store)

echo 'Agent Executor P2A Desktop authorization command store contract passed'
