#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/ky-agent-executor-service"
UNIT="$ROOT_DIR/ops/native/ky-agent-executor-service.service"
ROLES="$ROOT_DIR/ops/db/roles/ky_agent_executor_p1_roles.sql"

fail() {
  echo "Agent Executor P1 boundary test failed: $1" >&2
  exit 1
}

grep -q '^User=ky-agent-executor$' "$UNIT" || fail "fixed low-privilege user missing"
grep -q '^Group=ky-agent-executor$' "$UNIT" || fail "fixed low-privilege group missing"
grep -q '^NoNewPrivileges=true$' "$UNIT" || fail "NoNewPrivileges missing"
grep -q '^ProtectSystem=strict$' "$UNIT" || fail "ProtectSystem=strict missing"
grep -q '^PrivateDevices=true$' "$UNIT" || fail "PrivateDevices missing"
grep -q '^CapabilityBoundingSet=$' "$UNIT" || fail "capabilities are not empty"
grep -q '^KillMode=control-group$' "$UNIT" || fail "process-group stop contract missing"
grep -q "stat -c '%U:%G:%a'" "$ROOT_DIR/scripts/deploy_services.sh" || fail "dedicated config ownership check missing"
grep -q 'root:ky-agent-executor:640' "$ROOT_DIR/scripts/deploy_services.sh" || fail "dedicated config mode check missing"

if grep -qi 'agent.executor\|agent-executor\|18087' "$ROOT_DIR/ops/native/ky-admin-host.nginx.conf"; then
  fail "P1 service was added to public Nginx routing"
fi

grep -q 'CREATE ROLE ky_agent_executor_reader NOLOGIN' "$ROLES" || fail "reader NOLOGIN group missing"
grep -q 'CREATE ROLE ky_agent_executor_writer NOLOGIN' "$ROLES" || fail "writer NOLOGIN group missing"
if grep -Eqi 'GRANT[[:space:]]+(INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*ky_agent_executor_writer' "$ROLES"; then
  fail "writer received a business table write grant"
fi

if find "$SERVICE_DIR" -type f -name '*.go' ! -name '*_test.go' \
  ! -path '*/internal/appserver/launcher_linux.go' -print0 \
  | xargs -0 grep -n -E 'os/exec|exec\.Command|codex --remote|--listen[[:space:]]+(ws|unix)|CODEX_HOME='; then
  fail "runtime spawning escaped the isolated App Server launcher"
fi
grep -q 'DynamicUser=yes' "$SERVICE_DIR/internal/appserver/launcher_linux.go" || fail "DynamicUser runtime missing"
grep -q '"app-server", "--listen", "stdio://"' "$SERVICE_DIR/internal/appserver/launcher_linux.go" || fail "stdio App Server command missing"
if grep -q 'internal/appserver\|internal/credentialfs' "$SERVICE_DIR/internal/server/server.go"; then
  fail "P1 deployed server must not wire the P2A runtime before cutover"
fi
if grep -R -n -E 'INSERT[[:space:]]+INTO|UPDATE[[:space:]]+ky_|DELETE[[:space:]]+FROM|TRUNCATE[[:space:]]+' \
  "$SERVICE_DIR/internal/store" --include='*.go' --exclude='*_test.go'; then
  fail "P1 production store contains SQL writes"
fi

grep -q 'ky-agent-executor-service' "$ROOT_DIR/go.work" || fail "go.work integration missing"
grep -q 'ky-agent-executor-service' "$ROOT_DIR/scripts/build_services.sh" || fail "build integration missing"
grep -q 'ky-agent-executor-service' "$ROOT_DIR/scripts/deploy_services.sh" || fail "deploy integration missing"

(cd "$SERVICE_DIR" && go test -race ./... && go vet ./...)

echo "Agent Executor P1 boundary tests passed"
