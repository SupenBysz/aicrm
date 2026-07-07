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
	// Visible when: broadcast to everyone (all/user_all), OR this workspace is in the
	// targeted set (指定), OR a whole-type broadcast matching this workspace type.
	args := []any{wsType, `"` + wsID + `"`}
	clause := `status='published' AND (
		target_scope IN ('all','user_all')
		OR (target_scope=$1 AND target_ids @> $2::jsonb)
		OR (target_scope='agency_all' AND $1='agency')
		OR (target_scope='enterprise_all' AND $1='enterprise')
	)`
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

// allOrgIDsTx returns every non-deleted org id from the given table. `table` is a
// fixed internal literal ("ky_agency" / "ky_enterprise"), never user input.
func allOrgIDsTx(ctx context.Context, tx *sql.Tx, table string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM `+table+` WHERE deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
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

// UpdateAnnouncement edits a draft announcement. Published announcements are
// immutable (they have already been bridged to notifications), so the update only
// applies while status='draft'; otherwise ErrConflict.
func (s *Store) UpdateAnnouncement(ctx context.Context, a Announcement) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_system_announcement
		SET title=$2, content=$3, target_scope=$4, target_ids=$5::jsonb, updated_at=now()
		WHERE id=$1 AND status='draft'
	`, a.ID, a.Title, a.Content, a.TargetScope, stringsToJSON(a.TargetIDs))
	if err != nil {
		return classifyWriteErr(err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrConflict // not found or already published
	}
	return nil
}

// DeleteAnnouncement removes a draft announcement. Published ones cannot be
// deleted (recipients already notified); returns ErrConflict in that case.
func (s *Store) DeleteAnnouncement(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_system_announcement WHERE id=$1 AND status='draft'`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrConflict
	}
	return nil
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
	case "all", "user_all":
		// Platform-scoped notification — visible to every user in every workspace.
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
	case "agency_all", "enterprise_all":
		// Broadcast to every org of the type — fan out one notification per org so
		// existing per-workspace visibility applies (covers orgs created so far).
		table, scope := "ky_agency", "agency"
		if a.TargetScope == "enterprise_all" {
			table, scope = "ky_enterprise", "enterprise"
		}
		ids, err := allOrgIDsTx(ctx, tx, table)
		if err != nil {
			return 0, err
		}
		for _, id := range ids {
			if err := createNotificationTx(ctx, tx, scope, id, "", a.Title, a.Content, "system"); err != nil {
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
