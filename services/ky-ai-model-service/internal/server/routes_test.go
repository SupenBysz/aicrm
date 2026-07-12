package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestBuildMuxNoRouteConflict guards against Go 1.22 ServeMux pattern conflicts,
// which panic only at route-registration time (never caught by build/vet/test of
// handlers). A nil-store Server is fine: routes are registered, not invoked.
func TestBuildMuxNoRouteConflict(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("route registration panicked (pattern conflict): %v", r)
		}
	}()
	s := &Server{}
	if s.buildMux() == nil {
		t.Fatal("buildMux returned nil")
	}
}

func TestLegacyAuthorizationRoutesRemainRegistered(t *testing.T) {
	mux := (&Server{}).buildMux()
	for _, path := range []string{
		"/api/v1/ai-executors/executor_1/authorize",
		"/api/v1/ai-executors/executor_1/auth-status",
	} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code == http.StatusNotFound {
			t.Fatalf("legacy compatibility route is not registered: %s", path)
		}
	}
}
