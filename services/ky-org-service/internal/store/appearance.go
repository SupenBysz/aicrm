package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/Kysion/KyaiCRM/shared/appearance"
)

func (s *Store) GetAppearance(ctx context.Context, id string) (appearance.Value, error) {
	v := appearance.Default()
	err := s.db.QueryRowContext(ctx, `SELECT schema_version,source,theme_id,mode,revision FROM ky_platform_appearance WHERE id=$1`, id).Scan(&v.SchemaVersion, &v.Source, &v.ThemeID, &v.Mode, &v.Revision)
	if err == sql.ErrNoRows {
		return v, nil
	}
	return v, err
}
func (s *Store) SaveAppearance(ctx context.Context, id, actor, request string, v appearance.Value) (appearance.Value, error) {
	if !v.Valid(false) {
		return v, appearance.ErrValidation
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	// Serialize both initial creation and subsequent compare-and-swap writes.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "ky_platform_appearance:"+id); err != nil {
		return v, err
	}
	current := appearance.Default()
	err = tx.QueryRowContext(ctx, `SELECT schema_version,source,theme_id,mode,revision FROM ky_platform_appearance WHERE id=$1 FOR UPDATE`, id).Scan(&current.SchemaVersion, &current.Source, &current.ThemeID, &current.Mode, &current.Revision)
	if err != nil && err != sql.ErrNoRows {
		return v, err
	}
	if current.Revision != v.Revision {
		return v, appearance.ErrConflict
	}
	v.Revision++
	_, err = tx.ExecContext(ctx, `INSERT INTO ky_platform_appearance(id,schema_version,source,theme_id,mode,revision) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(id) DO UPDATE SET schema_version=EXCLUDED.schema_version,source=EXCLUDED.source,theme_id=EXCLUDED.theme_id,mode=EXCLUDED.mode,revision=EXCLUDED.revision,updated_at=now()`, id, v.SchemaVersion, v.Source, v.ThemeID, v.Mode, v.Revision)
	if err != nil {
		return v, err
	}
	before, _ := json.Marshal(current)
	after, _ := json.Marshal(v)
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_platform_appearance_change(revision,actor_id,request_id,before_value,after_value) VALUES($1,$2,$3,$4,$5)`, v.Revision, actor, request, string(before), string(after)); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
