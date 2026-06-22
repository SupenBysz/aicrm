package store

import "encoding/json"

func jsonToStrings(b []byte) []string {
	out := []string{}
	if len(b) == 0 {
		return out
	}
	_ = json.Unmarshal(b, &out)
	if out == nil {
		return []string{}
	}
	return out
}

func scopeAddAll(set map[string]struct{}, ids []string) {
	for _, id := range ids {
		if id != "" {
			set[id] = struct{}{}
		}
	}
}

func scopeKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	return out
}

// scopeInPlaceholders builds "$start+1,..." and the matching args slice.
func scopeInPlaceholders(start int, ids []string) (string, []any) {
	out := ""
	args := make([]any, len(ids))
	for i, id := range ids {
		if i > 0 {
			out += ","
		}
		out += "$" + itoa(start+i+1)
		args[i] = id
	}
	return out, args
}
