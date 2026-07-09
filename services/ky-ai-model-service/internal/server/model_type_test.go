package server

import "testing"

func TestPhase1ModelType(t *testing.T) {
	cases := map[string]bool{
		"text_generation": true,
		"embedding":       true,
		"vision":          true,
		"audio":           false,
		"":                false,
		"bogus":           false,
	}
	for in, want := range cases {
		if got := phase1ModelType(in); got != want {
			t.Errorf("phase1ModelType(%q)=%v want %v", in, got, want)
		}
	}
}

func TestValidStatusAI(t *testing.T) {
	if !validStatus("enabled", "enabled", "disabled") {
		t.Error("enabled should be valid")
	}
	if validStatus("frozen", "enabled", "disabled") {
		t.Error("frozen should be invalid for AI status")
	}
}
