package store

import (
	"encoding/json"
	"testing"
	"time"
)

func TestValidateExecutableLoginScriptDSLAllowsPublicActions(t *testing.T) {
	raw := json.RawMessage(`{
		"version":1,
		"purpose":"account_detect",
		"steps":[
			{"action":"clickText"},
			{"action":"clickSelector"},
			{"action":"wait"},
			{"action":"waitForElement"},
			{"action":"captureElement"},
			{"action":"readText"},
			{"action":"navigateAllowedUrl"}
		]
	}`)
	if err := validateExecutableLoginScriptDSL(raw, "account_detect"); err != nil {
		t.Fatalf("expected public DSL to pass validation: %v", err)
	}
}

func TestValidateExecutableLoginScriptDSLRejectsSensitiveAndUnknownActions(t *testing.T) {
	for _, action := range []string{"readStorage", "readIndexedDB", "executeJavaScript"} {
		t.Run(action, func(t *testing.T) {
			raw := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"` + action + `"}]}`)
			if err := validateExecutableLoginScriptDSL(raw, "account_detect"); err != ErrValidation {
				t.Fatalf("expected %s to fail validation, got %v", action, err)
			}
		})
	}
}

func TestValidateExecutableLoginScriptDSLRejectsPurposeMismatch(t *testing.T) {
	raw := json.RawMessage(`{"version":1,"purpose":"session_check","steps":[{"action":"readText"}]}`)
	if err := validateExecutableLoginScriptDSL(raw, "account_detect"); err != ErrValidation {
		t.Fatalf("expected purpose mismatch to fail validation, got %v", err)
	}
}

func TestExactLegacyCredentialAdapterRequiresVersionHashAndDeadline(t *testing.T) {
	raw := json.RawMessage(`{
		"purpose":"account_detect",
		"steps":[
			{"resultKey":"platformUid","storage":"cookie","key":"uid_tt","action":"readStorage"},
			{"storage":"cookie","action":"readStorage","resultKey":"identityKey","key":"sessionid"},
			{"key":"all","resultKey":"profileText","action":"readStorage","storage":"localStorage"}
		],
		"version":1
	}`)
	before := time.Date(2026, 7, 10, 19, 40, 0, 0, time.FixedZone("UTC+8", 8*60*60))
	if !isExactLegacyCredentialAdapter(legacyDouyinAccountDetectVersionID, raw, before) {
		t.Fatal("expected exact legacy adapter to match")
	}
	if isExactLegacyCredentialAdapter("malsv_other", raw, before) {
		t.Fatal("expected a different version to be rejected")
	}
	modified := json.RawMessage(`{"version":1,"purpose":"account_detect","steps":[{"action":"readStorage","storage":"cookie","key":"token"}]}`)
	if isExactLegacyCredentialAdapter(legacyDouyinAccountDetectVersionID, modified, before) {
		t.Fatal("expected a modified payload to be rejected")
	}
	after := time.Date(2026, 8, 1, 0, 0, 0, 0, time.FixedZone("UTC+8", 8*60*60))
	if isExactLegacyCredentialAdapter(legacyDouyinAccountDetectVersionID, raw, after) {
		t.Fatal("expected the expired adapter to be rejected")
	}
}
