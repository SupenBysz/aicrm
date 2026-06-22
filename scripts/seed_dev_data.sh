#!/usr/bin/env bash
set -euo pipefail

: "${KY_TENANT_DATABASE_URL:?KY_TENANT_DATABASE_URL is required}"

KY_DEV_ADMIN_ACCOUNT="${KY_DEV_ADMIN_ACCOUNT:-platform_owner}"
KY_DEV_ADMIN_PASSWORD="${KY_DEV_ADMIN_PASSWORD:-admin123456}"
KY_DEV_ADMIN_USER_ID="${KY_DEV_ADMIN_USER_ID:-user_platform_owner}"

if ! command -v htpasswd >/dev/null 2>&1; then
  echo "htpasswd is required to generate a bcrypt hash. Install apache2-utils or provide a manual hash." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to update development seed data." >&2
  exit 1
fi

HASH="$(htpasswd -bnBC 10 "" "$KY_DEV_ADMIN_PASSWORD" | tr -d ':' | sed 's/^\$2y\$/\$2a\$/')"

psql "$KY_TENANT_DATABASE_URL" <<SQL
INSERT INTO ky_user_credential (id, user_id, credential_type, identifier, password_hash, status, verified_at)
VALUES ('cred_platform_owner_password', '$KY_DEV_ADMIN_USER_ID', 'password', '$KY_DEV_ADMIN_ACCOUNT', '$HASH', 'normal', now())
ON CONFLICT (credential_type, identifier) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    verified_at = COALESCE(ky_user_credential.verified_at, now()),
    status = 'normal',
    updated_at = now();
SQL

echo "Development password hash upserted for account: $KY_DEV_ADMIN_ACCOUNT"
echo "This script is for local/test environments only."
