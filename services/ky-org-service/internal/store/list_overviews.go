package store

import (
	"context"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"strings"
)

func (s *Store) AgencyOverview(ctx context.Context, keyword string) (o.Result, error) {
	where, args := agencyConditions(keyword, "")
	statement, keys := o.StatusSQL("ky_agency a", strings.Join(where, " AND "), "a.status", []string{"normal", "disabled", "frozen", "pending"})
	return o.Count(ctx, s.db, statement, args, keys...)
}
func (s *Store) EnterpriseOverview(ctx context.Context, keyword, agencyID, agencyScope string) (o.Result, error) {
	where, args := enterpriseConditions(keyword, "", agencyID, agencyScope)
	statement, keys := o.StatusSQL("ky_enterprise e", strings.Join(where, " AND "), "e.status", []string{"normal", "disabled", "frozen", "pending"})
	return o.Count(ctx, s.db, statement, args, keys...)
}
func (s *Store) QualificationOverview(ctx context.Context) (o.Result, error) {
	where, args := qualificationConditions("")
	statement, keys := o.StatusSQL("ky_qualification", strings.Join(where, " AND "), "status", []string{"submitted", "approved", "rejected"})
	return o.Count(ctx, s.db, statement, args, keys...)
}
