package store

import (
	"reflect"
	"testing"
)

func TestJSONRoundTrip(t *testing.T) {
	cases := [][]string{
		{},
		{"a"},
		{"role_1", "role_2", "role_3"},
	}
	for _, in := range cases {
		got := jsonToStrings([]byte(stringsToJSON(in)))
		if len(in) == 0 {
			if len(got) != 0 {
				t.Errorf("expected empty, got %v", got)
			}
			continue
		}
		if !reflect.DeepEqual(got, in) {
			t.Errorf("round trip mismatch: in=%v got=%v", in, got)
		}
	}
}

func TestJSONToStringsEmpty(t *testing.T) {
	if got := jsonToStrings(nil); len(got) != 0 {
		t.Errorf("nil should yield empty slice, got %v", got)
	}
	if got := jsonToStrings([]byte("")); len(got) != 0 {
		t.Errorf("empty bytes should yield empty slice, got %v", got)
	}
}

func TestSplitIDs(t *testing.T) {
	if got := splitIDs(""); len(got) != 0 {
		t.Errorf("empty should split to empty, got %v", got)
	}
	got := splitIDs("a,b,c")
	if !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("unexpected split: %v", got)
	}
}
