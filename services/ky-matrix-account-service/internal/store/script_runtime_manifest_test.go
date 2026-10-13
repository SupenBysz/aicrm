package store

import (
	"os"
	"strings"
	"testing"
)

func manifestRequest(policy string) ScriptRuntimeResolveRequest {
	return ScriptRuntimeResolveRequest{
		WorkspaceType: "platform",
		WorkspaceID:   "platform_root",
		Platform:      "douyin",
		URL:           "https://example.com/product?tab=1",
		VersionPolicy: policy,
	}
}

func manifestAssets() ([]ScriptRuntimeCandidate, []PublicRuntimeScript) {
	return []ScriptRuntimeCandidate{
		{
			AssetType:          "script",
			Identifier:         "DD_LOGIN",
			Version:            "1.0.0",
			EffectiveVersionID: "asset-script-1",
			RunAt:              "document_start",
			Priority:           1000,
			SourceSHA256:       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		{
			AssetType:          "style",
			Identifier:         "DD_LOGIN",
			Version:            "1.0.0",
			EffectiveVersionID: "asset-style-1",
			RunAt:              "document_idle",
			Priority:           1000,
			SourceSHA256:       "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		},
	}, []PublicRuntimeScript{{
		Identifier:   "PUBLIC_HELPER",
		Version:      "7",
		SourceSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
	}}
}

func TestScriptRuntimeManifestRevisionActiveOnlyIsStableForResourceOrder(t *testing.T) {
	req := manifestRequest("active_only")
	assets, public := manifestAssets()
	want := ScriptRuntimeManifestRevision(req, assets, public)
	if want == "" {
		t.Fatal("manifest revision must be non-empty")
	}
	assets[0], assets[1] = assets[1], assets[0]
	if got := ScriptRuntimeManifestRevision(req, assets, public); got != want {
		t.Fatalf("resource order changed revision: got %s want %s", got, want)
	}
	public[0].SourceSHA256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if got := ScriptRuntimeManifestRevision(req, assets, public); got == want {
		t.Fatal("public resource hash change did not change revision")
	}
}

func TestScriptRuntimeManifestRevisionLatestReleasedChangesWithVersionOrHash(t *testing.T) {
	req := manifestRequest("latest_released")
	assets, public := manifestAssets()
	base := ScriptRuntimeManifestRevision(req, assets, public)
	assets[0].Version = "1.0.1"
	if got := ScriptRuntimeManifestRevision(req, assets, public); got == base {
		t.Fatal("asset version change did not change revision")
	}
	assets[0].Version = "1.0.0"
	assets[0].SourceSHA256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	if got := ScriptRuntimeManifestRevision(req, assets, public); got == base {
		t.Fatal("asset hash change did not change revision")
	}
}

func TestScriptRuntimeManifestRevisionChangesWhenCandidateRulesChange(t *testing.T) {
	req := manifestRequest("latest_released")
	assets, public := manifestAssets()
	assets[0].MatchRules = []RuntimeMatchRule{{ID: "login", MatchType: "exact", Pattern: "https://example.com/login", Enabled: true}}
	base := ScriptRuntimeManifestRevision(req, assets, public)
	assets[0].MatchRules[0].Pattern = "https://example.com/shop/*"
	if got := ScriptRuntimeManifestRevision(req, assets, public); got == base {
		t.Fatal("business URL match rule change did not change resolve manifest revision")
	}
	assets[0].MatchRules[0].Pattern = "https://example.com/login"
	flag := false
	assets[0].MatchConfiguredURLRules = &flag
	if got := ScriptRuntimeManifestRevision(req, assets, public); got == base {
		t.Fatal("per-asset URL rule bypass change did not change resolve manifest revision")
	}
	styleFlag := true
	styles := []PublicRuntimeStyle{{ID: "public-style-1", Identifier: "PUBLIC_STYLE", Version: "3", RunAt: "document_start", Enabled: true, SourceSHA256: "style-hash", MatchConfiguredURLRules: &styleFlag, MatchRules: []RuntimeMatchRule{{ID: "style", MatchType: "wildcard", Pattern: "https://example.com/a/*", Enabled: true}}}}
	styleRevision := ScriptRuntimeManifestRevision(req, nil, public, styles)
	styles[0].MatchRules[0].Pattern = "https://example.com/b/*"
	if got := ScriptRuntimeManifestRevision(req, nil, public, styles); got == styleRevision {
		t.Fatal("public style URL match rule change did not change resolve manifest revision")
	}
}

func TestScriptRuntimeManifestRevisionSeparatesContextAndPolicy(t *testing.T) {
	assets, public := manifestAssets()
	base := ScriptRuntimeManifestRevision(manifestRequest("active_only"), assets, public)
	for name, req := range map[string]ScriptRuntimeResolveRequest{
		"latest released": manifestRequest("latest_released"),
		"other workspace": func() ScriptRuntimeResolveRequest {
			r := manifestRequest("active_only")
			r.WorkspaceID = "other"
			return r
		}(),
		"other platform": func() ScriptRuntimeResolveRequest {
			r := manifestRequest("active_only")
			r.Platform = "kuaishou"
			return r
		}(),
		"other url": func() ScriptRuntimeResolveRequest {
			r := manifestRequest("active_only")
			r.URL = "https://example.com/other"
			return r
		}(),
	} {
		if got := ScriptRuntimeManifestRevision(req, assets, public); got == base {
			t.Fatalf("%s reused manifest revision %s", name, got)
		}
	}
}

func TestScriptRuntimeManifestRevisionIncludesPublishedMetadata(t *testing.T) {
	req := ScriptRuntimeManifestRequest{WorkspaceType: "platform", WorkspaceID: "platform_root", Platform: "douyin", VersionPolicy: "latest_released", Origin: "https://example.com/"}
	assets := []ScriptRuntimeManifestAsset{{AssetType: "style", Identifier: "DD_LOGIN", Version: "1.0.0", EffectiveVersionID: "style-1", RunAt: "document_start", Priority: 0, Enabled: true, Status: "active", SourceSHA256: "a"}}
	base := ScriptRuntimeManifestRevisionForManifest(req, assets, nil)
	assets[0].RunAt = "document_idle"
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, nil); got == base {
		t.Fatal("style runAt change did not change manifest revision")
	}
	assets[0].RunAt = "document_start"
	assets[0].Priority = 10
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, nil); got == base {
		t.Fatal("style priority change did not change manifest revision")
	}
	assets[0].Priority = 0
	assets[0].Enabled = false
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, nil); got == base {
		t.Fatal("style enabled change did not change manifest revision")
	}
}

