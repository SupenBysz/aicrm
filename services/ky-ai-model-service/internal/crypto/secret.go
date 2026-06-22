// Package crypto provides AES-256-GCM encryption for AI provider API keys.
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

// Cipher encrypts/decrypts secrets with AES-256-GCM. The key is derived from
// the configured KY_AI_SECRET_KEY (hex/base64/raw), normalized to 32 bytes via
// SHA-256 so any sufficiently long secret works.
type Cipher struct {
	gcm cipher.AEAD
}

// New returns a Cipher, or (nil, false) when no usable key is configured.
func New(secret string) (*Cipher, bool) {
	if secret == "" {
		return nil, false
	}
	key := deriveKey(secret)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, false
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, false
	}
	return &Cipher{gcm: gcm}, true
}

func deriveKey(secret string) []byte {
	// Accept hex or base64 32-byte keys directly; otherwise hash to 32 bytes.
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
	nonce, ct := raw[:ns], raw[ns:]
	plain, err := c.gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// Mask returns a masked representation of a plaintext key for display.
func Mask(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	if len(plaintext) <= 4 {
		return "***"
	}
	return "***" + plaintext[len(plaintext)-4:]
}
