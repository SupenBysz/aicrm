package store

import (
	"strings"
	"testing"
)

// TestAuditScopeFilterPlaceholders documents that inPlaceholders produces a
// correct, sequential placeholder string for the audit actor_membership_id IN
// filter, given a starting argument count.
func TestAuditScopeFilterPlaceholders(t *testing.T) {
	// Simulate args already holding workspace_type, workspace_id (2 args).
	ph, args := inPlaceholders(2, []string{"mem_a", "mem_b"})
	if ph != "$3,$4" {
		t.Errorf("placeholders=%q want $3,$4", ph)
	}
	if len(args) != 2 || args[0] != "mem_a" || args[1] != "mem_b" {
		t.Errorf("unexpected args: %v", args)
	}
	// The IN clause should embed the placeholder string.
	clause := "actor_membership_id IN (" + ph + ")"
	if !strings.Contains(clause, "$3,$4") {
		t.Errorf("clause missing placeholders: %s", clause)
	}
}

// TestVisibleMembershipEmptySemantics documents that an unrestricted-but-no-target
// scope filter yields an empty target set (handler converts to empty slice ->
// audit returns no rows), while self/dept/team produce targets.
func TestVisibleMembershipEmptySemantics(t *testing.T) {
	if (ScopeFilter{}).hasAnyTarget() {
		t.Error("empty scope must have no targets (-> empty audit)")
	}
	if !(ScopeFilter{SelfMembershipID: "m"}).hasAnyTarget() {
		t.Error("self scope has a target")
	}
	if !(ScopeFilter{DepartmentIDs: []string{"d"}}).hasAnyTarget() {
		t.Error("dept scope has a target")
	}
	if !(ScopeFilter{TeamIDs: []string{"t"}}).hasAnyTarget() {
		t.Error("team scope has a target")
	}
}
