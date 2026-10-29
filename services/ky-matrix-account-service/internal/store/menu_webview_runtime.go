package store

import (
	"context"
	"database/sql"
	"encoding/json"
)

// MenuWebViewRuntimeConfig is read only after the active menu permission has
// been verified for the caller's membership and workspace.
type MenuWebViewRuntimeConfig struct {
	Name                string                 `json:"name"`
	DirectoryType       string                 `json:"directoryType"`
	MenuKey             string                 `json:"menuKey"`
	Platform            string                 `json:"platform"`
	DefaultURL          string                 `json:"defaultUrl"`
	OpenMode            string                 `json:"openMode"`
	NavigationProtocols []string               `json:"navigationProtocols"`
	Scripts             []RuntimeAssetSelector `json:"scripts"`
	Styles              []RuntimeAssetSelector `json:"styles"`
	ScheduleMode        string                 `json:"scheduleMode"`
	Revision            int64                  `json:"revision"`
}

func (s *Store) ResolveMenuWebViewRuntimeConfig(ctx context.Context, membershipID, workspaceType, workspaceID, directoryType, menuKey string) (MenuWebViewRuntimeConfig, error) {
	var result MenuWebViewRuntimeConfig
	var protocols, scripts, styles []byte
	err := s.db.QueryRowContext(ctx, `
		WITH RECURSIVE menu_chain(menu_key,parent_key,node_type,status,depth,path,cycle) AS (
			SELECT d.menu_key,d.parent_key,d.node_type,d.status,0,ARRAY[d.menu_key],false
			FROM ky_menu_directory d
			WHERE d.directory_type=$1 AND d.menu_key=$2 AND d.status='active'
			  AND d.node_type='leaf' AND d.page_type='webview'
			  AND d.workspace_types @> jsonb_build_array($3::text)
			UNION ALL
			SELECT p.menu_key,p.parent_key,p.node_type,p.status,c.depth+1,c.path||p.menu_key,p.menu_key=ANY(c.path)
			FROM ky_menu_directory p JOIN menu_chain c ON p.directory_type=$1 AND p.menu_key=c.parent_key
			WHERE c.parent_key IS NOT NULL AND NOT c.cycle AND c.depth<64
			  AND p.workspace_types @> jsonb_build_array($3::text)
		), authorized AS (
			SELECT 1
			FROM ky_menu_directory d
			JOIN ky_permission p ON p.category='menu' AND p.status='normal' AND (CASE WHEN COALESCE(to_jsonb(d)->'permission_bindings','{}'::jsonb) ? $3::text THEN COALESCE(to_jsonb(d)->'permission_bindings'->$3::text,'[]'::jsonb) ? p.code ELSE p.code=d.permission_code END)
			JOIN ky_role_permission rp ON rp.permission_id=p.id
			JOIN ky_role r ON r.id=rp.role_id AND r.status='normal' AND r.deleted_at IS NULL
			JOIN ky_membership_role mr ON mr.role_id=r.id
			WHERE d.directory_type=$1 AND d.menu_key=$2 AND mr.membership_id=$5
			  AND mr.workspace_type=$3 AND mr.workspace_id=$4
			  AND r.workspace_type=$3 AND (r.workspace_id=$4 OR r.workspace_id IS NULL)
		)
		SELECT d.name,c.directory_type,c.menu_key,c.platform,c.default_url,c.open_mode,c.navigation_protocols,c.script_bindings,c.style_bindings,c.schedule_mode,c.revision
		FROM ky_menu_webview_config c
		JOIN ky_menu_directory d ON d.directory_type=c.directory_type AND d.menu_key=c.menu_key
		WHERE c.directory_type=$1 AND c.menu_key=$2
		  AND ((c.config_scope='workspace' AND c.workspace_type=$3 AND c.workspace_id=$4)
		       OR (c.config_scope='common' AND c.workspace_type='platform' AND c.workspace_id='*'))
		  AND EXISTS (SELECT 1 FROM authorized)
		  AND EXISTS (SELECT 1 FROM menu_chain)
		  AND NOT EXISTS (SELECT 1 FROM menu_chain WHERE (depth>0 AND (node_type<>'group' OR status<>'active')) OR cycle)
		  AND NOT EXISTS (SELECT 1 FROM menu_chain WHERE depth=64 AND parent_key IS NOT NULL)
		ORDER BY CASE WHEN c.config_scope='workspace' THEN 0 ELSE 1 END
		LIMIT 1`, directoryType, menuKey, workspaceType, workspaceID, membershipID).
		Scan(&result.Name, &result.DirectoryType, &result.MenuKey, &result.Platform, &result.DefaultURL, &result.OpenMode, &protocols, &scripts, &styles, &result.ScheduleMode, &result.Revision)
	if err == sql.ErrNoRows {
		return MenuWebViewRuntimeConfig{}, ErrNotFound
	}
	if err != nil {
		return MenuWebViewRuntimeConfig{}, err
	}
	if json.Unmarshal(protocols, &result.NavigationProtocols) != nil || result.NavigationProtocols == nil {
		return MenuWebViewRuntimeConfig{}, ErrValidation
	}
	if json.Unmarshal(scripts, &result.Scripts) != nil || result.Scripts == nil {
		return MenuWebViewRuntimeConfig{}, ErrValidation
	}
	if json.Unmarshal(styles, &result.Styles) != nil || result.Styles == nil {
		return MenuWebViewRuntimeConfig{}, ErrValidation
	}
	return result, nil
}
