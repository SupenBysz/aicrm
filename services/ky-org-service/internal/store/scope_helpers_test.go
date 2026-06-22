package store

import (
	"reflect"
	"testing"
)

func TestScopeInPlaceholders(t *testing.T) {
	ph, args := scopeInPlaceholders(2, []string{"a", "b", "c"})
	if ph != "$3,$4,$5" {
		t.Errorf("placeholders=%q want $3,$4,$5", ph)
	}
	if len(args) != 3 || args[0] != "a" || args[2] != "c" {
		t.Errorf("unexpected args: %v", args)
	}
	if p, a := scopeInPlaceholders(0, nil); p != "" || len(a) != 0 {
		t.Errorf("empty input should yield empty, got %q / %v", p, a)
	}
}

func TestScopeSetOps(t *testing.T) {
	set := map[string]struct{}{}
	scopeAddAll(set, []string{"a", "b", "", "a"})
	if len(set) != 2 {
		t.Errorf("expected 2 unique non-empty, got %d", len(set))
	}
	keys := scopeKeys(set)
	if len(keys) != 2 {
		t.Errorf("keys len=%d want 2", len(keys))
	}
}

func TestJSONToStrings(t *testing.T) {
	if got := jsonToStrings(nil); len(got) != 0 {
		t.Errorf("nil -> empty, got %v", got)
	}
	if got := jsonToStrings([]byte("[]")); len(got) != 0 {
		t.Errorf("[] -> empty, got %v", got)
	}
	got := jsonToStrings([]byte(`["x","y"]`))
	if !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Errorf("unexpected: %v", got)
	}
}
