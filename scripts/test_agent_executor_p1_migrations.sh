#!/usr/bin/env bash
# Destructive integration test against two disposable PostgreSQL databases.
#
# Connection is inherited from libpq PG* variables.  Run as a PostgreSQL role
# that can create/drop databases, for example:
#   sudo -u postgres ./scripts/test_agent_executor_p1_migrations.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
FRESH_DB="aicrm_agent_p1_fresh_${RUN_ID}"
UPGRADE_DB="aicrm_agent_p1_upgrade_${RUN_ID}"

cleanup() {
  for db in "$FRESH_DB" "$UPGRADE_DB"; do
    psql -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$db" >/dev/null <<'SQL' || true
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
  done
}
trap cleanup EXIT

create_database() {
  local db="$1"
  psql -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$db" >/dev/null <<'SQL'
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'db_name') \gexec
SQL
}

schema_fingerprint() {
  local db="$1"
  pg_dump -d "$db" --schema-only --no-owner --no-privileges \
    | sed -E '/^-- Dumped (from|by)/d; /^\\(un)?restrict /d' \
    | sha256sum \
    | awk '{print $1}'
}

assert_scalar() {
  local db="$1" sql="$2" expected="$3" description="$4"
  local actual
  actual="$(psql -X -d "$db" -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $description (expected=$expected actual=$actual)" >&2
    exit 1
  fi
}

echo "[1/5] fresh database: ledger deploy twice"
create_database "$FRESH_DB"
KY_TENANT_DATABASE_URL="$FRESH_DB" KY_EXECUTE_DATABASE_DEPLOY=1 \
  "$ROOT_DIR/scripts/deploy_database.sh" >/dev/null
KY_TENANT_DATABASE_URL="$FRESH_DB" KY_EXECUTE_DATABASE_DEPLOY=1 \
  "$ROOT_DIR/scripts/deploy_database.sh" >/dev/null
assert_scalar "$FRESH_DB" \
  "SELECT count(*) FROM ky_schema_migration WHERE version IN (38,39)" \
  "2" "P1 migrations are ledgered exactly once"
assert_scalar "$FRESH_DB" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ky_ai_executor_authorization_session','ky_ai_executor_operation_lease','ky_ai_executor_task_request_registry')" \
  "3" "P1 canonical tables exist"
psql -X -d "$FRESH_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_p1_roles.sql" >/dev/null
assert_scalar "$FRESH_DB" \
  "SELECT (NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)::int FROM pg_roles WHERE rolname='ky_agent_executor_reader'" \
  "1" "reader group is NOLOGIN and unprivileged"
assert_scalar "$FRESH_DB" \
  "SELECT has_table_privilege('ky_agent_executor_reader','ky_ai_executor_task','SELECT')::int" \
  "1" "reader can select executor-owned task data"
assert_scalar "$FRESH_DB" \
  "SELECT has_table_privilege('ky_agent_executor_reader','ky_matrix_account','SELECT')::int" \
  "0" "reader cannot select Matrix business data"
assert_scalar "$FRESH_DB" \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_task','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_ai_executor_task','INSERT') OR has_table_privilege('ky_agent_executor_writer','ky_ai_executor_task','UPDATE') OR has_table_privilege('ky_agent_executor_writer','ky_ai_executor_task','DELETE'))::int" \
  "0" "future writer has no P1 business grants"

echo "[2/5] production-like pre-P1 baseline"
create_database "$UPGRADE_DB"
for migration in "$ROOT_DIR"/ops/db/[0-9][0-9][0-9]_*.sql; do
  version="$(basename "$migration" | cut -c1-3)"
  if ((10#$version >= 38)); then
    continue
  fi
  psql -X -d "$UPGRADE_DB" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

# Canary values prove that canonical state is not inferred from legacy state
# and that the historical task_type remains unchanged.
psql -X -d "$UPGRADE_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
UPDATE ky_ai_executor_config
SET auth_status = 'authorized'
WHERE id = 'aiexec_platform_codex';

INSERT INTO ky_ai_executor_task (
  id, workspace_type, workspace_id, executor_id, executor_type,
  task_type, purpose, status
) VALUES (
  'task_p1_legacy_canary', 'platform', 'platform_root',
  'aiexec_platform_codex', 'codex', 'script_repair',
  'qr_login_prepare', 'completed'
);
SQL

echo "[3/5] migration transaction rolls back cleanly"
before_fingerprint="$(schema_fingerprint "$UPGRADE_DB")"
psql -X -d "$UPGRADE_DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
\ir $ROOT_DIR/ops/db/038_agent_executor_control_plane_expand.sql
\ir $ROOT_DIR/ops/db/039_agent_executor_task_fencing_expand.sql
ROLLBACK;
SQL
after_fingerprint="$(schema_fingerprint "$UPGRADE_DB")"
if [[ "$before_fingerprint" != "$after_fingerprint" ]]; then
  echo "FAIL: schema changed after migration rollback" >&2
  exit 1
fi

echo "[4/5] production-like upgrade is directly idempotent"
for pass in 1 2; do
  psql -X -d "$UPGRADE_DB" -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/ops/db/038_agent_executor_control_plane_expand.sql" >/dev/null
  psql -X -d "$UPGRADE_DB" -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/ops/db/039_agent_executor_task_fencing_expand.sql" >/dev/null
done

assert_scalar "$UPGRADE_DB" \
  "SELECT auth_status || ':' || credential_status FROM ky_ai_executor_config WHERE id='aiexec_platform_codex'" \
  "authorized:unknown" "legacy authorization is not promoted"
assert_scalar "$UPGRADE_DB" \
  "SELECT task_type || ':' || generation_engine FROM ky_ai_executor_task WHERE id='task_p1_legacy_canary'" \
  "script_repair:legacy_provider" "historical task type is preserved"
assert_scalar "$UPGRADE_DB" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ky_ai_executor_task' AND column_name='operation'" \
  "0" "redundant operation enum column is absent"
assert_scalar "$UPGRADE_DB" \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('ky_ai_executor_task_codex_binding_check','ky_ai_executor_task_fencing_shape_check')" \
  "2" "binding and fencing constraints exist once"
assert_scalar "$UPGRADE_DB" \
  "SELECT count(*) FROM pg_constraint WHERE conname='ky_ai_executor_config_readiness_status_check' AND pg_get_constraintdef(oid) LIKE '%degraded%' AND pg_get_constraintdef(oid) LIKE '%unavailable%' AND pg_get_constraintdef(oid) NOT LIKE '%not_ready%' AND pg_get_constraintdef(oid) NOT LIKE '%error%'" \
  "1" "readiness enum matches the locked degraded/unavailable contract"

echo "[5/5] migration contract passed"
