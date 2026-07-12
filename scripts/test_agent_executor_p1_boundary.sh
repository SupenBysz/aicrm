#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/ky-agent-executor-service"
UNIT="$ROOT_DIR/ops/native/ky-agent-executor-service.service"
ROLES="$ROOT_DIR/ops/db/roles/ky_agent_executor_p1_roles.sql"
SERVICE_ENV_EXAMPLE="$ROOT_DIR/ops/native/ky-agent-executor-service.env.example"

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

grep -Eq 'proxy_pass[[:space:]]+http://127\.0\.0\.1:18087;[[:space:]]*$' \
  "$ROOT_DIR/ops/native/ky-admin-host.nginx.conf" || fail "Agent Executor loopback gateway target is missing"
if grep -n '18087' "$ROOT_DIR/ops/native/ky-admin-host.nginx.conf" \
  | grep -Ev 'proxy_pass[[:space:]]+http://127\.0\.0\.1:18087;[[:space:]]*$'; then
  fail "Agent Executor gateway target is not the fixed loopback service"
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
grep -q 'StateDirectory=' "$SERVICE_DIR/internal/appserver/launcher_linux.go" || fail "DynamicUser state directory missing"
if grep -q ':idmap' "$SERVICE_DIR/internal/appserver/launcher_linux.go"; then
  fail "unsupported BindPaths idmap option remains"
fi
grep -q '"app-server", "--listen", "stdio://"' "$SERVICE_DIR/internal/appserver/launcher_linux.go" || fail "stdio App Server command missing"
grep -q 'if s.cfg.WriteEnabled {' "$SERVICE_DIR/internal/server/server.go" || fail "P2A runtime is not feature-gated"
grep -q 'authorization.New' "$SERVICE_DIR/internal/server/server.go" || fail "P2A runtime manager missing"
grep -q 'BrokerLauncher' "$SERVICE_DIR/internal/server/server.go" || fail "Agent service bypasses the root runtime broker"
grep -q '^User=root$' "$ROOT_DIR/ops/native/ky-agent-executor-runtime-broker.service" || fail "runtime broker is not root-owned"
grep -q -- '-m 1770 /var/lib/aicrm-agent-executors' "$ROOT_DIR/ops/native/ky-agent-executor-runtime-broker.service" || fail "credential root anchor contract missing"
grep -q '^ListenSequentialPacket=/run/aicrm-agent-runtime.sock$' "$ROOT_DIR/ops/native/ky-agent-executor-runtime-broker.socket" || fail "runtime broker socket contract missing"
grep -q '^After=network-online.target ky-agent-executor-runtime-broker.service$' "$ROOT_DIR/ops/native/ky-agent-executor-service.service" || fail "executor service does not start after broker recovery"
grep -q '^Requires=ky-agent-executor-runtime-broker.service$' "$ROOT_DIR/ops/native/ky-agent-executor-service.service" || fail "executor service does not require broker recovery"
grep -Eq 'uid[[:space:]]*!=[[:space:]]*s\.agentUID' "$SERVICE_DIR/internal/runtimebroker/server_linux.go" || fail "runtime broker peer UID check missing"
if grep -R -n -E 'INSERT[[:space:]]+INTO|UPDATE[[:space:]]+ky_|DELETE[[:space:]]+FROM|TRUNCATE[[:space:]]+' \
  "$SERVICE_DIR/internal/store" --include='*.go' --exclude='*_test.go' --exclude='control_*.go'; then
  fail "P1 shadow reader contains SQL writes"
fi
grep -q 'if s.cfg.WriteEnabled {' "$SERVICE_DIR/internal/server/server.go" || fail "P2A control store is not feature-gated"
grep -q 'strings.EqualFold(strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_WRITE_ENABLED")), "true")' \
  "$SERVICE_DIR/internal/config/config.go" || fail "control writes are not explicit opt-in"
if grep -q '^KY_AGENT_EXECUTOR_WRITE_ENABLED=true$' "$SERVICE_ENV_EXAMPLE"; then
  fail "P1 deployment example enables control writes"
fi
grep -q '^# KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET=' "$SERVICE_ENV_EXAMPLE" || fail "device challenge secret placeholder missing"
grep -q 'KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET' "$SERVICE_DIR/internal/config/config.go" || fail "device challenge secret config missing"
grep -q 'len(c.DeviceChallengeSecret) < 32' "$SERVICE_DIR/internal/config/config.go" || fail "device challenge secret minimum length missing"
grep -q 'c.DeviceChallengeSecret == c.AuthTokenSecret' "$SERVICE_DIR/internal/config/config.go" || fail "device/auth secret independence check missing"
grep -q 'c.DeviceChallengeSecret == c.InternalToken' "$SERVICE_DIR/internal/config/config.go" || fail "device/internal secret independence check missing"
grep -q '^# KY_AGENT_EXECUTOR_CONFIRMATION_CHALLENGE_SECRET=' "$SERVICE_ENV_EXAMPLE" || fail "confirmation challenge secret placeholder missing"
grep -q '^# KY_AGENT_EXECUTOR_TRUSTED_TOKEN_NONCE_SECRET=' "$SERVICE_ENV_EXAMPLE" || fail "trusted-token nonce secret placeholder missing"
grep -q '^# KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEY_ID=' "$SERVICE_ENV_EXAMPLE" || fail "trusted-token key-id placeholder missing"
grep -q '^# KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY=' "$SERVICE_ENV_EXAMPLE" || fail "trusted-token private-key placeholder missing"
grep -q 'len(c.ConfirmationChallengeSecret) < 32' "$SERVICE_DIR/internal/config/config.go" || fail "confirmation challenge minimum length missing"
grep -q 'len(c.TrustedTokenNonceSecret) < 32' "$SERVICE_DIR/internal/config/config.go" || fail "trusted-token nonce minimum length missing"
grep -q 'base64.RawURLEncoding.DecodeString' "$SERVICE_DIR/internal/config/config.go" || fail "trusted-token private-key canonical decode missing"
grep -q 'ed25519.NewKeyFromSeed' "$SERVICE_DIR/internal/config/config.go" || fail "trusted-token verification derivation missing"
grep -q 'operationconfirmation.New' "$SERVICE_DIR/internal/server/server.go" || fail "operation confirmation manager startup missing"

grep -q 'ky-agent-executor-service' "$ROOT_DIR/go.work" || fail "go.work integration missing"
grep -q 'ky-agent-executor-service' "$ROOT_DIR/scripts/build_services.sh" || fail "build integration missing"
grep -q 'ky-agent-executor-service' "$ROOT_DIR/scripts/deploy_services.sh" || fail "deploy integration missing"

(cd "$SERVICE_DIR" && go test -race ./... && go vet ./...)

echo "Agent Executor P1 boundary tests passed"
