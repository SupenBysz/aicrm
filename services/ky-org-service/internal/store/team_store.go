package store

import (
	"context"
	"strings"
)

const teamColumns = `id, workspace_type, workspace_id, department_id, name, code, leader_membership_id, description, status, created_at, updated_at`

func scanTeam(row interface{ Scan(...any) error }) (Team, error) {
	var t Team
	err := row.Scan(&t.ID, &t.WorkspaceType, &t.WorkspaceID, &t.DepartmentID, &t.Name, &t.Code,
		&t.LeaderMembershipID, &t.Description, &t.Status, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func (s *Store) ListTeams(ctx context.Context, wsType, wsID, departmentID, status string, scope OrgScope) ([]Team, error) {
	where := []string{"workspace_type=$1", "workspace_id=$2", "deleted_at IS NULL"}
	args := []any{wsType, wsID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if departmentID != "" {
		where = append(where, "department_id="+add(departmentID))
	}
	if status != "" {
		where = append(where, "status="+add(status))
	}
	// Data-scope restriction (Phase 1.13c): teams in visible teams OR under
	// visible departments.
	if !scope.Unrestricted {
		ors := []string{}
		if len(scope.TeamIDs) > 0 {
			ph, a := scopeInPlaceholders(len(args), scope.TeamIDs)
			args = append(args, a...)
			ors = append(ors, "id IN ("+ph+")")
		}
		if len(scope.DepartmentIDs) > 0 {
			ph, a := scopeInPlaceholders(len(args), scope.DepartmentIDs)
			args = append(args, a...)
			ors = append(ors, "department_id IN ("+ph+")")
		}
		if len(ors) == 0 {
			where = append(where, "false")
		} else {
			where = append(where, "("+strings.Join(ors, " OR ")+")")
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+teamColumns+` FROM ky_team WHERE `+
		strings.Join(where, " AND ")+` ORDER BY created_at`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Team{}
	for rows.Next() {
		t, err := scanTeam(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

func (s *Store) CreateTeam(ctx context.Context, t Team, createdBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_team (id, workspace_type, workspace_id, department_id, name, code, leader_membership_id, description, status, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
	`, t.ID, t.WorkspaceType, t.WorkspaceID, t.DepartmentID, t.Name, t.Code, t.LeaderMembershipID, t.Description, t.Status, createdBy)
	return classifyWriteErr(err)
}

func (s *Store) UpdateTeam(ctx context.Context, id, wsType, wsID string, t Team, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_team SET name=$4, department_id=$5, leader_membership_id=$6, description=$7, status=$8, updated_by=$9, updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	`, id, wsType, wsID, t.Name, t.DepartmentID, t.LeaderMembershipID, t.Description, t.Status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

// SetTeamMembers replaces team membership with the given membership ids. Every
// membership must belong to the team's workspace, enforced by the caller.
func (s *Store) SetTeamMembers(ctx context.Context, teamID, wsType, wsID string, membershipIDs []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var x int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM ky_team WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, teamID, wsType, wsID).Scan(&x)
	if err != nil {
		return ErrNotFound
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM ky_membership_team WHERE team_id=$1`, teamID); err != nil {
		return err
	}
	for _, mID := range membershipIDs {
		var valid int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM ky_membership WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`, mID, wsType, wsID).Scan(&valid)
		if err != nil {
			return ErrConflict
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_team (id, membership_id, team_id, role_in_team)
			VALUES ($1,$2,$3,'member')
			ON CONFLICT (membership_id, team_id) DO NOTHING
		`, "mt_"+teamID+"_"+mID, mID, teamID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
