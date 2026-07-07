package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/store"
)

// splitCSV splits a comma-separated list, trimming spaces and dropping empties.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// searchPlatformUsers serves GET /api/v1/platform/users?keyword=&limit=.
// Platform-only, requires platform.members.view. Returns lightweight user options
// for selection pickers (e.g. announcement "指定用户" targeting). Gating mirrors
// loginLogs: requireAuth → platform workspace membership → permission check.
func (s *Server) searchPlatformUsers(w http.ResponseWriter, r *http.Request) {
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
		writeError(w, r, http.StatusForbidden, "workspace_forbidden", "用户检索仅平台后台可访问")
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
	allowed, err := s.store.HasAny(r.Context(), membershipID, []string{"platform.members.view"})
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
		return
	}
	if !allowed {
		writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权检索用户")
		return
	}

	q := r.URL.Query()
	var users []store.User
	if idsParam := strings.TrimSpace(q.Get("ids")); idsParam != "" {
		// Resolve a specific set of ids → names (used to render already-selected targets).
		users, err = s.store.UsersByIDs(r.Context(), splitCSV(idsParam))
	} else {
		users, err = s.store.SearchUsers(r.Context(), q.Get("keyword"), atoiDefaultLog(q.Get("limit"), 20))
	}
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "用户检索失败")
		return
	}
	items := make([]map[string]any, 0, len(users))
	for _, u := range users {
		items = append(items, map[string]any{
			"id":          u.ID,
			"displayName": u.DisplayName,
			"username":    u.Username,
			"email":       u.Email,
		})
	}
	writeJSON(w, map[string]any{
		"data":      map[string]any{"items": items},
		"requestId": requestID(r),
	})
}
