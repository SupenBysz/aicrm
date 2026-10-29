package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/domains"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

func newGateway() (http.Handler, error) {
	secret, worker, token := os.Getenv("KY_DOMAIN_PROXY_SECRET"), os.Getenv("KY_DOMAIN_PROBE_SECRET"), os.Getenv("KY_DOMAIN_GATEWAY_TOKEN")
	org := os.Getenv("KY_DOMAIN_ORG_URL")
	up, e := url.Parse(os.Getenv("KY_DOMAIN_BACKEND_URL"))
	if e != nil || up == nil || up.Scheme != "http" || up.Hostname() != "127.0.0.1" || up.User != nil || up.Path != "" || up.RawQuery != "" || up.Fragment != "" || os.Getenv("KY_DOMAIN_BACKEND_HOST") == "" || len(secret) < 32 || len(worker) < 32 || len(token) < 32 || org == "" {
		return nil, errors.New("domain gateway configuration missing")
	}
	proxy := httputil.NewSingleHostReverseProxy(up)
	original := proxy.Director
	proxy.Director = func(r *http.Request) {
		host := r.Host
		original(r)
		r.Host = os.Getenv("KY_DOMAIN_BACKEND_HOST")
		r.Header.Set("X-KY-Entry-Host", host)
		r.Header.Set("X-KY-Entry-Proxy", secret)
		r.Header.Del("X-KY-Internal-Token")
		r.Header.Del("X-KY-Domain-Probe")
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) { domainentry.Fail(w, 503) }
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		host := strings.ToLower(r.Host)
		if strings.ContainsAny(host, "/:@ \t\r\n") {
			domainentry.Fail(w, 403)
			return
		}
		var entry domainentry.Entry
		if r.URL.Path == "/.well-known/kycrm-entry" {
			if r.Method != "GET" || !domainentry.ValidProbeProof(r.Header.Get("X-KY-Domain-Probe"), worker, host, time.Now()) {
				domainentry.Fail(w, 404)
				return
			}
			endpoints := strings.Split(os.Getenv("KY_DOMAIN_GATE_ENDPOINTS"), ",")
			if len(endpoints) != 6 {
				domainentry.Fail(w, 503)
				return
			}
			expected := map[string]bool{"ky-auth-service": true, "ky-org-service": true, "ky-membership-service": true, "ky-ai-model-service": true, "ky-matrix-account-service": true, "ky-agent-executor-service": true}
			for _, endpoint := range endpoints {
				var cap struct {
					Version int    `json:"gateVersion"`
					Service string `json:"service"`
				}
				if domainentry.Call(ctx, endpoint, token, "/internal/v1/domains/capabilities", map[string]any{}, &cap) != nil || cap.Version != 1 || !expected[cap.Service] {
					domainentry.Fail(w, 503)
					return
				}
				delete(expected, cap.Service)
			}
			// Domain resolve accepts candidate lookup only with both service and worker proofs.
			raw, _ := json.Marshal(map[string]any{"host": host, "probe": true})
			req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(org, "/")+"/internal/v1/domains/resolve", strings.NewReader(string(raw)))
			req.Header.Set("X-KY-Internal-Token", token)
			req.Header.Set("X-KY-Request-Id", "req_domain_probe")
			req.Header.Set("X-KY-Domain-Probe", worker)
			req.Header.Set("Content-Type", "application/json")
			client := http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			res, err := client.Do(req)
			if err != nil {
				domainentry.Fail(w, 503)
				return
			}
			defer res.Body.Close()
			var out struct {
				Data domainentry.Entry `json:"data"`
			}
			if res.StatusCode != 200 || json.NewDecoder(http.MaxBytesReader(w, res.Body, 8192)).Decode(&out) != nil || out.Data.BindingID == "" || out.Data.Host != host {
				domainentry.Fail(w, 403)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			fmt.Fprint(w, domains.ProbeDigest(domains.Binding{ID: out.Data.BindingID, Generation: out.Data.Generation, Hostname: host}))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/internal/") || r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			domainentry.Fail(w, 404)
			return
		}
		if err := domainentry.Call(ctx, org, token, "/internal/v1/domains/resolve", map[string]string{"host": host}, &entry); err != nil {
			domainentry.Fail(w, domainentry.FailureStatus(err))
			return
		}
		if entry.Host != host || entry.BindingID == "" {
			domainentry.Fail(w, 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "https://"+host {
			domainentry.Fail(w, 403)
			return
		}
		if r.Header.Get("Upgrade") != "" {
			domainentry.Fail(w, 403)
			return
		} // No long-lived sessions until periodic reauthorization is implemented.
		proxy.ServeHTTP(w, r)
	})
	return handler, nil
}
func main() {
	handler, err := newGateway()
	if err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("KY_DOMAIN_GATEWAY_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:18181"
	}
	if err := domainentry.LoopbackListen(addr); err != nil {
		log.Fatal(err)
	}
	srv := http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
