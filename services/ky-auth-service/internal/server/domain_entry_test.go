package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	localauth "github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/auth"
	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/store"
	sharedauth "github.com/Kysion/KyaiCRM/shared/auth"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDomainSessionDatabase(t *testing.T) {
	dsn := os.Getenv("DOMAIN_AUTH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated database required")
	}
	ctx := context.Background()
	db, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var name string
	if e = db.QueryRow(`SELECT current_database()`).Scan(&name); e != nil || !strings.HasPrefix(name, "domain_test_") {
		t.Fatal("unsafe database")
	}
	raw, e := os.ReadFile("../../../../ops/db/001_identity_schema.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(string(raw)); e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec(`CREATE TABLE ky_auth_session_entry(session_id text PRIMARY KEY,hostname text,binding_id text,agency_id text,generation bigint);INSERT INTO ky_user(id,username,display_name) VALUES('bound','bound','机构成员'),('legacy','legacy','平台成员')`)
	if e != nil {
		t.Fatal(e)
	}
	st, e := store.Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer st.Close()
	entry := domainentry.Entry{Host: "work.example.com", BindingID: "binding", AgencyID: "agency", Generation: 1}
	if e = st.CreateSession(domainentry.With(ctx, entry), store.Session{ID: "bound-session", UserID: "bound", TokenID: "bound-token", ExpiresAt: time.Now().Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	if e = st.CreateSession(ctx, store.Session{ID: "legacy-session", UserID: "legacy", TokenID: "legacy-token", ExpiresAt: time.Now().Add(time.Hour)}); e != nil {
		t.Fatal(e)
	}
	active := true
	scopeAllowed := true
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-KY-Internal-Token") != "internal" || r.Header.Get("Authorization") != "" {
			t.Error("unsafe dependency request")
		}
		if r.URL.Path == "/internal/v1/domains/resolve" {
			if !active {
				w.WriteHeader(403)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"data": entry})
			return
		}
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		allowed := scopeAllowed && (in["workspaceType"] == "" || in["workspaceType"] == "enterprise" && in["workspaceId"] == "owned")
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"allowed": allowed}})
	}))
	defer up.Close()
	s := New(config.Config{AuthTokenSecret: "sign", InternalToken: "internal", OrgServiceURL: up.URL, MembershipServiceURL: up.URL})
	s.store = st
	bound, _ := sharedauth.SignToken("sign", sharedauth.TokenPayload{UserID: "bound", SessionID: "bound-session", Exp: time.Now().Add(time.Hour).Unix()})
	legacy, _ := sharedauth.SignToken("sign", sharedauth.TokenPayload{UserID: "legacy", SessionID: "legacy-session", Exp: time.Now().Add(time.Hour).Unix()})
	if !s.entrySessionAllowed(ctx, bound, entry, "enterprise", "owned") {
		t.Fatal("valid entry denied")
	}
	if s.entrySessionAllowed(ctx, bound, entry, "enterprise", "other") {
		t.Fatal("foreign workspace accepted")
	}
	if s.entrySessionAllowed(ctx, bound, domainentry.Entry{Host: "platform.example.com"}, "", "") {
		t.Fatal("bound token accepted on platform")
	}
	if s.entrySessionAllowed(ctx, legacy, entry, "", "") {
		t.Fatal("platform token accepted on institution")
	}
	if !s.entrySessionAllowed(ctx, legacy, domainentry.Entry{Host: "platform.example.com"}, "", "") {
		t.Fatal("legacy platform broken")
	}
	wrong := entry
	wrong.Generation++
	if s.entrySessionAllowed(ctx, bound, wrong, "", "") {
		t.Fatal("old generation accepted")
	}
	active = false
	if s.entrySessionAllowed(ctx, bound, entry, "", "") {
		t.Fatal("disabled entry accepted")
	}
	active = true
	_, _ = db.Exec(`UPDATE ky_user SET status='disabled' WHERE id='bound'`)
	if s.entrySessionAllowed(ctx, bound, entry, "", "") {
		t.Fatal("disabled user accepted")
	}
	_, _ = db.Exec(`UPDATE ky_user SET status='normal' WHERE id='bound'`)
	// Exercise the real password-login handler and atomic scope creation for a separate account.
	hash, e := localauth.HashPassword("fixture-password")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO ky_user(id,username,display_name) VALUES('login-user','login-user','登录验收')`); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(`INSERT INTO ky_user_credential(id,user_id,credential_type,identifier,password_hash) VALUES('login-credential','login-user','password','login-user',$1)`, hash); e != nil {
		t.Fatal(e)
	}
	login := func(password string) (int, []byte) {
		raw, _ := json.Marshal(map[string]string{"account": "login-user", "password": password})
		r := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(raw))
		r = r.WithContext(domainentry.With(r.Context(), entry))
		w := httptest.NewRecorder()
		s.login(w, r)
		return w.Code, w.Body.Bytes()
	}
	if code, body := login("fixture-password"); code != 200 {
		t.Fatal("login failed", code, string(body))
	}
	var scopeCount int
	_ = db.QueryRow(`SELECT count(*) FROM ky_auth_session_entry e JOIN ky_user_session s ON s.id=e.session_id WHERE s.user_id='login-user' AND e.binding_id='binding'`).Scan(&scopeCount)
	if scopeCount != 1 {
		t.Fatal("login missing scope")
	}
	scopeAllowed = false
	codeDenied, denied := login("fixture-password")
	codeInvalid, invalid := login("incorrect-password")
	if codeDenied != 403 || codeInvalid != 403 || !bytes.Equal(denied, invalid) {
		t.Fatal("institution login exposed account scope", codeDenied, codeInvalid)
	}
	scopeAllowed = true
	// Atomic scope persistence: a scope write failure must retain the prior live session.
	_, e = db.Exec(`CREATE FUNCTION fail_entry_scope() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected';END$$;CREATE TRIGGER scope_fault BEFORE INSERT ON ky_auth_session_entry FOR EACH ROW EXECUTE FUNCTION fail_entry_scope()`)
	if e != nil {
		t.Fatal(e)
	}
	if e = st.CreateSession(domainentry.With(ctx, entry), store.Session{ID: "failed-session", UserID: "bound", TokenID: "failed-token", ExpiresAt: time.Now().Add(time.Hour)}); e == nil {
		t.Fatal("scope failure not observed")
	}
	if ok, e := st.IsSessionActive(ctx, "bound-session", time.Now()); e != nil || !ok {
		t.Fatal("previous session revoked on failure", e)
	}
}

