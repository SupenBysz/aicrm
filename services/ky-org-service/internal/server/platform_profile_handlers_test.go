package server

import "testing"

func TestValidPlatformLogoStyle(t *testing.T) {
	for _, tc := range []struct {
		name   string
		size   int
		family string
		weight int
		want   bool
	}{
		{"默认长Logo", 16, "system", 600, true},
		{"默认短Logo", 14, "system", 600, true},
		{"最小字号", 8, "sans", 400, true},
		{"最大字号", 72, "mono", 700, true},
		{"字号过小", 7, "system", 600, false},
		{"字号过大", 73, "system", 600, false},
		{"未知字体", 16, "user-css", 600, false},
		{"未知字重", 16, "system", 450, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validPlatformLogoStyle(tc.size, tc.weight, tc.family); got != tc.want {
				t.Fatalf("validPlatformLogoStyle(%d, %q, %d) = %v, want %v", tc.size, tc.family, tc.weight, got, tc.want)
			}
		})
	}
}
