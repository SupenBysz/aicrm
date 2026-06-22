#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${KY_TENANT_DATABASE_URL:?KY_TENANT_DATABASE_URL is required}"

sql_files=(
  001_identity_schema.sql
  002_organization_schema.sql
  003_membership_schema.sql
  004_access_schema.sql
  005_audit_notification_schema.sql
  006_system_setting_schema.sql
  007_ai_model_schema.sql
  008_seed.sql
)

echo "Database deploy dry run. Files will execute in order:"
for file in "${sql_files[@]}"; do
  echo "- $ROOT_DIR/ops/db/$file"
done

echo "Set KY_EXECUTE_DATABASE_DEPLOY=1 to execute with psql."
if [[ "${KY_EXECUTE_DATABASE_DEPLOY:-}" == "1" ]]; then
  for file in "${sql_files[@]}"; do
    psql "$KY_TENANT_DATABASE_URL" -f "$ROOT_DIR/ops/db/$file"
  done
fi
