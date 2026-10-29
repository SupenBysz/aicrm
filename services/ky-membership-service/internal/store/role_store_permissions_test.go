package store

import (
	"reflect"
	"testing"
)

func TestGroupRolePermissionIDs(t *testing.T) {
	got := groupRolePermissionIDs(
		[]string{"workspace-role", "template-role", "empty-role"},
		[]rolePermissionPair{
			{roleID: "template-role", permissionID: "menu.accounts"},
			{roleID: "workspace-role", permissionID: "menu.roles"},
			{roleID: "outside-page-role", permissionID: "menu.secret"},
			{roleID: "workspace-role", permissionID: "action.roles.edit"},
		},
	)
	want := map[string][]string{
		"workspace-role": {"menu.roles", "action.roles.edit"},
		"template-role":  {"menu.accounts"},
		"empty-role":     {},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("groupRolePermissionIDs() = %#v, want %#v", got, want)
	}
}

func TestRolePermissionQueryPlaceholders(t *testing.T) {
	if got, want := rolePermissionPlaceholders(1, 3), "$1,$2,$3"; got != want {
		t.Fatalf("rolePermissionPlaceholders() = %q, want %q", got, want)
	}
	if got, want := rolePermissionPlaceholders(4, 2), "$4,$5"; got != want {
		t.Fatalf("rolePermissionPlaceholders() offset = %q, want %q", got, want)
	}
}
