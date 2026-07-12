package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

var (
	opaqueIDPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	requestIDPattern      = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	safeCodePattern       = regexp.MustCompile(`^[a-z][a-z0-9_]{0,127}$`)
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,160}$`)
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

func ensureRequestID(r *http.Request) {
	if !requestIDPattern.MatchString(requestID(r)) {
		r.Header.Set("X-KY-Request-Id", newOpaqueID("req"))
	}
}

func newOpaqueID(prefix string) string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("secure random source unavailable")
	}
	return prefix + "_" + hex.EncodeToString(raw[:])
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func idempotencyKey(r *http.Request) (string, bool) {
	value := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	return value, idempotencyKeyPattern.MatchString(value)
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "request JSON is invalid")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "validation_error", "request must contain one JSON object")
		return false
	}
	return true
}

func decodeRawObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if !decodeStrictJSON(w, r, &object) || object == nil {
		return nil, false
	}
	return object, true
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
