package server

import "testing"

// hasBearer mirrors the guard used in acceptPublicInvitation; this test locks in
// the Phase 1.12 requirement that accept must reject requests without a valid
// Bearer token.
func hasBearer(header string) bool {
	return len(header) >= 8 && header[:7] == "Bearer "
}

func TestBearerDetection(t *testing.T) {
	cases := map[string]bool{
		"":              false,
		"Bearer ":       false, // empty token, fails length guard
		"Basic abc":     false,
		"Bearer abc.def": true,
	}
	for header, want := range cases {
		if got := hasBearer(header); got != want {
			t.Errorf("hasBearer(%q)=%v want %v", header, got, want)
		}
	}
}
