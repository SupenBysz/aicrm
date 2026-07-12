package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

var ErrInvalidAssuranceState = errors.New("invalid access assurance state")

type AccessAssuranceRequirements struct {
	RequireWorkspaceOwner       bool
	MaxAuthenticationAgeSeconds int
	RequireMFAIfEnabled         bool
}

type AccessDecisionRequest struct {
	ActorID                string
	SessionID              string
	WorkspaceType          string
	WorkspaceID            string
	RequiredAllPermissions []string
	RequiredAnyPermissions []string
	Assurance              *AccessAssuranceRequirements
}

type AccessAssuranceFacts struct {
	Verified        bool   `json:"verified"`
	WorkspaceOwner  bool   `json:"workspaceOwner"`
	AuthenticatedAt string `json:"authenticatedAt"`
	MFARequired     bool   `json:"mfaRequired"`
	MFAVerified     bool   `json:"mfaVerified"`
}

type AccessDecision struct {
	Allowed                    bool                  `json:"allowed"`
	ReasonCode                 string                `json:"reasonCode"`
	ActorID                    string                `json:"actorId"`
	MembershipID               string                `json:"membershipId,omitempty"`
	WorkspaceType              string                `json:"workspaceType"`
	WorkspaceID                string                `json:"workspaceId"`
	GrantedRequiredPermissions []string              `json:"grantedRequiredPermissions"`
	DataScopes                 []DataScope           `json:"dataScopes"`
	Assurance                  *AccessAssuranceFacts `json:"assurance,omitempty"`
}

func (s *Store) EvaluateAccessDecision(ctx context.Context, request AccessDecisionRequest) (AccessDecision, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelReadCommitted})
	if err != nil {
		return AccessDecision{}, err
	}
	defer tx.Rollback()
	decision, err := evaluateAccessDecisionTx(ctx, tx, request)
	if err != nil {
		return AccessDecision{}, err
	}
	if err := tx.Commit(); err != nil {
		return AccessDecision{}, err
	}
	return decision, nil
}

func evaluateAccessDecisionTx(ctx context.Context, tx *sql.Tx, request AccessDecisionRequest) (AccessDecision, error) {
	decision := AccessDecision{
		Allowed: false, ReasonCode: "session_inactive", ActorID: request.ActorID,
		WorkspaceType: request.WorkspaceType, WorkspaceID: request.WorkspaceID,
		GrantedRequiredPermissions: []string{}, DataScopes: []DataScope{},
	}

	var activeActor string
	var authenticatedAt, databaseNow time.Time
	var mfaVerifiedAt sql.NullTime
	err := tx.QueryRowContext(ctx, `
		SELECT user_id,authenticated_at,mfa_verified_at,transaction_timestamp()
		FROM ky_user_session
		WHERE id=$1 AND user_id=$2 AND status='active'
		  AND expires_at>transaction_timestamp()
	`, request.SessionID, request.ActorID).Scan(&activeActor, &authenticatedAt, &mfaVerifiedAt, &databaseNow)
	if errors.Is(err, sql.ErrNoRows) {
		return decision, nil
	}
	if err != nil {
		return AccessDecision{}, err
	}
	authenticatedAt = authenticatedAt.UTC()
	databaseNow = databaseNow.UTC()

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
		return decision, nil
	}
	if err != nil {
		return AccessDecision{}, err
	}
	decision.MembershipID = membershipID

	if request.Assurance != nil {
		facts, err := evaluateAccessAssurance(ctx, tx, request, membershipID, authenticatedAt, mfaVerifiedAt, databaseNow)
		if err != nil {
			return AccessDecision{}, err
		}
		decision.Assurance = &facts
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT permission.code
		FROM ky_membership_role membership_role
		JOIN ky_role role ON role.id=membership_role.role_id
		JOIN ky_role_permission role_permission ON role_permission.role_id=role.id
		JOIN ky_permission permission ON permission.id=role_permission.permission_id
		WHERE membership_role.membership_id=$1
		  AND membership_role.workspace_type=$2 AND membership_role.workspace_id=$3
		  AND role.workspace_type=$2 AND (role.workspace_id=$3 OR role.workspace_id IS NULL)
		  AND role.status='normal' AND role.deleted_at IS NULL
		  AND permission.status='normal'
	`, membershipID, request.WorkspaceType, request.WorkspaceID)
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
		return decision, nil
	}

	if decision.Assurance != nil && !decision.Assurance.Verified {
		decision.ReasonCode = accessAssuranceDenialReason(*request.Assurance, *decision.Assurance, authenticatedAt, databaseNow)
		return decision, nil
	}

	scopeRows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT scope.scope_type, scope.department_ids, scope.team_ids, scope.agency_ids, scope.enterprise_ids
		FROM ky_membership_role membership_role
		JOIN ky_role role ON role.id=membership_role.role_id
		JOIN ky_role_data_scope scope ON scope.role_id=role.id
		WHERE membership_role.membership_id=$1
		  AND membership_role.workspace_type=$2 AND membership_role.workspace_id=$3
		  AND role.workspace_type=$2 AND (role.workspace_id=$3 OR role.workspace_id IS NULL)
		  AND role.status='normal' AND role.deleted_at IS NULL
		ORDER BY scope.scope_type
	`, membershipID, request.WorkspaceType, request.WorkspaceID)
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
	return decision, nil
}

