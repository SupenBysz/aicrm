package server

import "testing"

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
