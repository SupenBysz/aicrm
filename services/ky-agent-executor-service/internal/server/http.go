package server

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

var (
	opaqueIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	safeCodePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,127}$`)
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeData(w http.ResponseWriter, r *http.Request, status int, data any) {
	writeJSON(w, status, map[string]any{
		"data":      data,
		"requestId": requestID(r),
	})
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
			"details": map[string]any{},
		},
		"requestId": requestID(r),
	})
}

func requestID(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-KY-Request-Id"))
}

func tokenEqual(expected, actual string) bool {
	if expected == "" || len(expected) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

func validOpaqueID(value string) bool {
	return value != "" && len(value) <= 160 && opaqueIDPattern.MatchString(value)
}

func safeCode(value string) string {
	if value == "" || safeCodePattern.MatchString(value) {
		return value
	}
	return "unsafe_code_redacted"
}

func sanitizeSafeJSON(raw json.RawMessage) json.RawMessage {
	var value any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return json.RawMessage(`{}`)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return json.RawMessage(`{}`)
	}
	cleaned := sanitizeValue(object)
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func sanitizeValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		cleaned := make(map[string]any, len(typed))
		for key, child := range typed {
			if forbiddenSafeKey(key) {
				continue
			}
			cleaned[key] = sanitizeValue(child)
		}
		return cleaned
	case []any:
		cleaned := make([]any, len(typed))
		for i, child := range typed {
			cleaned[i] = sanitizeValue(child)
		}
		return cleaned
	default:
		return typed
	}
}

func forbiddenSafeKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key))
	switch normalized {
	case "apikey", "accesstoken", "refreshtoken", "token", "authorization",
		"authorizationurl", "authurl", "verificationurl", "usercode",
		"loginid", "loginidhash", "challenge", "challengehash",
		"codexhome", "credential", "credentialpath", "path",
		"raw", "rawtext", "rawjson", "stdout", "stderr", "terminaloutput":
		return true
	default:
		return false
	}
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}
