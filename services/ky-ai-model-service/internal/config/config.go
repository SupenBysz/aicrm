package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	ServiceName     string
	HTTPAddr        string
	RuntimeEnvFile  string
	DatabaseURL     string
	RedisURL        string
	NATSURL         string
	AuthTokenSecret string
	AISecretKey     string
	InternalToken   string
	CodexBinary     string
	CodexWorkspace  string
}

func Load(serviceName, defaultHTTPAddr, httpAddrEnv string) Config {
	runtimeEnvFile := os.Getenv("KY_RUNTIME_ENV_FILE")
	if runtimeEnvFile != "" {
		_ = loadEnvFile(runtimeEnvFile)
	}

	addr := os.Getenv(httpAddrEnv)
	if addr == "" {
		addr = defaultHTTPAddr
	}

	codexBinary := os.Getenv("KY_CODEX_BINARY")
	if codexBinary == "" {
		codexBinary = "codex"
	}
	codexWorkspace := os.Getenv("KY_CODEX_WORKSPACE_DIR")
	if codexWorkspace == "" {
		codexWorkspace = "/data/Coolly"
	}

	return Config{
		ServiceName:     serviceName,
		HTTPAddr:        addr,
		RuntimeEnvFile:  runtimeEnvFile,
		DatabaseURL:     os.Getenv("KY_TENANT_DATABASE_URL"),
		RedisURL:        os.Getenv("KY_REDIS_URL"),
		NATSURL:         os.Getenv("KY_NATS_URL"),
		AuthTokenSecret: os.Getenv("KY_AUTH_TOKEN_SECRET"),
		AISecretKey:     os.Getenv("KY_AI_SECRET_KEY"),
		InternalToken:   os.Getenv("KY_INTERNAL_SERVICE_TOKEN"),
		CodexBinary:     codexBinary,
		CodexWorkspace:  codexWorkspace,
	}
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
		if key == "" {
			continue
		}
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	return scanner.Err()
}
