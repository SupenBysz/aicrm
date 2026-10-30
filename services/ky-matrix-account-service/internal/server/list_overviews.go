package server

import (
	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"net/http"
	"strings"
)

func (s *Server) accountOverview(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	spec := map[string][]string{"keyword": nil, "platform": {"douyin", "kuaishou", "xiaohongshu"}, "status": {"normal", "disabled"}, "loginStatus": {"online", "expired", "verify_required", "risk", "unknown", "not_logged_in", "login_pending"}, "attention": {"required"}}
	if o.Validate(q, spec) != nil {
		writeError(w, r, 400, "validation_error", "概览查询条件无效")
		return
	}
	result, err := s.store.AccountOverview(r.Context(), store.ListAccountsParams{WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID, Platform: q.Get("platform"), Keyword: strings.TrimSpace(q.Get("keyword"))})
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "概览暂不可用")
		return
	}
	result.SetScope(q, "status", "loginStatus", "attention")
	writeData(w, r, result)
}
