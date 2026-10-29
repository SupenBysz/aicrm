package domainentry

import (
	"encoding/json"
	sharedauth "github.com/Kysion/KyaiCRM/shared/auth"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEntryGate(t *testing.T) {
	t.Setenv("KY_DOMAIN_ENTRY_ENABLED", "1")
	t.Setenv("KY_DOMAIN_ORIGIN_ISOLATED", "1")
	t.Setenv("KY_DOMAIN_GATEWAY_TOKEN", strings.Repeat("g", 32))
	t.Setenv("KY_DOMAIN_PROXY_SECRET", strings.Repeat("p", 32))
	t.Setenv("KY_DOMAIN_PLATFORM_HOSTS", "platform.example.com")
	t.Setenv("KY_INTERNAL_SERVICE_TOKEN", "internal")
	t.Setenv("KY_AUTH_TOKEN_SECRET", "sign")
	org := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-KY-Internal-Token") != "internal" || r.Header.Get("Authorization") != "" {
			t.Error("unsafe internal context")
		}
		var in struct {
			Host string `json:"host"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.Host != "work.example.com" {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": Entry{Host: in.Host, BindingID: "binding", AgencyID: "agency", Generation: 2}})
	}))
	defer org.Close()
	t.Setenv("KY_DOMAIN_ORG_URL", org.URL)
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Entry Entry  `json:"entry"`
			Token string `json:"token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]bool{"allowed": in.Entry.BindingID == "binding" && in.Token != ""}})
	}))
	defer auth.Close()
	t.Setenv("KY_DOMAIN_AUTH_URL", auth.URL)
	token, _ := sharedauth.SignToken("sign", sharedauth.TokenPayload{UserID: "user", SessionID: "session", Exp: time.Now().Add(time.Hour).Unix()})
	gate := Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/login" && From(r.Context()).AgencyID != "agency" {
			t.Error("missing context")
		}
		w.WriteHeader(204)
	}), false)
	cases := []struct {
		name, host, path, bearer, proxy string
		want                            int
	}{{"candidate unknown", "unbound.example.com", "/api/v1/auth/login", "", strings.Repeat("p", 32), 403}, {"trusted login", "work.example.com", "/api/v1/auth/login", "", strings.Repeat("p", 32), 204}, {"spoof", "work.example.com", "/api/v1/auth/login", "", "bad", 503}, {"missing proof", "work.example.com", "/api/v1/auth/login", "", "", 403}, {"scoped session", "work.example.com", "/api/v1/auth/bootstrap", token, strings.Repeat("p", 32), 204}, {"cross entry", "platform.example.com", "/api/v1/auth/bootstrap", token, "", 403}, {"platform public", "platform.example.com", "/api/v1/terminal-auth/capabilities", "", "", 204}, {"institution terminal blocked", "work.example.com", "/api/v1/terminal-auth/capabilities", "", strings.Repeat("p", 32), 403}, {"institution register blocked", "work.example.com", "/api/v1/auth/register", "", strings.Repeat("p", 32), 403}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://"+c.host+c.path, nil)
			r.Header.Set("X-KY-Entry-Proxy", c.proxy)
			r.Header.Set("X-KY-Entry-Host", c.host)
			if c.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+c.bearer)
			}
			w := httptest.NewRecorder()
			gate.ServeHTTP(w, r)
			if w.Code != c.want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

func TestTunnelListener(t *testing.T) {
	for _, s := range []string{":18081", "0.0.0.0:18081", "[::]:18081", "127.0.0.1:0", "public.example.com:443"} {
		if LoopbackListen(s) == nil {
			t.Fatal("public listener accepted", s)
		}
	}
	for _, s := range []string{"127.0.0.1:18081", "[::1]:18081"} {
		if e := LoopbackListen(s); e != nil {
			t.Fatal(e)
		}
	}
}

func TestDisabledEntryPreservesExistingRoutes(t *testing.T) {
	for _, setting := range []string{"", "0"} {
		t.Run("disabled_"+setting, func(t *testing.T) {
			t.Setenv("KY_DOMAIN_ENTRY_ENABLED", setting)
			t.Setenv("KY_DOMAIN_PROXY_SECRET", "")
			t.Setenv("KY_DOMAIN_GATEWAY_TOKEN", "")
			if err := Validate(); err != nil {
				t.Fatal(err)
			}
			calls := 0
			h := Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusNoContent) }), false, "ky-org-service")
			for _, path := range []string{"/api/v1/public/platform-profile", "/api/v1/platform/agencies", "/api/v1/organizations/current/branding", "/healthz", "/readyz"} {
				w := httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest("GET", "http://existing.example"+path, nil))
				if w.Code != 204 {
					t.Fatalf("%s: status=%d", path, w.Code)
				}
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", "http://existing.example/internal/v1/domains/capabilities", nil))
			if w.Code != 503 || calls != 5 {
				t.Fatalf("disabled gate advertised readiness: status=%d downstream calls=%d", w.Code, calls)
			}
		})
	}
}
