package server

import (
	"errors"
	"github.com/Kysion/KyaiCRM/shared/appearance"
	"net/http"
)

func (s *Server) getAppearance(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	v, err := s.store.GetAppearance(r.Context(), actor.UserID)
	if err != nil {
		writeError(w, r, 503, "service_unavailable", "外观设置读取失败")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeData(w, r, v)
}
func (s *Server) updateAppearance(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var v appearance.Value
	if !appearance.Decode(w, r, &v) {
		writeError(w, r, 400, "validation_error", "请求外观配置格式无效")
		return
	}
	if !v.Valid(true) {
		writeError(w, r, 400, "validation_error", "外观设置无效")
		return
	}
	out, err := s.store.SaveAppearance(r.Context(), actor.UserID, actor.UserID, "", v)
	if errors.Is(err, appearance.ErrConflict) {
		writeError(w, r, 409, "appearance_conflict", "外观已在其他窗口更新，请重新读取后重试")
		return
	}
	if err != nil {
		writeError(w, r, 503, "service_unavailable", "外观设置保存失败")
		return
	}
	writeData(w, r, out)
}
