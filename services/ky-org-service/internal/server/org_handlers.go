package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

func (s *Server) getCurrentOrg(w http.ResponseWriter, r *http.Request, wc wsContext) {
	c, err := s.store.GetCurrentOrganization(r.Context(), wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, c)
}

type currentOrgInput struct {
	Name         string `json:"name"`
	LogoURL      string `json:"logoUrl"`
	Description  string `json:"description"`
	ContactName  string `json:"contactName"`
	ContactPhone string `json:"contactPhone"`
	ContactEmail string `json:"contactEmail"`
}

func (s *Server) updateCurrentOrg(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in currentOrgInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	c := store.CurrentOrganization{
		Name: strings.TrimSpace(in.Name), LogoURL: in.LogoURL, Description: in.Description,
		ContactName: in.ContactName, ContactPhone: in.ContactPhone, ContactEmail: in.ContactEmail,
	}
	if err := s.store.UpdateCurrentOrganization(r.Context(), wc.WorkspaceType, wc.WorkspaceID, c, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "organization.updated", "organization", wc.WorkspaceID, nil)
	updated, err := s.store.GetCurrentOrganization(r.Context(), wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}
