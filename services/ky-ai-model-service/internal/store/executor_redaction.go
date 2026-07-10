package store

import (
	"encoding/json"
	"strings"
)

const executorSummaryMaxDepth = 12

var executorSensitiveKeys = map[string]struct{}{
	"authorization":    {},
	"cookie":           {},
	"cookies":          {},
	"credential":       {},
	"credentials":      {},
	"indexeddb":        {},
	"localstorage":     {},
	"password":         {},
	"secret":           {},
	"sensitivecontext": {},
	"sessionid":        {},
	"sessionstorage":   {},
	"storage":          {},
	"token":            {},
	"tokens":           {},
	"uidtt":            {},
}

// sanitizeExecutorResultSummary is the final server-side boundary before an
// executor task is persisted or exposed to Codex. Clients may only submit
// diagnostic page projections; browser credentials and storage dumps are
// never task context.
func sanitizeExecutorResultSummary(input map[string]any) map[string]any {
	value, ok := sanitizeExecutorValue(input, 0).(map[string]any)
	if !ok || value == nil {
		return map[string]any{}
	}
	return value
}

func sanitizeExecutorSummaryJSON(input []byte) []byte {
	var value map[string]any
	if len(input) == 0 || json.Unmarshal(input, &value) != nil {
		return []byte("{}")
	}
	output, err := json.Marshal(sanitizeExecutorResultSummary(value))
	if err != nil || len(output) == 0 {
		return []byte("{}")
	}
	return output
}

func sanitizeExecutorValue(value any, depth int) any {
	if depth > executorSummaryMaxDepth {
		return nil
	}
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			if isExecutorSensitiveKey(key) {
				continue
			}
			sanitized := sanitizeExecutorValue(child, depth+1)
			if sanitized != nil {
				out[key] = sanitized
			}
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, child := range typed {
			sanitized := sanitizeExecutorValue(child, depth+1)
			if sanitized != nil {
				out = append(out, sanitized)
			}
		}
		return out
	case string, bool, float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, nil:
		return typed
	default:
		return nil
	}
}

func isExecutorSensitiveKey(key string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.TrimSpace(key)))
	if _, blocked := executorSensitiveKeys[normalized]; blocked {
		return true
	}
	return strings.Contains(normalized, "accesstoken") ||
		strings.Contains(normalized, "refreshtoken") ||
		strings.Contains(normalized, "csrftoken") ||
		strings.Contains(normalized, "sessioncookie")
}
