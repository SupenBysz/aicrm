package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/config"
)

func TestInternalAccessDecisionRejectsUntrustedAndUnknownInputBeforeStore(t *testing.T) {
	server := New(config.Config{InternalToken: "internal-test-token"})

	request := httptest.NewRequest(http.MethodPost, "/internal/v1/access-decisions", strings.NewReader(`{}`))
	recorder := httptest.NewRecorder()
	server.internalAccessDecision(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/internal/v1/access-decisions", strings.NewReader(`{
		"actorId":"user_1","sessionId":"session_1","workspaceType":"platform","workspaceId":"platform_root",
		"requiredAllPermissions":["platform.ai_executors.update"],"unknown":true
	}`))
	request.Header.Set("X-KY-Internal-Token", "internal-test-token")
	request.Header.Set("X-KY-Request-Id", "req-internal-test")
	recorder = httptest.NewRecorder()
	server.internalAccessDecision(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "validation_error") {
		t.Fatalf("unknown input status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestAccessDecisionInputRequiresUniqueValidPermissions(t *testing.T) {
	base := accessDecisionInput{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
	}
	if !validAccessDecisionInput(base) {
		t.Fatal("membership-only decision should be valid")
	}
	base.RequiredAllPermissions = []string{"platform.ai_executors.update"}
	base.RequiredAnyPermissions = []string{"platform.ai_executors.update"}
	if validAccessDecisionInput(base) {
		t.Fatal("duplicate permission across AND/OR sets was accepted")
	}
	base.RequiredAnyPermissions = []string{"UPPERCASE.INVALID"}
	if validAccessDecisionInput(base) {
		t.Fatal("invalid permission code was accepted")
	}
}
