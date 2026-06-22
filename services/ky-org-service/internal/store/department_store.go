package store

import (
	"context"
	"database/sql"
	"strings"
)

const departmentColumns = `id, workspace_type, workspace_id, parent_id, name, code, leader_membership_id, sort_order, status, created_at, updated_at`

func scanDepartment(row interface{ Scan(...any) error }) (Department, error) {
	var d Department
	err := row.Scan(&d.ID, &d.WorkspaceType, &d.WorkspaceID, &d.ParentID, &d.Name, &d.Code,
		&d.LeaderMembershipID, &d.SortOrder, &d.Status, &d.CreatedAt, &d.UpdatedAt)
	return d, err
}

func (s *Store) ListDepartments(ctx context.Context, wsType, wsID, parentID, status string, scope OrgScope) ([]Department, error) {
	where := []string{"workspace_type=$1", "workspace_id=$2", "deleted_at IS NULL"}
	args := []any{wsType, wsID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if parentID != "" {
		where = append(where, "parent_id="+add(parentID))
	}
	if status != "" {
		where = append(where, "status="+add(status))
	}
	// Data-scope restriction (Phase 1.13c): visible departments only.
	if !scope.Unrestricted {
		if len(scope.DepartmentIDs) == 0 {
			where = append(where, "false")
		} else {
			ph, a := scopeInPlaceholders(len(args), scope.DepartmentIDs)
			args = append(args, a...)
			where = append(where, "id IN ("+ph+")")
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+departmentColumns+` FROM ky_department WHERE `+
		strings.Join(where, " AND ")+` ORDER BY sort_order, created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Department{}
	for rows.Next() {
		d, err := scanDepartment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, d)
	}
	return items, rows.Err()
}

func (s *Store) CreateDepartment(ctx context.Context, d Department, createdBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_department (id, workspace_type, workspace_id, parent_id, name, code, leader_membership_id, sort_order, status, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
	`, d.ID, d.WorkspaceType, d.WorkspaceID, d.ParentID, d.Name, d.Code, d.LeaderMembershipID, d.SortOrder, d.Status, createdBy)
	return classifyWriteErr(err)
}

func (s *Store) UpdateDepartment(ctx context.Context, id, wsType, wsID string, d Department, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_department SET name=$4, parent_id=$5, leader_membership_id=$6, sort_order=$7, status=$8, updated_by=$9, updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	`, id, wsType, wsID, d.Name, d.ParentID, d.LeaderMembershipID, d.SortOrder, d.Status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) DeleteDepartment(ctx context.Context, id, wsType, wsID, updatedBy string) error {
	var childCount int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_department WHERE parent_id=$1 AND deleted_at IS NULL`, id).Scan(&childCount); err != nil {
		return err
	}
	if childCount > 0 {
		return ErrConflict
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_department SET deleted_at=now(), updated_by=$4, updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	`, id, wsType, wsID, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

// DepartmentExists reports whether a department id exists in the workspace.
func (s *Store) DepartmentExists(ctx context.Context, id, wsType, wsID string) (bool, error) {
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_department WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, id, wsType, wsID).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
