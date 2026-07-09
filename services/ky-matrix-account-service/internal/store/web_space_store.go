package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func (s *Store) CreateWebSpace(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID string, in MatrixAccountWebSpaceInput) (MatrixAccountWebSpace, error) {
	id := newID("maws")
	deviceID := strings.TrimSpace(in.DeviceID)
	if deviceID == "" {
		deviceID = "default"
	}
	browserPartition := webSpacePartition(workspaceType, workspaceID, in.Platform, id, deviceID)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_web_space (
		  id, workspace_type, workspace_id, platform, member_id, device_id, browser_partition, status, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8,$8)
	`, id, workspaceType, workspaceID, in.Platform, memberID, deviceID, browserPartition, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccountWebSpace{}, err
	}
	return s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, id)
}

func (s *Store) GetWebSpace(ctx context.Context, workspaceType, workspaceID, memberID, id string) (MatrixAccountWebSpace, error) {
	rows, err := s.db.QueryContext(ctx, webSpaceSelectSQL()+`
		WHERE workspace_type=$1 AND workspace_id=$2 AND member_id=$3 AND id=$4 AND deleted_at IS NULL
	`, workspaceType, workspaceID, memberID, id)
	if err != nil {
		return MatrixAccountWebSpace{}, err
	}
	defer rows.Close()
	items, err := scanWebSpaces(rows)
	if err != nil {
		return MatrixAccountWebSpace{}, err
	}
	if len(items) == 0 {
		return MatrixAccountWebSpace{}, ErrNotFound
	}
	return items[0], nil
}

func (s *Store) BindDetectedWebSpace(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, id string, in MatrixAccountDetectResultInput) (MatrixAccountBindResult, error) {
	deviceID := strings.TrimSpace(in.DeviceID)
	if deviceID == "" {
		deviceID = "default"
	}
	loginStatus := strings.TrimSpace(in.LoginStatus)
	if loginStatus == "" {
		loginStatus = "online"
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MatrixAccountBindResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	ws, err := getWebSpaceForUpdate(ctx, tx, workspaceType, workspaceID, memberID, id)
	if err != nil {
		return MatrixAccountBindResult{}, err
	}
	if ws.Status == "abandoned" || ws.Status == "cleared" {
		return MatrixAccountBindResult{}, ErrValidation
	}

	browserPartition := strings.TrimSpace(in.BrowserPartition)
	if browserPartition == "" {
		browserPartition = ws.BrowserPartition
	}
	displayName := firstNonEmpty(in.DisplayName, in.Nickname, in.PlatformUID, "未命名账号")

	accountID, created, err := upsertDetectedAccount(ctx, tx, workspaceType, workspaceID, actorUserID, ws.Platform, in, displayName, loginStatus)
	if err != nil {
		return MatrixAccountBindResult{}, err
	}
	if err := upsertClientSession(ctx, tx, accountID, workspaceType, workspaceID, memberID, deviceID, browserPartition, loginStatus); err != nil {
		return MatrixAccountBindResult{}, err
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE ky_matrix_account_web_space
		SET account_id=$5, status='bound', detected_identity_key=$6, detected_platform_uid=$7,
		    detected_nickname=$8, detected_avatar_url=$9, detected_home_url=$10,
		    browser_partition=$11, detected_at=now(), updated_by=$12, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND member_id=$3 AND id=$4 AND deleted_at IS NULL
	`, workspaceType, workspaceID, memberID, id, accountID, in.IdentityKey, in.PlatformUID, in.Nickname, in.AvatarURL, in.HomeURL, browserPartition, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccountBindResult{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return MatrixAccountBindResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return MatrixAccountBindResult{}, err
	}

	webSpace, err := s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, id)
	if err != nil {
		return MatrixAccountBindResult{}, err
	}
	account, err := s.GetAccount(ctx, workspaceType, workspaceID, accountID)
	if err != nil {
		return MatrixAccountBindResult{}, err
	}
	return MatrixAccountBindResult{WebSpace: webSpace, Account: account, Created: created}, nil
}

func (s *Store) MarkWebSpaceDetectFailed(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, id string, in MatrixAccountDetectResultInput) (MatrixAccountWebSpace, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_matrix_account_web_space
		SET status='detect_failed', detected_identity_key=$5, detected_platform_uid=$6,
		    detected_nickname=$7, detected_avatar_url=$8, detected_home_url=$9,
		    browser_partition=COALESCE(NULLIF($10, ''), browser_partition),
		    detected_at=now(), updated_by=$11, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND member_id=$3 AND id=$4
		  AND deleted_at IS NULL AND status NOT IN ('abandoned', 'cleared')
	`, workspaceType, workspaceID, memberID, id, in.IdentityKey, in.PlatformUID, in.Nickname, in.AvatarURL, in.HomeURL, in.BrowserPartition, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccountWebSpace{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return MatrixAccountWebSpace{}, err
	}
	return s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, id)
}

func (s *Store) AbandonWebSpace(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, id string) (MatrixAccountWebSpace, error) {
	return s.setWebSpaceStatus(ctx, workspaceType, workspaceID, memberID, actorUserID, id, "abandoned")
}

func (s *Store) ClearWebSpace(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, id string) (MatrixAccountWebSpace, error) {
	return s.setWebSpaceStatus(ctx, workspaceType, workspaceID, memberID, actorUserID, id, "cleared")
}

func (s *Store) setWebSpaceStatus(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, id, status string) (MatrixAccountWebSpace, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_matrix_account_web_space
		SET status=$5, updated_by=$6, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND member_id=$3 AND id=$4 AND deleted_at IS NULL
	`, workspaceType, workspaceID, memberID, id, status, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccountWebSpace{}, err
	}
	if err := affectedOrNotFound(res); err != nil {
		return MatrixAccountWebSpace{}, err
	}
	return s.GetWebSpace(ctx, workspaceType, workspaceID, memberID, id)
}

