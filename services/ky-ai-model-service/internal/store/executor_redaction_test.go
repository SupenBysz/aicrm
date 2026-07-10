package store

import (
	"encoding/json"
	"testing"
)

func TestSanitizeExecutorResultSummaryRemovesBrowserCredentials(t *testing.T) {
	input := map[string]any{
		"platform": "douyin",
		"snapshot": map[string]any{
			"pageFingerprint": "page-1",
			"sensitiveContext": map[string]any{
				"cookies":      []any{map[string]any{"name": "sessionid", "value": "secret"}},
				"localStorage": map[string]any{"token": "secret"},
			},
			"loginSignals": map[string]any{"hasQr": true},
		},
		"scriptResult": map[string]any{
			"accountCandidate": map[string]any{
				"identityKey": "stable-account-id",
				"sessionid":   "must-not-survive",
			},
			"access_token": "must-not-survive",
		},
	}

	got := sanitizeExecutorResultSummary(input)
	snapshot := got["snapshot"].(map[string]any)
	if _, exists := snapshot["sensitiveContext"]; exists {
		t.Fatal("sensitiveContext must be removed")
	}
	if snapshot["pageFingerprint"] != "page-1" {
		t.Fatal("non-sensitive diagnostic fields must be retained")
	}
	result := got["scriptResult"].(map[string]any)
	if _, exists := result["access_token"]; exists {
		t.Fatal("access token must be removed")
	}
	candidate := result["accountCandidate"].(map[string]any)
	if _, exists := candidate["sessionid"]; exists {
		t.Fatal("session cookie aliases must be removed")
	}
	if candidate["identityKey"] != "stable-account-id" {
		t.Fatal("stable business identity must be retained")
	}
}

func TestSanitizeExecutorSummaryJSONProtectsLegacyRows(t *testing.T) {
	input := []byte(`{"snapshot":{"pageFingerprint":"page-1","sensitiveContext":{"cookies":[{"value":"secret"}]}}}`)
	var got map[string]any
	if err := json.Unmarshal(sanitizeExecutorSummaryJSON(input), &got); err != nil {
		t.Fatalf("decode sanitized summary: %v", err)
	}
	snapshot := got["snapshot"].(map[string]any)
	if _, exists := snapshot["sensitiveContext"]; exists {
		t.Fatal("legacy sensitive context must be hidden on read")
	}
}
