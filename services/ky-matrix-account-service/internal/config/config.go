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
	AuthTokenSecret string
	AIModelBaseURL  string
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
		ServiceName:     serviceName,
		HTTPAddr:        addr,
		RuntimeEnvFile:  runtimeEnvFile,
		DatabaseURL:     os.Getenv("KY_TENANT_DATABASE_URL"),
		AuthTokenSecret: os.Getenv("KY_AUTH_TOKEN_SECRET"),
		AIModelBaseURL:  firstNonEmpty(os.Getenv("KY_AI_MODEL_SERVICE_URL"), "http://127.0.0.1:18086"),
		InternalToken:   os.Getenv("KY_INTERNAL_SERVICE_TOKEN"),
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
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
