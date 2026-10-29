package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/config"
)

// Exercise the trusted decision boundary, including a union of multiple roles.
func TestStatisticsAllowed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scopes []string
		change string
		want   int
	}{
		{"all", []string{"all"}, "", 200},
		{"all_and_enterprise", []string{"all", "specified_enterprise"}, "", 200},
		{"agency_and_all", []string{"specified_agency", "all"}, "", 200},
		{"enterprise_only", []string{"specified_enterprise"}, "", 403},
		{"agency_only", []string{"specified_agency"}, "", 403},
		{"empty", nil, "", 403},
		{"wrong_actor", []string{"all"}, "actorId", 403},
		{"wrong_member", []string{"all"}, "membershipId", 403},
		{"wrong_workspace", []string{"all"}, "workspaceId", 403},
		{"wrong_type", []string{"all"}, "workspaceType", 403},
		{"denied", []string{"all"}, "denied", 403},
		{"missing_permission", []string{"all"}, "permission", 403},
		{"unavailable", []string{"all"}, "unavailable", 503},
		{"malformed", []string{"all"}, "malformed", 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dep := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/internal/v1/access-decisions" || r.Header.Get("X-KY-Internal-Token") != "internal-test" {
					t.Error("missing trusted dependency context")
				}
				var input map[string]any
				if json.NewDecoder(r.Body).Decode(&input) != nil || input["actorId"] != "u" || input["sessionId"] != "s" {
					t.Error("missing actor/session context")
				}
				if tc.change == "unavailable" {
					w.WriteHeader(503)
					return
				}
				if tc.change == "malformed" {
					w.Write([]byte(`invalid`))
					return
				}
				scopes := []map[string]string{}
				for _, scope := range tc.scopes {
					scopes = append(scopes, map[string]string{"scopeType": scope})
				}
				d := map[string]any{"allowed": true, "actorId": "u", "membershipId": "m", "workspaceType": "platform", "workspaceId": "platform_root", "dataScopes": scopes, "grantedRequiredPermissions": []string{"platform.agencies.view", "platform.enterprises.view"}}
				switch tc.change {
				case "denied":
					d["allowed"] = false
				case "permission":
					d["grantedRequiredPermissions"] = []string{"platform.agencies.view"}
				case "actorId", "membershipId", "workspaceId", "workspaceType":
					d[tc.change] = "wrong"
				}
				json.NewEncoder(w).Encode(map[string]any{"data": d})
			}))
			defer dep.Close()
			s := &Server{cfg: config.Config{AuthTokenSecret: "secret", InternalServiceToken: "internal-test", MembershipURL: dep.URL}}
			r := httptest.NewRequest("POST", "/api/v1/platform/agencies/statistics", nil)
			r.Header.Set("Authorization", "Bearer "+token(t))
			r.Header.Set("X-KY-Request-Id", "test-statistics")
			if got := s.statisticsAllowed(r, wsContext{UserID: "u", MembershipID: "m", WorkspaceType: "platform", WorkspaceID: "platform_root"}, true); got != tc.want {
				t.Fatalf("status=%d, want %d", got, tc.want)
			}
		})
	}
}

func TestStatisticsUnavailableIsNotPermissionDenied(t *testing.T) {
	dependency := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer dependency.Close()
	s := &Server{cfg: config.Config{AuthTokenSecret: "secret", InternalServiceToken: "internal-test", MembershipURL: dependency.URL}}
	r := httptest.NewRequest("POST", "/api/v1/platform/agencies/statistics", strings.NewReader(`{"ids":["a"]}`))
	r.Header.Set("Authorization", "Bearer "+token(t))
	w := httptest.NewRecorder()
	s.agencyStatistics(w, r, wsContext{UserID: "u", MembershipID: "m", WorkspaceType: "platform", WorkspaceID: "platform_root"})
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if w.Code != 503 || envelope.Error.Code != "statistics_unavailable" {
		t.Fatalf("status=%d, code=%s", w.Code, envelope.Error.Code)
	}
}
