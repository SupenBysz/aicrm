package store

import (
	"context"
	"strconv"
	"strings"
	"time"
)

type LoginLog struct {
	ID           string    `json:"id"`
	UserID       *string   `json:"userId"`
	LoginAccount string    `json:"loginAccount"`
	Result       string    `json:"result"`
	FailReason   string    `json:"failReason"`
	IPAddress    string    `json:"ipAddress"`
	UserAgent    string    `json:"userAgent"`
	CreatedAt    time.Time `json:"createdAt"`
}

// ActiveMembershipID returns an active membership id for the user in the workspace.
func (s *Store) ActiveMembershipID(ctx context.Context, userID, workspaceType, workspaceID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `
		SELECT id FROM ky_membership
		WHERE user_id=$1 AND workspace_type=$2 AND workspace_id=$3 AND status='active' AND deleted_at IS NULL
		LIMIT 1
	`, userID, workspaceType, workspaceID).Scan(&id)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return "", nil
		}
		return "", err
	}
	return id, nil
}

// HasAny reports whether the membership holds at least one of the wanted permission codes.
func (s *Store) HasAny(ctx context.Context, membershipID string, wanted []string) (bool, error) {
	if len(wanted) == 0 {
		return true, nil
	}
	placeholders := make([]string, len(wanted))
	args := make([]any, 0, len(wanted)+1)
	args = append(args, membershipID)
	for i, code := range wanted {
		placeholders[i] = "$" + strconv.Itoa(i+2)
		args = append(args, code)
	}
	var x int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_permission rp ON rp.role_id = r.id
		JOIN ky_permission p ON p.id = rp.permission_id
		WHERE mr.membership_id=$1 AND r.status='normal' AND r.deleted_at IS NULL AND p.status='normal'
		  AND p.code IN (`+strings.Join(placeholders, ",")+`) LIMIT 1
	`, args...).Scan(&x)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

type LoginLogFilter struct{ UserID, Result, StartAt, EndAt, EndBefore, Account string }

func (s *Store) ListLoginLogs(ctx context.Context, userID, result, startAt, endAt string, page, pageSize int) ([]LoginLog, int64, error) {
	return s.ListLoginLogsFiltered(ctx, LoginLogFilter{UserID: userID, Result: result, StartAt: startAt, EndAt: endAt}, page, pageSize)
}
func (s *Store) ListLoginLogsFiltered(ctx context.Context, filter LoginLogFilter, page, pageSize int) ([]LoginLog, int64, error) {
	where, args := loginLogConditions(filter)
	add := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }

	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_login_log WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, login_account, result, fail_reason, ip_address, user_agent, created_at
		FROM ky_login_log WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []LoginLog{}
	for rows.Next() {
		var l LoginLog
		if err := rows.Scan(&l.ID, &l.UserID, &l.LoginAccount, &l.Result, &l.FailReason, &l.IPAddress, &l.UserAgent, &l.CreatedAt); err != nil {
			return nil, 0, err
		}
		items = append(items, l)
	}
	return items, total, rows.Err()
}

func loginLogConditions(filter LoginLogFilter) ([]string, []any) {
	where := []string{"TRUE"}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	if filter.UserID != "" {
		where = append(where, "user_id="+add(filter.UserID))
	}
	if filter.Result != "" {
		where = append(where, "result="+add(filter.Result))
	}
	if filter.StartAt != "" {
		where = append(where, "created_at>="+add(filter.StartAt))
	}
	if filter.EndAt != "" {
		where = append(where, "created_at<="+add(filter.EndAt))
	}
	if filter.EndBefore != "" {
		where = append(where, "created_at<"+add(filter.EndBefore))
	}
	if filter.Account != "" {
		where = append(where, "login_account="+add(filter.Account))
	}

	return where, args
}
