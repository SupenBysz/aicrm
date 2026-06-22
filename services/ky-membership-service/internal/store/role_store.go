package store

import (
	"context"
	"database/sql"
	"strings"
)

const roleColumns = `id, workspace_type, workspace_id, name, code, description, is_system, status`

func scanRoleRow(row interface{ Scan(...any) error }) (Role, error) {
	var r Role
	err := row.Scan(&r.ID, &r.WorkspaceType, &r.WorkspaceID, &r.Name, &r.Code, &r.Description, &r.IsSystem, &r.Status)
	return r, err
}

// ListRoles returns roles in the current workspace plus templates (workspace_id IS NULL).
func (s *Store) ListRoles(ctx context.Context, wsType, wsID, status string, page, pageSize int) ([]Role, int64, error) {
	where := []string{"workspace_type=$1", "(workspace_id=$2 OR workspace_id IS NULL)", "deleted_at IS NULL"}
	args := []any{wsType, wsID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_role WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+roleColumns+` FROM ky_role WHERE `+clause+` ORDER BY is_system DESC, code LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Role{}
	for rows.Next() {
		r, err := scanRoleRow(rows)
		if err != nil {
			return nil, 0, err
		}
		r.PermissionIDs = []string{}
		r.DataScopes = []DataScope{}
		items = append(items, r)
	}
	return items, total, rows.Err()
}

func (s *Store) GetRole(ctx context.Context, id, wsType, wsID string) (Role, error) {
	r, err := scanRoleRow(s.db.QueryRowContext(ctx, `SELECT `+roleColumns+` FROM ky_role
		WHERE id=$1 AND workspace_type=$2 AND (workspace_id=$3 OR workspace_id IS NULL) AND deleted_at IS NULL`, id, wsType, wsID))
	if err == sql.ErrNoRows {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	r.PermissionIDs, err = s.rolePermissionIDs(ctx, id)
	if err != nil {
		return Role{}, err
	}
	r.DataScopes, err = s.roleDataScopes(ctx, id)
	if err != nil {
		return Role{}, err
	}
	return r, nil
}

func (s *Store) rolePermissionIDs(ctx context.Context, roleID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT permission_id FROM ky_role_permission WHERE role_id=$1`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) roleDataScopes(ctx context.Context, roleID string) ([]DataScope, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT scope_type, department_ids, team_ids, agency_ids, enterprise_ids FROM ky_role_data_scope WHERE role_id=$1 ORDER BY scope_type`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDataScopes(rows)
}

// roleEditable returns the role if it exists in the current workspace (not a
// template) and is not a system role; otherwise an error.
func (s *Store) roleEditable(ctx context.Context, tx *sql.Tx, id, wsType, wsID string) (Role, error) {
	var r Role
	err := tx.QueryRowContext(ctx, `SELECT `+roleColumns+` FROM ky_role WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&r.ID, &r.WorkspaceType, &r.WorkspaceID, &r.Name, &r.Code, &r.Description, &r.IsSystem, &r.Status)
	if err == sql.ErrNoRows {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	if r.WorkspaceType != wsType || r.WorkspaceID == nil || *r.WorkspaceID != wsID {
		return Role{}, ErrNotFound
	}
	if r.IsSystem {
		return Role{}, ErrConflict
	}
	return r, nil
}

func (s *Store) CreateRole(ctx context.Context, r Role, dataScope *DataScope, permissionIDs []string, createdBy string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_role (id, workspace_type, workspace_id, name, code, description, is_system, status, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,false,'normal',$7,$7)
	`, r.ID, r.WorkspaceType, r.WorkspaceID, r.Name, r.Code, r.Description, createdBy); err != nil {
		return "", classifyWriteErr(err)
	}
	if err := setRolePermissionsTx(ctx, tx, r.ID, permissionIDs); err != nil {
		return "", classifyWriteErr(err)
	}
	if dataScope != nil {
		if err := setRoleDataScopeTx(ctx, tx, r.ID, *dataScope); err != nil {
			return "", classifyWriteErr(err)
		}
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return r.ID, nil
}

func (s *Store) UpdateRole(ctx context.Context, id, wsType, wsID, name, description string, dataScope *DataScope, updatedBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := s.roleEditable(ctx, tx, id, wsType, wsID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ky_role SET name=$2, description=$3, updated_by=$4, updated_at=now() WHERE id=$1`, id, name, description, updatedBy); err != nil {
		return classifyWriteErr(err)
	}
	if dataScope != nil {
		if err := setRoleDataScopeTx(ctx, tx, id, *dataScope); err != nil {
			return classifyWriteErr(err)
		}
	}
	return tx.Commit()
}

