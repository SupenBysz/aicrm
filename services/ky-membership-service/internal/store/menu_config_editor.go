package store

import (
	"context"
	"database/sql"
	"encoding/json"
)

type MenuConfigEditor struct {
	Config        *MenuWebViewConfig `json:"config"`
	ScopeRevision int64              `json:"scopeRevision"`
	Scope         string             `json:"scope"`
	HasOverride   bool               `json:"hasOverride"`
}

// Read metadata and config from one database snapshot, so a newer revision can
// never be attached to an older form value.
func (s *Store) GetMenuConfigEditor(ctx context.Context, directory, key, workspaceType, workspaceID, scope string) (MenuConfigEditor, error) {
	out := MenuConfigEditor{Scope: scope}
	if !ValidMenuDirectoryType(directory) || !menuKeyPattern.MatchString(key) || (scope != "common" && scope != "workspace") {
		return out, ErrValidation
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	targetType, targetID := workspaceType, workspaceID
	if scope == "common" {
		targetType, targetID = "platform", "*"
	}
	err = tx.QueryRowContext(ctx, `SELECT revision FROM ky_menu_webview_scope_revision WHERE directory_type=$1 AND menu_key=$2 AND config_scope=$3 AND workspace_type=$4 AND workspace_id=$5`, directory, key, scope, targetType, targetID).Scan(&out.ScopeRevision)
	if err != nil && err != sql.ErrNoRows {
		return out, err
	}
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_menu_webview_config WHERE directory_type=$1 AND menu_key=$2 AND config_scope=$3 AND workspace_type=$4 AND workspace_id=$5)`, directory, key, scope, targetType, targetID).Scan(&out.HasOverride); err != nil {
		return out, err
	}
	var m MenuWebViewConfig
	var protocols, scripts, styles []byte
	err = tx.QueryRowContext(ctx, `SELECT directory_type,menu_key,workspace_type,workspace_id,platform,default_url,open_mode,navigation_protocols,script_bindings,style_bindings,schedule_mode,revision,config_scope FROM ky_menu_webview_config WHERE directory_type=$1 AND menu_key=$2 AND ((config_scope=$3 AND workspace_type=$4 AND workspace_id=$5) OR ($3='workspace' AND config_scope='common' AND workspace_type='platform' AND workspace_id='*')) ORDER BY CASE WHEN config_scope=$3 THEN 0 ELSE 1 END LIMIT 1`, directory, key, scope, targetType, targetID).Scan(&m.DirectoryType, &m.MenuKey, &m.WorkspaceType, &m.WorkspaceID, &m.Platform, &m.DefaultURL, &m.OpenMode, &protocols, &scripts, &styles, &m.ScheduleMode, &m.Revision, &m.ConfigScope)
	if err != nil && err != sql.ErrNoRows {
		return out, err
	}
	if err == nil {
		_ = json.Unmarshal(protocols, &m.Protocols)
		_ = json.Unmarshal(scripts, &m.Scripts)
		_ = json.Unmarshal(styles, &m.Styles)
		m.Inherited = scope == "workspace" && m.ConfigScope == "common"
		out.Config = &m
	}
	return out, tx.Commit()
}

func lockMenuScope(ctx context.Context, tx *sql.Tx, directory, key, workspaceType, workspaceID, scope string, expected *int64) (int64, error) {
	if expected == nil || *expected < 0 {
		return 0, ErrValidation
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO ky_menu_webview_scope_revision(directory_type,menu_key,config_scope,workspace_type,workspace_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, directory, key, scope, workspaceType, workspaceID)
	if err != nil {
		return 0, err
	}
	var revision int64
	err = tx.QueryRowContext(ctx, `SELECT revision FROM ky_menu_webview_scope_revision WHERE directory_type=$1 AND menu_key=$2 AND config_scope=$3 AND workspace_type=$4 AND workspace_id=$5 FOR UPDATE`, directory, key, scope, workspaceType, workspaceID).Scan(&revision)
	if err != nil {
		return 0, err
	}
	if revision != *expected {
		return 0, ErrConflict
	}
	return revision + 1, nil
}
func advanceMenuScope(ctx context.Context, tx *sql.Tx, directory, key, workspaceType, workspaceID, scope, actor, action string, next int64) error {
	_, err := tx.ExecContext(ctx, `UPDATE ky_menu_webview_scope_revision SET revision=$6 WHERE directory_type=$1 AND menu_key=$2 AND config_scope=$3 AND workspace_type=$4 AND workspace_id=$5`, directory, key, scope, workspaceType, workspaceID, next)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO ky_menu_webview_scope_event(directory_type,menu_key,config_scope,workspace_type,workspace_id,revision,actor_id,action) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, directory, key, scope, workspaceType, workspaceID, next, actor, action)
	return err
}
func (s *Store) ResetMenuWorkspaceConfig(ctx context.Context, directory, key, workspaceType, workspaceID, actor string, expected int64) error {
	if !ValidMenuDirectoryType(directory) || !menuKeyPattern.MatchString(key) || workspaceID == "" {
		return ErrValidation
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	next, err := lockMenuScope(ctx, tx, directory, key, workspaceType, workspaceID, "workspace", &expected)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM ky_menu_webview_config WHERE directory_type=$1 AND menu_key=$2 AND config_scope='workspace' AND workspace_type=$3 AND workspace_id=$4`, directory, key, workspaceType, workspaceID); err != nil {
		return err
	}
	if err = advanceMenuScope(ctx, tx, directory, key, workspaceType, workspaceID, "workspace", actor, "reset", next); err != nil {
		return err
	}
	return tx.Commit()
}
