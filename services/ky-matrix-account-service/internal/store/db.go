package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/shared/session"
	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
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

func (s *Store) SessionActive(ctx context.Context, sessionID string, now time.Time) (bool, error) {
	return session.Active(ctx, s.db, sessionID, now)
}

func (s *Store) ActiveMembershipID(ctx context.Context, userID, workspaceType, workspaceID string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `
		SELECT id FROM ky_membership
		WHERE user_id=$1 AND workspace_type=$2 AND workspace_id=$3 AND status='active' AND deleted_at IS NULL
		LIMIT 1
	`, userID, workspaceType, workspaceID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

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
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func newID(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
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
	if strings.Contains(msg, "23505") || strings.Contains(msg, "duplicate key") {
		return ErrConflict
	}
	if strings.Contains(msg, "23503") || strings.Contains(msg, "violates foreign key") {
		return ErrValidation
	}
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
