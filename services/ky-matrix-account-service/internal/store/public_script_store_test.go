package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPublicScriptInputDefaultsAndSourceDigest(t *testing.T) {
	source := "const 标识 = '🙂';"
	in, err := normalizePublicScriptInput(PublicScriptInput{
		Name:          "公共脚本",
		Identifier:    "SHARED_SCRIPT_1",
		SourceContent: source,
	}, false)
	if err != nil {
		t.Fatalf("valid public script rejected: %v", err)
	}
	if in.Enabled == nil || !*in.Enabled {
		t.Fatal("create input should default enabled=true")
	}
	if got, want := utf8.RuneCountInString(source), 15; got != want {
		t.Fatalf("source character count=%d, want %d", got, want)
	}
	if got, want := len([]byte(source)), 22; got != want {
		t.Fatalf("source byte count=%d, want %d", got, want)
	}
	if publicScriptHash(source) == publicScriptHash(source+" ") {
		t.Fatal("source hash must change when source changes")
	}
	if publicScriptStatus(true) != "enabled" || publicScriptStatus(false) != "disabled" {
		t.Fatal("status mapping changed")
	}
}

func TestPublicScriptInputValidation(t *testing.T) {
	base := PublicScriptInput{Name: "公共脚本", Identifier: "SHARED", SourceContent: ""}
	for _, bad := range []PublicScriptInput{
		{Name: "", Identifier: "SHARED"},
		{Name: "公共脚本", Identifier: "-starts"},
		{Name: "公共脚本", Identifier: "has space"},
		{Name: "公共脚本", Identifier: strings.Repeat("a", 65)},
	} {
		if _, err := normalizePublicScriptInput(bad, false); !errors.Is(err, ErrValidation) {
			t.Fatalf("invalid input accepted: %+v", bad)
		}
	}
	if _, err := normalizePublicScriptInput(base, true); !errors.Is(err, ErrValidation) {
		t.Fatal("update without enabled should be rejected")
	}
	invalidUTF8 := base
	invalidUTF8.SourceContent = string([]byte{0xff})
	if _, err := normalizePublicScriptInput(invalidUTF8, false); !errors.Is(err, ErrValidation) {
		t.Fatal("invalid UTF-8 source accepted")
	}
}

func TestPublicScriptDependencyOrderingAndFailures(t *testing.T) {
	items := []PublicRuntimeScript{
		{Identifier: "COMMON", Dependencies: []PublicScriptDependency{{Identifier: "BASE"}}},
		{Identifier: "BASE"},
	}
	ordered, err := OrderPublicScriptDependencies(items, []string{"COMMON"})
	if err != nil || len(ordered) != 2 || ordered[0].Identifier != "BASE" || ordered[1].Identifier != "COMMON" {
		t.Fatalf("unexpected dependency order: %#v %v", ordered, err)
	}
	items[0].Dependencies = []PublicScriptDependency{{Identifier: "MISSING"}}
	if _, err := OrderPublicScriptDependencies(items, []string{"COMMON"}); !errors.Is(err, ErrPublicDependencyMissing) || !strings.Contains(err.Error(), "MISSING") {
		t.Fatalf("missing dependency error=%v", err)
	}
	items[0].Dependencies = []PublicScriptDependency{{Identifier: "BASE"}}
	items[1].Dependencies = []PublicScriptDependency{{Identifier: "COMMON"}}
	if _, err := OrderPublicScriptDependencies(items, []string{"COMMON"}); !errors.Is(err, ErrPublicDependencyCycle) {
		t.Fatalf("cycle error=%v", err)
	}
}

func TestParseBusinessPublicDependenciesReadsOneExecutableDeclaration(t *testing.T) {
	dependencies, err := ParseBusinessPublicDependencies(`// 业务脚本可按需声明公共模块。
const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":["normalize"]},{"identifier":"COMMON_DOUYIN","methods":["clickEmailLoginTab","ensurePolicyAccepted","selectStoreByName"]}];
(async () => {})();`)
	if err != nil {
		t.Fatalf("parse dependencies: %v", err)
	}
	if len(dependencies) != 2 || dependencies[0].Identifier != "COMMON_FUN" || dependencies[0].Methods[0] != "normalize" {
		t.Fatalf("unexpected dependency declaration: %#v", dependencies)
	}
	wantDouyin := []string{"clickEmailLoginTab", "ensurePolicyAccepted", "selectStoreByName"}
	if len(dependencies[1].Methods) != len(wantDouyin) {
		t.Fatalf("COMMON_DOUYIN methods=%v", dependencies[1].Methods)
	}
	for i, method := range wantDouyin {
		if dependencies[1].Methods[i] != method {
			t.Fatalf("COMMON_DOUYIN method[%d]=%q, want %q", i, dependencies[1].Methods[i], method)
		}
	}

	// 中性模板的有效声明默认为空；注释示例不会加载模块。
	dependencies, err = ParseBusinessPublicDependencies(`const KWW_PUBLIC_DEPENDENCIES = [];
// const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_DOUYIN","methods":["selectStoreByName"]}];
(async () => {})();`)
	if err != nil || len(dependencies) != 0 {
		t.Fatalf("empty declaration should require no module: %#v %v", dependencies, err)
	}
	dependencies, err = ParseBusinessPublicDependencies(`(async () => {})();`)
	if err != nil || len(dependencies) != 0 {
		t.Fatalf("未声明依赖的旧脚本应保持无依赖：%#v %v", dependencies, err)
	}
	dependencies, err = ParseBusinessPublicDependencies("const existing = true;\n" + `const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":[]}];` + "\n(async () => {})();")
	if err != nil || len(dependencies) != 1 || dependencies[0].Identifier != "COMMON_FUN" {
		t.Fatalf("模板插入到既有源码中段后仍应识别声明：%#v %v", dependencies, err)
	}
	dependencies, err = ParseBusinessPublicDependencies("const example = " + "`" + "\nconst KWW_PUBLIC_DEPENDENCIES = [{\"identifier\":\"SHOULD_NOT_LOAD\",\"methods\":[]}];\n" + "`" + ";\n/* const KWW_PUBLIC_DEPENDENCIES = [{\"identifier\":\"ALSO_NOT_LOADED\",\"methods\":[]}]; */")
	if err != nil || len(dependencies) != 0 {
		t.Fatalf("注释和模板字符串中的示例不得被解析：%#v %v", dependencies, err)
	}
	if _, err := ParseBusinessPublicDependencies("const KWW_PUBLIC_DEPENDENCIES = [];\nconst KWW_PUBLIC_DEPENDENCIES = [];"); err == nil {
		t.Fatal("重复的可执行声明必须拒绝")
	}
}

