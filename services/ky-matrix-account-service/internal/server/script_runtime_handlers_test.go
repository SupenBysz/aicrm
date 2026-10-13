package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func TestScriptRuntimeNetworkCapabilitiesResponseContract(t *testing.T) {
	capabilities, err := store.ServerNetworkCapabilities(nil)
	if err != nil {
		t.Fatalf("default server capabilities: %v", err)
	}
	asset := store.ScriptRuntimeCandidate{
		Identifier:          "DD_LOGIN",
		SourceContent:       "console.log('safe')",
		NetworkCapabilities: capabilities,
	}
	raw, err := json.Marshal(asset)
	if err != nil {
		t.Fatalf("marshal runtime asset: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode runtime asset: %v", err)
	}
	if _, ok := decoded["networkCapabilities"]; !ok {
		t.Fatal("networkCapabilities must be present in every runtime asset")
	}
	if store.HasNetworkCapability(capabilities, store.NetworkCapabilityInterceptRequest) || store.HasNetworkCapability(capabilities, store.NetworkCapabilityInterceptResponse) {
		t.Fatalf("default response granted interception: %#v", capabilities)
	}
	if _, ok := decoded["secretAccessKey"]; ok {
		t.Fatal("runtime asset must not expose secret fields")
	}
}

func TestDecodeScriptRuntimeJSONRejectsTrailingAndOversizedBodies(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "trailing json", body: `{ "platform": "douyin" } { "platform": "douyin" }`},
		{name: "oversized", body: strings.Repeat("x", maxScriptRuntimeRequestBytes+1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/script-runtime/resolve", bytes.NewBufferString(tt.body))
			var input store.ScriptRuntimeResolveRequest
			if decodeScriptRuntimeJSON(recorder, req, &input) {
				t.Fatal("invalid runtime body accepted")
			}
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d, want %d", recorder.Code, http.StatusBadRequest)
			}
		})
	}
}

func TestWriteScriptRuntimeDataRejectsOversizedResponse(t *testing.T) {
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/script-runtime/resolve", nil)
	writeScriptRuntimeData(recorder, req, map[string]string{"sourceContent": strings.Repeat("x", maxScriptRuntimeResponseBytes)})
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want %d", recorder.Code, http.StatusInternalServerError)
	}
}

func TestScriptRuntimeAssetCountIncludesPublicStyles(t *testing.T) {
	if got := scriptRuntimeAssetCount(nil, nil, []store.PublicRuntimeStyle{{Identifier: "STYLE"}}); got != 1 {
		t.Fatalf("public style count=%d, want 1", got)
	}
	if got := scriptRuntimeAssetCount([]store.RuntimeAsset{{Identifier: "SCRIPT"}}, []store.PublicRuntimeScript{{Identifier: "PUBLIC"}}, []store.PublicRuntimeStyle{{Identifier: "STYLE"}}); got != 3 {
		t.Fatalf("combined runtime count=%d, want 3", got)
	}
}

func TestScriptRuntimeResponseDataIncludesPublicStyles(t *testing.T) {
	styles := []store.PublicRuntimeStyle{{Identifier: "STYLE"}}
	data := scriptRuntimeResponseData(nil, nil, styles, "revision", "fetched-at")
	got, ok := data["publicStyles"].([]store.PublicRuntimeStyle)
	if !ok || len(got) != 1 || got[0].Identifier != "STYLE" {
		t.Fatalf("publicStyles response=%#v", data["publicStyles"])
	}
}

func TestScriptRuntimeManifestResponseDataIncludesPublicStyles(t *testing.T) {
	data := scriptRuntimeManifestResponseData(store.ScriptRuntimeManifest{
		ManifestRevision: "revision",
		PublicStyles:     []store.ScriptRuntimeManifestPublicStyle{{Identifier: "STYLE"}},
	}, "fetched-at")
	got, ok := data["publicStyles"].([]store.ScriptRuntimeManifestPublicStyle)
	if !ok || len(got) != 1 || got[0].Identifier != "STYLE" {
		t.Fatalf("manifest publicStyles response=%#v", data["publicStyles"])
	}
}

