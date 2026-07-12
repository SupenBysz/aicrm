// Package accountfingerprint owns the cross-runtime Codex account identity
// digest shared by Desktop and the executor control plane.
package accountfingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"
)

var ErrInvalidAccountIdentity = errors.New("invalid account identity")

// Calculate intentionally excludes plan type. Subscription changes must not
// turn one authorized account into a different credential identity.
func Calculate(accountType, email string) (string, error) {
	typeValue, ok := normalize(accountType, 64, false)
	if !ok {
		return "", ErrInvalidAccountIdentity
	}
	emailValue, ok := normalize(email, 320, true)
	if !ok {
		return "", ErrInvalidAccountIdentity
	}
	digest := sha256.Sum256([]byte(typeValue + "\n" + emailValue))
	return hex.EncodeToString(digest[:]), nil
}

func normalize(value string, maximumBytes int, lowercase bool) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > maximumBytes || !utf8.ValidString(trimmed) {
		return "", false
	}
	for _, character := range trimmed {
		if character < 0x20 || character == 0x7f {
			return "", false
		}
	}
	if lowercase {
		trimmed = strings.ToLower(trimmed)
	}
	return trimmed, true
}
