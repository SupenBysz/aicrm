package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
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

// WriteAudit writes an audit record on a best-effort basis. Callers should not
// roll back business operations if this returns an error.
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

func nullStr(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
