package server

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/config"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type pmRoundTrip func(*http.Request) (*http.Response, error)

func (f pmRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func pmAllowed() accessDecisionResponse {
	var d accessDecisionResponse
	_ = json.Unmarshal([]byte(`{"allowed":true,"actorId":"u","workspaceType":"platform","workspaceId":"platform_root","membershipId":"m","grantedRequiredPermissions":["platform.plugin_management.view"],"dataScopes":[{"scopeType":"all"}]}`), &d)
	return d
}
func TestPluginHealthHandlerContract(t *testing.T) {
	cases := []struct {
		name   string
		change func(*http.Request, *accessDecisionResponse)
		code   int
	}{
		{"授权成功", func(r *http.Request, d *accessDecisionResponse) {}, 200},
		{"未登录", func(r *http.Request, d *accessDecisionResponse) { r.Header.Del("Authorization") }, 401},
		{"无效令牌", func(r *http.Request, d *accessDecisionResponse) { r.Header.Set("Authorization", "Bearer invalid") }, 401},
		{"企业工作区", func(r *http.Request, d *accessDecisionResponse) { r.Header.Set("X-KY-Workspace-Type", "enterprise") }, 403},
		{"错误平台工作区", func(r *http.Request, d *accessDecisionResponse) { r.Header.Set("X-KY-Workspace-Id", "other") }, 403},
		{"无成员拒绝", func(r *http.Request, d *accessDecisionResponse) { *d = accessDecisionResponse{Allowed: false} }, 403},
		{"错误权限", func(r *http.Request, d *accessDecisionResponse) {
			d.GrantedRequiredPermissions = []string{"platform.basic_info.view"}
		}, 403},
		{"缺少范围", func(r *http.Request, d *accessDecisionResponse) { d.DataScopes = nil }, 403},
		{"身份矛盾", func(r *http.Request, d *accessDecisionResponse) { d.ActorID = "other" }, 503},
		{"缺少成员", func(r *http.Request, d *accessDecisionResponse) { d.MembershipID = "" }, 503},
		{"禁止查询目标", func(r *http.Request, d *accessDecisionResponse) { r.URL.RawQuery = "url=http://example.com" }, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var healthCalls atomic.Int32
			rt := pmRoundTrip(func(r *http.Request) (*http.Response, error) {
				healthCalls.Add(1)
				if len(r.Header) != 0 {
					t.Errorf("探测转发了外部请求头")
				}
				return (&readyRT{}).RoundTrip(r)
			})
			d := pmAllowed()
			s := &Server{cfg: config.Config{AuthTokenSecret: "secret", InternalServiceToken: "canary-secret"}, healthHTTPClient: &http.Client{Transport: rt}}
			s.pluginAccess = func(context.Context, string, string, string) (accessDecisionResponse, error) { return d, nil }
			r := httptest.NewRequest("GET", "/api/v1/platform/plugin-management/service-health", nil)
			r.Header.Set("Authorization", "Bearer "+token(t))
			r.Header.Set("X-KY-Workspace-Type", "platform")
			r.Header.Set("X-KY-Workspace-Id", "platform_root")
			r.Header.Set("X-Private-Canary", "must-not-forward")
			tc.change(r, &d)
			w := httptest.NewRecorder()
			s.pluginServiceHealth(w, r)
			if w.Code != tc.code {
				t.Fatalf("状态码=%d，预期=%d，响应=%s", w.Code, tc.code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("缺少禁止缓存头")
			}
			expected := int32(0)
			if tc.code == 200 {
				expected = 5
			}
			if healthCalls.Load() != expected {
				t.Fatalf("探测次数=%d", healthCalls.Load())
			}
			for _, secret := range []string{"canary-secret", "must-not-forward", "secret-version", "127.0.0.1", "18081"} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatalf("响应泄漏内部信息 %s", secret)
				}
			}
		})
	}
}

func TestPluginMembershipRedirectAndErrors(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	cases := []struct {
		name     string
		status   int
		body     string
		redirect bool
	}{
		{"禁止重定向", 302, "", true}, {"服务失败", 500, `{"secret":"canary"}`, false},
		{"空对象", 200, `{}`, false}, {"缺少判定", 200, `{"data":{}}`, false},
		{"类型错误", 200, `{"data":{"allowed":"yes"}}`, false}, {"超长响应", 200, strings.Repeat("x", 65537), false},
		{"尾随内容", 200, `{"data":{"allowed":false}} {}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				if tc.redirect {
					w.Header().Set("Location", destination.URL)
				}
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}))
			defer ts.Close()
			s := &Server{cfg: config.Config{MembershipURL: ts.URL, InternalServiceToken: "canary"}}
			if _, err := s.requestPluginAccess(context.Background(), "u", "s", "r"); err == nil {
				t.Fatal("错误响应未被拒绝")
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("内部授权请求跟随了重定向")
	}
}

type pmTimeoutBody struct{ ctx context.Context }

func (b pmTimeoutBody) Read([]byte) (int, error) { <-b.ctx.Done(); return 0, b.ctx.Err() }
func (b pmTimeoutBody) Close() error             { return nil }
func TestPluginHealthProbeContract(t *testing.T) {
	cases := []struct {
		name, body    string
		status        int
		state, reason string
		bodyTimeout   bool
	}{
		{"错误服务", `{"status":"ok","service":"other"}`, 200, "unknown", "invalid_response", false},
		{"错误状态", `{"status":"bad","service":"ky-org-service"}`, 200, "unknown", "invalid_response", false},
		{"无效JSON", "x", 200, "unknown", "invalid_response", false},
		{"超长响应", strings.Repeat("x", 4097), 200, "unknown", "oversize", false},
		{"错误状态码", "{}", 503, "unhealthy", "http_status", false},
		{"响应体超时", "", 200, "timeout", "timeout", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt := pmRoundTrip(func(r *http.Request) (*http.Response, error) {
				var body io.ReadCloser = io.NopCloser(strings.NewReader(tc.body))
				if tc.bodyTimeout {
					body = pmTimeoutBody{r.Context()}
				}
				return &http.Response{StatusCode: tc.status, Body: body, Header: make(http.Header), Request: r}, nil
			})
			s := &Server{healthHTTPClient: &http.Client{Transport: rt}}
			start := time.Now()
			got := s.collectHealth(context.Background())
			if time.Since(start) > 5500*time.Millisecond {
				t.Fatal("探测超出总超时")
			}
			if len(got) != 5 {
				t.Fatal("缺少服务")
			}
			for _, it := range got {
				if it.State != tc.state || it.Reason != tc.reason || it.Version != nil {
					t.Fatalf("状态不正确: %+v", it)
				}
			}
		})
	}
}

func TestPluginHealthCancellation(t *testing.T) {
	s := &Server{healthHTTPClient: &http.Client{Transport: pmRoundTrip(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	items := s.collectHealth(ctx)
	if time.Since(start) > time.Second {
		t.Fatal("取消未及时传播")
	}
	for _, item := range items {
		if item.State != "unknown" || item.Reason != "cancelled" {
			t.Fatalf("取消后状态不正确: %+v", item)
		}
	}
	s = &Server{cfg: config.Config{MembershipURL: "http://127.0.0.1:1", InternalServiceToken: "x"}}
	if _, err := s.requestPluginAccess(ctx, "u", "s", "r"); !errors.Is(err, context.Canceled) {
		t.Fatalf("权限取消错误=%v", err)
	}
}
