package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
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
	if dsn != "postgres://kycrm_contribution@127.0.0.1:51554/kycrm_contribution?sslmode=disable" {
		t.Fatal("integration test refuses any database other than the isolated contribution database")
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

	config := MenuWebViewConfigInput{Platform: "web", DefaultURL: "https://example.test/start", OpenMode: "embedded", Protocols: []string{"https"}, Scripts: []MenuResourceRef{}, Styles: []MenuResourceRef{}, ScheduleMode: "page_first"}
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
	workspaceConfig.ExpectedRevision = int64Pointer(workspace.Revision)
	workspace, err = store.SaveMenuWebViewConfig(ctx, "management", webEntry.MenuKey, "agency", "agency_one", "workspace", workspaceConfig, "actor")
	if err != nil || workspace.Revision != 2 {
		t.Fatalf("workspace config CAS: revision=%d err=%v", workspace.Revision, err)
	}
	config.DefaultURL = "https://example.test/common-v2"
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
