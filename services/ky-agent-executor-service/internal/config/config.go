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
)

type Config struct {
	HTTPAddr       string
	RuntimeEnvFile string
	DatabaseURL    string
	InternalToken  string
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

	return Config{
		HTTPAddr:       addr,
		RuntimeEnvFile: runtimeEnvFile,
		DatabaseURL:    strings.TrimSpace(os.Getenv("KY_AGENT_EXECUTOR_DATABASE_URL")),
		InternalToken:  internalToken,
	}
}

// Validate enforces the P1 transport boundary.  Nginx/public routing is not
// part of this phase and a wildcard bind must not be enabled by configuration.
func (c Config) Validate() error {
	host, _, err := net.SplitHostPort(c.HTTPAddr)
	if err != nil {
		return errors.New("KY_AGENT_EXECUTOR_SERVICE_HTTP_ADDR must be host:port")
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("ky-agent-executor-service P1 must bind to loopback")
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
