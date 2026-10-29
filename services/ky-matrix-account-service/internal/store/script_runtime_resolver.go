package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// ResolveScriptRuntime 是平台无关的运行时资源解析器；底层资产表仍可由兼容存储提供。
func (s *Store) ResolveScriptRuntime(ctx context.Context, req ScriptRuntimeResolveRequest) ([]RuntimeAsset, error) {
	if !ValidScriptRuntimePlatform(req.Platform) {
		return nil, ErrValidation
	}
	if req.VersionPolicy == "" {
		req.VersionPolicy = "active_only"
	}
	if req.VersionPolicy != "active_only" && req.VersionPolicy != "latest_released" {
		return nil, ErrValidation
	}
	if req.PreloadBoundAssets && !HasExplicitBusinessRuntimeSelection(req) {
		// Preloading must never enumerate all workspace assets. The handler may still
		// resolve explicitly selected public resources from the same request.
		return []RuntimeAsset{}, nil
	}
	if len(req.ScriptSelectors) > 0 || len(req.StyleSelectors) > 0 || (req.PreloadBoundAssets && HasExplicitBusinessRuntimeSelection(req)) {
		seen := make(map[string]struct{}, len(req.ScriptIdentifiers)+len(req.StyleIdentifiers)+len(req.ScriptSelectors)+len(req.StyleSelectors))
		items := make([]RuntimeAsset, 0, len(req.ScriptSelectors)+len(req.StyleSelectors)+len(req.ScriptIdentifiers)+len(req.StyleIdentifiers))
		appendSelector := func(assetType string, selector *RuntimeAssetSelector) error {
			if selector == nil || selector.Identifier == "" {
				return ErrValidation
			}
			key := assetType + ":" + selector.Identifier + ":" + selector.Version
			if _, ok := seen[key]; ok {
				return nil
			}
			seen[key] = struct{}{}
			selected, err := s.resolveRuntimeAsset(ctx, req, assetType, selector)
			if err != nil {
				return err
			}
			items = append(items, selected...)
			return nil
		}
		for _, selector := range req.ScriptSelectors {
			if err := appendSelector("script", selector); err != nil {
				return nil, err
			}
		}
		for _, selector := range req.StyleSelectors {
			if err := appendSelector("style", selector); err != nil {
				return nil, err
			}
		}
		for _, identifier := range req.ScriptIdentifiers {
			if identifier == "" {
				return nil, ErrValidation
			}
			if err := appendSelector("script", &RuntimeAssetSelector{Identifier: identifier}); err != nil {
				return nil, err
			}
		}
		for _, identifier := range req.StyleIdentifiers {
			if identifier == "" {
				return nil, ErrValidation
			}
			if err := appendSelector("style", &RuntimeAssetSelector{Identifier: identifier}); err != nil {
				return nil, err
			}
		}
		if req.Script != nil && req.Script.Identifier != "" {
			if err := appendSelector("script", req.Script); err != nil {
				return nil, err
			}
		}
		if req.Style != nil && req.Style.Identifier != "" {
			if err := appendSelector("style", req.Style); err != nil {
				return nil, err
			}
		}
		sortRuntimeAssets(items)
		return dedupeRuntimeAssets(items), nil
	}
	if req.Script != nil && req.Style != nil && req.Script.Identifier != "" && req.Style.Identifier != "" && req.Script.Identifier != req.Style.Identifier {
		scriptItems, err := s.resolveRuntimeAsset(ctx, req, "script", req.Script)
		if err != nil {
			return nil, err
		}
		styleItems, err := s.resolveRuntimeAsset(ctx, req, "style", req.Style)
		if err != nil {
			return nil, err
		}
		items := append(scriptItems, styleItems...)
		sortRuntimeAssets(items)
		return items, nil
	}
	args := []any{req.WorkspaceType, req.WorkspaceID, req.Platform}
	assetJoin := func(alias, assetType, pointer string, selector *RuntimeAssetSelector) string {
		conditions := []string{"v.script_id=s.id", fmt.Sprintf("v.asset_type='%s'", assetType)}
		if req.VersionPolicy == "active_only" {
			conditions = append(conditions, "v.id=s."+pointer, "v.status='active'")
		} else {
			// active 是已发布版本的最终状态，latest_released 必须同时读取两种发布态。
			conditions = append(conditions, "v.status IN ('released','active')")
		}
		if selector != nil && selector.Version != "" {
			args = append(args, selector.Version)
			conditions = append(conditions, fmt.Sprintf("v.version=$%d", len(args)))
		}
		runAtExpr := "COALESCE(s.run_at,'document_start')"
		if assetType == "style" {
			runAtExpr = "COALESCE(v.run_at,s.run_at,'document_start')"
		}
		return "LEFT JOIN LATERAL (SELECT v.id,v.version,v.status,v.source_content,v.source_bytes,v.source_sha256," + runAtExpr + " AS run_at,COALESCE(v.priority,s.priority) AS priority,COALESCE(v.enabled,true) AS enabled FROM ky_matrix_account_douyin_script_asset_version v WHERE " + strings.Join(conditions, " AND ") + " ORDER BY v.created_at DESC,v.id DESC LIMIT 1) " + alias + " ON true"
	}
	query := `SELECT s.id,s.identifier,s.revision,s.workspace_type,s.workspace_id,s.platform,s.match_type,s.match_url,COALESCE(s.match_rules,'[]'::jsonb),s.run_at,s.priority,
COALESCE(js.id,''),COALESCE(js.version,''),COALESCE(js.status,''),COALESCE(js.source_content,''),COALESCE(js.source_bytes,0),COALESCE(js.source_sha256,''),COALESCE(js.run_at,''),COALESCE(js.priority,s.priority),COALESCE(js.enabled,true),
COALESCE(css.id,''),COALESCE(css.version,''),COALESCE(css.status,''),COALESCE(css.source_content,''),COALESCE(css.source_bytes,0),COALESCE(css.source_sha256,''),COALESCE(css.run_at,''),COALESCE(css.priority,s.priority),COALESCE(css.enabled,true)
FROM ky_matrix_account_douyin_script s ` + assetJoin("js", "script", "effective_script_asset_version_id", req.Script) + ` ` + assetJoin("css", "style", "effective_style_asset_version_id", req.Style) + `
WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.platform=$3 AND s.status='enabled' AND s.deleted_at IS NULL`
	if req.Script != nil && req.Script.Identifier != "" {
		args = append(args, req.Script.Identifier)
		query += fmt.Sprintf(" AND s.identifier=$%d", len(args))
	} else if req.Style != nil && req.Style.Identifier != "" {
		args = append(args, req.Style.Identifier)
		query += fmt.Sprintf(" AND s.identifier=$%d", len(args))
	}
	query += " ORDER BY s.run_at,s.priority,s.identifier,s.id"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RuntimeAsset, 0)
	for rows.Next() {
		var scriptID, identifier, wsType, wsID, platform, matchType, matchURL, scriptRunAt string
		var rawRules []byte
		var revision, priority int
		var jsID, jsVersion, jsStatus, jsContent, jsHash, cssID, cssVersion, cssStatus, cssContent, cssHash string
		var jsBytes, cssBytes, jsPriority, cssPriority int
		var jsRunAt, cssRunAt string
		var jsEnabled, cssEnabled bool
		if err := rows.Scan(&scriptID, &identifier, &revision, &wsType, &wsID, &platform, &matchType, &matchURL, &rawRules, &scriptRunAt, &priority, &jsID, &jsVersion, &jsStatus, &jsContent, &jsBytes, &jsHash, &jsRunAt, &jsPriority, &jsEnabled, &cssID, &cssVersion, &cssStatus, &cssContent, &cssBytes, &cssHash, &cssRunAt, &cssPriority, &cssEnabled); err != nil {
			return nil, err
		}
		rules, decodeErr := decodeRuntimeMatchRules(rawRules, matchType, matchURL)
		if decodeErr != nil {
			return nil, decodeErr
		}
		scriptMatched, scriptRules, scriptRuleFlag, matchErr := runtimeAssetSelection(req, req.Script, jsRunAt, jsEnabled, rules, matchType, matchURL)
		if matchErr != nil {
			return nil, matchErr
		}
		styleMatched, styleRules, styleRuleFlag, matchErr := runtimeAssetSelection(req, req.Style, cssRunAt, cssEnabled, rules, matchType, matchURL)
		if matchErr != nil {
			return nil, matchErr
		}
		integrityDiagnostics := make([]string, 0, 2)
		if jsID != "" && !validRuntimeAssetContentGeneric(jsContent, jsBytes, jsHash) {
			jsID = ""
			integrityDiagnostics = append(integrityDiagnostics, "invalid_script_asset_integrity")
		}
		if cssID != "" && !validRuntimeAssetContentGeneric(cssContent, cssBytes, cssHash) {
			cssID = ""
			integrityDiagnostics = append(integrityDiagnostics, "invalid_style_asset_integrity")
		}
		diagnostics := runtimeAssetDiagnostics(jsID, cssID)
		diagnostics = append(diagnostics, integrityDiagnostics...)
		if jsID != "" && scriptMatched && jsEnabled && runtimeAssetRunAtMatches(jsRunAt, req.RunAt) {
			out = append(out, RuntimeAsset{ID: jsID, ScriptID: scriptID, Identifier: identifier, EffectiveVersionID: jsID, Revision: revision, WorkspaceType: wsType, WorkspaceID: wsID, Kind: "script", AssetType: "script", Platform: platform, Version: jsVersion, Status: jsStatus, SourceContent: jsContent, Source: jsContent, SourceBytes: jsBytes, SourceSHA256: jsHash, Diagnostics: diagnostics, RunAt: jsRunAt, Priority: jsPriority, Enabled: jsEnabled, NormalizedURL: req.URL, NetworkCapabilities: DefaultNetworkCapabilities(), MatchRules: scriptRules, MatchConfiguredURLRules: scriptRuleFlag})
		}
		if cssID != "" && styleMatched && cssEnabled && runtimeAssetRunAtMatches(cssRunAt, req.RunAt) {
			out = append(out, RuntimeAsset{ID: cssID, ScriptID: scriptID, Identifier: identifier, EffectiveVersionID: cssID, Revision: revision, WorkspaceType: wsType, WorkspaceID: wsID, Kind: "style", AssetType: "style", Platform: platform, Version: cssVersion, Status: cssStatus, SourceContent: cssContent, Source: cssContent, SourceBytes: cssBytes, SourceSHA256: cssHash, Diagnostics: diagnostics, RunAt: cssRunAt, Priority: cssPriority, Enabled: cssEnabled, NormalizedURL: req.URL, NetworkCapabilities: DefaultNetworkCapabilities(), MatchRules: styleRules, MatchConfiguredURLRules: styleRuleFlag})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sortRuntimeAssets(out)
	return dedupeRuntimeAssets(out), nil
}

func (s *Store) resolveRuntimeAsset(ctx context.Context, req ScriptRuntimeResolveRequest, assetType string, selector *RuntimeAssetSelector) ([]RuntimeAsset, error) {
	if selector == nil || selector.Identifier == "" {
		return nil, ErrValidation
	}
	args := []any{req.WorkspaceType, req.WorkspaceID, req.Platform, selector.Identifier}
	conditions := []string{"v.script_id=s.id", fmt.Sprintf("v.asset_type='%s'", assetType)}
	versionPolicy := selector.VersionPolicy
	if versionPolicy == "" {
		versionPolicy = req.VersionPolicy
	}
	if versionPolicy == "active_only" {
		pointer := "effective_script_asset_version_id"
		if assetType == "style" {
			pointer = "effective_style_asset_version_id"
		}
		conditions = append(conditions, "v.id=s."+pointer, "v.status='active'")
	} else {
		// active 是已发布版本的最终状态，latest_released 必须同时读取两种发布态。
		conditions = append(conditions, "v.status IN ('released','active')")
	}
	if selector.VersionID != "" {
		args = append(args, selector.VersionID)
		conditions = append(conditions, fmt.Sprintf("v.id=$%d", len(args)))
	}
	if selector.Version != "" {
		args = append(args, selector.Version)
		conditions = append(conditions, fmt.Sprintf("v.version=$%d", len(args)))
	}
	runAtExpr := "COALESCE(s.run_at,'document_start')"
	if assetType == "style" {
		runAtExpr = "COALESCE(v.run_at,s.run_at,'document_start')"
	}
	query := `SELECT s.id,s.identifier,s.revision,s.workspace_type,s.workspace_id,s.platform,s.match_type,s.match_url,COALESCE(s.match_rules,'[]'::jsonb),s.run_at,s.priority,
v.id,v.version,v.status,v.source_content,v.source_bytes,v.source_sha256,` + runAtExpr + `,COALESCE(v.priority,s.priority),COALESCE(v.enabled,true)
FROM ky_matrix_account_douyin_script s JOIN LATERAL (SELECT v.id,v.version,v.status,v.source_content,v.source_bytes,v.source_sha256,v.run_at,v.priority,v.enabled FROM ky_matrix_account_douyin_script_asset_version v WHERE ` + strings.Join(conditions, " AND ") + ` ORDER BY v.created_at DESC,v.id DESC LIMIT 1) v ON true
WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.platform=$3 AND s.identifier=$4 AND s.status='enabled' AND s.deleted_at IS NULL
ORDER BY s.run_at,s.priority,s.identifier,s.id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RuntimeAsset, 0, 1)
	for rows.Next() {
		var scriptID, identifier, wsType, wsID, platform, matchType, matchURL, scriptRunAt string
		var rawRules []byte
		var revision, priority, assetPriority int
		var id, version, status, content, hash string
		var bytes int
		var assetRunAt string
		var enabled bool
		if err := rows.Scan(&scriptID, &identifier, &revision, &wsType, &wsID, &platform, &matchType, &matchURL, &rawRules, &scriptRunAt, &priority, &id, &version, &status, &content, &bytes, &hash, &assetRunAt, &assetPriority, &enabled); err != nil {
			return nil, err
		}
		rules, decodeErr := decodeRuntimeMatchRules(rawRules, matchType, matchURL)
		if decodeErr != nil {
			return nil, decodeErr
		}
		matched, responseRules, responseRuleFlag, matchErr := runtimeAssetSelection(req, selector, assetRunAt, enabled, rules, matchType, matchURL)
		if matchErr != nil {
			return nil, matchErr
		}
		if !matched {
			continue
		}
		if !validRuntimeAssetContentGeneric(content, bytes, hash) {
			continue
		}
		selectedPriority := assetPriority
		if selector.Priority != nil {
			selectedPriority = *selector.Priority
		}
		out = append(out, RuntimeAsset{ID: id, ScriptID: scriptID, Identifier: identifier, EffectiveVersionID: id, Revision: revision, WorkspaceType: wsType, WorkspaceID: wsID, Kind: assetType, AssetType: assetType, Platform: platform, Version: version, Status: status, SourceContent: content, Source: content, SourceBytes: bytes, SourceSHA256: hash, RunAt: assetRunAt, Priority: selectedPriority, Enabled: enabled, NormalizedURL: req.URL, NetworkCapabilities: DefaultNetworkCapabilities(), MatchRules: responseRules, MatchConfiguredURLRules: responseRuleFlag})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// runtimeAssetURLMatches keeps the bypass scoped to one explicitly selected asset.
// ID lists and nil selectors use the persisted URL rules by default.
func runtimeAssetURLMatches(selector *RuntimeAssetSelector, rules []RuntimeMatchRule, legacyType, legacyURL, candidate string) (bool, error) {
	if selector != nil && selector.MatchConfiguredURLRules != nil && !*selector.MatchConfiguredURLRules {
		return true, nil
	}
	return matchRuntimeRules(rules, legacyType, legacyURL, candidate)
}

func HasExplicitBusinessRuntimeSelection(req ScriptRuntimeResolveRequest) bool {
	if len(req.ScriptSelectors)+len(req.StyleSelectors)+len(req.ScriptIdentifiers)+len(req.StyleIdentifiers) > 0 {
		return true
	}
	return (req.Script != nil && req.Script.Identifier != "") || (req.Style != nil && req.Style.Identifier != "")
}

func runtimeAssetSelection(req ScriptRuntimeResolveRequest, selector *RuntimeAssetSelector, assetRunAt string, enabled bool, rules []RuntimeMatchRule, legacyType, legacyURL string) (bool, []RuntimeMatchRule, *bool, error) {
	if !enabled || (selector != nil && selector.Enabled != nil && !*selector.Enabled) || (selector != nil && selector.RunAt != "" && selector.RunAt != assetRunAt) || !runtimeAssetRunAtMatches(assetRunAt, req.RunAt) {
		return false, nil, nil, nil
	}
	if req.PreloadBoundAssets {
		if assetRunAt != "document_start" {
			return false, nil, nil, nil
		}
		if len(rules) == 0 {
			rules = nil
		}
		normalized, err := normalizeRuntimeMatchRules(rules, legacyType, legacyURL)
		if err != nil {
			return false, nil, nil, err
		}
		flag := selector == nil || selector.MatchConfiguredURLRules == nil || *selector.MatchConfiguredURLRules
		if !flag {
			return true, []RuntimeMatchRule{}, boolPointer(false), nil
		}
		return true, enabledRuntimeMatchRules(normalized), boolPointer(true), nil
	}
	matched, err := runtimeAssetURLMatches(selector, rules, legacyType, legacyURL, req.URL)
	if err != nil || !matched {
		return matched, nil, nil, err
	}
	flag := selector == nil || selector.MatchConfiguredURLRules == nil || *selector.MatchConfiguredURLRules
	if !flag {
		return true, []RuntimeMatchRule{}, boolPointer(false), nil
	}
	if len(rules) == 0 && legacyType != "" && legacyURL != "" {
		rules = []RuntimeMatchRule{{ID: "legacy", MatchType: legacyType, Pattern: legacyURL, Enabled: true}}
	}
	return true, enabledRuntimeMatchRules(rules), boolPointer(true), nil
}

func enabledRuntimeMatchRules(rules []RuntimeMatchRule) []RuntimeMatchRule {
	out := make([]RuntimeMatchRule, 0, len(rules))
	for _, rule := range rules {
		if rule.Enabled {
			out = append(out, rule)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func boolPointer(value bool) *bool { return &value }

func runtimeAssetRunAtMatches(assetRunAt, requestedRunAt string) bool {
	return requestedRunAt == "" || assetRunAt == requestedRunAt
}

func validRuntimeAssetContentGeneric(content string, bytes int, expectedHash string) bool {
	if bytes != len([]byte(content)) || len(expectedHash) != sha256.Size*2 {
		return false
	}
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:]) == expectedHash
}

// ValidRuntimeAssetContent verifies the UTF-8 byte length and SHA-256 of runtime source.
func ValidRuntimeAssetContent(content string, bytes int, expectedHash string) bool {
	return validRuntimeAssetContentGeneric(content, bytes, expectedHash)
}

func runtimeAssetDiagnostics(scriptID, styleID string) []string {
	diagnostics := make([]string, 0, 2)
	if scriptID == "" {
		diagnostics = append(diagnostics, "missing_active_script_asset")
	}
	if styleID == "" {
		diagnostics = append(diagnostics, "missing_active_style_asset")
	}
	return diagnostics
}

func sortRuntimeAssets(items []RuntimeAsset) {
	sort.SliceStable(items, func(i, j int) bool {
		left, right := items[i], items[j]
		if scriptRuntimeRunAtOrder[left.RunAt] != scriptRuntimeRunAtOrder[right.RunAt] {
			return scriptRuntimeRunAtOrder[left.RunAt] < scriptRuntimeRunAtOrder[right.RunAt]
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Kind != right.Kind {
			return left.Kind == "style"
		}
		if left.ScriptID != right.ScriptID {
			return left.ScriptID < right.ScriptID
		}
		return left.ID < right.ID
	})
}

func dedupeRuntimeAssets(items []RuntimeAsset) []RuntimeAsset {
	seen := make(map[string]struct{}, len(items))
	out := make([]RuntimeAsset, 0, len(items))
	for _, item := range items {
		key := item.AssetType + "\x00" + item.Identifier + "\x00" + item.EffectiveVersionID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}
