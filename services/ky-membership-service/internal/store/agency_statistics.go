package store

import (
	"context"
	"encoding/json"
	"errors"
	a "github.com/Kysion/KyaiCRM/shared/agencystats"
)

func (s *Store) AgencyStatistics(ctx context.Context, groups []a.Group) ([]a.Group, error) {
	if err := a.Validate(groups); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(groups)
	rows, err := s.db.QueryContext(ctx, `WITH groups AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS g(id text,"enterpriseOnly" boolean,enterprises jsonb)), members AS (
 SELECT g.id,m.user_id,bool_or(m.status IN ('active','disabled')) AS employed,bool_or(m.status='active' AND m.deleted_at IS NULL) AS online_eligible FROM groups g JOIN ky_membership m ON
 ((NOT COALESCE(g."enterpriseOnly",false) AND m.workspace_type='agency' AND m.workspace_id=g.id) OR (m.workspace_type='enterprise' AND g.enterprises ? m.workspace_id))
 WHERE m.status IN ('active','disabled','left') AND (m.deleted_at IS NULL OR m.status='left') GROUP BY g.id,m.user_id)
 SELECT id,user_id,employed,online_eligible FROM members LIMIT 5001`, raw)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	index := map[string]int{}
	for i := range groups {
		index[groups[i].ID] = i
		groups[i].Users = []string{}
		groups[i].Total = 0
		groups[i].Employed = 0
		groups[i].Left = 0
	}
	n := 0
	for rows.Next() {
		n++
		if n > a.MaxMappings {
			return nil, errors.New("statistics mapping budget exceeded")
		}
		var id, user string
		var employed, eligible bool
		if err = rows.Scan(&id, &user, &employed, &eligible); err != nil {
			return nil, err
		}
		g := &groups[index[id]]
		g.Total++
		if employed {
			g.Employed++
			if eligible {
				g.Users = append(g.Users, user)
			}
		} else {
			g.Left++
		}
	}
	return groups, rows.Err()
}
