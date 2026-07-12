package config

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
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
	t.Setenv("KY_AGENT_EXECUTOR_CONFIRMATION_CHALLENGE_SECRET", strings.Repeat("c", 32))
	t.Setenv("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_NONCE_SECRET", strings.Repeat("n", 32))
	t.Setenv("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEY_ID", "confirmation_key_1")
	t.Setenv("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY", testTrustedTokenPrivateKey())

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
	if cfg.ConfirmationChallengeSecret != strings.Repeat("c", 32) ||
		cfg.TrustedTokenNonceSecret != strings.Repeat("n", 32) ||
		cfg.TrustedTokenKeyID != "confirmation_key_1" ||
		cfg.TrustedTokenPrivateKey != testTrustedTokenPrivateKey() {
		t.Fatal("operation confirmation secrets were not loaded")
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
	base.ConfirmationChallengeSecret = strings.Repeat("c", 32)
	base.TrustedTokenNonceSecret = strings.Repeat("n", 32)
	base.TrustedTokenKeyID = "confirmation_key_1"
	base.TrustedTokenPrivateKey = testTrustedTokenPrivateKey()
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
	base.ConfirmationChallengeSecret = base.AuthTokenSecret
	if err := base.Validate(); err == nil {
		t.Fatal("reused auth/confirmation challenge secret was accepted")
	}
	base.ConfirmationChallengeSecret = base.DeviceChallengeSecret
	if err := base.Validate(); err == nil {
		t.Fatal("reused device/confirmation challenge secret was accepted")
	}
	base.ConfirmationChallengeSecret = "too-short"
	if err := base.Validate(); err == nil {
		t.Fatal("short confirmation challenge secret was accepted")
	}
	base.ConfirmationChallengeSecret = strings.Repeat("c", 32)
	base.TrustedTokenNonceSecret = base.AuthTokenSecret
	if err := base.Validate(); err == nil {
		t.Fatal("reused auth/trusted-token nonce secret was accepted")
	}
	base.TrustedTokenNonceSecret = base.ConfirmationChallengeSecret
	if err := base.Validate(); err == nil {
		t.Fatal("reused confirmation/trusted-token nonce secret was accepted")
	}
	base.TrustedTokenNonceSecret = "too-short"
	if err := base.Validate(); err == nil {
		t.Fatal("short trusted-token nonce secret was accepted")
	}
	base.TrustedTokenNonceSecret = strings.Repeat("n", 32)
	base.DatabaseURL = base.WriterDatabaseURL
	if err := base.Validate(); err == nil {
		t.Fatal("same reader/writer role was accepted")
	}
}

func TestTrustedTokenKeyMaterialIsStrictAndDerived(t *testing.T) {
	encoded := testTrustedTokenPrivateKey()
	cfg := Config{TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: encoded}
	material, err := cfg.TrustedTokenKeyMaterial()
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.RawURLEncoding.DecodeString(encoded)
	if material.KeyID != cfg.TrustedTokenKeyID || !bytes.Equal(material.PrivateKey, decoded) ||
		!bytes.Equal(material.VerificationKey, ed25519.PrivateKey(decoded).Public().(ed25519.PublicKey)) {
		t.Fatal("trusted-token verification key was not derived from the private key")
	}
	invalid := []Config{
		{TrustedTokenKeyID: "bad key", TrustedTokenPrivateKey: encoded},
		{TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: encoded + "="},
		{TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SeedSize))},
	}
	corrupt, _ := base64.RawURLEncoding.DecodeString(encoded)
	corrupt[len(corrupt)-1] ^= 1
	invalid = append(invalid, Config{
		TrustedTokenKeyID:      "confirmation_key_1",
		TrustedTokenPrivateKey: base64.RawURLEncoding.EncodeToString(corrupt),
	})
	for index, candidate := range invalid {
		if _, err := candidate.TrustedTokenKeyMaterial(); err == nil {
			t.Fatalf("invalid trusted-token key %d was accepted", index)
		}
	}
}

func TestValidateTrustPlaneSecretsArePairwiseIndependent(t *testing.T) {
	base := Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		DatabaseURL: "reader-dsn", WriterDatabaseURL: "writer-dsn",
		InternalToken: strings.Repeat("i", 32), AuthTokenSecret: strings.Repeat("a", 32),
		DeviceChallengeSecret: strings.Repeat("d", 32), ConfirmationChallengeSecret: strings.Repeat("c", 32),
		TrustedTokenNonceSecret: strings.Repeat("n", 32), TrustedTokenKeyID: "confirmation_key_1",
		TrustedTokenPrivateKey: testTrustedTokenPrivateKey(),
		MembershipURL:          "http://127.0.0.1:18083", CredentialRoot: "/var/lib/aicrm-agent-executors",
		OwnerInstanceID: "instance-1", CodexVersion: "0.144.1", RuntimeBindingID: "server_test",
		RuntimeBrokerSocket: "/run/aicrm-agent-runtime.sock",
	}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"confirmation/internal", func(value *Config) { value.ConfirmationChallengeSecret = value.InternalToken }},
		{"nonce/internal", func(value *Config) { value.TrustedTokenNonceSecret = value.InternalToken }},
		{"nonce/device", func(value *Config) { value.TrustedTokenNonceSecret = value.DeviceChallengeSecret }},
		{"nonce/confirmation", func(value *Config) { value.TrustedTokenNonceSecret = value.ConfirmationChallengeSecret }},
		{"private/auth", func(value *Config) { value.AuthTokenSecret = value.TrustedTokenPrivateKey }},
		{"private/nonce", func(value *Config) { value.TrustedTokenNonceSecret = value.TrustedTokenPrivateKey }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			candidate := base
			testCase.mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("reused trust-plane secret was accepted")
			}
		})
	}
}

func testTrustedTokenPrivateKey() string {
	seed := bytes.Repeat([]byte{0x5a}, ed25519.SeedSize)
	return base64.RawURLEncoding.EncodeToString(ed25519.NewKeyFromSeed(seed))
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
