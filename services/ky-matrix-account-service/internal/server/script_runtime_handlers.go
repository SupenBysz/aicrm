package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/matcher"
	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

var runtimeIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var runtimeVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

const (
	maxScriptRuntimeRequestBytes  = 64 << 10
	maxScriptRuntimeResponseBytes = 8 << 20
	maxScriptRuntimeAssets        = 64
)

func validateScriptRuntimeRequest(in store.ScriptRuntimeResolveRequest, wc wsContext) (store.ScriptRuntimeResolveRequest, string, string) {
	if in.Workspace != nil {
		if in.WorkspaceType == "" {
			in.WorkspaceType = in.Workspace.Type
		}
		if in.WorkspaceID == "" {
			in.WorkspaceID = in.Workspace.ID
		}
	}
	if in.WorkspaceType != wc.WorkspaceType || in.WorkspaceID != wc.WorkspaceID {
		return in, "WORKSPACE_FORBIDDEN", "请求工作区与当前身份不一致"
	}
	in.Platform = strings.ToLower(strings.TrimSpace(in.Platform))
	if !store.ValidScriptRuntimePlatform(in.Platform) {
		return in, "PLATFORM_NOT_ALLOWED", "平台标识无效"
	}
	in.URL = strings.TrimSpace(in.URL)
	if in.URL == "" || len(in.URL) > 2048 {
		return in, "INVALID_URL", "URL 无效"
	}
	normalized, err := matcher.Normalize(in.URL)
	if err != nil {
		return in, "INVALID_URL", "URL 必须是有效的 HTTP/HTTPS 地址"
	}
	in.URL = normalized
	if in.VersionPolicy == "" {
		in.VersionPolicy = "active_only"
	}
	if in.VersionPolicy != "active_only" && in.VersionPolicy != "latest_released" {
		return in, "ASSET_NOT_FOUND", "版本选择策略无效"
	}
	if len(in.ScriptIdentifiers) > 32 || len(in.StyleIdentifiers) > 32 || len(in.ScriptSelectors) > 32 || len(in.StyleSelectors) > 32 || len(in.PublicIdentifiers) > 32 || len(in.PublicStyleIdentifiers) > 32 {
		return in, "INVALID_SELECTOR", "脚本标识符数量超出限制"
	}
	for _, identifier := range in.ScriptIdentifiers {
		if !runtimeIdentifierPattern.MatchString(identifier) {
			return in, "INVALID_SELECTOR", "脚本标识符无效"
		}
	}
	for _, identifier := range in.StyleIdentifiers {
		if !runtimeIdentifierPattern.MatchString(identifier) {
			return in, "INVALID_SELECTOR", "样式标识符无效"
		}
	}
	selectors := append(append([]*store.RuntimeAssetSelector{}, in.ScriptSelectors...), in.StyleSelectors...)
	for _, selector := range []*store.RuntimeAssetSelector{in.Script, in.Style} {
		if selector == nil {
			continue
		}
		if !runtimeIdentifierPattern.MatchString(selector.Identifier) {
			return in, "INVALID_SELECTOR", "脚本或样式选择器无效"
		}
		if selector.Version != "" && !runtimeVersionPattern.MatchString(selector.Version) {
			return in, "INVALID_SELECTOR", "脚本或样式版本号无效"
		}
	}
	for _, selector := range selectors {
		if selector == nil || !runtimeIdentifierPattern.MatchString(selector.Identifier) {
			return in, "INVALID_SELECTOR", "脚本或样式选择器无效"
		}
		if selector.Version != "" && !runtimeVersionPattern.MatchString(selector.Version) {
			return in, "INVALID_SELECTOR", "脚本或样式版本号无效"
		}
	}
	selectors = append(selectors, in.Script, in.Style)
	for _, selector := range selectors {
		if selector == nil {
			continue
		}
		if selector.RunAt != "" && !store.ValidScriptRuntimeRunAt(selector.RunAt) {
			return in, "ASSET_NOT_FOUND", "运行时机无效"
		}
		if selector.Priority != nil && (*selector.Priority < -10000 || *selector.Priority > 10000) {
			return in, "INVALID_SELECTOR", "资源优先级无效"
		}
	}
	for _, identifier := range in.PublicIdentifiers {
		if !store.ValidPublicScriptIdentifier(identifier) {
			return in, "INVALID_SELECTOR", "公共脚本标识符无效"
		}
	}
	for _, identifier := range in.PublicStyleIdentifiers {
		if !store.ValidPublicScriptIdentifier(identifier) {
			return in, "INVALID_SELECTOR", "公共样式标识符无效"
		}
	}
	if in.RunAt != "" && !store.ValidScriptRuntimeRunAt(in.RunAt) {
		return in, "ASSET_NOT_FOUND", "运行时机无效"
	}
	if in.PreloadBoundAssets {
		hasExplicitSelection := store.HasExplicitBusinessRuntimeSelection(in) || len(in.PublicIdentifiers) > 0 || len(in.PublicStyleIdentifiers) > 0
		if !hasExplicitSelection {
			return in, "INVALID_SELECTOR", "预加载必须明确选择至少一个资源标识符"
		}
		if in.RunAt != "" && in.RunAt != "document_start" {
			return in, "INVALID_SELECTOR", "预加载只支持 document_start"
		}
		for _, selector := range selectors {
			if selector != nil && selector.RunAt != "" && selector.RunAt != "document_start" {
				return in, "INVALID_SELECTOR", "预加载选择器只支持 document_start"
			}
		}
	}
	return in, "", ""
}

