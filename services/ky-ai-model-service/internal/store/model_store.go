package store

import (
	"context"
	"database/sql"
	"strings"
)

const modelColumns = `id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_at, updated_at`

func scanModel(row interface{ Scan(...any) error }) (Model, error) {
	var m Model
	var params []byte
	err := row.Scan(&m.ID, &m.ProviderID, &m.Name, &m.ModelKey, &m.ModelType, &m.ContextLength, &params, &m.Status, &m.Remark, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return Model{}, err
	}
	if len(params) == 0 {
		params = []byte("{}")
	}
	m.DefaultParameters = params
	return m, nil
}

func (s *Store) ListModels(ctx context.Context, providerID, modelType, status string, page, pageSize int) ([]Model, int64, error) {
	where := []string{"deleted_at IS NULL"}
	args := []any{}
	add := func(v any) string { args = append(args, v); return "$" + itoa(len(args)) }
	if providerID != "" {
		where = append(where, "provider_id="+add(providerID))
	}
	if modelType != "" {
		where = append(where, "model_type="+add(modelType))
	}
	if status != "" {
		where = append(where, "status="+add(status))
	}
	clause := strings.Join(where, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_model WHERE `+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(pageSize)
	offset := add((page - 1) * pageSize)
	rows, err := s.db.QueryContext(ctx, `SELECT `+modelColumns+` FROM ky_ai_model WHERE `+clause+` ORDER BY created_at DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Model{}
	for rows.Next() {
		m, err := scanModel(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, m)
	}
	return items, total, rows.Err()
}

func (s *Store) GetModel(ctx context.Context, id string) (Model, error) {
	m, err := scanModel(s.db.QueryRowContext(ctx, `SELECT `+modelColumns+` FROM ky_ai_model WHERE id=$1 AND deleted_at IS NULL`, id))
	if err == sql.ErrNoRows {
		return Model{}, ErrNotFound
	}
	return m, err
}

func (s *Store) CreateModel(ctx context.Context, m Model, createdBy string) error {
	params := m.DefaultParameters
	if len(params) == 0 {
		params = []byte("{}")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$10)
	`, m.ID, m.ProviderID, m.Name, m.ModelKey, m.ModelType, m.ContextLength, string(params), m.Status, m.Remark, createdBy)
	return classifyWriteErr(err)
}

func (s *Store) UpdateModel(ctx context.Context, id, name string, contextLength int, defaultParameters []byte, remark, updatedBy string) error {
	if len(defaultParameters) == 0 {
		defaultParameters = []byte("{}")
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_ai_model SET name=$2, context_length=$3, default_parameters=$4::jsonb, remark=$5, updated_by=$6, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL
	`, id, name, contextLength, string(defaultParameters), remark, updatedBy)
	if err != nil {
		return classifyWriteErr(err)
	}
	return affectedOrNotFound(res)
}

func (s *Store) UpdateModelStatus(ctx context.Context, id, status, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_ai_model SET status=$2, updated_by=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, id, status, updatedBy)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

// ModelForDefault returns (modelType, status) for validating a default-model setting.
func (s *Store) ModelForDefault(ctx context.Context, id string) (modelType, status string, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT model_type, status FROM ky_ai_model WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&modelType, &status)
	if err == sql.ErrNoRows {
		return "", "", ErrNotFound
	}
	return modelType, status, err
}
