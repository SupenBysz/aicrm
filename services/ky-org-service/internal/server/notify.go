package server

import "context"

// notifyOrgMembers best-effort fans out a personal notification to all active
// members (by user id) of the given agency/enterprise workspace, suppressing
// the actor (self). Failures are ignored (non-critical path), consistent with
// audit (Phase 1.16).
func (s *Server) notifyOrgMembers(ctx context.Context, wc wsContext, workspaceType, workspaceID, title, content, notificationType string) {
	userIDs, err := s.store.ActiveMemberUserIDs(ctx, workspaceType, workspaceID)
	if err != nil || len(userIDs) == 0 {
		return
	}
	for _, userID := range userIDs {
		if userID == "" || userID == wc.UserID {
			continue
		}
		_ = s.store.CreateUserNotification(ctx, userID, title, content, notificationType)
	}
}
