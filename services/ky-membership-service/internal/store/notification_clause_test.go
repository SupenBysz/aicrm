package store

import (
	"strings"
	"testing"
)

func TestVisibilityClausePlaceholders(t *testing.T) {
	args := []any{}
	clause := visibilityClause("user_1", "agency", "ag_1", &args)
	if len(args) != 3 {
		t.Fatalf("expected 3 args, got %d", len(args))
	}
	if args[0] != "user_1" || args[1] != "agency" || args[2] != "ag_1" {
		t.Fatalf("unexpected args: %v", args)
	}
	for _, p := range []string{"$1", "$2", "$3"} {
		if !strings.Contains(clause, p) {
			t.Errorf("clause missing placeholder %s: %s", p, clause)
		}
	}
	if !strings.Contains(clause, "scope_type='platform'") {
		t.Errorf("clause must include platform broadcast: %s", clause)
	}
}

func TestVisibilityClauseAppendsToExistingArgs(t *testing.T) {
	args := []any{"existing"}
	clause := visibilityClause("u", "platform", "platform_root", &args)
	if len(args) != 4 {
		t.Fatalf("expected 4 args, got %d", len(args))
	}
	// placeholders should be $2,$3,$4 since one arg pre-existed
	for _, p := range []string{"$2", "$3", "$4"} {
		if !strings.Contains(clause, p) {
			t.Errorf("clause missing placeholder %s: %s", p, clause)
		}
	}
}
