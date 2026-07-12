package config

import (
	"os"
	"testing"
)

func TestLoadIsFailClosedAndHasNoWriteMode(t *testing.T) {
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
	// Config intentionally has no WriteEnabled field and ignores the canary.
	if ShadowMode != "shadow_read_only" {
		t.Fatalf("unexpected mode: %s", ShadowMode)
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
