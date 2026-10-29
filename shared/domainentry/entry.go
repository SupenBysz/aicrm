// Package domainentry enforces the trusted external entry boundary before business handlers.
package domainentry

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	sharedauth "github.com/Kysion/KyaiCRM/shared/auth"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Entry struct {
	Host       string `json:"host"`
	BindingID  string `json:"bindingId"`
	AgencyID   string `json:"agencyId"`
	Generation int64  `json:"generation"`
}
type key struct{}

func From(ctx context.Context) Entry                    { v, _ := ctx.Value(key{}).(Entry); return v }
func With(ctx context.Context, e Entry) context.Context { return context.WithValue(ctx, key{}, e) }

var client = &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func Call(ctx context.Context, base, token, path string, in, out any) error {
	u, e := url.Parse(base)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return errors.New("invalid internal endpoint")
	}
	b, e := json.Marshal(in)
	if e != nil {
		return e
	}
	r, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+path, bytes.NewReader(b))
	if e != nil {
		return e
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-KY-Internal-Token", token)
	r.Header.Set("X-KY-Request-Id", "req_domain_entry")
	res, e := client.Do(r)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return &HTTPError{Status: res.StatusCode}
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	d := json.NewDecoder(io.LimitReader(res.Body, 65537))
	if e = d.Decode(&envelope); e != nil {
		return e
	}
	return json.Unmarshal(envelope.Data, out)
}
func Internal(r *http.Request, secret string) bool {
	return secret != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-KY-Internal-Token")), []byte(secret)) == 1 && r.Header.Get("X-KY-Request-Id") != "" && r.Header.Get("Authorization") == ""
}
func Fail(w http.ResponseWriter, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": entryCode(status), "message": "当前入口不可用或账号无访问权限"}})
}

