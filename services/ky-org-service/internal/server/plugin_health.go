package server

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Kysion/KyaiCRM/shared/auth"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type healthTarget struct{ key, port, service string }

var pluginHealthTargets = []healthTarget{{"auth", "18081", "ky-auth-service"}, {"org", "18082", "ky-org-service"}, {"membership", "18083", "ky-membership-service"}, {"matrix", "18085", "ky-matrix-account-service"}, {"ai-model", "18086", "ky-ai-model-service"}}

type healthItem struct {
	Key          string  `json:"key"`
	State        string  `json:"state"`
	Reason       string  `json:"reason"`
	CheckedAtUtc string  `json:"checkedAtUtc"`
	Version      *string `json:"version"`
}
type accessDecisionResponse struct {
	Allowed                    bool `json:"allowed"`
	allowedPresent             bool
	ActorID                    string   `json:"actorId"`
	WorkspaceType              string   `json:"workspaceType"`
	WorkspaceID                string   `json:"workspaceId"`
	MembershipID               string   `json:"membershipId"`
	GrantedRequiredPermissions []string `json:"grantedRequiredPermissions"`
	DataScopes                 []struct {
		ScopeType string `json:"scopeType"`
	} `json:"dataScopes"`
}

func (d *accessDecisionResponse) UnmarshalJSON(b []byte) error {
	type alias accessDecisionResponse
	var v struct {
		Allowed *bool `json:"allowed"`
		*alias
	}
	v.alias = (*alias)(d)
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	d.allowedPresent = v.Allowed != nil
	if v.Allowed != nil {
		d.Allowed = *v.Allowed
	}
	return nil
}

type pluginAccessFunc func(context.Context, string, string, string) (accessDecisionResponse, error)

var errAccessDenied = errors.New("access denied")

