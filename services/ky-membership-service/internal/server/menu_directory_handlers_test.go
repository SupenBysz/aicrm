package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func TestMenuResolveRequiresEnabledAncestorAndExactMenuPermission(t *testing.T) {
	parent := "workbench.tools"
	group := store.MenuEntry{DirectoryType: "workbench", MenuKey: parent, NodeType: "group", Status: "active"}
	leaf := store.MenuEntry{DirectoryType: "workbench", MenuKey: "workbench.tools.lookup", NodeType: "leaf", ParentKey: &parent, Status: "active", PageType: "webview", PermissionCode: "menu.workbench.tools.lookup"}
	entries := map[string]store.MenuEntry{parent: group, leaf.MenuKey: leaf}
	if !menuAncestorsEnabled(leaf, entries) {
		t.Fatal("visible enabled parent should permit resolved child")
	}
	if containsCode([]string{"menu.workbench.tools.lookup"}, leaf.PermissionCode) != true {
		t.Fatal("exact assigned menu permission should pass")
	}
	if containsCode([]string{"menu.workbench.tools"}, leaf.PermissionCode) {
		t.Fatal("parent/related permission must not authorize child")
	}
	group.Status = "disabled"
	entries[parent] = group
	if menuAncestorsEnabled(leaf, entries) {
		t.Fatal("disabled ancestor must hide child")
	}
}

func TestMenuRuntimeProjectionExcludesAuthorizationAndRevisionInternals(t *testing.T) {
	entry := store.MenuEntry{DirectoryType: "management", MenuKey: "management.profile", NodeType: "leaf", Name: "Profile", PermissionCode: "menu.management.profile", WorkspaceTypes: []string{"platform"}, PageType: "internal", Status: "active", Revision: 99}
	encoded, err := json.Marshal(menuNavigationProjection([]store.MenuEntry{entry}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, excluded := range []string{"permissionCode", "workspaceTypes", "revision", "status"} {
		if strings.Contains(text, excluded) {
			t.Errorf("navigation projection leaks %s", excluded)
		}
	}
	for _, required := range []string{"management.profile", "Profile", "internal"} {
		if !strings.Contains(text, required) {
			t.Errorf("projection missing %s", required)
		}
	}
}
