package store

import (
	"context"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"strings"
)

func (s *Store) AccountOverview(ctx context.Context, params ListAccountsParams) (o.Result, error) {
	params.Status = ""
	params.LoginStatus = ""
	params.Attention = ""
	where, args := accountConditions(params)
	query := `SELECT count(*),count(*) FILTER (WHERE a.status='normal' AND a.login_status='online'),
 count(*) FILTER (WHERE a.status='normal' AND a.login_status IN ('expired','verify_required','risk','unknown')),
 count(*) FILTER (WHERE a.status='disabled'),
 count(*) FILTER (WHERE a.status NOT IN ('normal','disabled') OR (a.status='normal' AND a.login_status NOT IN ('online','expired','verify_required','risk','unknown','not_logged_in','login_pending')))
 FROM ky_matrix_account a WHERE ` + strings.Join(where, " AND ")
	return o.Count(ctx, s.db, query, args, "online", "attention", "disabled", "unclassified")
}