func (s *Server) resolveScriptRuntime(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.ScriptRuntimeResolveRequest
	if !decodeScriptRuntimeJSON(w, r, &in) {
		return
	}
	var code, message string
	in, code, message = validateScriptRuntimeRequest(in, wc)
	if code != "" {
		status := http.StatusBadRequest
		if code == "WORKSPACE_FORBIDDEN" {
			status = http.StatusForbidden
		}
		writeError(w, r, status, code, message)
		return
	}
	var err error
	items, err := s.store.ResolveScriptRuntime(r.Context(), in)
	if err != nil {
		if errors.Is(err, store.ErrValidation) {
			writeError(w, r, http.StatusBadRequest, "ASSET_NOT_FOUND", "资源解析参数无效")
			return
		}
		writeStoreError(w, r, err)
		return
	}
	var publicItems []store.PublicRuntimeScript
	var publicStyles []store.PublicRuntimeStyle
	publicIdentifiers, dependencyErr := store.RuntimePublicDependencyRoots(items, in.PublicIdentifiers)
	if dependencyErr != nil {
		message := "业务脚本公共依赖声明无效"
		var declarationErr *store.PublicDependencyDeclarationError
		if errors.As(dependencyErr, &declarationErr) {
			if declarationErr.Identifier != "" && declarationErr.Method != "" {
				message = fmt.Sprintf("公共脚本依赖 %s 的方法 %s 声明无效", declarationErr.Identifier, declarationErr.Method)
			} else if declarationErr.Identifier != "" {
				message = fmt.Sprintf("公共脚本依赖标识符 %s 声明无效", declarationErr.Identifier)
			}
		}
		writeError(w, r, http.StatusBadRequest, "PUBLIC_DEPENDENCY_INVALID", message)
		return
	}
	if len(publicIdentifiers) > 0 {
		publicItems, err = s.store.ResolvePublicScripts(r.Context(), in.WorkspaceType, in.WorkspaceID, in.Platform, publicIdentifiers)
		if err != nil {
			if errors.Is(err, store.ErrPublicDependencyMissing) {
				identifier := strings.TrimPrefix(err.Error(), store.ErrPublicDependencyMissing.Error()+":")
				message := "公共脚本依赖不存在或未启用"
				if identifier != err.Error() && identifier != "" {
					message = fmt.Sprintf("公共脚本依赖 %s 不存在或未启用", identifier)
				}
				writeError(w, r, http.StatusNotFound, "PUBLIC_DEPENDENCY_MISSING", message)
				return
			}
			if errors.Is(err, store.ErrPublicDependencyCycle) {
				writeError(w, r, http.StatusBadRequest, "PUBLIC_DEPENDENCY_CYCLE", "公共脚本依赖存在循环")
				return
			}
			writeStoreError(w, r, err)
			return
		}
		if in.PreloadBoundAssets {
			for _, item := range publicItems {
				if !store.ValidRuntimeAssetContent(item.Source, item.SourceBytes, item.SourceSHA256) || utf8.RuneCountInString(item.Source) != item.SourceChars {
					writeError(w, r, http.StatusConflict, "PUBLIC_DEPENDENCY_INVALID", "公共脚本依赖内容完整性校验失败")
					return
				}
			}
		}
	}
	if shouldResolvePublicStyles(in) {
		publicStyles, err = s.store.ResolvePublicStylesWithOptions(r.Context(), in.WorkspaceType, in.WorkspaceID, in.Platform, in.URL, in.PublicStyleIdentifiers, in.PreloadBoundAssets)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
	}
	if len(items) == 0 && len(publicItems) == 0 && len(publicStyles) == 0 {
		code, message := scriptRuntimeEmptyResultError(in)
		writeError(w, r, http.StatusNotFound, code, message)
		return
	}
	if scriptRuntimeAssetCount(items, publicItems, publicStyles) > maxScriptRuntimeAssets {
		writeError(w, r, http.StatusInternalServerError, "runtime_response_too_large", "匹配资源数量超出响应限制")
		return
	}
	for index := range items {
		capabilities, err := store.ServerNetworkCapabilities(items[index].NetworkCapabilities)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "runtime_capability_invalid", "服务端网络能力声明无效")
			return
		}
		items[index].NetworkCapabilities = capabilities
	}
	for index := range publicStyles {
		capabilities, err := store.ServerNetworkCapabilities(publicStyles[index].NetworkCapabilities)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "runtime_capability_invalid", "服务端网络能力声明无效")
			return
		}
		publicStyles[index].NetworkCapabilities = capabilities
	}
	for index := range publicItems {
		capabilities, err := store.ServerNetworkCapabilities(publicItems[index].NetworkCapabilities)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "runtime_capability_invalid", "服务端网络能力声明无效")
			return
		}
		publicItems[index].NetworkCapabilities = capabilities
	}
	writeScriptRuntimeData(w, r, scriptRuntimeResponseData(items, publicItems, publicStyles, store.ScriptRuntimeManifestRevision(in, items, publicItems, publicStyles), time.Now().UTC().Format(time.RFC3339Nano)))
}

