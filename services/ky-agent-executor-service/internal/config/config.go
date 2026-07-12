package config

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	ServiceName = "ky-agent-executor-service"
	ShadowMode  = "shadow_read_only"
	ControlMode = "p2a_control_plane"
)

type Config struct {
	HTTPAddr                    string
	RuntimeEnvFile              string
	DatabaseURL                 string
	WriterDatabaseURL           string
	InternalToken               string
	AuthTokenSecret             string
	DeviceChallengeSecret       string
	ConfirmationChallengeSecret string
	TrustedTokenNonceSecret     string
	TrustedTokenKeyID           string
	TrustedTokenPrivateKey      string
	MembershipURL               string
	WriteEnabled                bool
	CredentialRoot              string
	CodexBinary                 string
	SystemdRunPath              string
	OwnerInstanceID             string
	CodexVersion                string
	RuntimeBindingID            string
	RuntimeBrokerSocket         string
}

func Load() Config {
	runtimeEnvFile := strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_RUNTIME_ENV_FILE"))
	if runtimeEnvFile != "" {
		_ = loadEnvFile(runtimeEnvFile)
	}

	addr := strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_SERVICE_HTTP_ADDR"))
	if addr == "" {
		addr = "127.0.0.1:18087"
	}

	internalToken := strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_INTERNAL_TOKEN"))
	if internalToken == "" {
		internalToken = strings.TrimSpace(os.Getenv("KY_INTERNAL_SERVICE_TOKEN"))
	}

	membershipURL := strings.TrimSpace(os.Getenv("KY_MEMBERSHIP_SERVICE_URL"))
	if membershipURL == "" {
		membershipURL = "http://127.0.0.1:18083"
	}
	credentialRoot := strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_CREDENTIAL_ROOT"))
	if credentialRoot == "" {
		credentialRoot = "/var/lib/aicrm-agent-executors"
	}
	ownerInstanceID := strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_OWNER_INSTANCE_ID"))
	if ownerInstanceID == "" {
		hostname, _ := os.Hostname()
		ownerInstanceID = fmt.Sprintf("%s-%d-%d", hostname, os.Getpid(), time.Now().UnixNano())
	}
	hostname, _ := os.Hostname()
	bindingDigest := sha256.Sum256([]byte(hostname))
	runtimeBindingID := "server_" + hex.EncodeToString(bindingDigest[:12])
	codexVersion := strings.TrimSpace(os.Getenv("KY_CODEX_VERSION"))
	if codexVersion == "" {
		codexVersion = "0.144.1"
	}
	runtimeBrokerSocket := strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_RUNTIME_BROKER_SOCKET"))
	if runtimeBrokerSocket == "" {
		runtimeBrokerSocket = "/run/aicrm-agent-runtime.sock"
	}
	return Config{
		HTTPAddr:                    addr,
		RuntimeEnvFile:              runtimeEnvFile,
		DatabaseURL:                 strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_DATABASE_URL")),
		WriterDatabaseURL:           strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_WRITER_DATABASE_URL")),
		InternalToken:               internalToken,
		AuthTokenSecret:             strings.TrimSpace(os.Getenv("KY_AUTH_TOKEN_SECRET")),
		DeviceChallengeSecret:       strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET")),
		ConfirmationChallengeSecret: strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_CONFIRMATION_CHALLENGE_SECRET")),
		TrustedTokenNonceSecret:     strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_NONCE_SECRET")),
		TrustedTokenKeyID:           strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEY_ID")),
		TrustedTokenPrivateKey:      strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY")),
		MembershipURL:               membershipURL,
		WriteEnabled:                strings.EqualFold(strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_WRITE_ENABLED")), "true"),
		CredentialRoot:              credentialRoot,
		CodexBinary:                 strings.TrimSpace(os.Getenv("KY_CODEX_BINARY")),
		SystemdRunPath:              strings.TrimSpace(os.Getenv("KY_SYSTEMD_RUN_PATH")),
		OwnerInstanceID:             ownerInstanceID,
		CodexVersion:                codexVersion,
		RuntimeBindingID:            runtimeBindingID,
		RuntimeBrokerSocket:         runtimeBrokerSocket,
	}
}

// Validate enforces the P1 transport boundary.  Nginx/public routing is not
// part of this phase and a wildcard bind must not be enabled by configuration.
func (c Config) Validate() error {
	host, _, err := net.SplitHostPort(c.HTTPAddr)
	if err != nil {
		return errors.New("KY_AGENT_EXECUTOR_SERVICE_HTTP_ADDR must be host:port")
	}
	if host != "localhost" {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("ky-agent-executor-service must bind to loopback")
		}
	}
	return c.validateControlPlane()
}

