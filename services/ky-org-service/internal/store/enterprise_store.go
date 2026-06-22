package store

import (
	"context"
	"database/sql"
	"strings"
)

const enterpriseSelect = `SELECT e.id, e.agency_id, e.name, e.code, e.logo_url, e.description, e.status,
	e.contact_name, e.contact_phone, e.contact_email,
	e.created_by, u.id, u.username, u.display_name, u.email, u.phone, u.status,
	(SELECT count(*) FROM ky_membership m WHERE m.workspace_type='enterprise' AND m.workspace_id=e.id AND m.deleted_at IS NULL),
	e.created_at, e.updated_at
	FROM ky_enterprise e LEFT JOIN ky_user u ON u.id = e.created_by`

func scanEnterprise(row interface{ Scan(...any) error }) (Enterprise, error) {
	var e Enterprise
	var createdBy, uid, uname, udisp, uemail, uphone, ustatus sql.NullString
	var memberCount int64
	err := row.Scan(&e.ID, &e.AgencyID, &e.Name, &e.Code, &e.LogoURL, &e.Description, &e.Status,
		&e.ContactName, &e.ContactPhone, &e.ContactEmail,
		&createdBy, &uid, &uname, &udisp, &uemail, &uphone, &ustatus,
		&memberCount, &e.CreatedAt, &e.UpdatedAt)
	if err != nil {
		return Enterprise{}, err
	}
	e.CreatedBy = createdBy.String
	e.MemberCount = memberCount
	e.Creator = userBriefFrom(uid, uname, udisp, uemail, uphone, ustatus)
	return e, nil
}

// ListEnterprises lists enterprises. When agencyScope is non-empty, results are
// limited to enterprises owned by that agency (used for the agency backend).
func (s *Store) ListEnterprises(ctx context.Context, keyword, status, agencyID, agencyScope string, page, pageSize int) ([]Enterprise, int64, error) {
	where := []string{"e.deleted_at IS NULL"}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }

	if keyword != "" {
		p := add("%" + keyword + "%")
		where = append(where, "(e.name ILIKE "+p+" OR e.code ILIKE "+p+")")
	}
	if status != "" {
		where = append(where, "e.status = "+add(status))
	}
	if agencyScope != "" {
		where = append(where, "e.agency_id = "+add(agencyScope))
	} else if agencyID != "" {
		where = append(where, "e.agency_id = "+add(agencyID))
	}
	clause := strings.Join(where, " AND ")

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_enterprise e WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, enterpriseSelect+` WHERE `+clause+
		` ORDER BY e.created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Enterprise{}
	for rows.Next() {
		e, err := scanEnterprise(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, e)
	}
	return items, total, rows.Err()
}

// GetEnterprise returns an enterprise. When agencyScope is non-empty, the
// enterprise must belong to that agency or ErrNotFound is returned.
func (s *Store) GetEnterprise(ctx context.Context, id, agencyScope string) (Enterprise, error) {
	query := enterpriseSelect + ` WHERE e.id = $1 AND e.deleted_at IS NULL`
	args := []any{id}
	if agencyScope != "" {
		query += ` AND e.agency_id = $2`
		args = append(args, agencyScope)
	}
	e, err := scanEnterprise(s.db.QueryRowContext(ctx, query, args...))
	if err == sql.ErrNoRows {
		return Enterprise{}, ErrNotFound
	}
	return e, err
}

func (s *Store) CreateEnterprise(ctx context.Context, e Enterprise, createdBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_enterprise (id, agency_id, name, code, logo_url, description, status, contact_name, contact_phone, contact_email, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
	`, e.ID, e.AgencyID, e.Name, e.Code, e.LogoURL, e.Description, e.Status, e.ContactName, e.ContactPhone, e.ContactEmail, createdBy)
	if err != nil {
		return classifyWriteErr(err)
	}
	if e.AgencyID != nil {
		if err := upsertOwnerRelation(ctx, tx, *e.AgencyID, e.ID, createdBy); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) UpdateEnterprise(ctx context.Context, id string, e Enterprise, agencyScope, updatedBy string) error {
	query := `UPDATE ky_enterprise SET name=$2, logo_url=$3, description=$4, contact_name=$5, contact_phone=$6, contact_email=$7,
		       updated_by=$8, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`
	args := []any{id, e.Name, e.LogoURL, e.Description, e.ContactName, e.ContactPhone, e.ContactEmail, updatedBy}
	if agencyScope != "" {
		query += ` AND agency_id = $9`
		args = append(args, agencyScope)
	}
	res, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) UpdateEnterpriseStatus(ctx context.Context, id, status, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_enterprise SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) AssignEnterpriseAgency(ctx context.Context, id string, agencyID *string, updatedBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `UPDATE ky_enterprise SET agency_id=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, agencyID, updatedBy)
	if err != nil {
		return err
	}
	if err := affectedOrNotFound(res); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ky_agency_enterprise_relation SET status='ended', ended_at=now(), updated_at=now() WHERE enterprise_id=$1 AND relation_type='owner' AND status<>'ended'`, id); err != nil {
		return err
	}
	if agencyID != nil {
		if err := upsertOwnerRelation(ctx, tx, *agencyID, id, updatedBy); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func upsertOwnerRelation(ctx context.Context, tx *sql.Tx, agencyID, enterpriseID, createdBy string) error {
	id := "aer_" + agencyID + "_" + enterpriseID
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_agency_enterprise_relation (id, agency_id, enterprise_id, relation_type, status, started_at, created_by)
		VALUES ($1,$2,$3,'owner','normal',now(),$4)
		ON CONFLICT (id)
		DO UPDATE SET status='normal', ended_at=NULL, updated_at=now()
	`, id, agencyID, enterpriseID, createdBy)
	return classifyWriteErr(err)
}
