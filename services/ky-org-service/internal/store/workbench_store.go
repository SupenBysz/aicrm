package store

import (
	"context"
	"time"
)

type AuditLogBrief struct {
	ID           string    `json:"id"`
	Action       string    `json:"action"`
	ResourceType string    `json:"resourceType"`
	ActorUserID  *string   `json:"actorUserId"`
	CreatedAt    time.Time `json:"createdAt"`
}

type PlatformSummary struct {
	UserCount              int64           `json:"userCount"`
	AgencyCount            int64           `json:"agencyCount"`
	EnterpriseCount        int64           `json:"enterpriseCount"`
	TodayLoginCount        int64           `json:"todayLoginCount"`
	EnabledAiProviderCount int64           `json:"enabledAiProviderCount"`
	EnabledAiModelCount    int64           `json:"enabledAiModelCount"`
	RecentAuditLogs        []AuditLogBrief `json:"recentAuditLogs"`
}

type OrgSummary struct {
	MemberCount            int64           `json:"memberCount"`
	DepartmentCount        int64           `json:"departmentCount"`
	TeamCount              int64           `json:"teamCount"`
	EnterpriseCount        int64           `json:"enterpriseCount,omitempty"`
	PendingInvitationCount int64           `json:"pendingInvitationCount"`
	RecentAuditLogs        []AuditLogBrief `json:"recentAuditLogs"`
}

func (s *Store) scalar(ctx context.Context, query string, args ...any) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&n)
	return n, err
}

func (s *Store) PlatformWorkbenchSummary(ctx context.Context) (PlatformSummary, error) {
	var sum PlatformSummary
	var err error
	if sum.UserCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_user WHERE deleted_at IS NULL`); err != nil {
		return sum, err
	}
	if sum.AgencyCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_agency WHERE deleted_at IS NULL`); err != nil {
		return sum, err
	}
	if sum.EnterpriseCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_enterprise WHERE deleted_at IS NULL`); err != nil {
		return sum, err
	}
	if sum.TodayLoginCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_login_log WHERE result='success' AND created_at >= date_trunc('day', now())`); err != nil {
		return sum, err
	}
	if sum.EnabledAiProviderCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_ai_provider WHERE status='enabled' AND deleted_at IS NULL`); err != nil {
		return sum, err
	}
	if sum.EnabledAiModelCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_ai_model WHERE status='enabled' AND deleted_at IS NULL`); err != nil {
		return sum, err
	}
	if sum.RecentAuditLogs, err = s.recentAuditLogs(ctx, "", ""); err != nil {
		return sum, err
	}
	return sum, nil
}

func (s *Store) OrgWorkbenchSummary(ctx context.Context, wsType, wsID string) (OrgSummary, error) {
	var sum OrgSummary
	var err error
	if sum.MemberCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_membership WHERE workspace_type=$1 AND workspace_id=$2 AND status='active' AND deleted_at IS NULL`, wsType, wsID); err != nil {
		return sum, err
	}
	if sum.DepartmentCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_department WHERE workspace_type=$1 AND workspace_id=$2 AND deleted_at IS NULL`, wsType, wsID); err != nil {
		return sum, err
	}
	if sum.TeamCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_team WHERE workspace_type=$1 AND workspace_id=$2 AND deleted_at IS NULL`, wsType, wsID); err != nil {
		return sum, err
	}
	if wsType == "agency" {
		if sum.EnterpriseCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_enterprise WHERE agency_id=$1 AND deleted_at IS NULL`, wsID); err != nil {
			return sum, err
		}
	}
	if sum.PendingInvitationCount, err = s.scalar(ctx, `SELECT count(*) FROM ky_invitation WHERE workspace_type=$1 AND workspace_id=$2 AND status='pending'`, wsType, wsID); err != nil {
		return sum, err
	}
	if sum.RecentAuditLogs, err = s.recentAuditLogs(ctx, wsType, wsID); err != nil {
		return sum, err
	}
	return sum, nil
}

// recentAuditLogs returns the 5 most recent audit logs, globally when wsType is
// empty, otherwise scoped to the workspace.
func (s *Store) recentAuditLogs(ctx context.Context, wsType, wsID string) ([]AuditLogBrief, error) {
	query := `SELECT id, action, resource_type, actor_user_id, created_at FROM ky_audit_log`
	args := []any{}
	if wsType != "" {
		query += ` WHERE workspace_type=$1 AND workspace_id=$2`
		args = append(args, wsType, wsID)
	}
	query += ` ORDER BY created_at DESC LIMIT 5`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditLogBrief{}
	for rows.Next() {
		var a AuditLogBrief
		if err := rows.Scan(&a.ID, &a.Action, &a.ResourceType, &a.ActorUserID, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
