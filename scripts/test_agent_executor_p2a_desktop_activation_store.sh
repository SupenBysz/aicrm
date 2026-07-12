#!/usr/bin/env bash
# Destructive P2A Desktop authorization proof/activation/recovery test on disposable PostgreSQL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
TEST_DB="aicrm_agent_activation_${RUN_ID}"
LOGIN_ROLE="ky_agent_activation_test_${RUN_ID}"
LOGIN_PASSWORD="ActivationTest${RUN_ID}Only"

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

schema_fingerprint() {
  if [[ "$(id -un)" == "postgres" ]]; then
    pg_dump -d "$TEST_DB" --schema-only --no-owner --no-privileges
  else
    sudo -u postgres pg_dump -d "$TEST_DB" --schema-only --no-owner --no-privileges
  fi | sed -E '/^-- Dumped (from|by)/d; /^\\(un)?restrict /d' | sha256sum | awk '{print $1}'
}

before_rollback="$(schema_fingerprint)"
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
\ir $ROOT_DIR/ops/db/048_agent_executor_desktop_activation.sql
\ir $ROOT_DIR/ops/db/050_agent_executor_desktop_activation_recovery.sql
ROLLBACK;
SQL
after_rollback="$(schema_fingerprint)"
[[ "$before_rollback" == "$after_rollback" ]] || {
  echo 'FAIL: migration 048 rollback changed schema' >&2
  exit 1
}

"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
\ir $ROOT_DIR/ops/db/048_agent_executor_desktop_activation.sql
\ir $ROOT_DIR/ops/db/048_agent_executor_desktop_activation.sql
\ir $ROOT_DIR/ops/db/050_agent_executor_desktop_activation_recovery.sql
\ir $ROOT_DIR/ops/db/050_agent_executor_desktop_activation_recovery.sql
SQL

"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_p2a_roles.sql" >/dev/null
"${PSQL[@]}" -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT_DIR/ops/db/roles/ky_agent_executor_desktop_activation_roles.sql" >/dev/null
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
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ky_ai_executor_desktop_authorization_proof' AND column_name IN ('claim_token_hash','device_key_generation','device_sequence','response_reference','response_session_revision')" \
  "5" "proof trust metadata columns exist"
assert_scalar \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ky_ai_executor_credential_activation' AND column_name IN ('device_binding_revision','activation_token_key_id','activation_token_nonce_hash','ack_device_key_generation','ack_device_sequence','acknowledged_at')" \
  "6" "activation token and ACK metadata columns exist"
assert_scalar \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('ky_ai_executor_desktop_proof_trust_shape_check','ky_ai_executor_activation_token_shape_check','ky_ai_executor_activation_ack_shape_check','ky_ai_executor_desktop_binding_fence_check')" \
  "4" "proof, token, ACK and Desktop binding fences exist once"
assert_scalar \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='ky_ai_executor_credential_activation_audit'" \
  "1" "activation immutable audit exists"
assert_scalar \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('ky_ai_exec_activation_audit_event_check','ky_ai_exec_activation_audit_sequence_check')" \
  "2" "activation recovery terminal audit constraints exist once"
assert_scalar \
  "SELECT count(*) FROM pg_indexes WHERE indexname='ky_ai_exec_credential_activation_pending_recovery_idx'" \
  "1" "pending activation recovery index exists once"
assert_scalar \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid='ky_ai_executor_credential_activation_audit'::regclass AND tgname='ky_ai_executor_credential_activation_audit_immutable_trg' AND NOT tgisinternal" \
  "1" "activation audit immutable trigger exists once"
assert_scalar \
  "SELECT count(*) FROM pg_trigger WHERE tgrelid='ky_ai_executor_credential_activation'::regclass AND tgname='ky_ai_executor_credential_activation_frozen_trg' AND NOT tgisinternal" \
  "1" "activation frozen target trigger exists once"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation','INSERT') AND has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation','UPDATE'))::int" \
  "1" "writer owns mutable activation state"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_authorization_proof','INSERT') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_authorization_proof','UPDATE') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_desktop_authorization_proof','DELETE'))::int" \
  "1" "proof rows are append-only"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','INSERT') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','UPDATE') AND NOT has_table_privilege('ky_agent_executor_writer','ky_ai_executor_credential_activation_audit','DELETE'))::int" \
  "1" "activation audit is append-only"
assert_scalar \
  "SELECT (has_table_privilege('ky_agent_executor_writer','ky_user','SELECT') OR has_table_privilege('ky_agent_executor_reader','ky_user_session','SELECT') OR has_table_privilege('ky_agent_executor_writer','ky_membership','SELECT'))::int" \
  "0" "activation roles cannot read identity truth tables"

CONTROL_URL="postgresql://${LOGIN_ROLE}:${LOGIN_PASSWORD}@127.0.0.1:5432/${TEST_DB}?sslmode=disable"
(cd "$ROOT_DIR" && \
  KY_AGENT_EXECUTOR_DESKTOP_ACTIVATION_TEST_DATABASE_URL="$CONTROL_URL" \
  go test -race -run '^TestDesktop(AuthorizationProofAndActivation|CredentialActivationRecovery)AgainstPostgres$' \
  -v ./services/ky-agent-executor-service/internal/store)

echo 'Agent Executor P2A Desktop authorization proof/activation/recovery contract passed'
