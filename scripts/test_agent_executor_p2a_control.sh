#!/usr/bin/env bash
# Destructive P2A control-store and least-privilege integration test.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
TEST_DB="aicrm_agent_control_${RUN_ID}"
LOGIN_ROLE="ky_agent_executor_test_${RUN_ID}"
LOGIN_PASSWORD="P2aTest${RUN_ID}Only"

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

assert_scalar "SELECT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_config','UPDATE')::int" "1" "writer can update executor config"
assert_scalar "SELECT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_api_idempotency','INSERT')::int" "1" "writer can insert idempotency rows"
assert_scalar "SELECT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_api_idempotency','UPDATE')::int" "0" "writer cannot mutate idempotency rows"
assert_scalar "SELECT has_table_privilege('ky_agent_executor_writer','ky_user','SELECT')::int" "0" "writer cannot read identity tables"
assert_scalar "SELECT has_table_privilege('ky_agent_executor_writer','ky_matrix_account','SELECT')::int" "0" "writer cannot read Matrix tables"

CONTROL_URL="postgresql://${LOGIN_ROLE}:${LOGIN_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
(cd "$ROOT_DIR/services/ky-agent-executor-service" && \
  GOWORK=off KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL="$CONTROL_URL" \
  go test -run TestControlStoreAgainstPostgres -v ./internal/store)

echo 'Agent Executor P2A control contract passed'
