package accessclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientUsesOnlyInternalAuthAndValidatesDecisionBinding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-KY-Internal-Token") != "internal-token" || r.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected headers: %#v", r.Header)
		}
		if r.Header.Get("X-KY-Request-Id") != "req-test" {
			t.Fatalf("missing request ID")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"allowed":true,"reasonCode":"allowed","actorId":"user_1","membershipId":"membership_1","workspaceType":"platform","workspaceId":"platform_root","grantedRequiredPermissions":["platform.ai_executors.view"],"dataScopes":[]}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "internal-token")
	if err != nil {
		t.Fatal(err)
	}
	decision, err := client.Evaluate(context.Background(), "req-test", Request{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		RequiredAllPermissions: []string{"platform.ai_executors.view"},
	})
	if err != nil || !decision.Allowed || decision.MembershipID != "membership_1" {
		t.Fatalf("decision=%#v err=%v", decision, err)
	}
}

func TestClientRejectsInsecureRemoteAndMismatchedDecision(t *testing.T) {
	if _, err := New("http://example.com", "token"); err == nil {
		t.Fatal("remote cleartext membership URL was accepted")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"allowed":true,"actorId":"other","workspaceType":"platform","workspaceId":"platform_root"}}`))
	}))
	defer server.Close()
	client, _ := New(server.URL, "token")
	_, err := client.Evaluate(context.Background(), "req-test", Request{
		ActorID: "user_1", SessionID: "session_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
	})
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("mismatched decision err=%v", err)
	}
}
