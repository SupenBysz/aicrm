package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

type runtimeManifestAsset struct {
	AssetType               string             `json:"assetType"`
	Identifier              string             `json:"identifier"`
	Version                 string             `json:"version"`
	EffectiveVersionID      string             `json:"effectiveVersionId,omitempty"`
	RunAt                   string             `json:"runAt,omitempty"`
	Priority                int                `json:"priority"`
	Enabled                 bool               `json:"enabled"`
	Status                  string             `json:"status"`
	SourceSHA256            string             `json:"sourceSha256"`
	MatchRules              []RuntimeMatchRule `json:"matchRules,omitempty"`
	MatchConfiguredURLRules *bool              `json:"matchConfiguredUrlRules,omitempty"`
}

type runtimeManifestPublicAsset struct {
	AssetType               string             `json:"assetType"`
	Identifier              string             `json:"identifier"`
	Version                 string             `json:"version"`
	EffectiveVersionID      string             `json:"effectiveVersionId,omitempty"`
	RunAt                   string             `json:"runAt,omitempty"`
	Priority                int                `json:"priority"`
	Enabled                 bool               `json:"enabled"`
	Status                  string             `json:"status"`
	SourceSHA256            string             `json:"sourceSha256"`
	MatchRules              []RuntimeMatchRule `json:"matchRules,omitempty"`
	MatchConfiguredURLRules *bool              `json:"matchConfiguredUrlRules,omitempty"`
}

type runtimeManifestInput struct {
	WorkspaceType string                       `json:"workspaceType"`
	WorkspaceID   string                       `json:"workspaceId"`
	Platform      string                       `json:"platform"`
	URL           string                       `json:"url"`
	Origin        string                       `json:"origin,omitempty"`
	VersionPolicy string                       `json:"versionPolicy"`
	Assets        []runtimeManifestAsset       `json:"assets"`
	Public        []runtimeManifestPublicAsset `json:"public"`
	PublicStyles  []runtimeManifestPublicAsset `json:"publicStyles"`
}

// ScriptRuntimeManifestAsset 是不含源码的已发布资产清单项。
type ScriptRuntimeManifestAsset struct {
	AssetType          string             `json:"assetType"`
	Identifier         string             `json:"identifier"`
	Version            string             `json:"version"`
	EffectiveVersionID string             `json:"effectiveVersionId,omitempty"`
	RunAt              string             `json:"runAt,omitempty"`
	Priority           int                `json:"priority"`
	Enabled            bool               `json:"enabled"`
	SourceSHA256       string             `json:"sourceSha256"`
	Status             string             `json:"status"`
	MatchRules         []RuntimeMatchRule `json:"matchRules,omitempty"`
}

// ScriptRuntimeManifestPublic 是不含源码的公共脚本清单项。
type ScriptRuntimeManifestPublicStyle struct {
	AssetType          string             `json:"assetType"`
	Identifier         string             `json:"identifier"`
	Version            string             `json:"version"`
	EffectiveVersionID string             `json:"effectiveVersionId,omitempty"`
	RunAt              string             `json:"runAt,omitempty"`
	Priority           int                `json:"priority"`
	Enabled            bool               `json:"enabled"`
	SourceSHA256       string             `json:"sourceSha256"`
	Status             string             `json:"status"`
	MatchRules         []RuntimeMatchRule `json:"matchRules,omitempty"`
}

type ScriptRuntimeManifestPublic struct {
	AssetType          string `json:"assetType"`
	Identifier         string `json:"identifier"`
	Version            string `json:"version"`
	EffectiveVersionID string `json:"effectiveVersionId,omitempty"`
	RunAt              string `json:"runAt,omitempty"`
	Priority           int    `json:"priority"`
	Enabled            bool   `json:"enabled"`
	SourceSHA256       string `json:"sourceSha256"`
	Status             string `json:"status"`
}

// ScriptRuntimeManifest 是工作区/平台级已发布资源清单，不包含源码正文。
type ScriptRuntimeManifest struct {
	SchemaVersion    string                             `json:"schemaVersion"`
	WorkspaceType    string                             `json:"workspaceType"`
	WorkspaceID      string                             `json:"workspaceId"`
	Platform         string                             `json:"platform"`
	VersionPolicy    string                             `json:"versionPolicy"`
	ManifestRevision string                             `json:"manifestRevision"`
	Assets           []ScriptRuntimeManifestAsset       `json:"assets"`
	Public           []ScriptRuntimeManifestPublic      `json:"public"`
	PublicStyles     []ScriptRuntimeManifestPublicStyle `json:"publicStyles"`
}

