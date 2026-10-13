package store

import (
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDouyinAssetInputValidation(t *testing.T) {
	for _, typ := range []string{"script", "style"} {
		in, err := normalizeDouyinAssetInput(DouyinAssetInput{AssetType: typ, Version: "1.2.3", SourceContent: ""})
		if err != nil || in.AssetType != typ {
			t.Fatalf("empty %s draft rejected: %v", typ, err)
		}
	}
	for _, in := range []DouyinAssetInput{{AssetType: "html", Version: "1.0.0"}, {AssetType: "script", Version: "1.0", SourceContent: "x"}, {AssetType: "style", Version: "1.0.0", SourceContent: string(make([]byte, 2_000_001))}} {
		if _, err := normalizeDouyinAssetInput(in); err != ErrValidation {
			t.Fatalf("invalid asset accepted: %+v", in)
		}
	}
	if assetHash("same") != assetHash("same") || assetHash("same") == assetHash("other") {
		t.Fatal("asset hash is not stable")
	}
	style, err := normalizeDouyinAssetInput(DouyinAssetInput{AssetType: "style", Version: "1.0.0"})
	if err != nil || style.RunAt != "document_start" || style.Priority == nil || *style.Priority != 0 || style.Enabled == nil || !*style.Enabled {
		t.Fatalf("style runtime defaults changed: %+v err=%v", style, err)
	}
	for _, runAt := range []string{"load", "user_action", "bad"} {
		_, err := normalizeDouyinAssetInput(DouyinAssetInput{AssetType: "style", Version: "1.0.0", RunAt: runAt})
		if err != ErrValidation {
			t.Fatalf("unsupported style runAt accepted: %q err=%v", runAt, err)
		}
	}
}

func TestDouyinPublishedStyleMetadataValidation(t *testing.T) {
	priority := 7
	enabled := false
	if err := normalizeDouyinStyleMetadata(DouyinAssetInput{AssetType: "style", RunAt: "document_idle", Priority: &priority, Enabled: &enabled}); err != nil {
		t.Fatalf("released style metadata should be accepted: %v", err)
	}
	for _, in := range []DouyinAssetInput{
		{AssetType: "script", RunAt: "document_idle", Priority: &priority, Enabled: &enabled},
		{AssetType: "style", RunAt: "document_idle", Enabled: &enabled},
		{AssetType: "style", RunAt: "document_idle", Priority: &priority},
		{AssetType: "style", RunAt: "load", Priority: &priority, Enabled: &enabled},
	} {
		if err := normalizeDouyinStyleMetadata(in); err != ErrValidation {
			t.Fatalf("invalid published style metadata accepted: %+v err=%v", in, err)
		}
	}
}

func TestDouyinAssetPublishedStyleUpdateContract(t *testing.T) {
	source, err := os.ReadFile("douyin_asset_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, want := range []string{
		`if current.Status == "released" || current.Status == "active"`,
		`if current.AssetType != "style"`,
		`v.status IN ('released','active')`,
		`SET run_at=$1,priority=$2,enabled=$3`,
		`v.revision=$11`,
		`if current.Status != "draft"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("published style update contract missing %q", want)
		}
	}
	if strings.Contains(text, "SET version=$1,source_content=$2,source_bytes=$3,source_sha256=$4") {
		// 完整源码更新仍只能进入草稿分支，已发布分支不得复用该 SQL。
		if !strings.Contains(text, `v.status='draft'`) {
			t.Fatal("full source update is not restricted to draft versions")
		}
	}
}

func TestDouyinAssetHistoryDeleteContract(t *testing.T) {
	source, err := os.ReadFile("douyin_asset_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, want := range []string{
		"v.status<>'archived' ORDER BY v.created_at DESC",
		"v.status<>'archived'",
		"v.status IN ('draft','released','active')",
		"s.effective_script_asset_version_id=v.id",
		"s.effective_style_asset_version_id=v.id",
		`whereStatus := "v.status='draft'"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("asset history delete contract missing %q", want)
		}
	}
}

func TestDouyinAssetCharacterCountContract(t *testing.T) {
	source, err := os.ReadFile("douyin_asset_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, "char_length(v.source_content)") || !strings.Contains(text, "SourceChars") {
		t.Fatal("asset queries must expose PostgreSQL Unicode character count")
	}
	for _, content := range []string{"你好，世界", "A🙂B"} {
		if len([]byte(content)) == utf8.RuneCountInString(content) {
			t.Fatalf("fixture must distinguish characters and UTF-8 bytes: %q", content)
		}
	}
	if utf8.RuneCountInString("你好，世界") != 5 || utf8.RuneCountInString("A🙂B") != 3 {
		t.Fatal("Unicode character count semantics changed")
	}
}

func TestDouyinStyleRuntimeMigrationContract(t *testing.T) {
	source, err := os.ReadFile("../../../../ops/db/091_matrix_account_douyin_style_runtime.sql")
	if err != nil || !strings.Contains(string(source), "ADD COLUMN IF NOT EXISTS run_at") || !strings.Contains(string(source), "ADD COLUMN IF NOT EXISTS enabled") {
		t.Fatalf("style runtime migration contract missing: %v", err)
	}
	storeSource, readErr := os.ReadFile("douyin_asset_store.go")
	if readErr != nil || !strings.Contains(string(storeSource), "COALESCE(v.run_at,s.run_at)") || !strings.Contains(string(storeSource), "COALESCE(v.enabled,true)") {
		t.Fatal("style runtime fallback contract missing")
	}
}
