package store

import (
	"context"
	"database/sql"
	"strings"
)

const providerColumns = `id, name, provider_type, base_url, api_key_encrypted, status, remark, created_at, updated_at`

func scanProvider(row interface{ Scan(...any) error }) (Provider, error) {
	var p Provider
	err := row.Scan(&p.ID, &p.Name, &p.ProviderType, &p.BaseURL, &p.APIKeyEncrypted, &p.Status, &p.Remark, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return Provider{}, err
	}
	p.HasAPIKey = p.APIKeyEncrypted != ""
	return p, nil
}

func (s *Store) ListProviders(ctx context.Context, status, providerType string, page, pageSize int) ([]Provider, int64, error) {
	where := []string{"deleted_at IS NULL"}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if status != "" {
		where = append(where, "status="+add(status))
	}
	if providerType != "" {
		where = append(where, "provider_type="+add(providerType))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_provider WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+providerColumns+` FROM ky_ai_provider WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Provider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, p)
	}
	return items, total, rows.Err()
}

func (s *Store) GetProvider(ctx context.Context, id string) (Provider, error) {
	p, err := scanProvider(s.db.QueryRowContext(ctx, `SELECT `+providerColumns+` FROM ky_ai_provider WHERE id=$1 AND deleted_at IS NULL`, id))
	if err == sql.ErrNoRows {
		return Provider{}, ErrNotFound
	}
	return p, err
}

func (s *Store) CreateProvider(ctx context.Context, p Provider, createdBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
	`, p.ID, p.Name, p.ProviderType, p.BaseURL, p.APIKeyEncrypted, p.Status, p.Remark, createdBy)
	return classifyWriteErr(err)
}

// UpdateProvider updates editable provider fields. When apiKeyEncrypted is empty
// the existing ciphertext is preserved.
func (s *Store) UpdateProvider(ctx context.Context, id, name, baseURL, remark, apiKeyEncrypted, updatedBy string) error {
	if apiKeyEncrypted == "" {
		res, err := s.db.ExecContext(ctx, `
			UPDATE ky_ai_provider SET name=$2, base_url=$3, remark=$4, updated_by=$5, updated_at=now()
			WHERE id=$1 AND deleted_at IS NULL
		`, id, name, baseURL, remark, updatedBy)
		if err != nil {
			return classifyWriteErr(err)
		}
		return affectedOrNotFound(res)
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_provider SET name=$2, base_url=$3, remark=$4, api_key_encrypted=$5, updated_by=$6, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL
	`, id, name, baseURL, remark, apiKeyEncrypted, updatedBy)
	if err != nil {
		return classifyWriteErr(err)
	}
	return affectedOrNotFound(res)
}

func (s *Store) UpdateProviderStatus(ctx context.Context, id, status, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_ai_provider SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func (s *Store) ProviderExists(ctx context.Context, id string) (bool, error) {
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_ai_provider WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ProviderEnabled reports whether the provider exists and is enabled.
func (s *Store) ProviderEnabled(ctx context.Context, id string) (bool, error) {
	var x int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM ky_ai_provider WHERE id=$1 AND status='enabled' AND deleted_at IS NULL`, id).Scan(&x)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// DisableProviderCascade disables a provider and, in the same transaction,
// disables all its non-deleted models and clears any platform default-model
// setting pointing at those models. Returns how many models were disabled and
// how many default settings were cleared. Provider missing -> ErrNotFound.
// Re-enabling a provider deliberately does NOT re-enable its models.
func (s *Store) DisableProviderCascade(ctx context.Context, providerID, updatedBy string) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	pres, err := tx.ExecContext(ctx, `UPDATE ky_ai_provider SET status='disabled', updated_by=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, providerID, updatedBy)
	if err != nil {
		return 0, 0, err
	}
	if n, _ := pres.RowsAffected(); n == 0 {
		return 0, 0, ErrNotFound
	}

	mres, err := tx.ExecContext(ctx, `UPDATE ky_ai_model SET status='disabled', updated_by=$2, updated_at=now() WHERE provider_id=$1 AND deleted_at IS NULL AND status<>'disabled'`, providerID, updatedBy)
	if err != nil {
		return 0, 0, err
	}
	modelsDisabled, _ := mres.RowsAffected()

	dres, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_model_setting SET model_id=NULL, updated_by=$3, updated_at=now()
		WHERE scope_type=$1 AND scope_id=$2 AND model_id IN (SELECT id FROM ky_ai_model WHERE provider_id=$4)
	`, platformScopeType, platformScopeID, updatedBy, providerID)
	if err != nil {
		return 0, 0, err
	}
	defaultsCleared, _ := dres.RowsAffected()

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return modelsDisabled, defaultsCleared, nil
}

// RotateProviderAPIKey replaces the provider's encrypted API key. Provider
// missing -> ErrNotFound.
func (s *Store) RotateProviderAPIKey(ctx context.Context, id, apiKeyEncrypted, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_ai_provider SET api_key_encrypted=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, apiKeyEncrypted, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}
