package store

import (
	"context"
	"time"

	"github.com/Kysion/KyaiCRM/shared/session"
)

// SessionActive reports whether the session exists, is active and not expired.
// Missing session is treated as inactive (not an error). Single source of truth:
// shared/session (Phase 1.17).
func (s *Store) SessionActive(ctx context.Context, sessionID string, now time.Time) (bool, error) {
	return session.Active(ctx, s.db, sessionID, now)
}
