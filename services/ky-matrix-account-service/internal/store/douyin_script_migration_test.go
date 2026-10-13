package store

import (
	"os"
	"strings"
	"testing"
)

func TestDouyinScriptMigrationContract(t *testing.T) {
	b, err := os.ReadFile("../../../../ops/db/086_matrix_account_douyin_scripts.sql")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_douyin_script",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_douyin_script_version",
		"platform.matrix_account_douyin_scripts.content_view",
		"menu.platform.matrix_account_douyin_scripts",
		"ON CONFLICT(code) DO NOTHING",
		"CHECK (platform = 'douyin')",
	} {
		if !strings.Contains(s, required) {
			t.Fatalf("migration missing %q", required)
		}
	}
	b2, err := os.ReadFile("../../../../ops/db/087_matrix_account_douyin_script_assets.sql")
	if err != nil {
		t.Fatal(err)
	}
	s2 := string(b2)
	for _, required := range []string{
		"ky_matrix_account_douyin_script_asset_version",
		"asset_type IN ('script','style')",
		"latest_script_asset_version_id",
		"effective_style_asset_version_id",
		"ON CONFLICT (script_id,asset_type,version) DO NOTHING",
	} {
		if !strings.Contains(s2, required) {
			t.Fatalf("asset migration missing %q", required)
		}
	}
	if strings.Contains(s, "ky_matrix_account_login_script") {
		t.Fatal("new migration must not modify legacy login script tables")
	}
	bPublic, err := os.ReadFile("../../../../ops/db/092_matrix_account_public_scripts.sql")
	if err != nil {
		t.Fatal(err)
	}
	public := string(bPublic)
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_public_script",
		"workspace_type IN ('platform','agency','enterprise')",
		"ky_matrix_account_public_script_identifier_uidx",
		"source_chars integer",
		"source_bytes integer",
		"source_sha256 text",
		"WHERE deleted_at IS NULL",
	} {
		if !strings.Contains(public, required) {
			t.Fatalf("public script migration missing %q", required)
		}
	}
	if strings.Contains(public, "ky_matrix_account_douyin_script") || strings.Contains(public, "ky_matrix_account_login_script") {
		t.Fatal("public script migration must not modify existing script tables")
	}
	bHashFix, err := os.ReadFile("../../../../ops/db/096_matrix_account_douyin_asset_source_hash_fix.sql")
	if err != nil {
		t.Fatal(err)
	}
	hashFix := string(bHashFix)
	for _, required := range []string{
		"CREATE EXTENSION IF NOT EXISTS pgcrypto",
		"source_sha256 IS DISTINCT FROM",
		"encode(sha256(convert_to(source_content, 'UTF8')), 'hex')",
	} {
		if !strings.Contains(hashFix, required) {
			t.Fatalf("hash repair migration missing %q", required)
		}
	}
	bRules, err := os.ReadFile("../../../../ops/db/093_matrix_account_douyin_script_match_rules.sql")
	if err != nil {
		t.Fatal(err)
	}
	rules := string(bRules)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS match_rules jsonb",
		"jsonb_build_array",
		"matchType",
		"ALTER COLUMN match_rules SET NOT NULL",
		"match_rules_array_ck",
		"match_type IN ('exact','prefix','wildcard')",
	} {
		if !strings.Contains(rules, required) {
			t.Fatalf("multi-rule migration missing %q", required)
		}
	}
	b3, err := os.ReadFile("../../../../ops/db/088_matrix_account_douyin_script_identifier.sql")
	if err != nil {
		t.Fatal(err)
	}
	s3 := string(b3)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS identifier text",
		"ky_matrix_account_douyin_script_identifier_ck",
		"ky_matrix_account_douyin_script_identifier_uidx",
		"script_' || regexp_replace(id",
	} {
		if !strings.Contains(s3, required) {
			t.Fatalf("identifier migration missing %q", required)
		}
	}
	b4, err := os.ReadFile("../../../../ops/db/089_matrix_account_douyin_script_runtime_contract.sql")
	if err != nil {
		t.Fatal(err)
	}
	s4 := string(b4)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS run_at text",
		"ADD COLUMN IF NOT EXISTS priority integer",
		"SET run_at = 'document_idle'",
		"SET priority = 1000",
		"ky_matrix_account_douyin_script_run_at_ck",
		"ky_matrix_account_douyin_script_priority_ck",
		"document_start",
		"spa_route_change",
		"BETWEEN -10000 AND 10000",
	} {
		if !strings.Contains(s4, required) {
			t.Fatalf("runtime migration missing %q", required)
		}
	}
	b5, err := os.ReadFile("../../../../ops/db/090_matrix_account_douyin_asset_published_at.sql")
	if err != nil {
		t.Fatal(err)
	}
	s5 := string(b5)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS published_at timestamptz",
		"status IN ('released', 'active')",
		"published_at = updated_at",
	} {
		if !strings.Contains(s5, required) {
			t.Fatalf("published-at migration missing %q", required)
		}
	}
	b6, err := os.ReadFile("../../../../ops/db/091_matrix_account_douyin_style_runtime.sql")
	if err != nil {
		t.Fatal(err)
	}
	s6 := string(b6)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS run_at text",
		"ADD COLUMN IF NOT EXISTS priority integer",
		"ADD COLUMN IF NOT EXISTS enabled boolean",
		"ky_matrix_account_douyin_asset_run_at_ck",
		"ky_matrix_account_douyin_asset_priority_ck",
		"spa_route_change",
	} {
		if !strings.Contains(s6, required) {
			t.Fatalf("style runtime migration missing %q", required)
		}
	}
	b7, err := os.ReadFile("../../../../ops/db/094_matrix_account_public_script_sdk.sql")
	if err != nil {
		t.Fatal(err)
	}
	s7 := string(b7)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS platform text",
		"ADD COLUMN IF NOT EXISTS dependencies jsonb",
		"ky_matrix_account_public_script_platform_check",
		"ky_matrix_account_public_script_runtime_idx",
		"WHERE deleted_at IS NULL",
	} {
		if !strings.Contains(s7, required) {
			t.Fatalf("public sdk migration missing %q", required)
		}
	}
}
