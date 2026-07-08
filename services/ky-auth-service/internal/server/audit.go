package server

import (
	"context"
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/store"
)

func (s *Server) audit(ctx context.Context, r *http.Request, wc workspaceAdminContext, action, resourceType, resourceID string, detail map[string]any) {
	entry := store.AuditEntry{
		ActorUserID:       wc.userID,
		ActorMembershipID: wc.membershipID,
		WorkspaceType:     wc.workspaceType,
		WorkspaceID:       wc.workspaceID,
		Action:            action,
		ResourceType:      resourceType,
		ResourceID:        resourceID,
		Result:            "success",
		RequestID:         requestID(r),
		IPAddress:         clientIP(r),
		UserAgent:         r.UserAgent(),
		Source:            "ky-auth-service",
		Detail:            detail,
	}
	switch wc.workspaceType {
	case "agency":
		entry.AgencyID = wc.workspaceID
	case "enterprise":
		entry.EnterpriseID = wc.workspaceID
	}
	_ = s.store.WriteAudit(ctx, entry)
}
