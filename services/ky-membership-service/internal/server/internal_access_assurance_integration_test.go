package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func TestInternalAccessDecisionAssuranceAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_MEMBERSHIP_ASSURANCE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_MEMBERSHIP_ASSURANCE_TEST_DATABASE_URL for PostgreSQL integration")
	}
	control, err := store.Open(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	server := New(config.Config{InternalToken: "internal-assurance-test"})
	server.store = control

	requestBody := `{
		"actorId":"user_assurance_owner","sessionId":"session_assurance_owner_fresh",
		"workspaceType":"platform","workspaceId":"platform_root",
		"requiredAllPermissions":[],"requiredAnyPermissions":[],
		"assurance":{"requireWorkspaceOwner":true,"maxAuthenticationAgeSeconds":600,"requireMfaIfEnabled":true}
	}`
	recorder := performInternalAssuranceRequest(t, server, requestBody)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var envelope struct {
		Data store.AccessDecision `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.Data.Allowed || envelope.Data.Assurance == nil || !envelope.Data.Assurance.Verified ||
		!envelope.Data.Assurance.WorkspaceOwner || envelope.Data.Assurance.AuthenticatedAt == "" {
		t.Fatalf("decision=%#v", envelope.Data)
	}

	legacyBody := `{
		"actorId":"user_assurance_owner","sessionId":"session_assurance_owner_fresh",
		"workspaceType":"platform","workspaceId":"platform_root",
		"requiredAllPermissions":[],"requiredAnyPermissions":[]
	}`
	legacy := performInternalAssuranceRequest(t, server, legacyBody)
	if legacy.Code != http.StatusOK || strings.Contains(legacy.Body.String(), `"assurance"`) {
		t.Fatalf("legacy status=%d body=%s", legacy.Code, legacy.Body.String())
	}

	adminBody := strings.ReplaceAll(requestBody, "user_assurance_owner", "user_assurance_admin")
	adminBody = strings.ReplaceAll(adminBody, "session_assurance_owner_fresh", "session_assurance_admin_fresh")
	admin := performInternalAssuranceRequest(t, server, adminBody)
	if admin.Code != http.StatusOK || !strings.Contains(admin.Body.String(), `"reasonCode":"owner_required"`) {
		t.Fatalf("admin status=%d body=%s", admin.Code, admin.Body.String())
	}
}

func performInternalAssuranceRequest(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/access-decisions", strings.NewReader(body))
	request.Header.Set("X-KY-Internal-Token", "internal-assurance-test")
	request.Header.Set("X-KY-Request-Id", "req-assurance-integration")
	recorder := httptest.NewRecorder()
	server.internalAccessDecision(recorder, request)
	return recorder
}
