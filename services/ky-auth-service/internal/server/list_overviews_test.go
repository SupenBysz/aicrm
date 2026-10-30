package server

import (
	"net/url"
	"testing"
)

func TestLogFilterCompatibility(t *testing.T) {
	for _, raw := range []string{"startAt=2026-01-01T00:00:00Z&endBefore=2026-01-02T00:00:00Z", "startAt=2026-01-01T08:00:00%2B08:00&endBefore=2026-01-02T08:00:00%2B08:00&result=failed&account=Alice"} {
		q, _ := url.ParseQuery(raw)
		if _, err := parseLoginLogFilters(q, true); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{"", "page=1", "startAt=2026-01-01T00:00:00Z&endBefore=2026-01-01T00:00:00Z", "startAt=2026-01-01T00:00:00Z&endBefore=2026-03-01T00:00:00Z", "startAt=invalid&endBefore=invalid", "startAt=2026-01-01T00:00:00Z&endBefore=2026-01-02T00:00:00Z&endAt=2026-01-02T00:00:00Z", "startAt=2026-01-01T00:00:00Z&endBefore=2026-01-02T00:00:00Z&result=unsafe"} {
		q, _ := url.ParseQuery(raw)
		if _, err := parseLoginLogFilters(q, true); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	q := url.Values{"startAt": {"2020-01-01T00:00:00Z"}, "endAt": {"2026-01-01T00:00:00Z"}}
	f, err := parseLoginLogFilters(q, false)
	if err != nil || f.EndAt == "" || f.EndBefore != "" {
		t.Fatal("legacy range restricted", f, err)
	}
}
