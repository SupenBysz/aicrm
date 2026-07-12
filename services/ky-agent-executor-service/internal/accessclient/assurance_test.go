package accessclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientSendsAndValidatesHighRiskAssurance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Assurance *AssuranceRequirements `json:"assurance"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Assurance == nil || !body.Assurance.RequireWorkspaceOwner ||
			body.Assurance.MaxAuthenticationAgeSeconds != 600 || !body.Assurance.RequireMFAIfEnabled {
			t.Fatalf("assurance request=%#v", body.Assurance)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"allowed":true,"reasonCode":"allowed","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":[],"dataScopes":[],"assurance":{"verified":true,"workspaceOwner":true,"authenticatedAt":"2026-07-12T00:00:00Z","mfaRequired":false,"mfaVerified":false}},"requestId":"req-assurance"}`))
	}))
	defer server.Close()
	client, err := New(server.URL, "internal-token")
	if err != nil {
		t.Fatal(err)
	}
	decision, err := client.Evaluate(context.Background(), "req-assurance", Request{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Assurance: &AssuranceRequirements{
			RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: 600, RequireMFAIfEnabled: true,
		},
	})
	if err != nil || !decision.Allowed || decision.Assurance == nil || !decision.Assurance.Verified {
		t.Fatalf("decision=%#v err=%v", decision, err)
	}
}

func TestClientPreservesAssuranceDenialFacts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"allowed":false,"reasonCode":"mfa_required","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":[],"dataScopes":[],"assurance":{"verified":false,"workspaceOwner":true,"authenticatedAt":"2026-07-12T00:00:00Z","mfaRequired":true,"mfaVerified":false}}}`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "internal-token")
	decision, err := client.Evaluate(context.Background(), "req-assurance", Request{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Assurance: &AssuranceRequirements{RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: 600, RequireMFAIfEnabled: true},
	})
	if !errors.Is(err, ErrDenied) || decision.ReasonCode != "mfa_required" ||
		decision.Assurance == nil || !decision.Assurance.MFARequired || decision.Assurance.MFAVerified {
		t.Fatalf("decision=%#v err=%v", decision, err)
	}
}

func TestClientFailsClosedOnMissingOrForgedAssuranceResponse(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"missing", `{"data":{"allowed":true,"reasonCode":"allowed","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":[],"dataScopes":[]}}`},
		{"unverified", `{"data":{"allowed":true,"reasonCode":"allowed","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":[],"dataScopes":[],"assurance":{"verified":false,"workspaceOwner":true,"authenticatedAt":"2026-07-12T00:00:00Z","mfaRequired":false,"mfaVerified":false}}}`},
		{"unknown field", `{"data":{"allowed":true,"reasonCode":"allowed","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":[],"dataScopes":[],"assurance":{"verified":true,"workspaceOwner":true,"authenticatedAt":"2026-07-12T00:00:00Z","mfaRequired":false,"mfaVerified":false,"forged":true}}}`},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(testCase.body))
			}))
			defer server.Close()
			client, _ := New(server.URL, "internal-token")
			_, err := client.Evaluate(context.Background(), "req-assurance", Request{
				ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
				Assurance: &AssuranceRequirements{RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: 600, RequireMFAIfEnabled: true},
			})
			if err == nil || !strings.Contains(err.Error(), "unavailable") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestClientOmitsAssuranceForLegacyDecision(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if _, exists := body["assurance"]; exists {
			t.Fatal("legacy decision request unexpectedly contained assurance")
		}
		_, _ = w.Write([]byte(`{"data":{"allowed":true,"reasonCode":"allowed","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":[],"dataScopes":[]}}`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "internal-token")
	if _, err := client.Evaluate(context.Background(), "req-legacy", Request{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
	}); err != nil {
		t.Fatal(err)
	}
}
