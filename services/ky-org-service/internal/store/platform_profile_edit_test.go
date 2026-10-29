package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestProfilePatchFieldPresence(t *testing.T) {
	p := PlatformProfile{CompanyName: "kept", CopyrightStyle: "full"}
	normalizePlatformProfile(&p)
	out, _, err := MergePlatformProfile(p, map[string]json.RawMessage{"brandLogoTextLong": json.RawMessage(`"Brand"`)})
	if err != nil || out.CompanyName != "kept" || out.CopyrightStyle != "full" {
		t.Fatal(out, err)
	}
	out, _, err = MergePlatformProfile(p, map[string]json.RawMessage{"companyName": json.RawMessage(`""`)})
	if err != nil || out.CompanyName != "" {
		t.Fatal(out, err)
	}
	for _, raw := range []string{`{"companyName":null}`, `{"copyrightStyle":""}`, `{"copyrightStyle":null}`, `{"other":"x"}`, `{"longLogoFontWeight":1}`, `{"companyName":"a\u0000b"}`} {
		var fields map[string]json.RawMessage
		json.Unmarshal([]byte(raw), &fields)
		if _, _, err = MergePlatformProfile(p, fields); !errors.Is(err, ErrValidation) {
			t.Fatal(raw, err)
		}
	}
}
func TestProfileConditionalDatabase(t *testing.T) {
	dsn := os.Getenv("KYCRM_PROFILE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("independent test database required")
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
		t.Fatal("unsafe test database")
	}
	if _, err = s.db.Exec(`CREATE TABLE ky_user(id text PRIMARY KEY);INSERT INTO ky_user VALUES('actor')`); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"015_platform_profile.sql", "023_platform_brand_profile.sql", "078_platform_logo_typography.sql", "100_platform_copyright_revision.sql"} {
		b, e := os.ReadFile("../../../../ops/db/" + file)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = s.db.Exec(strings.Split(string(b), "-- Permissions")[0]); e != nil {
			t.Fatal(file, e)
		}
	}
	current, err := s.GetPlatformProfile(ctx)
	if err != nil || current.CompanyName != "" || current.CopyrightStyle != "standard" {
		t.Fatal(current, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.EditPlatformProfile(ctx, current.Revision, "actor", "test", map[string]json.RawMessage{"copyrightStyle": json.RawMessage(`"full"`)})
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for e := range results {
		if e == nil {
			successes++
		} else if errors.Is(e, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
	current, _ = s.GetPlatformProfile(ctx)
	if current.CopyrightStyle != "full" {
		t.Fatal(current)
	}
	if err = s.UpsertPlatformProfile(ctx, "", "Legacy", "", 16, "system", 600, 14, "system", 600, "", "actor"); err != nil {
		t.Fatal(err)
	}
	after, _ := s.GetPlatformProfile(ctx)
	if after.CopyrightStyle != "full" || after.Revision == current.Revision {
		t.Fatal("legacy write did not invalidate new editor", after)
	}
	if _, err = s.db.Exec(`DROP TABLE ky_platform_profile_change`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.EditPlatformProfile(ctx, after.Revision, "actor", "audit-failure", map[string]json.RawMessage{"companyName": json.RawMessage(`"must rollback"`)}); err == nil {
		t.Fatal("audit failure accepted")
	}
	final, _ := s.GetPlatformProfile(ctx)
	if final.CompanyName != "" || final.Revision != after.Revision {
		t.Fatal("failed write committed", final)
	}
}
