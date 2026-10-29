package main

import (
	"encoding/json"
	"fmt"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/domains"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGatewayCandidateProbeAndBusinessBoundary(t *testing.T) {
	secret := strings.Repeat("s", 32)
	t.Setenv("KY_DOMAIN_PROXY_SECRET", secret)
	t.Setenv("KY_DOMAIN_PROBE_SECRET", secret)
	t.Setenv("KY_DOMAIN_GATEWAY_TOKEN", secret)
	t.Setenv("KY_DOMAIN_BACKEND_HOST", "backend.example.com")
	proxied := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied = true
		if r.Host != "backend.example.com" || r.Header.Get("X-KY-Entry-Host") != "work.example.com" || r.Header.Get("X-KY-Entry-Proxy") != secret || r.Header.Get("X-KY-Internal-Token") != "" {
			t.Error("unsafe forwarding")
		}
		fmt.Fprint(w, "business")
	}))
	defer backend.Close()
	t.Setenv("KY_DOMAIN_BACKEND_URL", backend.URL)
	active := false
	org := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-KY-Internal-Token") != secret {
			t.Error("missing internal token")
		}
		var in struct {
			Host  string `json:"host"`
			Probe bool   `json:"probe"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		if in.Host != "work.example.com" || (!active && !in.Probe) {
			w.WriteHeader(404)
			return
		}
		if in.Probe && r.Header.Get("X-KY-Domain-Probe") != secret {
			t.Error("missing private probe proof")
		}
		json.NewEncoder(w).Encode(map[string]any{"data": domainentry.Entry{Host: in.Host, BindingID: "binding", AgencyID: "agency", Generation: 2}})
	}))
	defer org.Close()
	t.Setenv("KY_DOMAIN_ORG_URL", org.URL)
	names := []string{"ky-auth-service", "ky-org-service", "ky-membership-service", "ky-ai-model-service", "ky-matrix-account-service", "ky-agent-executor-service"}
	endpoints := []string{}
	for _, name := range names {
		service := name
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"gateVersion": 1, "service": service}})
		}))
		defer s.Close()
		endpoints = append(endpoints, s.URL)
	}
	t.Setenv("KY_DOMAIN_GATE_ENDPOINTS", strings.Join(endpoints, ","))
	handler, err := newGateway()
	if err != nil {
		t.Fatal(err)
	}
	run := func(path string, proof string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "https://work.example.com"+path, nil)
		r.Header.Set("X-KY-Domain-Probe", proof)
		r.Header.Set("X-KY-Internal-Token", "forged")
		r.Header.Set("X-KY-Entry-Host", "other.example.com")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := run("/login", ""); w.Code != 403 || proxied {
		t.Fatal("candidate business opened", w.Code)
	}
	if w := run("/.well-known/kycrm-entry", secret); w.Code != 404 {
		t.Fatal("raw secret accepted", w.Code)
	}
	proof := domainentry.ProbeProof(secret, "work.example.com", time.Now())
	w := run("/.well-known/kycrm-entry", proof)
	expected := domains.ProbeDigest(domains.Binding{ID: "binding", Generation: 2, Hostname: "work.example.com"})
	if w.Code != 200 || w.Body.String() != expected || proxied {
		t.Fatal("candidate proof failed", w.Code, w.Body.String())
	}
	active = true
	if w = run("/internal/v1/domains/resolve", ""); w.Code != 404 || proxied {
		t.Fatal("internal route exposed", w.Code)
	}
	if w = run("/login", ""); w.Code != 200 || !proxied {
		t.Fatal("active entry failed", w.Code)
	}
}
