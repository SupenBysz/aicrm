package store

import (
	"context"
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
	_, err = s.db.Exec(`CREATE TABLE ky_user(id text,status text,deleted_at timestamptz);CREATE TABLE ky_user_session(id text,user_id text,status text,expires_at timestamptz,last_seen_at timestamptz);INSERT INTO ky_user VALUES('ok','normal',NULL),('blocked','disabled',NULL),('gone','normal',now()),('stale','normal',NULL);INSERT INTO ky_user_session VALUES('s','ok','active',now()+interval '1 hour',now()),('s2','ok','active',now()+interval '1 hour',now()),('s3','blocked','active',now()+interval '1 hour',now()),('s4','gone','active',now()+interval '1 hour',now()),('s5','stale','active',now()+interval '1 hour',now()-interval '91 seconds')`)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.OnlineUsers(ctx, []string{"ok", "blocked", "gone", "stale"})
	if err != nil || len(out) != 1 || out[0] != "ok" {
		t.Fatal(out, err)
	}
	if err = s.TouchPresence(ctx, "s5"); err != nil {
		t.Fatal(err)
	}
	out, err = s.OnlineUsers(ctx, []string{"stale"})
	if err != nil || len(out) != 1 {
		t.Fatal(out, err)
	}
}
