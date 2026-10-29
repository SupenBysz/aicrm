package store

import (
	"context"
	"errors"
	d "github.com/Kysion/KyaiCRM/shared/branding"
	"os"
	"strings"
	"testing"
)

func TestBrandInheritance(t *testing.T) {
	p := PlatformProfile{CompanyName: "Platform Company", BrandLogoTextLong: "Platform", CopyrightStyle: "chinese"}
	b := &d.Brand{Name: "Team", Version: 2}
	a := resolveBrand(b, p)
	if a.Name != "Team" || a.ApplicationName != "Team" || a.CopyrightHolder != "Platform Company" || a.CopyrightStyle != "chinese" || b.CopyrightStyle != "" {
		t.Fatal(a, b)
	}
	p.CopyrightStyle = "full"
	c := resolveBrand(b, p)
	if c.EffectiveFingerprint == a.EffectiveFingerprint || c.Version != 2 {
		t.Fatal(c)
	}
	fallback := resolveBrand(nil, p)
	if fallback.Name != "Platform" {
		t.Fatal(fallback)
	}
}
func TestBrandDatabase(t *testing.T) {
	dsn := os.Getenv("KYCRM_BRAND_TEST_DATABASE_URL")
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
	_, err = s.db.Exec(`CREATE TABLE ky_agency(id text PRIMARY KEY,status text DEFAULT 'normal',deleted_at timestamptz);INSERT INTO ky_agency(id) VALUES('a'),('b')`)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../../../ops/db/102_agency_branding.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(strings.Split(string(raw), "INSERT INTO ky_permission")[0]); err != nil {
		t.Fatal(err)
	}
	asset, err := s.SaveBrandAsset(ctx, "a", "png", []byte("fixture"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PublicBrandAsset(ctx, asset.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("draft publicly available", err)
	}
	draft := BrandDraft{Name: "Team", IconText: "Ky", WordmarkID: asset.ID}
	if err = s.SaveBrandDraft(ctx, "b", "actor", 0, draft); !errors.Is(err, ErrValidation) {
		t.Fatal("cross-agency asset accepted", err)
	}
	if err = s.SaveBrandDraft(ctx, "a", "actor", 0, draft); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveBrandDraft(ctx, "a", "actor", 0, draft); !errors.Is(err, ErrConflict) {
		t.Fatal("stale update accepted", err)
	}
	pub, err := s.PublishBrand(ctx, "a", "actor", "", 1, 0)
	if err != nil || pub.PublishedVersion != 1 || pub.Published.ShowAIIcon {
		t.Fatal(pub, err)
	}
	if _, err = s.PublicBrandAsset(ctx, asset.ID); err != nil {
		t.Fatal("published asset unavailable", err)
	}
	pub, err = s.PublishBrand(ctx, "a", "actor", "", 2, 1)
	if err != nil || pub.PublishedVersion != 2 {
		t.Fatal(pub, err)
	}
	// The suffix is versioned separately from images and survives draft reload,
	// publication, explicit disable, rollback, and effective-brand inheritance.
	draft.ShowAIIcon = true
	if err = s.SaveBrandDraft(ctx, "a", "actor", 3, draft); err != nil {
		t.Fatal(err)
	}
	saved, err := s.AgencyBranding(ctx, "a")
	if err != nil || !saved.Draft.ShowAIIcon {
		t.Fatal(saved, err)
	}
	pub, err = s.PublishBrand(ctx, "a", "actor", "", 4, 0)
	if err != nil || !pub.Published.ShowAIIcon || !resolveBrand(pub.Published, PlatformProfile{}).ShowAIIcon {
		t.Fatal(pub, err)
	}
	draft.ShowAIIcon = false
	if err = s.SaveBrandDraft(ctx, "a", "actor", 5, draft); err != nil {
		t.Fatal(err)
	}
	pub, err = s.PublishBrand(ctx, "a", "actor", "", 6, 0)
	if err != nil || pub.Published.ShowAIIcon {
		t.Fatal(pub, err)
	}
	pub, err = s.PublishBrand(ctx, "a", "actor", "", 7, 3)
	if err != nil || !pub.Published.ShowAIIcon {
		t.Fatal(pub, err)
	}
	pub, err = s.PublishBrand(ctx, "a", "actor", "", 8, 1)
	if err != nil || pub.Published.ShowAIIcon {
		t.Fatal(pub, err)
	}
	if _, err = s.db.Exec(`DROP TABLE ky_brand_change`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PublishBrand(ctx, "a", "actor", "", 9, 1); err == nil {
		t.Fatal("audit failure accepted")
	}
	after, err := s.AgencyBranding(ctx, "a")
	if err != nil || after.PublishedVersion != 6 || after.Revision != 9 {
		t.Fatal(after, err)
	}
}
