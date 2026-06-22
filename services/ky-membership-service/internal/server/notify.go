package server

import (
	"context"
	"strings"
)

// notifyMember best-effort generates a personal notification for the user that
// owns membershipID, unless that user is the actor (self-suppression). Failures
// are ignored (non-critical path), consistent with audit.
func (s *Server) notifyMember(ctx context.Context, wc wsContext, membershipID, title, contentTmpl, notificationType string) {
	userID, err := s.store.MembershipUserID(ctx, membershipID)
	if err != nil || userID == "" {
		return
	}
	if userID == wc.UserID {
		return // do not notify a user of their own action
	}
	wsName, err := s.store.WorkspaceName(ctx, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil || wsName == "" {
		wsName = wc.WorkspaceID
	}
	content := renderContent(contentTmpl, wsName)
	_ = s.store.CreateUserNotification(ctx, userID, title, content, notificationType)
}

// notifyUsers best-effort fans out a personal notification to each user id in
// userIDs, suppressing the actor (self). The content template's {ws} placeholder
// is rendered with the current workspace name. Failures are ignored.
func (s *Server) notifyUsers(ctx context.Context, wc wsContext, userIDs []string, title, contentTmpl, notificationType string) {
	if len(userIDs) == 0 {
		return
	}
	wsName, err := s.store.WorkspaceName(ctx, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil || wsName == "" {
		wsName = wc.WorkspaceID
	}
	content := renderContent(contentTmpl, wsName)
	for _, userID := range userIDs {
		if userID == "" || userID == wc.UserID {
			continue
		}
		_ = s.store.CreateUserNotification(ctx, userID, title, content, notificationType)
	}
}

// renderContent substitutes the workspace name placeholder {ws} in a template.
func renderContent(tmpl, wsName string) string {
	return strings.ReplaceAll(tmpl, "{ws}", wsName)
}
