package store

import "context"

type MenuResourceOption struct {
	Identifier string `json:"identifier"`
	Name       string `json:"name"`
	AssetType  string `json:"assetType"`
	VersionID  string `json:"versionId"`
	Version    string `json:"version"`
}

// Metadata only: configuring a binding does not require disclosing source code.
func (s *Store) ListMenuResourceOptions(ctx context.Context, workspaceType, workspaceID, platform string) ([]MenuResourceOption, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT s.identifier,s.name,v.asset_type,v.id,v.version FROM ky_matrix_account_douyin_script s JOIN ky_matrix_account_douyin_script_asset_version v ON v.script_id=s.id WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.platform=$3 AND s.status='enabled' AND s.deleted_at IS NULL AND v.status IN ('released','active') AND COALESCE(v.enabled,true) ORDER BY s.identifier,v.created_at DESC,v.id LIMIT 1000`, workspaceType, workspaceID, platform)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MenuResourceOption{}
	for rows.Next() {
		var option MenuResourceOption
		if err = rows.Scan(&option.Identifier, &option.Name, &option.AssetType, &option.VersionID, &option.Version); err != nil {
			return nil, err
		}
		out = append(out, option)
	}
	return out, rows.Err()
}
