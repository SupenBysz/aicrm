package server

import (
	"database/sql"
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/auth"
)

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// changePassword serves POST /api/v1/auth/change-password for the current user.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	payload, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req changePasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.CurrentPassword == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "当前密码不能为空")
		return
	}
	if len(req.NewPassword) < 6 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "新密码至少 6 位")
		return
	}
	if req.CurrentPassword == req.NewPassword {
		writeError(w, r, http.StatusBadRequest, "validation_error", "新密码不能与当前密码相同")
		return
	}

	credential, err := s.store.FindPasswordCredentialByUserID(r.Context(), payload.UserID)
	if err != nil {
		if err == sql.ErrNoRows {
			writeError(w, r, http.StatusNotFound, "not_found", "当前账号没有可修改的登录密码凭据")
			return
		}
		writeError(w, r, http.StatusInternalServerError, "internal_error", "登录凭据查询失败")
		return
	}
	if credential.Status != "normal" || credential.User.Status != "normal" || !auth.VerifyPassword(credential.PasswordHash, req.CurrentPassword) {
		writeError(w, r, http.StatusUnauthorized, "invalid_current_password", "当前密码错误")
		return
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "密码处理失败")
		return
	}
	if err := s.store.ResetUserPassword(r.Context(), payload.UserID, hash); err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "修改密码失败")
		return
	}
	writeData(w, r, map[string]bool{"changed": true})
}
