package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
)

func (s *Store) ListAccounts(ctx context.Context, params ListAccountsParams) ([]MatrixAccount, Page, error) {
	where := []string{"a.workspace_type=$1", "a.workspace_id=$2", "a.deleted_at IS NULL"}
	args := []any{params.WorkspaceType, params.WorkspaceID}
	if params.Platform != "" {
		args = append(args, params.Platform)
		where = append(where, "a.platform=$"+itoa(len(args)))
	}
	if params.Keyword != "" {
		args = append(args, "%"+params.Keyword+"%")
		where = append(where, "(a.display_name ILIKE $"+itoa(len(args))+" OR a.platform_uid ILIKE $"+itoa(len(args))+" OR a.nickname ILIKE $"+itoa(len(args))+" OR a.remark ILIKE $"+itoa(len(args))+")")
	}
	if params.LoginStatus != "" {
		args = append(args, params.LoginStatus)
		where = append(where, "a.login_status=$"+itoa(len(args)))
	}
	if params.Status != "" {
		args = append(args, params.Status)
		where = append(where, "a.status=$"+itoa(len(args)))
	}

	var total int
	countArgs := append([]any{}, args...)
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_matrix_account a WHERE `+strings.Join(where, " AND "), countArgs...).Scan(&total)
	if err != nil {
		return nil, Page{}, err
	}

	offset := (params.Page - 1) * params.PageSize
	args = append(args, params.PageSize, offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.id, a.platform, a.platform_identity_key, a.identity_source,
		       a.display_name, a.platform_uid, a.nickname, a.avatar_url, a.home_url,
		       COALESCE(cs.browser_partition, ''),
		       COALESCE(a.owner_member_id, ''), COALESCE(m.display_name, ''), COALESCE(d.name, ''), COALESCE(t.name, ''),
		       a.login_status, a.status, a.remark,
		       to_char(cs.last_login_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(cs.last_check_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account a
		LEFT JOIN ky_membership m ON m.id = a.owner_member_id
		LEFT JOIN ky_department d ON d.id = a.department_id
		LEFT JOIN ky_team t ON t.id = a.team_id
		LEFT JOIN LATERAL (
		  SELECT browser_partition, last_login_at, last_check_at
		  FROM ky_matrix_account_client_session s
		  WHERE s.account_id = a.id AND s.deleted_at IS NULL
		  ORDER BY COALESCE(s.last_check_at, s.updated_at) DESC
		  LIMIT 1
		) cs ON true
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY a.updated_at DESC, a.created_at DESC
		LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()
	items, err := scanAccounts(rows)
	if err != nil {
		return nil, Page{}, err
	}
	return items, Page{Page: params.Page, PageSize: params.PageSize, Total: total}, nil
}

func (s *Store) GetAccount(ctx context.Context, workspaceType, workspaceID, id string) (MatrixAccount, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.id, a.platform, a.platform_identity_key, a.identity_source,
		       a.display_name, a.platform_uid, a.nickname, a.avatar_url, a.home_url,
		       COALESCE(cs.browser_partition, ''),
		       COALESCE(a.owner_member_id, ''), COALESCE(m.display_name, ''), COALESCE(d.name, ''), COALESCE(t.name, ''),
		       a.login_status, a.status, a.remark,
		       to_char(cs.last_login_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(cs.last_check_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account a
		LEFT JOIN ky_membership m ON m.id = a.owner_member_id
		LEFT JOIN ky_department d ON d.id = a.department_id
		LEFT JOIN ky_team t ON t.id = a.team_id
		LEFT JOIN LATERAL (
		  SELECT browser_partition, last_login_at, last_check_at
		  FROM ky_matrix_account_client_session s
		  WHERE s.account_id = a.id AND s.deleted_at IS NULL
		  ORDER BY COALESCE(s.last_check_at, s.updated_at) DESC
		  LIMIT 1
		) cs ON true
		WHERE a.workspace_type=$1 AND a.workspace_id=$2 AND a.id=$3 AND a.deleted_at IS NULL
	`, workspaceType, workspaceID, id)
	if err != nil {
		return MatrixAccount{}, err
	}
	defer rows.Close()
	items, err := scanAccounts(rows)
	if err != nil {
		return MatrixAccount{}, err
	}
	if len(items) == 0 {
		return MatrixAccount{}, ErrNotFound
	}
	return items[0], nil
}

