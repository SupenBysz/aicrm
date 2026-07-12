package config

import (
	"os"
	"strings"
	"testing"
)

func TestLoadIsFailClosedUnlessWriteModeIsExplicit(t *testing.T) {
	t.Setenv("KY_AGENT_EXECUTOR_SERVICE_HTTP_ADDR", "")
	t.Setenv("KY_AGENT_EXECUTOR_DATABASE_URL", "reader-dsn")
	t.Setenv("KY_AGENT_EXECUTOR_INTERNAL_TOKEN", "internal-secret")
	t.Setenv("KY_AGENT_EXECUTOR_WRITE_ENABLED", "true")
	t.Setenv("KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET", strings.Repeat("d", 32))

	cfg := Load()
	if cfg.HTTPAddr != "127.0.0.1:18087" {
		t.Fatalf("unexpected default address: %q", cfg.HTTPAddr)
	}
	if cfg.DatabaseURL != "reader-dsn" || cfg.InternalToken != "internal-secret" {
		t.Fatalf("dedicated P1 settings were not loaded: %#v", cfg)
	}
	if cfg.DeviceChallengeSecret != strings.Repeat("d", 32) {
		t.Fatal("device challenge secret was not loaded")
	}
	if os.Getenv("KY_AGENT_EXECUTOR_WRITE_ENABLED") != "true" {
		t.Fatal("test canary unexpectedly changed")
	}
	if !cfg.WriteEnabled {
		t.Fatal("explicit control-plane write mode was not loaded")
	}
	if ShadowMode != "shadow_read_only" {
		t.Fatalf("unexpected mode: %s", ShadowMode)
	}
}

func TestValidateWriteModeRequiresDedicatedDependencies(t *testing.T) {
	base := Config{HTTPAddr: "127.0.0.1:18087", WriteEnabled: true}
	if err := base.Validate(); err == nil {
		t.Fatal("incomplete write mode was accepted")
	}
	base.WriterDatabaseURL = "writer-dsn"
	base.DatabaseURL = "reader-dsn"
	base.InternalToken = strings.Repeat("i", 32)
	base.AuthTokenSecret = strings.Repeat("a", 32)
	base.DeviceChallengeSecret = strings.Repeat("d", 32)
	base.MembershipURL = "http://127.0.0.1:18083"
	base.CredentialRoot = "/var/lib/aicrm-agent-executors"
	base.OwnerInstanceID = "instance-1"
	base.CodexVersion = "0.144.1"
	base.RuntimeBindingID = "server_test"
	base.RuntimeBrokerSocket = "/run/aicrm-agent-runtime.sock"
	if err := base.Validate(); err != nil {
		t.Fatalf("complete control-plane config rejected: %v", err)
	}
	base.DeviceChallengeSecret = base.AuthTokenSecret
	if err := base.Validate(); err == nil {
		t.Fatal("reused auth/device challenge secret was accepted")
	}
	base.DeviceChallengeSecret = base.InternalToken
	if err := base.Validate(); err == nil {
		t.Fatal("reused internal/device challenge secret was accepted")
	}
	base.DeviceChallengeSecret = "too-short"
	if err := base.Validate(); err == nil {
		t.Fatal("short device challenge secret was accepted")
	}
	base.DeviceChallengeSecret = strings.Repeat("d", 32)
	base.DatabaseURL = base.WriterDatabaseURL
	if err := base.Validate(); err == nil {
		t.Fatal("same reader/writer role was accepted")
	}
}

func TestValidateRequiresLoopback(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:18087", "[::1]:18087", "localhost:18087"} {
		if err := (Config{HTTPAddr: addr}).Validate(); err != nil {
			t.Fatalf("expected %q to be accepted: %v", addr, err)
		}
	}
	for _, addr := range []string{":18087", "0.0.0.0:18087", "192.0.2.10:18087", "invalid"} {
		if err := (Config{HTTPAddr: addr}).Validate(); err == nil {
			t.Fatalf("expected %q to be rejected", addr)
		}
	}
}