func TestBusinessPublicDependencyValidationAndDeduplication(t *testing.T) {
	dependencies, err := ParseBusinessPublicDependencies(`const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":["normalize","normalize"]},{"identifier":"COMMON_FUN","methods":["format"]}];`)
	if err != nil || len(dependencies) != 1 || len(dependencies[0].Methods) != 2 || dependencies[0].Methods[0] != "normalize" || dependencies[0].Methods[1] != "format" {
		t.Fatalf("duplicate dependencies/methods were not merged: %#v %v", dependencies, err)
	}
	repeated := make([]BusinessPublicDependency, maxBusinessPublicDependencies+1)
	for i := range repeated {
		repeated[i] = BusinessPublicDependency{Identifier: "COMMON_FUN", Methods: []string{"normalize"}}
	}
	if normalized, err := normalizeBusinessPublicDependencies(repeated); err != nil || len(normalized) != 1 || len(normalized[0].Methods) != 1 {
		t.Fatalf("repeated declarations should deduplicate before the unique limit: %#v %v", normalized, err)
	}
	for _, declaration := range []string{
		`const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"bad/id","methods":[]}];`,
		`const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","methods":["not-a-method"]}];`,
		`const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_FUN","unknown":[]}];`,
		`const KWW_PUBLIC_DEPENDENCIES = [notJson];`,
	} {
		if _, err := ParseBusinessPublicDependencies(declaration); err == nil {
			t.Fatalf("invalid declaration accepted: %s", declaration)
		}
	}
	tooMany := make([]BusinessPublicDependency, maxBusinessPublicDependencies+1)
	for i := range tooMany {
		tooMany[i] = BusinessPublicDependency{Identifier: fmt.Sprintf("COMMON_%d", i)}
	}
	encoded, err := json.Marshal(tooMany)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseBusinessPublicDependencies("const KWW_PUBLIC_DEPENDENCIES = " + string(encoded) + ";"); err == nil {
		t.Fatal("dependency count limit was not enforced")
	}
}

func TestRuntimePublicDependencyRootsIncludesSourceAndLegacyBindings(t *testing.T) {
	assets := []RuntimeAsset{
		{AssetType: "script", SourceContent: `const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"COMMON_DOUYIN","methods":["selectStoreByName"]}];`},
		{AssetType: "style", SourceContent: `const KWW_PUBLIC_DEPENDENCIES = [{"identifier":"SHOULD_NOT_LOAD","methods":[]}];`},
	}
	roots, err := RuntimePublicDependencyRoots(assets, []string{"COMMON_FUN", "COMMON_DOUYIN"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"COMMON_DOUYIN", "COMMON_FUN"}
	if len(roots) != len(want) {
		t.Fatalf("roots=%v, want %v", roots, want)
	}
	for i := range want {
		if roots[i] != want[i] {
			t.Fatalf("roots=%v, want %v", roots, want)
		}
	}
	declaredOnly, err := RuntimePublicDependencyRoots(assets[:1], nil)
	if err != nil || len(declaredOnly) != 1 || declaredOnly[0] != "COMMON_DOUYIN" {
		t.Fatalf("source dependency must resolve without external binding: roots=%v err=%v", declaredOnly, err)
	}
	if _, err := OrderPublicScriptDependencies(nil, declaredOnly); !errors.Is(err, ErrPublicDependencyMissing) || !strings.Contains(err.Error(), "COMMON_DOUYIN") {
		t.Fatalf("missing declared module should identify its id: %v", err)
	}
}

func TestPublicScriptMigrationContract(t *testing.T) {
	b, err := os.ReadFile("../../../../ops/db/092_matrix_account_public_scripts.sql")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_public_script",
		"workspace_type IN ('platform','agency','enterprise')",
		"identifier ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'",
		"source_chars integer",
		"source_bytes integer",
		"source_sha256 text",
		"ky_matrix_account_public_script_identifier_uidx",
		"WHERE deleted_at IS NULL",
	} {
		if !strings.Contains(s, required) {
			t.Fatalf("migration missing %q", required)
		}
	}
	if strings.Contains(s, "ky_matrix_account_douyin_script") || strings.Contains(s, "ky_matrix_account_login_script") {
		t.Fatal("public script migration must not modify existing script tables")
	}
}

func TestPublicScriptSQLContractsKeepWorkspaceAndRevisionGuards(t *testing.T) {
	b, err := os.ReadFile("public_script_store.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, required := range []string{
		"workspace_type=$1",
		"workspace_id=$2",
		"deleted_at IS NULL",
		"AND revision=$17",
		"deleted_at=now()",
		"source_chars",
		"source_bytes",
		"source_sha256",
	} {
		if !strings.Contains(s, required) {
			t.Fatalf("public script SQL contract missing %q", required)
		}
	}
}
