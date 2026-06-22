package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Qualification struct {
	ID                string          `json:"id"`
	TargetType        string          `json:"targetType"`
	TargetID          string          `json:"targetId"`
	QualificationType string          `json:"qualificationType"`
	Materials         json.RawMessage `json:"materials"`
	Status            string          `json:"status"`
	ReviewUserID      *string         `json:"reviewUserId"`
	ReviewedAt        *time.Time      `json:"reviewedAt"`
	ReviewRemark      string          `json:"reviewRemark"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

const qualificationColumns = `id, target_type, target_id, qualification_type, materials, status,
	review_user_id, reviewed_at, review_remark, created_at, updated_at`

func scanQualification(row interface{ Scan(...any) error }) (Qualification, error) {
	var q Qualification
	var reviewUser sql.NullString
	var reviewedAt sql.NullTime
	var materials []byte
	err := row.Scan(&q.ID, &q.TargetType, &q.TargetID, &q.QualificationType, &materials, &q.Status,
		&reviewUser, &reviewedAt, &q.ReviewRemark, &q.CreatedAt, &q.UpdatedAt)
	if err != nil {
		return Qualification{}, err
	}
	if len(materials) > 0 {
		q.Materials = json.RawMessage(materials)
	} else {
		q.Materials = json.RawMessage("[]")
	}
	q.ReviewUserID = nullToPtr(reviewUser)
	if reviewedAt.Valid {
		q.ReviewedAt = &reviewedAt.Time
	}
	return q, nil
}

func nullToPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func (s *Store) CreateQualification(ctx context.Context, q Qualification, createdBy string) error {
	materials := q.Materials
	if len(materials) == 0 {
		materials = json.RawMessage("[]")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_qualification (id, target_type, target_id, qualification_type, materials, status, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5::jsonb,'submitted',$6,$6)
	`, q.ID, q.TargetType, q.TargetID, q.QualificationType, string(materials), createdBy)
	return classifyWriteErr(err)
}

func (s *Store) ListQualifications(ctx context.Context, status string, page, pageSize int) ([]Qualification, int64, error) {
	where := []string{"1=1"}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_qualification WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+qualificationColumns+` FROM ky_qualification WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Qualification{}
	for rows.Next() {
		q, err := scanQualification(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, q)
	}
	return items, total, rows.Err()
}

// ListQualificationsByTarget lists qualifications submitted by a specific
// organization (agency/enterprise) workspace.
func (s *Store) ListQualificationsByTarget(ctx context.Context, targetType, targetID, status string, page, pageSize int) ([]Qualification, int64, error) {
	where := []string{"target_type=$1", "target_id=$2"}
	args := []any{targetType, targetID}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_qualification WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+qualificationColumns+` FROM ky_qualification WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Qualification{}
	for rows.Next() {
		q, err := scanQualification(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, q)
	}
	return items, total, rows.Err()
}

func (s *Store) GetQualification(ctx context.Context, id string) (Qualification, error) {
	q, err := scanQualification(s.db.QueryRowContext(ctx, `SELECT `+qualificationColumns+` FROM ky_qualification WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Qualification{}, ErrNotFound
	}
	return q, err
}

// ReviewQualification sets the status to approved/rejected for a submitted record.
func (s *Store) ReviewQualification(ctx context.Context, id, status, reviewUserID, remark string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_qualification
		SET status=$2, review_user_id=$3, reviewed_at=now(), review_remark=$4, updated_by=$3, updated_at=now()
		WHERE id=$1 AND status='submitted'
	`, id, status, reviewUserID, remark)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}
