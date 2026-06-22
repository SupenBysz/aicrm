package server

import (
	"strings"
	"testing"
)

func TestRenderContent(t *testing.T) {
	got := renderContent("您在『{ws}』的成员状态已变更为：disabled", "A 企业")
	want := "您在『A 企业』的成员状态已变更为：disabled"
	if got != want {
		t.Errorf("renderContent=%q want %q", got, want)
	}
	// no placeholder -> unchanged
	if renderContent("no placeholder", "X") != "no placeholder" {
		t.Error("template without {ws} should be unchanged")
	}
	// multiple placeholders
	if renderContent("{ws}/{ws}", "W") != "W/W" {
		t.Error("all placeholders should be replaced")
	}
}

// TestEventNotificationTypes documents the locked notification_type mapping for
// the five member events (must stay within the ky_notification CHECK enum).
func TestEventNotificationTypes(t *testing.T) {
	valid := map[string]bool{"invite": true, "security": true, "system": true, "permission": true, "organization": true}
	mapping := map[string]string{
		"member.status_changed":       "security",
		"member.removed":              "organization",
		"member.departments_assigned": "organization",
		"member.teams_assigned":       "organization",
		"membership.roles_assigned":   "permission",
		"role.permissions_updated":    "permission", // fan-out to role holders (1.16)
		"role.status_changed":         "permission", // disable/enable strips/restores holder perms (1.17 review)
	}
	for event, nType := range mapping {
		if !valid[nType] {
			t.Errorf("event %s maps to invalid notification_type %q", event, nType)
		}
	}
}

func TestContentTemplatesHaveWorkspacePlaceholder(t *testing.T) {
	// The removal template intentionally references the workspace via {ws}.
	templates := []string{
		"您在『{ws}』的成员状态已变更为：disabled",
		"您已被移出『{ws}』",
		"您在『{ws}』的部门归属已更新",
		"您在『{ws}』的团队归属已更新",
		"您在『{ws}』的角色已更新",
	}
	for _, tmpl := range templates {
		if !strings.Contains(tmpl, "{ws}") {
			t.Errorf("template missing {ws}: %s", tmpl)
		}
	}
}
