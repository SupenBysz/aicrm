package agencystats

import "testing"

func TestBudgets(t *testing.T) {
	if ValidIDs([]string{"a", "a"}, 100) || ValidIDs(nil, 100) {
		t.Fatal("invalid IDs accepted")
	}
	g := Group{ID: "a", Enterprises: []string{"e"}}
	if Validate([]Group{g}) != nil {
		t.Fatal("valid group rejected")
	}
	if Validate([]Group{g, g}) == nil {
		t.Fatal("duplicate groups accepted")
	}
	g.Enterprises = make([]string, 5001)
	if Validate([]Group{g}) == nil {
		t.Fatal("unbounded request")
	}
}
