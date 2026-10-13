package store

import "testing"

func TestNormalizeDouyinMatchRulesLegacyAndPrefix(t *testing.T) {
	rules, err := normalizeDouyinMatchRules(nil, "exact", "https://example.com/path")
	if err != nil || len(rules) != 1 || rules[0].Pattern != "https://example.com/path" {
		t.Fatalf("legacy rule = %#v, err=%v", rules, err)
	}
	rules, err = normalizeDouyinMatchRules([]DouyinMatchRule{
		{ID: "prefix", MatchType: "prefix", Pattern: "https://example.com/product", Enabled: true},
		{ID: "queryless", MatchType: "exact", Pattern: "https://example.com/home?x=1", IgnoreQuery: true, Enabled: true},
	}, "", "")
	if err != nil || len(rules) != 2 {
		t.Fatalf("rules = %#v, err=%v", rules, err)
	}
}

func TestNormalizeDouyinMatchRulesRejectsDuplicateAndDisabled(t *testing.T) {
	for name, rules := range map[string][]DouyinMatchRule{
		"duplicate": {
			{MatchType: "exact", Pattern: "https://example.com", Enabled: true},
			{MatchType: "exact", Pattern: "https://example.com", Enabled: true},
		},
		"disabled": {{MatchType: "exact", Pattern: "https://example.com", Enabled: false}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeDouyinMatchRules(rules, "", ""); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestMatchDouyinRulesAnyEnabled(t *testing.T) {
	rules := []DouyinMatchRule{
		{MatchType: "exact", Pattern: "https://example.com/never", Enabled: true},
		{MatchType: "prefix", Pattern: "https://example.com/product", Enabled: true},
	}
	matched, err := matchDouyinRules(rules, "", "", "https://example.com/product/list?sku=1")
	if err != nil || !matched {
		t.Fatalf("matched=%v err=%v", matched, err)
	}
}