func TestScriptRuntimeHandlerUsesNeutralResolver(t *testing.T) {
	source, err := os.ReadFile("script_runtime_handlers.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, "s.store.ResolveScriptRuntime(r.Context(), in)") {
		t.Fatal("generic resolve handler does not call neutral resolver")
	}
	if strings.Contains(text, "ListDouyinRuntimeCandidates") {
		t.Fatal("generic resolve handler depends on legacy Douyin resolver")
	}
}

func TestScriptRuntimeHandlerPreparesSourceDeclaredPublicDependenciesAndKeepsLegacyField(t *testing.T) {
	source, err := os.ReadFile("script_runtime_handlers.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"store.RuntimePublicDependencyRoots(items, in.PublicIdentifiers)",
		"s.store.ResolvePublicScripts(r.Context(), in.WorkspaceType, in.WorkspaceID, in.Platform, publicIdentifiers)",
		"\"PUBLIC_DEPENDENCY_INVALID\"",
		"\"PUBLIC_DEPENDENCY_MISSING\"",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("runtime handler dependency contract missing %q", required)
		}
	}
}

func TestValidateScriptRuntimeRequestNormalizesWorkspaceAndURL(t *testing.T) {
	got, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin",
		URL:      "HTTPS://Example.com:443/product?tab=1",
		Workspace: &store.RuntimeWorkspace{
			Type: "platform",
			ID:   "platform_root",
		},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "" || message != "" {
		t.Fatalf("unexpected validation error: %s %s", code, message)
	}
	if got.URL != "https://example.com/product?tab=1" || got.VersionPolicy != "active_only" {
		t.Fatalf("normalized request = %#v", got)
	}
}

func TestValidateScriptRuntimeRequestRejectsCrossWorkspaceAndInvalidPlatform(t *testing.T) {
	tests := []struct {
		name string
		wc   wsContext
		in   store.ScriptRuntimeResolveRequest
		code string
	}{
		{
			name: "cross workspace",
			wc:   wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"},
			in: store.ScriptRuntimeResolveRequest{
				Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "other",
			},
			code: "WORKSPACE_FORBIDDEN",
		},
		{
			name: "invalid policy",
			wc:   wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"},
			in: store.ScriptRuntimeResolveRequest{
				Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root", VersionPolicy: "draft",
			},
			code: "ASSET_NOT_FOUND",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, code, message := validateScriptRuntimeRequest(tt.in, tt.wc)
			if code != tt.code || message == "" {
				t.Fatalf("code=%q message=%q, want code %q with a message", code, message, tt.code)
			}
		})
	}
	got, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "unknown platform",
		URL:      "https://example.com/", WorkspaceType: "enterprise", WorkspaceID: "enterprise-1",
	}, wsContext{WorkspaceType: "enterprise", WorkspaceID: "enterprise-1"})
	if got.Platform != "unknown platform" || code != "PLATFORM_NOT_ALLOWED" || message == "" {
		t.Fatalf("invalid platform result=%#v code=%q message=%q", got, code, message)
	}
}

