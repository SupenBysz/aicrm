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
	var in a.Request
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if !decodeJSON(w, r, &in) {
		return
	}
	if a.Validate(in.Groups) != nil {
		writeError(w, r, 400, "validation_error", "统计批次过大")
		return
	}
	out, err := s.store.AgencyStatistics(r.Context(), in.Groups)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, out)
}
