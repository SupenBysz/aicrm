package store

import (
	"context"
	"strconv"
)

// ListScriptRuntimeManifest 返回工作区/平台的全部已发布资产元数据，不做 URL 匹配。
func (s *Store) ListScriptRuntimeManifest(ctx context.Context, req ScriptRuntimeManifestRequest) (ScriptRuntimeManifest, error) {
	policy := req.VersionPolicy
	if policy == "" {
		policy = "latest_released"
	}
	if policy != "active_only" && policy != "latest_released" {
		return ScriptRuntimeManifest{}, ErrValidation
	}
	assetFilter := "v.status IN ('released','active')"
	if policy == "active_only" {
		assetFilter = "v.status='active' AND ((v.asset_type='script' AND v.id=s.effective_script_asset_version_id) OR (v.asset_type='style' AND v.id=s.effective_style_asset_version_id))"
	}
	query := `SELECT s.identifier,v.asset_type,v.version,v.id,
CASE WHEN v.asset_type='script' THEN COALESCE(s.effective_script_asset_version_id,'') ELSE COALESCE(s.effective_style_asset_version_id,'') END,
CASE WHEN v.asset_type='script' THEN COALESCE(s.run_at,'document_start') ELSE COALESCE(v.run_at,s.run_at,'document_start') END,
COALESCE(v.priority,s.priority),COALESCE(v.enabled,true),v.source_sha256,v.status,s.match_type,s.match_url,COALESCE(s.match_rules,'[]'::jsonb)
FROM ky_matrix_account_douyin_script s JOIN ky_matrix_account_douyin_script_asset_version v ON v.script_id=s.id
WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.platform=$3 AND s.status='enabled' AND s.deleted_at IS NULL AND ` + assetFilter + `
AND v.id=(SELECT latest.id FROM ky_matrix_account_douyin_script_asset_version latest WHERE latest.script_id=s.id AND latest.asset_type=v.asset_type AND ` + assetFilterForLatest(policy) + ` ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
ORDER BY s.identifier,v.asset_type,v.version,v.id`
	rows, err := s.db.QueryContext(ctx, query, req.WorkspaceType, req.WorkspaceID, req.Platform)
	if err != nil {
		return ScriptRuntimeManifest{}, err
	}
	defer rows.Close()
	assets := make([]ScriptRuntimeManifestAsset, 0)
	for rows.Next() {
		var item ScriptRuntimeManifestAsset
		var assetID, matchType, matchURL string
		var rawRules []byte
		if err := rows.Scan(&item.Identifier, &item.AssetType, &item.Version, &assetID, &item.EffectiveVersionID, &item.RunAt, &item.Priority, &item.Enabled, &item.SourceSHA256, &item.Status, &matchType, &matchURL, &rawRules); err != nil {
			return ScriptRuntimeManifest{}, err
		}
		rules, err := decodeRuntimeMatchRules(rawRules, matchType, matchURL)
		if err != nil {
			return ScriptRuntimeManifest{}, err
		}
		if len(rules) == 0 {
			rules = nil
		}
		normalizedRules, err := normalizeRuntimeMatchRules(rules, matchType, matchURL)
		if err != nil {
			return ScriptRuntimeManifest{}, err
		}
		item.MatchRules = enabledRuntimeMatchRules(normalizedRules)
		assets = append(assets, item)
	}
	if err := rows.Err(); err != nil {
		return ScriptRuntimeManifest{}, err
	}

	publicRows, err := s.db.QueryContext(ctx, `SELECT id,identifier,revision,source_sha256,enabled FROM ky_matrix_account_public_script WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND deleted_at IS NULL ORDER BY identifier,id`, req.WorkspaceType, req.WorkspaceID, req.Platform)
	if err != nil {
		return ScriptRuntimeManifest{}, err
	}
	defer publicRows.Close()
	public := make([]ScriptRuntimeManifestPublic, 0)
	for publicRows.Next() {
		var item ScriptRuntimeManifestPublic
		var publicID string
		var revision int
		if err := publicRows.Scan(&publicID, &item.Identifier, &revision, &item.SourceSHA256, &item.Enabled); err != nil {
			return ScriptRuntimeManifest{}, err
		}
		item.AssetType, item.EffectiveVersionID, item.RunAt, item.Priority = "public", publicID, "document_start", 0
		item.Version = strconv.Itoa(revision)
		if item.Enabled {
			item.Status = "enabled"
		} else {
			item.Status = "disabled"
		}
		public = append(public, item)
	}
	if err := publicRows.Err(); err != nil {
		return ScriptRuntimeManifest{}, err
	}

	styleRows, err := s.db.QueryContext(ctx, `SELECT id,identifier,revision,source_sha256,match_type,match_url,run_at,priority,enabled,status FROM ky_matrix_account_public_style WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND deleted_at IS NULL AND status=$4 ORDER BY identifier,id`, req.WorkspaceType, req.WorkspaceID, req.Platform, "enabled")
	if err != nil {
		return ScriptRuntimeManifest{}, err
	}
	defer styleRows.Close()
	publicStyles := make([]ScriptRuntimeManifestPublicStyle, 0)
	for styleRows.Next() {
		var item ScriptRuntimeManifestPublicStyle
		var id, matchType, matchURL string
		var revision int
		if err := styleRows.Scan(&id, &item.Identifier, &revision, &item.SourceSHA256, &matchType, &matchURL, &item.RunAt, &item.Priority, &item.Enabled, &item.Status); err != nil {
			return ScriptRuntimeManifest{}, err
		}
		rules, err := normalizeRuntimeMatchRules([]RuntimeMatchRule{{ID: "legacy", MatchType: matchType, Pattern: matchURL, Enabled: true, SortOrder: 0}}, "", "")
		if err != nil {
			return ScriptRuntimeManifest{}, err
		}
		item.MatchRules = enabledRuntimeMatchRules(rules)
		if req.Origin != "" {
			matched, err := matchRuntimeRules(rules, "", "", req.Origin)
			if err != nil {
				return ScriptRuntimeManifest{}, err
			}
			if !matched {
				continue
			}
		}
		item.AssetType = "public-style"
		item.EffectiveVersionID = id
		item.Version = strconv.Itoa(revision)
		publicStyles = append(publicStyles, item)
	}
	if err := styleRows.Err(); err != nil {
		return ScriptRuntimeManifest{}, err
	}

	revision := ScriptRuntimeManifestRevisionForManifest(req, assets, public, publicStyles)
	return ScriptRuntimeManifest{
		SchemaVersion:    "1",
		WorkspaceType:    req.WorkspaceType,
		WorkspaceID:      req.WorkspaceID,
		Platform:         req.Platform,
		VersionPolicy:    policy,
		ManifestRevision: revision,
		Assets:           assets,
		Public:           public,
		PublicStyles:     publicStyles,
	}, nil
}

func assetFilterForLatest(policy string) string {
	if policy == "active_only" {
		return "latest.status='active' AND ((latest.asset_type='script' AND latest.id=s.effective_script_asset_version_id) OR (latest.asset_type='style' AND latest.id=s.effective_style_asset_version_id))"
	}
	return "latest.status IN ('released','active')"
}
