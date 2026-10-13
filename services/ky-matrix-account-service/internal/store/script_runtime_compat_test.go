package store

import (
	"os"
	"strings"
	"testing"
)

func TestScriptRuntimeCompatibilityLayerKeepsLegacyDouyinEntry(t *testing.T) {
	b, err := os.ReadFile("script_runtime_compat.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, want := range []string{
		"func (s *Store) ListDouyinRuntimeCandidates",
		`Platform: "douyin"`,
		`VersionPolicy: "active_only"`,
		"return s.ResolveScriptRuntime",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("compatibility contract missing %q", want)
		}
	}
}