func (s *Store) UpdateRoleStatus(ctx context.Context, id, wsType, wsID, status, updatedBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := s.roleEditable(ctx, tx, id, wsType, wsID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ky_role SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1`, id, status, updatedBy); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetRolePermissions(ctx context.Context, id, wsType, wsID string, permissionIDs []string, updatedBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := s.roleEditable(ctx, tx, id, wsType, wsID); err != nil {
		return err
	}
	if err := setRolePermissionsTx(ctx, tx, id, permissionIDs); err != nil {
		return classifyWriteErr(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ky_role SET updated_by=$2, updated_at=now() WHERE id=$1`, id, updatedBy); err != nil {
		return err
	}
	return tx.Commit()
}

func setRolePermissionsTx(ctx context.Context, tx *sql.Tx, roleID string, permissionIDs []string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM ky_role_permission WHERE role_id=$1`, roleID); err != nil {
		return err
	}
	for _, pid := range permissionIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_role_permission (id, role_id, permission_id) VALUES ($1,$2,$3)
			ON CONFLICT (role_id, permission_id) DO NOTHING
		`, "rp_"+roleID+"_"+pid, roleID, pid); err != nil {
			return err
		}
	}
	return nil
}

func setRoleDataScopeTx(ctx context.Context, tx *sql.Tx, roleID string, ds DataScope) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM ky_role_data_scope WHERE role_id=$1`, roleID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_role_data_scope (id, role_id, scope_type, department_ids, team_ids, agency_ids, enterprise_ids)
		VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)
	`, "rds_"+roleID, roleID, ds.ScopeType, stringsToJSON(ds.DepartmentIDs), stringsToJSON(ds.TeamIDs), stringsToJSON(ds.AgencyIDs), stringsToJSON(ds.EnterpriseIDs))
	return err
}

// MembershipInWorkspace reports whether a membership belongs to the workspace.
func (s *Store) MembershipInWorkspace(ctx context.Context, membershipID, wsType, wsID string) (bool, error) {
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_membership WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, membershipID, wsType, wsID).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// rolesAssignable reports whether every role id is usable in the workspace
// (same workspace_type and either current workspace or a template).
func (s *Store) rolesAssignable(ctx context.Context, tx *sql.Tx, roleIDs []string, wsType, wsID string) (bool, error) {
	if len(roleIDs) == 0 {
		return true, nil
	}
	placeholders := make([]string, len(roleIDs))
	args := make([]any, 0, len(roleIDs)+2)
	args = append(args, wsType, wsID)
	for i, id := range roleIDs {
		placeholders[i] = "$" + itoa(i+3)
		args = append(args, id)
	}
	var count int
	err := tx.QueryRowContext(ctx, `
		SELECT count(*) FROM ky_role
		WHERE id IN (`+strings.Join(placeholders, ",")+`)
		  AND deleted_at IS NULL AND status='normal'
		  AND workspace_type=$1 AND (workspace_id=$2 OR workspace_id IS NULL)
	`, args...).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == len(roleIDs), nil
}

func (s *Store) AssignMembershipRoles(ctx context.Context, membershipID, wsType, wsID string, roleIDs []string, createdBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var x int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM ky_membership WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, membershipID, wsType, wsID).Scan(&x); err != nil {
		if err == sql.ErrNoRows {
			return ErrNotFound
		}
		return err
	}
	ok, err := s.rolesAssignable(ctx, tx, roleIDs, wsType, wsID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrValidation
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM ky_membership_role WHERE membership_id=$1`, membershipID); err != nil {
		return err
	}
	for _, rid := range roleIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_role (id, membership_id, role_id, workspace_type, workspace_id, created_by)
			VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (membership_id, role_id) DO NOTHING
		`, "mr_"+membershipID+"_"+rid, membershipID, rid, wsType, wsID, createdBy); err != nil {
			return classifyWriteErr(err)
		}
	}
	return tx.Commit()
}
