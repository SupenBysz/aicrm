package server

import (
	"encoding/base64"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
	d "github.com/Kysion/KyaiCRM/shared/branding"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"net/http"
	"os"
	"strings"
)

func brandPublicBase() string {
	return strings.TrimRight(os.Getenv("KY_BRAND_PUBLIC_URL"), "/")
}
func (s *Server) getAgencyBrand(w http.ResponseWriter, r *http.Request, wc wsContext) {
	agency, err := s.store.GetAgency(r.Context(), r.PathValue("id"))
	if err != nil || agency.Status != "normal" {
		writeError(w, r, 403, "agency_unavailable", "机构不可用")
		return
	}
	b, err := s.store.AgencyBranding(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, b)
}
func (s *Server) saveAgencyBrand(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		ExpectedRevision int64            `json:"expectedRevision"`
		Draft            store.BrandDraft `json:"draft"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	if !decodeJSON(w, r, &in) {
		return
	}
	before, err := s.store.AgencyBranding(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	changed := []string{}
	if before.Draft.ShowAIIcon != in.Draft.ShowAIIcon {
		changed = append(changed, "showAiIcon")
	}
	for field, pair := range map[string][2]string{"name": {before.Draft.Name, in.Draft.Name}, "applicationName": {before.Draft.ApplicationName, in.Draft.ApplicationName}, "iconText": {before.Draft.IconText, strings.TrimSpace(in.Draft.IconText)}, "copyrightHolder": {before.Draft.CopyrightHolder, strings.TrimSpace(in.Draft.CopyrightHolder)}, "copyrightStyle": {before.Draft.CopyrightStyle, in.Draft.CopyrightStyle}, "iconId": {before.Draft.IconID, in.Draft.IconID}, "wordmarkId": {before.Draft.WordmarkID, in.Draft.WordmarkID}, "wordmarkDarkId": {before.Draft.WordmarkDarkID, in.Draft.WordmarkDarkID}} {
		if pair[0] != pair[1] {
			changed = append(changed, field)
		}
	}
	if err := s.store.SaveBrandDraft(r.Context(), r.PathValue("id"), wc.UserID, in.ExpectedRevision, in.Draft); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "agency.branding.saved", "agency", r.PathValue("id"), map[string]any{"expectedRevision": in.ExpectedRevision, "changedFields": changed})
	s.getAgencyBrand(w, r, wc)
}
func (s *Server) publishAgencyBrand(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		ExpectedRevision int64 `json:"expectedRevision"`
		RollbackVersion  int64 `json:"rollbackVersion"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if !decodeJSON(w, r, &in) {
		return
	}
	base := brandPublicBase()
	if base != "" && !strings.HasPrefix(base, "https://") {
		writeError(w, r, 503, "configuration_missing", "发布域名尚未配置")
		return
	}
	b, err := s.store.PublishBrand(r.Context(), r.PathValue("id"), wc.UserID, base, in.ExpectedRevision, in.RollbackVersion)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "agency.branding.published", "agency", r.PathValue("id"), map[string]any{"version": b.PublishedVersion, "rollbackVersion": in.RollbackVersion})
	writeData(w, r, b)
}
func (s *Server) uploadBrandAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		Kind string `json:"kind"`
		PNG  string `json:"pngBase64"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Kind != "icon" && in.Kind != "wordmark" {
		writeError(w, r, 400, "validation_error", "请选择图标或文字LOGO")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(in.PNG)
	if err != nil {
		writeError(w, r, 400, "validation_error", "图片编码无效")
		return
	}
	normalized, err := d.NormalizePNG(raw, in.Kind == "icon")
	if err != nil {
		writeError(w, r, 400, "validation_error", "PNG图片无效或尺寸超限")
		return
	}
	format := "png"

	a, err := s.store.SaveBrandAsset(r.Context(), r.PathValue("id"), format, normalized)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, a)
}

// Immutable logos contain no business data. Only exact asset IDs are served; no listing.
func (s *Server) publicBrandAsset(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, 503, "service_unavailable", "资源服务未就绪")
		return
	}
	a, err := s.store.PublicBrandAsset(r.Context(), r.PathValue("assetId"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if a.Format == "png" {
		w.Header().Set("Content-Type", "image/png")
	} else {
		w.Header().Set("Content-Type", "image/x-icon")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public,max-age=31536000,immutable")
	w.Header().Set("ETag", `"`+a.Digest+`"`)
	if r.Header.Get("If-None-Match") == `"`+a.Digest+`"` {
		w.WriteHeader(304)
		return
	}
	_, _ = w.Write(a.Content)
}

// Branding is presentation data scoped to the authenticated current workspace.
func (s *Server) currentWorkspaceBrand(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var brand *d.Brand
	var err error
	if wc.WorkspaceType == "enterprise" {
		_, brand, err = s.store.EnterpriseBrand(r.Context(), wc.WorkspaceID)
	} else {
		agency, e := s.store.GetAgency(r.Context(), wc.WorkspaceID)
		if e != nil || agency.Status != "normal" {
			writeError(w, r, 403, "agency_unavailable", "机构不可用")
			return
		}
		var b store.AgencyBranding
		b, err = s.store.AgencyBranding(r.Context(), wc.WorkspaceID)
		brand = b.Published
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	brand, err = s.store.EffectiveBrand(r.Context(), brand)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"brand": brand})
}

func (s *Server) draftBrandAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	a, err := s.store.BrandAsset(r.Context(), r.PathValue("assetId"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if a.AgencyID != r.PathValue("id") {
		writeError(w, r, 404, "not_found", "素材不存在")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeData(w, r, map[string]string{"pngBase64": base64.StdEncoding.EncodeToString(a.Content)})
}
func (s *Server) brandHistory(w http.ResponseWriter, r *http.Request, wc wsContext) {
	v, err := s.store.BrandHistory(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, v)
}

func (s *Server) internalAgencyBrand(w http.ResponseWriter, r *http.Request) {
	if !domainentry.Internal(r, s.cfg.InternalServiceToken) {
		domainentry.Fail(w, 403)
		return
	}
	if s.store == nil {
		domainentry.Fail(w, 503)
		return
	}
	a, err := s.store.GetAgency(r.Context(), r.PathValue("id"))
	if err != nil || a.Status != "normal" {
		domainentry.Fail(w, 403)
		return
	}
	b, err := s.store.AgencyBranding(r.Context(), a.ID)
	if err != nil {
		domainentry.Fail(w, 503)
		return
	}
	effective, err := s.store.EffectiveBrand(r.Context(), b.Published)
	if err != nil {
		domainentry.Fail(w, 503)
		return
	}
	writeData(w, r, map[string]any{"effectiveBrand": effective})
}