func TestScriptRuntimeManifestRevisionForManifestIncludesURLRules(t *testing.T) {
	req := ScriptRuntimeManifestRequest{WorkspaceType: "platform", WorkspaceID: "platform_root", Platform: "douyin", VersionPolicy: "latest_released"}
	assets := []ScriptRuntimeManifestAsset{{AssetType: "script", Identifier: "LOGIN", Version: "1.0.0", EffectiveVersionID: "v1", Status: "released", SourceSHA256: "hash", MatchRules: []RuntimeMatchRule{{ID: "login", MatchType: "exact", Pattern: "https://example.com/login", Enabled: true}}}}
	base := ScriptRuntimeManifestRevisionForManifest(req, assets, nil)
	assets[0].MatchRules[0].Pattern = "https://example.com/shop/*"
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, nil); got == base {
		t.Fatal("manifest API revision did not change after business match rule changed")
	}
	styles := []ScriptRuntimeManifestPublicStyle{{AssetType: "public-style", Identifier: "COMMON_STYLE", Version: "2", EffectiveVersionID: "style-2", Status: "enabled", SourceSHA256: "style-hash", MatchRules: []RuntimeMatchRule{{ID: "legacy", MatchType: "wildcard", Pattern: "https://example.com/a/*", Enabled: true}}}}
	base = ScriptRuntimeManifestRevisionForManifest(req, nil, nil, styles)
	styles[0].MatchRules[0].Pattern = "https://example.com/b/*"
	if got := ScriptRuntimeManifestRevisionForManifest(req, nil, nil, styles); got == base {
		t.Fatal("manifest API revision did not change after public style match rule changed")
	}
}

func TestScriptRuntimeManifestRevisionSortsAssetsAndSeparatesWorkspacePlatform(t *testing.T) {
	req := ScriptRuntimeManifestRequest{WorkspaceType: "platform", WorkspaceID: "platform_root", Platform: "douyin", VersionPolicy: "latest_released"}
	assets := []ScriptRuntimeManifestAsset{{AssetType: "script", Identifier: "B", Version: "1.0.0", EffectiveVersionID: "b", Status: "released", SourceSHA256: "b"}, {AssetType: "style", Identifier: "A", Version: "1.0.0", EffectiveVersionID: "a", Status: "active", SourceSHA256: "a"}}
	public := []ScriptRuntimeManifestPublic{{AssetType: "public", Identifier: "COMMON", Version: "2", Status: "enabled", SourceSHA256: "p"}}
	base := ScriptRuntimeManifestRevisionForManifest(req, assets, public)
	assets[0], assets[1] = assets[1], assets[0]
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, public); got != base {
		t.Fatal("resource order changed manifest revision")
	}
	req.WorkspaceID = "other"
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, public); got == base {
		t.Fatal("workspace change reused manifest revision")
	}
	req.WorkspaceID = "platform_root"
	req.Platform = "kuaishou"
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, public); got == base {
		t.Fatal("platform change reused manifest revision")
	}
	req.Platform = "douyin"
	req.VersionPolicy = "active_only"
	if got := ScriptRuntimeManifestRevisionForManifest(req, assets, public); got == base {
		t.Fatal("version policy change reused manifest revision")
	}
}

func TestScriptRuntimeManifestQueryIsFullMetadataOnly(t *testing.T) {
	source, err := os.ReadFile("script_runtime_manifest_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, want := range []string{
		"s.workspace_type=$1 AND s.workspace_id=$2 AND s.platform=$3",
		"v.status IN ('released','active')",
		"v.status='active'",
		"effective_script_asset_version_id",
		"effective_style_asset_version_id",
		"source_sha256",
		"s.match_rules",
		"item.MatchRules = enabledRuntimeMatchRules",
		"CASE WHEN v.asset_type='script' THEN COALESCE(s.run_at,'document_start') ELSE COALESCE(v.run_at,s.run_at,'document_start') END",
		"SELECT id,identifier,revision,source_sha256,enabled",
		"ORDER BY s.identifier,v.asset_type,v.version,v.id",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("manifest query contract missing %q", want)
		}
	}
	if strings.Contains(text, "source_content") {
		t.Fatal("manifest query must not return source content")
	}
	if strings.Contains(text, "CASE WHEN v.asset_type='script' THEN 'document_start'") {
		t.Fatal("manifest query must preserve configured script runAt")
	}
}
