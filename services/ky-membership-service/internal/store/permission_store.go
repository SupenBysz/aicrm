package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// EffectivePermissions resolves a membership's effective permission codes,
// split by category (page/action/menu). Only normal roles/permissions count.
func (s *Store) EffectivePermissions(ctx context.Context, membershipID string) (PermissionSet, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT p.code, p.category
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_permission rp ON rp.role_id = r.id
		JOIN ky_permission p ON p.id = rp.permission_id
		WHERE mr.membership_id = $1
		  AND r.status = 'normal' AND r.deleted_at IS NULL
		  AND p.status = 'normal'
		ORDER BY p.category, p.code
	`, membershipID)
	if err != nil {
		return PermissionSet{}, err
	}
	defer rows.Close()

	set := PermissionSet{Permissions: []string{}, ActionPermissions: []string{}, MenuKeys: []string{}}
	for rows.Next() {
		var code, category string
		if err := rows.Scan(&code, &category); err != nil {
			return PermissionSet{}, err
		}
		switch category {
		case "menu":
			set.MenuKeys = append(set.MenuKeys, code)
		case "page":
			set.Permissions = append(set.Permissions, code)
		case "action":
			set.ActionPermissions = append(set.ActionPermissions, code)
		}
	}
	return set, rows.Err()
}

// HasAny reports whether the membership holds at least one of the wanted codes
// (page or action). Used by the request guard.
func (s *Store) HasAny(ctx context.Context, membershipID string, wanted []string) (bool, error) {
	if len(wanted) == 0 {
		return true, nil
	}
	placeholders := make([]string, len(wanted))
	args := make([]any, 0, len(wanted)+1)
	args = append(args, membershipID)
	for i, code := range wanted {
		placeholders[i] = "$" + itoa(i+2)
		args = append(args, code)
	}
	var x int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_permission rp ON rp.role_id = r.id
		JOIN ky_permission p ON p.id = rp.permission_id
		WHERE mr.membership_id = $1
		  AND r.status = 'normal' AND r.deleted_at IS NULL
		  AND p.status = 'normal'
		  AND p.code IN (`+strings.Join(placeholders, ",")+`)
		LIMIT 1
	`, args...).Scan(&x)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *Store) DataScopesForMembership(ctx context.Context, membershipID string) ([]DataScope, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT rds.scope_type, rds.department_ids, rds.team_ids, rds.agency_ids, rds.enterprise_ids
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_data_scope rds ON rds.role_id = r.id
		WHERE mr.membership_id = $1 AND r.status='normal' AND r.deleted_at IS NULL
		ORDER BY rds.scope_type
	`, membershipID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDataScopes(rows)
}

func scanDataScopes(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]DataScope, error) {
	scopes := []DataScope{}
	for rows.Next() {
		var d DataScope
		var depB, teamB, agencyB, entB []byte
		if err := rows.Scan(&d.ScopeType, &depB, &teamB, &agencyB, &entB); err != nil {
			return nil, err
		}
		d.DepartmentIDs = jsonToStrings(depB)
		d.TeamIDs = jsonToStrings(teamB)
		d.AgencyIDs = jsonToStrings(agencyB)
		d.EnterpriseIDs = jsonToStrings(entB)
		scopes = append(scopes, d)
	}
	return scopes, rows.Err()
}

func (s *Store) ListPermissions(ctx context.Context, workspaceType, category string) ([]Permission, error) {
	where := []string{"status='normal'", "workspace_types @> $1::jsonb"}
	args := []any{`["` + workspaceType + `"]`}
	if category != "" {
		args = append(args, category)
		where = append(where, "category=$2")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, code, name, category, resource, action, workspace_types, status
		FROM ky_permission WHERE `+strings.Join(where, " AND ")+` ORDER BY category, code
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Permission{}
	for rows.Next() {
		var p Permission
		var wtB []byte
		if err := rows.Scan(&p.ID, &p.Code, &p.Name, &p.Category, &p.Resource, &p.Action, &wtB, &p.Status); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(wtB, &p.WorkspaceTypes)
		if p.WorkspaceTypes == nil {
			p.WorkspaceTypes = []string{}
		}
		items = append(items, p)
	}
	return items, rows.Err()
}

// PermissionsAllBelongToWorkspaceType reports whether every permission id exists
// and includes workspaceType in its workspace_types catalog.
func (s *Store) PermissionsAllBelongToWorkspaceType(ctx context.Context, permissionIDs []string, workspaceType string) (bool, error) {
	if len(permissionIDs) == 0 {
		return true, nil
	}
	placeholders := make([]string, len(permissionIDs))
	args := make([]any, 0, len(permissionIDs)+1)
	args = append(args, `["`+workspaceType+`"]`)
	for i, id := range permissionIDs {
		placeholders[i] = "$" + itoa(i+2)
		args = append(args, id)
	}
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT count(*) FROM ky_permission
		WHERE id IN (`+strings.Join(placeholders, ",")+`)
		  AND status='normal' AND workspace_types @> $1::jsonb
	`, args...).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == len(permissionIDs), nil
}
