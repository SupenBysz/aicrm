package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

type Announcement struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Content     string     `json:"content"`
	TargetScope string     `json:"targetScope"`
	TargetIDs   []string   `json:"targetIds"`
	Status      string     `json:"status"`
	PublishedAt *time.Time `json:"publishedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
}

func scanAnnouncement(row interface{ Scan(...any) error }) (Announcement, error) {
	var a Announcement
	var targetB []byte
	err := row.Scan(&a.ID, &a.Title, &a.Content, &a.TargetScope, &targetB, &a.Status, &a.PublishedAt, &a.CreatedAt)
	if err != nil {
		return Announcement{}, err
	}
	a.TargetIDs = jsonToStrings(targetB)
	return a, nil
}

const announcementColumns = `id, title, content, target_scope, target_ids, status, published_at, created_at`

// ListAnnouncementsPlatform returns all announcements (optionally by status).
func (s *Store) ListAnnouncementsPlatform(ctx context.Context, status string, page, pageSize int) ([]Announcement, int64, error) {
	where := []string{"TRUE"}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_system_announcement WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+announcementColumns+` FROM ky_system_announcement WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	return collectAnnouncements(rows, total)
}

// ListAnnouncementsForWorkspace returns published announcements visible to the workspace.
func (s *Store) ListAnnouncementsForWorkspace(ctx context.Context, wsType, wsID string, page, pageSize int) ([]Announcement, int64, error) {
	// visible: target_scope='all' OR (target_scope=wsType AND target_ids contains wsID)
	args := []any{wsType, `"` + wsID + `"`}
	clause := `status='published' AND (target_scope='all' OR (target_scope=$1 AND target_ids @> $2::jsonb))`
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_system_announcement WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+announcementColumns+` FROM ky_system_announcement WHERE `+clause+` ORDER BY published_at DESC NULLS LAST LIMIT $3 OFFSET $4`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	return collectAnnouncements(rows, total)
}

func collectAnnouncements(rows *sql.Rows, total int64) ([]Announcement, int64, error) {
	items := []Announcement{}
	for rows.Next() {
		a, err := scanAnnouncement(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, a)
	}
	return items, total, rows.Err()
}

func (s *Store) CreateAnnouncement(ctx context.Context, a Announcement, createdBy string) (string, error) {
	id := "ann_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_system_announcement (id, title, content, target_scope, target_ids, status, created_by)
		VALUES ($1,$2,$3,$4,$5::jsonb,'draft',$6)
	`, id, a.Title, a.Content, a.TargetScope, stringsToJSON(a.TargetIDs), createdBy)
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) GetAnnouncement(ctx context.Context, id string) (Announcement, error) {
	a, err := scanAnnouncement(s.db.QueryRowContext(ctx, `SELECT `+announcementColumns+` FROM ky_system_announcement WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return Announcement{}, ErrNotFound
	}
	return a, err
}

// PublishAnnouncement publishes a draft and bridges notifications. Returns the
// number of notifications generated.
func (s *Store) PublishAnnouncement(ctx context.Context, id string) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	a, err := scanAnnouncement(tx.QueryRowContext(ctx, `SELECT `+announcementColumns+` FROM ky_system_announcement WHERE id=$1 FOR UPDATE`, id))
	if err == sql.ErrNoRows {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if a.Status != "draft" {
		return 0, ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ky_system_announcement SET status='published', published_at=now(), updated_at=now() WHERE id=$1`, id); err != nil {
		return 0, err
	}

	generated := 0
	switch a.TargetScope {
	case "all":
		if err := createNotificationTx(ctx, tx, "platform", "platform_root", "", a.Title, a.Content, "system"); err != nil {
			return 0, err
		}
		generated = 1
	case "agency", "enterprise":
		for _, tid := range a.TargetIDs {
			if err := createNotificationTx(ctx, tx, a.TargetScope, tid, "", a.Title, a.Content, "system"); err != nil {
				return 0, err
			}
			generated++
		}
	case "user":
		for _, uid := range a.TargetIDs {
			if err := createNotificationTx(ctx, tx, "user", uid, uid, a.Title, a.Content, "system"); err != nil {
				return 0, err
			}
			generated++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return generated, nil
}