func shouldResolvePublicStyles(in store.ScriptRuntimeResolveRequest) bool {
	return len(in.PublicStyleIdentifiers) > 0 || (!in.PreloadBoundAssets && in.Style == nil && len(in.PublicIdentifiers) == 0)
}

func scriptRuntimeEmptyResultError(in store.ScriptRuntimeResolveRequest) (string, string) {
	if hasRequestedRuntimeVersion(in) {
		return "VERSION_NOT_RELEASED", "指定版本不存在或尚未发布"
	}
	if in.PreloadBoundAssets {
		return "PRELOAD_ASSET_UNAVAILABLE", "没有可用于 document_start 的已授权资源"
	}
	return "URL_NOT_MATCHED", "没有匹配当前 URL 的已发布资源"
}

func hasRequestedRuntimeVersion(in store.ScriptRuntimeResolveRequest) bool {
	if (in.Script != nil && in.Script.Version != "") || (in.Style != nil && in.Style.Version != "") {
		return true
	}
	if !in.PreloadBoundAssets {
		return false
	}
	for _, selector := range append(append([]*store.RuntimeAssetSelector{}, in.ScriptSelectors...), in.StyleSelectors...) {
		if selector != nil && selector.Version != "" {
			return true
		}
	}
	return false
}

func scriptRuntimeAssetCount(items []store.RuntimeAsset, publicItems []store.PublicRuntimeScript, publicStyles []store.PublicRuntimeStyle) int {
	return len(items) + len(publicItems) + len(publicStyles)
}

func scriptRuntimeResponseData(items []store.RuntimeAsset, publicItems []store.PublicRuntimeScript, publicStyles []store.PublicRuntimeStyle, manifestRevision, fetchedAt string) map[string]any {
	return map[string]any{
		"assets":           items,
		"public":           publicItems,
		"publicStyles":     publicStyles,
		"manifestRevision": manifestRevision,
		"fetchedAt":        fetchedAt,
	}
}

