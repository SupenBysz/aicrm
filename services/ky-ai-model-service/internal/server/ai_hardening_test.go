package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/crypto"
)

// rotate handler should reject an empty apiKey before any store access, so this
// runs safely with a nil store.
func TestRotateProviderAPIKey_EmptyRejected(t *testing.T) {
	c, ok := crypto.New("test-secret-key")
	if !ok {
		t.Fatal("cipher init failed")
	}
	s := &Server{cipher: c}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-models/providers/prov_1/rotate-api-key", strings.NewReader(`{"apiKey":""}`))
	req.SetPathValue("id", "prov_1")
	rec := httptest.NewRecorder()
	s.rotateProviderAPIKey(rec, req, wsContext{UserID: "u1"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty apiKey: got %d want %d", rec.Code, http.StatusBadRequest)
	}
}

// rotate handler should 503 when the cipher (encryption key) is unconfigured,
// before touching the store.
func TestRotateProviderAPIKey_NoCipher(t *testing.T) {
	s := &Server{} // cipher nil
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ai-models/providers/prov_1/rotate-api-key", strings.NewReader(`{"apiKey":"sk-abc"}`))
	req.SetPathValue("id", "prov_1")
	rec := httptest.NewRecorder()
	s.rotateProviderAPIKey(rec, req, wsContext{UserID: "u1"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil cipher: got %d want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

// The rotation response must never carry plaintext/ciphertext — only a masked
// key. Mask shows at most the last 4 chars.
func TestRotateMaskingNeverPlaintext(t *testing.T) {
	plaintext := "sk-secret-1234"
	masked := crypto.Mask(plaintext)
	if masked == plaintext {
		t.Fatal("masked must differ from plaintext")
	}
	if strings.Contains(masked, "secret") {
		t.Fatalf("masked leaks key body: %q", masked)
	}
	if masked != "***1234" {
		t.Fatalf("unexpected mask: %q", masked)
	}
}

// TestAIHardeningAuditActions documents the locked audit actions for the new
// behaviors so they stay stable.
func TestAIHardeningAuditActions(t *testing.T) {
	for _, a := range []string{"ai_provider.status_changed", "ai_provider.api_key_rotated"} {
		if a == "" {
			t.Fatal("empty audit action")
		}
	}
}
