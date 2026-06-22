package store

import (
	"context"
	"database/sql"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type Store struct {
	db *sql.DB
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

// ActiveMembershipID returns the membership id of an active membership for the
// given user inside the workspace, or empty string if the user has no active
// membership there.
func (s *Store) ActiveMembershipID(ctx context.Context, userID, workspaceType, workspaceID string) (string, error) {
	var membershipID string
	err := s.db.QueryRowContext(ctx, `
		SELECT id FROM ky_membership
		WHERE user_id = $1 AND workspace_type = $2 AND workspace_id = $3
		  AND status = 'active' AND deleted_at IS NULL
		LIMIT 1
	`, userID, workspaceType, workspaceID).Scan(&membershipID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return membershipID, nil
}
