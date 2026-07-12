//go:build linux

package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/runtimebroker"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	cfg := runtimebroker.Config{CredentialRoot: env("KY_AGENT_EXECUTOR_CREDENTIAL_ROOT", "/var/lib/aicrm-agent-executors"), AgentUser: env("KY_AGENT_EXECUTOR_USER", "ky-agent-executor"), SystemdRunPath: env("KY_SYSTEMD_RUN_PATH", "/usr/bin/systemd-run"), SystemctlPath: env("KY_SYSTEMCTL_PATH", "/usr/bin/systemctl"), CodexBinary: env("KY_CODEX_BINARY", "/usr/bin/codex")}
	server, err := runtimebroker.New(cfg)
	if err != nil {
		log.Fatal("runtime broker configuration failed")
	}
	listener, err := runtimebroker.ListenerFromSystemd()
	if err != nil {
		log.Fatal("runtime broker socket activation failed")
	}
	runtimebroker.CleanupStaleUnits(cfg.SystemctlPath)
	if err := server.Serve(ctx, listener); err != nil && ctx.Err() == nil {
		log.Fatal("runtime broker stopped")
	}
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
