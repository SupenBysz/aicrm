#!/usr/bin/env bash
# Destructive P2A Desktop handoff migration/store test against disposable PostgreSQL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
TEST_DB="aicrm_agent_handoff_${RUN_ID}"
LOGIN_ROLE="ky_agent_handoff_test_${RUN_ID}"
LOGIN_PASSWORD="HandoffTest${RUN_ID}Only"

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

# The handoff migration must remain transaction-safe and idempotent without
# being added to the shared migration test while P2A work is still parallel.
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
\ir $ROOT_DIR/ops/db/046_agent_executor_desktop_handoff_claim.sql
ROLLBACK;
\ir $ROOT_DIR/ops/db/046_agent_executor_desktop_handoff_claim.sql
\ir $ROOT_DIR/ops/db/046_agent_executor_desktop_handoff_claim.sql
SQL

"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_p2a_roles.sql" >/dev/null
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_desktop_handoff_roles.sql" >/dev/null
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

assert_scalar \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ky_ai_executor_desktop_handoff' AND column_name IN ('claim_token_key_id','claim_token_nonce_hash','claim_token_issued_at','claimed_session_revision')" \
  "4" "safe deterministic claim-token columns exist"
assert_scalar \
  "SELECT count(*) FROM pg_constraint WHERE conrelid='ky_ai_executor_desktop_handoff'::regclass AND conname IN ('ky_ai_executor_handoff_ticket_key_id_check','ky_ai_executor_handoff_claim_key_id_check','ky_ai_executor_handoff_claim_nonce_hash_check','ky_ai_executor_handoff_claim_session_revision_check','ky_ai_executor_handoff_claim_metadata_check')" \
  "5" "handoff token metadata constraints exist exactly once"
assert_scalar \
  "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='ky_ai_executor_desktop_handoff' AND indexname IN ('ky_ai_executor_desktop_handoff_ticket_hash_uidx','ky_ai_executor_desktop_handoff_claim_token_hash_uidx')" \
  "2" "handoff token hashes are unique"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_handoff','SELECT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_handoff','INSERT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_handoff','UPDATE'))::int" \
  "1" "writer owns handoff state"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_request_ledger','INSERT') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_request_ledger','UPDATE') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_device_request_ledger','DELETE'))::int" \
  "1" "writer can only append device ledger"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_authorization_session_event','INSERT') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_authorization_session_event','UPDATE') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_authorization_session_event','DELETE'))::int" \
  "1" "writer can only append authorization events"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_user','SELECT') OR has_table_privilege('ky_agent_executor_reader','ky_user_session','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_membership','SELECT'))::int" \
  "0" "handoff roles cannot read identity truth tables"

CONTROL_URL="postgresql://${LOGIN_ROLE}:${LOGIN_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
(cd "$ROOT_DIR/services/ky-agent-executor-service" && \
  GOWORK=off GOFLAGS=-mod=readonly \
  KY_AGENT_EXECUTOR_DESKTOP_HANDOFF_TEST_DATABASE_URL="$CONTROL_URL" \
  go test -race -run '^TestControlDesktopHandoffStoreAgainstPostgres$' -v ./internal/store)

echo 'Agent Executor P2A Desktop handoff migration/store contract passed'
