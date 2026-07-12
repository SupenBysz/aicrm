package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

func TestLegacyExecutorProjectionRedactsSensitiveState(t *testing.T) {
	item := store.ExecutorConfig{
		ID:               "executor_1",
		AppServerListen:  "ws://127.0.0.1:4500",
		AuthStatus:       "authorizing",
		AuthMethod:       "path:/root/.codex",
		AuthAccountLabel: "private-user@example.com",
		BoundDeviceID:    "device_private_identifier",
		Capabilities: json.RawMessage(`{
			"supportsAppServerAuth":true,
			"supportsTaskTransport":false,
			"codexHome":"/root/.codex",
			"statusText":"logged in using private-user@example.com",
			"probes":[{"command":"codex exec"}],
			"userCode":"ABCD-EFGH"
		}`),
	}

	projection := toLegacyExecutorConfigProjection(item)
	if projection.AppServerListen != "stdio://" {
		t.Fatalf("appServerListen = %q, want stdio://", projection.AppServerListen)
	}
	if projection.AuthStatus != "not_authorized" {
		t.Fatalf("authStatus = %q, want not_authorized", projection.AuthStatus)
	}
	if projection.AuthMethod != "" {
		t.Fatalf("unsafe auth method survived projection: %q", projection.AuthMethod)
	}
	if projection.AuthAccountLabel == "" || strings.Contains(projection.AuthAccountLabel, "private-user") {
		t.Fatalf("account summary was not irreversibly redacted: %q", projection.AuthAccountLabel)
	}
	if len(projection.Capabilities) != 2 || !projection.Capabilities["supportsAppServerAuth"] {
		t.Fatalf("unexpected capability projection: %#v", projection.Capabilities)
	}
	if projection.Capabilities["supportsTaskTransport"] {
		t.Fatalf("false capability changed value: %#v", projection.Capabilities)
	}

	encoded, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}
	serialized := string(encoded)
	for _, forbidden := range []string{
		"boundDeviceId",
		"device_private_identifier",
		"private-user@example.com",
		"codexHome",
		"/root/.codex",
		"statusText",
		"probes",
		"userCode",
		"codex exec",
		"ws://",
	} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("projection contains forbidden legacy material %q: %s", forbidden, serialized)
		}
	}
}

func TestLegacyExecutorProjectionKeepsOnlyExplicitBooleanCapabilities(t *testing.T) {
	projection := toLegacyExecutorConfigProjection(store.ExecutorConfig{
		Capabilities: json.RawMessage(`{
			"supportsReadiness":true,
			"supportsModelCatalog":"true",
			"supportsUnknownCapability":true
		}`),
	})
	if len(projection.Capabilities) != 1 || !projection.Capabilities["supportsReadiness"] {
		t.Fatalf("unexpected capability allowlist result: %#v", projection.Capabilities)
	}
}
