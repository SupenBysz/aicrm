package server

import (
	"context"
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) audit(ctx context.Context, r *http.Request, wc wsContext, action, resourceType, resourceID string, detail map[string]any) {
	entry := store.AuditEntry{
		ActorUserID:       wc.UserID,
		ActorMembershipID: wc.MembershipID,
		WorkspaceType:     wc.WorkspaceType,
		WorkspaceID:       wc.WorkspaceID,
		Action:            action,
		ResourceType:      resourceType,
		ResourceID:        resourceID,
		Result:            "success",
		RequestID:         requestID(r),
		IPAddress:         clientIP(r),
		UserAgent:         r.UserAgent(),
		Source:            "ky-matrix-account-service",
		Detail:            detail,
	}
	switch wc.WorkspaceType {
	case "agency":
		entry.AgencyID = wc.WorkspaceID
	case "enterprise":
		entry.EnterpriseID = wc.WorkspaceID
	}
	_ = s.store.WriteAudit(ctx, entry)
}
