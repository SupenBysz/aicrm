package server

import "testing"

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
