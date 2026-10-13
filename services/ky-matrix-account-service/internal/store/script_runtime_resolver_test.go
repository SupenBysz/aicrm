package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/matcher"
)

func TestScriptRuntimeAssetDiagnosticsReportsMissingActiveResource(t *testing.T) {
	got := scriptRuntimeAssetDiagnostics("script-1", "")
	if len(got) != 1 || got[0] != "missing_active_style_asset" {
		t.Fatalf("diagnostics=%v, want missing style", got)
	}
}

func TestSortScriptRuntimeCandidatesDeterministicCSSBeforeJS(t *testing.T) {
	items := []ScriptRuntimeCandidate{
		{ID: "b:js", ScriptID: "b", Identifier: "same", Kind: "script", RunAt: "document_idle", Priority: 10},
		{ID: "a:css", ScriptID: "a", Identifier: "same", Kind: "style", RunAt: "document_idle", Priority: 10},
		{ID: "a:js", ScriptID: "a", Identifier: "same", Kind: "script", RunAt: "document_idle", Priority: 10},
		{ID: "early", ScriptID: "z", Identifier: "later", Kind: "script", RunAt: "document_start", Priority: 99},
	}
	sortScriptRuntimeCandidates(items)
	want := []string{"early", "a:css", "a:js", "b:js"}
	for i, item := range items {
		if item.ID != want[i] {
			t.Fatalf("candidate[%d]=%q, want %q", i, item.ID, want[i])
		}
	}
}

func TestValidScriptRuntimeAssetContentChecksBytesAndHash(t *testing.T) {
	content := "console.log('ok')"
	sum := sha256.Sum256([]byte(content))
	hash := hex.EncodeToString(sum[:])
	if !validScriptRuntimeAssetContent(content, len([]byte(content)), hash) {
		t.Fatal("valid content was rejected")
	}
	if validScriptRuntimeAssetContent(content+"!", len([]byte(content)), hash) {
		t.Fatal("content hash mismatch was accepted")
	}
	if validScriptRuntimeAssetContent(content, len([]byte(content))+1, hash) {
		t.Fatal("content byte mismatch was accepted")
	}
}

func TestScriptRuntimeLatestReleasedIncludesActivePublishedAssets(t *testing.T) {
	b, err := os.ReadFile("script_runtime_resolver.go")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(b), "v.status IN ('released','active')"); got != 2 {
		t.Fatalf("latest_released status predicates=%d, want 2", got)
	}
}

func TestScriptRuntimeResolverKeepsSelectionAndIntegrityGuards(t *testing.T) {
	b, err := os.ReadFile("script_runtime_resolver.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, want := range []string{
		"s.workspace_type=$1 AND s.workspace_id=$2 AND s.platform=$3",
		"s.status='enabled' AND s.deleted_at IS NULL",
		"v.status='active'",
		"v.status IN ('released','active')",
		"runtimeAssetURLMatches",
		"runtimeAssetRunAtMatches",
		"validRuntimeAssetContentGeneric",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("resolver guard missing %q", want)
		}
	}
	if !strings.Contains(text, "if selector != nil && selector.MatchConfiguredURLRules != nil && !*selector.MatchConfiguredURLRules") {
		t.Fatal("selector URL-rule bypass is not explicit and scoped")
	}
}

