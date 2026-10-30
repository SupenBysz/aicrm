package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) documentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/public/documents/{slug}", s.publicDocument)
	mux.HandleFunc("GET /api/v1/public/documents/{slug}/versions/{version}", s.publicDocument)
	mux.HandleFunc("GET /api/v1/public/document-links", s.publicDocumentLinks)
	mux.HandleFunc("GET /api/v1/platform/documents", s.documentWS("platform.documents.view", s.listDocuments))
	mux.HandleFunc("POST /api/v1/platform/documents", s.documentWS("platform.documents.create", s.createDocument))
	mux.HandleFunc("GET /api/v1/platform/documents/{id}", s.documentWS("platform.documents.view", s.getDocument))
	for _, action := range []string{"draft", "publish", "restore", "unpublish", "delete"} {
		method, perm := "POST", action
		if action == "draft" {
			method, perm = "PATCH", "update"
		}
		if action == "restore" {
			perm = "update"
		}
		path := "/api/v1/platform/documents/{id}/" + action
		if action == "delete" {
			method = "DELETE"
			path = "/api/v1/platform/documents/{id}"
		}
		mux.HandleFunc(method+" "+path, s.documentWS("platform.documents."+perm, func(w http.ResponseWriter, r *http.Request, wc wsContext) { s.changeDocument(w, r, wc, action) }))
	}
	mux.HandleFunc("GET /api/v1/platform/documents/{id}/versions", s.documentWS("platform.documents.view", s.documentVersions))
	mux.HandleFunc("GET /api/v1/platform/documents/{id}/versions/{version}", s.documentWS("platform.documents.view", s.documentVersion))
	mux.HandleFunc("GET /api/v1/platform/document-links", s.documentWS("platform.documents.view", s.documentBindings))
	mux.HandleFunc("PATCH /api/v1/platform/document-links", s.documentWS("platform.documents.bind", s.bindDocument))
}
func (s *Server) documentWS(permission string, next wsHandler) http.HandlerFunc {
	return s.ws("platform", []string{permission}, func(w http.ResponseWriter, r *http.Request, wc wsContext) {
		if wc.WorkspaceID != "platform_root" {
			writeError(w, r, 403, "workspace_forbidden", "仅平台根工作区可管理公开文档")
			return
		}
		next(w, r, wc)
	})
}
func documentBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 7*store.DocumentMaxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, r, 400, "validation_error", "文档请求格式错误或超过大小限制")
		return false
	}
	if dec.Decode(new(any)) != io.EOF {
		writeError(w, r, 400, "validation_error", "请求只能包含一个JSON对象")
		return false
	}
	return true
}
func positiveInt(raw string, fallback, max int) int {
	v, e := strconv.Atoi(raw)
	if e != nil || v < 1 {
		return fallback
	}
	if v > max {
		return max
	}
	return v
}
func (s *Server) listDocuments(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	items, p, e := s.store.Documents(r.Context(), q.Get("q"), q.Get("category"), q.Get("status"), positiveInt(q.Get("page"), 1, 1000000), positiveInt(q.Get("pageSize"), 20, 100))
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeList(w, r, items, p)
}
func (s *Server) getDocument(w http.ResponseWriter, r *http.Request, wc wsContext) {
	v, e := s.store.Document(r.Context(), r.PathValue("id"))
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, v)
}
func (s *Server) createDocument(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.DocumentInput
	if !documentBody(w, r, &in) {
		return
	}
	v, e := s.store.CreateDocument(r.Context(), newID("doc"), wc.UserID, in)
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	s.audit(r.Context(), r, wc, "document.created", "document", v.ID, nil)
	writeData(w, r, v)
}
func (s *Server) changeDocument(w http.ResponseWriter, r *http.Request, wc wsContext, action string) {
	var in store.DocumentInput
	if !documentBody(w, r, &in) {
		return
	}
	v, e := s.store.ChangeDocument(r.Context(), r.PathValue("id"), wc.UserID, action, in)
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	s.audit(r.Context(), r, wc, "document."+action, "document", v.ID, map[string]any{"version": v.Version})
	writeData(w, r, v)
}
func (s *Server) documentVersions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	v, e := s.store.DocumentVersions(r.Context(), r.PathValue("id"))
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, map[string]any{"items": v})
}
func (s *Server) documentVersion(w http.ResponseWriter, r *http.Request, wc wsContext) {
	n, e := strconv.Atoi(r.PathValue("version"))
	if e != nil || n < 1 {
		writeStoreError(w, r, store.ErrNotFound)
		return
	}
	v, e := s.store.DocumentVersion(r.Context(), r.PathValue("id"), n)
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, v)
}
func publicDocumentJSON(w http.ResponseWriter, r *http.Request, v any) {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	for _, candidate := range strings.Split(r.Header.Get("If-None-Match"), ",") {
		if strings.TrimSpace(candidate) == etag || strings.TrimSpace(candidate) == "*" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	writeData(w, r, v)
}
func (s *Server) publicDocument(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	version := 0
	if raw := r.PathValue("version"); raw != "" {
		v, e := strconv.Atoi(raw)
		if e != nil || v < 1 {
			writeStoreError(w, r, store.ErrNotFound)
			return
		}
		version = v
	}
	if s.store == nil {
		writeError(w, r, 503, "service_unavailable", "文档暂不可用")
		return
	}
	v, e := s.store.PublicDocument(r.Context(), r.PathValue("slug"), version)
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	publicDocumentJSON(w, r, v)
}
func (s *Server) publicDocumentLinks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.store == nil {
		writeError(w, r, 503, "service_unavailable", "文档入口暂不可用")
		return
	}
	v, e := s.store.PublicDocumentLinks(r.Context())
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	publicDocumentJSON(w, r, map[string]any{"items": v})
}
func (s *Server) documentBindings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	v, e := s.store.DocumentBindings(r.Context())
	if e != nil {
		writeStoreError(w, r, e)
		return
	}
	writeData(w, r, map[string]any{"items": v})
}
func (s *Server) bindDocument(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var b store.DocumentBinding
	if !documentBody(w, r, &b) {
		return
	}
	if b.Purpose != "privacy_policy" && b.Purpose != "terms_of_service" {
		writeStoreError(w, r, store.ErrValidation)
		return
	}
	if e := s.store.BindDocument(r.Context(), wc.UserID, b); e != nil {
		writeStoreError(w, r, e)
		return
	}
	s.audit(r.Context(), r, wc, "document.bound", "document_link", b.Purpose, map[string]any{"documentId": b.DocumentID})
	s.documentBindings(w, r, wc)
}
