package store

import (
	"context"
	"sort"
	"strconv"
	"unicode/utf8"
)

type PublicRuntimeStyle struct {
	ID                      string             `json:"id"`
	Identifier              string             `json:"identifier"`
	Platform                string             `json:"platform"`
	Version                 string             `json:"version"`
	SourceContent           string             `json:"sourceContent"`
	SourceBytes             int                `json:"sourceBytes"`
	SourceChars             int                `json:"sourceChars"`
	SourceSHA256            string             `json:"sourceSha256"`
	RunAt                   string             `json:"runAt"`
	Priority                int                `json:"priority"`
	Enabled                 bool               `json:"enabled"`
	NetworkCapabilities     []string           `json:"networkCapabilities"`
	MatchRules              []RuntimeMatchRule `json:"matchRules,omitempty"`
	MatchConfiguredURLRules *bool              `json:"matchConfiguredUrlRules,omitempty"`
}

func (s *Store) ResolvePublicStyles(ctx context.Context, wsType, wsID, platform, url string, roots []string) ([]PublicRuntimeStyle, error) {
	return s.ResolvePublicStylesWithOptions(ctx, wsType, wsID, platform, url, roots, false)
}

// ResolvePublicStylesWithOptions preserves URL filtering for existing calls. Preload mode
// requires explicit roots and returns only document_start styles with validated rules.
func (s *Store) ResolvePublicStylesWithOptions(ctx context.Context, wsType, wsID, platform, url string, roots []string, preloadBoundAssets bool) ([]PublicRuntimeStyle, error) {
	if preloadBoundAssets && len(roots) == 0 {
		return []PublicRuntimeStyle{}, nil
	}
	query := "SELECT id,identifier,platform,revision,source_content,source_chars,source_bytes,source_sha256,match_type,match_url,run_at,priority,enabled FROM ky_matrix_account_public_style WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND enabled AND status='enabled' AND deleted_at IS NULL"
	args := []any{wsType, wsID, platform}
	if preloadBoundAssets {
		query += " AND identifier = ANY($4)"
		args = append(args, roots)
	}
	query += " ORDER BY identifier,id"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	wanted := make(map[string]bool, len(roots))
	for _, id := range roots {
		wanted[id] = true
	}
	out := make([]PublicRuntimeStyle, 0)
	for rows.Next() {
		var item PublicRuntimeStyle
		var revision int
		var matchType, pattern string
		if err := rows.Scan(&item.ID, &item.Identifier, &item.Platform, &revision, &item.SourceContent, &item.SourceChars, &item.SourceBytes, &item.SourceSHA256, &matchType, &pattern, &item.RunAt, &item.Priority, &item.Enabled); err != nil {
			return nil, err
		}
		if len(wanted) > 0 && !wanted[item.Identifier] {
			continue
		}
		if preloadBoundAssets && !validPublicStyleRuntimeContent(item.SourceContent, item.SourceChars, item.SourceBytes, item.SourceSHA256) {
			continue
		}
		matched, rules, ruleFlag, err := publicStyleRuntimeSelection(preloadBoundAssets, item.RunAt, matchType, pattern, url)
		if err != nil {
			return nil, err
		}
		if !matched {
			continue
		}
		item.MatchRules = rules
		item.MatchConfiguredURLRules = ruleFlag
		item.Version = strconv.Itoa(revision)
		item.NetworkCapabilities = DefaultNetworkCapabilities()
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority < out[j].Priority
		}
		return out[i].Identifier < out[j].Identifier
	})
	return out, nil
}

func validPublicStyleRuntimeContent(content string, chars, bytes int, expectedHash string) bool {
	return utf8.RuneCountInString(content) == chars && validRuntimeAssetContentGeneric(content, bytes, expectedHash)
}

func publicStyleRuntimeSelection(preload bool, runAt, matchType, pattern, url string) (bool, []RuntimeMatchRule, *bool, error) {
	if matchType != "exact" && matchType != "wildcard" {
		return false, nil, nil, ErrValidation
	}
	if preload {
		if runAt != "document_start" {
			return false, nil, nil, nil
		}
		rules, err := normalizeRuntimeMatchRules([]RuntimeMatchRule{{ID: "legacy", MatchType: matchType, Pattern: pattern, Enabled: true, SortOrder: 0}}, "", "")
		if err != nil {
			return false, nil, nil, err
		}
		return true, enabledRuntimeMatchRules(rules), boolPointer(true), nil
	}
	rules, err := normalizeRuntimeMatchRules([]RuntimeMatchRule{{ID: "legacy", MatchType: matchType, Pattern: pattern, Enabled: true, SortOrder: 0}}, "", "")
	if err != nil {
		return false, nil, nil, err
	}
	matched, err := matchRuntimeRules(rules, "", "", url)
	return matched, enabledRuntimeMatchRules(rules), boolPointer(true), err
}
