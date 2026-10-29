package store

import (
	"context"
	"errors"
	"fmt"
	"github.com/Kysion/KyaiCRM/shared/appearance"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAppearanceDatabase(t *testing.T) {
	dsn := os.Getenv("KYCRM_APPEARANCE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated database required")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var name string
	if err = s.db.QueryRow(`SELECT current_database()`).Scan(&name); err != nil || !strings.HasPrefix(name, "kycrm_test_appearance_") {
		t.Fatal("unsafe database", err)
	}

	schema := fmt.Sprintf("appearance_%d", time.Now().UnixNano())
	if _, err = s.db.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	defer s.db.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	scoped, err := Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer scoped.Close()
	s = scoped
	_, err = s.db.Exec(`CREATE TABLE ky_user(id text PRIMARY KEY);INSERT INTO ky_user VALUES('a'),('b');
 CREATE TABLE ky_permission(id text PRIMARY KEY,code text UNIQUE,name text,category text,resource text,action text,workspace_types jsonb,description text,status text);
 CREATE TABLE ky_role(id text PRIMARY KEY,code text,workspace_type text,workspace_id text,is_system boolean,deleted_at timestamptz,status text);
 CREATE TABLE ky_role_permission(id text PRIMARY KEY,role_id text,permission_id text,UNIQUE(role_id,permission_id));`)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../ops/db/106_appearance_themes.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(string(raw)); err != nil {
		t.Fatal(err)
	}
	id := "a"
	v := appearance.Default()
	v.Source = "personal"
	v.ThemeID = "business-blue"
	v.Mode = "dark"
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.SaveAppearance(ctx, id, "a", "test", v); results <- err }()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, appearance.ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	got, err := s.GetAppearance(ctx, id)
	if err != nil || got.Revision != 1 || got.ThemeID != "business-blue" {
		t.Fatal(got, err)
	}
	other, err := s.GetAppearance(ctx, "b")
	if err != nil || other.Source != "platform" || other.Revision != 0 || other.ThemeID != "" {
		t.Fatal(other, err)
	}
	got.Source = "platform"
	got.ThemeID = ""
	got.Mode = ""
	got, err = s.SaveAppearance(ctx, id, "a", "test", got)
	if err != nil || got.Revision != 2 || got.Source != "platform" {
		t.Fatal(got, err)
	}
}