// ScriptRuntimeManifestRevision returns a stable digest of the complete runtime resource set.
// It deliberately excludes source text and retrieval time so identical results remain comparable.
func ScriptRuntimeManifestRevision(req ScriptRuntimeResolveRequest, assets []RuntimeAsset, public []PublicRuntimeScript, publicStyles ...[]PublicRuntimeStyle) string {
	policy := req.VersionPolicy
	if policy == "" {
		policy = "active_only"
	}
	canonical := runtimeManifestInput{
		WorkspaceType: req.WorkspaceType,
		WorkspaceID:   req.WorkspaceID,
		Platform:      req.Platform,
		URL:           req.URL,
		VersionPolicy: policy,
		Assets:        make([]runtimeManifestAsset, 0, len(assets)),
		Public:        make([]runtimeManifestPublicAsset, 0, len(public)),
	}
	for _, asset := range assets {
		canonical.Assets = append(canonical.Assets, runtimeManifestAsset{
			AssetType:               asset.AssetType,
			Identifier:              asset.Identifier,
			Version:                 asset.Version,
			EffectiveVersionID:      asset.EffectiveVersionID,
			RunAt:                   asset.RunAt,
			Priority:                asset.Priority,
			Enabled:                 asset.Enabled,
			Status:                  asset.Status,
			SourceSHA256:            asset.SourceSHA256,
			MatchRules:              asset.MatchRules,
			MatchConfiguredURLRules: asset.MatchConfiguredURLRules,
		})
	}
	for _, asset := range public {
		canonical.Public = append(canonical.Public, runtimeManifestPublicAsset{
			AssetType:          "public",
			Identifier:         asset.Identifier,
			Version:            asset.Version,
			EffectiveVersionID: asset.ID,
			Enabled:            true,
			Status:             "enabled",
			SourceSHA256:       asset.SourceSHA256,
		})
	}
	for _, styles := range publicStyles {
		for _, asset := range styles {
			canonical.PublicStyles = append(canonical.PublicStyles, runtimeManifestPublicAsset{AssetType: "public-style", Identifier: asset.Identifier, Version: asset.Version, EffectiveVersionID: asset.ID, RunAt: asset.RunAt, Priority: asset.Priority, Enabled: asset.Enabled, Status: "enabled", SourceSHA256: asset.SourceSHA256, MatchRules: asset.MatchRules, MatchConfiguredURLRules: asset.MatchConfiguredURLRules})
		}
	}
	sort.Slice(canonical.Assets, func(i, j int) bool {
		left, right := canonical.Assets[i], canonical.Assets[j]
		if left.AssetType != right.AssetType {
			return left.AssetType < right.AssetType
		}
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		if left.EffectiveVersionID != right.EffectiveVersionID {
			return left.EffectiveVersionID < right.EffectiveVersionID
		}
		if left.RunAt != right.RunAt {
			return left.RunAt < right.RunAt
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.SourceSHA256 != right.SourceSHA256 {
			return left.SourceSHA256 < right.SourceSHA256
		}
		if boolPointerOrder(left.MatchConfiguredURLRules) != boolPointerOrder(right.MatchConfiguredURLRules) {
			return boolPointerOrder(left.MatchConfiguredURLRules) < boolPointerOrder(right.MatchConfiguredURLRules)
		}
		return runtimeMatchRulesKey(left.MatchRules) < runtimeMatchRulesKey(right.MatchRules)
	})
	sort.Slice(canonical.Public, func(i, j int) bool {
		left, right := canonical.Public[i], canonical.Public[j]
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		return left.SourceSHA256 < right.SourceSHA256
	})
	sort.Slice(canonical.PublicStyles, func(i, j int) bool {
		left, right := canonical.PublicStyles[i], canonical.PublicStyles[j]
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		if left.RunAt != right.RunAt {
			return left.RunAt < right.RunAt
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.EffectiveVersionID != right.EffectiveVersionID {
			return left.EffectiveVersionID < right.EffectiveVersionID
		}
		if left.SourceSHA256 != right.SourceSHA256 {
			return left.SourceSHA256 < right.SourceSHA256
		}
		if boolPointerOrder(left.MatchConfiguredURLRules) != boolPointerOrder(right.MatchConfiguredURLRules) {
			return boolPointerOrder(left.MatchConfiguredURLRules) < boolPointerOrder(right.MatchConfiguredURLRules)
		}
		return runtimeMatchRulesKey(left.MatchRules) < runtimeMatchRulesKey(right.MatchRules)
	})
	payload, _ := json.Marshal(canonical)
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

// ScriptRuntimeManifestRevisionForManifest 计算不依赖查询顺序的全量清单摘要。
func ScriptRuntimeManifestRevisionForManifest(req ScriptRuntimeManifestRequest, assets []ScriptRuntimeManifestAsset, public []ScriptRuntimeManifestPublic, publicStyles ...[]ScriptRuntimeManifestPublicStyle) string {
	canonical := runtimeManifestInput{
		WorkspaceType: req.WorkspaceType,
		WorkspaceID:   req.WorkspaceID,
		Platform:      req.Platform,
		Origin:        req.Origin,
		URL:           req.Origin,
		VersionPolicy: req.VersionPolicy,
	}
	for _, asset := range assets {
		canonical.Assets = append(canonical.Assets, runtimeManifestAsset{AssetType: asset.AssetType, Identifier: asset.Identifier, Version: asset.Version, EffectiveVersionID: asset.EffectiveVersionID, RunAt: asset.RunAt, Priority: asset.Priority, Enabled: asset.Enabled, Status: asset.Status, SourceSHA256: asset.SourceSHA256, MatchRules: asset.MatchRules})
	}
	for _, asset := range public {
		canonical.Public = append(canonical.Public, runtimeManifestPublicAsset{AssetType: asset.AssetType, Identifier: asset.Identifier, Version: asset.Version, EffectiveVersionID: asset.EffectiveVersionID, RunAt: asset.RunAt, Priority: asset.Priority, Enabled: asset.Enabled, Status: asset.Status, SourceSHA256: asset.SourceSHA256})
	}
	for _, styles := range publicStyles {
		for _, asset := range styles {
			canonical.PublicStyles = append(canonical.PublicStyles, runtimeManifestPublicAsset{AssetType: asset.AssetType, Identifier: asset.Identifier, Version: asset.Version, EffectiveVersionID: asset.EffectiveVersionID, RunAt: asset.RunAt, Priority: asset.Priority, Enabled: asset.Enabled, Status: asset.Status, SourceSHA256: asset.SourceSHA256, MatchRules: asset.MatchRules})
		}
	}
	sort.Slice(canonical.Assets, func(i, j int) bool {
		left, right := canonical.Assets[i], canonical.Assets[j]
		if left.AssetType != right.AssetType {
			return left.AssetType < right.AssetType
		}
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		if left.EffectiveVersionID != right.EffectiveVersionID {
			return left.EffectiveVersionID < right.EffectiveVersionID
		}
		if left.RunAt != right.RunAt {
			return left.RunAt < right.RunAt
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.Enabled != right.Enabled {
			return !left.Enabled
		}
		if left.Status != right.Status {
			return left.Status < right.Status
		}
		if left.SourceSHA256 != right.SourceSHA256 {
			return left.SourceSHA256 < right.SourceSHA256
		}
		return runtimeMatchRulesKey(left.MatchRules) < runtimeMatchRulesKey(right.MatchRules)
	})
	sort.Slice(canonical.Public, func(i, j int) bool {
		left, right := canonical.Public[i], canonical.Public[j]
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		if left.EffectiveVersionID != right.EffectiveVersionID {
			return left.EffectiveVersionID < right.EffectiveVersionID
		}
		if left.SourceSHA256 != right.SourceSHA256 {
			return left.SourceSHA256 < right.SourceSHA256
		}
		return runtimeMatchRulesKey(left.MatchRules) < runtimeMatchRulesKey(right.MatchRules)
	})
	sort.Slice(canonical.PublicStyles, func(i, j int) bool {
		left, right := canonical.PublicStyles[i], canonical.PublicStyles[j]
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		if left.Version != right.Version {
			return left.Version < right.Version
		}
		if left.RunAt != right.RunAt {
			return left.RunAt < right.RunAt
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.EffectiveVersionID != right.EffectiveVersionID {
			return left.EffectiveVersionID < right.EffectiveVersionID
		}
		if left.SourceSHA256 != right.SourceSHA256 {
			return left.SourceSHA256 < right.SourceSHA256
		}
		return runtimeMatchRulesKey(left.MatchRules) < runtimeMatchRulesKey(right.MatchRules)
	})
	payload, _ := json.Marshal(canonical)
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func runtimeMatchRulesKey(rules []RuntimeMatchRule) string {
	payload, _ := json.Marshal(rules)
	return string(payload)
}

func boolPointerOrder(value *bool) int {
	if value == nil {
		return 0
	}
	if !*value {
		return 1
	}
	return 2
}
