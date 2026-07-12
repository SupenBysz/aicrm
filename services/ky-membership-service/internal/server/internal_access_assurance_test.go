package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/config"
)

func TestAccessDecisionAssuranceInputIsStrictAndBounded(t *testing.T) {
	base := accessDecisionInput{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Assurance: &accessDecisionAssuranceInput{
			RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: 600, RequireMFAIfEnabled: true,
		},
	}
	if !validAccessDecisionInput(base) {
		t.Fatal("locked high-risk assurance input was rejected")
	}
	tests := []struct {
		name   string
		mutate func(*accessDecisionAssuranceInput)
	}{
		{"empty", func(value *accessDecisionAssuranceInput) { *value = accessDecisionAssuranceInput{} }},
		{"negative age", func(value *accessDecisionAssuranceInput) { value.MaxAuthenticationAgeSeconds = -1 }},
		{"excessive age", func(value *accessDecisionAssuranceInput) { value.MaxAuthenticationAgeSeconds = 86401 }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			input := base
			copyAssurance := *base.Assurance
			input.Assurance = &copyAssurance
			testCase.mutate(input.Assurance)
			if validAccessDecisionInput(input) {
				t.Fatal("invalid assurance input was accepted")
			}
		})
	}
}

func TestInternalAccessDecisionRejectsUnknownNestedAssuranceField(t *testing.T) {
	server := New(config.Config{InternalToken: "internal-test-token"})
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/access-decisions", strings.NewReader(`{
		"actorId":"user_1","sessionId":"session_1","workspaceType":"platform","workspaceId":"platform_root",
		"requiredAllPermissions":[],"requiredAnyPermissions":[],
		"assurance":{"requireWorkspaceOwner":true,"maxAuthenticationAgeSeconds":600,"requireMfaIfEnabled":true,"forged":true}
	}`))
	request.Header.Set("X-KY-Internal-Token", "internal-test-token")
	request.Header.Set("X-KY-Request-Id", "req-assurance-strict")
	recorder := httptest.NewRecorder()
	server.internalAccessDecision(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "validation_error") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
