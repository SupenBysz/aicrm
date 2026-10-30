package store

import (
	"context"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"strings"
	"time"
)

func (s *Store) MemberOverview(ctx context.Context, wsType, wsID, keyword, departmentID, teamID string, scope ScopeFilter) (o.Result, error) {
	where, args := memberConditions(wsType, wsID, keyword, departmentID, teamID, "", scope)
	statement, keys := o.StatusSQL("ky_membership m JOIN ky_user u ON u.id=m.user_id", strings.Join(where, " AND "), "m.status", []string{"active", "disabled", "invited", "left"})
	return o.Count(ctx, s.db, statement, args, keys...)
}
func (s *Store) InvitationOverview(ctx context.Context, wsType, wsID string, inviterIDs []string) (o.Result, error) {
	where, args := invitationConditions(wsType, wsID, "", inviterIDs)
	asOf := time.Now().UTC()
	args = append(args, asOf)
	source := "(SELECT CASE WHEN status='pending' AND expires_at<=$" + itoa(len(args)) + " THEN 'expired' ELSE status END AS effective_status FROM ky_invitation WHERE " + strings.Join(where, " AND ") + ") i"
	statement, keys := o.StatusSQL(source, "true", "effective_status", []string{"pending", "accepted", "expired", "cancelled"})
	r, err := o.Count(ctx, s.db, statement, args, keys...)
	r.AsOf = asOf
	return r, err
}
