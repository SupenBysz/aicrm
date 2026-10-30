package server

import (
	"bytes"
	"context"
	"database/sql"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
	sharedauth "github.com/Kysion/KyaiCRM/shared/auth"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPublicDocumentsAnonymousRouting(t *testing.T) {
	s := &Server{}
	mux := http.NewServeMux()
	s.documentRoutes(mux)
	for _, path := range []string{"/api/v1/public/documents/privacy-policy", "/api/v1/public/documents/privacy-policy/versions/1", "/api/v1/public/document-links"} {
		for _, method := range []string{"GET", "HEAD"} {
			r := httptest.NewRequest(method, path, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != 503 {
				t.Fatal(method, path, w.Code, w.Body.String())
			}
			if w.Header().Get("Location") != "" {
				t.Fatal("auth redirect")
			}
		}
	}
}
func TestPublicDocumentETag(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	publicDocumentJSON(w, r, map[string]string{"title": "published"})
	etag := w.Header().Get("ETag")
	if etag == "" || w.Code != 200 {
		t.Fatal(w)
	}
	r.Header.Set("If-None-Match", etag)
	w = httptest.NewRecorder()
	publicDocumentJSON(w, r, map[string]string{"title": "published"})
	if w.Code != 304 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	publicDocumentJSON(w, r, map[string]string{"title": "updated"})
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
}

func TestPublicDocumentsDatabaseHTTP(t *testing.T) {
	dsn := os.Getenv("KYCRM_DOCUMENTS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated database required")
	}
	if !strings.Contains(dsn, "kycrm_test_documents") {
		t.Fatal("unsafe database")
	}
	st, err := store.Open(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	s := &Server{store: st, cfg: config.Config{AuthTokenSecret: "test-only-not-a-real-secret"}}
	mux := http.NewServeMux()
	s.documentRoutes(mux)
	get := func(path, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("If-None-Match", etag)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	path := "/api/v1/public/documents/privacy-policy"
	w := get(path, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "original") {
		t.Fatal(w.Code, w.Body.String())
	}
	etag := w.Header().Get("ETag")
	if get(path, etag).Code != 304 {
		t.Fatal("ETag")
	}
	w = get("/api/v1/platform/documents", "")
	if w.Code != 401 {
		t.Fatal("anonymous admin", w.Code)
	}
	d, err := st.Document(context.Background(), "doc_test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.ChangeDocument(context.Background(), d.ID, "test", "unpublish", store.DocumentInput{ExpectedRevision: d.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if w = get(path, etag); w.Code != 404 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("offline ETag bypass", w.Code, w.Body.String())
	}
	if w = get(path+"/versions/1", etag); w.Code != 404 {
		t.Fatal("history bypass", w.Code)
	}
}

func TestDocumentManagementAuthorizationDatabase(t *testing.T) {
	dsn := os.Getenv("KYCRM_DOCUMENTS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated database required")
	}
	if !strings.Contains(dsn, "kycrm_test_documents") {
		t.Fatal("unsafe database")
	}
	db, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, e = db.Exec(`CREATE TABLE ky_user_session(id text PRIMARY KEY,status text,expires_at timestamptz);
 CREATE TABLE ky_membership(id text PRIMARY KEY,user_id text,workspace_type text,workspace_id text,status text,deleted_at timestamptz);
 CREATE TABLE ky_membership_role(membership_id text,role_id text);
 INSERT INTO ky_user_session VALUES('docs-session','active',now()+interval '1 hour');
 INSERT INTO ky_membership VALUES('docs-member','actor','platform','platform_root','active',NULL);
 INSERT INTO ky_membership_role VALUES('docs-member','role_platform_owner');`)
	if e != nil {
		t.Fatal(e)
	}
	st, e := store.Open(context.Background(), dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer st.Close()
	s := &Server{store: st, cfg: config.Config{AuthTokenSecret: "test-only-not-a-real-secret"}}
	mux := http.NewServeMux()
	s.documentRoutes(mux)
	token, _ := sharedauth.SignToken(s.cfg.AuthTokenSecret, sharedauth.TokenPayload{UserID: "actor", SessionID: "docs-session", Exp: time.Now().Add(time.Hour).Unix()})
	call := func(workspace, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/platform/documents", bytes.NewBufferString(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("X-KY-Workspace-Type", workspace)
		r.Header.Set("X-KY-Workspace-Id", "platform_root")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	body := `{"slug":"http-policy","title":"HTTP协议","category":"agreement","markdown":"正文"}`
	if w := call("agency", body); w.Code != 403 {
		t.Fatal("tenant write", w.Code, w.Body.String())
	}
	if w := call("platform", body); w.Code != 200 {
		t.Fatal("authorized create", w.Code, w.Body.String())
	}
	if _, e = db.Exec(`DELETE FROM ky_membership_role WHERE membership_id='docs-member'`); e != nil {
		t.Fatal(e)
	}
	if w := call("platform", body); w.Code != 403 {
		t.Fatal("ungranted write", w.Code, w.Body.String())
	}
}
