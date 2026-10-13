package store

import "context"

// DouyinRuntimeCandidate 保留旧运行时 API 的响应类型名；通用解析类型见 ScriptRuntimeCandidate。
type DouyinRuntimeCandidate = ScriptRuntimeCandidate

// ListDouyinRuntimeCandidates 是旧 Douyin API 的兼容入口，解析逻辑由通用 resolver 提供。
func (s *Store) ListDouyinRuntimeCandidates(ctx context.Context, workspaceType, workspaceID, normalizedURL, runAt, identifierFilter string) ([]DouyinRuntimeCandidate, error) {
	var selector *RuntimeAssetSelector
	if identifierFilter != "" {
		selector = &RuntimeAssetSelector{Identifier: identifierFilter}
	}
	return s.ResolveScriptRuntime(ctx, ScriptRuntimeResolveRequest{
		Platform: "douyin", URL: normalizedURL, WorkspaceType: workspaceType, WorkspaceID: workspaceID,
		VersionPolicy: "active_only", RunAt: runAt, Script: selector,
	})
}

// 这些 helper 只保留旧测试/兼容调用方；通用实现不依赖 Douyin 命名。
func douyinRuntimeAssetDiagnostics(scriptID, styleID string) []string {
	return scriptRuntimeAssetDiagnostics(scriptID, styleID)
}
func sortDouyinRuntimeCandidates(items []DouyinRuntimeCandidate) {
	sortScriptRuntimeCandidates(items)
}
func dedupeDouyinRuntimeCandidates(items []DouyinRuntimeCandidate) []DouyinRuntimeCandidate {
	return dedupeScriptRuntimeCandidates(items)
}
func validRuntimeAssetContent(content string, bytes int, expectedHash string) bool {
	return validScriptRuntimeAssetContent(content, bytes, expectedHash)
}
