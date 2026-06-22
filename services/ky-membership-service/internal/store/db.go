package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
	ErrGone       = errors.New("gone")
	ErrValidation = errors.New("validation")
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

func itoa(i int) string { return strconv.Itoa(i) }

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func affectedOrNotFound(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func classifyWriteErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "23505") || strings.Contains(msg, "duplicate key") ||
		strings.Contains(msg, "23503") || strings.Contains(msg, "violates foreign key") {
		return ErrConflict
	}
	return err
}
