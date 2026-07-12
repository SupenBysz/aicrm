package store

import (
	"testing"
	"time"
)

func TestAuthenticationWithinAgeUsesInclusiveSecondBoundaryAndRejectsFuture(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	if !authenticationWithinAge(now.Add(-600*time.Second), now, 600) {
		t.Fatal("exact 600-second authentication boundary was rejected")
	}
	if authenticationWithinAge(now.Add(-600*time.Second-time.Nanosecond), now, 600) {
		t.Fatal("authentication older than 600 seconds was accepted")
	}
	if authenticationWithinAge(now.Add(time.Nanosecond), now, 600) {
		t.Fatal("future authentication timestamp was accepted")
	}
}

func TestAccessAssuranceDenialReasonIsStableAndFailClosed(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	requirements := AccessAssuranceRequirements{
		RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: 600, RequireMFAIfEnabled: true,
	}
	facts := AccessAssuranceFacts{MFARequired: true}
	if reason := accessAssuranceDenialReason(requirements, facts, now.Add(-time.Hour), now); reason != "owner_required" {
		t.Fatalf("owner reason=%s", reason)
	}
	facts.WorkspaceOwner = true
	if reason := accessAssuranceDenialReason(requirements, facts, now.Add(-time.Hour), now); reason != "fresh_login_required" {
		t.Fatalf("fresh-login reason=%s", reason)
	}
	if reason := accessAssuranceDenialReason(requirements, facts, now.Add(-time.Minute), now); reason != "mfa_required" {
		t.Fatalf("MFA reason=%s", reason)
	}
}

func TestWorkspaceOwnerRoleCodesAreExact(t *testing.T) {
	want := map[string]string{
		"platform": "platform_owner", "agency": "agency_owner", "enterprise": "enterprise_owner",
	}
	for workspaceType, expected := range want {
		actual, ok := workspaceOwnerRoleCode(workspaceType)
		if !ok || actual != expected {
			t.Fatalf("workspace=%s role=%s ok=%v", workspaceType, actual, ok)
		}
	}
	if _, ok := workspaceOwnerRoleCode("forged"); ok {
		t.Fatal("unknown workspace owner code was accepted")
	}
}
