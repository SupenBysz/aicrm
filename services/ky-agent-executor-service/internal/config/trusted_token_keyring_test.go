package config

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrustedTokenTrustMaterialLoadsActiveAndVerifyOnlyKeys(t *testing.T) {
	activePrivate := decodedTestPrivateKey(t)
	oldPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x33}, ed25519.SeedSize))
	raw := keyringJSON(t, 7, "confirmation_key_1", []testKeyringKey{
		{
			KeyID: "old_key_1", PublicKey: oldPrivate.Public().(ed25519.PublicKey),
			NotBefore: "2026-01-01T00:00:00Z", NotAfter: stringPointer("2026-07-13T00:00:00Z"),
			VerifyUntil: stringPointer("2026-07-13T00:10:00Z"),
		},
		{
			KeyID: "confirmation_key_1", PublicKey: activePrivate.Public().(ed25519.PublicKey),
			NotBefore: "2026-07-13T00:00:00Z",
		},
	})
	cfg := Config{
		TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: testTrustedTokenPrivateKey(),
		TrustedTokenKeyringFile: writeKeyringFixture(t, raw, 0o600),
	}
	material, err := cfg.TrustedTokenTrustMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if len(material.VerificationKeys) != 2 || material.Active.KeyID != "confirmation_key_1" ||
		material.SigningWindow.SigningNotBefore <= 0 {
		t.Fatalf("unexpected trust material: %#v", material)
	}
	projection := material.PublicProjection
	if projection.Revision != 7 || projection.ActiveKeyID != "confirmation_key_1" ||
		projection.MaximumLifetimeSeconds != 600 || len(projection.Keys) != 2 ||
		projection.Keys[0].KeyID != "confirmation_key_1" || projection.Keys[1].KeyID != "old_key_1" ||
		len(projection.KeyRingDigest) != 64 {
		t.Fatalf("unexpected public projection: %#v", projection)
	}
	encoded, err := json.Marshal(projection)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(testTrustedTokenPrivateKey())) || bytes.Contains(encoded, []byte("private")) {
		t.Fatal("public projection leaked private key material")
	}
	again, err := material.VerificationKeys.PublicProjection(7, "confirmation_key_1")
	if err != nil || again.KeyRingDigest != projection.KeyRingDigest || !bytes.Equal(mustJSON(t, again), encoded) {
		t.Fatal("public projection or digest was not deterministic")
	}
}

func TestTrustedTokenTrustMaterialRejectsIncompleteOrUnsafeKeyrings(t *testing.T) {
	activePublic := decodedTestPrivateKey(t).Public().(ed25519.PublicKey)
	valid := keyringJSON(t, 1, "confirmation_key_1", []testKeyringKey{{
		KeyID: "confirmation_key_1", PublicKey: activePublic, NotBefore: "2026-07-13T00:00:00Z",
	}})
	tests := []struct {
		name string
		raw  []byte
		mode os.FileMode
	}{
		{"unknown field", bytes.Replace(valid, []byte(`"keys":`), []byte(`"extra":true,"keys":`), 1), 0o600},
		{"duplicate field", bytes.Replace(valid, []byte(`"revision":1`), []byte(`"revision":1,"revision":1`), 1), 0o600},
		{"active mismatch", bytes.Replace(valid, []byte(`"activeKid":"confirmation_key_1"`), []byte(`"activeKid":"other_key"`), 1), 0o600},
		{"padded public key", bytes.Replace(valid, []byte(base64.RawURLEncoding.EncodeToString(activePublic)), []byte(base64.RawURLEncoding.EncodeToString(activePublic)+"="), 1), 0o600},
		{"fractional time", bytes.Replace(valid, []byte("2026-07-13T00:00:00Z"), []byte("2026-07-13T00:00:00.000Z"), 1), 0o600},
		{"group writable", valid, 0o620},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := Config{
				TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: testTrustedTokenPrivateKey(),
				TrustedTokenKeyringFile: writeKeyringFixture(t, testCase.raw, testCase.mode),
			}
			if _, err := cfg.TrustedTokenTrustMaterial(); err == nil {
				t.Fatal("invalid keyring was accepted")
			}
		})
	}
	wrongPublic := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x44}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	wrong := keyringJSON(t, 2, "confirmation_key_1", []testKeyringKey{{
		KeyID: "confirmation_key_1", PublicKey: wrongPublic, NotBefore: "2026-07-13T00:00:00Z",
	}})
	cfg := Config{
		TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: testTrustedTokenPrivateKey(),
		TrustedTokenKeyringFile: writeKeyringFixture(t, wrong, 0o600),
	}
	if _, err := cfg.TrustedTokenTrustMaterial(); err == nil || !strings.Contains(err.Error(), "do not match") {
		t.Fatalf("active public/private mismatch was not rejected: %v", err)
	}
}

