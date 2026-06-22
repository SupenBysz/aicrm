package store

import "testing"

func TestMemberVisible(t *testing.T) {
	m := Member{ID: "mem_1", DepartmentIDs: []string{"dep_a"}, TeamIDs: []string{"team_x"}}

	cases := []struct {
		name  string
		scope ScopeFilter
		want  bool
	}{
		{"unrestricted", ScopeFilter{Unrestricted: true}, true},
		{"self match", ScopeFilter{SelfMembershipID: "mem_1"}, true},
		{"self no match", ScopeFilter{SelfMembershipID: "mem_2"}, false},
		{"dept match", ScopeFilter{DepartmentIDs: []string{"dep_a", "dep_b"}}, true},
		{"dept no match", ScopeFilter{DepartmentIDs: []string{"dep_z"}}, false},
		{"team match", ScopeFilter{TeamIDs: []string{"team_x"}}, true},
		{"team no match", ScopeFilter{TeamIDs: []string{"team_z"}}, false},
		{"empty scope", ScopeFilter{}, false},
		{"union dept+self, self wins", ScopeFilter{SelfMembershipID: "mem_1", DepartmentIDs: []string{"dep_z"}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := memberVisible(m, c.scope); got != c.want {
				t.Errorf("memberVisible=%v want %v", got, c.want)
			}
		})
	}
}

func TestIntersects(t *testing.T) {
	if intersects(nil, []string{"a"}) {
		t.Error("nil should not intersect")
	}
	if intersects([]string{"a"}, nil) {
		t.Error("empty b should not intersect")
	}
	if !intersects([]string{"a", "b"}, []string{"b", "c"}) {
		t.Error("shared element should intersect")
	}
	if intersects([]string{"a"}, []string{"b"}) {
		t.Error("disjoint should not intersect")
	}
}

func TestInPlaceholders(t *testing.T) {
	ph, args := inPlaceholders(2, []string{"x", "y", "z"})
	if ph != "$3,$4,$5" {
		t.Errorf("placeholders=%q want $3,$4,$5", ph)
	}
	if len(args) != 3 || args[0] != "x" || args[2] != "z" {
		t.Errorf("unexpected args: %v", args)
	}
}

func TestScopeFilterHasAnyTarget(t *testing.T) {
	if (ScopeFilter{}).hasAnyTarget() {
		t.Error("empty filter has no target")
	}
	if !(ScopeFilter{SelfMembershipID: "m"}).hasAnyTarget() {
		t.Error("self is a target")
	}
	if !(ScopeFilter{DepartmentIDs: []string{"d"}}).hasAnyTarget() {
		t.Error("dept is a target")
	}
}