func TestPublicDomainBrand(t *testing.T) {
	for _, tc := range []struct {
		name, response, want string
		status               int
	}{
		{"unconfigured", `{"data":{"brand":null,"effectiveBrand":{"name":"Platform","applicationName":"Platform App","copyrightHolder":"Platform Company","copyrightStyle":"standard"}}}`, "Platform Company", 200},
		{"published", `{"data":{"agencyName":"Team Organization","effectiveBrand":{"name":"Team","applicationName":"Team Workspace","wordmark":{"url":"/logo.png"},"agencyId":"private-id"}}}`, "Team Workspace", 200},
		{"unavailable", ``, "", 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			org := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-KY-Internal-Token") != "internal" {
					t.Error("missing service proof")
				}
				if tc.status == 503 {
					w.WriteHeader(503)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.response))
			}))
			defer org.Close()
			s := New(config.Config{OrgServiceURL: org.URL, InternalToken: "internal"})
			r := httptest.NewRequest("GET", "/api/v1/public/entry", nil)
			r = r.WithContext(domainentry.With(r.Context(), domainentry.Entry{Host: "test.example.com", BindingID: "binding", AgencyID: "agency", Generation: 1}))
			w := httptest.NewRecorder()
			s.publicDomainEntry(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
			if tc.want != "" && !strings.Contains(w.Body.String(), tc.want) {
				t.Fatal(w.Body.String())
			}
			if strings.Contains(w.Body.String(), "private-id") || strings.Contains(w.Body.String(), "agencyName") {
				t.Fatal("internal identity leaked")
			}
		})
	}
}
