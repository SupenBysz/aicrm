package server

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/matcher"
	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) listDouyinRuntimeCandidates(w http.ResponseWriter, r *http.Request, wc wsContext) {
	urlValue := strings.TrimSpace(r.URL.Query().Get("url"))
	if urlValue == "" || len(urlValue) > 2048 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少有效的 normalized URL")
		return
	}
	normalizedURL, err := matcher.Normalize(urlValue)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "URL 必须是有效的 HTTP/HTTPS 地址")
		return
	}
	runAt := strings.TrimSpace(r.URL.Query().Get("runAt"))
	if runAt != "" && !store.ValidDouyinScriptRunAtForRuntime(runAt) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "运行时机无效")
		return
	}
	identifier := strings.TrimSpace(r.URL.Query().Get("identifier"))
	if len(identifier) > 64 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "脚本标识符无效")
		return
	}
	items, err := s.store.ListDouyinRuntimeCandidates(r.Context(), wc.WorkspaceType, wc.WorkspaceID, normalizedURL, runAt, identifier)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

func scriptCommandKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	k := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if k == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "写操作必须提供 Idempotency-Key")
		return "", false
	}
	if len(k) > 200 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "幂等键无效")
		return "", false
	}
	return k, true
}
func expectedRevision(r *http.Request) (int, bool) {
	n, e := strconv.Atoi(strings.TrimSpace(r.Header.Get("X-KY-Expected-Revision")))
	return n, e == nil && n > 0
}
func (s *Server) listDouyinScripts(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, size := parsePage(r)
	items, p, err := s.store.ListDouyinScripts(r.Context(), store.DouyinScriptListParams{WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID, Keyword: strings.TrimSpace(r.URL.Query().Get("keyword")), Status: strings.TrimSpace(r.URL.Query().Get("status")), Page: page, PageSize: size})
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, p)
}
func (s *Server) createDouyinScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	var in store.DouyinScriptInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.CreateDouyinScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.UserID, key, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_script_created", "matrix_account_douyin_script", item.ID, map[string]any{"scriptId": item.ID, "runAt": item.RunAt, "priority": item.Priority})
	writeData(w, r, item)
}
func (s *Server) getDouyinScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetDouyinScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}
func (s *Server) updateDouyinScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var in store.DouyinScriptInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.UpdateDouyinScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, rev, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_script_updated", "matrix_account_douyin_script", item.ID, map[string]any{"expectedRevision": rev, "runAt": item.RunAt, "priority": item.Priority})
	writeData(w, r, item)
}
func (s *Server) updateDouyinScriptStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.UpdateDouyinScriptStatus(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, rev, strings.TrimSpace(in.Status))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_script_status_changed", "matrix_account_douyin_script", item.ID, map[string]any{"status": item.Status, "expectedRevision": rev})
	writeData(w, r, item)
}
func (s *Server) listDouyinScriptVersions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListDouyinScriptVersions(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}
func (s *Server) createDouyinScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	var in store.DouyinScriptVersionInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.CreateDouyinScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_script_version_created", "matrix_account_douyin_script", r.PathValue("id"), map[string]any{"versionId": item.ID, "contentSha256": item.ContentSHA256})
	writeData(w, r, item)
}
func (s *Server) getDouyinScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	content := false
	if r.URL.Query().Get("content") == "1" {
		ok, err := s.store.HasAny(r.Context(), wc.MembershipID, []string{"platform.matrix_account_douyin_scripts.content_view"})
		if err != nil || !ok {
			writeError(w, r, http.StatusForbidden, "permission_denied", "当前身份无权查看脚本源码")
			return
		}
		content = true
	}
	item, err := s.store.GetDouyinScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("versionId"), content)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}
func (s *Server) updateDouyinScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var in store.DouyinScriptVersionInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.UpdateDouyinScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("versionId"), wc.UserID, key, rev, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_script_version_updated", "matrix_account_douyin_script", r.PathValue("id"), map[string]any{"versionId": item.ID, "expectedRevision": rev})
	writeData(w, r, item)
}
func (s *Server) releaseDouyinScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.changeDouyinVersionState(w, r, wc, "release")
}
func (s *Server) activateDouyinScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.changeDouyinVersionState(w, r, wc, "activate")
}
func (s *Server) archiveDouyinScriptVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.changeDouyinVersionState(w, r, wc, "archive")
}
func (s *Server) changeDouyinVersionState(w http.ResponseWriter, r *http.Request, wc wsContext, action string) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var (
		item store.DouyinScriptVersion
		err  error
	)
	switch action {
	case "release":
		item, err = s.store.ReleaseDouyinScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("versionId"), wc.UserID, key, rev)
	case "activate":
		item, err = s.store.ActivateDouyinScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("versionId"), wc.UserID, key, rev)
	default:
		item, err = s.store.ArchiveDouyinScriptVersion(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), r.PathValue("versionId"), wc.UserID, key, rev)
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.douyin_script_version_"+action, "matrix_account_douyin_script", r.PathValue("id"), map[string]any{"versionId": item.ID, "expectedRevision": rev})
	writeData(w, r, item)
}
