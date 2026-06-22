package store

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/shared/notify"
)

type Notification struct {
	ID               string    `json:"id"`
	ScopeType        string    `json:"scopeType"`
	ScopeID          string    `json:"scopeId"`
	Title            string    `json:"title"`
	Content          string    `json:"content"`
	NotificationType string    `json:"notificationType"`
	Read             bool      `json:"read"`
	CreatedAt        time.Time `json:"createdAt"`
}

// visibilityClause builds the "my notifications" predicate and its args,
// starting placeholder numbering at the given base (len of existing args).
func visibilityClause(userID, wsType, wsID string, args *[]any) string {
	*args = append(*args, userID)
	uidP := "$" + itoa(len(*args))
	*args = append(*args, wsType)
	wtP := "$" + itoa(len(*args))
	*args = append(*args, wsID)
	wiP := "$" + itoa(len(*args))
	return "(n.recipient_user_id=" + uidP + " OR n.scope_type='platform' OR (n.scope_type=" + wtP + " AND n.scope_id=" + wiP + "))"
}

func (s *Store) ListNotifications(ctx context.Context, userID, wsType, wsID, readFilter, typeFilter string, page, pageSize int) ([]Notification, int64, error) {
	// whereArgs holds exactly the parameters referenced by the WHERE clause, so
	// the COUNT query binds the right number (the read-status projection param is
	// only added to the SELECT below). Mixing them caused a param-count mismatch
	// (500) whenever readFilter was empty.
	whereArgs := []any{}
	vis := visibilityClause(userID, wsType, wsID, &whereArgs)
	where := []string{"n.status='normal'", vis}

	if typeFilter != "" {
		whereArgs = append(whereArgs, typeFilter)
		where = append(where, "n.notification_type=$"+itoa(len(whereArgs)))
	}
	if readFilter == "true" || readFilter == "false" {
		whereArgs = append(whereArgs, userID)
		expr := "EXISTS (SELECT 1 FROM ky_notification_read nr WHERE nr.notification_id=n.id AND nr.user_id=$" + itoa(len(whereArgs)) + ")"
		if readFilter == "false" {
			expr = "NOT " + expr
		}
		where = append(where, expr)
	}
	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_notification n WHERE `+clause, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	selArgs := append([]any{}, whereArgs...)
	selArgs = append(selArgs, userID)
	readExpr := "EXISTS (SELECT 1 FROM ky_notification_read nr WHERE nr.notification_id=n.id AND nr.user_id=$" + itoa(len(selArgs)) + ")"
	selArgs = append(selArgs, pageSize)
	limit := "$" + itoa(len(selArgs))
	selArgs = append(selArgs, (page-1)*pageSize)
	offset := "$" + itoa(len(selArgs))
	rows, err := s.db.QueryContext(ctx, `
		SELECT n.id, n.scope_type, n.scope_id, n.title, n.content, n.notification_type, `+readExpr+`, n.created_at
		FROM ky_notification n WHERE `+clause+` ORDER BY n.created_at DESC LIMIT `+limit+` OFFSET `+offset, selArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.ScopeType, &n.ScopeID, &n.Title, &n.Content, &n.NotificationType, &n.Read, &n.CreatedAt); err != nil {
			return nil, 0, err
		}
		items = append(items, n)
	}
	return items, total, rows.Err()
}

func (s *Store) UnreadCount(ctx context.Context, userID, wsType, wsID string) (int64, error) {
	args := []any{}
	vis := visibilityClause(userID, wsType, wsID, &args)
	args = append(args, userID)
	readUser := "$" + itoa(len(args))
	var count int64
	err := s.db.QueryRowContext(ctx, `
		SELECT count(*) FROM ky_notification n
		WHERE n.status='normal' AND `+vis+`
		  AND NOT EXISTS (SELECT 1 FROM ky_notification_read nr WHERE nr.notification_id=n.id AND nr.user_id=`+readUser+`)
	`, args...).Scan(&count)
	return count, err
}

// notificationVisible reports whether the notification is visible to the user.
func (s *Store) notificationVisible(ctx context.Context, id, userID, wsType, wsID string) (bool, error) {
	args := []any{id}
	// visibilityClause appends to args, so its placeholders start at $2 here,
	// matching the n.id=$1 parameter above it.
	vis := visibilityClause(userID, wsType, wsID, &args)
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_notification n WHERE n.id=$1 AND n.status='normal' AND `+vis, args...).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) MarkNotificationRead(ctx context.Context, id, userID, wsType, wsID string) error {
	visible, err := s.notificationVisible(ctx, id, userID, wsType, wsID)
	if err != nil {
		return err
	}
	if !visible {
		return ErrNotFound
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO ky_notification_read (id, notification_id, user_id) VALUES ($1,$2,$3)
		ON CONFLICT (notification_id, user_id) DO NOTHING
	`, "nr_"+id+"_"+userID, id, userID)
	return err
}

func (s *Store) MarkAllRead(ctx context.Context, userID, wsType, wsID string) (int64, error) {
	args := []any{}
	vis := visibilityClause(userID, wsType, wsID, &args)
	args = append(args, userID)
	readUser := "$" + itoa(len(args))
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_notification_read (id, notification_id, user_id)
		SELECT 'nr_' || n.id || '_' || `+readUser+`, n.id, `+readUser+`
		FROM ky_notification n
		WHERE n.status='normal' AND `+vis+`
		  AND NOT EXISTS (SELECT 1 FROM ky_notification_read nr WHERE nr.notification_id=n.id AND nr.user_id=`+readUser+`)
		ON CONFLICT (notification_id, user_id) DO NOTHING
	`, args...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// createNotificationTx inserts a notification within a transaction.
func createNotificationTx(ctx context.Context, tx *sql.Tx, scopeType, scopeID, recipientUserID, title, content, nType string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_notification (id, scope_type, scope_id, recipient_user_id, title, content, notification_type, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'normal')
	`, "ntf_"+randomSuffix(), scopeType, scopeID, nullStr(recipientUserID), title, content, nType)
	return err
}

// CreateUserNotification inserts a personal notification targeted at a user
// (scope_type='user', recipient_user_id=userID). Delegates to shared/notify
// (single source of truth, Phase 1.17).
func (s *Store) CreateUserNotification(ctx context.Context, userID, title, content, notificationType string) error {
	return notify.CreateUserNotification(ctx, s.db, userID, title, content, notificationType)
}

// UserIDsByRole returns the distinct owning user ids of all (non-deleted)
// memberships that currently hold the given role. Used to fan out role
// permission-change notifications (Phase 1.16).
func (s *Store) UserIDsByRole(ctx context.Context, roleID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT m.user_id
		FROM ky_membership_role mr JOIN ky_membership m ON m.id = mr.membership_id
		WHERE mr.role_id = $1 AND m.deleted_at IS NULL
	`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// MembershipUserID returns the owning user id of a membership, regardless of
// soft-deletion state (member.removed sets deleted_at but the owner is still
// the notification recipient).
func (s *Store) MembershipUserID(ctx context.Context, membershipID string) (string, error) {
	var userID string
	err := s.db.QueryRowContext(ctx, `SELECT user_id FROM ky_membership WHERE id=$1`, membershipID).Scan(&userID)
	if err == sql.ErrNoRows {
		return "", ErrNotFound
	}
	return userID, err
}
