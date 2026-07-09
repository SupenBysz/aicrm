#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="${KY_DEPLOY_ROOT:-/data/kyai_crm}"
SRC_DIR="$ROOT_DIR/dist/services"
TARGET_BIN_DIR="$DEPLOY_ROOT/bin"
SYSTEMD_DIR="${KY_SYSTEMD_DIR:-/etc/systemd/system}"

services=(
  ky-auth-service
  ky-org-service
  ky-membership-service
  ky-ai-model-service
  ky-matrix-account-service
)

for service in "${services[@]}"; do
  test -x "$SRC_DIR/$service"
  test -f "$ROOT_DIR/ops/native/$service.service"
done

echo "Service deploy dry run."
echo "- target bin dir: $TARGET_BIN_DIR"
echo "- systemd dir: $SYSTEMD_DIR"
for service in "${services[@]}"; do
  echo "- install binary: $SRC_DIR/$service -> $TARGET_BIN_DIR/$service"
  echo "- install unit: $ROOT_DIR/ops/native/$service.service -> $SYSTEMD_DIR/$service.service"
  echo "- systemctl enable --now $service.service"
  echo "- verify readyz for $service"
done

echo "Set KY_EXECUTE_SERVICE_DEPLOY=1 to install binaries/units, daemon-reload, enable, restart, and verify."
if [[ "${KY_EXECUTE_SERVICE_DEPLOY:-}" == "1" ]]; then
  install -d "$TARGET_BIN_DIR"
  for service in "${services[@]}"; do
    install -m 0755 "$SRC_DIR/$service" "$TARGET_BIN_DIR/$service"
    install -m 0644 "$ROOT_DIR/ops/native/$service.service" "$SYSTEMD_DIR/$service.service"
  done

  systemctl daemon-reload
  for service in "${services[@]}"; do
    systemctl enable "$service.service"
    systemctl restart "$service.service"
    systemctl --no-pager --full status "$service.service" >/dev/null
  done

  "$ROOT_DIR/scripts/verify_deployment.sh" --readyz-only
fi
