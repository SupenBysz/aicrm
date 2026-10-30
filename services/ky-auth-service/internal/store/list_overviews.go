package store

import (
	"context"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"strings"
)

func (s *Store) LoginLogOverview(ctx context.Context, filter LoginLogFilter) (o.Result, error) {
	filter.Result = ""
	where, args := loginLogConditions(filter)
	query := `SELECT count(*),count(*) FILTER (WHERE result='success'),count(*) FILTER (WHERE result='failed'),
 count(DISTINCT NULLIF(btrim(login_account),'')) FILTER (WHERE result='failed'),
 count(*) FILTER (WHERE result IS NULL OR result NOT IN ('success','failed'))
 FROM ky_login_log WHERE ` + strings.Join(where, " AND ")
	return o.Count(ctx, s.db, query, args, "success", "failed", "failedAccounts", "unclassified")
}
