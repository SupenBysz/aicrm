package store

import (
	"context"
	"database/sql"
	"errors"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
)

func (s *Store) SessionEntry(ctx context.Context, id string) (domainentry.Entry, error) {
	var e domainentry.Entry
	err := s.db.QueryRowContext(ctx, `SELECT hostname,binding_id,agency_id,generation FROM ky_auth_session_entry WHERE session_id=$1`, id).Scan(&e.Host, &e.BindingID, &e.AgencyID, &e.Generation)
	if errors.Is(err, sql.ErrNoRows) {
		return e, nil
	}
	return e, err
}
