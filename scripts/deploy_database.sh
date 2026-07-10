#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${KY_TENANT_DATABASE_URL:?KY_TENANT_DATABASE_URL is required}"

mapfile -t sql_files < <(find "$ROOT_DIR/ops/db" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort)

echo "Database deploy dry run. Files will execute in order:"
for file in "${sql_files[@]}"; do
  echo "- $ROOT_DIR/ops/db/$file"
done

echo "Set KY_EXECUTE_DATABASE_DEPLOY=1 to execute with psql."
if [[ "${KY_EXECUTE_DATABASE_DEPLOY:-}" == "1" ]]; then
  for file in "${sql_files[@]}"; do
    psql "$KY_TENANT_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/ops/db/$file"
  done
fi
