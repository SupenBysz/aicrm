package store

import (
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func boolPtr(v bool) *bool { return &v }
func intPtr(v int) *int    { return &v }

func TestPublicStyleInputValidationAndHashes(t *testing.T) {
	in, err := normalizePublicStyleInput(PublicStyleInput{
		Name:          "样式",
		Identifier:    "PUBLIC_STYLE",
		MatchType:     "wildcard",
		MatchURL:      "https://shop.example.com/*",
		SourceContent: "body { color: 红; }",
		Enabled:       boolPtr(true),
		Priority:      intPtr(0),
	}, true)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if in.Enabled == nil || !*in.Enabled || in.RunAt != "document_start" || in.Priority == nil || *in.Priority != 0 {
		t.Fatalf("defaults not applied: %+v", in)
	}
	if got := utf8.RuneCountInString(in.SourceContent); got != 18 || len([]byte(in.SourceContent)) <= got || len(publicStyleHash(in.SourceContent)) != 64 {
		t.Fatalf("source metadata mismatch: %d", got)
	}
	for _, bad := range []PublicStyleInput{
		{Identifier: "bad id", MatchType: "exact", MatchURL: "https://example.com/", SourceContent: "x"},
		{Identifier: "PUBLIC_STYLE", MatchType: "bad", MatchURL: "https://example.com/", SourceContent: "x"},
		{Identifier: "PUBLIC_STYLE", MatchType: "exact", MatchURL: "", SourceContent: "x"},
	} {
		if _, err := normalizePublicStyleInput(bad, true); err == nil {
			t.Fatalf("expected validation error for %+v", bad)
		}
	}
}

func TestPublicStyleMigrationIsIdempotentAndIndependent(t *testing.T) {
	data, err := os.ReadFile("../../../../ops/db/099_matrix_account_public_styles.sql")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, token := range []string{
		"ky_matrix_account_public_style",
		"CREATE TABLE IF NOT EXISTS",
		"ON CONFLICT",
		"source_sha256",
		"run_at",
		"priority",
		"enabled",
	} {
		if !strings.Contains(text, token) {
			t.Fatalf("migration missing %q", token)
		}
	}
	if strings.Contains(text, "ky_matrix_account_douyin_script_asset_version") {
		t.Fatal("public style migration must not reuse private asset table")
	}
}