func (s *Server) pluginServiceHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.RawQuery != "" {
		writeError(w, r, 400, "validation_error", "不接受查询参数")
		return
	}
	if s.cfg.AuthTokenSecret == "" {
		writeError(w, r, 503, "service_unavailable", "认证未配置")
		return
	}
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		writeError(w, r, 401, "unauthorized", "未登录")
		return
	}
	p, e := auth.VerifyToken(s.cfg.AuthTokenSecret, strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")))
	if e != nil || strings.TrimSpace(p.UserID) == "" || strings.TrimSpace(p.SessionID) == "" {
		writeError(w, r, 401, "unauthorized", "未登录")
		return
	}
	if r.Header.Get("X-KY-Workspace-Type") != "platform" || r.Header.Get("X-KY-Workspace-Id") != "platform_root" {
		writeError(w, r, 403, "workspace_forbidden", "仅支持 platform_root")
		return
	}
	if s.cfg.InternalServiceToken == "" {
		writeError(w, r, 503, "service_unavailable", "内部权限服务未配置")
		return
	}
	dec, e := s.callPluginAccess(r.Context(), p.UserID, p.SessionID, requestID(r))
	if e != nil {
		if errors.Is(e, errAccessDenied) {
			writeError(w, r, 403, "permission_denied", "权限决策拒绝")
		} else if errors.Is(e, context.DeadlineExceeded) {
			writeError(w, r, 503, "access_decision_timeout", "权限决策超时")
		} else {
			writeError(w, r, 503, "access_decision_unavailable", "权限决策不可用")
		}
		return
	}
	if !dec.Allowed {
		writeError(w, r, 403, "permission_denied", "权限决策拒绝")
		return
	}
	if dec.ActorID != p.UserID || dec.WorkspaceType != "platform" || dec.WorkspaceID != "platform_root" || dec.MembershipID == "" {
		writeError(w, r, 503, "access_decision_unavailable", "权限身份校验不可用")
		return
	}
	if !hasPermission(dec.GrantedRequiredPermissions, "platform.plugin_management.view") || len(dec.DataScopes) == 0 {
		writeError(w, r, 403, "permission_denied", "权限决策拒绝")
		return
	}
	for _, x := range dec.DataScopes {
		if x.ScopeType != "all" {
			writeError(w, r, 403, "permission_denied", "权限决策拒绝")
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeData(w, r, map[string]any{"services": s.collectHealth(r.Context())})
}
func hasPermission(a []string, w string) bool {
	for _, v := range a {
		if v == w {
			return true
		}
	}
	return false
}
func (s *Server) callPluginAccess(c context.Context, a, b, rid string) (accessDecisionResponse, error) {
	if s.pluginAccess != nil {
		d, err := s.pluginAccess(c, a, b, rid)
		d.allowedPresent = true
		return d, err
	}
	return s.requestPluginAccess(c, a, b, rid)
}
func validMembershipURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid membership url")
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme != "http" {
		return errors.New("invalid membership scheme")
	}
	h := u.Hostname()
	if h == "localhost" {
		return nil
	}
	ip := net.ParseIP(h)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("membership host not loopback")
	}
	return nil
}
func (s *Server) requestPluginAccess(ctx context.Context, actor, session, rid string) (accessDecisionResponse, error) {
	if e := validMembershipURL(s.cfg.MembershipURL); e != nil {
		return accessDecisionResponse{}, e
	}
	ctx, c := context.WithTimeout(ctx, 2*time.Second)
	defer c()
	b, _ := json.Marshal(map[string]any{"actorId": actor, "sessionId": session, "workspaceType": "platform", "workspaceId": "platform_root", "requiredAllPermissions": []string{"platform.plugin_management.view"}, "requiredAnyPermissions": []string{}})
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.MembershipURL, "/")+"/internal/v1/access-decisions", strings.NewReader(string(b)))
	if e != nil {
		return accessDecisionResponse{}, e
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-KY-Internal-Token", s.cfg.InternalServiceToken)
	req.Header.Set("X-KY-Request-Id", rid)
	cl := s.pluginHTTPClient
	if cl == nil {
		cl = &http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 2 * time.Second}
	}
	defer cl.CloseIdleConnections()
	res, e := cl.Do(req)
	if e != nil {
		return accessDecisionResponse{}, e
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 && res.StatusCode < 500 {
		return accessDecisionResponse{}, errAccessDenied
	}
	if res.StatusCode != 200 {
		return accessDecisionResponse{}, errors.New("decision service")
	}
	data, e := io.ReadAll(io.LimitReader(res.Body, 65537))
	if e != nil {
		return accessDecisionResponse{}, e
	}
	if len(data) > 65536 {
		return accessDecisionResponse{}, errors.New("invalid body")
	}
	var raw struct {
		Data json.RawMessage `json:"data"`
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	if e = d.Decode(&raw); e != nil || len(raw.Data) == 0 {
		return accessDecisionResponse{}, errors.New("invalid decision")
	}
	var fields map[string]json.RawMessage
	if e = json.Unmarshal(raw.Data, &fields); e != nil {
		return accessDecisionResponse{}, e
	}
	if _, ok := fields["allowed"]; !ok {
		return accessDecisionResponse{}, errors.New("missing allowed")
	}
	var env accessDecisionResponse
	if e = json.Unmarshal(raw.Data, &env); e != nil {
		return accessDecisionResponse{}, e
	}
	var extra any
	if e = d.Decode(&extra); e != io.EOF {
		return accessDecisionResponse{}, errors.New("trailing json")
	}
	if !env.allowedPresent {
		return accessDecisionResponse{}, errors.New("missing allowed")
	}
	return env, nil
}
func (s *Server) collectHealth(parent context.Context) []healthItem {
	ctx, c := context.WithTimeout(parent, 5*time.Second)
	defer c()
	out := make([]healthItem, len(pluginHealthTargets))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	cl := s.healthHTTPClient
	if cl == nil {
		cl = &http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	defer cl.CloseIdleConnections()
	for i, t := range pluginHealthTargets {
		wg.Add(1)
		go func(i int, t healthTarget) {
			defer wg.Done()
			it := healthItem{Key: t.key, State: "unknown", Reason: "connection_failed", CheckedAtUtc: time.Now().UTC().Format(time.RFC3339)}
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				it.Reason = "cancelled"
				out[i] = it
				return
			}
			rc, cc := context.WithTimeout(ctx, 2*time.Second)
			defer cc()
			req, e := http.NewRequestWithContext(rc, http.MethodGet, "http://127.0.0.1:"+t.port+"/readyz", nil)
			if e == nil {
				res, x := cl.Do(req)
				if x != nil {
					if errors.Is(rc.Err(), context.DeadlineExceeded) {
						it.State = "timeout"
						it.Reason = "timeout"
					} else if errors.Is(ctx.Err(), context.Canceled) {
						it.Reason = "cancelled"
					}
				} else {
					defer res.Body.Close()
					b, x := io.ReadAll(io.LimitReader(res.Body, 4097))
					if len(b) > 4096 {
						it.Reason = "oversize"
					} else if x != nil {
						if errors.Is(rc.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
							it.State = "timeout"
							it.Reason = "timeout"
						} else if errors.Is(ctx.Err(), context.Canceled) {
							it.Reason = "cancelled"
						} else {
							it.Reason = "read_error"
						}
					} else if res.StatusCode != 200 {
						it.State = "unhealthy"
						it.Reason = "http_status"
					} else {
						var v struct{ Status, Service string }
						d := json.NewDecoder(strings.NewReader(string(b)))
						var z any
						if d.Decode(&v) != nil || d.Decode(&z) != io.EOF || v.Status != "ok" || v.Service != t.service {
							it.Reason = "invalid_response"
						} else {
							it.State = "healthy"
							it.Reason = "ok"
						}
					}
				}
			}
			out[i] = it
		}(i, t)
	}
	wg.Wait()
	return out
}
