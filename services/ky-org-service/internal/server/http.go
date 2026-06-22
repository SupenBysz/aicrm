package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func writeData(w http.ResponseWriter, r *http.Request, data any) {
	writeJSON(w, map[string]any{"data": data, "requestId": requestID(r)})
}

func writeList(w http.ResponseWriter, r *http.Request, items any, page store.Page) {
	writeJSON(w, map[string]any{
		"data":      map[string]any{"items": items, "pagination": page},
		"requestId": requestID(r),
	})
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.WriteHeader(status)
	writeJSON(w, map[string]any{
		"error":     map[string]any{"code": code, "message": message, "details": map[string]any{}},
		"requestId": requestID(r),
	})
}

// writeStoreError maps store sentinel errors to HTTP responses.
func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch err {
	case store.ErrNotFound:
		writeError(w, r, http.StatusNotFound, "not_found", "资源不存在")
	case store.ErrConflict:
		writeError(w, r, http.StatusConflict, "conflict", "数据冲突")
	default:
		writeError(w, r, http.StatusInternalServerError, "internal_error", "服务内部错误")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 格式错误")
		return false
	}
	return true
}

func requestID(r *http.Request) string {
	if id := r.Header.Get("X-KY-Request-Id"); id != "" {
		return id
	}
	return newID("req")
}

func newID(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

func strPtr(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
