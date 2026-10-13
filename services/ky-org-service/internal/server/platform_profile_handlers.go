package server

import (
	"net/http"
	"strings"
)

var platformLogoFontFamilies = map[string]struct{}{
	"system": {},
	"sans":   {},
	"serif":  {},
	"mono":   {},
}

var platformLogoFontWeights = map[int]struct{}{
	400: {}, 500: {}, 600: {}, 700: {},
}

func validPlatformLogoStyle(size, weight int, family string) bool {
	if size < 8 || size > 72 {
		return false
	}
	if _, ok := platformLogoFontFamilies[family]; !ok {
		return false
	}
	_, ok := platformLogoFontWeights[weight]
	return ok
}

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
	CompanyName         string  `json:"companyName"`
	BrandLogoTextLong   string  `json:"brandLogoTextLong"`
	BrandLogoTextShort  string  `json:"brandLogoTextShort"`
	LongLogoFontSize    *int    `json:"longLogoFontSize"`
	LongLogoFontFamily  *string `json:"longLogoFontFamily"`
	LongLogoFontWeight  *int    `json:"longLogoFontWeight"`
	ShortLogoFontSize   *int    `json:"shortLogoFontSize"`
	ShortLogoFontFamily *string `json:"shortLogoFontFamily"`
	ShortLogoFontWeight *int    `json:"shortLogoFontWeight"`
	ICPRecord           string  `json:"icpRecord"`
}

func (s *Server) updatePlatformProfile(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in platformProfileInput
	if !decodeJSON(w, r, &in) {
		return
	}
	current, err := s.store.GetPlatformProfile(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	longSize, longFamily, longWeight := current.LongLogoFontSize, current.LongLogoFontFamily, current.LongLogoFontWeight
	shortSize, shortFamily, shortWeight := current.ShortLogoFontSize, current.ShortLogoFontFamily, current.ShortLogoFontWeight
	if in.LongLogoFontSize != nil {
		longSize = *in.LongLogoFontSize
	}
	if in.LongLogoFontFamily != nil {
		longFamily = *in.LongLogoFontFamily
	}
	if in.LongLogoFontWeight != nil {
		longWeight = *in.LongLogoFontWeight
	}
	if in.ShortLogoFontSize != nil {
		shortSize = *in.ShortLogoFontSize
	}
	if in.ShortLogoFontFamily != nil {
		shortFamily = *in.ShortLogoFontFamily
	}
	if in.ShortLogoFontWeight != nil {
		shortWeight = *in.ShortLogoFontWeight
	}
	if !validPlatformLogoStyle(longSize, longWeight, longFamily) {
		writeError(w, r, http.StatusBadRequest, "invalid_logo_style", "长文字 LOGO 字体设置无效")
		return
	}
	if !validPlatformLogoStyle(shortSize, shortWeight, shortFamily) {
		writeError(w, r, http.StatusBadRequest, "invalid_logo_style", "短文字 LOGO 字体设置无效")
		return
	}
	if err := s.store.UpsertPlatformProfile(
		r.Context(),
		strings.TrimSpace(in.CompanyName),
		strings.TrimSpace(in.BrandLogoTextLong),
		strings.TrimSpace(in.BrandLogoTextShort),
		longSize,
		longFamily,
		longWeight,
		shortSize,
		shortFamily,
		shortWeight,
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
