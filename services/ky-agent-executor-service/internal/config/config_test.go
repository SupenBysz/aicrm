package config

import (
	"os"
	"testing"
)

func TestLoadIsFailClosedUnlessWriteModeIsExplicit(t *testing.T) {
	t.Setenv("KY_AGENT_EXECUTOR_SERVICE_HTTP_ADDR", "")
	t.Setenv("KY_AGENT_EXECUTOR_DATABASE_URL", "reader-dsn")
	t.Setenv("KY_AGENT_EXECUTOR_INTERNAL_TOKEN", "internal-secret")
	t.Setenv("KY_AGENT_EXECUTOR_WRITE_ENABLED", "true")

	cfg := Load()
	if cfg.HTTPAddr != "127.0.0.1:18087" {
		t.Fatalf("unexpected default address: %q", cfg.HTTPAddr)
	}
	if cfg.DatabaseURL != "reader-dsn" || cfg.InternalToken != "internal-secret" {
		t.Fatalf("dedicated P1 settings were not loaded: %#v", cfg)
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
	base.InternalToken = "internal"
	base.AuthTokenSecret = "auth-secret"
	base.MembershipURL = "http://127.0.0.1:18083"
	base.CredentialRoot = "/var/lib/aicrm-agent-executors"
	base.OwnerInstanceID = "instance-1"
	if err := base.Validate(); err != nil {
		t.Fatalf("complete control-plane config rejected: %v", err)
	}
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
