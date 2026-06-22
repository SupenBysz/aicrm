package store

import "context"

type DictionaryItem struct {
	Label     string `json:"label"`
	Value     string `json:"value"`
	SortOrder int    `json:"sortOrder"`
	Status    string `json:"status"`
}

type Dictionary struct {
	ID     string           `json:"id"`
	Code   string           `json:"code"`
	Name   string           `json:"name"`
	Status string           `json:"status"`
	Items  []DictionaryItem `json:"items"`
}

// ListDictionaries returns platform dictionaries with their items.
func (s *Store) ListDictionaries(ctx context.Context, code string) ([]Dictionary, error) {
	query := `SELECT id, code, name, status FROM ky_dictionary WHERE scope_type='platform' AND scope_id='platform_root'`
	args := []any{}
	if code != "" {
		query += ` AND code=$1`
		args = append(args, code)
	}
	query += ` ORDER BY code`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	dicts := []Dictionary{}
	for rows.Next() {
		var d Dictionary
		if err := rows.Scan(&d.ID, &d.Code, &d.Name, &d.Status); err != nil {
			return nil, err
		}
		d.Items = []DictionaryItem{}
		dicts = append(dicts, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range dicts {
		items, err := s.dictionaryItems(ctx, dicts[i].ID)
		if err != nil {
			return nil, err
		}
		dicts[i].Items = items
	}
	return dicts, nil
}

func (s *Store) dictionaryItems(ctx context.Context, dictionaryID string) ([]DictionaryItem, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT label, value, sort_order, status FROM ky_dictionary_item
		WHERE dictionary_id=$1 ORDER BY sort_order
	`, dictionaryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []DictionaryItem{}
	for rows.Next() {
		var it DictionaryItem
		if err := rows.Scan(&it.Label, &it.Value, &it.SortOrder, &it.Status); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, rows.Err()
}
