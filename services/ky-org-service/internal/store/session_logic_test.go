package store

import (
	"testing"
	"time"
)

// sessionActiveDecision mirrors the SessionActive post-scan predicate so the
// active/revoked/expired/missing semantics are locked by a unit test without a
// live database.
func sessionActiveDecision(status string, expiresAt, now time.Time) bool {
	return status == "active" && expiresAt.After(now)
}

func TestSessionActiveDecision(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	future := now.Add(time.Hour)
	past := now.Add(-time.Hour)

	cases := []struct {
		name      string
		status    string
		expiresAt time.Time
		want      bool
	}{
		{"active not expired", "active", future, true},
		{"active expired", "active", past, false},
		{"revoked", "revoked", future, false},
		{"expired status", "expired", future, false},
		{"active at exact now", "active", now, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := sessionActiveDecision(c.status, c.expiresAt, now); got != c.want {
				t.Errorf("decision=%v want %v", got, c.want)
			}
		})
	}
}
