package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("conflict")

const agencySelect = `SELECT a.id, a.name, a.code, a.logo_url, a.description, a.status,
	a.contact_name, a.contact_phone, a.contact_email,
	a.created_by, u.id, u.username, u.display_name, u.email, u.phone, u.status,
	(SELECT count(*) FROM ky_membership m WHERE m.workspace_type='agency' AND m.workspace_id=a.id AND m.deleted_at IS NULL),
	a.created_at, a.updated_at
	FROM ky_agency a LEFT JOIN ky_user u ON u.id = a.created_by`

func scanAgency(row interface{ Scan(...any) error }) (Agency, error) {
	var a Agency
	var createdBy, uid, uname, udisp, uemail, uphone, ustatus sql.NullString
	var memberCount int64
	err := row.Scan(&a.ID, &a.Name, &a.Code, &a.LogoURL, &a.Description, &a.Status,
		&a.ContactName, &a.ContactPhone, &a.ContactEmail,
		&createdBy, &uid, &uname, &udisp, &uemail, &uphone, &ustatus,
		&memberCount, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return Agency{}, err
	}
	a.CreatedBy = createdBy.String
	a.MemberCount = memberCount
	a.Creator = userBriefFrom(uid, uname, udisp, uemail, uphone, ustatus)
	return a, nil
}

func userBriefFrom(uid, uname, udisp, uemail, uphone, ustatus sql.NullString) *UserBrief {
	if !uid.Valid {
		return nil
	}
	return &UserBrief{
		ID: uid.String, Username: uname.String, DisplayName: udisp.String,
		Email: uemail.String, Phone: uphone.String, Status: ustatus.String,
	}
}

func (s *Store) ListAgencies(ctx context.Context, keyword, status string, page, pageSize int) ([]Agency, int64, error) {
	where := []string{"a.deleted_at IS NULL"}
	args := []any{}
	if keyword != "" {
		args = append(args, "%"+keyword+"%")
		where = append(where, "(a.name ILIKE $1 OR a.code ILIKE $1)")
	}
	if status != "" {
		args = append(args, status)
		where = append(where, "a.status = $"+itoa(len(args)))
	}
	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_agency a WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.QueryContext(ctx, agencySelect+` WHERE `+clause+
		` ORDER BY a.created_at DESC LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Agency{}
	for rows.Next() {
		a, err := scanAgency(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, a)
	}
	return items, total, rows.Err()
}

func (s *Store) GetAgency(ctx context.Context, id string) (Agency, error) {
	a, err := scanAgency(s.db.QueryRowContext(ctx, agencySelect+` WHERE a.id = $1 AND a.deleted_at IS NULL`, id))
	if err == sql.ErrNoRows {
		return Agency{}, ErrNotFound
	}
	return a, err
}

func (s *Store) CreateAgency(ctx context.Context, a Agency, createdBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_agency (id, name, code, logo_url, description, status, contact_name, contact_phone, contact_email, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
	`, a.ID, a.Name, a.Code, a.LogoURL, a.Description, a.Status, a.ContactName, a.ContactPhone, a.ContactEmail, createdBy)
	return classifyWriteErr(err)
}

func (s *Store) UpdateAgency(ctx context.Context, id string, a Agency, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_agency SET name=$2, logo_url=$3, description=$4, contact_name=$5, contact_phone=$6, contact_email=$7,
		       updated_by=$8, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL
	`, id, a.Name, a.LogoURL, a.Description, a.ContactName, a.ContactPhone, a.ContactEmail, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) UpdateAgencyStatus(ctx context.Context, id, status, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_agency SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}
