package server

import (
	"encoding/base64"
	d "github.com/Kysion/KyaiCRM/shared/branding"
	"net/http"
)

func (s *Server) uploadPlatformBrandAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		Kind      string `json:"kind"`
		PNGBase64 string `json:"pngBase64"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	if !decodeJSON(w, r, &in) {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(in.PNGBase64)
	if err != nil || (in.Kind != "icon" && in.Kind != "wordmark") {
		writeError(w, r, 400, "validation_error", "请选择PNG图片")
		return
	}
	raw, err = d.NormalizePNG(raw, in.Kind == "icon")
	if err != nil {
		writeError(w, r, 400, "validation_error", "PNG图片无效或尺寸超限")
		return
	}
	id, err := s.store.SavePlatformBrandAsset(r.Context(), raw)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]string{"id": id})
}
func (s *Server) previewPlatformBrandAsset(w http.ResponseWriter, r *http.Request, wc wsContext) {
	raw, err := s.store.PlatformBrandAsset(r.Context(), r.PathValue("assetId"), false)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeData(w, r, map[string]string{"pngBase64": base64.StdEncoding.EncodeToString(raw)})
}
func (s *Server) publicPlatformBrandAsset(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, 503, "service_unavailable", "资源服务未就绪")
		return
	}
	raw, err := s.store.PlatformBrandAsset(r.Context(), r.PathValue("assetId"), true)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Current references can be removed; avoid long-lived public caching of drafts.
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(raw)
}
