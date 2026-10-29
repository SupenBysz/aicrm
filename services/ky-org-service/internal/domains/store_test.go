package domains

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	_ "github.com/jackc/pgx/v5/stdlib"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNormalize(t *testing.T) {
	for _, v := range []struct{ in, want string }{{"https://WORK.Example.com/login?x=1", "work.example.com"}, {"work.example.com.", "work.example.com"}, {"工作.example.com", "xn--2qq276a.example.com"}} {
		h, e := Normalize(v.in, nil, nil)
		if e != nil || h != v.want {
			t.Fatalf("%s %s %v", v.in, h, e)
		}
	}
	for _, v := range []string{"example.com", "localhost", "127.0.0.1", "foo.local", "*.example.com", "http://work.example.com", "https://u:p@work.example.com", "https://work.example.com:443", "work.example.com/abc", "a..example.com", "deep.work.example.com"} {
		if _, e := Normalize(v, nil, nil); e == nil {
			t.Fatal("accepted", v)
		}
	}
	if _, e := Normalize("admin.example.com", []string{"example.com"}, nil); e == nil {
		t.Fatal("reserved suffix")
	}
}
func TestDomainDatabase(t *testing.T) {
	dsn := os.Getenv("DOMAIN_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("independent empty database required")
	}
	db, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	ctx := context.Background()
	var name string
	if e = db.QueryRow(`SELECT current_database()`).Scan(&name); e != nil || !strings.HasPrefix(name, "domain_test_") {
		t.Fatal("unsafe database", name, e)
	}
	if _, e = db.Exec(`CREATE TABLE ky_agency(id text PRIMARY KEY,status text NOT NULL,deleted_at timestamptz);CREATE TABLE ky_enterprise(id text PRIMARY KEY,agency_id text,status text,deleted_at timestamptz);CREATE TABLE ky_permission(id text PRIMARY KEY,code text UNIQUE,name text,category text,resource text,action text,workspace_types jsonb);INSERT INTO ky_agency VALUES('agency1','normal',NULL),('agency2','normal',NULL)`); e != nil {
		t.Fatal(e)
	}
	migration, e := os.ReadFile("../../../../ops/db/103_org_agency_domains.sql")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec(string(migration)); e != nil {
		t.Fatal(e)
	}
	s := Store{DB: db}
	in := Input{Hostname: "work.example.com", Mode: "managed", NSConsent: true}
	b, e := s.Command(ctx, "actor", "platform_root", "agency1", "", "create", "create-original", in)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := s.Command(ctx, "actor", "platform_root", "agency1", "", "create", "create-original", in)
	if e != nil || replay.ID != b.ID {
		t.Fatal("replay", e)
	}
	other := in
	other.Hostname = "other.example.com"
	if _, e = s.Command(ctx, "actor", "platform_root", "agency1", "", "create", "create-original", other); !errors.Is(e, ErrConflict) {
		t.Fatal("payload reuse", e)
	}
	if _, e = s.Command(ctx, "actor", "platform_root", "agency2", "", "create", "create-duplicate", in); !errors.Is(e, ErrConflict) {
		t.Fatal("hostname uniqueness", e)
	}
	var count int
	_ = db.QueryRow(`SELECT count(*) FROM ky_agency_domain`).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
	if _, e = s.Resolve(ctx, b.Hostname); !errors.Is(e, ErrNotFound) {
		t.Fatal("candidate opened", e)
	}
	work, e := s.Claim(ctx)
	if e != nil || work.Binding.ID != b.ID {
		t.Fatal("claim", e)
	}
	if _, e = s.Claim(ctx); !errors.Is(e, ErrNotFound) {
		t.Fatal("parallel lease", e)
	}
	complete := Observation{Verified: true, DNSReady: true, TLSReady: true, RouteReady: true, Message: "ready"}
	if e = s.Complete(ctx, work, complete, true); e != nil {
		t.Fatal(e)
	}
	b, e = s.Resolve(ctx, b.Hostname)
	if e != nil || b.State != "active" {
		t.Fatal("activation", b, e)
	}
	if e = s.Complete(ctx, work, complete, true); !errors.Is(e, ErrConflict) {
		t.Fatal("late result", e)
	}
	suspended, e := s.Command(ctx, "actor", "platform_root", "agency1", b.ID, "suspend", "suspend-original", Input{Revision: b.Revision, Reason: "safety"})
	if e != nil {
		t.Fatal(e)
	}
	if suspended.Generation <= b.Generation {
		t.Fatal("generation not revoked")
	}
	if _, e = s.Resolve(ctx, b.Hostname); !errors.Is(e, ErrNotFound) {
		t.Fatal("suspended remains accessible", e)
	}
	renewed, e := s.Command(ctx, "actor", "platform_root", "agency1", b.ID, "resume", "resume-original", Input{Revision: suspended.Revision, Reason: "revalidate"})
	if e != nil {
		t.Fatal(e)
	}
	work, e = s.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	detached, e := s.Command(ctx, "actor", "platform_root", "agency1", b.ID, "detach", "detach-original", Input{Revision: renewed.Revision, Reason: "offboard"})
	if e != nil || detached.State != "detaching" {
		t.Fatal(e)
	}
	if e = s.Complete(ctx, work, complete, true); !errors.Is(e, ErrConflict) {
		t.Fatal("cancelled work reopened", e)
	}
	_, _ = db.Exec(`UPDATE ky_agency_domain_task SET lease_until=now()-interval '1 second' WHERE state='cancelled'`)
	cleanup, e := s.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Complete(ctx, cleanup, Observation{Deleted: true}, false); e != nil {
		t.Fatal(e)
	}
	b, e = s.Get(ctx, "agency1", b.ID)
	if e != nil || b.State != "detached" {
		t.Fatal(e)
	}
	// Concurrent first-claims across institutions yield one owner, without partial task/command rows.
	var wg sync.WaitGroup
	success := make(chan Binding, 2)
	errs := make(chan error, 2)
	for _, agency := range []string{"agency1", "agency2"} {
		wg.Add(1)
		go func(a string) {
			defer wg.Done()
			v, err := s.Command(ctx, "actor", "platform_root", a, "", "create", "parallel-"+a, Input{Hostname: "parallel.example.com", Mode: "managed", NSConsent: true})
			if err == nil {
				success <- v
			}
			errs <- err
		}(agency)
	}
	wg.Wait()
	close(success)
	close(errs)
	if len(success) != 1 {
		t.Fatal("concurrent ownership", len(success))
	}
	for e := range errs {
		if e != nil && !errors.Is(e, ErrConflict) {
			t.Fatal(e)
		}
	}
	var audits int
	_ = db.QueryRow(`SELECT count(*) FROM ky_agency_domain_audit`).Scan(&audits)
	if audits < 5 {
		t.Fatal("missing audit", audits)
	}
	// Final task-write failure rolls back the binding activation as one transaction.
	var winner Binding
	for v := range success {
		winner = v
	}
	work, e = s.Claim(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if work.Binding.ID != winner.ID {
		t.Fatal("wrong candidate")
	}
	_, e = db.Exec(`CREATE FUNCTION fail_domain_task() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected';END$$;CREATE TRIGGER fail_result BEFORE UPDATE ON ky_agency_domain_task FOR EACH ROW EXECUTE FUNCTION fail_domain_task()`)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Complete(ctx, work, complete, true); e == nil {
		t.Fatal("fault not injected")
	}
	if _, e = s.Resolve(ctx, winner.Hostname); !errors.Is(e, ErrNotFound) {
		t.Fatal("partial activation", e)
	}
	_, _ = db.Exec(`DROP TRIGGER fail_result ON ky_agency_domain_task`)
	if e = s.Complete(ctx, work, complete, true); e != nil {
		t.Fatal("retry", e)
	}
	// DTOs must not expose supplier references or operator identity.
	dto, _ := json.Marshal(winner)
	if strings.Contains(string(dto), "providerId") || strings.Contains(string(dto), "actorId") {
		t.Fatal("private fields exposed")
	}
	_ = time.Second
}

func TestReservedPlatformHostsDoNotBlockSiblingSubdomains(t *testing.T) {
	hosts := []string{"console.example.com", "example.com", "www.example.com"}
	h, e := Normalize("https://admin.example.com/login", nil, hosts)
	if e != nil || h != "admin.example.com" {
		t.Fatal(h, e)
	}
	for _, raw := range []string{"console.example.com", "https://CONSOLE.example.com./login", "www.example.com"} {
		if _, e := Normalize(raw, nil, hosts); !errors.Is(e, ErrReserved) {
			t.Fatal("platform host not protected", raw, e)
		}
	}
	if _, e := Normalize("admin.example.com", []string{"example.com"}, nil); !errors.Is(e, ErrReserved) {
		t.Fatal("explicit reserved root not protected", e)
	}
}
