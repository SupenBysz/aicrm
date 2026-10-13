package server

import (
	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
	"net/http"
	"strings"
)

func (s *Server) listPublicStyles(w http.ResponseWriter, r *http.Request, wc wsContext) {
	p, size := parsePage(r)
	items, page, err := s.store.ListPublicStyles(r.Context(), store.PublicStyleListParams{WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID, Platform: strings.TrimSpace(r.URL.Query().Get("platform")), Keyword: strings.TrimSpace(r.URL.Query().Get("keyword")), Status: strings.TrimSpace(r.URL.Query().Get("status")), Page: p, PageSize: size})
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, page)
}
func (s *Server) getPublicStyle(w http.ResponseWriter, r *http.Request, wc wsContext) {
	x, e := s.store.GetPublicStyle(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, x)
}
func (s *Server) createPublicStyle(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	var in store.PublicStyleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	x, e := s.store.CreatePublicStyle(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.UserID, key, in)
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.public_style_created", "ky_matrix_account_public_style", x.ID, map[string]any{"identifier": x.Identifier})
	writeData(w, r, x)
}
func (s *Server) updatePublicStyle(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	var in store.PublicStyleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	x, e := s.store.UpdatePublicStyle(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, rev, in)
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.public_style_updated", "ky_matrix_account_public_style", x.ID, map[string]any{"expectedRevision": rev})
	writeData(w, r, x)
}
func (s *Server) updatePublicStyleStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
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
	x, e := s.store.UpdatePublicStyleStatus(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, rev, strings.TrimSpace(in.Status))
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, x)
}
func (s *Server) deletePublicStyle(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key, ok := scriptCommandKey(w, r)
	if !ok {
		return
	}
	rev, ok := expectedRevision(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "缺少 expected revision")
		return
	}
	if e := s.store.DeletePublicStyle(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID, key, rev); e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, map[string]string{"id": r.PathValue("id")})
}
