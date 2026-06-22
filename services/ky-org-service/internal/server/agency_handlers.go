package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

func (s *Server) listAgencies(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	items, total, err := s.store.ListAgencies(r.Context(), strings.TrimSpace(q.Get("keyword")), q.Get("status"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) getAgency(w http.ResponseWriter, r *http.Request, wc wsContext) {
	a, err := s.store.GetAgency(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, a)
}

type agencyInput struct {
	Name         string `json:"name"`
	Code         string `json:"code"`
	LogoURL      string `json:"logoUrl"`
	Description  string `json:"description"`
	ContactName  string `json:"contactName"`
	ContactPhone string `json:"contactPhone"`
	ContactEmail string `json:"contactEmail"`
}

func (s *Server) createAgency(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in agencyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.TrimSpace(in.Code)
	if in.Name == "" || in.Code == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 code 不能为空")
		return
	}
	a := store.Agency{
		ID: newID("agency"), Name: in.Name, Code: in.Code, LogoURL: in.LogoURL, Description: in.Description,
		Status: "normal", ContactName: in.ContactName, ContactPhone: in.ContactPhone, ContactEmail: in.ContactEmail,
	}
	if err := s.store.CreateAgency(r.Context(), a, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "agency.created", "agency", a.ID, map[string]any{"code": a.Code})
	created, err := s.store.GetAgency(r.Context(), a.ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

func (s *Server) updateAgency(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in agencyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	a := store.Agency{
		Name: strings.TrimSpace(in.Name), LogoURL: in.LogoURL, Description: in.Description,
		ContactName: in.ContactName, ContactPhone: in.ContactPhone, ContactEmail: in.ContactEmail,
	}
	if a.Name == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	if err := s.store.UpdateAgency(r.Context(), r.PathValue("id"), a, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "agency.updated", "agency", r.PathValue("id"), nil)
	updated, err := s.store.GetAgency(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

type statusInput struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

func (s *Server) updateAgencyStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in statusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validStatus(in.Status, "normal", "disabled", "frozen") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "status 非法")
		return
	}
	if err := s.store.UpdateAgencyStatus(r.Context(), r.PathValue("id"), in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "agency.status_changed", "agency", r.PathValue("id"), map[string]any{"status": in.Status})
	name := r.PathValue("id")
	if a, err := s.store.GetAgency(r.Context(), r.PathValue("id")); err == nil && a.Name != "" {
		name = a.Name
	}
	s.notifyOrgMembers(r.Context(), wc, "agency", r.PathValue("id"),
		"机构状态变更", "您所属的机构『"+name+"』状态已变更为："+in.Status, "organization")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status})
}
