#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="${KY_DEPLOY_ROOT:-/data/kyai_crm}"
SRC_DIR="$ROOT_DIR/dist/services"
TARGET_BIN_DIR="$DEPLOY_ROOT/bin"
SYSTEMD_DIR="${KY_SYSTEMD_DIR:-/etc/systemd/system}"
SYSUSERS_DIR="${KY_SYSUSERS_DIR:-/usr/lib/sysusers.d}"
AGENT_EXECUTOR_SYSUSERS="ky-agent-executor-service.sysusers.conf"
AGENT_EXECUTOR_ENV="$DEPLOY_ROOT/config/ky-agent-executor-service.env"

services=(
  ky-auth-service
  ky-org-service
  ky-membership-service
  ky-ai-model-service
  ky-matrix-account-service
  ky-agent-executor-service
)

for service in "${services[@]}"; do
  test -x "$SRC_DIR/$service"
  test -f "$ROOT_DIR/ops/native/$service.service"
done
test -f "$ROOT_DIR/ops/native/$AGENT_EXECUTOR_SYSUSERS"

echo "Service deploy dry run."
echo "- target bin dir: $TARGET_BIN_DIR"
echo "- systemd dir: $SYSTEMD_DIR"
for service in "${services[@]}"; do
  echo "- install binary: $SRC_DIR/$service -> $TARGET_BIN_DIR/$service"
  echo "- install unit: $ROOT_DIR/ops/native/$service.service -> $SYSTEMD_DIR/$service.service"
  echo "- systemctl enable --now $service.service"
  echo "- verify readyz for $service"
done
echo "- install sysusers: $ROOT_DIR/ops/native/$AGENT_EXECUTOR_SYSUSERS -> $SYSUSERS_DIR/$AGENT_EXECUTOR_SYSUSERS"
echo "- require dedicated config: $AGENT_EXECUTOR_ENV (root:ky-agent-executor 0640)"

echo "Set KY_EXECUTE_SERVICE_DEPLOY=1 to install binaries/units, daemon-reload, enable, restart, and verify."
if [[ "${KY_EXECUTE_SERVICE_DEPLOY:-}" == "1" ]]; then
  test -f "$AGENT_EXECUTOR_ENV"
  command -v systemd-sysusers >/dev/null
  install -d "$SYSUSERS_DIR"
  install -m 0644 "$ROOT_DIR/ops/native/$AGENT_EXECUTOR_SYSUSERS" "$SYSUSERS_DIR/$AGENT_EXECUTOR_SYSUSERS"
  systemd-sysusers "$SYSUSERS_DIR/$AGENT_EXECUTOR_SYSUSERS"
  if [[ "$(stat -c '%U:%G:%a' "$AGENT_EXECUTOR_ENV")" != "root:ky-agent-executor:640" ]]; then
    echo "Agent Executor config must be root:ky-agent-executor mode 0640: $AGENT_EXECUTOR_ENV" >&2
    exit 1
  fi
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
