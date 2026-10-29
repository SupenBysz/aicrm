package domains

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNoSupplierCredentialRedirect(t *testing.T) {
	hits := 0
	dest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer dest.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, dest.URL, http.StatusTemporaryRedirect)
	}))
	defer api.Close()
	p := Provider{InstanceID: "test", Token: "private", APIBase: api.URL}
	if e := p.call(context.Background(), "GET", "/test", nil, nil); e == nil || hits != 0 {
		t.Fatal("credential redirect", e, hits)
	}
}

func TestProbeAddressPolicy(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.1", "100.64.1.1", "169.254.169.254", "192.0.2.1", "198.18.0.1", "::1", "fc00::1", "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1"} {
		if publicProbeIP(net.ParseIP(s)) {
			t.Fatal("unsafe probe", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "104.16.0.1", "2606:4700::1111"} {
		if !publicProbeIP(net.ParseIP(s)) {
			t.Fatal("public probe denied", s)
		}
	}
}
func TestManagedZoneAutomaticallyBootstrapsChallenge(t *testing.T) {
	for _, tc := range []struct {
		name, state, zone string
		public            bool
	}{{"dns_pending", "awaiting_verification", "active", false}, {"ready", "awaiting_verification", "active", true}, {"ns_pending", "awaiting_verification", "pending", false}, {"active_ownership_lost", "active", "active", false}} {
		t.Run(tc.name, func(t *testing.T) {
			txtWrites, cnameWrites, calls, ingress := 0, 0, 0, 0
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path == "/zones" {
					fmt.Fprintf(w, `{"success":true,"result":[{"id":"zone","status":%q,"name_servers":["ns.example.net"],"name":"example.com","account":{"id":"account"}}]}`, tc.zone)
					return
				}
				if r.Method == "GET" {
					fmt.Fprint(w, `{"success":true,"result":[]}`)
					return
				}
				if r.Method != "POST" {
					t.Error("unexpected method", r.Method)
				}
				var in map[string]any
				json.NewDecoder(r.Body).Decode(&in)
				if in["type"] == "TXT" {
					txtWrites++
				} else if in["type"] == "CNAME" {
					cnameWrites++
				} else {
					t.Error(in)
				}
				fmt.Fprint(w, `{"success":true,"result":{}}`)
			}))
			defer api.Close()
			p := Provider{InstanceID: "test", Token: "private", AccountID: "account", TunnelID: "tunnel", Origin: "http://127.0.0.1:18181", APIBase: api.URL,
				lookupTXT: func(context.Context, string) ([]string, error) {
					if tc.public {
						return []string{"nonce"}, nil
					}
					return nil, fmt.Errorf("not propagated")
				},
				verifyIngress: func(context.Context, Binding) error { ingress++; return nil }, probe: func(context.Context, Binding) bool { return true },
			}
			o := p.Observe(context.Background(), Binding{ID: "b", Hostname: "work.example.com", Mode: "managed", State: tc.state, Challenge: "nonce", ExpiresAt: time.Now().Add(time.Hour)})
			if tc.state == "active" {
				if calls != 0 || o.Verified || o.RouteReady {
					t.Fatal("active ownership was self-healed", o, calls)
				}
				return
			}
			if txtWrites != 1 {
				t.Fatal("challenge not bootstrapped", o, txtWrites)
			}
			ready := tc.public && tc.zone == "active"
			if o.Verified != ready || o.RouteReady != ready || (cnameWrites == 1) != ready || (ingress == 1) != ready {
				t.Fatal(o, txtWrites, cnameWrites, ingress)
			}
			if o.NameserverChangeRequired != (tc.zone != "active") {
				t.Fatal("incorrect NS guidance", o)
			}
		})
	}
}
