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
AGENT_RUNTIME_BROKER="ky-agent-executor-runtime-broker"
AGENT_RUNTIME_ROOT="/var/lib/aicrm-agent-executors"
AGENT_RUNTIME_STATE_ROOT="/var/lib/private/aicrm-codex-runtime"

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
test -x "$SRC_DIR/$AGENT_RUNTIME_BROKER"
test -f "$ROOT_DIR/ops/native/$AGENT_RUNTIME_BROKER.service"
test -f "$ROOT_DIR/ops/native/$AGENT_RUNTIME_BROKER.socket"

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
echo "- install runtime broker binary and systemd socket"
echo "- require credential root anchor: $AGENT_RUNTIME_ROOT (root:ky-agent-executor 1770)"
echo "- require private runtime state root: $AGENT_RUNTIME_STATE_ROOT (root:root 0700)"

echo "Set KY_EXECUTE_SERVICE_DEPLOY=1 to install binaries/units, daemon-reload, enable, restart, and verify."
if [[ "${KY_EXECUTE_SERVICE_DEPLOY:-}" == "1" ]]; then
  # Recheck at the mutation boundary as deploy artifacts may have been built
  # on another host. Never restart the executor against an unverified schema.
  "$ROOT_DIR/scripts/verify_codex_appserver_protocol.sh"
  test -f "$AGENT_EXECUTOR_ENV"
  command -v systemd-sysusers >/dev/null
  install -d "$SYSUSERS_DIR"
  install -m 0644 "$ROOT_DIR/ops/native/$AGENT_EXECUTOR_SYSUSERS" "$SYSUSERS_DIR/$AGENT_EXECUTOR_SYSUSERS"
  systemd-sysusers "$SYSUSERS_DIR/$AGENT_EXECUTOR_SYSUSERS"
  if [[ "$(stat -c '%U:%G:%a' "$AGENT_EXECUTOR_ENV")" != "root:ky-agent-executor:640" ]]; then
    echo "Agent Executor config must be root:ky-agent-executor mode 0640: $AGENT_EXECUTOR_ENV" >&2
    exit 1
  fi
  install -d -m 1770 -o root -g ky-agent-executor "$AGENT_RUNTIME_ROOT"
  install -d -m 0700 -o root -g root "$AGENT_RUNTIME_STATE_ROOT"
  install -d "$TARGET_BIN_DIR"
  for service in "${services[@]}"; do
    install -m 0755 "$SRC_DIR/$service" "$TARGET_BIN_DIR/$service"
    install -m 0644 "$ROOT_DIR/ops/native/$service.service" "$SYSTEMD_DIR/$service.service"
  done
  install -m 0755 "$SRC_DIR/$AGENT_RUNTIME_BROKER" "$TARGET_BIN_DIR/$AGENT_RUNTIME_BROKER"
  install -m 0644 "$ROOT_DIR/ops/native/$AGENT_RUNTIME_BROKER.service" "$SYSTEMD_DIR/$AGENT_RUNTIME_BROKER.service"
  install -m 0644 "$ROOT_DIR/ops/native/$AGENT_RUNTIME_BROKER.socket" "$SYSTEMD_DIR/$AGENT_RUNTIME_BROKER.socket"

  systemctl daemon-reload
  systemctl enable --now "$AGENT_RUNTIME_BROKER.socket"
  systemctl try-restart "$AGENT_RUNTIME_BROKER.service" || true
  for service in "${services[@]}"; do
    systemctl enable "$service.service"
    systemctl restart "$service.service"
    systemctl --no-pager --full status "$service.service" >/dev/null
  done

  if [[ "$(stat -c '%U:%G:%a' "$AGENT_RUNTIME_ROOT")" != "root:ky-agent-executor:1770" ]]; then
    echo "Agent Executor credential root ownership is unsafe: $AGENT_RUNTIME_ROOT" >&2
    exit 1
  fi
  if [[ "$(stat -c '%U:%G:%a' "$AGENT_RUNTIME_STATE_ROOT")" != "root:root:700" ]]; then
    echo "Agent Executor runtime state root ownership is unsafe: $AGENT_RUNTIME_STATE_ROOT" >&2
    exit 1
  fi

  "$ROOT_DIR/scripts/verify_deployment.sh" --readyz-only
fi
