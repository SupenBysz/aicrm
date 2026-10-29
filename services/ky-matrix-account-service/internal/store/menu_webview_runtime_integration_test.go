package store

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// This test only targets the one-shot isolated loopback database. It creates
// and drops a schema and never loads service configuration or business data.
func TestMenuWebViewRuntimeAuthorizationPostgresIntegration(t *testing.T) {
	dsn := os.Getenv("KY_MENU_DIRECTORY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set KY_MENU_DIRECTORY_TEST_DATABASE_URL to the isolated contribution database")
	}
	if !validIsolatedMenuTestDatabaseURL(dsn) {
		t.Fatal("integration test only accepts an explicit loopback PostgreSQL test database URL without a password")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal("open isolated database:", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		t.Fatal("connect isolated database:", err)
	}
	schema := "ky_runtime_test_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal("create schema:", err)
	}
	defer func() { _, _ = db.ExecContext(context.Background(), `DROP SCHEMA `+schema+` CASCADE`) }()
	if _, err := db.ExecContext(ctx, `SET search_path TO `+schema+`, public`); err != nil {
		t.Fatal("set schema:", err)
	}
	for _, statement := range []string{
		`CREATE TABLE ky_permission(id text PRIMARY KEY,code text NOT NULL,category text NOT NULL,status text NOT NULL)`,
		`CREATE TABLE ky_role(id text PRIMARY KEY,workspace_type text NOT NULL,workspace_id text,status text NOT NULL,deleted_at timestamptz)`,
		`CREATE TABLE ky_role_permission(role_id text NOT NULL,permission_id text NOT NULL)`,
		`CREATE TABLE ky_membership_role(role_id text NOT NULL,membership_id text NOT NULL,workspace_type text NOT NULL,workspace_id text NOT NULL)`,
		`CREATE TABLE ky_menu_directory(directory_type text NOT NULL,menu_key text NOT NULL,node_type text NOT NULL,parent_key text,name text NOT NULL,permission_code text NOT NULL,workspace_types jsonb NOT NULL,page_type text NOT NULL,status text NOT NULL,PRIMARY KEY(directory_type,menu_key))`,
		`CREATE TABLE ky_menu_webview_config(directory_type text NOT NULL,menu_key text NOT NULL,config_scope text NOT NULL,workspace_type text NOT NULL,workspace_id text NOT NULL,platform text NOT NULL,default_url text NOT NULL,open_mode text NOT NULL,navigation_protocols jsonb NOT NULL,script_bindings jsonb NOT NULL,style_bindings jsonb NOT NULL,schedule_mode text NOT NULL,revision bigint NOT NULL)`,
		`INSERT INTO ky_permission VALUES('p_menu','test.menu.view','menu','normal')`,
		`INSERT INTO ky_menu_directory VALUES('management','test.web','leaf',NULL,'Test Web','test.menu.view','["platform"]','webview','active')`,
		`INSERT INTO ky_menu_webview_config VALUES('management','test.web','common','platform','*','web','https://example.test','embedded','["https"]','[]','[]','page_first',1)`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal("create runtime fixture:", err)
		}
	}
	store := &Store{db: db}
	_, err = store.ResolveMenuWebViewRuntimeConfig(ctx, "membership_without_role", "platform", "platform_root", "management", "test.web")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("runtime config leaked without menu assignment: %v", err)
	}
	for _, statement := range []string{
		`INSERT INTO ky_role VALUES('role_menu','platform','platform_root','normal',NULL)`,
		`INSERT INTO ky_role_permission VALUES('role_menu','p_menu')`,
		`INSERT INTO ky_membership_role VALUES('role_menu','membership_authorized','platform','platform_root')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal("insert authorization fixture:", err)
		}
	}
	config, err := store.ResolveMenuWebViewRuntimeConfig(ctx, "membership_authorized", "platform", "platform_root", "management", "test.web")
	if err != nil || config.MenuKey != "test.web" || config.DefaultURL != "https://example.test" {
		t.Fatalf("authorized runtime config missing: %#v err=%v", config, err)
	}
	if _, err := store.ResolveMenuWebViewRuntimeConfig(ctx, "membership_authorized", "platform", "other_workspace", "management", "test.web"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("workspace mismatch returned config: %v", err)
	}
	for _, statement := range []string{
		`ALTER TABLE ky_menu_directory ADD COLUMN permission_bindings jsonb NOT NULL DEFAULT '{}'::jsonb`,
		`INSERT INTO ky_permission VALUES('p_bound','menu.platform.bound','menu','normal')`,
		`UPDATE ky_menu_directory SET permission_bindings='{"platform":["menu.platform.bound"]}'::jsonb WHERE menu_key='test.web'`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.ResolveMenuWebViewRuntimeConfig(ctx, "membership_authorized", "platform", "platform_root", "management", "test.web"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy permission bypassed explicit binding: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO ky_role_permission VALUES('role_menu','p_bound')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveMenuWebViewRuntimeConfig(ctx, "membership_authorized", "platform", "platform_root", "management", "test.web"); err != nil {
		t.Fatalf("explicit workspace binding rejected: %v", err)
	}

	if _, err := db.ExecContext(ctx, `UPDATE ky_menu_directory SET status='disabled' WHERE menu_key='test.web'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveMenuWebViewRuntimeConfig(ctx, "membership_authorized", "platform", "platform_root", "management", "test.web"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("disabled menu returned runtime config: %v", err)
	}
}

func validIsolatedMenuTestDatabaseURL(dsn string) bool {
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme != "postgres" || parsed.Opaque != "" || parsed.Fragment != "" || parsed.User == nil || parsed.User.Username() == "" {
		return false
	}
	if _, hasPassword := parsed.User.Password(); hasPassword {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	port, portErr := strconv.Atoi(parsed.Port())
	if ip == nil || !ip.IsLoopback() || portErr != nil || port < 1 || port > 65535 {
		return false
	}
	database := strings.TrimPrefix(parsed.Path, "/")
	if parsed.Path != "/"+database || database == "" || strings.ContainsAny(database, "./- ") {
		return false
	}
	if !(strings.HasSuffix(database, "_test") || strings.HasSuffix(database, "_testing") || strings.HasSuffix(database, "_contribution") || strings.HasSuffix(database, "_isolated")) {
		return false
	}
	query := parsed.Query()
	sslModes := query["sslmode"]
	return len(query) == 1 && len(sslModes) == 1 && sslModes[0] == "disable"
}

func TestValidIsolatedMenuTestDatabaseURL(t *testing.T) {
	for index, value := range []struct {
		dsn string
		ok  bool
	}{
		{"postgres://tester@127.0.0.1:51554/kycrm_contribution?sslmode=disable", true},
		{"postgres://tester@[::1]:5439/tenant_test?sslmode=disable", true},
		{"postgres://tester@db.example.test:5432/tenant_test?sslmode=disable", false},
		{"postgres://tester@127.0.0.1:5432/kwwcrm?sslmode=disable", false},
		{"postgres://tester:secret@127.0.0.1:5432/tenant_test?sslmode=disable", false},
		{"postgres://tester@127.0.0.1:5432/tenant_test?sslmode=disable&connect_timeout=1", false},
		{"postgres://tester@127.0.0.1:5432/tenant_test?sslmode=disable&sslmode=disable", false},
	} {
		if validIsolatedMenuTestDatabaseURL(value.dsn) != value.ok {
			t.Fatalf("unexpected isolated database URL validation case %d", index)
		}
	}
}
