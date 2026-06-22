// Package notify is the single source of truth for writing personal
// (scope_type='user') notifications into ky_notification.
package notify

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
)

// CreateUserNotification inserts a personal notification targeted at a user
// (scope_type='user', recipient_user_id=userID). The notification id is
// generated internally ("ntf_<rand>"); callers do not supply it.
func CreateUserNotification(ctx context.Context, db *sql.DB, userID, title, content, notificationType string) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO ky_notification (id, scope_type, scope_id, recipient_user_id, title, content, notification_type, status)
		VALUES ($1,'user',$2,$2,$3,$4,$5,'normal')
	`, "ntf_"+randomSuffix(), userID, title, content, notificationType)
	return err
}

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
