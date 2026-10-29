package store

import (
	"context"
	"encoding/json"
	a "github.com/Kysion/KyaiCRM/shared/agencystats"
)

func (s *Store) AgencyStatisticGroups(ctx context.Context, ids []string) ([]a.Group, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT a.id,COALESCE(jsonb_agg(e.id) FILTER(WHERE e.id IS NOT NULL),'[]'::jsonb) FROM ky_agency a LEFT JOIN ky_enterprise e ON e.agency_id=a.id AND e.deleted_at IS NULL WHERE a.id=ANY($1) AND a.deleted_at IS NULL GROUP BY a.id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []a.Group{}
	for rows.Next() {
		var g a.Group
		var raw []byte
		if err = rows.Scan(&g.ID, &raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &g.Enterprises); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) EnterpriseStatisticGroups(ctx context.Context, ids []string) ([]a.Group, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM ky_enterprise WHERE id=ANY($1) AND deleted_at IS NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []a.Group{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, a.Group{ID: id, Enterprises: []string{id}, EnterpriseOnly: true})
	}
	return out, rows.Err()
}
