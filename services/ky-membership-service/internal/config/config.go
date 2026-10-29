package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	AuthServiceURL  string
	OrgServiceURL   string
	ServiceName     string
	HTTPAddr        string
	RuntimeEnvFile  string
	DatabaseURL     string
	RedisURL        string
	NATSURL         string
	AuthTokenSecret string
	InternalToken   string
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

	return Config{
		AuthServiceURL:  os.Getenv("KY_AUTH_SERVICE_URL"),
		OrgServiceURL:   os.Getenv("KY_ORG_SERVICE_URL"),
		ServiceName:     serviceName,
		HTTPAddr:        addr,
		RuntimeEnvFile:  runtimeEnvFile,
		DatabaseURL:     os.Getenv("KY_TENANT_DATABASE_URL"),
		RedisURL:        os.Getenv("KY_REDIS_URL"),
		NATSURL:         os.Getenv("KY_NATS_URL"),
		AuthTokenSecret: os.Getenv("KY_AUTH_TOKEN_SECRET"),
		InternalToken:   os.Getenv("KY_INTERNAL_SERVICE_TOKEN"),
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
