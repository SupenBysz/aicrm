package store

import (
	"context"
	"fmt"
	o "github.com/Kysion/KyaiCRM/shared/listoverview"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestListOverviewPostgres(t *testing.T) {
	dsn := os.Getenv("KY_LIST_OVERVIEW_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated test database required")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || (!strings.HasSuffix(u.Path, "_test") && !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "kycrm_test_")) {
		t.Fatal("unsafe test DSN")
	}
	if _, set := u.User.Password(); set {
		t.Fatal("password DSN not allowed")
	}
	ctx := context.Background()
	base, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	schema := fmt.Sprintf("overview_org_%d", time.Now().UnixNano())
	if _, err = base.db.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer base.db.Exec("DROP SCHEMA " + schema + " CASCADE")
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	s, err := Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, err = s.db.Exec(`CREATE TABLE ky_agency(id text,name text,code text,status text,deleted_at timestamptz);
 INSERT INTO ky_agency VALUES('a','Alpha','A','normal',NULL),('b','Alpha branch','B','disabled',NULL),('c','Beta','C','frozen',NULL),('gone','Alpha','G','normal',now()),('odd','Other','O','unknown',NULL);
 CREATE TABLE ky_enterprise(id text,name text,code text,status text,agency_id text,deleted_at timestamptz);
 INSERT INTO ky_enterprise VALUES('e1','Alpha','E1','normal','a',NULL),('e2','Alpha','E2','disabled','b',NULL),('e3','Alpha','E3','frozen','a',NULL);
 CREATE TABLE ky_qualification(id text,status text); INSERT INTO ky_qualification VALUES('q1','submitted'),('q2','submitted'),('q3','approved'),('q4','rejected');`)
	if err != nil {
		t.Fatal(err)
	}
	count := func(r o.Result, key string) int64 {
		for _, m := range r.Metrics {
			if m.Key == key {
				return m.Count
			}
		}
		t.Fatal("missing metric", key)
		return -1
	}
	r, err := s.AgencyOverview(ctx, "Alpha")
	if err != nil || r.Total != 2 || count(r, "normal") != 1 || count(r, "disabled") != 1 {
		t.Fatal(r, err)
	}
	r, err = s.AgencyOverview(ctx, "")
	if err != nil || r.Total != 4 || count(r, "unclassified") != 1 {
		t.Fatal(r, err)
	}
	// Server-owned agency scope wins over a conflicting supplied agency ID.
	r, err = s.EnterpriseOverview(ctx, "Alpha", "b", "a")
	if err != nil || r.Total != 2 || count(r, "disabled") != 0 {
		t.Fatal(r, err)
	}
	r, err = s.EnterpriseOverview(ctx, "", "b", "")
	if err != nil || r.Total != 1 || count(r, "disabled") != 1 {
		t.Fatal(r, err)
	}
	r, err = s.QualificationOverview(ctx)
	if err != nil || r.Total != 4 || count(r, "submitted") != 2 {
		t.Fatal(r, err)
	}
	// The actual list predicate and aggregate use exactly the same base cohort.
	where, args := agencyConditions("Alpha", "")
	var n int64
	if err = s.db.QueryRow("SELECT count(*) FROM ky_agency a WHERE "+strings.Join(where, " AND "), args...).Scan(&n); err != nil || n != 2 {
		t.Fatal(n, err)
	}
}
