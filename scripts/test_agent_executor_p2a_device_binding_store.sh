#!/usr/bin/env bash
# Destructive P2A device-binding store test against disposable PostgreSQL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
TEST_DB="aicrm_agent_binding_${RUN_ID}"
LOGIN_ROLE="ky_agent_binding_test_${RUN_ID}"
LOGIN_PASSWORD="BindingTest${RUN_ID}Only"

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
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_p2a_roles.sql" >/dev/null
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

assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding','SELECT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding','INSERT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding','UPDATE'))::int" "1" "writer owns binding state"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding_audit','SELECT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding_audit','INSERT'))::int" "1" "writer can read and append binding audit"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding_audit','UPDATE') OR has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_binding_audit','DELETE'))::int" "0" "writer cannot mutate immutable binding audit"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_request_ledger','INSERT') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_request_ledger','UPDATE'))::int" "1" "writer can only append device ledger"
assert_scalar "SELECT (has_table_privilege('ky_agent_executor_writer','ky_user','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_user_session','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_membership','SELECT'))::int" "0" "writer cannot read identity tables"

CONTROL_URL="postgresql://${LOGIN_ROLE}:${LOGIN_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
(cd "$ROOT_DIR/services/ky-agent-executor-service" && \
  GOWORK=off GOFLAGS=-mod=readonly KY_AGENT_EXECUTOR_DEVICE_BINDING_TEST_DATABASE_URL="$CONTROL_URL" \
  go test -race -run '^TestControlDeviceBindingStoreAgainstPostgres$' -v ./internal/store)

echo 'Agent Executor P2A device binding store contract passed'
