#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy_database.sh"

fail() {
  echo "deploy database test failed: $1" >&2
  exit 1
}

dry_run="$(env -u KY_TENANT_DATABASE_URL -u KY_EXECUTE_DATABASE_DEPLOY -u KY_DATABASE_DEPLOY_RENDER_SQL bash "$DEPLOY_SCRIPT")"
[[ "$dry_run" == *"Database deploy dry run"* ]] || fail "dry run summary missing"
[[ "$dry_run" == *"Set KY_EXECUTE_DATABASE_DEPLOY=1"* ]] || fail "dry run execution guard missing"

rendered="$(env -u KY_TENANT_DATABASE_URL KY_DATABASE_DEPLOY_RENDER_SQL=1 bash "$DEPLOY_SCRIPT")"
[[ "$rendered" == *"pg_advisory_lock(4701196508681632081)"* ]] || fail "advisory lock missing"
[[ "$rendered" == *"pg_advisory_unlock(4701196508681632081)"* ]] || fail "advisory unlock missing"
[[ "$rendered" == *"to_regclass('public.ky_schema_migration')"* ]] || fail "ledger detection missing"
[[ "$rendered" == *"to_regclass('public.ky_user') IS NULL"* ]] || fail "fresh/baseline detection missing"
[[ "$rendered" == *"034_migration_ledger.sql"* ]] || fail "ledger migration missing"
[[ "$rendered" == *"migration checksum mismatch"* ]] || fail "checksum drift failure missing"
[[ "$rendered" == *"migration ledger is missing required baseline entry"* ]] || fail "baseline gap failure missing"
[[ "$rendered" == *"'bootstrap'"* ]] || fail "fresh bootstrap records missing"
[[ "$rendered" == *"'baseline'"* ]] || fail "existing baseline records missing"
[[ "$rendered" == *"COMMIT;"* ]] || fail "transaction commit missing"
grep -q "'migrate'" "$DEPLOY_SCRIPT" || fail "future migration mode missing from deployer"

expected_count="$(find "$ROOT_DIR/ops/db" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' | wc -l | tr -d ' ')"
checksum_count="$(grep -c "migration checksum mismatch:" <<<"$rendered")"
if [[ "$checksum_count" != "$expected_count" ]]; then
  fail "expected $expected_count checksum guards, found $checksum_count"
fi

if_count="$(grep -c '^\\if ' <<<"$rendered")"
endif_count="$(grep -c '^\\endif$' <<<"$rendered")"
if [[ "$if_count" != "$endif_count" ]]; then
  fail "unbalanced psql conditionals: if=$if_count endif=$endif_count"
fi

fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/scripts" "$fixture_root/ops/db"
cp "$DEPLOY_SCRIPT" "$fixture_root/scripts/deploy_database.sh"
cp "$ROOT_DIR/ops/db/034_migration_ledger.sql" "$fixture_root/ops/db/034_migration_ledger.sql"
printf '%s\n' 'SELECT 1;' >"$fixture_root/ops/db/035_future_test.sql"

future_rendered="$(KY_DATABASE_DEPLOY_RENDER_SQL=1 bash "$fixture_root/scripts/deploy_database.sh")"
[[ "$future_rendered" == *"035_future_test.sql"* ]] || fail "future migration not rendered"
[[ "$future_rendered" == *"'migrate'"* ]] || fail "future migration ledger insert missing"

printf '%s\n' 'BEGIN;' 'SELECT 1;' 'COMMIT;' >"$fixture_root/ops/db/035_future_test.sql"
if KY_DATABASE_DEPLOY_RENDER_SQL=1 bash "$fixture_root/scripts/deploy_database.sh" >/dev/null 2>&1; then
  fail "future migration with transaction control was accepted"
fi

echo "deploy database tests passed"
