package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

const invitationColumns = `id, workspace_type, workspace_id, invitation_type, invitee_email, invitee_phone, token,
	preset_role_ids, preset_department_ids, preset_team_ids, status, expires_at, accepted_user_id, accepted_at, created_at`

func scanInvitation(row interface{ Scan(...any) error }) (Invitation, error) {
	var inv Invitation
	var roleB, deptB, teamB []byte
	err := row.Scan(&inv.ID, &inv.WorkspaceType, &inv.WorkspaceID, &inv.InvitationType, &inv.InviteeEmail, &inv.InviteePhone, &inv.Token,
		&roleB, &deptB, &teamB, &inv.Status, &inv.ExpiresAt, &inv.AcceptedUserID, &inv.AcceptedAt, &inv.CreatedAt)
	if err != nil {
		return Invitation{}, err
	}
	inv.PresetRoleIDs = jsonToStrings(roleB)
	inv.PresetDeptIDs = jsonToStrings(deptB)
	inv.PresetTeamIDs = jsonToStrings(teamB)
	return inv, nil
}

func jsonToStrings(b []byte) []string {
	out := []string{}
	if len(b) == 0 {
		return out
	}
	_ = json.Unmarshal(b, &out)
	if out == nil {
		return []string{}
	}
	return out
}

