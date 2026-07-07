package store

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// GetSettings returns all settings for a scope as setting_key -> raw jsonb value.
func (s *Store) GetSettings(ctx context.Context, scopeType, scopeID, section string) (map[string]json.RawMessage, error) {
	query := `SELECT setting_key, setting_value FROM ky_system_setting WHERE scope_type=$1 AND scope_id=$2`
	args := []any{scopeType, scopeID}
	if section != "" {
		query += ` AND setting_key=$3`
		args = append(args, section)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		if len(v) == 0 {
			v = []byte("null")
		}
		out[k] = json.RawMessage(v)
	}
	return out, rows.Err()
}

// UpsertSettings replaces the scope's settings with the provided set: keys absent
// from `settings` are deleted (so removals — including deleting all — persist), and
// the provided keys are inserted/updated.
func (s *Store) UpsertSettings(ctx context.Context, scopeType, scopeID string, settings map[string]json.RawMessage, updatedBy string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if len(settings) == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM ky_system_setting WHERE scope_type=$1 AND scope_id=$2`, scopeType, scopeID); err != nil {
			return err
		}
	} else {
		args := []any{scopeType, scopeID}
		placeholders := make([]string, 0, len(settings))
		for key := range settings {
			args = append(args, key)
			placeholders = append(placeholders, "$"+strconv.Itoa(len(args)))
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM ky_system_setting WHERE scope_type=$1 AND scope_id=$2 AND setting_key NOT IN (`+strings.Join(placeholders, ",")+`)`,
			args...); err != nil {
			return err
		}
	}

	for key, value := range settings {
		if len(value) == 0 {
			value = json.RawMessage("null")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_system_setting (id, scope_type, scope_id, setting_key, setting_value, updated_by)
			VALUES ($1,$2,$3,$4,$5::jsonb,$6)
			ON CONFLICT (scope_type, scope_id, setting_key)
			DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_by=EXCLUDED.updated_by, updated_at=now()
		`, "set_"+scopeType+"_"+scopeID+"_"+key, scopeType, scopeID, key, string(value), updatedBy); err != nil {
			return classifyWriteErr(err)
		}
	}
	return tx.Commit()
}
