package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

type AuditEntry struct {
	ActorUserID       string
	ActorMembershipID string
	WorkspaceType     string
	WorkspaceID       string
	AgencyID          string
	EnterpriseID      string
	Action            string
	ResourceType      string
	ResourceID        string
	Result            string
	RequestID         string
	IPAddress         string
	UserAgent         string
	Source            string
	Remark            string
	Detail            map[string]any
}

type AuditLog struct {
	ID                string    `json:"id"`
	ActorUserID       *string   `json:"actorUserId"`
	ActorName         string    `json:"actorName"`
	ActorMembershipID *string   `json:"actorMembershipId"`
	WorkspaceType     string    `json:"workspaceType"`
	WorkspaceID       string    `json:"workspaceId"`
	Action            string    `json:"action"`
	ResourceType      string    `json:"resourceType"`
	ResourceID        string    `json:"resourceId"`
	Result            string    `json:"result"`
	RequestID         string    `json:"requestId"`
	Source            string    `json:"source"`
	Remark            string    `json:"remark"`
	CreatedAt         time.Time `json:"createdAt"`
}

// WriteAudit inserts an audit record. Best-effort: returns error for caller to
// log but business flow should not roll back on audit failure.
func (s *Store) WriteAudit(ctx context.Context, e AuditEntry) error {
	if e.Result == "" {
		e.Result = "success"
	}
	detail := e.Detail
	if detail == nil {
		detail = map[string]any{}
	}
	detailJSON, _ := json.Marshal(detail)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_audit_log (id, actor_user_id, actor_membership_id, workspace_type, workspace_id, agency_id, enterprise_id,
			action, resource_type, resource_id, result, request_id, ip_address, user_agent, source, remark, detail)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
	`, "aud_"+randomSuffix(),
		nullStr(e.ActorUserID), nullStr(e.ActorMembershipID), e.WorkspaceType, e.WorkspaceID,
		nullStr(e.AgencyID), nullStr(e.EnterpriseID), e.Action, e.ResourceType, e.ResourceID, e.Result,
		e.RequestID, e.IPAddress, e.UserAgent, e.Source, e.Remark, string(detailJSON))
	return err
}

// ListAuditLogs lists audit logs. actorMembershipIDs applies a data-scope
// restriction: nil means unrestricted; non-nil restricts to actor_membership_id
// in the set (an empty set yields no rows).
func (s *Store) ListAuditLogs(ctx context.Context, wsType, wsID string, platformGlobal bool, action, resourceType, actorUserID, startAt, endAt string, actorMembershipIDs []string, page, pageSize int) ([]AuditLog, int64, error) {
	where := []string{}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }

	if !platformGlobal {
		where = append(where, "a.workspace_type="+add(wsType))
		where = append(where, "a.workspace_id="+add(wsID))
	}
	if action != "" {
		where = append(where, "a.action="+add(action))
	}
	if resourceType != "" {
		where = append(where, "a.resource_type="+add(resourceType))
	}
	if actorUserID != "" {
		where = append(where, "a.actor_user_id="+add(actorUserID))
	}
	if startAt != "" {
		where = append(where, "a.created_at>="+add(startAt))
	}
	if endAt != "" {
		where = append(where, "a.created_at<="+add(endAt))
	}
	// Data-scope restriction by visible actor memberships (Phase 1.13b).
	if actorMembershipIDs != nil {
		if len(actorMembershipIDs) == 0 {
			where = append(where, "false")
		} else {
			ph, a := inPlaceholders(len(args), actorMembershipIDs)
			args = append(args, a...)
			where = append(where, "a.actor_membership_id IN ("+ph+")")
		}
	}
	clause := "TRUE"
	if len(where) > 0 {
		clause = strings.Join(where, " AND ")
	}

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_audit_log a WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	// LEFT JOIN ky_user to surface the actor's display name instead of a bare id.
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.id, a.actor_user_id, COALESCE(u.display_name,''), a.actor_membership_id, a.workspace_type, a.workspace_id,
		       a.action, a.resource_type, a.resource_id, a.result, a.request_id, a.source, a.remark, a.created_at
		FROM ky_audit_log a LEFT JOIN ky_user u ON u.id = a.actor_user_id
		WHERE `+clause+` ORDER BY a.created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []AuditLog{}
	for rows.Next() {
		var a AuditLog
		if err := rows.Scan(&a.ID, &a.ActorUserID, &a.ActorName, &a.ActorMembershipID, &a.WorkspaceType, &a.WorkspaceID, &a.Action, &a.ResourceType, &a.ResourceID, &a.Result, &a.RequestID, &a.Source, &a.Remark, &a.CreatedAt); err != nil {
			return nil, 0, err
		}
		items = append(items, a)
	}
	return items, total, rows.Err()
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
