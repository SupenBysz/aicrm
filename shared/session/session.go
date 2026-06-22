// Package session is the single source of truth for session-validity checks
// against ky_user_session, shared by all services that enforce live sessions.
package session

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Active reports whether the session exists, is active and not expired.
// A missing session is treated as inactive (not an error).
func Active(ctx context.Context, db *sql.DB, sessionID string, now time.Time) (bool, error) {
	var status string
	var expiresAt time.Time
	err := db.QueryRowContext(ctx, `SELECT status, expires_at FROM ky_user_session WHERE id=$1`, sessionID).Scan(&status, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return status == "active" && expiresAt.After(now), nil
}
