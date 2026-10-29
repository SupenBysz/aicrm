package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMenuDirectoryPostgresIntegration only accepts the one-shot loopback test
// database provisioned for this contribution. It must never point at a service
// or business database.
func TestMenuDirectoryPostgresIntegration(t *testing.T) {
	dsn := os.Getenv("KY_MENU_DIRECTORY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set KY_MENU_DIRECTORY_TEST_DATABASE_URL to the isolated contribution database")
	}
	if !validIsolatedMenuTestDatabaseURL(dsn) {
		t.Fatal("integration test only accepts an explicit loopback PostgreSQL test database URL without a password")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
	schema := "ky_menu_test_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal("create isolated schema:", err)
	}
	defer func() { _, _ = db.ExecContext(context.Background(), `DROP SCHEMA `+schema+` CASCADE`) }()
	if _, err := db.ExecContext(ctx, `SET search_path TO `+schema+`, public`); err != nil {
		t.Fatal("set isolated schema:", err)
	}

	for _, statement := range []string{
		`CREATE TABLE ky_role(id text PRIMARY KEY, workspace_type text NOT NULL, workspace_id text, name text NOT NULL DEFAULT '', code text NOT NULL, description text NOT NULL DEFAULT '', is_system boolean NOT NULL DEFAULT false, deleted_at timestamptz, status text NOT NULL DEFAULT 'normal', updated_by text, updated_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE ky_permission(id text PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, category text NOT NULL, resource text NOT NULL, action text NOT NULL, workspace_types jsonb NOT NULL, description text NOT NULL, status text NOT NULL)`,
		`CREATE TABLE ky_role_permission(id text PRIMARY KEY, role_id text NOT NULL, permission_id text NOT NULL, UNIQUE(role_id,permission_id))`,
		`CREATE TABLE ky_membership_role(role_id text NOT NULL, membership_id text NOT NULL, workspace_type text NOT NULL, workspace_id text NOT NULL)`,
		`INSERT INTO ky_role(id,code,workspace_type,workspace_id,is_system,status) VALUES ('role_platform_owner','platform_owner','platform','platform_root',true,'normal'),('role_platform_admin','platform_admin','platform','platform_root',true,'normal'),('role_custom','custom','platform','platform_root',false,'normal')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal("create isolated fixture:", err)
		}
	}
	migration, err := os.ReadFile(filepath.Join("../../../../ops/db", "107_menu_directory_and_webview_config.sql"))
	if err != nil {
		t.Fatal("read migration 107:", err)
	}
	for run := 0; run < 2; run++ {
		if _, err := db.ExecContext(ctx, string(migration)); err != nil {
			t.Fatalf("apply migration 107 run %d: %v", run+1, err)
		}
	}
	for _, version := range []string{"108_menu_catalog_baseline.sql", "109_menu_webview_scope_revision.sql"} {
		migration, err := os.ReadFile(filepath.Join("../../../../ops/db", version))
		if err != nil {
			t.Fatal(err)
		}
		for run := 0; run < 2; run++ {
			if _, err = db.ExecContext(ctx, string(migration)); err != nil {
				t.Fatal("apply", version, err)
			}
		}
	}

	store := &Store{db: db}
	var revisionDefault int64
	if err := db.QueryRowContext(ctx, `SELECT permission_revision FROM ky_role WHERE id='role_platform_owner'`).Scan(&revisionDefault); err != nil || revisionDefault != 1 {
		t.Fatalf("role permission revision default: value=%d err=%v", revisionDefault, err)
	}
	updatedRevision, err := store.SetRolePermissions(ctx, "role_custom", "platform", "platform_root", []string{"permission.test.menu"}, "actor", revisionDefault)
	if err != nil || updatedRevision != 2 {
		t.Fatalf("role permission revision update: revision=%d err=%v", updatedRevision, err)
	}
	if _, err := store.SetRolePermissions(ctx, "role_custom", "platform", "platform_root", nil, "actor", revisionDefault); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale role permission revision accepted: %v", err)
	}
	if _, err := store.SetRolePermissions(ctx, "role_custom", "agency", "agency_one", nil, "actor", updatedRevision); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace role permission update accepted: %v", err)
	}
	var seededOwner, seededAdmin, seededCustom int
	_ = db.QueryRowContext(ctx, `SELECT count(*) FROM ky_role_permission rp JOIN ky_role r ON r.id=rp.role_id JOIN ky_permission p ON p.id=rp.permission_id WHERE p.code='platform.menu_catalog.manage' AND r.id='role_platform_owner'`).Scan(&seededOwner)
	_ = db.QueryRowContext(ctx, `SELECT count(*) FROM ky_role_permission rp JOIN ky_role r ON r.id=rp.role_id JOIN ky_permission p ON p.id=rp.permission_id WHERE p.code='platform.menu_catalog.manage' AND r.id='role_platform_admin'`).Scan(&seededAdmin)
	_ = db.QueryRowContext(ctx, `SELECT count(*) FROM ky_role_permission rp JOIN ky_role r ON r.id=rp.role_id JOIN ky_permission p ON p.id=rp.permission_id WHERE p.code='platform.menu_catalog.manage' AND r.id='role_custom'`).Scan(&seededCustom)
	if seededOwner != 1 || seededAdmin != 1 || seededCustom != 0 {
		t.Fatalf("menu catalog grants widened: owner=%d admin=%d custom=%d", seededOwner, seededAdmin, seededCustom)
	}

	workspaceTypes, _ := json.Marshal([]string{"platform", "agency"})
	if _, err := db.ExecContext(ctx, `INSERT INTO ky_permission(id,code,name,category,resource,action,workspace_types,description,status) VALUES('permission.test.menu','platform.test.menu.view','Test menu','menu','test','view',$1,'test fixture','normal')`, workspaceTypes); err != nil {
		t.Fatal("insert menu permission:", err)
	}
	entry := func(key, node string, parent *string, workspaces []string) MenuEntryInput {
		raw, _ := json.Marshal(workspaces)
		var selected []string
		_ = json.Unmarshal(raw, &selected)
		return MenuEntryInput{MenuEntry: MenuEntry{DirectoryType: "management", MenuKey: key, NodeType: node, ParentKey: parent, Name: key, PermissionCode: "platform.test.menu.view", WorkspaceTypes: selected, PageType: "internal", Status: "active"}}
	}
	root, err := store.SaveMenuEntry(ctx, entry("group.root", "group", nil, []string{"platform", "agency"}), "actor")
	if err != nil {
		t.Fatal("create root group:", err)
	}
	childRef := "group.root"
	web := entry("page.web", "leaf", &childRef, []string{"platform", "agency"})
	web.PageType = "webview"
	webEntry, err := store.SaveMenuEntry(ctx, web, "actor")
	if err != nil {
		t.Fatal("create webview leaf:", err)
	}
	if _, err := store.SaveMenuEntry(ctx, MenuEntryInput{MenuEntry: MenuEntry{DirectoryType: "management", MenuKey: root.MenuKey, NodeType: "leaf", ParentKey: nil, Name: "Invalid leaf", PermissionCode: "platform.test.menu.view", WorkspaceTypes: []string{"platform"}, PageType: "internal", Status: "active"}, ExpectedRevision: int64Pointer(root.Revision)}, "actor"); !errors.Is(err, ErrValidation) {
		t.Fatalf("group with children changed to leaf: got %v", err)
	}
	shrink := root
	shrink.WorkspaceTypes = []string{"platform"}
	if _, err := store.SaveMenuEntry(ctx, MenuEntryInput{MenuEntry: shrink, ExpectedRevision: int64Pointer(root.Revision)}, "actor"); !errors.Is(err, ErrValidation) {
		t.Fatalf("parent workspace shrink accepted: %v", err)
	}
	if err := store.UpdateMenuStatus(ctx, "management", webEntry.MenuKey, "disabled", "actor", webEntry.Revision); err != nil {
		t.Fatal("disable leaf:", err)
	}
	if err := store.UpdateMenuStatus(ctx, "management", webEntry.MenuKey, "active", "actor", webEntry.Revision); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale status revision accepted: %v", err)
	}

	// Two concurrent changes cannot create a cycle: the per-directory advisory
	// transaction lock makes the second writer validate the committed first edge.
	x, err := store.SaveMenuEntry(ctx, entry("group.x", "group", &childRef, []string{"platform"}), "actor")
	if err != nil {
		t.Fatal("create group x:", err)
	}
	y, err := store.SaveMenuEntry(ctx, entry("group.y", "group", &childRef, []string{"platform"}), "actor")
	if err != nil {
		t.Fatal("create group y:", err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	updateParent := func(item MenuEntry, parent string) {
		defer wg.Done()
		item.ParentKey = &parent
		_, updateErr := store.SaveMenuEntry(ctx, MenuEntryInput{MenuEntry: item, ExpectedRevision: int64Pointer(item.Revision)}, "actor")
		results <- updateErr
	}
	wg.Add(2)
	go updateParent(x, y.MenuKey)
	go updateParent(y, x.MenuKey)
	wg.Wait()
	close(results)
	accepted, rejected := 0, 0
	for result := range results {
		if result == nil {
			accepted++
		} else if errors.Is(result, ErrValidation) || errors.Is(result, ErrConflict) {
			rejected++
		} else {
			t.Fatalf("unexpected concurrent tree error: %v", result)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("concurrent cycle result accepted=%d rejected=%d", accepted, rejected)
	}

	boundEntry := MenuEntryInput{MenuEntry: MenuEntry{DirectoryType: "workbench", MenuKey: "bound.web", NodeType: "leaf", Name: "多工作区网页", WorkspaceTypes: []string{"platform", "agency"}, PageType: "webview", Status: "active", PermissionBindings: map[string][]string{"platform": {"platform.test.menu.view"}, "agency": {"platform.test.menu.view"}}}}
	savedBound, err := store.SaveMenuEntry(ctx, boundEntry, "actor")
	if err != nil || len(savedBound.PermissionBindings) != 2 || savedBound.PermissionCode != "" {
		t.Fatalf("workspace bindings not persisted: %#v %v", savedBound, err)
	}
	if !MenuEntryAllowed(savedBound, "platform", map[string]bool{"platform.test.menu.view": true}) || MenuEntryAllowed(savedBound, "agency", map[string]bool{}) {
		t.Fatal("explicit bindings widened authorization")
	}
	badBound := boundEntry
	badBound.MenuKey = "invalid.bound"
	badBound.PermissionBindings = map[string][]string{"platform": {"platform.test.menu.view"}}
	if _, err := store.SaveMenuEntry(ctx, badBound, "actor"); !errors.Is(err, ErrValidation) {
		t.Fatalf("partial workspace binding accepted: %v", err)
	}

	config := MenuWebViewConfigInput{ExpectedScopeRevision: int64Pointer(0), Platform: "web", DefaultURL: "https://example.test/start", OpenMode: "embedded", Protocols: []string{"https"}, Scripts: []MenuResourceRef{}, Styles: []MenuResourceRef{}, ScheduleMode: "page_first"}
	common, err := store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "platform", "platform_root", "common", config, "actor")
	if err != nil {
		t.Fatal("create common config:", err)
	}
	workspace, err := store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace", config, "actor")
	if err != nil {
		t.Fatal("create workspace config:", err)
	}
	workspaceConfig := config
	workspaceConfig.DefaultURL = "https://example.test/workspace"
	workspaceConfig.ExpectedScopeRevision = int64Pointer(1)
	workspaceConfig.ExpectedRevision = int64Pointer(workspace.Revision)
	workspace, err = store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace", workspaceConfig, "actor")
	if err != nil || workspace.Revision != 2 {
		t.Fatalf("workspace config CAS: revision=%d err=%v", workspace.Revision, err)
	}
	config.DefaultURL = "https://example.test/common-v2"
	config.ExpectedScopeRevision = int64Pointer(1)
	config.ExpectedRevision = int64Pointer(common.Revision)
	common, err = store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "platform", "platform_root", "common", config, "actor")
	if err != nil || common.Revision != 2 {
		t.Fatalf("common config CAS: revision=%d err=%v", common.Revision, err)
	}
	workspaceExact, err := store.GetMenuWebViewConfigAtScope(ctx, "management", webEntry.MenuKey, "workspace", "agency", "agency_one")
	if err != nil || workspaceExact.Revision != 2 || workspaceExact.DefaultURL != "https://example.test/workspace" {
		t.Fatalf("workspace scope revision leaked: %#v err=%v", workspaceExact, err)
	}
	inherited, err := store.GetMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_two")
	if err != nil || !inherited.Inherited || inherited.Revision != 2 || inherited.DefaultURL != "https://example.test/common-v2" {
		t.Fatalf("common inheritance/revision: %#v err=%v", inherited, err)
	}
	editor, err := store.GetMenuConfigEditor(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace")
	if err != nil || !editor.HasOverride || editor.ScopeRevision != 2 {
		t.Fatalf("editor snapshot: %#v %v", editor, err)
	}
	if err = store.ResetMenuWorkspaceConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "actor", editor.ScopeRevision); err != nil {
		t.Fatal(err)
	}
	resetEditor, err := store.GetMenuConfigEditor(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace")
	if err != nil || resetEditor.HasOverride || resetEditor.ScopeRevision != 3 || resetEditor.Config == nil || !resetEditor.Config.Inherited {
		t.Fatalf("reset inheritance: %#v %v", resetEditor, err)
	}
	if _, err = store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace", workspaceConfig, "actor"); !errors.Is(err, ErrConflict) {
		t.Fatalf("late write after reset: %v", err)
	}
	recreated := workspaceConfig
	recreated.ExpectedRevision = nil
	recreated.ExpectedScopeRevision = int64Pointer(3)
	if _, err = store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace", recreated, "actor"); err != nil {
		t.Fatal("recreate", err)
	}
	if err = store.ResetMenuWorkspaceConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "actor", 2); !errors.Is(err, ErrConflict) {
		t.Fatalf("ABA reset accepted: %v", err)
	}
	var eventCount int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM ky_menu_webview_scope_event WHERE menu_key=$1 AND workspace_id='agency_one'`, webEntry.MenuKey).Scan(&eventCount); err != nil || eventCount != 4 {
		t.Fatalf("atomic audit count=%d err=%v", eventCount, err)
	}
	// Repeating a baseline never overwrites administrator metadata.
	if _, err = db.ExecContext(ctx, `UPDATE ky_menu_directory SET name='自定义名称',status='disabled' WHERE menu_key='ky-access-management.roles'`); err != nil {
		t.Fatal(err)
	}
	seed, err := os.ReadFile(filepath.Join("../../../../ops/db", "108_menu_catalog_baseline.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, string(seed)); err != nil {
		t.Fatal(err)
	}
	preserved, err := store.GetMenuEntry(ctx, "management", "ky-access-management.roles")
	if err != nil || preserved.Name != "自定义名称" || preserved.Status != "disabled" {
		t.Fatalf("baseline overwrote administrator: %#v %v", preserved, err)
	}

	withoutRole, err := store.EffectivePermissions(ctx, "membership_without_menu_role")
	if err != nil || len(withoutRole.MenuKeys) != 0 {
		t.Fatalf("menu key leaked without role: %#v err=%v", withoutRole, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO ky_role(id,code,workspace_type,workspace_id,is_system,status) VALUES('role_test_runtime','runtime','platform','platform_root',false,'normal')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO ky_role_permission(id,role_id,permission_id) VALUES('rp_runtime','role_test_runtime','permission.test.menu')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO ky_membership_role(role_id,membership_id,workspace_type,workspace_id) VALUES('role_test_runtime','membership_with_menu_role','platform','platform_root')`); err != nil {
		t.Fatal(err)
	}
	withRole, err := store.EffectivePermissions(ctx, "membership_with_menu_role")
	if err != nil || len(withRole.MenuKeys) != 1 || withRole.MenuKeys[0] != "platform.test.menu.view" {
		t.Fatalf("menu permission not projected for authorized membership: %#v err=%v", withRole, err)
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
