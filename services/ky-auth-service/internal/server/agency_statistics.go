package server

import (
	"crypto/subtle"
	a "github.com/Kysion/KyaiCRM/shared/agencystats"
	"net/http"
)

func (s *Server) agencyStatistics(w http.ResponseWriter, r *http.Request) {
	if s.cfg.InternalToken == "" || subtle.ConstantTimeCompare([]byte(s.cfg.InternalToken), []byte(r.Header.Get("X-KY-Internal-Token"))) != 1 || r.Header.Get("X-KY-Request-Id") == "" || r.Header.Get("Authorization") != "" {
		writeError(w, r, 401, "unauthorized", "内部鉴权失败")
		return
	}
	var in struct {
		IDs []string `json:"ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if !decodeJSON(w, r, &in) {
		return
	}
	if !a.ValidIDs(in.IDs, a.ChunkSize) {
		writeError(w, r, 400, "validation_error", "统计批次过大")
		return
	}
	out, err := s.store.OnlineUsers(r.Context(), in.IDs)
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "统计暂不可用")
		return
	}
	writeData(w, r, out)
}
func (s *Server) presence(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	if err := s.store.TouchPresence(r.Context(), p.SessionID); err != nil {
		writeError(w, r, 503, "presence_unavailable", "在线状态更新失败")
		return
	}
	writeData(w, r, map[string]bool{"ok": true})
}
