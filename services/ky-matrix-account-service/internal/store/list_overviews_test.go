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
	schema := fmt.Sprintf("overview_matrix_%d", time.Now().UnixNano())
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

	_, err = s.db.Exec(`CREATE TABLE ky_matrix_account(id text,workspace_type text,workspace_id text,platform text,display_name text,platform_uid text,nickname text,remark text,status text,login_status text,deleted_at timestamptz);
 INSERT INTO ky_matrix_account VALUES
 ('online','agency','a','douyin','One','1','','','normal','online',NULL),
 ('expired','agency','a','douyin','Two','2','','','normal','expired',NULL),
 ('disabled','agency','a','douyin','Three','3','','','disabled','expired',NULL),
 ('pending','agency','a','douyin','Four','4','','','normal','login_pending',NULL),
 ('unknown','agency','a','kuaishou','Five','5','','','normal','unknown',NULL),
 ('gone','agency','a','douyin','Gone','6','','','normal','online',now()),
 ('outside','agency','b','douyin','Outside','7','','','normal','online',NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	params := ListAccountsParams{WorkspaceType: "agency", WorkspaceID: "a", Platform: "douyin"}
	r, err := s.AccountOverview(ctx, params)
	if err != nil || r.Total != 4 {
		t.Fatal(r, err)
	}
	counts := map[string]int64{}
	for _, m := range r.Metrics {
		counts[m.Key] = m.Count
	}
	if counts["online"] != 1 || counts["attention"] != 1 || counts["disabled"] != 1 {
		t.Fatal(counts)
	}
	params.Attention = "required"
	where, args := accountConditions(params)
	var n int
	if err = s.db.QueryRow("SELECT count(*) FROM ky_matrix_account a WHERE "+strings.Join(where, " AND "), args...).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	params.Platform = "kuaishou"
	r, err = s.AccountOverview(ctx, params)
	if err != nil || r.Total != 1 || r.Metrics[1].Count != 1 {
		t.Fatal(r, err)
	}
	params.WorkspaceID = "missing"
	r, err = s.AccountOverview(ctx, params)
	if err != nil || r.Total != 0 {
		t.Fatal(r, err)
	}
}
