// Package crypto provides AES-256-GCM encryption for sensitive platform secrets
// (object-storage keys, SMS/email credentials, etc.). Shared across services so
// any service can encrypt/decrypt with the same scheme. The wire format and key
// derivation are identical to the AI module's cipher, so ciphertext is compatible
// when the same key value is used.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

// Cipher encrypts/decrypts secrets with AES-256-GCM. The key is derived from the
// configured secret (hex/base64 32-byte accepted directly, otherwise SHA-256).
type Cipher struct {
	gcm cipher.AEAD
}

// New returns a Cipher, or (nil, false) when no usable key is configured.
func New(secret string) (*Cipher, bool) {
	if secret == "" {
		return nil, false
	}
	block, err := aes.NewCipher(deriveKey(secret))
	if err != nil {
		return nil, false
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, false
	}
	return &Cipher{gcm: gcm}, true
}

// Enabled reports whether the cipher is usable.
func (c *Cipher) Enabled() bool { return c != nil && c.gcm != nil }

func deriveKey(secret string) []byte {
	if b, err := hex.DecodeString(secret); err == nil && len(b) == 32 {
		return b
	}
	if b, err := base64.StdEncoding.DecodeString(secret); err == nil && len(b) == 32 {
		return b
	}
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// Encrypt returns base64(nonce || ciphertext).
func (c *Cipher) Encrypt(plaintext string) (string, error) {
	nonce := make([]byte, c.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// Decrypt reverses Encrypt.
func (c *Cipher) Decrypt(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	ns := c.gcm.NonceSize()
	if len(raw) < ns {
		return "", errors.New("ciphertext too short")
	}
	plain, err := c.gcm.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// Mask returns a masked representation of a plaintext secret for display.
func Mask(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	if len(plaintext) <= 4 {
		return "***"
	}
	return "***" + plaintext[len(plaintext)-4:]
}
