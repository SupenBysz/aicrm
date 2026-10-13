package matcher

import (
	"strings"
	"testing"
)

func TestNormalizeExactURL(t *testing.T) {
	got, err := Normalize("HTTPS://SHOP.EXAMPLE.COM:443/product/list?b=2&a=1")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://shop.example.com/product/list?b=2&a=1" {
		t.Fatalf("normalized URL = %q", got)
	}
	if ok, err := Match("exact", got, "https://shop.example.com/product/list?b=2&a=1"); err != nil || !ok {
		t.Fatalf("exact match = %v, %v", ok, err)
	}
	for _, candidate := range []string{
		"https://other.example.com/product/list?b=2&a=1",
		"https://shop.example.com/product/list?b=2&a=2",
		"http://shop.example.com/product/list?b=2&a=1",
	} {
		if ok, err := Match("exact", got, candidate); err != nil || ok {
			t.Fatalf("exact false case %q = %v, %v", candidate, ok, err)
		}
	}
}

func TestWildcardDomainPathAndQueryBoundaries(t *testing.T) {
	cases := []struct {
		pattern, candidate string
		want               bool
	}{
		{"https://shop.example.com/product/*", "https://shop.example.com/product/list", true},
		{"https://shop.example.com/product/*", "https://shop.example.com/products/list", false},
		{"https://*.example.com/product/*", "https://shop.example.com/product/list", true},
		{"https://*.example.com/product/*", "https://evil.example.net/product/list", false},
		{"https://shop.example.com:8443/product/*", "https://shop.example.com/product/list", false},
		{"https://shop.example.com/product/*?tab=*", "https://shop.example.com/product/list?tab=detail", true},
		{"https://shop.example.com/product/*?tab=*", "https://shop.example.com/product/list?other=detail", false},
		{"https://fxg.jinritemai.com/login/common?channel=zhaoshang", "https://fxg.jinritemai.com/login/common?channel=zhaoshang", true},
		{"https://fxg.jinritemai.com/login/common?channel=zhaoshang", "https://fxg.jinritemai.com/login/common?channel=other", false},
	}
	for _, tc := range cases {
		got, err := Match("wildcard", tc.pattern, tc.candidate)
		if err != nil || got != tc.want {
			t.Errorf("Match(%q,%q) = %v, %v; want %v", tc.pattern, tc.candidate, got, err, tc.want)
		}
	}
}

func TestURLPatternValidation(t *testing.T) {
	bad := []struct {
		kind, pattern string
	}{
		{"exact", ""},
		{"exact", "/product/list"},
		{"exact", "https://example.com/*"},
		{"wildcard", "https://example.com/" + strings.Repeat("a", MaxPatternLength)},
		{"wildcard", "https://example.com/" + strings.Repeat("*", MaxWildcardCount+1)},
		{"wildcard", "https://example.com/\n*"},
		{"wildcard", "javascript:alert(1)*"},
	}
	for _, tc := range bad {
		if _, err := Validate(tc.kind, tc.pattern); err == nil {
			t.Errorf("Validate(%q,%q) unexpectedly succeeded", tc.kind, tc.pattern)
		}
	}
	if _, err := Normalize("https://example.com/a#fragment"); err == nil {
		t.Error("fragment URL unexpectedly succeeded")
	}
	if _, err := Normalize("https://user:pass@example.com/a"); err == nil {
		t.Error("userinfo URL unexpectedly succeeded")
	}
}

func TestWildcardWithoutStarIsLiteral(t *testing.T) {
	pattern, err := Validate("wildcard", "HTTPS://example.com/product")
	if err != nil || pattern != "https://example.com/product" {
		t.Fatalf("wildcard literal validation = %q, %v", pattern, err)
	}
	ok, err := Match("wildcard", pattern, "https://example.com/product")
	if err != nil || !ok {
		t.Fatalf("wildcard literal match = %v, %v", ok, err)
	}
}

func TestMatchRulePrefixAndIgnoreQuery(t *testing.T) {
	ok, err := MatchRule("prefix", "https://shop.example.com/product", "https://shop.example.com/product/list?tab=detail", false)
	if err != nil || !ok {
		t.Fatalf("prefix match = %v, %v", ok, err)
	}
	ok, err = MatchRule("prefix", "https://shop.example.com/product?old=1", "https://shop.example.com/product/list?new=2", true)
	if err != nil || !ok {
		t.Fatalf("ignore-query prefix match = %v, %v", ok, err)
	}
	if ok, err := MatchRule("prefix", "https://shop.example.com/product", "https://other.example.com/product/list", false); err != nil || ok {
		t.Fatalf("cross-domain prefix match = %v, %v", ok, err)
	}
	if _, err := ValidateRule("prefix", "https://shop.example.com/*"); err == nil {
		t.Fatal("prefix wildcard unexpectedly accepted")
	}
}
