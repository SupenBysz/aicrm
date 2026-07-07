package server

import (
	"net/http"
	"strings"
)

// getPublicPlatformProfile serves GET /api/v1/public/platform-profile — no auth,
// read-only non-sensitive info for login page / footer.
func (s *Server) getPublicPlatformProfile(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
		return
	}
	p, err := s.store.GetPlatformProfile(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, p)
}

func (s *Server) getPlatformProfile(w http.ResponseWriter, r *http.Request, wc wsContext) {
	p, err := s.store.GetPlatformProfile(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, p)
}

type platformProfileInput struct {
	CompanyName        string `json:"companyName"`
	BrandLogoTextLong  string `json:"brandLogoTextLong"`
	BrandLogoTextShort string `json:"brandLogoTextShort"`
	ICPRecord          string `json:"icpRecord"`
}

func (s *Server) updatePlatformProfile(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in platformProfileInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.UpsertPlatformProfile(
		r.Context(),
		strings.TrimSpace(in.CompanyName),
		strings.TrimSpace(in.BrandLogoTextLong),
		strings.TrimSpace(in.BrandLogoTextShort),
		strings.TrimSpace(in.ICPRecord),
		wc.UserID,
	); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "platform_profile.updated", "platform_profile", "default", nil)
	p, err := s.store.GetPlatformProfile(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, p)
}
