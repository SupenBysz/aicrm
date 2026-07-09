package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	platform := strings.TrimSpace(r.URL.Query().Get("platform"))
	if platform != "" && !validOneOf(platform, "douyin", "kuaishou", "xiaohongshu") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "平台类型无效")
		return
	}
	loginStatus := strings.TrimSpace(r.URL.Query().Get("loginStatus"))
	if loginStatus != "" && !validOneOf(loginStatus, "not_logged_in", "login_pending", "online", "expired", "verify_required", "risk") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "登录状态无效")
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !validOneOf(status, "normal", "disabled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "账号状态无效")
		return
	}
	items, pagination, err := s.store.ListAccounts(r.Context(), store.ListAccountsParams{
		WorkspaceType: wc.WorkspaceType,
		WorkspaceID:   wc.WorkspaceID,
		Platform:      platform,
		Keyword:       strings.TrimSpace(r.URL.Query().Get("keyword")),
		LoginStatus:   loginStatus,
		Status:        status,
		Page:          page,
		PageSize:      pageSize,
	})
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, pagination)
}

func (s *Server) getAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetAccount(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.created", "matrix_account", item.ID, map[string]any{"platform": item.Platform})
	writeData(w, r, item)
}

func (s *Server) createAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.MatrixAccountInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !normalizeAccountInput(w, r, &in, true) {
		return
	}
	item, err := s.store.CreateAccount(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.UserID, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.updated", "matrix_account", item.ID, map[string]any{"platform": item.Platform})
	writeData(w, r, item)
}

func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.MatrixAccountInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !normalizeAccountInput(w, r, &in, false) {
		return
	}
	item, err := s.store.UpdateAccount(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) updateAccountStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validOneOf(in.Status, "normal", "disabled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "账号状态无效")
		return
	}
	if err := s.store.UpdateAccountStatus(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.status_changed", "matrix_account", r.PathValue("id"), map[string]any{"status": in.Status})
	writeData(w, r, map[string]string{"id": r.PathValue("id"), "status": in.Status})
}

func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if err := s.store.DeleteAccount(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.deleted", "matrix_account", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"deleted": true})
}

func (s *Server) createLoginTask(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		DeviceID string `json:"deviceId"`
		LoginURL string `json:"loginUrl"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	task, err := s.store.CreateLoginTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"), strings.TrimSpace(in.DeviceID), strings.TrimSpace(in.LoginURL))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_task_created", "matrix_account", r.PathValue("id"), map[string]any{"taskId": task.ID})
	writeData(w, r, task)
}

func (s *Server) getLoginTask(w http.ResponseWriter, r *http.Request, wc wsContext) {
	task, err := s.store.GetLoginTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("taskId"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, task)
}

func (s *Server) batchDisable(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	success := 0
	failures := []map[string]string{}
	for _, id := range in.IDs {
		if strings.TrimSpace(id) == "" {
			continue
		}
		if err := s.store.UpdateAccountStatus(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id, "disabled", wc.UserID); err != nil {
			failures = append(failures, map[string]string{"id": id, "reason": err.Error()})
			continue
		}
		success++
	}
	writeData(w, r, map[string]any{"success": success, "failed": len(failures), "failures": failures})
}

func (s *Server) batchCheck(w http.ResponseWriter, r *http.Request, _ wsContext) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	// Real login-state detection is executed by the Electron controlled browser.
	// This endpoint records the authoritative contract and returns an empty
	// failure summary until platform-specific detectors are added.
	writeData(w, r, map[string]any{"success": len(in.IDs), "failed": 0, "failures": []map[string]string{}})
}

func normalizeAccountInput(w http.ResponseWriter, r *http.Request, in *store.MatrixAccountInput, requirePlatform bool) bool {
	in.Platform = strings.TrimSpace(in.Platform)
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	in.PlatformUID = strings.TrimSpace(in.PlatformUID)
	in.Nickname = strings.TrimSpace(in.Nickname)
	in.HomeURL = strings.TrimSpace(in.HomeURL)
	in.OwnerMemberID = strings.TrimSpace(in.OwnerMemberID)
	in.DepartmentID = strings.TrimSpace(in.DepartmentID)
	in.TeamID = strings.TrimSpace(in.TeamID)
	in.Remark = strings.TrimSpace(in.Remark)
	if requirePlatform && !validOneOf(in.Platform, "douyin", "kuaishou", "xiaohongshu") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "平台类型无效")
		return false
	}
	if in.DisplayName == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请输入账号名称")
		return false
	}
	return true
}
