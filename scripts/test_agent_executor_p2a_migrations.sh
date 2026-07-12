#!/usr/bin/env bash
# Destructive P2A migration integration test against disposable PostgreSQL.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DB="${KY_AGENT_EXECUTOR_TEST_ADMIN_DATABASE:-postgres}"
RUN_ID="$(date +%s)_$$"
TEST_DB="aicrm_agent_p2a_${RUN_ID}"

cleanup() {
  psql -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$TEST_DB" >/dev/null <<'SQL' || true
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SQL
}
trap cleanup EXIT

psql -X -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -v db_name="$TEST_DB" >/dev/null <<'SQL'
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'db_name') \gexec
SQL

for migration in "$ROOT_DIR"/ops/db/[0-9][0-9][0-9]_*.sql; do
  version="$(basename "$migration" | cut -c1-3)"
  if ((10#$version >= 40)); then
    continue
  fi
  psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

# Duplicate legacy rows prove deterministic backfill does not collide.
psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO ky_ai_executor_device_registration_challenge (
  id, public_key_digest, actor_id, challenge_hash, request_hash, expires_at
) VALUES
  ('challenge_legacy_a', repeat('1', 64), 'user_legacy', repeat('2', 64), repeat('3', 64), now() + interval '2 minutes'),
  ('challenge_legacy_b', repeat('1', 64), 'user_legacy', repeat('4', 64), repeat('5', 64), now() + interval '2 minutes');

INSERT INTO ky_ai_executor_operation_confirmation (
  id, action, executor_id, actor_id, expected_revision,
  challenge_hash, request_hash, expires_at
) VALUES
  ('confirmation_legacy_a', 'force_revoke', 'aiexec_platform_codex', 'user_legacy', 1,
   repeat('6', 64), repeat('7', 64), now() + interval '5 minutes'),
  ('confirmation_legacy_b', 'force_revoke', 'aiexec_platform_codex', 'user_legacy', 1,
   repeat('8', 64), repeat('9', 64), now() + interval '5 minutes');
SQL

schema_fingerprint() {
  pg_dump -d "$TEST_DB" --schema-only --no-owner --no-privileges \
    | sed -E '/^-- Dumped (from|by)/d; /^\\(un)?restrict /d' \
    | sha256sum | awk '{print $1}'
}

before="$(schema_fingerprint)"
psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
\ir $ROOT_DIR/ops/db/040_agent_executor_authorization_runtime.sql
\ir $ROOT_DIR/ops/db/041_agent_executor_p2a_control_api.sql
\ir $ROOT_DIR/ops/db/042_agent_executor_credential_recovery.sql
ROLLBACK;
SQL
after="$(schema_fingerprint)"
[[ "$before" == "$after" ]] || { echo 'FAIL: P2A rollback changed schema' >&2; exit 1; }

for _ in 1 2; do
  psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/ops/db/040_agent_executor_authorization_runtime.sql" >/dev/null
  psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/ops/db/041_agent_executor_p2a_control_api.sql" >/dev/null
  psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 \
    -f "$ROOT_DIR/ops/db/042_agent_executor_credential_recovery.sql" >/dev/null
done

assert_scalar() {
  local sql="$1" expected="$2" description="$3" actual
  actual="$(psql -X -d "$TEST_DB" -Atqc "$sql")"
  [[ "$actual" == "$expected" ]] || {
    echo "FAIL: $description (expected=$expected actual=$actual)" >&2
    exit 1
  }
}

assert_scalar \
  "SELECT count(DISTINCT idempotency_key_hash) FROM ky_ai_executor_device_registration_challenge WHERE actor_id='user_legacy'" \
  "2" "legacy registration idempotency hashes are collision-free"
assert_scalar \
  "SELECT count(DISTINCT idempotency_key_hash) FROM ky_ai_executor_operation_confirmation WHERE actor_id='user_legacy'" \
  "2" "legacy confirmation idempotency hashes are collision-free"
assert_scalar \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ky_ai_executor_runtime_worker','ky_ai_executor_desktop_handoff','ky_ai_executor_desktop_authorization_proof','ky_ai_executor_credential_activation','ky_ai_executor_desktop_command_operation','ky_ai_executor_credential_revocation')" \
  "6" "P2A runtime tables exist"
assert_scalar \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('ky_ai_executor_task_result_safe_metadata_check','ky_ai_executor_task_event_safe_metadata_check','ky_ai_executor_task_outbox_safe_metadata_check','ky_ai_executor_control_outbox_safe_metadata_check')" \
  "4" "safe metadata constraints exist once"
assert_scalar \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='ky_ai_executor_api_idempotency'" \
  "1" "P2A API idempotency table exists"
assert_scalar \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ky_ai_executor_credential_binding' AND column_name IN ('operation_id','lease_epoch','source_credential_revision','digest_algorithm')" \
  "4" "credential recovery fence columns exist"
assert_scalar \
  "SELECT count(*) FROM pg_constraint WHERE conname='ky_ai_executor_credential_binding_recovery_fence_check'" \
  "1" "credential recovery fence constraint exists once"

psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
INSERT INTO ky_ai_executor_authorization_session (
  id, executor_id, runtime_type, flow_type, intent, requested_by,
  idempotency_key_hash, request_hash, session_deadline_at
) VALUES (
  'session_sensitive_canary', 'aiexec_platform_codex', 'server', 'device_code',
  'authorize', 'user_legacy', repeat('a', 64), repeat('b', 64),
  now() + interval '10 minutes'
);
SQL

if psql -X -d "$TEST_DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
INSERT INTO ky_ai_executor_authorization_session_event (
  id, session_id, sequence, event_type, safe_payload_json, occurred_at
) VALUES ('invalid_event', 'session_sensitive_canary', 1, 'failed', '{"userCode":"secret"}', now());
SQL
then
  echo 'FAIL: sensitive authorization payload was accepted' >&2
  exit 1
fi

echo 'Agent Executor P2A migration contract passed'
