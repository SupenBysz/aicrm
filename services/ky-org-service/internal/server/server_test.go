package server

import "testing"

func TestTypeAllowed(t *testing.T) {
	cases := []struct {
		allowed string
		wsType  string
		want    bool
	}{
		{"platform", "platform", true},
		{"platform", "agency", false},
		{"agency,enterprise", "agency", true},
		{"agency,enterprise", "enterprise", true},
		{"agency,enterprise", "platform", false},
		{"", "platform", false},
	}
	for _, c := range cases {
		if got := typeAllowed(c.allowed, c.wsType); got != c.want {
			t.Errorf("typeAllowed(%q,%q)=%v want %v", c.allowed, c.wsType, got, c.want)
		}
	}
}

func TestValidStatus(t *testing.T) {
	if !validStatus("normal", "normal", "disabled", "frozen") {
		t.Error("normal should be valid")
	}
	if validStatus("bogus", "normal", "disabled", "frozen") {
		t.Error("bogus should be invalid")
	}
}

func TestNormalize(t *testing.T) {
	if normalize("") != "normal" {
		t.Error("empty status should normalize to normal")
	}
	if normalize("disabled") != "disabled" {
		t.Error("explicit status should be preserved")
	}
}