func TestTrustedTokenTrustMaterialRequiresExactRetirementGrace(t *testing.T) {
	publicKey := decodedTestPrivateKey(t).Public().(ed25519.PublicKey)
	for _, verifyUntil := range []string{"", "2026-07-13T00:09:59Z", "2026-07-13T00:10:01Z"} {
		var value *string
		if verifyUntil != "" {
			value = stringPointer(verifyUntil)
		}
		raw := keyringJSON(t, 3, "confirmation_key_1", []testKeyringKey{{
			KeyID: "confirmation_key_1", PublicKey: publicKey, NotBefore: "2026-01-01T00:00:00Z",
			NotAfter: stringPointer("2026-07-13T00:00:00Z"), VerifyUntil: value,
		}})
		cfg := Config{
			TrustedTokenKeyID: "confirmation_key_1", TrustedTokenPrivateKey: testTrustedTokenPrivateKey(),
			TrustedTokenKeyringFile: writeKeyringFixture(t, raw, 0o600),
		}
		if _, err := cfg.TrustedTokenTrustMaterial(); err == nil {
			t.Fatalf("verifyUntil %q was accepted", verifyUntil)
		}
	}
}

func testTrustedTokenKeyringFile(t *testing.T) string {
	t.Helper()
	publicKey := decodedTestPrivateKey(t).Public().(ed25519.PublicKey)
	raw := keyringJSON(t, 1, "confirmation_key_1", []testKeyringKey{{
		KeyID: "confirmation_key_1", PublicKey: publicKey, NotBefore: "2026-01-01T00:00:00Z",
	}})
	return writeKeyringFixture(t, raw, 0o600)
}

type testKeyringKey struct {
	KeyID       string
	PublicKey   ed25519.PublicKey
	NotBefore   string
	NotAfter    *string
	VerifyUntil *string
}

func keyringJSON(t *testing.T, revision int64, activeKeyID string, keys []testKeyringKey) []byte {
	t.Helper()
	type key struct {
		KeyID            string  `json:"kid"`
		PublicKey        string  `json:"publicKey"`
		SigningNotBefore string  `json:"signingNotBefore"`
		SigningNotAfter  *string `json:"signingNotAfter"`
		VerifyUntil      *string `json:"verifyUntil"`
	}
	type document struct {
		SchemaVersion int    `json:"schemaVersion"`
		Revision      int64  `json:"revision"`
		ActiveKeyID   string `json:"activeKid"`
		Keys          []key  `json:"keys"`
	}
	items := make([]key, 0, len(keys))
	for _, item := range keys {
		items = append(items, key{
			KeyID: item.KeyID, PublicKey: base64.RawURLEncoding.EncodeToString(item.PublicKey),
			SigningNotBefore: item.NotBefore, SigningNotAfter: item.NotAfter, VerifyUntil: item.VerifyUntil,
		})
	}
	raw, err := json.Marshal(document{SchemaVersion: 1, Revision: revision, ActiveKeyID: activeKeyID, Keys: items})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func writeKeyringFixture(t *testing.T, raw []byte, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "trusted-token-keyring.json")
	if err := os.WriteFile(path, raw, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func decodedTestPrivateKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(testTrustedTokenPrivateKey())
	if err != nil {
		t.Fatal(err)
	}
	return ed25519.PrivateKey(raw)
}

func stringPointer(value string) *string {
	return &value
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
