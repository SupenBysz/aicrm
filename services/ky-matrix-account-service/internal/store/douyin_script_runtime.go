package store

import "sort"

const (
	// 业务脚本由宿主统一在 document_start 注入，旧值仅用于兼容读取。
	DefaultDouyinScriptRunAt    = "document_start"
	DefaultDouyinScriptPriority = 1000
	MinDouyinScriptPriority     = -10000
	MaxDouyinScriptPriority     = 10000
)

var douyinScriptRunAtOrder = map[string]int{
	"document_start":     0,
	"dom_content_loaded": 1,
	"document_idle":      2,
	"load":               3,
	"spa_route_change":   4,
	"user_action":        5,
}

func validDouyinScriptRunAt(runAt string) bool {
	_, ok := douyinScriptRunAtOrder[runAt]
	return ok
}

// ValidDouyinScriptRunAtForRuntime供运行时查询接口复用受限事件枚举。
func ValidDouyinScriptRunAtForRuntime(runAt string) bool {
	return validDouyinScriptRunAt(runAt)
}

// sortDouyinScriptCandidates只提供确定性候选排序，不读取源码，也不执行脚本。
// 调用方必须先传入服务端已授权的工作区；函数仍再次过滤工作区、启用状态和生效版本。
func sortDouyinScriptCandidates(items []DouyinScript, workspaceType, workspaceID string) []DouyinScript {
	out := make([]DouyinScript, 0, len(items))
	for _, item := range items {
		if item.WorkspaceType != workspaceType || item.WorkspaceID != workspaceID || item.Status != "enabled" || item.EffectiveVersionID == "" {
			continue
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool {
		left, right := out[i], out[j]
		if douyinScriptRunAtOrder[left.RunAt] != douyinScriptRunAtOrder[right.RunAt] {
			return douyinScriptRunAtOrder[left.RunAt] < douyinScriptRunAtOrder[right.RunAt]
		}
		if left.Priority != right.Priority {
			return left.Priority < right.Priority
		}
		if left.Identifier != right.Identifier {
			return left.Identifier < right.Identifier
		}
		return left.ID < right.ID
	})
	return out
}
