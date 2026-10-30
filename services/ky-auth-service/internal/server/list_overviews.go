package server

import (
	"errors"
	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/store"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func parseLoginLogFilters(q url.Values, summary bool) (store.LoginLogFilter, error) {
	f := store.LoginLogFilter{UserID: q.Get("userId"), Result: q.Get("result"), StartAt: q.Get("startAt"), EndAt: q.Get("endAt"), EndBefore: q.Get("endBefore"), Account: strings.TrimSpace(q.Get("account"))}
	if f.EndAt != "" && f.EndBefore != "" {
		return f, errors.New("endAt与endBefore不能同时提供")
	}
	if summary || q.Has("endBefore") {
		spec := map[string][]string{"userId": nil, "account": nil, "result": {"success", "failed"}, "startAt": nil, "endBefore": nil}
		if !summary {
			spec["page"] = nil
			spec["pageSize"] = nil
		}
		if o.Validate(q, spec) != nil {
			return f, errors.New("登录日志查询条件无效")
		}
		start, e1 := time.Parse(time.RFC3339Nano, f.StartAt)
		end, e2 := time.Parse(time.RFC3339Nano, f.EndBefore)
		if e1 != nil || e2 != nil || !end.After(start) || end.Sub(start) > 31*24*time.Hour {
			return f, errors.New("请提供有效的起止时间，范围不超过31天")
		}
		f.StartAt = start.UTC().Format(time.RFC3339Nano)
		f.EndBefore = end.UTC().Format(time.RFC3339Nano)
	}
	return f, nil
}
func (s *Server) loginLogOverview(w http.ResponseWriter, r *http.Request) {
	if !s.requireLoginLogAccess(w, r) {
		return
	}
	filter, err := parseLoginLogFilters(r.URL.Query(), true)
	if err != nil {
		writeError(w, r, 400, "validation_error", err.Error())
		return
	}
	result, err := s.store.LoginLogOverview(r.Context(), filter)
	if err != nil {
		writeError(w, r, 503, "statistics_unavailable", "登录概览暂不可用")
		return
	}
	result.SetScope(r.URL.Query(), "result")
	writeData(w, r, result)
}