func validateScriptRuntimeManifestRequest(in store.ScriptRuntimeManifestRequest, wc wsContext) (store.ScriptRuntimeManifestRequest, string, string) {
	if in.Workspace != nil {
		if in.WorkspaceType == "" {
			in.WorkspaceType = in.Workspace.Type
		}
		if in.WorkspaceID == "" {
			in.WorkspaceID = in.Workspace.ID
		}
	}
	if in.WorkspaceType != wc.WorkspaceType || in.WorkspaceID != wc.WorkspaceID {
		return in, "WORKSPACE_FORBIDDEN", "请求工作区与当前身份不一致"
	}
	in.Platform = strings.ToLower(strings.TrimSpace(in.Platform))
	if !store.ValidScriptRuntimePlatform(in.Platform) {
		return in, "PLATFORM_NOT_ALLOWED", "平台标识无效"
	}
	if in.VersionPolicy == "" {
		in.VersionPolicy = "latest_released"
	}
	if in.VersionPolicy != "active_only" && in.VersionPolicy != "latest_released" {
		return in, "ASSET_NOT_FOUND", "版本选择策略无效"
	}
	if len(in.Origin) > 2048 {
		return in, "INVALID_URL", "origin 无效"
	}
	if in.Origin != "" {
		normalized, err := matcher.Normalize(strings.TrimSpace(in.Origin))
		if err != nil {
			return in, "INVALID_URL", "origin 必须是有效的 HTTP/HTTPS 地址"
		}
		in.Origin = normalized
	}
	return in, "", ""
}

func scriptRuntimeManifestRevisionFromRequest(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("X-KY-Manifest-Revision"))
	if value == "" {
		value = strings.TrimSpace(r.Header.Get("If-None-Match"))
	}
	value = strings.TrimSpace(strings.TrimPrefix(value, "W/"))
	return strings.Trim(value, `"`)
}

func (s *Server) scriptRuntimeManifest(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.ScriptRuntimeManifestRequest
	if !decodeScriptRuntimeJSON(w, r, &in) {
		return
	}
	var code, message string
	in, code, message = validateScriptRuntimeManifestRequest(in, wc)
	if code != "" {
		status := http.StatusBadRequest
		if code == "WORKSPACE_FORBIDDEN" {
			status = http.StatusForbidden
		}
		writeError(w, r, status, code, message)
		return
	}
	manifest, err := s.store.ListScriptRuntimeManifest(r.Context(), in)
	if err != nil {
		if errors.Is(err, store.ErrValidation) {
			writeError(w, r, http.StatusBadRequest, "ASSET_NOT_FOUND", "清单参数无效")
			return
		}
		writeStoreError(w, r, err)
		return
	}
	w.Header().Set("ETag", `W/"`+manifest.ManifestRevision+`"`)
	w.Header().Set("X-KY-Manifest-Revision", manifest.ManifestRevision)
	if scriptRuntimeManifestRevisionFromRequest(r) == manifest.ManifestRevision {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeScriptRuntimeData(w, r, scriptRuntimeManifestResponseData(manifest, time.Now().UTC().Format(time.RFC3339Nano)))
}

func scriptRuntimeManifestResponseData(manifest store.ScriptRuntimeManifest, fetchedAt string) map[string]any {
	return map[string]any{
		"schemaVersion":    manifest.SchemaVersion,
		"workspaceType":    manifest.WorkspaceType,
		"workspaceId":      manifest.WorkspaceID,
		"platform":         manifest.Platform,
		"versionPolicy":    manifest.VersionPolicy,
		"manifestRevision": manifest.ManifestRevision,
		"fetchedAt":        fetchedAt,
		"assets":           manifest.Assets,
		"public":           manifest.Public,
		"publicStyles":     manifest.PublicStyles,
	}
}

func decodeScriptRuntimeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxScriptRuntimeRequestBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(value); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 格式错误或超过大小限制")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}

func writeScriptRuntimeData(w http.ResponseWriter, r *http.Request, data any) {
	payload, err := json.Marshal(map[string]any{"data": data, "requestId": requestID(r)})
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "服务内部错误")
		return
	}
	if len(payload) > maxScriptRuntimeResponseBytes {
		writeError(w, r, http.StatusInternalServerError, "runtime_response_too_large", "运行时响应超过大小限制")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(append(payload, '\n'))
}
