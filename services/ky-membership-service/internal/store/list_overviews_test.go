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
	schema := fmt.Sprintf("overview_members_%d", time.Now().UnixNano())
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

	_, err = s.db.Exec(`CREATE TABLE ky_user(id text,username text,email text,phone text); INSERT INTO ky_user VALUES('u','alice','a@example.invalid','1'),('v','bob','b@example.invalid','2');
 CREATE TABLE ky_membership(id text,user_id text,workspace_type text,workspace_id text,display_name text,status text,deleted_at timestamptz);
 INSERT INTO ky_membership VALUES('m1','u','agency','a','Alice','active',NULL),('m2','v','agency','a','Other','disabled',NULL),('m3','u','agency','b','Alice','active',NULL),('gone','u','agency','a','Alice','active',now());
 CREATE TABLE ky_membership_department(membership_id text,department_id text); INSERT INTO ky_membership_department VALUES('m1','d'),('m1','d');
 CREATE TABLE ky_membership_team(membership_id text,team_id text);
 CREATE TABLE ky_invitation(id text,workspace_type text,workspace_id text,invitation_type text DEFAULT 'member',invitee_email text,invitee_phone text,invited_by_membership_id text,token text DEFAULT 'test',preset_role_ids jsonb DEFAULT '[]',preset_department_ids jsonb DEFAULT '[]',preset_team_ids jsonb DEFAULT '[]',status text,expires_at timestamptz NOT NULL,accepted_user_id text,accepted_at timestamptz,created_at timestamptz DEFAULT now());
 INSERT INTO ky_invitation(id,workspace_type,workspace_id,invited_by_membership_id,status,expires_at) VALUES
 ('future','agency','a','m1','pending','2099-01-01Z'),('past','agency','a','m1','pending','2000-01-01Z'),('accepted','agency','a','m1','accepted','2000-01-01Z'),('other','agency','a','m2','cancelled','2099-01-01Z'),('outside','agency','b','m1','pending','2099-01-01Z');`)
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
	r, err := s.MemberOverview(ctx, "agency", "a", "", "", "", ScopeFilter{DepartmentIDs: []string{"d"}})
	if err != nil || r.Total != 1 || count(r, "active") != 1 {
		t.Fatal(r, err)
	}
	r, err = s.MemberOverview(ctx, "agency", "a", "", "", "", ScopeFilter{})
	if err != nil || r.Total != 0 {
		t.Fatal("empty scope leaked", r, err)
	}
	r, err = s.MemberOverview(ctx, "agency", "a", "Alice", "", "", ScopeFilter{Unrestricted: true})
	if err != nil || r.Total != 1 {
		t.Fatal(r, err)
	}
	r, err = s.InvitationOverview(ctx, "agency", "a", []string{"m1"})
	if err != nil || r.Total != 3 || count(r, "pending") != 1 || count(r, "expired") != 1 || count(r, "accepted") != 1 {
		t.Fatal(r, err)
	}
	r, err = s.InvitationOverview(ctx, "agency", "a", []string{})
	if err != nil || r.Total != 0 {
		t.Fatal("empty inviter scope leaked", r, err)
	}
	_, n, err := s.ListInvitations(ctx, "agency", "a", "pending", []string{"m1"}, 1, 10)
	if err != nil || n != 2 {
		t.Fatal("legacy status changed", n, err)
	}
	items, n, err := s.ListInvitationsEffective(ctx, "agency", "a", "", "expired", []string{"m1"}, 1, 10, time.Now().UTC())
	if err != nil || n != 1 || len(items) != 1 || items[0].Status != "pending" || items[0].EffectiveStatus != "expired" {
		t.Fatal(items, n, err)
	}
	var stored string
	if err = s.db.QueryRow(`SELECT status FROM ky_invitation WHERE id='past'`).Scan(&stored); err != nil || stored != "pending" {
		t.Fatal("GET wrote invitation", stored, err)
	}
	boundary := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	_, n, err = s.ListInvitationsEffective(ctx, "agency", "a", "", "expired", []string{"m1"}, 1, 10, boundary)
	if err != nil || n != 1 {
		t.Fatal("expiry equality boundary", n, err)
	}
}
