package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

func (s *Server) listQualifications(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	items, total, err := s.store.ListQualifications(r.Context(), r.URL.Query().Get("status"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) getQualification(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q, err := s.store.GetQualification(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, q)
}

// listMyQualifications returns the current organization's own qualifications.
func (s *Server) listMyQualifications(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	items, total, err := s.store.ListQualificationsByTarget(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.URL.Query().Get("status"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type qualificationSubmitInput struct {
	QualificationType string          `json:"qualificationType"`
	Materials         json.RawMessage `json:"materials"`
}

// submitQualification lets an organization submit its own qualification for the
// current (agency/enterprise) workspace; the platform then reviews it.
func (s *Server) submitQualification(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in qualificationSubmitInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.QualificationType = strings.TrimSpace(in.QualificationType)
	if in.QualificationType == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "qualificationType 不能为空")
		return
	}
	q := store.Qualification{
		ID: newID("qual"), TargetType: wc.WorkspaceType, TargetID: wc.WorkspaceID,
		QualificationType: in.QualificationType, Materials: in.Materials,
	}
	if err := s.store.CreateQualification(r.Context(), q, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "qualification.submitted", "qualification", q.ID, map[string]any{"targetType": q.TargetType})
	created, err := s.store.GetQualification(r.Context(), q.ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

type reviewInput struct {
	Remark string `json:"remark"`
}

func (s *Server) approveQualification(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in reviewInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.ReviewQualification(r.Context(), r.PathValue("id"), "approved", wc.UserID, in.Remark); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "qualification.approved", "qualification", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": "approved"})
}

func (s *Server) rejectQualification(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in reviewInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.ReviewQualification(r.Context(), r.PathValue("id"), "rejected", wc.UserID, in.Remark); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "qualification.rejected", "qualification", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": "rejected"})
}
