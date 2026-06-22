package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

func (s *Store) ListActiveMemberships(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, workspace_type, workspace_id, display_name, status
		FROM ky_membership
		WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL
		ORDER BY workspace_type, workspace_id
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var memberships []Membership
	for rows.Next() {
		var membership Membership
		if err := rows.Scan(&membership.ID, &membership.UserID, &membership.WorkspaceType, &membership.WorkspaceID, &membership.DisplayName, &membership.Status); err != nil {
			return nil, err
		}
		memberships = append(memberships, membership)
	}
	return memberships, rows.Err()
}

func (s *Store) WorkspaceName(ctx context.Context, workspaceType string, workspaceID string) (string, error) {
	switch workspaceType {
	case "platform":
		if workspaceID != "platform_root" {
			return "", fmt.Errorf("invalid platform workspace id: %s", workspaceID)
		}
		return "平台后台", nil
	case "agency":
		var name string
		err := s.db.QueryRowContext(ctx, `SELECT name FROM ky_agency WHERE id = $1 AND deleted_at IS NULL`, workspaceID).Scan(&name)
		if err == sql.ErrNoRows {
			return "", fmt.Errorf("agency workspace not found: %s", workspaceID)
		}
		return name, err
	case "enterprise":
		var name string
		err := s.db.QueryRowContext(ctx, `SELECT name FROM ky_enterprise WHERE id = $1 AND deleted_at IS NULL`, workspaceID).Scan(&name)
		if err == sql.ErrNoRows {
			return "", fmt.Errorf("enterprise workspace not found: %s", workspaceID)
		}
		return name, err
	default:
		return "", fmt.Errorf("invalid workspace type: %s", workspaceType)
	}
}

func (s *Store) RolesForMembership(ctx context.Context, membershipID string) ([]Role, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id, r.code, r.name
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		WHERE mr.membership_id = $1 AND r.status = 'normal' AND r.deleted_at IS NULL
		ORDER BY r.code
	`, membershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var roles []Role
	for rows.Next() {
		var role Role
		if err := rows.Scan(&role.ID, &role.Code, &role.Name); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func (s *Store) PermissionsForMembership(ctx context.Context, membershipID string) (permissions []string, actionPermissions []string, menuKeys []string, err error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT p.code, p.category
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_permission rp ON rp.role_id = r.id
		JOIN ky_permission p ON p.id = rp.permission_id
		WHERE mr.membership_id = $1
		  AND r.status = 'normal'
		  AND r.deleted_at IS NULL
		  AND p.status = 'normal'
		ORDER BY p.category, p.code
	`, membershipID)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var code string
		var category string
		if err := rows.Scan(&code, &category); err != nil {
			return nil, nil, nil, err
		}
		switch category {
		case "menu":
			menuKeys = append(menuKeys, code)
		case "page":
			permissions = append(permissions, code)
		case "action":
			actionPermissions = append(actionPermissions, code)
		}
	}
	return permissions, actionPermissions, menuKeys, rows.Err()
}

func (s *Store) DataScopesForMembership(ctx context.Context, membershipID string) ([]DataScope, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT rds.scope_type, rds.department_ids, rds.team_ids, rds.agency_ids, rds.enterprise_ids
		FROM ky_membership_role mr
		JOIN ky_role_data_scope rds ON rds.role_id = mr.role_id
		WHERE mr.membership_id = $1
		ORDER BY rds.scope_type
	`, membershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var scopes []DataScope
	for rows.Next() {
		var scope DataScope
		var departmentIDs, teamIDs, agencyIDs, enterpriseIDs []byte
		if err := rows.Scan(&scope.ScopeType, &departmentIDs, &teamIDs, &agencyIDs, &enterpriseIDs); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(departmentIDs, &scope.DepartmentIDs)
		_ = json.Unmarshal(teamIDs, &scope.TeamIDs)
		_ = json.Unmarshal(agencyIDs, &scope.AgencyIDs)
		_ = json.Unmarshal(enterpriseIDs, &scope.EnterpriseIDs)
		scopes = append(scopes, scope)
	}
	return scopes, rows.Err()
}
