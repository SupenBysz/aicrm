package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/auth"
)

// gateWorkspacePerms validates the caller's session + current workspace membership,
// then checks it holds any of the wanted permissions. Returns false (and writes the
// error) if not allowed. Used by user admin endpoints that the 用户管理 page calls
// across platform / agency / enterprise workspaces.
func (s *Server) gateWorkspacePerms(w http.ResponseWriter, r *http.Request, wanted []string) bool {
	payload, ok := s.requireAuth(w, r)
	if !ok {
		return false
	}
	wsType := r.Header.Get("X-KY-Workspace-Type")
	wsID := r.Header.Get("X-KY-Workspace-Id")
	if wsType == "" || wsID == "" {
		writeError(w, r, http.StatusBadRequest, "workspace_required", "缺少工作区 Header")
		return false
	}
	membershipID, err := s.store.ActiveMembershipID(r.Context(), payload.UserID, wsType, wsID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "工作区身份校验失败")
		return false
	}
	if membershipID == "" {
		writeError(w, r, http.StatusForbidden, "workspace_forbidden", "用户无当前工作区身份")
		return false
	}
	allowed, err := s.store.HasAny(r.Context(), membershipID, wanted)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
		return false
	}
	if !allowed {
		writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权执行该操作")
		return false
	}
	return true
}

type updateUserRequest struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
}

// updateUser serves PATCH /api/v1/platform/users/{id}.
func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	if !s.gateWorkspacePerms(w, r, []string{"platform.members.update", "agency.members.update", "enterprise.members.update"}) {
		return
	}
	id := r.PathValue("id")
	var req updateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 格式错误")
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "显示名不能为空")
		return
	}
	if err := s.store.UpdateUser(r.Context(), id, req.DisplayName, strings.TrimSpace(req.Email), strings.TrimSpace(req.Phone)); err != nil {
		if err == sql.ErrNoRows {
			writeError(w, r, http.StatusNotFound, "not_found", "用户不存在")
			return
		}
		writeError(w, r, http.StatusConflict, "conflict", "保存失败:邮箱或手机号可能已被占用")
		return
	}
	user, err := s.store.GetUserByID(r.Context(), id)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "查询失败")
		return
	}
	writeJSON(w, map[string]any{
		"data": map[string]any{
			"id": user.ID, "displayName": user.DisplayName, "email": user.Email, "phone": user.Phone,
		},
		"requestId": requestID(r),
	})
}

type resetPasswordRequest struct {
	NewPassword string `json:"newPassword"`
}

// resetUserPassword serves POST /api/v1/platform/users/{id}/reset-password.
func (s *Server) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	if !s.gateWorkspacePerms(w, r, []string{"platform.members.reset_password", "agency.members.reset_password", "enterprise.members.reset_password"}) {
		return
	}
	id := r.PathValue("id")
	var req resetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 格式错误")
		return
	}
	if len(req.NewPassword) < 6 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "新密码至少 6 位")
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "密码处理失败")
		return
	}
	if err := s.store.ResetUserPassword(r.Context(), id, hash); err != nil {
		if err == sql.ErrNoRows {
			writeError(w, r, http.StatusNotFound, "not_found", "该用户没有可重置的登录密码凭据")
			return
		}
		writeError(w, r, http.StatusInternalServerError, "internal_error", "重置失败")
		return
	}
	writeJSON(w, map[string]any{"data": map[string]any{"id": id, "reset": true}, "requestId": requestID(r)})
}
