package store

import (
	"context"

	"github.com/Kysion/KyaiCRM/shared/notify"
)

// CreateUserNotification inserts a personal notification targeted at a user
// (scope_type='user', recipient_user_id=userID). Delegates to shared/notify
// (single source of truth, Phase 1.17).
func (s *Store) CreateUserNotification(ctx context.Context, userID, title, content, notificationType string) error {
	return notify.CreateUserNotification(ctx, s.db, userID, title, content, notificationType)
}

// ActiveMemberUserIDs returns the distinct owning user ids of all active,
// non-deleted memberships of the given workspace (agency/enterprise). Used to
// fan out organization status-change notifications (Phase 1.16).
func (s *Store) ActiveMemberUserIDs(ctx context.Context, workspaceType, workspaceID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT user_id FROM ky_membership
		WHERE workspace_type = $1 AND workspace_id = $2 AND status = 'active' AND deleted_at IS NULL
	`, workspaceType, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
