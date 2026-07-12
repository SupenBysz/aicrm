// Package deviceauth implements the pure cryptographic and replay-decision
// primitives for the AiCRM executor-bound Desktop trust plane.
//
// It deliberately performs no database writes, ticket verification, HTTP
// authorization, or business state transitions. Callers must combine a
// verified request with the persistent ledger transaction required by the
// locked P2A contract.
package deviceauth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
)

var (
	ErrInvalidPublicKey = errors.New("invalid Ed25519 public key")
	ErrInvalidDeviceID  = errors.New("invalid device ID")
	ErrDeviceIDMismatch = errors.New("device ID does not match public key")
	ErrInvalidSignature = errors.New("invalid Ed25519 signature")
)

// ParsePublicKey accepts only canonical base64url-no-padding encoding of the
// raw 32-byte Ed25519 public key.
func ParsePublicKey(encoded string) (ed25519.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != ed25519.PublicKeySize || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return nil, ErrInvalidPublicKey
	}
	return ed25519.PublicKey(raw), nil
}

// EncodePublicKey returns the locked raw-key representation.
func EncodePublicKey(publicKey ed25519.PublicKey) (string, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return "", ErrInvalidPublicKey
	}
	return base64.RawURLEncoding.EncodeToString(publicKey), nil
}

// DeviceID is SHA-256(raw32) encoded as 64 lowercase hexadecimal characters.
func DeviceID(publicKey ed25519.PublicKey) (string, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return "", ErrInvalidPublicKey
	}
	digest := sha256.Sum256(publicKey)
	return hex.EncodeToString(digest[:]), nil
}

// ValidateDeviceID rejects uppercase, padded, shortened, or otherwise
// non-canonical digests.
func ValidateDeviceID(deviceID string) error {
	decoded, err := hex.DecodeString(deviceID)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != deviceID {
		return ErrInvalidDeviceID
	}
	return nil
}

// MatchDeviceID uses constant-time digest comparison after canonical parsing.
func MatchDeviceID(publicKey ed25519.PublicKey, claimed string) error {
	if err := ValidateDeviceID(claimed); err != nil {
		return err
	}
	derived, err := DeviceID(publicKey)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(derived), []byte(claimed)) != 1 {
		return ErrDeviceIDMismatch
	}
	return nil
}

// ParseSignature accepts only canonical base64url-no-padding encoding of the
// raw 64-byte Ed25519 signature.
func ParseSignature(encoded string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != ed25519.SignatureSize || base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return nil, ErrInvalidSignature
	}
	return raw, nil
}

// VerifySignature validates an already-canonical signing input.
func VerifySignature(publicKey ed25519.PublicKey, signingInput, signature []byte) error {
	if len(publicKey) != ed25519.PublicKeySize {
		return ErrInvalidPublicKey
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, signingInput, signature) {
		return fmt.Errorf("%w: verification failed", ErrInvalidSignature)
	}
	return nil
}