func (s *Store) CreateAccount(ctx context.Context, workspaceType, workspaceID, actorUserID string, in MatrixAccountInput) (MatrixAccount, error) {
	id := newID("ma")
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_matrix_account (
		  id, workspace_type, workspace_id, platform, platform_identity_key, identity_source, display_name, platform_uid, nickname, home_url,
		  owner_member_id, department_id, team_id, remark, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
	`, id, workspaceType, workspaceID, in.Platform, in.PlatformUID, in.DisplayName, in.PlatformUID, in.Nickname, in.HomeURL,
		nullStr(in.OwnerMemberID), nullStr(in.DepartmentID), nullStr(in.TeamID), in.Remark, actorUserID)
	if err != nil {
		return MatrixAccount{}, classifyWriteErr(err)
	}
	return s.GetAccount(ctx, workspaceType, workspaceID, id)
}

func (s *Store) UpdateAccount(ctx context.Context, workspaceType, workspaceID, id, actorUserID string, in MatrixAccountInput) (MatrixAccount, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_matrix_account
		SET display_name=$4, owner_member_id=$5, department_id=$6, team_id=$7,
		    remark=$8, updated_by=$9, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
	`, workspaceType, workspaceID, id, in.DisplayName, nullStr(in.OwnerMemberID), nullStr(in.DepartmentID), nullStr(in.TeamID), in.Remark, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccount{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return MatrixAccount{}, err
	}
	return s.GetAccount(ctx, workspaceType, workspaceID, id)
}

func (s *Store) UpdateAccountStatus(ctx context.Context, workspaceType, workspaceID, id, status, actorUserID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_matrix_account
		SET status=$4, updated_by=$5, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
	`, workspaceType, workspaceID, id, status, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) DeleteAccount(ctx context.Context, workspaceType, workspaceID, id, actorUserID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_matrix_account
		SET deleted_at=now(), updated_by=$4, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND id=$3 AND deleted_at IS NULL
	`, workspaceType, workspaceID, id, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) CreateLoginTask(ctx context.Context, workspaceType, workspaceID, memberID, accountID, deviceID, loginURL string) (LoginTask, error) {
	id := newID("mlt")
	if deviceID == "" {
		deviceID = "default"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_login_task (id, account_id, workspace_type, workspace_id, member_id, device_id, status, platform_login_url, expired_at)
		SELECT $1, id, workspace_type, workspace_id, $5, $6, 'pending', $7, now() + interval '10 minutes'
		FROM ky_matrix_account
		WHERE workspace_type=$2 AND workspace_id=$3 AND id=$4 AND deleted_at IS NULL
	`, id, workspaceType, workspaceID, accountID, memberID, deviceID, loginURL)
	if err := classifyWriteErr(err); err != nil {
		return LoginTask{}, err
	}
	return s.GetLoginTask(ctx, workspaceType, workspaceID, accountID, id)
}

func (s *Store) GetLoginTask(ctx context.Context, workspaceType, workspaceID, accountID, id string) (LoginTask, error) {
	var task LoginTask
	var expiredAt, completedAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, account_id, status, platform_login_url, error_message,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(expired_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_task
		WHERE workspace_type=$1 AND workspace_id=$2 AND account_id=$3 AND id=$4
	`, workspaceType, workspaceID, accountID, id).Scan(
		&task.ID, &task.AccountID, &task.Status, &task.PlatformLoginURL, &task.ErrorMessage,
		&task.CreatedAt, &expiredAt, &completedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return LoginTask{}, ErrNotFound
	}
	if expiredAt.Valid {
		task.ExpiredAt = &expiredAt.String
	}
	if completedAt.Valid {
		task.CompletedAt = &completedAt.String
	}
	return task, err
}

func scanAccounts(rows *sql.Rows) ([]MatrixAccount, error) {
	items := []MatrixAccount{}
	for rows.Next() {
		var item MatrixAccount
		var lastLogin, lastCheck sql.NullString
		if err := rows.Scan(
			&item.ID, &item.Platform, &item.PlatformIdentityKey, &item.IdentitySource,
			&item.DisplayName, &item.PlatformUID, &item.Nickname, &item.AvatarURL, &item.HomeURL, &item.BrowserPartition,
			&item.OwnerMemberID, &item.OwnerName, &item.DepartmentName, &item.TeamName,
			&item.LoginStatus, &item.Status, &item.Remark,
			&lastLogin, &lastCheck, &item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if lastLogin.Valid {
			item.LastLoginAt = &lastLogin.String
		}
		if lastCheck.Valid {
			item.LastCheckAt = &lastCheck.String
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func itoa(i int) string {
	return strconv.Itoa(i)
}
