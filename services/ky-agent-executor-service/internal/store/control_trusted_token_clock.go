package store

import (
	"context"
	"errors"
	"time"
)

// TrustedTokenDatabaseNow exposes only PostgreSQL transaction time to the
// public keyring handler. The server consumes it through a narrow interface;
// it is intentionally not part of the broad controlStore contract.
func (s *ControlStore) TrustedTokenDatabaseNow(ctx context.Context) (time.Time, error) {
	if s == nil || s.db == nil {
		return time.Time{}, errors.New("trusted-token database clock unavailable")
	}
	var databaseNow time.Time
	if err := s.db.QueryRowContext(ctx, `SELECT transaction_timestamp()`).Scan(&databaseNow); err != nil {
		return time.Time{}, err
	}
	return databaseNow.UTC().Truncate(time.Second), nil
}
