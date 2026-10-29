package store

import (
	"os"
	"strings"
	"testing"
)

func TestValidateMenuEntryInput(t *testing.T) {
	route := "ky-access-management.roles"
	base := MenuEntryInput{MenuEntry: MenuEntry{DirectoryType: "management", MenuKey: "access.roles", NodeType: "leaf", Name: "Roles", PermissionCode: "platform.roles.view", WorkspaceTypes: []string{"platform"}, RouteKey: &route, PageType: "internal", Status: "active"}}
	if err := ValidateMenuEntryInput(base); err != nil {
		t.Fatalf("valid internal menu rejected: %v", err)
	}
	bad := base
	bad.NodeType = "group"
	if ValidateMenuEntryInput(bad) == nil {
		t.Fatal("group route must be rejected")
	}
	bad = base
	bad.DirectoryType = "douyin"
	if ValidateMenuEntryInput(bad) == nil {
		t.Fatal("platform-specific directory must be rejected")
	}
	bad = base
	bad.MenuKey = "../outside"
	if ValidateMenuEntryInput(bad) == nil {
		t.Fatal("invalid menu key must be rejected")
	}
	bad = base
	bad.RoutePath = strPointer("//external.example")
	if ValidateMenuEntryInput(bad) == nil {
		t.Fatal("protocol-relative route must be rejected")
	}
	bad = base
	bad.ExpectedRevision = int64Pointer(-1)
	if ValidateMenuEntryInput(bad) == nil {
		t.Fatal("negative revision must be rejected")
	}
}

func TestRegisteredMenuPermissionCodeSyntax(t *testing.T) {
	in := MenuEntryInput{MenuEntry: MenuEntry{DirectoryType: "workbench", MenuKey: "test.web", NodeType: "leaf", Name: "Web", PermissionCode: "menu.platform.matrix_accounts", WorkspaceTypes: []string{"platform"}, PageType: "webview", Status: "active"}}
	if err := ValidateMenuEntryInput(in); err != nil {
		t.Fatalf("existing menu.* permission rejected: %v", err)
	}
}

func TestValidateMenuWebViewConfigRestrictsProtocolsAndBindings(t *testing.T) {
	base := MenuWebViewConfigInput{Platform: "web", DefaultURL: "https://example.test/start", OpenMode: "embedded", Protocols: []string{"https"}, ScheduleMode: "page_first", Scripts: []MenuResourceRef{{Identifier: "COMMON", VersionPolicy: "pinned", VersionID: "asset_1", Version: "1.2.3"}}, Styles: []MenuResourceRef{}}
	if err := ValidateMenuWebViewConfig(base); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := base
	bad.DefaultURL = "javascript:alert(1)"
	if ValidateMenuWebViewConfig(bad) == nil {
		t.Fatal("javascript URL must be rejected")
	}
	bad = base
	bad.DefaultURL = "https://user:secret@example.test"
	if ValidateMenuWebViewConfig(bad) == nil {
		t.Fatal("URL userinfo must be rejected")
	}
	bad = base
	bad.Protocols = []string{"file"}
	if ValidateMenuWebViewConfig(bad) == nil {
		t.Fatal("file navigation must be rejected")
	}
	bad = base
	bad.Scripts = []MenuResourceRef{{Identifier: "COMMON", VersionPolicy: "pinned", VersionID: "a", Version: "latest"}}
	if ValidateMenuWebViewConfig(bad) == nil {
		t.Fatal("invalid pinned semver must be rejected")
	}
	bad = base
	bad.Scripts = []MenuResourceRef{{Identifier: "COMMON", VersionPolicy: "pinned", VersionID: "a", Version: "1.0.0"}, {Identifier: "COMMON", VersionPolicy: "pinned", VersionID: "b", Version: "1.1.0"}}
	if ValidateMenuWebViewConfig(bad) == nil {
		t.Fatal("duplicate resource binding must be rejected")
	}
	bad = base
	bad.Scripts = []MenuResourceRef{{Identifier: "COMMON", VersionPolicy: "latest_released", VersionID: "client-choice", Version: "9.9.9"}}
	if ValidateMenuWebViewConfig(bad) == nil {
		t.Fatal("client-pinned version must not be accepted as latest")
	}
}

func TestMenuMigrationDefinesGenericScopeAndCASWithoutKWWDomain(t *testing.T) {
	bytes, err := os.ReadFile("../../../../ops/db/107_menu_directory_and_webview_config.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(bytes)
	for _, required := range []string{"CREATE TABLE IF NOT EXISTS ky_menu_directory", "CREATE TABLE IF NOT EXISTS ky_menu_webview_config", "revision bigint NOT NULL DEFAULT 1", "config_scope IN ('common','workspace')", "ON CONFLICT (code) DO NOTHING"} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing %q", required)
		}
	}
	for _, forbidden := range []string{"kww.org.cn", "jinritemai", "proxy_password", "token"} {
		if strings.Contains(strings.ToLower(sql), forbidden) {
			t.Errorf("migration contains product-specific or secret field %q", forbidden)
		}
	}
}

func strPointer(value string) *string { return &value }
func int64Pointer(value int64) *int64 { return &value }
