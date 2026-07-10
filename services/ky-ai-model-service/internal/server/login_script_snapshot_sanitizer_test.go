package server

import (
	"encoding/json"
	"testing"
)

func TestSanitizeLoginScriptSnapshotRemovesSessionMaterial(t *testing.T) {
	input := map[string]any{
		"pageFingerprint":  "page-1",
		"browserPartition": "persist:secret",
		"sensitiveContext": map[string]any{
			"cookies": []any{map[string]any{"name": "sessionid", "value": "secret"}},
		},
		"domSummary": map[string]any{
			"selector":     "#qr-code",
			"access_token": "secret",
		},
	}

	got := sanitizeLoginScriptSnapshot(input)
	if got["pageFingerprint"] != "page-1" {
		t.Fatal("page fingerprint must be retained")
	}
	if _, exists := got["browserPartition"]; exists {
		t.Fatal("browser partition must not be sent to the model")
	}
	if _, exists := got["sensitiveContext"]; exists {
		t.Fatal("sensitive context must not be sent to the model")
	}
	dom := got["domSummary"].(map[string]any)
	if _, exists := dom["access_token"]; exists {
		t.Fatal("nested tokens must be removed")
	}
	if dom["selector"] != "#qr-code" {
		t.Fatal("safe DOM diagnostics must be retained")
	}
}

func TestBuildLoginScriptMessagesDoesNotSendScreenshotByDefault(t *testing.T) {
	t.Setenv("AICRM_ALLOW_AI_LOGIN_SCREENSHOTS", "")
	messages := buildLoginScriptMessages("prompt", "vision", json.RawMessage(`{"screenshotDataUrl":"data:image/png;base64,secret"}`))
	if len(messages) != 1 {
		t.Fatalf("expected one message, got %d", len(messages))
	}
	content, ok := messages[0]["content"].(string)
	if !ok || content != "prompt" {
		t.Fatalf("screenshot must not be attached by default: %#v", messages[0]["content"])
	}
}
