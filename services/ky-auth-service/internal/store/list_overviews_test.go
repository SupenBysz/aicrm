package store

import (
	"context"
	"fmt"

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
	schema := fmt.Sprintf("overview_auth_%d", time.Now().UnixNano())
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

	_, err = s.db.Exec(`CREATE TABLE ky_login_log(id text,user_id text,login_account text,result text,fail_reason text DEFAULT '',ip_address text DEFAULT '',user_agent text DEFAULT '',created_at timestamptz);
 INSERT INTO ky_login_log(id,user_id,login_account,result,created_at) VALUES
 ('a','u','Alice','success','2026-01-01T00:00:00Z'),
 ('b',NULL,'Alice','failed','2026-01-01T01:00:00Z'),('c',NULL,'Alice','failed','2026-01-01T02:00:00Z'),
 ('d','u','alice','failed','2026-01-01T03:00:00Z'),('e',NULL,'','failed','2026-01-01T04:00:00Z'),
 ('f','u','Alice','other','2026-01-01T05:00:00Z'),('g','u','Bob','success','2026-01-02T00:00:00Z'),
 ('h','u','Alice','success','2025-12-31T23:59:59Z');`)
	if err != nil {
		t.Fatal(err)
	}
	f := LoginLogFilter{StartAt: "2026-01-01T00:00:00Z", EndBefore: "2026-01-02T00:00:00Z"}
	r, err := s.LoginLogOverview(ctx, f)
	if err != nil || r.Total != 6 {
		t.Fatal(r, err)
	}
	counts := map[string]int64{}
	for _, m := range r.Metrics {
		counts[m.Key] = m.Count
	}
	if counts["success"] != 1 || counts["failed"] != 4 || counts["failedAccounts"] != 2 || counts["unclassified"] != 1 {
		t.Fatal(counts)
	}
	f.Result = "failed"
	_, n, err := s.ListLoginLogsFiltered(ctx, f, 1, 2)
	if err != nil || n != 4 {
		t.Fatal(n, err)
	}
	r, err = s.LoginLogOverview(ctx, f)
	if err != nil || r.Total != 6 {
		t.Fatal("summary followed result", r, err)
	}
	_, n, err = s.ListLoginLogs(ctx, "", "", f.StartAt, f.EndBefore, 1, 10)
	if err != nil || n != 7 {
		t.Fatal("legacy inclusive end changed", n, err)
	}
	f.Result = ""
	f.UserID = "u"
	f.Account = "Alice"
	r, err = s.LoginLogOverview(ctx, f)
	if err != nil || r.Total != 2 {
		t.Fatal("account/user intersection", r, err)
	}
}
