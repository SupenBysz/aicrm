package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicStepResultsRejectTrustedSuccessWithServiceUnavailable(t *testing.T) {
	tests := []struct {
		methodKey string
		code      string
	}{
		{"session.snapshot.seal.v1", "trusted_runtime_proof_unavailable"},
		{"web_space.cleanup.v1", "trusted_runtime_proof_unavailable"},
		{"business.onboarding.complete.v1", "snapshot_verifier_unavailable"},
	}
	for _, tt := range tests {
		t.Run(tt.methodKey, func(t *testing.T) {
			body := `{"operationId":"operation-1","methodKey":"` + tt.methodKey + `","status":"success","verificationReceipt":"attacker-controlled"}`
			req := httptest.NewRequest(http.MethodPost, "/api/v1/matrix-account-login-attempts/attempt-1/step-results", strings.NewReader(body))
			req.SetPathValue("id", "attempt-1")
			response := httptest.NewRecorder()
			new(Server).submitLoginAttemptStepResult(response, req, wsContext{})
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Error.Code != tt.code {
				t.Fatalf("error code = %q", envelope.Error.Code)
			}
		})
	}
}

func TestPublicTrustedStepSuccessPolicyFailsClosed(t *testing.T) {
	tests := []struct {
		methodKey string
		code      string
	}{
		{"session.snapshot.seal.v1", "trusted_runtime_proof_unavailable"},
		{"web_space.cleanup.v1", "trusted_runtime_proof_unavailable"},
		{"business.onboarding.complete.v1", "snapshot_verifier_unavailable"},
	}
	for _, tt := range tests {
		code, _, blocked := publicTrustedStepSuccessBlock(tt.methodKey, "success")
		if !blocked || code != tt.code {
			t.Fatalf("method %s block = %q, %v", tt.methodKey, code, blocked)
		}
		if _, _, blocked := publicTrustedStepSuccessBlock(tt.methodKey, "failed"); blocked {
			t.Fatalf("method %s failure result must remain recordable", tt.methodKey)
		}
	}
	if _, _, blocked := publicTrustedStepSuccessBlock("account.identity.get.v1", "success"); blocked {
		t.Fatal("ordinary method success was blocked")
	}
}

func TestProjectLoginStepSummaryDropsCredentialMaterial(t *testing.T) {
	projected, ok := projectLoginStepSummary("account.identity.get.v1", map[string]any{
		"identityKey": "douyin-user-1",
		"nickname":    "Account One",
		"cookie":      "sessionid=secret",
		"token":       "secret",
		"localStorage": map[string]any{
			"auth": "secret",
		},
	})
	if !ok {
		t.Fatal("identity method was rejected")
	}
	if projected["identityKey"] != "douyin-user-1" {
		t.Fatalf("allowed identity fields were lost: %#v", projected)
	}
	if _, exists := projected["nickname"]; exists {
		t.Fatalf("profile fields must not be able to overwrite identity projection: %#v", projected)
	}
	for _, forbidden := range []string{"cookie", "token", "localStorage"} {
		if _, exists := projected[forbidden]; exists {
			t.Fatalf("forbidden field %q persisted: %#v", forbidden, projected)
		}
	}
}

func TestProjectLoginStepSummaryRejectsUnknownMethod(t *testing.T) {
	if projected, ok := projectLoginStepSummary("arbitrary.execute", map[string]any{"token": "secret"}); ok || projected != nil {
		t.Fatalf("unknown method projection = %#v, %v", projected, ok)
	}
}

func TestFailedLoginStepDoesNotRequireSuccessOutput(t *testing.T) {
	for _, methodKey := range []string{
		"login.status.probe.v1",
		"account.identity.get.v1",
		"session.snapshot.seal.v1",
		"web_space.cleanup.v1",
	} {
		projected, ok := normalizeLoginStepSummary(methodKey, "failed", map[string]any{
			"token":   "must-not-persist",
			"cleared": false,
		})
		if !ok {
			t.Fatalf("method %s should be recognized", methodKey)
		}
		if len(projected) != 0 {
			t.Fatalf("method %s projected unexpected failure data: %#v", methodKey, projected)
		}
	}
}

func TestProjectProfileSummaryCannotReplaceStableIdentity(t *testing.T) {
	projected, ok := projectLoginStepSummary("account.profile.get.v1", map[string]any{
		"identityKey": "attacker-controlled-id",
		"platformUid": "attacker-controlled-uid",
		"nickname":    "Account One",
		"avatarUrl":   "https://example.invalid/avatar.png",
	})
	if !ok {
		t.Fatal("profile method was rejected")
	}
	if _, exists := projected["identityKey"]; exists {
		t.Fatalf("profile result may not overwrite identity: %#v", projected)
	}
	if _, exists := projected["platformUid"]; exists {
		t.Fatalf("profile result may not overwrite platform uid: %#v", projected)
	}
	if projected["nickname"] != "Account One" {
		t.Fatalf("safe profile fields were lost: %#v", projected)
	}
}

func TestProjectProfileSummaryStripsURLCredentialsAndQuery(t *testing.T) {
	projected, ok := normalizeLoginStepSummary("account.profile.get.v1", "success", map[string]any{
		"avatarUrl": "https://cdn.example.invalid/avatar.png?token=secret#fragment",
		"homeUrl":   "javascript:alert(1)",
	})
	if ok {
		t.Fatalf("unsafe profile URL must reject the success result: %#v", projected)
	}

	projected, ok = normalizeLoginStepSummary("account.profile.get.v1", "success", map[string]any{
		"avatarUrl": "https://cdn.example.invalid/avatar.png?token=secret#fragment",
		"homeUrl":   "https://creator.example.invalid/account/123?ticket=secret#profile",
	})
	if !ok {
		t.Fatalf("safe public URLs should be accepted after normalization: %#v", projected)
	}
	if projected["avatarUrl"] != "https://cdn.example.invalid/avatar.png" ||
		projected["homeUrl"] != "https://creator.example.invalid/account/123" {
		t.Fatalf("URL credentials were not stripped: %#v", projected)
	}
}

func TestProjectBindingSummaryNormalizesFacadeShape(t *testing.T) {
	projected, ok := projectLoginStepSummary("business.binding.confirm.v1", map[string]any{
		"bindingDecision": "create_new",
		"businessAssignment": map[string]any{
			"ownerMemberId": "member-1",
			"remark":        "primary",
			"token":         "must-not-persist",
		},
	})
	if !ok {
		t.Fatal("binding method was rejected")
	}
	binding := projected["bindingInput"].(map[string]any)
	if binding["decision"] != "create_new" || binding["ownerMemberId"] != "member-1" {
		t.Fatalf("normalized binding = %#v", binding)
	}
	if _, exists := binding["token"]; exists {
		t.Fatalf("credential field persisted: %#v", binding)
	}
}

func TestAssignmentMutationIncludesExplicitClear(t *testing.T) {
	if hasAssignmentMutation(map[string]any{"decision": "attach_existing"}) {
		t.Fatal("binding decision alone must not be treated as an assignment mutation")
	}
	if !hasAssignmentMutation(map[string]any{"departmentId": ""}) {
		t.Fatal("explicitly clearing an assignment still requires update permission")
	}
}
