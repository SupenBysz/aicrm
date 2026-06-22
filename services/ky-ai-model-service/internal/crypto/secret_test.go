package crypto

import "testing"

func TestNewRequiresSecret(t *testing.T) {
	if _, ok := New(""); ok {
		t.Fatal("empty secret must not produce a cipher")
	}
	if _, ok := New("any-non-empty-secret"); !ok {
		t.Fatal("non-empty secret should produce a cipher")
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	c, ok := New("test-secret-key")
	if !ok {
		t.Fatal("expected cipher")
	}
	plain := "sk-super-secret-api-key-12345"
	enc, err := c.Encrypt(plain)
	if err != nil {
		t.Fatalf("encrypt error: %v", err)
	}
	if enc == plain {
		t.Fatal("ciphertext must differ from plaintext")
	}
	dec, err := c.Decrypt(enc)
	if err != nil {
		t.Fatalf("decrypt error: %v", err)
	}
	if dec != plain {
		t.Fatalf("round trip mismatch: got %q", dec)
	}
}

func TestEncryptNonDeterministic(t *testing.T) {
	c, _ := New("k")
	a, _ := c.Encrypt("same")
	b, _ := c.Encrypt("same")
	if a == b {
		t.Fatal("nonce should make ciphertexts differ")
	}
}

func TestDecryptRejectsTampered(t *testing.T) {
	c, _ := New("k")
	enc, _ := c.Encrypt("data")
	if _, err := c.Decrypt(enc + "AA"); err == nil {
		t.Fatal("tampered ciphertext should fail")
	}
	if _, err := c.Decrypt("not-base64!!!"); err == nil {
		t.Fatal("invalid base64 should fail")
	}
}

func TestMask(t *testing.T) {
	if Mask("") != "" {
		t.Error("empty should mask to empty")
	}
	if Mask("ab") != "***" {
		t.Error("short should fully mask")
	}
	if Mask("sk-abcd1234") != "***1234" {
		t.Errorf("unexpected mask: %s", Mask("sk-abcd1234"))
	}
}
