package server

import (
	"errors"
	"github.com/Kysion/KyaiCRM/shared/appearance"
	"net/http"
)

func (s *Server) publicAppearance(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, 503, "service_unavailable", "外观设置读取失败")
		return
	}
	v, err := s.store.GetAppearance(r.Context(), "default")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeData(w, r, v)
}
func (s *Server) getAppearance(w http.ResponseWriter, r *http.Request, wc wsContext) {
	s.publicAppearance(w, r)
}
func (s *Server) updateAppearance(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var v appearance.Value
	if !appearance.Decode(w, r, &v) {
		writeError(w, r, 400, "validation_error", "请求外观配置格式无效")
		return
	}
	if !v.Valid(false) {
		writeError(w, r, 400, "validation_error", "外观设置无效")
		return
	}
	out, err := s.store.SaveAppearance(r.Context(), "default", wc.UserID, requestID(r), v)
	if errors.Is(err, appearance.ErrConflict) {
		writeError(w, r, 409, "appearance_conflict", "平台默认已更新，请重新读取后重试")
		return
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "appearance.updated", "appearance", "platform_root", map[string]any{"revision": out.Revision, "themeId": out.ThemeID, "mode": out.Mode})
	writeData(w, r, out)
}
