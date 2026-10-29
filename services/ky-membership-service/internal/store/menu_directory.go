package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/Kysion/KyaiCRM/shared/menucatalog"
	"net/url"
	"regexp"
	"strings"
)

type MenuEntry struct {
	UsageScope         string              `json:"usageScope"`
	PermissionBindings map[string][]string `json:"permissionBindings"`
	SourceVersion      int                 `json:"sourceVersion"`
	DirectoryType      string              `json:"directoryType"`
	MenuKey            string              `json:"menuKey"`
	NodeType           string              `json:"nodeType"`
	ParentKey          *string             `json:"parentKey,omitempty"`
	Name               string              `json:"name"`
	Icon               string              `json:"icon"`
	PermissionCode     string              `json:"permissionCode"`
	WorkspaceTypes     []string            `json:"workspaceTypes"`
	RouteKey           *string             `json:"routeKey,omitempty"`
	RoutePath          *string             `json:"routePath,omitempty"`
	PageType           string              `json:"pageType"`
	Status             string              `json:"status"`
	SortOrder          int                 `json:"sortOrder"`
	Revision           int64               `json:"revision"`
}

type MenuEntryInput struct {
	MenuEntry
	ExpectedRevision *int64 `json:"expectedRevision"`
}

type MenuWebViewConfig struct {
	DirectoryType string            `json:"directoryType"`
	MenuKey       string            `json:"menuKey"`
	ConfigScope   string            `json:"configScope"`
	WorkspaceType string            `json:"workspaceType"`
	WorkspaceID   string            `json:"workspaceId"`
	Platform      string            `json:"platform"`
	DefaultURL    string            `json:"defaultUrl"`
	OpenMode      string            `json:"openMode"`
	Protocols     []string          `json:"navigationProtocols"`
	Scripts       []MenuResourceRef `json:"scripts"`
	Styles        []MenuResourceRef `json:"styles"`
	ScheduleMode  string            `json:"scheduleMode"`
	Revision      int64             `json:"revision"`
	Inherited     bool              `json:"inherited,omitempty"`
}

type MenuResourceRef struct {
	Identifier    string `json:"identifier"`
	VersionPolicy string `json:"versionPolicy"`
	VersionID     string `json:"versionId,omitempty"`
	Version       string `json:"version,omitempty"`
}

type MenuWebViewConfigInput struct {
	ExpectedScopeRevision *int64            `json:"expectedScopeRevision"`
	Platform              string            `json:"platform"`
	DefaultURL            string            `json:"defaultUrl"`
	OpenMode              string            `json:"openMode"`
	Protocols             []string          `json:"navigationProtocols"`
	Scripts               []MenuResourceRef `json:"scripts"`
	Styles                []MenuResourceRef `json:"styles"`
	ScheduleMode          string            `json:"scheduleMode"`
	ExpectedRevision      *int64            `json:"expectedRevision"`
}

var menuKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,127}$`)
var menuPermissionPattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,191}$`)
var menuIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
var menuVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
var menuRoutePattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,127}$`)
var menuRunAtValues = map[string]bool{"document_start": true, "dom_content_loaded": true, "document_idle": true, "load": true, "spa_route_change": true, "user_action": true}
var menuPlatformPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

func ValidMenuDirectoryType(value string) bool { return value == "management" || value == "workbench" }

func ValidateMenuEntryInput(in MenuEntryInput) error {
	if !ValidMenuDirectoryType(in.DirectoryType) || !menuKeyPattern.MatchString(in.MenuKey) || (in.NodeType != "group" && in.NodeType != "leaf") || strings.TrimSpace(in.Name) == "" || len([]rune(in.Name)) > 80 || (in.PermissionCode != "" && !menuPermissionPattern.MatchString(in.PermissionCode)) {
		return ErrValidation
	}
	if in.PageType != "internal" && in.PageType != "webview" || in.Status != "active" && in.Status != "disabled" || in.SortOrder < -100000 || in.SortOrder > 100000 {
		return ErrValidation
	}
	if in.NodeType == "group" && (in.RouteKey != nil || in.RoutePath != nil || in.PageType != "internal") {
		return ErrValidation
	}
	if in.PageType == "webview" && (in.NodeType != "leaf" || in.RoutePath != nil) {
		return ErrValidation
	}
	if in.ParentKey != nil && (!menuKeyPattern.MatchString(*in.ParentKey) || *in.ParentKey == in.MenuKey) {
		return ErrValidation
	}
	if in.NodeType == "leaf" && in.PageType == "internal" && (in.RouteKey == nil || strings.TrimSpace(*in.RouteKey) == "") {
		return ErrValidation
	}
	if in.RouteKey != nil && (!menuRoutePattern.MatchString(*in.RouteKey) || (in.PageType == "internal" && !menucatalog.InternalRouteAllowed(in.DirectoryType, *in.RouteKey))) {
		return ErrValidation
	}
	if in.RoutePath != nil && (!strings.HasPrefix(*in.RoutePath, "/") || strings.HasPrefix(*in.RoutePath, "//") || strings.ContainsAny(*in.RoutePath, "?#\\\\") || strings.Contains(*in.RoutePath, "..")) {
		return ErrValidation
	}
	if len(in.WorkspaceTypes) == 0 || len(in.WorkspaceTypes) > 3 {
		return ErrValidation
	}
	seen := map[string]bool{}
	for _, item := range in.WorkspaceTypes {
		if (item != "platform" && item != "agency" && item != "enterprise") || seen[item] {
			return ErrValidation
		}
		seen[item] = true
	}
	if in.ExpectedRevision != nil && *in.ExpectedRevision < 0 {
		return ErrValidation
	}
	return nil
}

func ValidateMenuWebViewConfig(in MenuWebViewConfigInput) error {
	parsed, err := url.Parse(strings.TrimSpace(in.DefaultURL))
	if err != nil || parsed == nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || strings.ContainsAny(in.DefaultURL, "\r\n") || len(in.DefaultURL) > 4096 {
		return ErrValidation
	}
	if in.OpenMode != "embedded" && in.OpenMode != "window" {
		return ErrValidation
	}
	if !menuPlatformPattern.MatchString(in.Platform) {
		return ErrValidation
	}
	if in.ScheduleMode != "page_first" && in.ScheduleMode != "strict_document_start" {
		return ErrValidation
	}
	if len(in.Protocols) == 0 || len(in.Protocols) > 8 {
		return ErrValidation
	}
	for _, p := range in.Protocols {
		if p != "https" && p != "http" && p != "wss" {
			return ErrValidation
		}
	}
	for _, refs := range [][]MenuResourceRef{in.Scripts, in.Styles} {
		if len(refs) > 32 {
			return ErrValidation
		}
		seen := map[string]bool{}
		for _, ref := range refs {
			if !menuIdentifierPattern.MatchString(ref.Identifier) || seen[ref.Identifier] {
				return ErrValidation
			}
			seen[ref.Identifier] = true
			if ref.VersionPolicy != "pinned" && ref.VersionPolicy != "latest_released" {
				return ErrValidation
			}
			if ref.VersionPolicy == "pinned" && (ref.VersionID == "" || !menuVersionPattern.MatchString(ref.Version)) {
				return ErrValidation
			}
			if ref.VersionPolicy == "latest_released" && (ref.VersionID != "" || ref.Version != "") {
				return ErrValidation
			}
		}
	}
	if in.ExpectedRevision != nil && *in.ExpectedRevision < 0 {
		return ErrValidation
	}
	return nil
}

const menuEntryColumns = `directory_type,menu_key,node_type,parent_key,name,icon,permission_code,workspace_types,route_key,route_path,page_type,status,sort_order,revision,permission_bindings,source_version`

func scanMenuEntry(row interface{ Scan(...any) error }) (MenuEntry, error) {
	var m MenuEntry
	var workspaceJSON, bindingJSON []byte
	err := row.Scan(&m.DirectoryType, &m.MenuKey, &m.NodeType, &m.ParentKey, &m.Name, &m.Icon, &m.PermissionCode, &workspaceJSON, &m.RouteKey, &m.RoutePath, &m.PageType, &m.Status, &m.SortOrder, &m.Revision, &bindingJSON, &m.SourceVersion)
	if err == nil {
		m.UsageScope = "browser_and_client"
		if m.PageType == "webview" {
			m.UsageScope = "client_only"
		}
		_ = json.Unmarshal(bindingJSON, &m.PermissionBindings)
		if json.Unmarshal(workspaceJSON, &m.WorkspaceTypes) != nil || m.WorkspaceTypes == nil {
			m.WorkspaceTypes = []string{}
		}
	}
	return m, err
}

func (s *Store) ListMenuDirectory(ctx context.Context, directory, workspaceType string, includeDisabled bool) ([]MenuEntry, error) {
	if !ValidMenuDirectoryType(directory) {
		return nil, ErrValidation
	}
	status := "status='active'"
	if includeDisabled {
		status = "status IN ('active','disabled')"
	}
	workspaceFilter := `["` + workspaceType + `"]`
	if workspaceType == "all" {
		workspaceFilter = "[]"
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+menuEntryColumns+` FROM ky_menu_directory WHERE directory_type=$1 AND `+status+` AND workspace_types @> $2::jsonb ORDER BY sort_order,menu_key`, directory, workspaceFilter)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MenuEntry{}
	for rows.Next() {
		m, e := scanMenuEntry(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetMenuEntry(ctx context.Context, directory, key string) (MenuEntry, error) {
	m, e := scanMenuEntry(s.db.QueryRowContext(ctx, `SELECT `+menuEntryColumns+` FROM ky_menu_directory WHERE directory_type=$1 AND menu_key=$2`, directory, key))
	if e == sql.ErrNoRows {
		return MenuEntry{}, ErrNotFound
	}
	return m, e
}

func (s *Store) SaveMenuEntry(ctx context.Context, in MenuEntryInput, actor string) (MenuEntry, error) {
	if err := ValidateMenuEntryInput(in); err != nil {
		return MenuEntry{}, err
	}
	workspaceJSON, _ := json.Marshal(in.WorkspaceTypes)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MenuEntry{}, err
	}
	defer tx.Rollback()
	// Serialize tree mutations per directory so parent/workspace checks and the
	// resulting write observe one consistent menu tree.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('ky_menu_directory'),hashtext($1))`, in.DirectoryType); err != nil {
		return MenuEntry{}, err
	}
	if in.NodeType == "leaf" && in.PageType == "webview" && in.PermissionCode == "" && len(in.PermissionBindings) == 0 {
		return MenuEntry{}, ErrValidation
	}
	if in.PermissionCode != "" && len(in.PermissionBindings) == 0 {
		var permissionCount int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM ky_permission WHERE code=$1 AND category='menu' AND status='normal' AND workspace_types @> $2::jsonb`, in.PermissionCode, workspaceJSON).Scan(&permissionCount); err != nil {
			return MenuEntry{}, err
		}
		if permissionCount != 1 {
			return MenuEntry{}, ErrValidation
		}
	}
	// Internal bindings are supplied by the trusted route manifest, not by the renderer.
	bindings := map[string][]string{}
	if in.NodeType == "leaf" && in.PageType == "internal" {
		for _, entry := range menucatalog.Entries() {
			if entry.DirectoryType == in.DirectoryType && entry.RouteKey != nil && in.RouteKey != nil && *entry.RouteKey == *in.RouteKey {
				bindings = entry.PermissionBindings
				in.RoutePath = entry.RoutePath
				break
			}
		}
	}
	if in.NodeType == "leaf" && in.PageType == "webview" && len(in.PermissionBindings) > 0 {
		if len(in.PermissionBindings) != len(in.WorkspaceTypes) {
			return MenuEntry{}, ErrValidation
		}
		for _, workspace := range in.WorkspaceTypes {
			codes := in.PermissionBindings[workspace]
			if len(codes) == 0 || len(codes) > 8 {
				return MenuEntry{}, ErrValidation
			}
			seen := map[string]bool{}
			for _, code := range codes {
				if !menuPermissionPattern.MatchString(code) || seen[code] {
					return MenuEntry{}, ErrValidation
				}
				seen[code] = true
				var count int
				if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM ky_permission WHERE code=$1 AND category='menu' AND status='normal' AND workspace_types @> jsonb_build_array($2::text)`, code, workspace).Scan(&count); err != nil {
					return MenuEntry{}, err
				}
				if count != 1 {
					return MenuEntry{}, ErrValidation
				}
			}
			bindings[workspace] = append([]string{}, codes...)
		}
		in.PermissionCode = ""
	}
	bindingJSON, _ := json.Marshal(bindings)
	workspaceSet := map[string]bool{}
	for _, value := range in.WorkspaceTypes {
		workspaceSet[value] = true
	}
	if in.ParentKey != nil {
		var parentType string
		var parentWorkspace []byte
		err = tx.QueryRowContext(ctx, `SELECT node_type,workspace_types FROM ky_menu_directory WHERE directory_type=$1 AND menu_key=$2 FOR UPDATE`, in.DirectoryType, *in.ParentKey).Scan(&parentType, &parentWorkspace)
		if err == sql.ErrNoRows {
			return MenuEntry{}, ErrValidation
		}
		if err != nil {
			return MenuEntry{}, err
		}
		if parentType != "group" {
			return MenuEntry{}, ErrValidation
		}
		var parentTypes []string
		if json.Unmarshal(parentWorkspace, &parentTypes) != nil {
			return MenuEntry{}, ErrValidation
		}
		parentSet := map[string]bool{}
		for _, value := range parentTypes {
			parentSet[value] = true
		}
		for value := range workspaceSet {
			if !parentSet[value] {
				return MenuEntry{}, ErrValidation
			}
		}
		var cycle bool
		if err = tx.QueryRowContext(ctx, `WITH RECURSIVE ancestors(menu_key,parent_key,path,cycle) AS (
			SELECT menu_key,parent_key,ARRAY[menu_key],false FROM ky_menu_directory WHERE directory_type=$1 AND menu_key=$2
			UNION ALL
			SELECT p.menu_key,p.parent_key,a.path||p.menu_key,p.menu_key=ANY(a.path)
			FROM ky_menu_directory p JOIN ancestors a ON p.directory_type=$1 AND p.menu_key=a.parent_key
			WHERE NOT a.cycle
		) SELECT EXISTS(SELECT 1 FROM ancestors WHERE menu_key=$3)`, in.DirectoryType, *in.ParentKey, in.MenuKey).Scan(&cycle); err != nil {
			return MenuEntry{}, err
		}
		if cycle {
			return MenuEntry{}, ErrValidation
		}
	}
	if in.ExpectedRevision != nil && *in.ExpectedRevision > 0 {
		var hasChildren bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_menu_directory WHERE directory_type=$1 AND parent_key=$2)`, in.DirectoryType, in.MenuKey).Scan(&hasChildren); err != nil {
			return MenuEntry{}, err
		}
		if hasChildren {
			if in.NodeType != "group" {
				return MenuEntry{}, ErrValidation
			}
			rows, queryErr := tx.QueryContext(ctx, `SELECT workspace_types FROM ky_menu_directory WHERE directory_type=$1 AND parent_key=$2`, in.DirectoryType, in.MenuKey)
			if queryErr != nil {
				return MenuEntry{}, queryErr
			}
			for rows.Next() {
				var raw []byte
				var childTypes []string
				if scanErr := rows.Scan(&raw); scanErr != nil {
					rows.Close()
					return MenuEntry{}, scanErr
				}
				if json.Unmarshal(raw, &childTypes) != nil {
					rows.Close()
					return MenuEntry{}, ErrValidation
				}
				for _, value := range childTypes {
					if !workspaceSet[value] {
						rows.Close()
						return MenuEntry{}, ErrValidation
					}
				}
			}
			if rowsErr := rows.Err(); rowsErr != nil {
				rows.Close()
				return MenuEntry{}, rowsErr
			}
			rows.Close()
		}
	}
	if in.ExpectedRevision == nil || *in.ExpectedRevision == 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO ky_menu_directory (`+menuEntryColumns+`,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,0,$15,$15)`, in.DirectoryType, in.MenuKey, in.NodeType, in.ParentKey, strings.TrimSpace(in.Name), in.Icon, in.PermissionCode, workspaceJSON, in.RouteKey, in.RoutePath, in.PageType, in.Status, in.SortOrder, bindingJSON, actor)
	} else {
		var result sql.Result
		result, err = tx.ExecContext(ctx, `UPDATE ky_menu_directory SET node_type=$3,parent_key=$4,name=$5,icon=$6,permission_code=$7,workspace_types=$8,route_key=$9,route_path=$10,page_type=$11,status=$12,sort_order=$13,revision=revision+1,updated_by=$14,updated_at=now(),permission_bindings=$16 WHERE directory_type=$1 AND menu_key=$2 AND revision=$15`, in.DirectoryType, in.MenuKey, in.NodeType, in.ParentKey, strings.TrimSpace(in.Name), in.Icon, in.PermissionCode, workspaceJSON, in.RouteKey, in.RoutePath, in.PageType, in.Status, in.SortOrder, actor, *in.ExpectedRevision, bindingJSON)
		if err == nil {
			var affected int64
			affected, err = result.RowsAffected()
			if err == nil && affected == 0 {
				err = ErrConflict
			}
		}
	}
	if err != nil {
		return MenuEntry{}, classifyWriteErr(err)
	}
	if err = tx.Commit(); err != nil {
		return MenuEntry{}, classifyWriteErr(err)
	}
	return s.GetMenuEntry(ctx, in.DirectoryType, in.MenuKey)
}

