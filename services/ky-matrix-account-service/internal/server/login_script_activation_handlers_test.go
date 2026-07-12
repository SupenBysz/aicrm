package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestActivateLoginScriptVersionFailsClosedUntilContractTestsAreTrusted(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/matrix-account-login-scripts/script/versions/version/activate", nil)
	rec := httptest.NewRecorder()

	(&Server{}).activateLoginScriptVersion(rec, req, wsContext{})

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	if !strings.Contains(rec.Body.String(), "contract_test_unavailable") {
		t.Fatalf("response = %s, want contract_test_unavailable", rec.Body.String())
	}
}
