package store

// RuntimeAsset 是平台无关的已授权运行时资源。旧业务 API 通过类型别名继续返回相同 JSON。
type RuntimeAsset struct {
	ID                      string             `json:"id"`
	ScriptID                string             `json:"scriptId"`
	Identifier              string             `json:"identifier"`
	EffectiveVersionID      string             `json:"effectiveVersionId"`
	Revision                int                `json:"revision"`
	WorkspaceType           string             `json:"workspaceType"`
	WorkspaceID             string             `json:"workspaceId"`
	Kind                    string             `json:"kind"`
	Version                 string             `json:"version"`
	Status                  string             `json:"status"`
	SourceContent           string             `json:"sourceContent"`
	SourceBytes             int                `json:"sourceBytes"`
	SourceSHA256            string             `json:"sourceSha256"`
	Diagnostics             []string           `json:"diagnostics,omitempty"`
	RunAt                   string             `json:"runAt"`
	Priority                int                `json:"priority"`
	Enabled                 bool               `json:"enabled"`
	NormalizedURL           string             `json:"normalizedUrl"`
	AssetType               string             `json:"assetType"`
	Platform                string             `json:"platform"`
	Source                  string             `json:"source"`
	NetworkCapabilities     []string           `json:"networkCapabilities"`
	MatchRules              []RuntimeMatchRule `json:"matchRules,omitempty"`
	MatchConfiguredURLRules *bool              `json:"matchConfiguredUrlRules,omitempty"`
}

type RuntimeAssetSelector struct {
	Identifier              string `json:"identifier,omitempty"`
	Version                 string `json:"version,omitempty"`
	VersionID               string `json:"versionId,omitempty"`
	VersionPolicy           string `json:"versionPolicy,omitempty"`
	MatchConfiguredURLRules *bool  `json:"matchConfiguredUrlRules,omitempty"`
	RunAt                   string `json:"runAt,omitempty"`
	Priority                *int   `json:"priority,omitempty"`
	Enabled                 *bool  `json:"enabled,omitempty"`
}

type RuntimeWorkspace struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type ScriptRuntimeResolveRequest struct {
	Platform                   string                  `json:"platform"`
	URL                        string                  `json:"url"`
	WorkspaceType              string                  `json:"workspaceType"`
	WorkspaceID                string                  `json:"workspaceId"`
	Workspace                  *RuntimeWorkspace       `json:"workspace,omitempty"`
	VersionPolicy              string                  `json:"versionPolicy"`
	Script                     *RuntimeAssetSelector   `json:"script,omitempty"`
	ScriptIdentifiers          []string                `json:"scriptIdentifiers,omitempty"`
	StyleIdentifiers           []string                `json:"styleIdentifiers,omitempty"`
	ScriptSelectors            []*RuntimeAssetSelector `json:"scriptSelectors,omitempty"`
	StyleSelectors             []*RuntimeAssetSelector `json:"styleSelectors,omitempty"`
	PublicIdentifiers          []string                `json:"publicIdentifiers,omitempty"`
	PublicStyleIdentifiers     []string                `json:"publicStyleIdentifiers,omitempty"`
	Style                      *RuntimeAssetSelector   `json:"style,omitempty"`
	RunAt                      string                  `json:"runAt,omitempty"`
	PreloadBoundAssets         bool                    `json:"preloadBoundAssets,omitempty"`
	SkipUnselectedPublicStyles bool                    `json:"-"`
	AllowEmptyResult           bool                    `json:"-"`
}

var scriptRuntimeRunAtOrder = map[string]int{
	"document_start":     0,
	"dom_content_loaded": 1,
	"document_idle":      2,
	"load":               3,
	"spa_route_change":   4,
	"user_action":        5,
}

func validScriptRuntimeRunAt(runAt string) bool {
	_, ok := scriptRuntimeRunAtOrder[runAt]
	return ok
}

// ValidScriptRuntimeRunAt 用于通用运行时解析接口的生命周期枚举校验。
func ValidScriptRuntimeRunAt(runAt string) bool { return validScriptRuntimeRunAt(runAt) }

func ValidScriptRuntimePlatform(platform string) bool {
	if platform == "" || len(platform) > 32 {
		return false
	}
	for i, r := range platform {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (i > 0 && (r == '-' || r == '_')) {
			continue
		}
		return false
	}
	return true
}

// ScriptRuntimeManifestRequest 描述平台无关的工作区资源清单请求。
// 业务资产的存储实现可以保持平台专用，但请求类型属于通用 runtime 契约。
type ScriptRuntimeManifestRequest struct {
	Platform      string            `json:"platform"`
	WorkspaceType string            `json:"workspaceType"`
	WorkspaceID   string            `json:"workspaceId"`
	Workspace     *RuntimeWorkspace `json:"workspace,omitempty"`
	VersionPolicy string            `json:"versionPolicy"`
	Origin        string            `json:"origin,omitempty"`
}
