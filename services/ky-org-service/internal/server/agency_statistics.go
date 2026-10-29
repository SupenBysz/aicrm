package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	a "github.com/Kysion/KyaiCRM/shared/agencystats"
	"github.com/Kysion/KyaiCRM/shared/auth"
	"io"
	"net/http"
	"strings"
	"time"
)

var statisticsHTTP = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (s *Server) statisticsCall(ctx context.Context, base, path, rid string, in, out any) error {
	if s.cfg.InternalServiceToken == "" {
		return errors.New("internal credential missing")
	}
	raw, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-KY-Internal-Token", s.cfg.InternalServiceToken)
	req.Header.Set("X-KY-Request-Id", rid)
	res, err := statisticsHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("dependency unavailable")
	}
	raw, err = io.ReadAll(io.LimitReader(res.Body, 2<<20+1))
	if err != nil || len(raw) > 2<<20 {
		return errors.New("dependency response limit")
	}
	return json.Unmarshal(raw, out)
}
func (s *Server) statisticsAllowed(r *http.Request, wc wsContext, agencies bool) int {
	payload, err := auth.VerifyToken(s.cfg.AuthTokenSecret, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if err != nil {
		return 403
	}
	perms := []string{"platform.enterprises.view"}
	if agencies {
		perms = append(perms, "platform.agencies.view")
	}
	var dec struct {
		Data accessDecisionResponse `json:"data"`
	}
	err = s.statisticsCall(r.Context(), s.cfg.MembershipURL, "/internal/v1/access-decisions", requestID(r), map[string]any{"actorId": wc.UserID, "sessionId": payload.SessionID, "workspaceType": wc.WorkspaceType, "workspaceId": wc.WorkspaceID, "requiredAllPermissions": perms, "requiredAnyPermissions": []string{}}, &dec)
	d := dec.Data
	if err != nil {
		return 503
	}
	if err != nil || !d.Allowed || d.ActorID != wc.UserID || d.MembershipID != wc.MembershipID || d.WorkspaceType != "platform" || d.WorkspaceID != wc.WorkspaceID || len(d.DataScopes) == 0 {
		return 403
	}
	for _, p := range perms {
		if !hasPermission(d.GrantedRequiredPermissions, p) {
			return 403
		}
	}
	for _, sc := range d.DataScopes {
		if sc.ScopeType != "all" {
			return 403
		}
	}
	return 200
}
func (s *Server) agencyStatistics(w http.ResponseWriter, r *http.Request, wc wsContext) {
	w.Header().Set("Cache-Control", "no-store")
	var in struct {
		IDs []string `json:"ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	if !decodeJSON(w, r, &in) {
		return
	}
	if !a.ValidIDs(in.IDs, a.MaxGroups) {
		writeError(w, r, 400, "validation_error", "请选择1至100条不同记录")
		return
	}
	agencies := strings.Contains(r.URL.Path, "/agencies/")
	if status := s.statisticsAllowed(r, wc, agencies); status != 200 {
		writeError(w, r, status, "statistics_scope_required", "统计需要相应列表权限及完整数据范围")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var groups []a.Group
	var err error
	if agencies {
		groups, err = s.store.AgencyStatisticGroups(ctx, in.IDs)
	} else {
		groups, err = s.store.EnterpriseStatisticGroups(ctx, in.IDs)
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if len(groups) != len(in.IDs) {
		writeError(w, r, 404, "not_found", "部分记录不可见或已删除")
		return
	}
	if a.Validate(groups) != nil {
		writeError(w, r, 503, "statistics_unavailable", "统计规模超过当前预算，请缩小范围")
		return
	}
	var members struct {
		Data []a.Group `json:"data"`
	}
	if s.statisticsCall(ctx, s.cfg.MembershipURL, "/internal/v1/agency-statistics", requestID(r), a.Request{Groups: groups}, &members) != nil || len(members.Data) != len(groups) {
		writeError(w, r, 503, "statistics_unavailable", "用户统计暂不可用，请重试")
		return
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, g := range members.Data {
		for _, id := range g.Users {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	if len(ids) > a.MaxMappings {
		writeError(w, r, 503, "statistics_unavailable", "统计规模超过当前预算")
		return
	}
	online := map[string]bool{}
	for start := 0; start < len(ids); start += a.ChunkSize {
		end := min(start+a.ChunkSize, len(ids))
		var result struct {
			Data []string `json:"data"`
		}
		if s.statisticsCall(ctx, s.cfg.StatisticsAuthURL, "/internal/v1/statistics/online-users", requestID(r), map[string]any{"ids": ids[start:end]}, &result) != nil {
			writeError(w, r, 503, "statistics_unavailable", "在线统计暂不可用，请重试")
			return
		}
		for _, id := range result.Data {
			online[id] = true
		}
	}
	out := map[string]a.Stats{}
	for _, g := range members.Data {
		v := a.Stats{EnterpriseCount: len(g.Enterprises), Users: a.Users{Employed: g.Employed, Left: g.Left, Total: g.Total}}
		for _, id := range g.Users {
			if online[id] {
				v.Users.Online++
			}
		}
		out[g.ID] = v
	}
	writeData(w, r, out)
}
