package server

import (
	"context"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"net/http"
	"strings"
)

func (s *Server) invitationVisibleInviters(ctx context.Context, wc wsContext) ([]string, error) {
	scope, err := s.store.ResolveMemberScope(ctx, wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if scope.Unrestricted {
		return nil, nil
	}
	return s.store.VisibleMembershipIDs(ctx, wc.WorkspaceType, wc.WorkspaceID, scope)
}
func (s *Server) memberOverview(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	if o.Validate(q, map[string][]string{"keyword": nil, "departmentId": nil, "teamId": nil, "status": {"active", "disabled", "invited", "left"}}) != nil {
		writeError(w, r, 400, "validation_error", "概览查询条件无效")
		return
	}
	scope, err := s.store.ResolveMemberScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "数据范围暂不可用")
		return
	}
	result, err := s.store.MemberOverview(r.Context(), wc.WorkspaceType, wc.WorkspaceID, strings.TrimSpace(q.Get("keyword")), q.Get("departmentId"), q.Get("teamId"), scope)
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "概览暂不可用")
		return
	}
	result.SetScope(q, "status")
	writeData(w, r, result)
}
func (s *Server) invitationOverview(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	states := []string{"pending", "accepted", "cancelled", "expired"}
	if o.Validate(q, map[string][]string{"status": states, "effectiveStatus": states}) != nil || (q.Has("status") && q.Has("effectiveStatus")) {
		writeError(w, r, 400, "validation_error", "概览查询条件无效")
		return
	}
	ids, err := s.invitationVisibleInviters(r.Context(), wc)
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "数据范围暂不可用")
		return
	}
	result, err := s.store.InvitationOverview(r.Context(), wc.WorkspaceType, wc.WorkspaceID, ids)
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "概览暂不可用")
		return
	}
	result.SetScope(q, "status", "effectiveStatus")
	writeData(w, r, result)
}
