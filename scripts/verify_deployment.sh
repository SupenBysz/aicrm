#!/usr/bin/env bash
set -euo pipefail

READYZ_ONLY=0
if [[ "${1:-}" == "--readyz-only" ]]; then
  READYZ_ONLY=1
fi

check_url() {
  local url="$1"
  echo "Checking $url"
  curl -fsS "$url" >/dev/null
}

check_systemd() {
  local service="$1"
  if command -v systemctl >/dev/null 2>&1; then
    echo "Checking systemd service $service"
    systemctl is-active --quiet "$service.service"
  else
    echo "Skipping systemd check for $service: systemctl not available"
  fi
}

services=(
  ky-auth-service
  ky-org-service
  ky-membership-service
  ky-ai-model-service
)

for service in "${services[@]}"; do
  check_systemd "$service"
done

check_url "${KY_AUTH_READYZ_URL:-http://127.0.0.1:18081/readyz}"
check_url "${KY_ORG_READYZ_URL:-http://127.0.0.1:18082/readyz}"
check_url "${KY_MEMBERSHIP_READYZ_URL:-http://127.0.0.1:18083/readyz}"
check_url "${KY_AI_MODEL_READYZ_URL:-http://127.0.0.1:18086/readyz}"

if [[ "$READYZ_ONLY" == "1" ]]; then
  echo "Readyz verification passed."
  exit 0
fi

check_url "${KY_VERIFY_CONSOLE_URL:-http://127.0.0.1}/healthz"

echo "Phase 1 skeleton verification notes:"
echo "- Login, bootstrap, workspace switching, platform/agency/enterprise menus, permission denial, member invitation, notification unread count, and AI model checks require the corresponding APIs to be implemented."
echo "- Keep this script as the verification entrypoint; extend it with authenticated API checks when those endpoints are implemented."

echo "Deployment verification passed for current skeleton scope."
