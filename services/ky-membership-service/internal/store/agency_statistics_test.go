package store

import (
	"context"
	a "github.com/Kysion/KyaiCRM/shared/agencystats"
	"os"
	"strings"
	"testing"
)

func TestStatisticsDatabase(t *testing.T) {
	dsn := os.Getenv("KYCRM_STATS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("independent database required")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var name string
	s.db.QueryRow(`SELECT current_database()`).Scan(&name)
	if !strings.HasPrefix(name, "kycrm_test_") {
		t.Fatal("unsafe database")
	}
	_, err = s.db.Exec(`CREATE TABLE ky_membership(user_id text,workspace_type text,workspace_id text,status text,deleted_at timestamptz);INSERT INTO ky_membership VALUES
 ('u','agency','a','left',now()),('u','enterprise','e','active',NULL),('u','enterprise','e','active',NULL),('left','enterprise','e','left',now()),('invited','enterprise','e','invited',NULL),('disabled','enterprise','e','disabled',NULL),('alien','enterprise','other','active',NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.AgencyStatistics(ctx, []a.Group{{ID: "a", Enterprises: []string{"e"}}})
	if err != nil {
		t.Fatal(err)
	}
	g := out[0]
	if g.Total != 3 || g.Employed != 2 || g.Left != 1 || len(g.Users) != 1 || g.Users[0] != "u" {
		t.Fatal(g)
	}
	_, err = s.db.Exec(`INSERT INTO ky_membership SELECT 'bulk-'||n,'enterprise','e','active',NULL FROM generate_series(1,5001)n`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.AgencyStatistics(ctx, []a.Group{{ID: "a", Enterprises: []string{"e"}}}); err == nil {
		t.Fatal("budget did not fail closed")
	}
}
