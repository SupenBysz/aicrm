package store

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
)

func (s *Store) CreateUser(ctx context.Context, user User) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_user (id, username, display_name, avatar_url, phone, email, status)
		VALUES ($1, NULLIF($2, ''), $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7)
	`, user.ID, user.Username, user.DisplayName, user.AvatarURL, user.Phone, user.Email, user.Status)
	return err
}

func (s *Store) GetUserByID(ctx context.Context, id string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		SELECT id, COALESCE(username, ''), display_name, avatar_url, COALESCE(phone, ''), COALESCE(email, ''), status
		FROM ky_user
		WHERE id = $1 AND deleted_at IS NULL
	`, id))
}

// SearchUsers returns up to `limit` active users matching the keyword (by display
// name / username / email / phone). Used for selection pickers (e.g. announcement
// targeting). Empty keyword returns the first page of active users.
func (s *Store) SearchUsers(ctx context.Context, keyword string, limit int) ([]User, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	base := `SELECT id, COALESCE(username, ''), display_name, avatar_url, COALESCE(phone, ''), COALESCE(email, ''), status
		FROM ky_user WHERE deleted_at IS NULL AND status = 'normal'`
	var (
		rows *sql.Rows
		err  error
	)
	if kw := strings.TrimSpace(keyword); kw != "" {
		rows, err = s.db.QueryContext(ctx,
			base+` AND (display_name ILIKE $1 OR username ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)
			ORDER BY display_name LIMIT `+strconv.Itoa(limit), "%"+kw+"%")
	} else {
		rows, err = s.db.QueryContext(ctx, base+` ORDER BY display_name LIMIT `+strconv.Itoa(limit))
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := make([]User, 0, limit)
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.Phone, &u.Email, &u.Status); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *Store) UpdateLastLogin(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_user SET last_login_at = now(), updated_at = now() WHERE id = $1`, userID)
	return err
}

func scanUser(row *sql.Row) (User, error) {
	var user User
	err := row.Scan(&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.Phone, &user.Email, &user.Status)
	return user, err
}
