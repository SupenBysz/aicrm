package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestDocumentsValidation(t *testing.T) {
	v := DocumentInput{Slug: "privacy-policy", Title: "隐私政策", Category: "privacy"}
	if !v.Valid() {
		t.Fatal("valid input rejected")
	}
	for _, slug := range []string{"", "../x", "a/b", "UPPER", "-x", "x-"} {
		v.Slug = slug
		if v.Valid() {
			t.Fatal(slug)
		}
	}
	v.Slug = "safe"
	v.Markdown = strings.Repeat("x", DocumentMaxBytes+1)
	if v.Valid() {
		t.Fatal("oversize")
	}
}
func TestDocumentsDatabase(t *testing.T) {
	dsn := os.Getenv("KYCRM_DOCUMENTS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated database required")
	}
	ctx := context.Background()
	s, e := Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	var db string
	s.db.QueryRow(`SELECT current_database()`).Scan(&db)
	if !strings.HasPrefix(db, "kycrm_test_") {
		t.Fatal("unsafe database")
	}
	sql, e := os.ReadFile("../../../../ops/db/113_public_documents.sql")
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.db.Exec(`CREATE TABLE ky_permission(id text UNIQUE,code text UNIQUE,name text,category text,resource text,action text,workspace_types jsonb,description text,status text);
CREATE TABLE ky_role(id text PRIMARY KEY,code text,workspace_type text,workspace_id text,is_system boolean,deleted_at timestamptz,status text);
CREATE TABLE ky_role_permission(id text PRIMARY KEY,role_id text,permission_id text,UNIQUE(role_id,permission_id));
CREATE TABLE ky_menu_directory(directory_type text,menu_key text,permission_bindings jsonb);
INSERT INTO ky_role VALUES('role_platform_owner','platform_owner','platform','platform_root',true,NULL,'normal');
INSERT INTO ky_menu_directory VALUES('management','ky-system-settings.hub','{"platform":["platform.settings.view"]}');`)
	if e != nil {
		t.Fatal(e)
	}
	ddl := string(sql)
	if _, e = s.db.Exec(ddl); e != nil {
		t.Fatal(e)
	}
	var grants int
	if e = s.db.QueryRow(`SELECT count(*) FROM ky_role_permission`).Scan(&grants); e != nil || grants != 7 {
		t.Fatal("permission migration", grants, e)
	}
	in := DocumentInput{Slug: "privacy-policy", Title: "隐私政策", Category: "privacy", Markdown: "# original"}
	d, e := s.CreateDocument(ctx, "doc_test", "actor", in)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.PublicDocument(ctx, in.Slug, 0); !errors.Is(e, ErrNotFound) {
		t.Fatal("draft leaked", e)
	}
	if _, e = s.CreateDocument(ctx, "doc_duplicate", "actor", in); !errors.Is(e, ErrConflict) {
		t.Fatal("duplicate", e)
	}
	pub := DocumentInput{ExpectedRevision: d.Revision, PublishKey: "publish-test-1"}
	d, e = s.ChangeDocument(ctx, d.ID, "actor", "publish", pub)
	if e != nil || d.Version != 1 {
		t.Fatal(d, e)
	}
	again, e := s.ChangeDocument(ctx, d.ID, "actor", "publish", pub)
	if e != nil || again.Version != 1 {
		t.Fatal("idempotency", again, e)
	}
	in.Markdown = "# draft changed"
	in.ExpectedRevision = d.Revision
	d, e = s.ChangeDocument(ctx, d.ID, "actor", "draft", in)
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.PublicDocument(ctx, in.Slug, 0)
	if e != nil || v.Markdown != "# original" {
		t.Fatal("draft leaked", v, e)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.ChangeDocument(ctx, d.ID, "actor", "draft", DocumentInput{Slug: d.Slug, Title: d.Title, Category: d.Category, Markdown: "race", ExpectedRevision: d.Revision})
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	d, _ = s.Document(ctx, d.ID)
	id := d.ID
	if e = s.BindDocument(ctx, "actor", DocumentBinding{Purpose: "privacy_policy", DocumentID: &id, Revision: 0}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ChangeDocument(ctx, id, "actor", "unpublish", DocumentInput{ExpectedRevision: d.Revision}); !errors.Is(e, ErrConflict) {
		t.Fatal("bound offline", e)
	}
	links, e := s.PublicDocumentLinks(ctx)
	if e != nil || len(links) != 1 || links[0].URL != "/legal/privacy-policy" {
		t.Fatal(links, e)
	}
	if e = s.BindDocument(ctx, "actor", DocumentBinding{Purpose: "privacy_policy", Revision: 1}); e != nil {
		t.Fatal(e)
	}
	d, e = s.ChangeDocument(ctx, id, "actor", "unpublish", DocumentInput{ExpectedRevision: d.Revision})
	if e != nil {
		t.Fatal(e)
	}
	for _, n := range []int{0, 1} {
		if _, e = s.PublicDocument(ctx, in.Slug, n); !errors.Is(e, ErrNotFound) {
			t.Fatal("offline leaked", n, e)
		}
	}
	if _, e = s.ChangeDocument(ctx, id, "actor", "delete", DocumentInput{ExpectedRevision: d.Revision}); !errors.Is(e, ErrConflict) {
		t.Fatal("published deleted", e)
	}
	d, e = s.ChangeDocument(ctx, id, "actor", "restore", DocumentInput{ExpectedRevision: d.Revision, Version: 1})
	if e != nil || d.Markdown != "# original" || d.Status != "offline" {
		t.Fatal(d, e)
	}
	d, e = s.ChangeDocument(ctx, id, "actor", "publish", DocumentInput{ExpectedRevision: d.Revision, PublishKey: "publish-test-2"})
	if e != nil || d.Version != 2 {
		t.Fatal(d, e)
	}
	v, e = s.PublicDocument(ctx, in.Slug, 1)
	if e != nil || v.Markdown != "# original" {
		t.Fatal("history changed", e)
	}
	versions, e := s.DocumentVersions(ctx, id)
	if e != nil || len(versions) != 2 {
		t.Fatal(versions, e)
	}
	conn, e := s.db.Conn(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	if _, e = conn.ExecContext(ctx, `CREATE ROLE document_test_writer`); e != nil {
		t.Fatal(e)
	}
	grantSQL, e := os.ReadFile("../../../../ops/db/roles/public_documents.sql.example")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = conn.ExecContext(ctx, strings.ReplaceAll(string(grantSQL), `:"org_writer"`, `document_test_writer`)); e != nil {
		t.Fatal(e)
	}
	if _, e = conn.ExecContext(ctx, `SET ROLE document_test_writer`); e != nil {
		t.Fatal(e)
	}
	_, e = conn.ExecContext(ctx, `UPDATE ky_document_version SET markdown='tampered' WHERE document_id='doc_test'`)
	if e == nil {
		t.Fatal("published snapshots mutable by service role")
	}
	if _, e = conn.ExecContext(ctx, `RESET ROLE`); e != nil {
		t.Fatal(e)
	}

}