func (s *Store) UpdateMenuStatus(ctx context.Context, directory, key, status, actor string, expected int64) error {
	if !ValidMenuDirectoryType(directory) || (status != "active" && status != "disabled") || expected < 1 {
		return ErrValidation
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('ky_menu_directory'),hashtext($1))`, directory); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `UPDATE ky_menu_directory SET status=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE directory_type=$1 AND menu_key=$2 AND revision=$5`, directory, key, status, actor, expected)
	if err != nil {
		return classifyWriteErr(err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrConflict
	}
	return tx.Commit()
}

func (s *Store) SaveMenuWebViewConfig(ctx context.Context, directory, key, workspaceType, workspaceID, scope string, in MenuWebViewConfigInput, actor string) (MenuWebViewConfig, error) {
	if !ValidMenuDirectoryType(directory) || !menuKeyPattern.MatchString(key) || (scope != "common" && scope != "workspace") || workspaceType == "" || workspaceID == "" || ValidateMenuWebViewConfig(in) != nil {
		return MenuWebViewConfig{}, ErrValidation
	}
	entry, err := s.GetMenuEntry(ctx, directory, key)
	if err != nil {
		return MenuWebViewConfig{}, err
	}
	if entry.NodeType != "leaf" || entry.PageType != "webview" {
		return MenuWebViewConfig{}, ErrValidation
	}
	if scope == "common" {
		workspaceType = "platform"
		workspaceID = "*"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MenuWebViewConfig{}, err
	}
	defer tx.Rollback()
	next, err := lockMenuScope(ctx, tx, directory, key, workspaceType, workspaceID, scope, in.ExpectedScopeRevision)
	if err != nil {
		return MenuWebViewConfig{}, err
	}
	protocolJSON, _ := json.Marshal(in.Protocols)
	scriptsJSON, _ := json.Marshal(in.Scripts)
	stylesJSON, _ := json.Marshal(in.Styles)
	if in.ExpectedRevision == nil || *in.ExpectedRevision == 0 {
		_, err := tx.ExecContext(ctx, `INSERT INTO ky_menu_webview_config(directory_type,menu_key,config_scope,workspace_type,workspace_id,platform,default_url,open_mode,navigation_protocols,script_bindings,style_bindings,schedule_mode,revision,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$14,$13,$13)`, directory, key, scope, workspaceType, workspaceID, in.Platform, in.DefaultURL, in.OpenMode, protocolJSON, scriptsJSON, stylesJSON, in.ScheduleMode, actor, next)
		if err != nil {
			return MenuWebViewConfig{}, classifyWriteErr(err)
		}
	} else {
		res, err := tx.ExecContext(ctx, `UPDATE ky_menu_webview_config SET platform=$6,default_url=$7,open_mode=$8,navigation_protocols=$9,script_bindings=$10,style_bindings=$11,schedule_mode=$12,revision=revision+1,updated_by=$13,updated_at=now() WHERE directory_type=$1 AND menu_key=$2 AND config_scope=$3 AND workspace_type=$4 AND workspace_id=$5 AND revision=$14`, directory, key, scope, workspaceType, workspaceID, in.Platform, in.DefaultURL, in.OpenMode, protocolJSON, scriptsJSON, stylesJSON, in.ScheduleMode, actor, *in.ExpectedRevision)
		if err != nil {
			return MenuWebViewConfig{}, classifyWriteErr(err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return MenuWebViewConfig{}, ErrConflict
		}
	}
	if err = advanceMenuScope(ctx, tx, directory, key, workspaceType, workspaceID, scope, actor, "saved", next); err != nil {
		return MenuWebViewConfig{}, err
	}
	if err = tx.Commit(); err != nil {
		return MenuWebViewConfig{}, err
	}
	return s.getMenuWebViewConfigAtScope(ctx, directory, key, scope, workspaceType, workspaceID)
}

func (s *Store) getMenuWebViewConfigAtScope(ctx context.Context, directory, key, scope, workspaceType, workspaceID string) (MenuWebViewConfig, error) {
	if scope == "common" {
		workspaceType, workspaceID = "platform", "*"
	}
	var m MenuWebViewConfig
	var protocols, scripts, styles []byte
	err := s.db.QueryRowContext(ctx, `SELECT directory_type,menu_key,workspace_type,workspace_id,platform,default_url,open_mode,navigation_protocols,script_bindings,style_bindings,schedule_mode,revision,config_scope FROM ky_menu_webview_config WHERE directory_type=$1 AND menu_key=$2 AND config_scope=$3 AND workspace_type=$4 AND workspace_id=$5`, directory, key, scope, workspaceType, workspaceID).Scan(&m.DirectoryType, &m.MenuKey, &m.WorkspaceType, &m.WorkspaceID, &m.Platform, &m.DefaultURL, &m.OpenMode, &protocols, &scripts, &styles, &m.ScheduleMode, &m.Revision, &m.ConfigScope)
	if err == sql.ErrNoRows {
		return MenuWebViewConfig{}, ErrNotFound
	}
	if err != nil {
		return MenuWebViewConfig{}, err
	}
	_ = json.Unmarshal(protocols, &m.Protocols)
	_ = json.Unmarshal(scripts, &m.Scripts)
	_ = json.Unmarshal(styles, &m.Styles)
	return m, nil
}

func (s *Store) GetMenuWebViewConfigAtScope(ctx context.Context, directory, key, scope, workspaceType, workspaceID string) (MenuWebViewConfig, error) {
	if !ValidMenuDirectoryType(directory) || !menuKeyPattern.MatchString(key) || (scope != "common" && scope != "workspace") {
		return MenuWebViewConfig{}, ErrValidation
	}
	return s.getMenuWebViewConfigAtScope(ctx, directory, key, scope, workspaceType, workspaceID)
}

func (s *Store) GetMenuWebViewConfig(ctx context.Context, directory, key, workspaceType, workspaceID string) (MenuWebViewConfig, error) {
	var m MenuWebViewConfig
	var protocols, scripts, styles []byte
	var scopeMarker string
	err := s.db.QueryRowContext(ctx, `SELECT directory_type,menu_key,workspace_type,workspace_id,platform,default_url,open_mode,navigation_protocols,script_bindings,style_bindings,schedule_mode,revision,config_scope FROM ky_menu_webview_config WHERE directory_type=$1 AND menu_key=$2 AND ((config_scope='workspace' AND workspace_type=$3 AND workspace_id=$4) OR (config_scope='common' AND workspace_type='platform' AND workspace_id='*')) ORDER BY CASE WHEN config_scope='workspace' THEN 0 ELSE 1 END LIMIT 1`, directory, key, workspaceType, workspaceID).Scan(&m.DirectoryType, &m.MenuKey, &m.WorkspaceType, &m.WorkspaceID, &m.Platform, &m.DefaultURL, &m.OpenMode, &protocols, &scripts, &styles, &m.ScheduleMode, &m.Revision, &scopeMarker)
	if err == sql.ErrNoRows {
		return MenuWebViewConfig{}, ErrNotFound
	}
	if err != nil {
		return MenuWebViewConfig{}, err
	}
	m.ConfigScope = scopeMarker
	m.Inherited = scopeMarker == "common"
	_ = json.Unmarshal(protocols, &m.Protocols)
	_ = json.Unmarshal(scripts, &m.Scripts)
	_ = json.Unmarshal(styles, &m.Styles)
	return m, nil
}

// MenuEntryAllowed evaluates explicit workspace bindings without guessing code prefixes.
// Empty trusted bindings mean a signed-in built-in utility page, never a custom WebView.
func MenuEntryAllowed(entry MenuEntry, workspaceType string, allowed map[string]bool) bool {
	if codes, ok := entry.PermissionBindings[workspaceType]; ok {
		for _, code := range codes {
			if allowed[code] {
				return true
			}
		}
		return false
	}
	if entry.SourceVersion > 0 && entry.NodeType == "leaf" && entry.PageType == "internal" && len(entry.PermissionBindings) == 0 {
		return true
	}
	return entry.PermissionCode != "" && allowed[entry.PermissionCode]
}
func (s *Store) MenuCatalogReady(ctx context.Context) (bool, error) {
	var ready bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_menu_catalog_baseline WHERE version=1)`).Scan(&ready)
	return ready, err
}