// Wrap is opt-in. Enabling requires a private proxy secret and an explicit platform host allowlist.
// Every external service must be wrapped; internal routes remain protected by their own service auth.
func Wrap(next http.Handler, authService bool, serviceNames ...string) http.Handler {
	if os.Getenv("KY_DOMAIN_ENTRY_ENABLED") != "1" {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/internal/v1/domains/capabilities" {
				Fail(w, 503)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	secret, org, auth, token := os.Getenv("KY_DOMAIN_PROXY_SECRET"), os.Getenv("KY_DOMAIN_ORG_URL"), os.Getenv("KY_DOMAIN_AUTH_URL"), os.Getenv("KY_INTERNAL_SERVICE_TOKEN")
	hosts := map[string]bool{}
	for _, h := range strings.Split(os.Getenv("KY_DOMAIN_PLATFORM_HOSTS"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts[h] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/v1/domains/capabilities" {
			gatewayToken := os.Getenv("KY_DOMAIN_GATEWAY_TOKEN")
			if !(Internal(r, token) || len(gatewayToken) >= 32 && Internal(r, gatewayToken)) || os.Getenv("KY_DOMAIN_ORIGIN_ISOLATED") != "1" || len(secret) < 32 || org == "" || auth == "" || len(hosts) == 0 {
				Fail(w, 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"gateVersion": 1, "service": func() string {
				if len(serviceNames) == 1 {
					return serviceNames[0]
				}
				return ""
			}()}})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/internal/") || r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		if len(secret) < 32 || token == "" || org == "" || auth == "" || len(hosts) == 0 || r.Header.Get("X-KY-Entry-Proxy") != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-KY-Entry-Proxy")), []byte(secret)) != 1 {
			Fail(w, 503)
			return
		}
		host := strings.ToLower(r.Header.Get("X-KY-Entry-Host"))
		if r.Header.Get("X-KY-Entry-Proxy") == "" {
			host = strings.ToLower(r.Host)
			if !hosts[host] {
				Fail(w, 403)
				return
			}
		}
		if host == "" || strings.ContainsAny(host, "/:@ \t\r\n") {
			Fail(w, 403)
			return
		}
		entry := Entry{Host: host}
		if !hosts[host] {
			if err := Call(r.Context(), org, token, "/internal/v1/domains/resolve", map[string]string{"host": host}, &entry); err != nil {
				Fail(w, FailureStatus(err))
				return
			}
			if entry.BindingID == "" || entry.AgencyID == "" || entry.Generation < 1 || entry.Host != host {
				Fail(w, 403)
				return
			}
		}
		r = r.WithContext(With(r.Context(), entry))
		w.Header().Set("Cache-Control", "no-store")
		// Public institution surface is intentionally small until every additional auth path is reviewed.
		public := r.Method == "GET" && r.URL.Path == "/api/v1/public/platform-profile" || entry.BindingID != "" && r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/v1/public/brand-assets/") || r.Method == "POST" && r.URL.Path == "/api/v1/auth/login" || r.Method == "GET" && r.URL.Path == "/api/v1/public/entry"
		if entry.BindingID != "" && (r.URL.Path == "/api/v1/auth/register" || strings.EqualFold(r.Header.Get("Upgrade"), "websocket")) {
			Fail(w, 403)
			return
		}
		payload, parseErr := sharedauth.VerifyToken(os.Getenv("KY_AUTH_TOKEN_SECRET"), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		userSession := parseErr == nil && payload.UserID != "" && payload.SessionID != ""
		if !public && strings.HasPrefix(r.URL.Path, "/api/") && (entry.BindingID != "" || userSession) {
			var result struct {
				Allowed bool `json:"allowed"`
			}
			wt, wid := r.Header.Get("X-KY-Workspace-Type"), r.Header.Get("X-KY-Workspace-Id")
			switch r.URL.Path {
			case "/api/v1/auth/bootstrap", "/api/v1/auth/me", "/api/v1/auth/logout", "/api/v1/auth/change-password", "/api/v1/auth/presence":
				wt, wid = "", ""
			}
			if err := Call(r.Context(), auth, token, "/internal/v1/domains/session-access", map[string]any{"token": strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "entry": entry, "workspaceType": wt, "workspaceId": wid}, &result); err != nil {
				Fail(w, 503)
				return
			}
			if !result.Allowed {
				Fail(w, 403)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func Validate() error {
	v := os.Getenv("KY_DOMAIN_ENTRY_ENABLED")
	if v == "" || v == "0" {
		return nil
	}
	if v != "1" || len(os.Getenv("KY_DOMAIN_GATEWAY_TOKEN")) < 32 || os.Getenv("KY_DOMAIN_ORIGIN_ISOLATED") != "1" || strings.Contains(os.Getenv("KY_DOMAIN_PROXY_SECRET"), "REPLACE") || os.Getenv("KY_INTERNAL_SERVICE_TOKEN") == "REPLACE_ME" || len(os.Getenv("KY_DOMAIN_PROXY_SECRET")) < 32 || os.Getenv("KY_DOMAIN_ORG_URL") == "" || os.Getenv("KY_DOMAIN_AUTH_URL") == "" || os.Getenv("KY_DOMAIN_PLATFORM_HOSTS") == "" || os.Getenv("KY_INTERNAL_SERVICE_TOKEN") == "" || os.Getenv("KY_AUTH_TOKEN_SECRET") == "" {
		return errors.New("domain entry configuration missing")
	}
	return nil
}

func entryCode(status int) string {
	if status == 503 {
		return "entry_unavailable"
	}
	return "entry_denied"
}

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return "entry dependency unavailable" }
func FailureStatus(err error) int {
	var e *HTTPError
	if errors.As(err, &e) && (e.Status == 403 || e.Status == 404) {
		return 403
	}
	return 503
}

// LoopbackListen is mandatory when the tunnel entry policy is enabled.
func LoopbackListen(addr string) error {
	host, port, e := net.SplitHostPort(addr)
	if e != nil {
		return errors.New("loopback listener required")
	}
	ip := net.ParseIP(host)
	n, e := strconv.Atoi(port)
	if e != nil || n < 1 || n > 65535 || ip == nil || !ip.IsLoopback() {
		return errors.New("public business listener forbidden in tunnel-only mode")
	}
	return nil
}

// ProbeProof reveals no reusable service secret and is valid for one hostname for 60 seconds.
func ProbeProof(secret, host string, now time.Time) string {
	stamp := strconv.FormatInt(now.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("entry-probe:" + host + ":" + stamp))
	return stamp + "." + hex.EncodeToString(mac.Sum(nil))
}
func ValidProbeProof(proof, secret, host string, now time.Time) bool {
	if len(secret) < 32 {
		return false
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 2 {
		return false
	}
	stamp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || stamp > now.Unix()+5 || stamp < now.Unix()-60 {
		return false
	}
	expected := ProbeProof(secret, host, time.Unix(stamp, 0))
	return hmac.Equal([]byte(proof), []byte(expected))
}
