package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) listPublicScripts(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, size := parsePage(r)
	items, pagination, err := s.store.ListPublicScripts(r.Context(), store.PublicScriptListParams{
		WorkspaceType: wc.WorkspaceType,
		WorkspaceID:   wc.WorkspaceID,
		Keyword:       strings.TrimSpace(r.URL.Query().Get("keyword")),
		Status:        strings.TrimSpace(r.URL.Query().Get("status")),
		Page:          page,
		PageSize:      size,
	})
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, pagination)
}

func (s *Server) getPublicScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetPublicScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) createPublicScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	var in store.PublicScriptInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.CreatePublicScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.UserID, key, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.public_script_created", "matrix_account_public_script", item.ID, map[string]any{"identifier": item.Identifier})
	writeData(w, r, item)
}

func (s *Server) updatePublicScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	revision, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var in store.PublicScriptInput
	if !decodeJSON(w, r, &in) {
		return
	}
	item, err := s.store.UpdatePublicScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, revision, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.public_script_updated", "matrix_account_public_script", item.ID, map[string]any{"expectedRevision": revision})
	writeData(w, r, item)
}

func (s *Server) updatePublicScriptStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	revision, ok := expectedRevision(r)
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
	item, err := s.store.UpdatePublicScriptStatus(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, revision, strings.TrimSpace(in.Status))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.public_script_status_changed", "matrix_account_public_script", item.ID, map[string]any{"status": item.Status, "expectedRevision": revision})
	writeData(w, r, item)
}

func (s *Server) deletePublicScript(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	revision, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	if err := s.store.DeletePublicScript(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, revision); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.public_script_deleted", "matrix_account_public_script", r.PathValue("id"), map[string]any{"expectedRevision": revision})
	writeData(w, r, map[string]string{"id": r.PathValue("id")})
}
