package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// HasAny reports whether the membership holds at least one of the wanted
// permission codes (page or action) in its assigned roles. Mirrors the
// resolver in ky-membership-service to keep enforcement consistent.
func (s *Store) HasAny(ctx context.Context, membershipID string, wanted []string) (bool, error) {
	if len(wanted) == 0 {
		return true, nil
	}
	placeholders := make([]string, len(wanted))
	args := make([]any, 0, len(wanted)+1)
	args = append(args, membershipID)
	for i, code := range wanted {
		placeholders[i] = "$" + itoa(i+2)
		args = append(args, code)
	}
	var x int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_permission rp ON rp.role_id = r.id
		JOIN ky_permission p ON p.id = rp.permission_id
		WHERE mr.membership_id = $1
		  AND r.status = 'normal' AND r.deleted_at IS NULL
		  AND p.status = 'normal'
		  AND p.code IN (`+strings.Join(placeholders, ",")+`)
		LIMIT 1
	`, args...).Scan(&x)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