func (c Config) validateControlPlane() error {
	if !c.WriteEnabled {
		return nil
	}
	for name, value := range map[string]string{
		"KY_AGENT_EXECUTOR_DATABASE_URL":                  c.DatabaseURL,
		"KY_AGENT_EXECUTOR_WRITER_DATABASE_URL":           c.WriterDatabaseURL,
		"KY_AGENT_EXECUTOR_INTERNAL_TOKEN":                c.InternalToken,
		"KY_AUTH_TOKEN_SECRET":                            c.AuthTokenSecret,
		"KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET":       c.DeviceChallengeSecret,
		"KY_AGENT_EXECUTOR_CONFIRMATION_CHALLENGE_SECRET": c.ConfirmationChallengeSecret,
		"KY_AGENT_EXECUTOR_TRUSTED_TOKEN_NONCE_SECRET":    c.TrustedTokenNonceSecret,
		"KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEY_ID":          c.TrustedTokenKeyID,
		"KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY":     c.TrustedTokenPrivateKey,
		"KY_MEMBERSHIP_SERVICE_URL":                       c.MembershipURL,
		"KY_AGENT_EXECUTOR_CREDENTIAL_ROOT":               c.CredentialRoot,
		"KY_AGENT_EXECUTOR_OWNER_INSTANCE_ID":             c.OwnerInstanceID,
		"KY_CODEX_VERSION":                                c.CodexVersion,
		"KY_AGENT_EXECUTOR_RUNTIME_BINDING_ID":            c.RuntimeBindingID,
		"KY_AGENT_EXECUTOR_RUNTIME_BROKER_SOCKET":         c.RuntimeBrokerSocket,
	} {
		if strings.TrimSpace(value) == "" {
			return errors.New(name + " is required when Agent Executor writes are enabled")
		}
	}
	if len(c.DeviceChallengeSecret) < 32 {
		return errors.New("KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET must be at least 32 bytes")
	}
	if c.DeviceChallengeSecret == c.AuthTokenSecret || c.DeviceChallengeSecret == c.InternalToken {
		return errors.New("KY_AGENT_EXECUTOR_DEVICE_CHALLENGE_SECRET must be independent")
	}
	if len(c.ConfirmationChallengeSecret) < 32 {
		return errors.New("KY_AGENT_EXECUTOR_CONFIRMATION_CHALLENGE_SECRET must be at least 32 bytes")
	}
	if len(c.TrustedTokenNonceSecret) < 32 {
		return errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_NONCE_SECRET must be at least 32 bytes")
	}
	keyMaterial, err := c.TrustedTokenKeyMaterial()
	if err != nil {
		return err
	}
	for _, secret := range []string{c.AuthTokenSecret, c.InternalToken, c.DeviceChallengeSecret} {
		if c.ConfirmationChallengeSecret == secret {
			return errors.New("KY_AGENT_EXECUTOR_CONFIRMATION_CHALLENGE_SECRET must be independent")
		}
		if c.TrustedTokenPrivateKey == secret || bytes.Equal(keyMaterial.PrivateKey, []byte(secret)) {
			return errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY must be independent")
		}
	}
	for _, secret := range []string{
		c.AuthTokenSecret, c.InternalToken, c.DeviceChallengeSecret, c.ConfirmationChallengeSecret,
	} {
		if c.TrustedTokenNonceSecret == secret {
			return errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_NONCE_SECRET must be independent")
		}
	}
	if c.TrustedTokenPrivateKey == c.TrustedTokenNonceSecret ||
		bytes.Equal(keyMaterial.PrivateKey, []byte(c.TrustedTokenNonceSecret)) {
		return errors.New("trusted-token nonce secret and private key must be independent")
	}
	if c.TrustedTokenPrivateKey == c.ConfirmationChallengeSecret ||
		bytes.Equal(keyMaterial.PrivateKey, []byte(c.ConfirmationChallengeSecret)) {
		return errors.New("operation confirmation challenge and trusted-token key must be independent")
	}
	if c.DatabaseURL != "" && c.DatabaseURL == c.WriterDatabaseURL {
		return errors.New("reader and writer database URLs must use distinct roles")
	}
	return nil
}

var trustedTokenKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type TrustedTokenKeyMaterial struct {
	KeyID           string
	PrivateKey      ed25519.PrivateKey
	VerificationKey ed25519.PublicKey
}

// TrustedTokenKeyMaterial strictly parses the canonical raw
// Ed25519 private key used for trusted-token issuance. The verification key is
// always derived from this private key and is never independently configured.
func (c Config) TrustedTokenKeyMaterial() (TrustedTokenKeyMaterial, error) {
	keyID := c.TrustedTokenKeyID
	encoded := c.TrustedTokenPrivateKey
	if strings.TrimSpace(keyID) != keyID || !trustedTokenKeyIDPattern.MatchString(keyID) {
		return TrustedTokenKeyMaterial{}, errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_KEY_ID is invalid")
	}
	if strings.TrimSpace(encoded) != encoded || encoded == "" || strings.Contains(encoded, "=") {
		return TrustedTokenKeyMaterial{}, errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY must be canonical base64url")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) != ed25519.PrivateKeySize || base64.RawURLEncoding.EncodeToString(decoded) != encoded {
		return TrustedTokenKeyMaterial{}, errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY must encode a 64-byte Ed25519 private key")
	}
	derived := ed25519.NewKeyFromSeed(decoded[:ed25519.SeedSize])
	if !bytes.Equal(derived, decoded) {
		return TrustedTokenKeyMaterial{}, errors.New("KY_AGENT_EXECUTOR_TRUSTED_TOKEN_PRIVATE_KEY is not a valid Ed25519 private key")
	}
	privateKey := append(ed25519.PrivateKey(nil), decoded...)
	verificationKey := append(ed25519.PublicKey(nil), derived[ed25519.SeedSize:]...)
	return TrustedTokenKeyMaterial{
		KeyID: keyID, PrivateKey: privateKey, VerificationKey: verificationKey,
	}, nil
}

func loadEnvFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), "\"'")
		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	return scanner.Err()
}
