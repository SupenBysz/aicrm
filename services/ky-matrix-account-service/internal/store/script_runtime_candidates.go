package store

// ScriptRuntimeCandidate 是平台无关的运行时资源候选类型。
type ScriptRuntimeCandidate = RuntimeAsset

func scriptRuntimeAssetDiagnostics(scriptID, styleID string) []string {
	return runtimeAssetDiagnostics(scriptID, styleID)
}

func sortScriptRuntimeCandidates(items []ScriptRuntimeCandidate) {
	sortRuntimeAssets(items)
}

func dedupeScriptRuntimeCandidates(items []ScriptRuntimeCandidate) []ScriptRuntimeCandidate {
	return dedupeRuntimeAssets(items)
}

func validScriptRuntimeAssetContent(content string, bytes int, expectedHash string) bool {
	return validRuntimeAssetContentGeneric(content, bytes, expectedHash)
}
