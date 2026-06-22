package server

import (
	"net/http/httptest"
	"testing"
)

// invitationTargetAllowed cases that do not require DB access (the agency->
// enterprise check that hits the store is exercised separately in integration).
func TestInvitationTargetAllowed_NoDB(t *testing.T) {
	s := &Server{}
	r := httptest.NewRequest("POST", "/api/v1/invitations", nil)

	cases := []struct {
		name string
		wc   wsContext
		in   createInvitationInput
		want bool
	}{
		{
			name: "member into own workspace",
			wc:   wsContext{WorkspaceType: "enterprise", WorkspaceID: "ent_1"},
			in:   createInvitationInput{InvitationType: "member", TargetWorkspaceType: "enterprise", TargetWorkspaceID: "ent_1"},
			want: true,
		},
		{
			name: "member into other workspace rejected",
			wc:   wsContext{WorkspaceType: "enterprise", WorkspaceID: "ent_1"},
			in:   createInvitationInput{InvitationType: "member", TargetWorkspaceType: "enterprise", TargetWorkspaceID: "ent_2"},
			want: false,
		},
		{
			name: "agency_admin from platform ok",
			wc:   wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"},
			in:   createInvitationInput{InvitationType: "agency_admin", TargetWorkspaceType: "agency", TargetWorkspaceID: "ag_1"},
			want: true,
		},
		{
			name: "agency_admin from agency rejected",
			wc:   wsContext{WorkspaceType: "agency", WorkspaceID: "ag_1"},
			in:   createInvitationInput{InvitationType: "agency_admin", TargetWorkspaceType: "agency", TargetWorkspaceID: "ag_1"},
			want: false,
		},
		{
			name: "enterprise_admin from platform ok",
			wc:   wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"},
			in:   createInvitationInput{InvitationType: "enterprise_admin", TargetWorkspaceType: "enterprise", TargetWorkspaceID: "ent_9"},
			want: true,
		},
		{
			name: "enterprise_admin wrong target type rejected",
			wc:   wsContext{WorkspaceType: "platform", WorkspaceID: "platform_root"},
			in:   createInvitationInput{InvitationType: "enterprise_admin", TargetWorkspaceType: "agency", TargetWorkspaceID: "ag_1"},
			want: false,
		},
		{
			name: "enterprise_admin from enterprise rejected",
			wc:   wsContext{WorkspaceType: "enterprise", WorkspaceID: "ent_1"},
			in:   createInvitationInput{InvitationType: "enterprise_admin", TargetWorkspaceType: "enterprise", TargetWorkspaceID: "ent_1"},
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, _ := s.invitationTargetAllowed(r, c.wc, c.in)
			if got != c.want {
				t.Errorf("invitationTargetAllowed=%v want %v", got, c.want)
			}
		})
	}
}

func TestTypeAllowedAndStatus(t *testing.T) {
	if !typeAllowed("platform,agency,enterprise", "agency") {
		t.Error("agency should be allowed")
	}
	if typeAllowed("agency,enterprise", "platform") {
		t.Error("platform should be rejected for org-only handlers")
	}
	if !validStatus("active", "active", "disabled", "left") {
		t.Error("active should be valid")
	}
	if validStatus("bogus", "active", "disabled", "left") {
		t.Error("bogus should be invalid")
	}
}