func TestRuntimeResolverUsesScriptAndStyleRunAtResponsibilities(t *testing.T) {
	b, err := os.ReadFile("script_runtime_resolver.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, want := range []string{
		`runAtExpr := "COALESCE(s.run_at,'document_start')"`,
		`runAtExpr = "COALESCE(v.run_at,s.run_at,'document_start')"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("resolver runAt contract missing %q", want)
		}
	}
	if strings.Contains(text, `runAtExpr := "COALESCE(v.run_at,s.run_at,'document_start')"`) {
		t.Fatal("script resolver must not let asset version runAt override script runAt")
	}
	if strings.Count(text, `runAtExpr := "COALESCE(s.run_at,'document_start')"`) != 2 {
		t.Fatal("script runAt expression must be used by selector and list paths")
	}
	if strings.Count(text, `runAtExpr = "COALESCE(v.run_at,s.run_at,'document_start')"`) != 2 {
		t.Fatal("style runAt expression must be used by selector and list paths")
	}
}

func TestScriptRuntimeURLMatchesSelectorDefaultsToConfiguredRules(t *testing.T) {
	rules := []RuntimeMatchRule{{MatchType: "exact", Pattern: "https://example.com/product", Enabled: true}}
	cases := []struct {
		name     string
		selector *RuntimeAssetSelector
		want     bool
	}{
		{name: "selector omitted", want: false},
		{name: "selector true", selector: boolSelector(true), want: false},
		{name: "selector false bypasses only selected asset", selector: boolSelector(false), want: true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			got, err := runtimeAssetURLMatches(tt.selector, rules, "", "", "https://example.com/other")
			if err != nil {
				t.Fatalf("match error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("matched=%v want=%v", got, tt.want)
			}
		})
	}
}

func TestScriptRuntimeURLMatchBypassIsIndependentPerSelector(t *testing.T) {
	rules := []RuntimeMatchRule{{MatchType: "exact", Pattern: "https://example.com/product", Enabled: true}}
	script, err := runtimeAssetURLMatches(boolSelector(false), rules, "", "", "https://example.com/other")
	if err != nil || !script {
		t.Fatalf("script bypass matched=%v err=%v", script, err)
	}
	style, err := runtimeAssetURLMatches(boolSelector(true), rules, "", "", "https://example.com/other")
	if err != nil || style {
		t.Fatalf("style configured rule matched=%v err=%v", style, err)
	}
}

func TestScriptRuntimeRunAtMatchesConfiguredLifecycle(t *testing.T) {
	for _, tt := range []struct {
		name       string
		assetRunAt string
		requested  string
		want       bool
	}{
		{name: "unspecified request accepts user action", assetRunAt: "user_action", want: true},
		{name: "user action selects user action", assetRunAt: "user_action", requested: "user_action", want: true},
		{name: "document start does not select user action", assetRunAt: "user_action", requested: "document_start", want: false},
		{name: "user action does not select document start", assetRunAt: "document_start", requested: "user_action", want: false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := runtimeAssetRunAtMatches(tt.assetRunAt, tt.requested); got != tt.want {
				t.Fatalf("runAt match=%v want=%v", got, tt.want)
			}
		})
	}
}

func TestScriptRuntimePreloadReturnsSelectedCandidateRulesAcrossNavigation(t *testing.T) {
	request := ScriptRuntimeResolveRequest{URL: "https://example.com/login", PreloadBoundAssets: true}
	selector := &RuntimeAssetSelector{Identifier: "SHOP_SCRIPT"}
	rules := []RuntimeMatchRule{
		{ID: "disabled", MatchType: "exact", Pattern: "https://example.com/never", Enabled: false, SortOrder: 0},
		{ID: "exact", MatchType: "exact", Pattern: "https://example.com/product/list", IgnoreQuery: true, Enabled: true, SortOrder: 1},
		{ID: "prefix", MatchType: "prefix", Pattern: "https://example.com/shops", Enabled: true, SortOrder: 2},
		{ID: "shop", MatchType: "wildcard", Pattern: "https://example.com/shop/*", IgnoreQuery: true, Enabled: true, Remark: "shop pages", SortOrder: 3},
	}
	include, responseRules, ruleFlag, err := runtimeAssetSelection(request, selector, "document_start", true, rules, "", "")
	if err != nil || !include {
		t.Fatalf("preload selection include=%v err=%v", include, err)
	}
	if ruleFlag == nil || !*ruleFlag || len(responseRules) != 3 || responseRules[0].ID != "exact" || responseRules[1].ID != "prefix" || responseRules[2].ID != "shop" {
		t.Fatalf("preload rules/flag=%#v %#v", responseRules, ruleFlag)
	}
	for _, candidate := range []struct {
		kind, pattern, url string
		ignoreQuery, want  bool
	}{
		{"prefix", "https://example.com/shops", "https://example.com/shops/42", false, true},
		{"wildcard", "https://example.com/shop/*", "https://example.com/shop/list?tab=1", true, true},
		{"exact", "https://example.com/product/list", "https://example.com/product/list?tab=1", true, true},
		{"exact", "https://example.com/product/list", "https://example.com/product/listing", false, false},
		{"wildcard", "https://example.com/shop/*", "https://other.example.com/shop/list", false, false},
	} {
		matched, matchErr := matcher.MatchRule(candidate.kind, candidate.pattern, candidate.url, candidate.ignoreQuery)
		if matchErr != nil {
			t.Fatalf("match %q: %v", candidate.url, matchErr)
		}
		if matched != candidate.want {
			t.Fatalf("target URL %q matched=%v want=%v", candidate.url, matched, candidate.want)
		}
	}
	encoded, err := json.Marshal(RuntimeAsset{MatchRules: responseRules, MatchConfiguredURLRules: ruleFlag})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	var wireRules []map[string]json.RawMessage
	if err := json.Unmarshal(payload["matchRules"], &wireRules); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "matchType", "pattern", "ignoreQuery", "enabled", "remark", "sortOrder"} {
		if _, ok := wireRules[0][key]; !ok {
			t.Fatalf("wire match rule missing %q: %s", key, payload["matchRules"])
		}
	}
	var wireFlag bool
	if err := json.Unmarshal(payload["matchConfiguredUrlRules"], &wireFlag); err != nil || !wireFlag {
		t.Fatalf("wire matchConfiguredUrlRules=%s err=%v", payload["matchConfiguredUrlRules"], err)
	}
}

func TestScriptRuntimePreloadBypassIsExplicitAndPerSelector(t *testing.T) {
	request := ScriptRuntimeResolveRequest{URL: "https://example.com/login", PreloadBoundAssets: true}
	rules := []RuntimeMatchRule{{ID: "r", MatchType: "exact", Pattern: "https://example.com/shop", Enabled: true}}
	include, returned, flag, err := runtimeAssetSelection(request, boolSelector(false), "document_start", true, rules, "", "")
	if err != nil || !include || flag == nil || *flag || len(returned) != 0 {
		t.Fatalf("explicit bypass include=%v rules=%#v flag=%v err=%v", include, returned, flag, err)
	}
	include, returned, flag, err = runtimeAssetSelection(request, boolSelector(true), "document_start", true, rules, "", "")
	if err != nil || !include || flag == nil || !*flag || len(returned) != 1 || returned[0].ID != "r" {
		t.Fatalf("configured selector must return rule for client-side URL check: include=%v rules=%#v flag=%v err=%v", include, returned, flag, err)
	}
	request.PreloadBoundAssets = false
	include, _, _, err = runtimeAssetSelection(request, boolSelector(false), "document_start", true, rules, "", "")
	if err != nil || !include {
		t.Fatalf("legacy explicit bypass changed: include=%v err=%v", include, err)
	}
	include, _, _, err = runtimeAssetSelection(ScriptRuntimeResolveRequest{URL: request.URL}, nil, "document_start", true, rules, "", "")
	if err != nil || include {
		t.Fatalf("legacy default URL filtering changed: include=%v err=%v", include, err)
	}
}

func TestScriptRuntimePreloadRetainsRunAtEnabledAndIntegrityGates(t *testing.T) {
	request := ScriptRuntimeResolveRequest{PreloadBoundAssets: true}
	selector := &RuntimeAssetSelector{Identifier: "SHOP_SCRIPT"}
	rules := []RuntimeMatchRule{{ID: "r", MatchType: "prefix", Pattern: "https://example.com/shop", Enabled: true}}
	falseValue, trueValue := false, true
	for _, test := range []struct {
		name, runAt     string
		enabled         bool
		selectorEnabled *bool
		want            bool
	}{
		{"document start", "document_start", true, nil, true},
		{"idle not elevated", "document_idle", true, nil, false},
		{"disabled not selected", "document_start", false, nil, false},
		{"selector disabled", "document_start", true, &falseValue, false},
		{"selector asks another event", "document_start", true, &trueValue, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			selector.Enabled = test.selectorEnabled
			if test.name == "selector asks another event" {
				selector.RunAt = "document_idle"
			} else {
				selector.RunAt = ""
			}
			include, _, _, err := runtimeAssetSelection(request, selector, test.runAt, test.enabled, rules, "", "")
			if err != nil || include != test.want {
				t.Fatalf("include=%v want=%v err=%v", include, test.want, err)
			}
		})
	}
	content := "console.log('candidate')"
	hash := sha256.Sum256([]byte(content))
	if !validRuntimeAssetContentGeneric(content, len([]byte(content)), hex.EncodeToString(hash[:])) || validRuntimeAssetContentGeneric(content, len(content)+1, hex.EncodeToString(hash[:])) {
		t.Fatal("preload source integrity helper no longer enforces byte length and hash")
	}
}

func TestPreloadDoesNotEnumerateUnselectedBusinessAssets(t *testing.T) {
	if HasExplicitBusinessRuntimeSelection(ScriptRuntimeResolveRequest{PreloadBoundAssets: true}) {
		t.Fatal("empty preload request must not count as an explicit selection")
	}
	for _, request := range []ScriptRuntimeResolveRequest{
		{ScriptIdentifiers: []string{"A"}},
		{StyleIdentifiers: []string{"B"}},
		{ScriptSelectors: []*RuntimeAssetSelector{{Identifier: "C"}}},
		{Style: &RuntimeAssetSelector{Identifier: "D"}},
	} {
		if !HasExplicitBusinessRuntimeSelection(request) {
			t.Fatalf("explicit selection not recognized: %#v", request)
		}
	}
}

func TestPreloadPublicOnlySelectionDoesNotQueryBusinessAssets(t *testing.T) {
	store := &Store{}
	for _, request := range []ScriptRuntimeResolveRequest{
		{Platform: "douyin", WorkspaceType: "platform", WorkspaceID: "platform_root", PreloadBoundAssets: true, PublicIdentifiers: []string{"COMMON"}},
		{Platform: "douyin", WorkspaceType: "platform", WorkspaceID: "platform_root", PreloadBoundAssets: true, PublicStyleIdentifiers: []string{"THEME"}},
	} {
		items, err := store.ResolveScriptRuntime(t.Context(), request)
		if err != nil || len(items) != 0 {
			t.Fatalf("public-only preload selected business items=%#v err=%v", items, err)
		}
	}
}

func TestPublicStylePreloadReturnsValidatedRulesButLegacyStillFiltersURL(t *testing.T) {
	include, rules, flag, err := publicStyleRuntimeSelection(true, "document_start", "wildcard", "https://example.com/shop/*", "https://example.com/login")
	if err != nil || !include || flag == nil || !*flag || len(rules) != 1 || rules[0].Pattern != "https://example.com/shop/*" || !rules[0].Enabled {
		t.Fatalf("preload public style rules=%#v flag=%v err=%v", rules, flag, err)
	}
	if ok, _, _, err := publicStyleRuntimeSelection(false, "document_start", "wildcard", "https://example.com/shop/*", "https://example.com/login"); err != nil || ok {
		t.Fatalf("legacy public style URL filter changed: matched=%v err=%v", ok, err)
	}
	if ok, _, _, err := publicStyleRuntimeSelection(true, "document_idle", "wildcard", "https://example.com/shop/*", "https://example.com/login"); err != nil || ok {
		t.Fatalf("non-start public style was elevated: matched=%v err=%v", ok, err)
	}
	if _, _, _, err := publicStyleRuntimeSelection(true, "document_start", "regex", "https://example.com/*", ""); err == nil {
		t.Fatal("invalid public style rule accepted for preload")
	}
}

func TestPublicStylePreloadSourceMetadataUsesUnicodeCharactersAndUTF8Hash(t *testing.T) {
	content := "你好A"
	sum := sha256.Sum256([]byte(content))
	hash := hex.EncodeToString(sum[:])
	if !validPublicStyleRuntimeContent(content, 3, len([]byte(content)), hash) {
		t.Fatal("valid UTF-8 public style metadata rejected")
	}
	if validPublicStyleRuntimeContent(content, len([]byte(content)), len([]byte(content)), hash) {
		t.Fatal("byte count must not be accepted as character count")
	}
	if validPublicStyleRuntimeContent(content, 3, len([]byte(content))+1, hash) || validPublicStyleRuntimeContent(content, 3, len([]byte(content)), strings.Repeat("0", 64)) {
		t.Fatal("invalid public style bytes/hash accepted")
	}
}

func boolSelector(value bool) *RuntimeAssetSelector {
	return &RuntimeAssetSelector{Identifier: "asset", MatchConfiguredURLRules: &value}
}
