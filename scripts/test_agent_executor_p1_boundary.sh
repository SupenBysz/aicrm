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
  ! -path '*/internal/appserver/launcher_linux.go' \
  ! -path '*/internal/runtimebroker/server_linux.go' -print0 \
  | xargs -0 grep -n -E 'os/exec|exec\.Command|codex --remote|--listen[[:space:]]+(ws|unix)|CODEX_HOME='; then
  fail "runtime spawning escaped the isolated App Server launcher"
fi
grep -q 'DynamicUser=yes' "$SERVICE_DIR/internal/appserver/launcher_linux.go" || fail "DynamicUser runtime missing"
grep -q '"app-server", "--listen", "stdio://"' "$SERVICE_DIR/internal/appserver/launcher_linux.go" || fail "stdio App Server command missing"
grep -q 'if s.cfg.WriteEnabled {' "$SERVICE_DIR/internal/server/server.go" || fail "P2A runtime is not feature-gated"
grep -q 'authorization.New' "$SERVICE_DIR/internal/server/server.go" || fail "P2A runtime manager missing"
grep -q 'BrokerLauncher' "$SERVICE_DIR/internal/server/server.go" || fail "Agent service bypasses the root runtime broker"
grep -q '^User=root$' "$ROOT_DIR/ops/native/ky-agent-executor-runtime-broker.service" || fail "runtime broker is not root-owned"
grep -q '^ListenSequentialPacket=/run/aicrm-agent-runtime/control.sock$' "$ROOT_DIR/ops/native/ky-agent-executor-runtime-broker.socket" || fail "runtime broker socket contract missing"
grep -Eq 'uid[[:space:]]*!=[[:space:]]*s\.agentUID' "$SERVICE_DIR/internal/runtimebroker/server_linux.go" || fail "runtime broker peer UID check missing"
if grep -R -n -E 'INSERT[[:space:]]+INTO|UPDATE[[:space:]]+ky_|DELETE[[:space:]]+FROM|TRUNCATE[[:space:]]+' \
  "$SERVICE_DIR/internal/store" --include='*.go' --exclude='*_test.go' --exclude='control_*.go'; then
  fail "P1 shadow reader contains SQL writes"
fi
grep -q 'if s.cfg.WriteEnabled {' "$SERVICE_DIR/internal/server/server.go" || fail "P2A control store is not feature-gated"
grep -q 'strings.EqualFold(strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_WRITE_ENABLED")), "true")' \
  "$SERVICE_DIR/internal/config/config.go" || fail "control writes are not explicit opt-in"
if grep -q '^KY_AGENT_EXECUTOR_WRITE_ENABLED=true$' "$ROOT_DIR/ops/native/ky-agent-executor-service.env.example"; then
  fail "P1 deployment example enables control writes"
fi

grep -q 'ky-agent-executor-service' "$ROOT_DIR/go.work" || fail "go.work integration missing"
grep -q 'ky-agent-executor-service' "$ROOT_DIR/scripts/build_services.sh" || fail "build integration missing"
grep -q 'ky-agent-executor-service' "$ROOT_DIR/scripts/deploy_services.sh" || fail "deploy integration missing"

(cd "$SERVICE_DIR" && go test -race ./... && go vet ./...)

echo "Agent Executor P1 boundary tests passed"
