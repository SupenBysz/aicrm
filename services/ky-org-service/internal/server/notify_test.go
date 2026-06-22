package server

import "testing"

// TestFanoutNotificationTypes documents the locked notification_type mapping for
// the org-service fan-out events (must stay within the ky_notification CHECK enum).
func TestFanoutNotificationTypes(t *testing.T) {
	valid := map[string]bool{"invite": true, "security": true, "system": true, "permission": true, "organization": true}
	mapping := map[string]string{
		"agency.status_changed":     "organization",
		"enterprise.status_changed": "organization",
	}
	for event, nType := range mapping {
		if !valid[nType] {
			t.Errorf("event %s maps to invalid notification_type %q", event, nType)
		}
	}
}
