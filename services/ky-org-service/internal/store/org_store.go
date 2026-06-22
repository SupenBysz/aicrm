package store

import (
	"context"
	"database/sql"
)

// CurrentOrganization represents the unified view returned for
// GET /api/v1/organizations/current.
type CurrentOrganization struct {
	ID            string `json:"id"`
	WorkspaceType string `json:"workspaceType"`
	Name          string `json:"name"`
	Code          string `json:"code"`
	LogoURL       string `json:"logoUrl"`
	Description   string `json:"description"`
	Status        string `json:"status"`
	ContactName   string `json:"contactName"`
	ContactPhone  string `json:"contactPhone"`
	ContactEmail  string `json:"contactEmail"`
}

func (s *Store) GetCurrentOrganization(ctx context.Context, wsType, wsID string) (CurrentOrganization, error) {
	var table string
	switch wsType {
	case "agency":
		table = "ky_agency"
	case "enterprise":
		table = "ky_enterprise"
	default:
		return CurrentOrganization{}, ErrNotFound
	}
	var c CurrentOrganization
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, code, logo_url, description, status, contact_name, contact_phone, contact_email
		FROM `+table+` WHERE id=$1 AND deleted_at IS NULL
	`, wsID).Scan(&c.ID, &c.Name, &c.Code, &c.LogoURL, &c.Description, &c.Status, &c.ContactName, &c.ContactPhone, &c.ContactEmail)
	if err == sql.ErrNoRows {
		return CurrentOrganization{}, ErrNotFound
	}
	if err != nil {
		return CurrentOrganization{}, err
	}
	c.WorkspaceType = wsType
	return c, nil
}

func (s *Store) UpdateCurrentOrganization(ctx context.Context, wsType, wsID string, c CurrentOrganization, updatedBy string) error {
	var table string
	switch wsType {
	case "agency":
		table = "ky_agency"
	case "enterprise":
		table = "ky_enterprise"
	default:
		return ErrNotFound
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE `+table+` SET name=$2, logo_url=$3, description=$4, contact_name=$5, contact_phone=$6, contact_email=$7, updated_by=$8, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL
	`, wsID, c.Name, c.LogoURL, c.Description, c.ContactName, c.ContactPhone, c.ContactEmail, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}