func TestValidateScriptRuntimeRequestRejectsInvalidURLAndRunAt(t *testing.T) {
	base := store.ScriptRuntimeResolveRequest{
		Platform: "douyin", WorkspaceType: "platform", WorkspaceID: "platform_root",
	}
	base.URL = "javascript:alert(1)"
	_, code, _ := validateScriptRuntimeRequest(base, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "INVALID_URL" {
		t.Fatalf("invalid URL code=%q", code)
	}
	base.URL = "https://example.com/"
	base.RunAt = "unknown"
	_, code, _ = validateScriptRuntimeRequest(base, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "ASSET_NOT_FOUND" {
		t.Fatalf("invalid runAt code=%q", code)
	}
}

func TestValidateScriptRuntimeRequestAcceptsExplicitStyleIdentifiers(t *testing.T) {
	got, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root",
		StyleIdentifiers: []string{"layout.base", "theme-dark"},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "" || message != "" || len(got.StyleIdentifiers) != 2 {
		t.Fatalf("style identifiers rejected: %#v %q %q", got, code, message)
	}
	_, code, message = validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root",
		StyleIdentifiers: []string{"bad/style"},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "INVALID_SELECTOR" || message == "" {
		t.Fatalf("invalid style identifier accepted: %q %q", code, message)
	}
}

func TestValidateScriptRuntimeRequestValidatesSelectorRunAt(t *testing.T) {
	_, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Style: &store.RuntimeAssetSelector{Identifier: "STYLE", RunAt: "not-a-run-at"},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "ASSET_NOT_FOUND" || message == "" {
		t.Fatalf("invalid selector runAt accepted: %q %q", code, message)
	}
}

func TestValidateScriptRuntimeRequestAcceptsVersionedScriptAndStyleSelectors(t *testing.T) {
	got, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ScriptSelectors: []*store.RuntimeAssetSelector{{Identifier: "LOGIN", Version: "1.0.0", RunAt: "document_start"}},
		StyleSelectors:  []*store.RuntimeAssetSelector{{Identifier: "THEME", Version: "2.0.0", RunAt: "document_idle"}},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "" || message != "" || len(got.ScriptSelectors) != 1 || got.ScriptSelectors[0].Version != "1.0.0" || len(got.StyleSelectors) != 1 || got.StyleSelectors[0].Version != "2.0.0" {
		t.Fatalf("versioned selectors rejected: %#v %q %q", got, code, message)
	}
	_, code, message = validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ScriptSelectors: []*store.RuntimeAssetSelector{{Identifier: "LOGIN", RunAt: "invalid"}},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "ASSET_NOT_FOUND" || message == "" {
		t.Fatalf("invalid selector runAt accepted: %q %q", code, message)
	}
	_, code, message = validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: "https://example.com/", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ScriptSelectors: []*store.RuntimeAssetSelector{{Identifier: "LOGIN", Version: "1.0"}},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "INVALID_SELECTOR" || message == "" {
		t.Fatalf("invalid selector version accepted: %q %q", code, message)
	}
}

func TestValidateScriptRuntimeRequestPreloadRequiresExplicitDocumentStartSelection(t *testing.T) {
	wc := wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"}
	base := store.ScriptRuntimeResolveRequest{Platform: "douyin", URL: "https://example.com/login", WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID, PreloadBoundAssets: true}
	if _, code, _ := validateScriptRuntimeRequest(base, wc); code != "INVALID_SELECTOR" {
		t.Fatalf("empty preload selection code=%q, want INVALID_SELECTOR", code)
	}
	base.ScriptSelectors = []*store.RuntimeAssetSelector{{Identifier: "LOGIN"}}
	if _, code, _ := validateScriptRuntimeRequest(base, wc); code != "" {
		t.Fatalf("explicit preload selector rejected: %s", code)
	}
	base.RunAt = "document_idle"
	if _, code, _ := validateScriptRuntimeRequest(base, wc); code != "INVALID_SELECTOR" {
		t.Fatalf("non-start preload runAt code=%q, want INVALID_SELECTOR", code)
	}
	base.RunAt = ""
	base.ScriptSelectors[0].RunAt = "document_idle"
	if _, code, _ := validateScriptRuntimeRequest(base, wc); code != "INVALID_SELECTOR" {
		t.Fatalf("non-start selector runAt code=%q, want INVALID_SELECTOR", code)
	}
}

func TestScriptRuntimePreloadRequestFieldIsOptionalAndCamelCased(t *testing.T) {
	var omitted store.ScriptRuntimeResolveRequest
	if err := json.Unmarshal([]byte(`{"platform":"demo","url":"https://example.com/"}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.PreloadBoundAssets {
		t.Fatal("omitted preloadBoundAssets must preserve the legacy false behavior")
	}
	var enabled store.ScriptRuntimeResolveRequest
	if err := json.Unmarshal([]byte(`{"preloadBoundAssets":true}`), &enabled); err != nil {
		t.Fatal(err)
	}
	if !enabled.PreloadBoundAssets {
		t.Fatal("preloadBoundAssets JSON field was not recognized")
	}
	raw, err := json.Marshal(enabled)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["preloadBoundAssets"]; !ok {
		t.Fatalf("request JSON field is missing: %s", raw)
	}
}

func TestScriptRuntimeEmptyResultKeepsPreloadDiagnosticSeparateFromURLMismatch(t *testing.T) {
	code, message := scriptRuntimeEmptyResultError(store.ScriptRuntimeResolveRequest{PreloadBoundAssets: true})
	if code != "PRELOAD_ASSET_UNAVAILABLE" || message == "" || code == "URL_NOT_MATCHED" {
		t.Fatalf("preload empty result=(%q,%q)", code, message)
	}
	code, _ = scriptRuntimeEmptyResultError(store.ScriptRuntimeResolveRequest{})
	if code != "URL_NOT_MATCHED" {
		t.Fatalf("legacy empty result code=%q, want URL_NOT_MATCHED", code)
	}
	code, _ = scriptRuntimeEmptyResultError(store.ScriptRuntimeResolveRequest{PreloadBoundAssets: true, ScriptSelectors: []*store.RuntimeAssetSelector{{Identifier: "LOGIN", Version: "1.0.0"}}})
	if code != "VERSION_NOT_RELEASED" {
		t.Fatalf("preload version miss code=%q, want VERSION_NOT_RELEASED", code)
	}
}

func TestPreloadResolvesOnlyExplicitPublicStyles(t *testing.T) {
	cases := []struct {
		name    string
		request store.ScriptRuntimeResolveRequest
		want    bool
	}{
		{name: "legacy default still resolves URL-matched styles", request: store.ScriptRuntimeResolveRequest{}, want: true},
		{name: "preload without public style binding does not enumerate", request: store.ScriptRuntimeResolveRequest{PreloadBoundAssets: true, ScriptSelectors: []*store.RuntimeAssetSelector{{Identifier: "LOGIN"}}}, want: false},
		{name: "preload explicitly selected public style", request: store.ScriptRuntimeResolveRequest{PreloadBoundAssets: true, PublicStyleIdentifiers: []string{"THEME"}}, want: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldResolvePublicStyles(test.request); got != test.want {
				t.Fatalf("shouldResolvePublicStyles=%v want=%v", got, test.want)
			}
		})
	}
}

func TestScriptRuntimePreloadCandidateWritesSuccessEnvelope(t *testing.T) {
	flag := true
	candidate := store.RuntimeAsset{Identifier: "SHOP_SCRIPT", RunAt: "document_start", MatchConfiguredURLRules: &flag, MatchRules: []store.RuntimeMatchRule{{ID: "target", MatchType: "prefix", Pattern: "https://example.com/shop", Enabled: true}}}
	data := scriptRuntimeResponseData([]store.RuntimeAsset{candidate}, nil, nil, "revision", "fetched-at")
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/script-runtime/resolve", nil)
	writeScriptRuntimeData(recorder, request, data)
	if recorder.Code != http.StatusOK {
		t.Fatalf("candidate response status=%d", recorder.Code)
	}
	var envelope struct {
		Data struct {
			Assets []store.RuntimeAsset `json:"assets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Data.Assets) != 1 || envelope.Data.Assets[0].MatchConfiguredURLRules == nil || !*envelope.Data.Assets[0].MatchConfiguredURLRules || len(envelope.Data.Assets[0].MatchRules) != 1 {
		t.Fatalf("success envelope lost preload rules: %#v", envelope.Data.Assets)
	}
}

func TestValidateScriptRuntimeRequestAllowsIndependentScriptAndStyleIdentifiers(t *testing.T) {
	got, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform:      "douyin",
		URL:           "https://example.com/",
		WorkspaceType: "platform",
		WorkspaceID:   "platform_root",
		Script:        &store.RuntimeAssetSelector{Identifier: "DD_LOGIN"},
		Style:         &store.RuntimeAssetSelector{Identifier: "OTHER"},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "" || message != "" || got.Script.Identifier != "DD_LOGIN" || got.Style.Identifier != "OTHER" {
		t.Fatalf("independent selectors rejected or changed: request=%#v code=%q message=%q", got, code, message)
	}
}

func TestRuntimeAssetSelectorURLRuleFlagIsOptionalAndScoped(t *testing.T) {
	var omitted store.ScriptRuntimeResolveRequest
	if err := json.Unmarshal([]byte(`{"script":{"identifier":"SCRIPT"}}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.Script == nil || omitted.Script.MatchConfiguredURLRules != nil {
		t.Fatalf("omitted matchConfiguredUrlRules must remain nil: %#v", omitted.Script)
	}
	var explicit store.ScriptRuntimeResolveRequest
	if err := json.Unmarshal([]byte(`{"script":{"identifier":"SCRIPT","matchConfiguredUrlRules":false},"style":{"identifier":"STYLE","matchConfiguredUrlRules":true}}`), &explicit); err != nil {
		t.Fatal(err)
	}
	if explicit.Script == nil || explicit.Script.MatchConfiguredURLRules == nil || *explicit.Script.MatchConfiguredURLRules {
		t.Fatalf("script false flag was not preserved: %#v", explicit.Script)
	}
	if explicit.Style == nil || explicit.Style.MatchConfiguredURLRules == nil || !*explicit.Style.MatchConfiguredURLRules {
		t.Fatalf("style true flag was not preserved: %#v", explicit.Style)
	}
}

func TestValidateScriptRuntimeRequestAllowsNonDouyinPlatform(t *testing.T) {
	got, code, message := validateScriptRuntimeRequest(store.ScriptRuntimeResolveRequest{
		Platform:      "kuaishou",
		URL:           "https://example.com/",
		WorkspaceType: "enterprise",
		WorkspaceID:   "enterprise-1",
	}, wsContext{WorkspaceType: "enterprise", WorkspaceID: "enterprise-1"})
	if code != "" || message != "" || got.Platform != "kuaishou" {
		t.Fatalf("non-douyin platform rejected: request=%#v code=%q message=%q", got, code, message)
	}
}

func TestValidateScriptRuntimeManifestRequestDefaultsAndWorkspace(t *testing.T) {
	got, code, message := validateScriptRuntimeManifestRequest(store.ScriptRuntimeManifestRequest{
		Platform:  "douyin",
		Workspace: &store.RuntimeWorkspace{Type: "platform", ID: "platform_root"},
	}, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
	if code != "" || message != "" || got.VersionPolicy != "latest_released" || got.WorkspaceID != "platform_root" {
		t.Fatalf("manifest validation result=%#v code=%q message=%q", got, code, message)
	}
}

func TestValidateScriptRuntimeManifestRequestRejectsCrossWorkspaceAndPolicy(t *testing.T) {
	tests := []struct {
		name string
		in   store.ScriptRuntimeManifestRequest
		code string
	}{
		{name: "cross workspace", in: store.ScriptRuntimeManifestRequest{Platform: "douyin", WorkspaceType: "platform", WorkspaceID: "other"}, code: "WORKSPACE_FORBIDDEN"},
		{name: "invalid policy", in: store.ScriptRuntimeManifestRequest{Platform: "douyin", WorkspaceType: "platform", WorkspaceID: "platform_root", VersionPolicy: "draft"}, code: "ASSET_NOT_FOUND"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, code, message := validateScriptRuntimeManifestRequest(tt.in, wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"})
			if code != tt.code || message == "" {
				t.Fatalf("code=%q message=%q, want %q", code, message, tt.code)
			}
		})
	}
}

func TestScriptRuntimeManifestRevisionHeaderSupportsDirectAndWeakETag(t *testing.T) {
	for _, header := range []string{"abc123", `"abc123"`, `W/"abc123"`} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/script-runtime/manifest", nil)
		req.Header.Set("If-None-Match", header)
		if got := scriptRuntimeManifestRevisionFromRequest(req); got != "abc123" {
			t.Fatalf("header %q normalized to %q", header, got)
		}
	}
}
