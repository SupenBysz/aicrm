package server

import (
	"encoding/json"
	"testing"
)

// TestSettingsWorkspaceGating documents the intended workspace gating for the
// Phase 1.11 endpoints via the shared typeAllowed helper.
func TestSettingsWorkspaceGating(t *testing.T) {
	// /settings is agency,enterprise only
	if typeAllowed("agency,enterprise", "platform") {
		t.Error("/settings must reject platform workspace")
	}
	if !typeAllowed("agency,enterprise", "agency") {
		t.Error("/settings must allow agency workspace")
	}
	// platform system-settings / dictionaries / platform workbench are platform-only
	if typeAllowed("platform", "agency") {
		t.Error("platform-only endpoint must reject agency workspace")
	}
	if !typeAllowed("platform", "platform") {
		t.Error("platform-only endpoint must allow platform workspace")
	}
}

func TestSettingsPatchOnlyAcceptsMFABoolean(t *testing.T) {
	if err := validateSettingsPatch(map[string]json.RawMessage{"security": json.RawMessage(`{"mfaEnabled":true,"sessionHours":12}`)}); err != nil {
		t.Fatalf("布尔MFA配置应被接受: %v", err)
	}
	for name, settings := range map[string]map[string]json.RawMessage{
		"字符串":          {"security": json.RawMessage(`{"mfaEnabled":"true"}`)},
		"缺失":           {"security": json.RawMessage(`{"sessionHours":12}`)},
		"空值":           {"security": json.RawMessage(`{"mfaEnabled":null}`)},
		"字面点号键":        {"security.mfaEnabled": json.RawMessage("true")},
		"未知顶层键":        {"general": json.RawMessage(`{"enabled":true}`)},
		"security非法类型": {"security": json.RawMessage(`true`)},
		"空补丁":          {},
	} {
		if err := validateSettingsPatch(settings); err == nil {
			t.Fatalf("%s应被拒绝", name)
		}
	}
}