func evaluateAccessAssurance(
	ctx context.Context,
	tx *sql.Tx,
	request AccessDecisionRequest,
	membershipID string,
	authenticatedAt time.Time,
	mfaVerifiedAt sql.NullTime,
	databaseNow time.Time,
) (AccessAssuranceFacts, error) {
	facts := AccessAssuranceFacts{AuthenticatedAt: authenticatedAt.Format(time.RFC3339Nano)}
	ownerCode, ok := workspaceOwnerRoleCode(request.WorkspaceType)
	if !ok {
		return AccessAssuranceFacts{}, ErrInvalidAssuranceState
	}
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
		  SELECT 1
		  FROM ky_membership_role membership_role
		  JOIN ky_role role ON role.id=membership_role.role_id
		  WHERE membership_role.membership_id=$1
		    AND membership_role.workspace_type=$2 AND membership_role.workspace_id=$3
		    AND role.workspace_type=$2 AND (role.workspace_id=$3 OR role.workspace_id IS NULL)
		    AND role.code=$4 AND role.is_system
		    AND role.status='normal' AND role.deleted_at IS NULL
		)
	`, membershipID, request.WorkspaceType, request.WorkspaceID, ownerCode).Scan(&facts.WorkspaceOwner); err != nil {
		return AccessAssuranceFacts{}, err
	}

	var hasMFAKey bool
	var mfaType, mfaValue string
	if err := tx.QueryRowContext(ctx, `
		SELECT setting_value ? 'mfaEnabled',
		       COALESCE(jsonb_typeof(setting_value->'mfaEnabled'),''),
		       COALESCE(setting_value->>'mfaEnabled','')
		FROM ky_system_setting
		WHERE scope_type='platform' AND scope_id='platform_root' AND setting_key='security'
	`).Scan(&hasMFAKey, &mfaType, &mfaValue); err != nil {
		return AccessAssuranceFacts{}, ErrInvalidAssuranceState
	}
	if hasMFAKey {
		if mfaType != "boolean" || (mfaValue != "true" && mfaValue != "false") {
			return AccessAssuranceFacts{}, ErrInvalidAssuranceState
		}
		facts.MFARequired = mfaValue == "true"
	}
	facts.MFAVerified = mfaVerifiedAt.Valid &&
		!mfaVerifiedAt.Time.UTC().Before(authenticatedAt) &&
		!mfaVerifiedAt.Time.UTC().After(databaseNow)
	facts.Verified = (!request.Assurance.RequireWorkspaceOwner || facts.WorkspaceOwner) &&
		(request.Assurance.MaxAuthenticationAgeSeconds == 0 || authenticationWithinAge(
			authenticatedAt, databaseNow, request.Assurance.MaxAuthenticationAgeSeconds,
		)) &&
		(!request.Assurance.RequireMFAIfEnabled || !facts.MFARequired || facts.MFAVerified)
	return facts, nil
}

func accessAssuranceDenialReason(
	requirements AccessAssuranceRequirements,
	facts AccessAssuranceFacts,
	authenticatedAt time.Time,
	databaseNow time.Time,
) string {
	if requirements.RequireWorkspaceOwner && !facts.WorkspaceOwner {
		return "owner_required"
	}
	if requirements.MaxAuthenticationAgeSeconds > 0 &&
		!authenticationWithinAge(authenticatedAt, databaseNow, requirements.MaxAuthenticationAgeSeconds) {
		return "fresh_login_required"
	}
	if requirements.RequireMFAIfEnabled && facts.MFARequired && !facts.MFAVerified {
		return "mfa_required"
	}
	return "assurance_denied"
}

func authenticationWithinAge(authenticatedAt, databaseNow time.Time, maximumSeconds int) bool {
	if maximumSeconds <= 0 || authenticatedAt.After(databaseNow) {
		return false
	}
	return databaseNow.Sub(authenticatedAt) <= time.Duration(maximumSeconds)*time.Second
}

func workspaceOwnerRoleCode(workspaceType string) (string, bool) {
	switch workspaceType {
	case "platform":
		return "platform_owner", true
	case "agency":
		return "agency_owner", true
	case "enterprise":
		return "enterprise_owner", true
	default:
		return "", false
	}
}
