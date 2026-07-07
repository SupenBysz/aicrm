package crypto

import "testing"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	c, ok := New("test-secret-key-value-1234567890")
	if !ok || !c.Enabled() {
		t.Fatal("cipher should be enabled")
	}
	plain := "sk-super-secret-credential"
	enc, err := c.Encrypt(plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if enc == plain {
		t.Fatal("ciphertext must differ from plaintext")
	}
	dec, err := c.Decrypt(enc)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if dec != plain {
		t.Fatalf("round-trip mismatch: got %q", dec)
	}
}

func TestNewEmptyDisabled(t *testing.T) {
	if c, ok := New(""); ok || c.Enabled() {
		t.Fatal("empty secret should yield a disabled cipher")
	}
}

func TestMask(t *testing.T) {
	if Mask("") != "" || Mask("ab") != "***" || Mask("sk-abcd1234") != "***1234" {
		t.Fatalf("mask output unexpected")
	}
}