func getWebSpaceForUpdate(ctx context.Context, tx *sql.Tx, workspaceType, workspaceID, memberID, id string) (MatrixAccountWebSpace, error) {
	rows, err := tx.QueryContext(ctx, webSpaceSelectSQL()+`
		WHERE workspace_type=$1 AND workspace_id=$2 AND member_id=$3 AND id=$4 AND deleted_at IS NULL
		FOR UPDATE
	`, workspaceType, workspaceID, memberID, id)
	if err != nil {
		return MatrixAccountWebSpace{}, err
	}
	defer rows.Close()
	items, err := scanWebSpaces(rows)
	if err != nil {
		return MatrixAccountWebSpace{}, err
	}
	if len(items) == 0 {
		return MatrixAccountWebSpace{}, ErrNotFound
	}
	return items[0], nil
}

func upsertDetectedAccount(ctx context.Context, tx *sql.Tx, workspaceType, workspaceID, actorUserID, platform string, in MatrixAccountDetectResultInput, displayName, loginStatus string) (string, bool, error) {
	var accountID string
	err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM ky_matrix_account
		WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND platform_identity_key=$4 AND deleted_at IS NULL
		LIMIT 1
	`, workspaceType, workspaceID, platform, in.IdentityKey).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		accountID = newID("ma")
		_, err = tx.ExecContext(ctx, `
			INSERT INTO ky_matrix_account (
			  id, workspace_type, workspace_id, platform, platform_identity_key, identity_source,
			  display_name, platform_uid, nickname, avatar_url, home_url, login_status, created_by, updated_by)
			VALUES ($1,$2,$3,$4,$5,'web_space',$6,$7,$8,$9,$10,$11,$12,$12)
		`, accountID, workspaceType, workspaceID, platform, in.IdentityKey, displayName, in.PlatformUID, in.Nickname, in.AvatarURL, in.HomeURL, loginStatus, actorUserID)
		if err := classifyWriteErr(err); err != nil {
			return "", false, err
		}
		return accountID, true, nil
	}
	if err != nil {
		return "", false, err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE ky_matrix_account
		SET platform_uid=$5, nickname=$6, avatar_url=$7, home_url=$8,
		    login_status=$9, updated_by=$10, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND id=$4 AND deleted_at IS NULL
	`, workspaceType, workspaceID, platform, accountID, in.PlatformUID, in.Nickname, in.AvatarURL, in.HomeURL, loginStatus, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return "", false, err
	}
	return accountID, false, nil
}

func upsertClientSession(ctx context.Context, tx *sql.Tx, accountID, workspaceType, workspaceID, memberID, deviceID, browserPartition, loginStatus string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_client_session (
		  id, account_id, workspace_type, workspace_id, member_id, device_id, browser_partition,
		  login_status, last_login_at, last_check_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
		ON CONFLICT (account_id, member_id, device_id) WHERE deleted_at IS NULL
		DO UPDATE SET browser_partition=EXCLUDED.browser_partition, login_status=EXCLUDED.login_status,
		              last_login_at=now(), last_check_at=now(), updated_at=now()
	`, newID("macs"), accountID, workspaceType, workspaceID, memberID, deviceID, browserPartition, loginStatus)
	return classifyWriteErr(err)
}

func webSpaceSelectSQL() string {
	return `
		SELECT id, workspace_type, workspace_id, platform, member_id, device_id, browser_partition,
		       COALESCE(account_id, ''), status, detected_identity_key, detected_platform_uid,
		       detected_nickname, detected_avatar_url, detected_home_url,
		       to_char(last_opened_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(detected_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_web_space
	`
}

func scanWebSpaces(rows *sql.Rows) ([]MatrixAccountWebSpace, error) {
	items := []MatrixAccountWebSpace{}
	for rows.Next() {
		var item MatrixAccountWebSpace
		var lastOpenedAt, detectedAt sql.NullString
		if err := rows.Scan(
			&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.Platform, &item.MemberID, &item.DeviceID, &item.BrowserPartition,
			&item.AccountID, &item.Status, &item.DetectedIdentityKey, &item.DetectedPlatformUID,
			&item.DetectedNickname, &item.DetectedAvatarURL, &item.DetectedHomeURL,
			&lastOpenedAt, &detectedAt, &item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if lastOpenedAt.Valid {
			item.LastOpenedAt = &lastOpenedAt.String
		}
		if detectedAt.Valid {
			item.DetectedAt = &detectedAt.String
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func webSpacePartition(workspaceType, workspaceID, platform, webSpaceID, deviceID string) string {
	return strings.Join([]string{
		"persist:matrix-account-space",
		safePartitionPart(workspaceType),
		safePartitionPart(workspaceID),
		safePartitionPart(platform),
		safePartitionPart(webSpaceID),
		safePartitionPart(deviceID),
	}, ":")
}

func safePartitionPart(value string) string {
	mapped := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '.' || r == '-' {
			return r
		}
		return '_'
	}, value)
	if len(mapped) > 96 {
		return mapped[:96]
	}
	return mapped
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
