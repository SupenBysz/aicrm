package server

import (
	"net/http"
	"strconv"
)

// loginLogs serves GET /api/v1/login-logs. Platform-only, requires
// platform.login_logs.view. Reuses requireAuth for token+session, then
// validates the platform workspace membership and permission.
func (s *Server) loginLogs(w http.ResponseWriter, r *http.Request) {
	payload, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	wsType := r.Header.Get("X-KY-Workspace-Type")
	wsID := r.Header.Get("X-KY-Workspace-Id")
	if wsType == "" || wsID == "" {
		writeError(w, r, http.StatusBadRequest, "workspace_required", "缺少工作区 Header")
		return
	}
	if wsType != "platform" {
		writeError(w, r, http.StatusForbidden, "workspace_forbidden", "登录日志仅平台后台可访问")
		return
	}
	membershipID, err := s.store.ActiveMembershipID(r.Context(), payload.UserID, wsType, wsID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "工作区身份校验失败")
		return
	}
	if membershipID == "" {
		writeError(w, r, http.StatusForbidden, "workspace_forbidden", "用户无当前工作区身份")
		return
	}
	allowed, err := s.store.HasAny(r.Context(), membershipID, []string{"platform.login_logs.view"})
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
		return
	}
	if !allowed {
		writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权查看登录日志")
		return
	}

	q := r.URL.Query()
	page := atoiDefaultLog(q.Get("page"), 1)
	if page < 1 {
		page = 1
	}
	pageSize := atoiDefaultLog(q.Get("pageSize"), 20)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	items, total, err := s.store.ListLoginLogs(r.Context(), q.Get("userId"), q.Get("result"), q.Get("startAt"), q.Get("endAt"), page, pageSize)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "登录日志查询失败")
		return
	}
	writeJSON(w, map[string]any{
		"data": map[string]any{
			"items":      items,
			"pagination": map[string]any{"page": page, "pageSize": pageSize, "total": total},
		},
		"requestId": requestID(r),
	})
}

func atoiDefaultLog(s string, def int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return v
}
