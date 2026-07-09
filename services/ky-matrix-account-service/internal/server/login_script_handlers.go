package server

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) resolveWebSpaceLoginScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.LoginScriptResolveInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeLoginScriptResolveInput(&in)
	if !validLoginScriptPurpose(in.Purpose) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本用途无效")
		return
	}
	result, err := s.store.ResolveLoginScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"), in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, result)
}

func (s *Server) generateWebSpaceLoginScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.LoginScriptGenerateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeLoginScriptGenerateInput(&in)
	if !validLoginScriptPurpose(in.Purpose) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本用途无效")
		return
	}
	if len(in.Snapshot) == 0 || len(in.Snapshot) > 2_500_000 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "页面快照无效")
		return
	}
	webSpace, err := s.store.GetWebSpace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	generated, err := s.generateLoginScriptWithAI(r.Context(), webSpace.Platform, in)
	if err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", err.Error())
		return
	}
	result, err := s.store.CreateGeneratedLoginScriptCandidate(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, webSpace.ID, in, generated)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_script_generated", "matrix_account_web_space", webSpace.ID, map[string]any{
		"scriptId":         result.Script.ID,
		"scriptVersionId":  result.Version.ID,
		"purpose":          in.Purpose,
		"modelId":          generated.ModelID,
		"usageSource":      generated.UsageSource,
		"promptTokens":     generated.PromptTokens,
		"completionTokens": generated.CompletionTokens,
		"totalTokens":      generated.TotalTokens,
	})
	writeData(w, r, result)
}

func (s *Server) submitWebSpaceLoginScriptRunResult(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.LoginScriptRunResultInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeLoginScriptRunResultInput(&in)
	if !validLoginScriptPurpose(in.Purpose) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本用途无效")
		return
	}
	if !validOneOf(in.Status, "success", "failed", "timeout", "cancelled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本运行状态无效")
		return
	}
	in.ResultSummary = sanitizeScriptRunSummary(in.ResultSummary)
	result, err := s.store.RecordLoginScriptRun(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"), in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_script_run_recorded", "matrix_account_web_space", r.PathValue("id"), map[string]any{
		"scriptId":        in.ScriptID,
		"scriptVersionId": in.ScriptVersionID,
		"purpose":         in.Purpose,
		"status":          in.Status,
		"errorCode":       in.ErrorCode,
		"durationMs":      in.DurationMs,
	})
	writeData(w, r, result)
}

func (s *Server) listWebSpaceLoginScriptRuns(w http.ResponseWriter, r *http.Request, wc wsContext) {
	limit := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	items, err := s.store.ListWebSpaceLoginScriptRuns(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"), limit)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

func (s *Server) listLoginScripts(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	platform := strings.TrimSpace(r.URL.Query().Get("platform"))
	purpose := strings.TrimSpace(r.URL.Query().Get("purpose"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if platform != "" && !validOneOf(platform, "douyin", "kuaishou", "xiaohongshu") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "平台类型无效")
		return
	}
	if purpose != "" && !validLoginScriptPurpose(purpose) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本用途无效")
		return
	}
	if status != "" && !validOneOf(status, "enabled", "disabled", "learning", "failed") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本状态无效")
		return
	}
	items, pagination, err := s.store.ListLoginScripts(r.Context(), store.LoginScriptListParams{
		WorkspaceType: wc.WorkspaceType,
		WorkspaceID:   wc.WorkspaceID,
		Platform:      platform,
		Purpose:       purpose,
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

func (s *Server) getLoginScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetLoginScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) listLoginScriptVersions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListLoginScriptVersions(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

func (s *Server) updateLoginScriptStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Status = strings.TrimSpace(in.Status)
	if !validOneOf(in.Status, "enabled", "disabled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本状态无效")
		return
	}
	item, err := s.store.UpdateLoginScriptStatus(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), in.Status, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_script_status_changed", "matrix_account_login_script", item.ID, map[string]any{
		"status": item.Status,
	})
	writeData(w, r, item)
}

func (s *Server) activateLoginScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.ActivateLoginScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("versionId"), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_script_version_activated", "matrix_account_login_script", r.PathValue("id"), map[string]any{
		"version": item.Version,
	})
	writeData(w, r, item)
}

func normalizeLoginScriptResolveInput(in *store.LoginScriptResolveInput) {
	in.Purpose = strings.TrimSpace(in.Purpose)
	in.PageFingerprint = strings.TrimSpace(in.PageFingerprint)
	in.URL = strings.TrimSpace(in.URL)
	in.ModelID = strings.TrimSpace(in.ModelID)
	if in.Purpose == "" {
		in.Purpose = "qr_login_prepare"
	}
}

func normalizeLoginScriptRunResultInput(in *store.LoginScriptRunResultInput) {
	in.ScriptID = strings.TrimSpace(in.ScriptID)
	in.ScriptVersionID = strings.TrimSpace(in.ScriptVersionID)
	in.Purpose = strings.TrimSpace(in.Purpose)
	in.Status = strings.TrimSpace(in.Status)
	in.ErrorCode = strings.TrimSpace(in.ErrorCode)
	in.ErrorMessage = strings.TrimSpace(in.ErrorMessage)
	if in.Purpose == "" {
		in.Purpose = "qr_login_prepare"
	}
	if in.Status == "" {
		in.Status = "failed"
	}
}

func normalizeLoginScriptGenerateInput(in *store.LoginScriptGenerateInput) {
	in.Purpose = strings.TrimSpace(in.Purpose)
	in.PageFingerprint = strings.TrimSpace(in.PageFingerprint)
	in.URL = strings.TrimSpace(in.URL)
	in.Title = strings.TrimSpace(in.Title)
	in.ModelID = strings.TrimSpace(in.ModelID)
	in.GenerationReason = strings.TrimSpace(in.GenerationReason)
	if in.Purpose == "" {
		in.Purpose = "qr_login_prepare"
	}
	if in.GenerationReason == "" {
		in.GenerationReason = defaultLoginScriptGenerationReason(in.Purpose)
	}
}

func validLoginScriptPurpose(value string) bool {
	return validOneOf(value, "qr_login_prepare", "qr_login_refresh", "account_detect", "session_check")
}

func defaultLoginScriptGenerationReason(purpose string) string {
	if purpose == "qr_login_refresh" {
		return "refresh_script_missing"
	}
	if purpose == "account_detect" {
		return "detect_script_missing"
	}
	return "no_active_script"
}

func sanitizeScriptRunSummary(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	out := map[string]any{}
	if _, ok := raw["qrCodeDataUrl"]; ok {
		out["hasQrCode"] = true
	}
	if candidate, ok := raw["accountCandidate"]; ok && candidate != nil {
		out["hasAccountCandidate"] = true
	}
	for _, key := range []string{"status", "errorCode", "durationMs"} {
		if value, ok := raw[key]; ok {
			out[key] = value
		}
	}
	return out
}
