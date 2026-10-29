package store

import (
	"context"
)

func (s *Store) OnlineUsers(ctx context.Context, ids []string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT s.user_id FROM ky_user_session s JOIN ky_user u ON u.id=s.user_id WHERE s.user_id=ANY($1) AND u.deleted_at IS NULL AND u.status='normal' AND s.status='active' AND s.expires_at>now() AND s.last_seen_at>now()-interval '90 seconds'`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
func (s *Store) TouchPresence(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_user_session SET last_seen_at=now() WHERE id=$1 AND status='active' AND expires_at>now() AND (last_seen_at IS NULL OR last_seen_at<now()-interval '20 seconds')`, id)
	return err
}
