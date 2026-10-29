#!/usr/bin/env bash
set -euo pipefail

# Only retry readiness. Once SQL starts, fail without automatically replaying it.
if [[ "${KY_EXECUTE_DATABASE_DEPLOY:-}" == "1" ]]; then
  : "${KY_TENANT_DATABASE_URL:?database connection is required}"
  for attempt in $(seq 1 45); do
    if pg_isready -q -t 1 -d "$KY_TENANT_DATABASE_URL"; then
      break
    fi
    sleep 1
  done
  if ! pg_isready -q -t 1 -d "$KY_TENANT_DATABASE_URL"; then
    echo 'Database did not become ready; migrations were not started.' >&2
    exit 1
  fi
fi
exec bash "$(dirname "${BASH_SOURCE[0]}")/deploy_database.sh"
