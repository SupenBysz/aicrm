package config

import (
	"bufio"
	"errors"
	"net"
	"os"
	"strings"
)

const (
	ServiceName = "ky-agent-executor-service"
	ShadowMode  = "shadow_read_only"
	ControlMode = "p2a_control_plane"
)

type Config struct {
	HTTPAddr          string
	RuntimeEnvFile    string
	DatabaseURL       string
	WriterDatabaseURL string
	InternalToken     string
	AuthTokenSecret   string
	MembershipURL     string
	WriteEnabled      bool
	CredentialRoot    string
	CodexBinary       string
	SystemdRunPath    string
	OwnerInstanceID   string
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
		ownerInstanceID = hostname
	}
	return Config{
		HTTPAddr:          addr,
		RuntimeEnvFile:    runtimeEnvFile,
		DatabaseURL:       strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_DATABASE_URL")),
		WriterDatabaseURL: strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_WRITER_DATABASE_URL")),
		InternalToken:     internalToken,
		AuthTokenSecret:   strings.TrimSpace(os.Getenv("KY_AUTH_TOKEN_SECRET")),
		MembershipURL:     membershipURL,
		WriteEnabled:      strings.EqualFold(strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_WRITE_ENABLED")), "true"),
		CredentialRoot:    credentialRoot,
		CodexBinary:       strings.TrimSpace(os.Getenv("KY_CODEX_BINARY")),
		SystemdRunPath:    strings.TrimSpace(os.Getenv("KY_SYSTEMD_RUN_PATH")),
		OwnerInstanceID:   ownerInstanceID,
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
		"KY_AGENT_EXECUTOR_DATABASE_URL":        c.DatabaseURL,
		"KY_AGENT_EXECUTOR_WRITER_DATABASE_URL": c.WriterDatabaseURL,
		"KY_AGENT_EXECUTOR_INTERNAL_TOKEN":      c.InternalToken,
		"KY_AUTH_TOKEN_SECRET":                  c.AuthTokenSecret,
		"KY_MEMBERSHIP_SERVICE_URL":             c.MembershipURL,
		"KY_AGENT_EXECUTOR_CREDENTIAL_ROOT":     c.CredentialRoot,
		"KY_AGENT_EXECUTOR_OWNER_INSTANCE_ID":   c.OwnerInstanceID,
	} {
		if strings.TrimSpace(value) == "" {
			return errors.New(name + " is required when Agent Executor writes are enabled")
		}
	}
	if c.DatabaseURL != "" && c.DatabaseURL == c.WriterDatabaseURL {
		return errors.New("reader and writer database URLs must use distinct roles")
	}
	return nil
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
