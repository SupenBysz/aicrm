package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

func TestLegacyExecutorAuthStatusEndpointGoneBeforeDecode(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-executors/executor_1/auth-status", strings.NewReader(`{
		"authStatus":"authorized",
		"authAccountLabel":"must-not-persist",
		"capabilities":{"codexHome":"/root/.codex"}
	}`))
	req.SetPathValue("id", "executor_1")
	rec := httptest.NewRecorder()

	s.syncExecutorAuthStatus(rec, req, wsContext{UserID: "user_1"})

	if rec.Code != http.StatusGone {
		t.Fatalf("auth-status response status = %d, want %d", rec.Code, http.StatusGone)
	}
	assertLegacyAuthorizationHeaders(t, rec)
	assertErrorCode(t, rec.Body.String(), "legacy_endpoint_gone")
	assertNoLegacyAuthorizationMaterial(t, rec.Body.String())
}

func TestLegacyExecutorAuthorizeFailsClosedWithoutProbe(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-executors/executor_1/authorize", nil)
	req.SetPathValue("id", "executor_1")
	rec := httptest.NewRecorder()

	s.authorizeExecutor(rec, req, wsContext{UserID: "user_1"})

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("authorize response status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	assertLegacyAuthorizationHeaders(t, rec)
	assertErrorCode(t, rec.Body.String(), "executor_authorization_unavailable")
	assertNoLegacyAuthorizationMaterial(t, rec.Body.String())
}

func TestLegacyExecutorAuthorizeRejectsLegacyBody(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-executors/executor_1/authorize", strings.NewReader(`{
		"authStatus":"authorized",
		"codexHome":"/root/.codex"
	}`))
	req.SetPathValue("id", "executor_1")
	rec := httptest.NewRecorder()

	s.authorizeExecutor(rec, req, wsContext{UserID: "user_1"})

	if rec.Code != http.StatusUpgradeRequired {
		t.Fatalf("legacy authorize body response status = %d, want %d", rec.Code, http.StatusUpgradeRequired)
	}
	assertLegacyAuthorizationHeaders(t, rec)
	assertErrorCode(t, rec.Body.String(), "desktop_bridge_upgrade_required")
	assertNoLegacyAuthorizationMaterial(t, rec.Body.String())
}

func TestLegacyCodexExecutorConfigPatchIsGoneBeforeDecode(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/ai-executors/codex", strings.NewReader(`{
		"appServerListen":"ws://127.0.0.1:4500",
		"capabilities":{"codexHome":"/root/.codex"}
	}`))
	rec := httptest.NewRecorder()

	s.updateExecutorConfig(rec, req, wsContext{UserID: "user_1"})

	if rec.Code != http.StatusGone {
		t.Fatalf("legacy config PATCH response status = %d, want %d", rec.Code, http.StatusGone)
	}
	assertLegacyAuthorizationHeaders(t, rec)
	assertErrorCode(t, rec.Body.String(), "legacy_endpoint_gone")
	assertNoLegacyAuthorizationMaterial(t, rec.Body.String())
	if strings.Contains(rec.Body.String(), "ws://") {
		t.Fatalf("legacy config PATCH echoed unsafe transport: %s", rec.Body.String())
	}
}

func TestServerCodexHomeCandidatesOnlyUsesExecutorOwnedPath(t *testing.T) {
	t.Setenv("CODEX_HOME", "/tmp/global-codex-home-must-be-ignored")
	s := &Server{}
	candidates := s.serverCodexHomeCandidates(store.ExecutorConfig{
		ID:           "executor_1",
		Capabilities: json.RawMessage(`{"codexHome":"/root/.codex"}`),
	})
	if len(candidates) != 1 {
		t.Fatalf("candidate count = %d, want 1: %#v", len(candidates), candidates)
	}
	if candidates[0].CodexHome != "/data/kyai_crm/codex-executors/executor_1" || candidates[0].Source != "executor" {
		t.Fatalf("unexpected executor-owned candidate: %#v", candidates[0])
	}

	unsafeIDHome := serverCodexHome("../../root")
	if !strings.HasPrefix(unsafeIDHome, "/data/kyai_crm/codex-executors/") || strings.Contains(unsafeIDHome, "..") {
		t.Fatalf("unsafe executor id escaped owned root: %q", unsafeIDHome)
	}
}

func assertLegacyAuthorizationHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("Deprecation") != "true" {
		t.Fatalf("Deprecation = %q, want true", rec.Header().Get("Deprecation"))
	}
}

func assertErrorCode(t *testing.T, body, expected string) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatalf("decode response: %v; body=%q", err, body)
	}
	if envelope.Error.Code != expected {
		t.Fatalf("error.code = %q, want %q", envelope.Error.Code, expected)
	}
}

func assertNoLegacyAuthorizationMaterial(t *testing.T, body string) {
	t.Helper()
	for _, forbidden := range []string{"codexHome", "CODEX_HOME", "/root/.codex", "verificationUri", "userCode", "\"command\""} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("response contains forbidden legacy authorization material %q: %s", forbidden, body)
		}
	}
}
