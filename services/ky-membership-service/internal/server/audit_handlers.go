package server

import (
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func (s *Server) listAuditLogs(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	platformGlobal := wc.WorkspaceType == "platform"

	// Data-scope restriction (Phase 1.13b): unrestricted callers see all (nil
	// filter); restricted callers see only audit by their visible members.
	scope, err := s.store.ResolveMemberScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围解析失败")
		return
	}
	var actorMembershipIDs []string // nil = unrestricted; non-nil (incl empty) = restricted
	if !scope.Unrestricted {
		// VisibleMembershipIDs always returns non-nil (possibly empty), so the
		// filter stays non-nil here and ListAuditLogs treats empty as "no rows".
		actorMembershipIDs, err = s.store.VisibleMembershipIDs(r.Context(), wc.WorkspaceType, wc.WorkspaceID, scope)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "可见成员解析失败")
			return
		}
	}

	items, total, err := s.store.ListAuditLogs(r.Context(), wc.WorkspaceType, wc.WorkspaceID, platformGlobal,
		q.Get("action"), q.Get("resourceType"), q.Get("actorUserId"), q.Get("startAt"), q.Get("endAt"), actorMembershipIDs, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}
