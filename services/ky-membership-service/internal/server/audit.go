package server

import (
	"context"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

// audit writes a best-effort audit record for a successful operation. Failure
// to write the audit log must not affect the business response.
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
		Source:            "ky-membership-service",
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

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.TrimSpace(strings.Split(ip, ",")[0])
	}
	return r.RemoteAddr
}
