package store

import (
	"context"
	"database/sql"
	"strings"
)

func splitIDs(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, ",")
}

const memberSelect = `
	SELECT m.id, m.user_id, m.workspace_type, m.workspace_id, m.display_name, m.employee_no, m.title, m.status, m.joined_at,
	       COALESCE(u.email,''), COALESCE(u.phone,''),
	       COALESCE(array_to_string(ARRAY(SELECT department_id FROM ky_membership_department WHERE membership_id=m.id), ','), ''),
	       COALESCE(array_to_string(ARRAY(SELECT team_id FROM ky_membership_team WHERE membership_id=m.id), ','), ''),
	       COALESCE(array_to_string(ARRAY(SELECT role_id FROM ky_membership_role WHERE membership_id=m.id), ','), '')
	FROM ky_membership m JOIN ky_user u ON u.id = m.user_id`

func scanMember(row interface{ Scan(...any) error }) (Member, error) {
	var m Member
	var deptStr, teamStr, roleStr string
	err := row.Scan(&m.ID, &m.UserID, &m.WorkspaceType, &m.WorkspaceID, &m.DisplayName, &m.EmployeeNo, &m.Title, &m.Status, &m.JoinedAt,
		&m.Email, &m.Phone, &deptStr, &teamStr, &roleStr)
	if err != nil {
		return Member{}, err
	}
	m.DepartmentIDs = splitIDs(deptStr)
	m.TeamIDs = splitIDs(teamStr)
	m.RoleIDs = splitIDs(roleStr)
	return m, nil
}

func (s *Store) ListMembers(ctx context.Context, wsType, wsID, keyword, departmentID, teamID, status string, scope ScopeFilter, page, pageSize int) ([]Member, int64, error) {
	where := []string{"m.workspace_type=$1", "m.workspace_id=$2", "m.deleted_at IS NULL"}
	args := []any{wsType, wsID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }

	if keyword != "" {
		p := add("%" + keyword + "%")
		where = append(where, "(m.display_name ILIKE "+p+" OR u.username ILIKE "+p+" OR u.email ILIKE "+p+" OR u.phone ILIKE "+p+")")
	}
	if status != "" {
		where = append(where, "m.status="+add(status))
	}
	if departmentID != "" {
		where = append(where, "EXISTS (SELECT 1 FROM ky_membership_department md WHERE md.membership_id=m.id AND md.department_id="+add(departmentID)+")")
	}
	if teamID != "" {
		where = append(where, "EXISTS (SELECT 1 FROM ky_membership_team mt WHERE mt.membership_id=m.id AND mt.team_id="+add(teamID)+")")
	}
	// Apply caller data-scope restriction (Phase 1.13).
	if !scope.Unrestricted {
		ors := []string{}
		if scope.SelfMembershipID != "" {
			ors = append(ors, "m.id="+add(scope.SelfMembershipID))
		}
		if len(scope.DepartmentIDs) > 0 {
			ph, a := inPlaceholders(len(args), scope.DepartmentIDs)
			args = append(args, a...)
			ors = append(ors, "EXISTS (SELECT 1 FROM ky_membership_department md WHERE md.membership_id=m.id AND md.department_id IN ("+ph+"))")
		}
		if len(scope.TeamIDs) > 0 {
			ph, a := inPlaceholders(len(args), scope.TeamIDs)
			args = append(args, a...)
			ors = append(ors, "EXISTS (SELECT 1 FROM ky_membership_team mt WHERE mt.membership_id=m.id AND mt.team_id IN ("+ph+"))")
		}
		if len(ors) == 0 {
			where = append(where, "false")
		} else {
			where = append(where, "("+strings.Join(ors, " OR ")+")")
		}
	}
	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_membership m JOIN ky_user u ON u.id=m.user_id WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, memberSelect+` WHERE `+clause+` ORDER BY m.created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Member{}
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, m)
	}
	return items, total, rows.Err()
}

func (s *Store) GetMember(ctx context.Context, id, wsType, wsID string, scope ScopeFilter) (Member, error) {
	m, err := scanMember(s.db.QueryRowContext(ctx, memberSelect+` WHERE m.id=$1 AND m.workspace_type=$2 AND m.workspace_id=$3 AND m.deleted_at IS NULL`, id, wsType, wsID))
	if err == sql.ErrNoRows {
		return Member{}, ErrNotFound
	}
	if err != nil {
		return Member{}, err
	}
	// Out-of-scope members are reported as not found to avoid probing (Phase 1.13).
	if !memberVisible(m, scope) {
		return Member{}, ErrNotFound
	}
	return m, nil
}

// memberVisible reports whether a member falls within the caller's scope filter.
func memberVisible(m Member, scope ScopeFilter) bool {
	if scope.Unrestricted {
		return true
	}
	if scope.SelfMembershipID != "" && m.ID == scope.SelfMembershipID {
		return true
	}
	if intersects(m.DepartmentIDs, scope.DepartmentIDs) {
		return true
	}
	if intersects(m.TeamIDs, scope.TeamIDs) {
		return true
	}
	return false
}

func intersects(a, b []string) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	set := make(map[string]struct{}, len(b))
	for _, x := range b {
		set[x] = struct{}{}
	}
	for _, x := range a {
		if _, ok := set[x]; ok {
			return true
		}
	}
	return false
}

func (s *Store) UpdateMemberStatus(ctx context.Context, id, wsType, wsID, status, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_membership SET status=$4, updated_by=$5, updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	`, id, wsType, wsID, status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) RemoveMember(ctx context.Context, id, wsType, wsID, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_membership SET status='left', deleted_at=now(), updated_by=$4, updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	`, id, wsType, wsID, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

// memberInWorkspace reports whether the membership exists and is active in the workspace.
func (s *Store) memberInWorkspace(ctx context.Context, tx *sql.Tx, id, wsType, wsID string) (bool, error) {
	var x int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM ky_membership WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, id, wsType, wsID).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) AssignMemberDepartments(ctx context.Context, id, wsType, wsID string, assignments []DepartmentAssignment) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	ok, err := s.memberInWorkspace(ctx, tx, id, wsType, wsID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM ky_membership_department WHERE membership_id=$1`, id); err != nil {
		return err
	}
	for _, a := range assignments {
		var valid int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM ky_department WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, a.DepartmentID, wsType, wsID).Scan(&valid)
		if err != nil {
			return ErrValidation
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_department (id, membership_id, department_id, is_primary)
			VALUES ($1,$2,$3,$4) ON CONFLICT (membership_id, department_id) DO UPDATE SET is_primary=EXCLUDED.is_primary
		`, "md_"+id+"_"+a.DepartmentID, id, a.DepartmentID, a.IsPrimary); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) AssignMemberTeams(ctx context.Context, id, wsType, wsID string, teamIDs []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	ok, err := s.memberInWorkspace(ctx, tx, id, wsType, wsID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM ky_membership_team WHERE membership_id=$1`, id); err != nil {
		return err
	}
	for _, teamID := range teamIDs {
		var valid int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM ky_team WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, teamID, wsType, wsID).Scan(&valid)
		if err != nil {
			return ErrValidation
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_team (id, membership_id, team_id, role_in_team)
			VALUES ($1,$2,$3,'member') ON CONFLICT (membership_id, team_id) DO NOTHING
		`, "mt_"+id+"_"+teamID, id, teamID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