func stringsToJSON(v []string) string {
	if v == nil {
		v = []string{}
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// ListInvitations lists invitations. inviterMembershipIDs applies a data-scope
// restriction by creator: nil means unrestricted; non-nil restricts to
// invited_by_membership_id in the set (an empty set yields no rows).
func (s *Store) ListInvitations(ctx context.Context, wsType, wsID, status string, inviterMembershipIDs []string, page, pageSize int) ([]Invitation, int64, error) {
	where := []string{"workspace_type=$1", "workspace_id=$2"}
	args := []any{wsType, wsID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	// Data-scope restriction by inviter (Phase 1.13c).
	if inviterMembershipIDs != nil {
		if len(inviterMembershipIDs) == 0 {
			where = append(where, "false")
		} else {
			ph, a := inPlaceholders(len(args), inviterMembershipIDs)
			args = append(args, a...)
			where = append(where, "invited_by_membership_id IN ("+ph+")")
		}
	}
	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_invitation WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+invitationColumns+` FROM ky_invitation WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Invitation{}
	for rows.Next() {
		inv, err := scanInvitation(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, inv)
	}
	return items, total, rows.Err()
}

func (s *Store) CreateInvitation(ctx context.Context, inv Invitation, invitedByMembershipID string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_invitation (id, workspace_type, workspace_id, invitation_type, invitee_email, invitee_phone,
			invited_by_membership_id, token, preset_role_ids, preset_department_ids, preset_team_ids, status, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,'pending',$12)
	`, inv.ID, inv.WorkspaceType, inv.WorkspaceID, inv.InvitationType, inv.InviteeEmail, inv.InviteePhone,
		invitedByMembershipID, inv.Token, stringsToJSON(inv.PresetRoleIDs), stringsToJSON(inv.PresetDeptIDs), stringsToJSON(inv.PresetTeamIDs), inv.ExpiresAt)
	return classifyWriteErr(err)
}

func (s *Store) CancelInvitation(ctx context.Context, id, wsType, wsID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_invitation SET status='cancelled', updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND status='pending'
	`, id, wsType, wsID)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) GetInvitationByToken(ctx context.Context, token string) (Invitation, error) {
	inv, err := scanInvitation(s.db.QueryRowContext(ctx, `SELECT `+invitationColumns+` FROM ky_invitation WHERE token=$1`, token))
	if err == sql.ErrNoRows {
		return Invitation{}, ErrNotFound
	}
	return inv, err
}

// EnterpriseBelongsToAgency reports whether enterpriseID is owned by agencyID.
func (s *Store) EnterpriseBelongsToAgency(ctx context.Context, enterpriseID, agencyID string) (bool, error) {
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_enterprise WHERE id=$1 AND agency_id=$2 AND deleted_at IS NULL`, enterpriseID, agencyID).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) WorkspaceName(ctx context.Context, wsType, wsID string) (string, error) {
	switch wsType {
	case "platform":
		return "平台后台", nil
	case "agency":
		var name string
		err := s.db.QueryRowContext(ctx, `SELECT name FROM ky_agency WHERE id=$1 AND deleted_at IS NULL`, wsID).Scan(&name)
		if err == sql.ErrNoRows {
			return "", ErrNotFound
		}
		return name, err
	case "enterprise":
		var name string
		err := s.db.QueryRowContext(ctx, `SELECT name FROM ky_enterprise WHERE id=$1 AND deleted_at IS NULL`, wsID).Scan(&name)
		if err == sql.ErrNoRows {
			return "", ErrNotFound
		}
		return name, err
	default:
		return "", ErrNotFound
	}
}

// UserExists reports whether a non-deleted user exists.
func (s *Store) UserExists(ctx context.Context, userID string) (bool, error) {
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_user WHERE id=$1 AND deleted_at IS NULL`, userID).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

type AcceptResult struct {
	MembershipID  string
	WorkspaceType string
	WorkspaceID   string
}

// AcceptInvitation validates and accepts a pending invitation for userID,
// creating or reusing a membership and applying preset roles/departments/teams.
func (s *Store) AcceptInvitation(ctx context.Context, token, userID, displayName string, now time.Time) (AcceptResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AcceptResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	inv, err := scanInvitation(tx.QueryRowContext(ctx, `SELECT `+invitationColumns+` FROM ky_invitation WHERE token=$1 FOR UPDATE`, token))
	if err == sql.ErrNoRows {
		return AcceptResult{}, ErrNotFound
	}
	if err != nil {
		return AcceptResult{}, err
	}
	if inv.Status != "pending" {
		return AcceptResult{}, ErrConflict
	}
	if !inv.ExpiresAt.After(now) {
		_, _ = tx.ExecContext(ctx, `UPDATE ky_invitation SET status='expired', updated_at=now() WHERE id=$1 AND status='pending'`, inv.ID)
		if err := tx.Commit(); err != nil {
			return AcceptResult{}, err
		}
		return AcceptResult{}, ErrGone
	}

	// Reuse existing active membership or create a new one.
	var membershipID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM ky_membership WHERE user_id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL`,
		userID, inv.WorkspaceType, inv.WorkspaceID).Scan(&membershipID)
	if err == sql.ErrNoRows {
		membershipID = "mem_" + inv.ID + "_" + userID
		if displayName == "" {
			displayName = "成员"
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership (id, user_id, workspace_type, workspace_id, display_name, status, joined_at)
			VALUES ($1,$2,$3,$4,$5,'active',now())
		`, membershipID, userID, inv.WorkspaceType, inv.WorkspaceID, displayName); err != nil {
			return AcceptResult{}, classifyWriteErr(err)
		}
	} else if err != nil {
		return AcceptResult{}, err
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE ky_membership SET status='active', updated_at=now() WHERE id=$1`, membershipID); err != nil {
			return AcceptResult{}, err
		}
	}

	for _, roleID := range inv.PresetRoleIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_role (id, membership_id, role_id, workspace_type, workspace_id, created_by)
			VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (membership_id, role_id) DO NOTHING
		`, "mr_"+membershipID+"_"+roleID, membershipID, roleID, inv.WorkspaceType, inv.WorkspaceID, userID); err != nil {
			return AcceptResult{}, classifyWriteErr(err)
		}
	}
	for _, depID := range inv.PresetDeptIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_department (id, membership_id, department_id, is_primary)
			VALUES ($1,$2,$3,false) ON CONFLICT (membership_id, department_id) DO NOTHING
		`, "md_"+membershipID+"_"+depID, membershipID, depID); err != nil {
			return AcceptResult{}, classifyWriteErr(err)
		}
	}
	for _, teamID := range inv.PresetTeamIDs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_membership_team (id, membership_id, team_id, role_in_team)
			VALUES ($1,$2,$3,'member') ON CONFLICT (membership_id, team_id) DO NOTHING
		`, "mt_"+membershipID+"_"+teamID, membershipID, teamID); err != nil {
			return AcceptResult{}, classifyWriteErr(err)
		}
	}

	if _, err := tx.ExecContext(ctx, `UPDATE ky_invitation SET status='accepted', accepted_user_id=$2, accepted_at=now(), updated_at=now() WHERE id=$1`, inv.ID, userID); err != nil {
		return AcceptResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return AcceptResult{}, err
	}
	return AcceptResult{MembershipID: membershipID, WorkspaceType: inv.WorkspaceType, WorkspaceID: inv.WorkspaceID}, nil
}

// RoleRef is a minimal role reference for invitation display.
type RoleRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// RolesByIDs returns id+name for the given role ids, preserving existence only
// (order is by code). Unknown ids are skipped.
func (s *Store) RolesByIDs(ctx context.Context, ids []string) ([]RoleRef, error) {
	out := []RoleRef{}
	if len(ids) == 0 {
		return out, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "$" + itoa(i+1)
		args[i] = id
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name FROM ky_role WHERE id IN (`+strings.Join(placeholders, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref RoleRef
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// UserDisplayName returns a user's display name for membership creation.
func (s *Store) UserDisplayName(ctx context.Context, userID string) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT display_name FROM ky_user WHERE id=$1 AND deleted_at IS NULL`, userID).Scan(&name)
	if err == sql.ErrNoRows {
		return "", ErrNotFound
	}
	return name, err
}
