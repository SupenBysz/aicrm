package server

import (
	"context"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/config"
	"github.com/Kysion/KyaiCRM/shared/auth"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func token(t *testing.T) string {
	t.Helper()
	v, e := auth.SignToken("secret", auth.TokenPayload{UserID: "u", SessionID: "s", Exp: time.Now().Add(time.Hour).Unix()})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestValidMembershipURL(t *testing.T) {
	for raw, w := range map[string]bool{"http://127.0.0.1:18083": true, "http://localhost:9": true, "https://membership.example": true, "http://10.0.0.1": false, "http://user:pass@localhost": false, "http://localhost/x?q=1": false, "http://": false} {
		if (validMembershipURL(raw) == nil) != w {
			t.Errorf("%s", raw)
		}
	}
}
func TestRequestPluginAccessStrictAndHeaders(t *testing.T) {
	var mu sync.Mutex
	var tok, rid string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		tok = r.Header.Get("X-KY-Internal-Token")
		rid = r.Header.Get("X-KY-Request-Id")
		mu.Unlock()
		w.Write([]byte(`{"data":{"allowed":true,"actorId":"u","workspaceType":"platform","workspaceId":"platform_root","membershipId":"m","grantedRequiredPermissions":["platform.plugin_management.view"],"dataScopes":[{"scopeType":"all"}]}}`))
	}))
	defer ts.Close()
	s := &Server{cfg: config.Config{MembershipURL: ts.URL, InternalServiceToken: "secret"}}
	d, e := s.requestPluginAccess(context.Background(), "u", "s", "rid-1")
	if e != nil || !d.Allowed {
		t.Fatalf("%v", e)
	}
	mu.Lock()
	defer mu.Unlock()
	if tok != "secret" || rid != "rid-1" {
		t.Fatal("headers")
	}
}
func TestRequestPluginAccessRejectsMalformed(t *testing.T) {
	for _, body := range []string{`{"data":{}} {"x":1}`, strings.Repeat("x", 65537)} {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
		s := &Server{cfg: config.Config{MembershipURL: ts.URL, InternalServiceToken: "x"}}
		if _, e := s.requestPluginAccess(context.Background(), "u", "s", "r"); e == nil {
			t.Fatal("accepted malformed")
		}
		ts.Close()
	}
}

type healthRT struct {
	mu    sync.Mutex
	calls int
	max   int
	body  []byte
}

func (h *healthRT) RoundTrip(r *http.Request) (*http.Response, error) {
	h.mu.Lock()
	h.calls++
	if h.calls > h.max {
		h.max = h.calls
	}
	h.mu.Unlock()
	<-r.Context().Done()
	return nil, r.Context().Err()
}
func TestPluginServiceHealthUsesInjectedDecisionAndNoStore(t *testing.T) {
	h := &healthRT{}
	cases := []struct {
		name string
		dec  accessDecisionResponse
		code int
	}{{"denied", accessDecisionResponse{ActorID: "u", WorkspaceType: "platform", WorkspaceID: "platform_root", MembershipID: "m"}, 403}, {"wrongGrant", accessDecisionResponse{Allowed: true, ActorID: "u", WorkspaceType: "platform", WorkspaceID: "platform_root", MembershipID: "m", DataScopes: []struct {
		ScopeType string `json:"scopeType"`
	}{{ScopeType: "all"}}}, 403}, {"mixed", accessDecisionResponse{Allowed: true, ActorID: "u", WorkspaceType: "platform", WorkspaceID: "platform_root", MembershipID: "m", GrantedRequiredPermissions: []string{"platform.plugin_management.view"}, DataScopes: []struct {
		ScopeType string `json:"scopeType"`
	}{{ScopeType: "all"}, {ScopeType: "agency"}}}, 403}, {"identity", accessDecisionResponse{Allowed: true, ActorID: "other", WorkspaceType: "platform", WorkspaceID: "platform_root", MembershipID: "m", GrantedRequiredPermissions: []string{"platform.plugin_management.view"}, DataScopes: []struct {
		ScopeType string `json:"scopeType"`
	}{{ScopeType: "all"}}}, 503}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{cfg: config.Config{AuthTokenSecret: "secret", InternalServiceToken: "x"}, pluginHTTPClient: &http.Client{Transport: &http.Transport{Proxy: nil}}, healthHTTPClient: &http.Client{Transport: h}}
			s.pluginAccess = func(context.Context, string, string, string) (accessDecisionResponse, error) { return tc.dec, nil }
			r := httptest.NewRequest(http.MethodGet, "/api/v1/platform/plugin-management/service-health", nil)
			r.Header.Set("Authorization", "Bearer "+token(t))
			r.Header.Set("X-KY-Workspace-Type", "platform")
			r.Header.Set("X-KY-Workspace-Id", "platform_root")
			w := httptest.NewRecorder()
			s.pluginServiceHealth(w, r)
			if w.Code != tc.code {
				t.Fatalf("code=%d", w.Code)
			}
		})
	}
}
func TestHealthTransportHonorsCancellation(t *testing.T) {
	h := &healthRT{}
	s := &Server{healthHTTPClient: &http.Client{Transport: h}}
	ctx, c := context.WithCancel(context.Background())
	c()
	got := s.collectHealth(ctx)
	if len(got) != len(pluginHealthTargets) {
		t.Fatal("targets")
	}
}

type readyRT struct {
	mu          sync.Mutex
	active, max int
}

func (h *readyRT) RoundTrip(r *http.Request) (*http.Response, error) {
	h.mu.Lock()
	h.active++
	if h.active > h.max {
		h.max = h.active
	}
	h.mu.Unlock()
	time.Sleep(time.Millisecond)
	h.mu.Lock()
	h.active--
	h.mu.Unlock()
	svc := ""
	for _, t := range pluginHealthTargets {
		if strings.Contains(r.URL.Port(), t.port) {
			svc = t.service
		}
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":"ok","service":"` + svc + `","version":"secret-version"}`)), Header: make(http.Header), Request: r}, nil
}
func TestCollectHealthFiveTargetsAndConcurrency(t *testing.T) {
	rt := &readyRT{}
	s := &Server{healthHTTPClient: &http.Client{Transport: rt}}
	items := s.collectHealth(context.Background())
	if len(items) != 5 {
		t.Fatalf("items=%d", len(items))
	}
	for _, it := range items {
		if it.State != "healthy" || it.Version != nil {
			t.Fatalf("unsafe health result: %+v", it)
		}
	}
	if rt.max > 4 {
		t.Fatalf("concurrency=%d", rt.max)
	}
}

func TestMembershipClusterDNSRequiresExplicitTrust(t *testing.T) {
	const target = "http://membership.kycrm-staging.svc.cluster.local:18083"
	if validMembershipURL(target) == nil {
		t.Fatal("cluster host trusted implicitly")
	}
	if err := validMembershipURL(target, "membership.kycrm-staging.svc.cluster.local"); err != nil {
		t.Fatal(err)
	}
	if validMembershipURL("http://other.kycrm-staging.svc.cluster.local:18083", "membership.kycrm-staging.svc.cluster.local") == nil {
		t.Fatal("foreign host trusted")
	}
}
