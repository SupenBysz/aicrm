#!/usr/bin/env bash
# KyaiCRM local one-shot run + acceptance.
#
# Builds the four services, initializes the database (schema + seed + dev
# credential), starts the services locally, waits for readiness, and runs the
# acceptance harness. Local/test use only.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${KY_TENANT_DATABASE_URL:?KY_TENANT_DATABASE_URL is required}"
: "${KY_AUTH_TOKEN_SECRET:?KY_AUTH_TOKEN_SECRET is required}"
: "${KY_AI_SECRET_KEY:?KY_AI_SECRET_KEY is required}"

AUTH_ADDR="${KY_AUTH_SERVICE_HTTP_ADDR:-:18081}"
ORG_ADDR="${KY_ORG_SERVICE_HTTP_ADDR:-:18082}"
MEMBERSHIP_ADDR="${KY_MEMBERSHIP_SERVICE_HTTP_ADDR:-:18083}"
AI_ADDR="${KY_AI_MODEL_SERVICE_HTTP_ADDR:-:18086}"

PIDS=()
cleanup() {
  echo "Stopping services..."
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "[1/6] Database schema + seed"
KY_EXECUTE_DATABASE_DEPLOY=1 "$ROOT_DIR/scripts/deploy_database.sh"

echo "[2/6] Development credential"
"$ROOT_DIR/scripts/seed_dev_data.sh"

echo "[3/6] Build services"
"$ROOT_DIR/scripts/build_services.sh"

echo "[4/6] Start services"
BIN="$ROOT_DIR/dist/services"
KY_AUTH_SERVICE_HTTP_ADDR="$AUTH_ADDR" "$BIN/ky-auth-service" & PIDS+=("$!")
KY_ORG_SERVICE_HTTP_ADDR="$ORG_ADDR" "$BIN/ky-org-service" & PIDS+=("$!")
KY_MEMBERSHIP_SERVICE_HTTP_ADDR="$MEMBERSHIP_ADDR" "$BIN/ky-membership-service" & PIDS+=("$!")
KY_AI_MODEL_SERVICE_HTTP_ADDR="$AI_ADDR" "$BIN/ky-ai-model-service" & PIDS+=("$!")

echo "[5/6] Wait for readiness"
hostport() { printf '127.0.0.1:%s' "${1#:}"; }
for i in $(seq 1 30); do
  if curl -fsS "http://$(hostport "$AUTH_ADDR")/readyz" >/dev/null 2>&1 &&
     curl -fsS "http://$(hostport "$ORG_ADDR")/readyz" >/dev/null 2>&1 &&
     curl -fsS "http://$(hostport "$MEMBERSHIP_ADDR")/readyz" >/dev/null 2>&1 &&
     curl -fsS "http://$(hostport "$AI_ADDR")/readyz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 30 ]]; then echo "Services did not become ready in time" >&2; exit 1; fi
done

echo "[6/6] Acceptance"
KY_ACCEPT_AUTH_URL="http://$(hostport "$AUTH_ADDR")" \
KY_ACCEPT_ORG_URL="http://$(hostport "$ORG_ADDR")" \
KY_ACCEPT_MEMBERSHIP_URL="http://$(hostport "$MEMBERSHIP_ADDR")" \
KY_ACCEPT_AI_URL="http://$(hostport "$AI_ADDR")" \
  "$ROOT_DIR/scripts/acceptance.sh"
