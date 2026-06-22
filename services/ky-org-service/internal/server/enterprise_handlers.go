package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

type enterpriseInput struct {
	AgencyID     string `json:"agencyId"`
	Name         string `json:"name"`
	Code         string `json:"code"`
	LogoURL      string `json:"logoUrl"`
	Description  string `json:"description"`
	ContactName  string `json:"contactName"`
	ContactPhone string `json:"contactPhone"`
	ContactEmail string `json:"contactEmail"`
}

// --- platform enterprise handlers ---

func (s *Server) listEnterprises(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	items, total, err := s.store.ListEnterprises(r.Context(), strings.TrimSpace(q.Get("keyword")), q.Get("status"), q.Get("agencyId"), "", page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) getEnterprise(w http.ResponseWriter, r *http.Request, wc wsContext) {
	e, err := s.store.GetEnterprise(r.Context(), r.PathValue("id"), "")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, e)
}

func (s *Server) createEnterprise(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in enterpriseInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.TrimSpace(in.Code)
	if in.Name == "" || in.Code == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 code 不能为空")
		return
	}
	e := store.Enterprise{
		ID: newID("enterprise"), AgencyID: strPtr(in.AgencyID), Name: in.Name, Code: in.Code,
		LogoURL: in.LogoURL, Description: in.Description, Status: "normal",
		ContactName: in.ContactName, ContactPhone: in.ContactPhone, ContactEmail: in.ContactEmail,
	}
	if err := s.store.CreateEnterprise(r.Context(), e, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "enterprise.created", "enterprise", e.ID, map[string]any{"code": e.Code})
	created, err := s.store.GetEnterprise(r.Context(), e.ID, "")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

func (s *Server) updateEnterprise(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.updateEnterpriseScoped(w, r, wc, "")
}

func (s *Server) updateEnterpriseScoped(w http.ResponseWriter, r *http.Request, wc wsContext, agencyScope string) {
	var in enterpriseInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	e := store.Enterprise{
		Name: strings.TrimSpace(in.Name), LogoURL: in.LogoURL, Description: in.Description,
		ContactName: in.ContactName, ContactPhone: in.ContactPhone, ContactEmail: in.ContactEmail,
	}
	if err := s.store.UpdateEnterprise(r.Context(), r.PathValue("id"), e, agencyScope, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "enterprise.updated", "enterprise", r.PathValue("id"), nil)
	updated, err := s.store.GetEnterprise(r.Context(), r.PathValue("id"), agencyScope)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

type assignAgencyInput struct {
	AgencyID string `json:"agencyId"`
}

func (s *Server) assignEnterpriseAgency(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in assignAgencyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.AssignEnterpriseAgency(r.Context(), r.PathValue("id"), strPtr(in.AgencyID), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "enterprise.agency_assigned", "enterprise", r.PathValue("id"), map[string]any{"agencyId": in.AgencyID})
	updated, err := s.store.GetEnterprise(r.Context(), r.PathValue("id"), "")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

func (s *Server) updateEnterpriseStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in statusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validStatus(in.Status, "normal", "disabled", "frozen") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "status 非法")
		return
	}
	if err := s.store.UpdateEnterpriseStatus(r.Context(), r.PathValue("id"), in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "enterprise.status_changed", "enterprise", r.PathValue("id"), map[string]any{"status": in.Status})
	name := r.PathValue("id")
	if e, err := s.store.GetEnterprise(r.Context(), r.PathValue("id"), ""); err == nil && e.Name != "" {
		name = e.Name
	}
	s.notifyOrgMembers(r.Context(), wc, "enterprise", r.PathValue("id"),
		"企业状态变更", "您所属的企业『"+name+"』状态已变更为："+in.Status, "organization")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status})
}

// --- agency-scoped enterprise handlers ---

func (s *Server) listAgencyEnterprises(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	items, total, err := s.store.ListEnterprises(r.Context(), strings.TrimSpace(q.Get("keyword")), q.Get("status"), "", wc.WorkspaceID, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) getAgencyEnterprise(w http.ResponseWriter, r *http.Request, wc wsContext) {
	e, err := s.store.GetEnterprise(r.Context(), r.PathValue("id"), wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, e)
}

func (s *Server) createAgencyEnterprise(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in enterpriseInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.TrimSpace(in.Code)
	if in.Name == "" || in.Code == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 code 不能为空")
		return
	}
	agencyID := wc.WorkspaceID
	e := store.Enterprise{
		ID: newID("enterprise"), AgencyID: &agencyID, Name: in.Name, Code: in.Code,
		LogoURL: in.LogoURL, Description: in.Description, Status: "normal",
		ContactName: in.ContactName, ContactPhone: in.ContactPhone, ContactEmail: in.ContactEmail,
	}
	if err := s.store.CreateEnterprise(r.Context(), e, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "agency_enterprise.created", "enterprise", e.ID, map[string]any{"code": e.Code})
	created, err := s.store.GetEnterprise(r.Context(), e.ID, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

func (s *Server) updateAgencyEnterprise(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.updateEnterpriseScoped(w, r, wc, wc.WorkspaceID)
}
