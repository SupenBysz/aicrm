package store

import (
	"context"
	"database/sql"
	d "github.com/Kysion/KyaiCRM/shared/branding"
)

func (s *Store) SavePlatformBrandAsset(ctx context.Context, content []byte) (string, error) {
	sum := d.Digest(content)
	id := "pba_" + sum
	_, err := s.db.ExecContext(ctx, `INSERT INTO ky_platform_brand_asset(id,digest,content) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING`, id, sum, content)
	return id, err
}
func (s *Store) PlatformBrandAsset(ctx context.Context, id string, public bool) ([]byte, error) {
	var raw []byte
	query := `SELECT content FROM ky_platform_brand_asset WHERE id=$1`
	if public {
		query += ` AND EXISTS(SELECT 1 FROM ky_platform_profile WHERE id='default' AND (brand_config->>'iconId'=$1 OR brand_config->>'wordmarkId'=$1))`
	}
	err := s.db.QueryRowContext(ctx, query, id).Scan(&raw)
	if err == sql.ErrNoRows {
		err = ErrNotFound
	}
	return raw, err
}
