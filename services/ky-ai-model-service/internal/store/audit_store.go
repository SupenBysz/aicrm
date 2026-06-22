package store

import (
	"context"
	"encoding/json"
)

type AuditEntry struct {
	ActorUserID       string
	ActorMembershipID string
	WorkspaceType     string
	WorkspaceID       string
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

// WriteAudit inserts an audit record (best-effort). Detail must never include
// plaintext API keys.
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
		INSERT INTO ky_audit_log (id, actor_user_id, actor_membership_id, workspace_type, workspace_id,
			action, resource_type, resource_id, result, request_id, ip_address, user_agent, source, remark, detail)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
	`, "aud_"+randomSuffix(), nullStr(e.ActorUserID), nullStr(e.ActorMembershipID), e.WorkspaceType, e.WorkspaceID,
		e.Action, e.ResourceType, e.ResourceID, e.Result, e.RequestID, e.IPAddress, e.UserAgent, e.Source, e.Remark, string(detailJSON))
	return err
}
