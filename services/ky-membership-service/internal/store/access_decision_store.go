package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

type AccessDecisionRequest struct {
	ActorID                string
	SessionID              string
	WorkspaceType          string
	WorkspaceID            string
	RequiredAllPermissions []string
	RequiredAnyPermissions []string
	Now                    time.Time
}

type AccessDecision struct {
	Allowed                    bool        `json:"allowed"`
	ReasonCode                 string      `json:"reasonCode"`
	ActorID                    string      `json:"actorId"`
	MembershipID               string      `json:"membershipId,omitempty"`
	WorkspaceType              string      `json:"workspaceType"`
	WorkspaceID                string      `json:"workspaceId"`
	GrantedRequiredPermissions []string    `json:"grantedRequiredPermissions"`
	DataScopes                 []DataScope `json:"dataScopes"`
}

func (s *Store) EvaluateAccessDecision(ctx context.Context, request AccessDecisionRequest) (AccessDecision, error) {
	decision := AccessDecision{
		Allowed: false, ReasonCode: "session_inactive", ActorID: request.ActorID,
		WorkspaceType: request.WorkspaceType, WorkspaceID: request.WorkspaceID,
		GrantedRequiredPermissions: []string{}, DataScopes: []DataScope{},
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelReadCommitted})
	if err != nil {
		return AccessDecision{}, err
	}
	defer tx.Rollback()

	var activeActor string
	err = tx.QueryRowContext(ctx, `
		SELECT user_id
		FROM ky_user_session
		WHERE id=$1 AND user_id=$2 AND status='active' AND expires_at>$3
	`, request.SessionID, request.ActorID, request.Now).Scan(&activeActor)
	if errors.Is(err, sql.ErrNoRows) {
		return decision, tx.Commit()
	}
	if err != nil {
		return AccessDecision{}, err
	}

	var membershipID string
	err = tx.QueryRowContext(ctx, `
		SELECT id
		FROM ky_membership
		WHERE user_id=$1 AND workspace_type=$2 AND workspace_id=$3
		  AND status='active' AND deleted_at IS NULL
		LIMIT 1
	`, request.ActorID, request.WorkspaceType, request.WorkspaceID).Scan(&membershipID)
	if errors.Is(err, sql.ErrNoRows) {
		decision.ReasonCode = "workspace_forbidden"
		return decision, tx.Commit()
	}
	if err != nil {
		return AccessDecision{}, err
	}
	decision.MembershipID = membershipID

	rows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT permission.code
		FROM ky_membership_role membership_role
		JOIN ky_role role ON role.id=membership_role.role_id
		JOIN ky_role_permission role_permission ON role_permission.role_id=role.id
		JOIN ky_permission permission ON permission.id=role_permission.permission_id
		WHERE membership_role.membership_id=$1
		  AND role.status='normal' AND role.deleted_at IS NULL
		  AND permission.status='normal'
	`, membershipID)
	if err != nil {
		return AccessDecision{}, err
	}
	granted := make(map[string]struct{})
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			rows.Close()
			return AccessDecision{}, err
		}
		granted[code] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return AccessDecision{}, err
	}
	if err := rows.Err(); err != nil {
		return AccessDecision{}, err
	}

	allGranted := true
	for _, code := range request.RequiredAllPermissions {
		if _, ok := granted[code]; !ok {
			allGranted = false
		} else {
			decision.GrantedRequiredPermissions = append(decision.GrantedRequiredPermissions, code)
		}
	}
	anyGranted := len(request.RequiredAnyPermissions) == 0
	for _, code := range request.RequiredAnyPermissions {
		if _, ok := granted[code]; ok {
			anyGranted = true
			decision.GrantedRequiredPermissions = append(decision.GrantedRequiredPermissions, code)
		}
	}
	sort.Strings(decision.GrantedRequiredPermissions)
	if !allGranted || !anyGranted {
		decision.ReasonCode = "permission_denied"
		return decision, tx.Commit()
	}

	scopeRows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT scope.scope_type, scope.department_ids, scope.team_ids, scope.agency_ids, scope.enterprise_ids
		FROM ky_membership_role membership_role
		JOIN ky_role role ON role.id=membership_role.role_id
		JOIN ky_role_data_scope scope ON scope.role_id=role.id
		WHERE membership_role.membership_id=$1
		  AND role.status='normal' AND role.deleted_at IS NULL
		ORDER BY scope.scope_type
	`, membershipID)
	if err != nil {
		return AccessDecision{}, err
	}
	decision.DataScopes, err = scanDataScopes(scopeRows)
	if closeErr := scopeRows.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return AccessDecision{}, err
	}
	decision.Allowed = true
	decision.ReasonCode = "allowed"
	return decision, tx.Commit()
}
