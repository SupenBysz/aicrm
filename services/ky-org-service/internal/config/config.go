package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	ServiceName          string
	HTTPAddr             string
	RuntimeEnvFile       string
	DatabaseURL          string
	RedisURL             string
	NATSURL              string
	AuthTokenSecret      string
	SecretKey            string
	StatisticsAuthURL    string
	MembershipURL        string
	InternalServiceToken string
	MembershipDNSName    string
	ServiceHealthURLs    map[string]string
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
		RedisURL:        os.Getenv("KY_REDIS_URL"),
		NATSURL:         os.Getenv("KY_NATS_URL"),
		AuthTokenSecret: os.Getenv("KY_AUTH_TOKEN_SECRET"),
		// Platform-wide secret for encrypting settings credentials (storage/SMS/email).
		// Falls back to KY_AI_SECRET_KEY so a single master key can serve both.
		SecretKey:            firstNonEmpty(os.Getenv("KY_SECRET_KEY"), os.Getenv("KY_AI_SECRET_KEY")),
		StatisticsAuthURL:    firstNonEmpty(os.Getenv("KY_AUTH_SERVICE_URL"), "http://127.0.0.1:18081"),
		MembershipURL:        firstNonEmpty(os.Getenv("KY_MEMBERSHIP_SERVICE_URL"), "http://127.0.0.1:18083"),
		InternalServiceToken: os.Getenv("KY_INTERNAL_SERVICE_TOKEN"),
		MembershipDNSName:    os.Getenv("KY_MEMBERSHIP_SERVICE_DNS_NAME"),
		ServiceHealthURLs: map[string]string{
			"auth":       os.Getenv("KY_AUTH_SERVICE_URL"),
			"org":        os.Getenv("KY_ORG_SERVICE_URL"),
			"membership": os.Getenv("KY_MEMBERSHIP_SERVICE_URL"),
			"matrix":     os.Getenv("KY_MATRIX_ACCOUNT_SERVICE_URL"),
			"ai-model":   os.Getenv("KY_AI_MODEL_SERVICE_URL"),
		},
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
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
		if key == "" {
			continue
		}
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	return scanner.Err()
}
